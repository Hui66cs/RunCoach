import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { NormalizedActivity } from '@runcoach/shared';
import { calendarResponseSchema } from '@runcoach/shared';
import { buildApp } from '../src/app.js';
import { openDatabase, type DatabaseContext } from '../src/db/client.js';
import { applyMigrations } from '../src/db/migrate.js';
import { ActivityRepository } from '../src/repositories/activity-repository.js';
import { ImportService } from '../src/services/import-service.js';
import { RawFileStore } from '../src/storage/raw-file-store.js';

const DEFAULT_OFFSET = 480;

let sourceCounter = 0;

function createActivity(
  repository: ActivityRepository,
  fileStore: RawFileStore,
  localDate: string,
): string {
  sourceCounter += 1;
  const label = `calendar-activity-${sourceCounter}`;
  const stored = fileStore.save(Buffer.from(label), `${label}.fit`, 'application/octet-stream');
  const rawFileId = repository.ensureRawFile(stored);
  const jobId = repository.createImportJob('FIT', `${label}.fit`, rawFileId);
  const itemId = repository.createImportItem(jobId);
  const normalized: NormalizedActivity = {
    sourceType: 'FIT',
    sourceExternalId: `${label}-external`,
    sourceIdentityKey: `${label}-identity`,
    activityType: 'RUN',
    startTimeUtc: `${localDate}T00:00:00.000Z`,
    originalStartTime: `${localDate}T08:00:00+08:00`,
    timezoneOffsetMinutes: DEFAULT_OFFSET,
    localDate,
    name: `实际活动 ${localDate}`,
    notes: null,
    distanceMeters: 5000,
    durationSeconds: 1500,
    movingDurationSeconds: 1400,
    averageHeartRateBpm: 150,
    maxHeartRateBpm: null,
    deviceName: 'CalendarTest',
    laps: [],
    rawSummary: {},
    samples: [],
  };
  return repository.createActivityFromSource({
    normalized,
    rawFileId,
    fileSha256: stored.sha256,
    rawPayload: {},
    importItemId: itemId,
  }).activityId;
}

interface AppHarness {
  directory: string;
  database: DatabaseContext;
  app: FastifyInstance;
  repository: ActivityRepository;
  fileStore: RawFileStore;
}

async function buildHarness(): Promise<AppHarness> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-calendar-'));
  const database = openDatabase(path.join(directory, 'runcoach.db'));
  applyMigrations(database.sqlite, path.resolve('apps/server/drizzle'));
  const repository = new ActivityRepository(database.db);
  const fileStore = new RawFileStore(directory);
  const app = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 3100,
      dataDir: directory,
      databasePath: path.join(directory, 'runcoach.db'),
      localOffsetMinutes: DEFAULT_OFFSET,
      maxUploadBytes: 1024 * 1024,
    },
    repository,
    importService: new ImportService(repository, fileStore, DEFAULT_OFFSET),
  });
  return { directory, database, app, repository, fileStore };
}

function teardownHarness(harness: AppHarness): void {
  void harness.app.close();
  harness.database.close();
  fs.rmSync(harness.directory, { recursive: true, force: true });
}

async function createWorkout(
  app: FastifyInstance,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/planned-workouts',
    payload: body,
  });
  return { status: response.statusCode, json: response.json() };
}

describe('training calendar and planned workouts', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(() => {
    teardownHarness(harness);
  });

  it('applies 0003 forward on top of a real 0002-state database and stays idempotent', () => {
    // Build a partial migrations directory containing only 0000-0002, apply it
    // to a fresh database, then write real M2 data into that 0002 state.
    const migrationsDirectory = path.resolve('apps/server/drizzle');
    const partialDirectory = path.join(harness.directory, 'migrations-0002');
    fs.mkdirSync(partialDirectory);
    for (const file of fs.readdirSync(migrationsDirectory).filter((name) => name < '0003')) {
      fs.copyFileSync(path.join(migrationsDirectory, file), path.join(partialDirectory, file));
    }
    const database = openDatabase(path.join(harness.directory, 'forward.db'));
    applyMigrations(database.sqlite, partialDirectory);
    const repository = new ActivityRepository(database.db);
    const activityId = createActivity(repository, harness.fileStore, '2026-09-20');

    const tableExists = (): boolean =>
      database.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'planned_workouts'",
        )
        .get() !== undefined;
    expect(tableExists()).toBe(false);

    // Applying the full migration directory on the same database must run only
    // the pending 0003 and keep the existing activity readable.
    applyMigrations(database.sqlite, migrationsDirectory);
    expect(tableExists()).toBe(true);
    const activity = repository.getActivity(activityId);
    expect(activity).not.toBeNull();
    expect(activity?.name).toBe('实际活动 2026-09-20');

    // planned_workouts is usable after the forward migration.
    const created = repository.createPlannedWorkout({
      scheduledLocalDate: '2026-09-21',
      workoutType: 'EASY_RUN',
      title: '前向迁移检查',
    });
    expect(repository.getPlannedWorkout(created.id)?.title).toBe('前向迁移检查');

    // Running the full directory again is idempotent.
    applyMigrations(database.sqlite, migrationsDirectory);
    expect(repository.getPlannedWorkout(created.id)).not.toBeNull();
    expect(repository.getActivity(activityId)).not.toBeNull();
    database.close();
  });

  it('persists planned workout updates across an app/database close and reopen', async () => {
    const databasePath = path.join(harness.directory, 'persist.db');
    const firstDatabase = openDatabase(databasePath);
    applyMigrations(firstDatabase.sqlite, path.resolve('apps/server/drizzle'));
    const firstRepository = new ActivityRepository(firstDatabase.db);
    const app = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 3100,
        dataDir: harness.directory,
        databasePath,
        localOffsetMinutes: DEFAULT_OFFSET,
        maxUploadBytes: 1024 * 1024,
      },
      repository: firstRepository,
      importService: new ImportService(firstRepository, harness.fileStore, DEFAULT_OFFSET),
    });
    let workoutId: string;
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/planned-workouts',
        payload: {
          scheduledLocalDate: '2026-09-20',
          workoutType: 'EASY_RUN',
          title: '重启前标题',
          targetDistanceMeters: 5000,
        },
      });
      expect(created.statusCode).toBe(200);
      workoutId = created.json<{ id: string }>().id;
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/planned-workouts/${workoutId}`,
        payload: { title: '重启后标题', targetDistanceMeters: 8000 },
      });
      expect(patched.statusCode).toBe(200);
    } finally {
      // Close the app first, then the database, in that order.
      await app.close();
      firstDatabase.close();
    }

    // Reopen the same database and rebuild the app/repository on top of it.
    const reopenedDatabase = openDatabase(databasePath);
    const reopenedRepository = new ActivityRepository(reopenedDatabase.db);
    const reopenedApp = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 3100,
        dataDir: harness.directory,
        databasePath,
        localOffsetMinutes: DEFAULT_OFFSET,
        maxUploadBytes: 1024 * 1024,
      },
      repository: reopenedRepository,
      importService: new ImportService(reopenedRepository, harness.fileStore, DEFAULT_OFFSET),
    });
    try {
      const calendar = await reopenedApp.inject({
        method: 'GET',
        url: '/api/calendar?from=2026-09-20&to=2026-09-20',
      });
      expect(calendar.statusCode).toBe(200);
      const body = calendar.json<{
        plannedWorkouts: Array<{
          id: string;
          title: string;
          targetDistanceMeters: number | null;
          scheduledLocalDate: string;
        }>;
      }>();
      expect(body.plannedWorkouts).toHaveLength(1);
      const workout = body.plannedWorkouts[0]!;
      expect(workout.id).toBe(workoutId);
      expect(workout.title).toBe('重启后标题');
      expect(workout.targetDistanceMeters).toBe(8000);
      expect(workout.scheduledLocalDate).toBe('2026-09-20');
    } finally {
      await reopenedApp.close();
      reopenedDatabase.close();
    }
  });

  it('creates a planned workout and returns the persisted state', async () => {
    const created = await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-20',
      workoutType: 'EASY_RUN',
      title: '  轻松跑  ',
      notes: '配速 6:30',
      targetDistanceMeters: 5000,
      targetDurationSeconds: 1800,
    });
    expect(created.status).toBe(200);
    const workout = created.json as {
      id: string;
      title: string;
      scheduledLocalDate: string;
      targetDistanceMeters: number;
      targetDurationSeconds: number;
      createdAt: string;
      updatedAt: string;
    };
    expect(workout.title).toBe('轻松跑');
    expect(workout.scheduledLocalDate).toBe('2026-09-20');
    expect(workout.targetDistanceMeters).toBe(5000);
    expect(workout.targetDurationSeconds).toBe(1800);
    expect(workout.createdAt).toBe(workout.updatedAt);
  });

  it('allows REST workouts without any target', async () => {
    const created = await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-20',
      workoutType: 'REST',
      title: '完全休息',
    });
    expect(created.status).toBe(200);
    expect(created.json['targetDistanceMeters']).toBeNull();
    expect(created.json['targetDurationSeconds']).toBeNull();
  });

  it('rejects empty or whitespace-only titles', async () => {
    for (const title of ['', '   ']) {
      const created = await createWorkout(harness.app, {
        scheduledLocalDate: '2026-09-20',
        workoutType: 'EASY_RUN',
        title,
      });
      expect(created.status).toBe(400);
    }
  });

  it('rejects negative, zero, and non-numeric targets', async () => {
    for (const [key, value] of [
      ['targetDistanceMeters', -100],
      ['targetDistanceMeters', 0],
      ['targetDistanceMeters', 'not-a-number'],
      ['targetDurationSeconds', -50],
      ['targetDurationSeconds', 0],
    ] as Array<[string, unknown]>) {
      const created = await createWorkout(harness.app, {
        scheduledLocalDate: '2026-09-20',
        workoutType: 'EASY_RUN',
        title: '目标校验',
        [key]: value,
      });
      expect(created.status, `${key}=${String(value)} 应被拒绝`).toBe(400);
    }
  });

  it('patches selected fields only and bumps updatedAt', async () => {
    const created = await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-20',
      workoutType: 'EASY_RUN',
      title: '原始标题',
      targetDistanceMeters: 5000,
    });
    const id = (created.json as { id: string }).id;
    const before = created.json as { updatedAt: string };
    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/planned-workouts/${id}`,
      payload: { title: '修改后的标题', targetDistanceMeters: 8000 },
    });
    expect(patched.statusCode).toBe(200);
    const workout = patched.json<{
      title: string;
      targetDistanceMeters: number;
      workoutType: string;
      notes: string | null;
      targetDurationSeconds: number | null;
      updatedAt: string;
    }>();
    expect(workout.title).toBe('修改后的标题');
    expect(workout.targetDistanceMeters).toBe(8000);
    expect(workout.workoutType).toBe('EASY_RUN');
    expect(workout.notes).toBeNull();
    expect(workout.targetDurationSeconds).toBeNull();
    expect(workout.updatedAt >= before.updatedAt).toBe(true);
  });

  it('rejects an empty PATCH body with 400', async () => {
    const created = await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-20',
      workoutType: 'EASY_RUN',
      title: '标题',
    });
    const id = (created.json as { id: string }).id;
    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/planned-workouts/${id}`,
      payload: {},
    });
    expect(patched.statusCode).toBe(400);
  });

  it('returns 404 when patching a missing planned workout', async () => {
    const patched = await harness.app.inject({
      method: 'PATCH',
      url: '/api/planned-workouts/00000000-0000-4000-8000-000000000000',
      payload: { title: '不存在' },
    });
    expect(patched.statusCode).toBe(404);
  });

  it('deletes a planned workout and returns 404 for a second delete', async () => {
    const created = await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-20',
      workoutType: 'TEMPO_RUN',
      title: '将被删除',
    });
    const id = (created.json as { id: string }).id;
    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: `/api/planned-workouts/${id}`,
    });
    expect(deleted.statusCode).toBe(204);
    const again = await harness.app.inject({
      method: 'DELETE',
      url: `/api/planned-workouts/${id}`,
    });
    expect(again.statusCode).toBe(404);
  });

  it('deleting a planned workout never touches activities or import data', async () => {
    const activityId = createActivity(harness.repository, harness.fileStore, '2026-09-20');
    const created = await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-20',
      workoutType: 'EASY_RUN',
      title: '删除共存',
    });
    const id = (created.json as { id: string }).id;
    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: `/api/planned-workouts/${id}`,
    });
    expect(deleted.statusCode).toBe(204);
    const detail = await harness.app.inject({
      method: 'GET',
      url: `/api/activities/${activityId}`,
    });
    expect(detail.statusCode).toBe(200);
    const history = await harness.app.inject({ method: 'GET', url: '/api/imports/history' });
    expect(history.statusCode).toBe(200);
    expect(history.json<{ jobs: unknown[] }>().jobs).toHaveLength(1);
  });

  it('returns a closed range with deterministic ordering and no samples', async () => {
    createActivity(harness.repository, harness.fileStore, '2026-09-20');
    await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-20',
      workoutType: 'EASY_RUN',
      title: 'B 计划',
    });
    await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-20',
      workoutType: 'EASY_RUN',
      title: 'A 计划',
    });
    await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-21',
      workoutType: 'REST',
      title: '休息日',
    });
    const calendar = await harness.app.inject({
      method: 'GET',
      url: '/api/calendar?from=2026-09-20&to=2026-09-21',
    });
    expect(calendar.statusCode).toBe(200);
    const parsed = calendarResponseSchema.parse(calendar.json());
    const plannedDates = parsed.plannedWorkouts.map((workout) => workout.scheduledLocalDate);
    expect(plannedDates).toEqual(['2026-09-20', '2026-09-20', '2026-09-21']);
    expect(parsed.plannedWorkouts.map((workout) => workout.title)).toEqual([
      'A 计划',
      'B 计划',
      '休息日',
    ]);
    expect(parsed.activities.map((activity) => activity.localDate)).toEqual(['2026-09-20']);
    expect(parsed.activities[0]?.name).toBe('实际活动 2026-09-20');
    expect(JSON.stringify(parsed)).not.toContain('samples');
  });

  it('rejects reversed ranges, oversized ranges, and invalid dates with 400', async () => {
    for (const query of [
      'from=2026-09-21&to=2026-09-20',
      'from=2026-01-01&to=2026-12-31',
      'from=2026-13-01&to=2026-12-31',
      'to=2026-09-20',
      'from=not-a-date&to=2026-09-20',
    ]) {
      const calendar = await harness.app.inject({
        method: 'GET',
        url: `/api/calendar?${query}`,
      });
      expect(calendar.statusCode, query).toBe(400);
      expect(calendar.json<{ code: string }>().code).toBe('INVALID_CALENDAR_QUERY');
    }
  });

  it('allows the maximum 93-day closed range', async () => {
    const calendar = await harness.app.inject({
      method: 'GET',
      url: '/api/calendar?from=2026-01-01&to=2026-04-03',
    });
    expect(calendar.statusCode).toBe(200);
    const parsed = calendarResponseSchema.parse(calendar.json());
    expect(parsed.from).toBe('2026-01-01');
    expect(parsed.to).toBe('2026-04-03');
  });

  it('keeps the calendar query count constant regardless of record count (no N+1)', async () => {
    const countQueries = async (workoutCount: number, activityCount: number): Promise<number> => {
      for (let index = 0; index < workoutCount; index += 1) {
        const day = 1 + (index % 28);
        await createWorkout(harness.app, {
          scheduledLocalDate: `2026-09-${day.toString().padStart(2, '0')}`,
          workoutType: 'EASY_RUN',
          title: `训练 ${index}`,
        });
      }
      for (let index = 0; index < activityCount; index += 1) {
        createActivity(
          harness.repository,
          harness.fileStore,
          `2026-09-${(1 + (index % 28)).toString().padStart(2, '0')}`,
        );
      }
      let count = 0;
      const originalPrepare = harness.database.sqlite.prepare.bind(harness.database.sqlite);
      harness.database.sqlite.prepare = (...args: Parameters<typeof originalPrepare>) => {
        count += 1;
        return originalPrepare(...args);
      };
      try {
        harness.repository.getCalendarRange({ from: '2026-09-01', to: '2026-09-28' });
      } finally {
        harness.database.sqlite.prepare = originalPrepare;
      }
      return count;
    };
    const smallCount = await countQueries(1, 1);
    const largeCount = await countQueries(30, 30);
    expect(smallCount).toBeLessThanOrEqual(4);
    expect(largeCount).toBeLessThanOrEqual(4);
    expect(smallCount).toBe(largeCount);
  });
});
