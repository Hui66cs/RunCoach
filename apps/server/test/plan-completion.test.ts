import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { NormalizedActivity } from '@runcoach/shared';
import {
  calendarResponseSchema,
  plannedWorkoutSchema,
  trainingSummaryResponseSchema,
} from '@runcoach/shared';
import { buildApp } from '../src/app.js';
import { openDatabase, type DatabaseContext } from '../src/db/client.js';
import { applyMigrations } from '../src/db/migrate.js';
import { ActivityRepository } from '../src/repositories/activity-repository.js';
import { ImportService } from '../src/services/import-service.js';
import { RawFileStore } from '../src/storage/raw-file-store.js';

const TODAY = '2026-09-22'; // Tuesday; current week runs 2026-09-21 .. 2026-09-27.
const DEFAULT_OFFSET = 480;

let sourceCounter = 0;

function createActivity(
  repository: ActivityRepository,
  fileStore: RawFileStore,
  localDate: string,
): string {
  sourceCounter += 1;
  const label = `completion-activity-${sourceCounter}`;
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
    deviceName: 'CompletionTest',
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-completion-'));
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

async function teardownHarness(harness: AppHarness): Promise<void> {
  await harness.app.close();
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

async function patchCompletion(
  app: FastifyInstance,
  workoutId: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/planned-workouts/${workoutId}/completion`,
    payload,
  });
  return { status: response.statusCode, json: response.json() };
}

async function getTrainingSummary(
  app: FastifyInstance,
  query: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/training-summary?${query}`,
  });
  return { status: response.statusCode, json: response.json() };
}

describe('0004 plan completion migration', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await teardownHarness(harness);
  });

  it('upgrades a real 0003-state database, keeps data, stays idempotent, and enforces the unique link', () => {
    // Build a partial migrations directory containing only 0000-0003, apply it
    // to a fresh database, then write real 0003-era data into that state.
    const migrationsDirectory = path.resolve('apps/server/drizzle');
    const partialDirectory = path.join(harness.directory, 'migrations-0003');
    fs.mkdirSync(partialDirectory);
    for (const file of fs.readdirSync(migrationsDirectory).filter((name) => name < '0004')) {
      fs.copyFileSync(path.join(migrationsDirectory, file), path.join(partialDirectory, file));
    }
    const database = openDatabase(path.join(harness.directory, 'forward.db'));
    applyMigrations(database.sqlite, partialDirectory);
    const repository = new ActivityRepository(database.db);
    const activityId = createActivity(repository, harness.fileStore, '2026-09-20');

    const legacyInsert = database.sqlite.prepare(
      `INSERT INTO planned_workouts
        (id, scheduled_local_date, workout_type, title, notes, target_distance_meters, target_duration_seconds, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    legacyInsert.run(
      'legacy-1',
      '2026-09-21',
      'EASY_RUN',
      '旧计划 A',
      '备注',
      5000,
      1800,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    legacyInsert.run(
      'legacy-2',
      '2026-09-22',
      'REST',
      '旧计划 B',
      null,
      null,
      null,
      '2026-01-02T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
    );

    const columns = database.sqlite.prepare('PRAGMA table_info(planned_workouts)').all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).not.toContain('completion_status');

    // Applying the full directory on the same database runs only 0004.
    applyMigrations(database.sqlite, migrationsDirectory);

    // Old planned workouts are upgraded to PLANNED and keep their data.
    const rows = database.sqlite
      .prepare('SELECT * FROM planned_workouts ORDER BY id')
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row['completion_status']).toBe('PLANNED');
      expect(row['linked_activity_id']).toBeNull();
    }
    expect(rows[0]?.['title']).toBe('旧计划 A');
    expect(rows[0]?.['target_distance_meters']).toBe(5000);
    expect(rows[1]?.['workout_type']).toBe('REST');

    // The pre-existing activity and its import history are preserved.
    const activity = repository.getActivity(activityId);
    expect(activity).not.toBeNull();
    expect(activity?.name).toBe('实际活动 2026-09-20');
    const jobs = database.sqlite.prepare('SELECT count(*) AS c FROM import_jobs').get() as {
      c: number;
    };
    expect(jobs.c).toBe(1);

    // The unique linked-activity index rejects a second plan on one activity.
    const update = database.sqlite.prepare(
      'UPDATE planned_workouts SET linked_activity_id = ? WHERE id = ?',
    );
    update.run(activityId, 'legacy-1');
    expect(() => update.run(activityId, 'legacy-2')).toThrow();
    expect(() =>
      database.sqlite
        .prepare(
          "INSERT INTO planned_workouts (id, scheduled_local_date, workout_type, title, created_at, updated_at, linked_activity_id) VALUES ('legacy-3', '2026-09-23', 'REST', '旧计划 C', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', ?)",
        )
        .run(activityId),
    ).toThrow();
    // Multiple NULL links remain allowed.
    expect(() =>
      database.sqlite
        .prepare(
          "INSERT INTO planned_workouts (id, scheduled_local_date, workout_type, title, created_at, updated_at, linked_activity_id) VALUES ('legacy-4', '2026-09-24', 'REST', '旧计划 D', '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z', NULL)",
        )
        .run(),
    ).not.toThrow();

    // Deleting the underlying activity clears the link but keeps COMPLETED.
    database.sqlite
      .prepare("UPDATE planned_workouts SET completion_status = 'COMPLETED' WHERE id = 'legacy-1'")
      .run();
    database.sqlite.prepare('DELETE FROM activities WHERE id = ?').run(activityId);
    const afterDelete = database.sqlite
      .prepare(
        "SELECT completion_status, linked_activity_id FROM planned_workouts WHERE id = 'legacy-1'",
      )
      .get() as { completion_status: string; linked_activity_id: string | null };
    expect(afterDelete.completion_status).toBe('COMPLETED');
    expect(afterDelete.linked_activity_id).toBeNull();

    // Running the full directory again is idempotent.
    applyMigrations(database.sqlite, migrationsDirectory);
    const stillThere = database.sqlite
      .prepare('SELECT count(*) AS c FROM planned_workouts')
      .get() as { c: number };
    expect(stillThere.c).toBe(3);
    database.close();
  });
});

describe('planned workout completion API', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await teardownHarness(harness);
  });

  it('creates workouts as PLANNED without a link', async () => {
    const created = await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-20',
      workoutType: 'EASY_RUN',
      title: '初始计划',
    });
    expect(created.status).toBe(200);
    const workout = plannedWorkoutSchema.parse(created.json);
    expect(workout.completionStatus).toBe('PLANNED');
    expect(workout.linkedActivityId).toBeNull();
  });

  it('completes manually without linking an activity', async () => {
    const created = await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-20',
      workoutType: 'EASY_RUN',
      title: '人工完成',
    });
    const id = (created.json as { id: string }).id;
    const patched = await patchCompletion(harness.app, id, {
      completionStatus: 'COMPLETED',
      linkedActivityId: null,
    });
    expect(patched.status).toBe(200);
    const workout = plannedWorkoutSchema.parse(patched.json);
    expect(workout.completionStatus).toBe('COMPLETED');
    expect(workout.linkedActivityId).toBeNull();
  });

  it('completes and links an activity, swaps the link, and unlinks while staying completed', async () => {
    const activityA = createActivity(harness.repository, harness.fileStore, '2026-09-20');
    const activityB = createActivity(harness.repository, harness.fileStore, '2026-09-21');
    const created = await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-20',
      workoutType: 'EASY_RUN',
      title: '关联计划',
    });
    const id = (created.json as { id: string }).id;

    const linked = await patchCompletion(harness.app, id, {
      completionStatus: 'COMPLETED',
      linkedActivityId: activityA,
    });
    expect(linked.status).toBe(200);
    expect(plannedWorkoutSchema.parse(linked.json).linkedActivityId).toBe(activityA);

    // The activity itself is untouched.
    const activity = harness.repository.getActivity(activityA);
    expect(activity?.name).toBe('实际活动 2026-09-20');
    expect(activity?.distanceMeters).toBe(5000);

    // Swap the link to another activity.
    const swapped = await patchCompletion(harness.app, id, {
      completionStatus: 'COMPLETED',
      linkedActivityId: activityB,
    });
    expect(swapped.status).toBe(200);
    expect(plannedWorkoutSchema.parse(swapped.json).linkedActivityId).toBe(activityB);

    // Unlink while keeping the manual completion.
    const unlinked = await patchCompletion(harness.app, id, {
      completionStatus: 'COMPLETED',
      linkedActivityId: null,
    });
    expect(unlinked.status).toBe(200);
    const workout = plannedWorkoutSchema.parse(unlinked.json);
    expect(workout.completionStatus).toBe('COMPLETED');
    expect(workout.linkedActivityId).toBeNull();
  });

  it('clears the link when moving COMPLETED back to PLANNED or SKIPPED', async () => {
    const activityId = createActivity(harness.repository, harness.fileStore, '2026-09-20');
    const created = await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-20',
      workoutType: 'EASY_RUN',
      title: '状态回退',
    });
    const id = (created.json as { id: string }).id;
    await patchCompletion(harness.app, id, {
      completionStatus: 'COMPLETED',
      linkedActivityId: activityId,
    });

    const replanned = await patchCompletion(harness.app, id, { completionStatus: 'PLANNED' });
    expect(replanned.status).toBe(200);
    let workout = plannedWorkoutSchema.parse(replanned.json);
    expect(workout.completionStatus).toBe('PLANNED');
    expect(workout.linkedActivityId).toBeNull();

    await patchCompletion(harness.app, id, {
      completionStatus: 'COMPLETED',
      linkedActivityId: activityId,
    });
    const skipped = await patchCompletion(harness.app, id, { completionStatus: 'SKIPPED' });
    expect(skipped.status).toBe(200);
    workout = plannedWorkoutSchema.parse(skipped.json);
    expect(workout.completionStatus).toBe('SKIPPED');
    expect(workout.linkedActivityId).toBeNull();
  });

  it('returns 404 for a missing workout and 404 ACTIVITY_NOT_FOUND for a missing activity', async () => {
    const missingWorkout = await patchCompletion(
      harness.app,
      '00000000-0000-4000-8000-000000000000',
      {
        completionStatus: 'COMPLETED',
        linkedActivityId: null,
      },
    );
    expect(missingWorkout.status).toBe(404);
    expect((missingWorkout.json as { code: string }).code).toBe('NOT_FOUND');

    const created = await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-20',
      workoutType: 'EASY_RUN',
      title: '缺失活动',
    });
    const id = (created.json as { id: string }).id;
    const missingActivity = await patchCompletion(harness.app, id, {
      completionStatus: 'COMPLETED',
      linkedActivityId: '00000000-0000-4000-8000-000000000000',
    });
    expect(missingActivity.status).toBe(404);
    expect((missingActivity.json as { code: string }).code).toBe('ACTIVITY_NOT_FOUND');
  });

  it('rejects linking one activity to two plans with 409 ACTIVITY_ALREADY_LINKED', async () => {
    const activityId = createActivity(harness.repository, harness.fileStore, '2026-09-20');
    const first = await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-20',
      workoutType: 'EASY_RUN',
      title: '第一个计划',
    });
    const second = await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-21',
      workoutType: 'EASY_RUN',
      title: '第二个计划',
    });
    const firstId = (first.json as { id: string }).id;
    const secondId = (second.json as { id: string }).id;

    const linked = await patchCompletion(harness.app, firstId, {
      completionStatus: 'COMPLETED',
      linkedActivityId: activityId,
    });
    expect(linked.status).toBe(200);

    const conflict = await patchCompletion(harness.app, secondId, {
      completionStatus: 'COMPLETED',
      linkedActivityId: activityId,
    });
    expect(conflict.status).toBe(409);
    expect((conflict.json as { code: string }).code).toBe('ACTIVITY_ALREADY_LINKED');
    // The failed attempt did not silently steal the link or change status.
    const stillFirst = await harness.app.inject({
      method: 'GET',
      url: '/api/calendar?from=2026-09-20&to=2026-09-21',
    });
    const calendar = calendarResponseSchema.parse(stillFirst.json());
    const secondWorkout = calendar.plannedWorkouts.find((workout) => workout.id === secondId);
    expect(secondWorkout?.completionStatus).toBe('PLANNED');
    expect(secondWorkout?.linkedActivityId).toBeNull();
  });

  it('rejects invalid completion payloads with 400', async () => {
    const created = await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-20',
      workoutType: 'EASY_RUN',
      title: '非法请求',
    });
    const id = (created.json as { id: string }).id;
    for (const payload of [
      {},
      { completionStatus: 'SOMETHING' },
      { completionStatus: 'PLANNED', linkedActivityId: null },
      { completionStatus: 'SKIPPED', linkedActivityId: '00000000-0000-4000-8000-000000000000' },
      { completionStatus: 'COMPLETED' },
    ]) {
      const patched = await patchCompletion(harness.app, id, payload);
      expect(patched.status, JSON.stringify(payload)).toBe(400);
    }
  });

  it('deleting a plan never deletes the activity or import history and frees the activity for another plan', async () => {
    const activityId = createActivity(harness.repository, harness.fileStore, '2026-09-20');
    const first = await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-20',
      workoutType: 'EASY_RUN',
      title: '将被删除',
    });
    const firstId = (first.json as { id: string }).id;
    await patchCompletion(harness.app, firstId, {
      completionStatus: 'COMPLETED',
      linkedActivityId: activityId,
    });

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: `/api/planned-workouts/${firstId}`,
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
    const counts = harness.repository.countRows();
    expect(counts.activities).toBe(1);
    expect(counts.mergeEvents).toBe(1);

    // The activity can now be linked to another plan.
    const second = await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-21',
      workoutType: 'EASY_RUN',
      title: '接力计划',
    });
    const relinked = await patchCompletion(harness.app, (second.json as { id: string }).id, {
      completionStatus: 'COMPLETED',
      linkedActivityId: activityId,
    });
    expect(relinked.status).toBe(200);
  });

  it('keeps status and link across closing and reopening the database', async () => {
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
    let activityId: string;
    try {
      activityId = createActivity(firstRepository, harness.fileStore, '2026-09-20');
      const created = await app.inject({
        method: 'POST',
        url: '/api/planned-workouts',
        payload: { scheduledLocalDate: '2026-09-20', workoutType: 'EASY_RUN', title: '重启计划' },
      });
      workoutId = created.json<{ id: string }>().id;
      const patched = await patchCompletion(app, workoutId, {
        completionStatus: 'COMPLETED',
        linkedActivityId: activityId,
      });
      expect(patched.status).toBe(200);
    } finally {
      await app.close();
      firstDatabase.close();
    }

    const reopenedDatabase = openDatabase(databasePath);
    const reopenedRepository = new ActivityRepository(reopenedDatabase.db);
    try {
      const workout = reopenedRepository.getPlannedWorkout(workoutId);
      expect(workout?.completionStatus).toBe('COMPLETED');
      expect(workout?.linkedActivityId).toBe(activityId);
      expect(reopenedRepository.getActivity(activityId)).not.toBeNull();
    } finally {
      reopenedDatabase.close();
    }
  });
});

describe('training summary', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await teardownHarness(harness);
  });

  function createPlan(date: string, title: string): void {
    harness.repository.createPlannedWorkout({
      scheduledLocalDate: date,
      workoutType: 'EASY_RUN',
      title,
    });
  }

  it('classifies completed, linked completed, skipped, overdue, and upcoming plans', () => {
    const activityId = createActivity(harness.repository, harness.fileStore, '2026-09-14');
    const linked = harness.repository.createPlannedWorkout({
      scheduledLocalDate: '2026-09-14',
      workoutType: 'EASY_RUN',
      title: '已关联完成',
    });
    harness.repository.updatePlannedWorkoutCompletion(linked.id, {
      completionStatus: 'COMPLETED',
      linkedActivityId: activityId,
    });
    const manual = harness.repository.createPlannedWorkout({
      scheduledLocalDate: '2026-09-15',
      workoutType: 'REST',
      title: '人工完成',
    });
    harness.repository.updatePlannedWorkoutCompletion(manual.id, {
      completionStatus: 'COMPLETED',
      linkedActivityId: null,
    });
    const skipped = harness.repository.createPlannedWorkout({
      scheduledLocalDate: '2026-09-16',
      workoutType: 'REST',
      title: '已跳过',
    });
    harness.repository.updatePlannedWorkoutCompletion(skipped.id, {
      completionStatus: 'SKIPPED',
    });
    createPlan('2026-09-17', '逾期计划'); // before TODAY
    createPlan('2026-09-22', '今天计划'); // TODAY itself: upcoming, not overdue
    createPlan('2026-09-25', '未来计划');

    const summary = harness.repository.getTrainingSummary(
      { from: '2026-09-14', to: '2026-09-27' },
      TODAY,
    );
    expect(() => trainingSummaryResponseSchema.parse(summary)).not.toThrow();
    expect(summary.generatedForLocalDate).toBe(TODAY);
    expect(summary.timezoneOffsetMinutes).toBe(DEFAULT_OFFSET);
    expect(summary.summary).toEqual({
      plannedCount: 6,
      completedCount: 2,
      linkedCompletedCount: 1,
      skippedCount: 1,
      overdueCount: 1,
      upcomingCount: 2,
      eligibleCount: 4,
      adherenceRate: 0.5,
    });
  });

  it('returns null adherence when eligible is 0 and never lets future or today plans lower the rate', () => {
    createPlan('2026-09-22', '今天计划');
    createPlan('2026-09-25', '未来计划');
    const onlyUpcoming = harness.repository.getTrainingSummary(
      { from: '2026-09-20', to: '2026-09-27' },
      TODAY,
    );
    expect(onlyUpcoming.summary).toEqual({
      plannedCount: 2,
      completedCount: 0,
      linkedCompletedCount: 0,
      skippedCount: 0,
      overdueCount: 0,
      upcomingCount: 2,
      eligibleCount: 0,
      adherenceRate: null,
    });

    const empty = harness.repository.getTrainingSummary(
      { from: '2026-10-01', to: '2026-10-07' },
      TODAY,
    );
    expect(empty.summary.adherenceRate).toBeNull();
    expect(empty.summary.plannedCount).toBe(0);
  });

  it('derives today from the athlete settings timezone offset rather than server UTC', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse('2026-09-21T20:30:00.000Z'));
      // UTC date is 2026-09-21; with +08:00 the local date is 2026-09-22.
      const defaultOffset = harness.repository.getTrainingSummary({
        from: '2026-09-18',
        to: '2026-09-25',
      });
      expect(defaultOffset.generatedForLocalDate).toBe('2026-09-22');

      harness.repository.updateAthleteSettings({ timezoneOffsetMinutes: 0 });
      const utcOffset = harness.repository.getTrainingSummary({
        from: '2026-09-18',
        to: '2026-09-25',
      });
      expect(utcOffset.generatedForLocalDate).toBe('2026-09-21');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rolls weeks up Monday-start, zero-fills, orders oldest first, and only counts in-range plans', () => {
    // 2026-08-31 is a Monday; the range 2026-09-01..2026-09-15 touches three
    // Monday-start weeks: 08-31..09-06, 09-07..09-13, 09-14..09-20.
    const completed = harness.repository.createPlannedWorkout({
      scheduledLocalDate: '2026-09-01',
      workoutType: 'EASY_RUN',
      title: '完成',
    });
    harness.repository.updatePlannedWorkoutCompletion(completed.id, {
      completionStatus: 'COMPLETED',
      linkedActivityId: null,
    });
    createPlan('2026-09-09', '逾期');
    createPlan('2026-09-14', '逾期（部分周）');
    // Outside the request range: must not be counted.
    createPlan('2026-08-31', '范围外');
    createPlan('2026-09-16', '范围外');

    const summary = harness.repository.getTrainingSummary(
      { from: '2026-09-01', to: '2026-09-15' },
      TODAY,
    );
    expect(summary.weeklyRollups.map((rollup) => rollup.weekStartLocalDate)).toEqual([
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
    ]);
    // Partial first and last weeks keep full natural-week labels.
    expect(summary.weeklyRollups[0]?.weekEndLocalDate).toBe('2026-09-06');
    expect(summary.weeklyRollups[2]?.weekEndLocalDate).toBe('2026-09-20');
    expect(summary.weeklyRollups[0]).toMatchObject({
      plannedCount: 1,
      completedCount: 1,
    });
    expect(summary.weeklyRollups[1]).toMatchObject({
      plannedCount: 1,
      overdueCount: 1,
      adherenceRate: 0,
    });
    expect(summary.weeklyRollups[2]).toMatchObject({
      plannedCount: 1,
      overdueCount: 1,
      adherenceRate: 0,
    });
    expect(summary.summary.plannedCount).toBe(3);
  });

  it('handles cross-month, cross-year, and Monday boundaries', () => {
    // 2026-11-30 is a Monday; 2026-12-31 is a Thursday. A plan on Monday
    // itself belongs to that Monday's week.
    createPlan('2026-11-30', '周一计划');
    createPlan('2026-12-31', '年末计划');
    createPlan('2027-01-01', '跨年计划');
    const summary = harness.repository.getTrainingSummary(
      { from: '2026-11-30', to: '2027-01-01' },
      TODAY,
    );
    expect(summary.weeklyRollups.map((rollup) => rollup.weekStartLocalDate)).toEqual([
      '2026-11-30',
      '2026-12-07',
      '2026-12-14',
      '2026-12-21',
      '2026-12-28',
    ]);
    expect(summary.weeklyRollups[0]?.plannedCount).toBe(1);
    expect(summary.weeklyRollups[4]?.plannedCount).toBe(2);
    expect(summary.summary.plannedCount).toBe(3);
    expect(summary.summary.upcomingCount).toBe(3);
  });

  it('allows 93 days but rejects 94 days and invalid ranges with 400', async () => {
    const allowed = await getTrainingSummary(harness.app, 'from=2026-01-01&to=2026-04-03');
    expect(allowed.status).toBe(200);
    expect(() => trainingSummaryResponseSchema.parse(allowed.json)).not.toThrow();

    const rejected = await getTrainingSummary(harness.app, 'from=2026-01-01&to=2026-04-04');
    expect(rejected.status).toBe(400);
    expect((rejected.json as { code: string }).code).toBe('INVALID_TRAINING_SUMMARY_QUERY');

    for (const query of [
      'from=2026-09-22&to=2026-09-21',
      'from=not-a-date&to=2026-09-21',
      'to=2026-09-21',
    ]) {
      const invalid = await getTrainingSummary(harness.app, query);
      expect(invalid.status, query).toBe(400);
    }
  });

  it('keeps the query count constant regardless of plan count and never reads samples', () => {
    const countQueries = (planCount: number): { total: number; sampleQueries: number } => {
      for (let index = 0; index < planCount; index += 1) {
        createPlan(`2026-09-${(1 + (index % 28)).toString().padStart(2, '0')}`, `计划 ${index}`);
      }
      let total = 0;
      let sampleQueries = 0;
      const originalPrepare = harness.database.sqlite.prepare.bind(harness.database.sqlite);
      harness.database.sqlite.prepare = (...args: Parameters<typeof originalPrepare>) => {
        total += 1;
        const text = String(args[0]);
        if (text.includes('activity_samples')) sampleQueries += 1;
        return originalPrepare(...args);
      };
      try {
        harness.repository.getTrainingSummary({ from: '2026-09-01', to: '2026-09-28' }, TODAY);
      } finally {
        harness.database.sqlite.prepare = originalPrepare;
      }
      return { total, sampleQueries };
    };
    const small = countQueries(1);
    const large = countQueries(30);
    expect(small.total).toBe(large.total);
    expect(small.total).toBeLessThanOrEqual(3);
    expect(small.sampleQueries).toBe(0);
    expect(large.sampleQueries).toBe(0);
  });
});

describe('calendar projection with linked activities', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await teardownHarness(harness);
  });

  it('returns a bounded linked activity summary even when it lies outside the calendar range', async () => {
    const inRangeActivity = createActivity(harness.repository, harness.fileStore, '2026-09-20');
    const outOfRangeActivity = createActivity(harness.repository, harness.fileStore, '2026-08-15');
    const created = await createWorkout(harness.app, {
      scheduledLocalDate: '2026-09-20',
      workoutType: 'EASY_RUN',
      title: '关联范围外活动',
    });
    const workoutId = (created.json as { id: string }).id;
    const linked = await patchCompletion(harness.app, workoutId, {
      completionStatus: 'COMPLETED',
      linkedActivityId: outOfRangeActivity,
    });
    expect(linked.status).toBe(200);

    const calendar = await harness.app.inject({
      method: 'GET',
      url: '/api/calendar?from=2026-09-20&to=2026-09-21',
    });
    expect(calendar.statusCode).toBe(200);
    const parsed = calendarResponseSchema.parse(calendar.json());
    const workout = parsed.plannedWorkouts.find((entry) => entry.id === workoutId);
    expect(workout?.completionStatus).toBe('COMPLETED');
    expect(workout?.linkedActivityId).toBe(outOfRangeActivity);
    expect(workout?.linkedActivity).toMatchObject({
      id: outOfRangeActivity,
      localDate: '2026-08-15',
      name: '实际活动 2026-08-15',
      distanceMeters: 5000,
      durationSeconds: 1500,
    });
    // The activities array still only contains in-range activities.
    expect(parsed.activities.map((activity) => activity.id)).toEqual([inRangeActivity]);
    // No samples, laps, or source payloads anywhere in the response.
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain('samples');
    expect(serialized).not.toContain('laps');
    expect(serialized).not.toContain('sources');
    expect(serialized).not.toContain('rawPayload');
  });

  it('keeps the calendar query count bounded regardless of record count (no N+1)', async () => {
    const countQueries = async (workoutCount: number): Promise<number> => {
      for (let index = 0; index < workoutCount; index += 1) {
        // Each workout links its own activity so every calendar row carries a
        // linked-activity summary.
        const activityId = createActivity(
          harness.repository,
          harness.fileStore,
          `2026-09-${(1 + (index % 28)).toString().padStart(2, '0')}`,
        );
        const created = await createWorkout(harness.app, {
          scheduledLocalDate: '2026-09-20',
          workoutType: 'EASY_RUN',
          title: `训练 ${index}`,
        });
        const patched = await patchCompletion(harness.app, (created.json as { id: string }).id, {
          completionStatus: 'COMPLETED',
          linkedActivityId: activityId,
        });
        expect(patched.status).toBe(200);
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
    const smallCount = await countQueries(1);
    const largeCount = await countQueries(20);
    expect(smallCount).toBeLessThanOrEqual(4);
    expect(largeCount).toBeLessThanOrEqual(4);
    expect(smallCount).toBe(largeCount);
  });
});
