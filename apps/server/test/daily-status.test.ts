import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { dailyStatusEntrySchema } from '@runcoach/shared';
import { buildApp } from '../src/app.js';
import { openDatabase, type DatabaseContext } from '../src/db/client.js';
import { applyMigrations } from '../src/db/migrate.js';
import { ActivityRepository } from '../src/repositories/activity-repository.js';
import { ImportService } from '../src/services/import-service.js';
import { RawFileStore } from '../src/storage/raw-file-store.js';

const DEFAULT_OFFSET = 480;

let harness: {
  directory: string;
  database: DatabaseContext;
  app: FastifyInstance;
  repository: ActivityRepository;
  fileStore: RawFileStore;
};

beforeEach(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-daily-status-'));
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
  harness = { directory, database, app, repository, fileStore };
});

afterEach(async () => {
  await harness.app.close();
  harness.database.close();
  fs.rmSync(harness.directory, { recursive: true, force: true });
});

async function putDailyStatus(
  localDate: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await harness.app.inject({
    method: 'PUT',
    url: `/api/daily-status/${localDate}`,
    payload,
  });
  return { status: response.statusCode, json: response.json() };
}

describe('0005 daily training context migration', () => {
  it('upgrades a real 0004-state database, preserves settings, and stays idempotent', () => {
    const migrationsDirectory = path.resolve('apps/server/drizzle');
    const partialDirectory = path.join(harness.directory, 'migrations-0004');
    fs.mkdirSync(partialDirectory);
    for (const file of fs.readdirSync(migrationsDirectory).filter((name) => name < '0005')) {
      fs.copyFileSync(path.join(migrationsDirectory, file), path.join(partialDirectory, file));
    }
    const database = openDatabase(path.join(harness.directory, 'forward.db'));
    try {
      applyMigrations(database.sqlite, partialDirectory);

      // Write pre-0005 athlete settings with raw SQL: the compiled Drizzle
      // schema already knows the new columns, which do not exist in the
      // 0004-state database yet.
      database.sqlite
        .prepare(
          "UPDATE athlete_settings SET max_heart_rate_bpm = ?, timezone_offset_minutes = ? WHERE id = 'default'",
        )
        .run(190, 420);
      const legacyRepository = new ActivityRepository(database.db);
      const legacyPlanned = legacyRepository.createPlannedWorkout({
        scheduledLocalDate: '2026-09-20',
        workoutType: 'EASY_RUN',
        title: '0005 前的计划',
      });

      const columns = database.sqlite
        .prepare('PRAGMA table_info(athlete_settings)')
        .all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain('display_name');
      expect(
        database.sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_status_entries'",
          )
          .get(),
      ).toBeUndefined();

      // Applying the full directory on the same database runs only 0005.
      applyMigrations(database.sqlite, migrationsDirectory);

      // Existing settings survive and the new profile columns default to NULL.
      const row = database.sqlite
        .prepare('SELECT * FROM athlete_settings WHERE id = ?')
        .get('default') as Record<string, unknown>;
      expect(row['max_heart_rate_bpm']).toBe(190);
      expect(row['timezone_offset_minutes']).toBe(420);
      expect(row['display_name']).toBeNull();
      expect(row['experience_level']).toBeNull();
      expect(row['primary_goal']).toBeNull();
      expect(row['weekly_distance_target_meters']).toBeNull();
      // Planned workout data survives untouched.
      expect(legacyRepository.getPlannedWorkout(legacyPlanned.id)?.title).toBe('0005 前的计划');

      // The unique local-date constraint exists and is enforced.
      const uniqueIndexes = database.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'daily_status_entries' AND name = 'daily_status_entries_local_date_uq'",
        )
        .all() as Array<{ name: string }>;
      expect(uniqueIndexes).toHaveLength(1);
      const insert = database.sqlite.prepare(
        "INSERT INTO daily_status_entries (id, local_date, created_at, updated_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
      );
      insert.run('one', '2026-09-20');
      expect(() => insert.run('two', '2026-09-20')).toThrow();
      expect(() => insert.run('three', '2026-09-21')).not.toThrow();

      // Running the full directory again is idempotent.
      applyMigrations(database.sqlite, migrationsDirectory);
      const entryCount = database.sqlite
        .prepare('SELECT count(*) AS c FROM daily_status_entries')
        .get() as { c: number };
      expect(entryCount.c).toBe(2);
    } finally {
      database.close();
    }
  });
});

describe('athlete settings profile fields', () => {
  it('returns the new profile fields with null defaults', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/settings/athlete' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      maxHeartRateBpm: null,
      displayName: null,
      experienceLevel: null,
      primaryGoal: null,
      weeklyDistanceTargetMeters: null,
    });
  });

  it('sets, clears, and keeps every legacy field working', async () => {
    const set = await harness.app.inject({
      method: 'PATCH',
      url: '/api/settings/athlete',
      payload: {
        displayName: '  跑者甲  ',
        experienceLevel: 'INTERMEDIATE',
        primaryGoal: '完成一场全程马拉松',
        weeklyDistanceTargetMeters: 50000,
        maxHeartRateBpm: 190,
      },
    });
    expect(set.statusCode).toBe(200);
    const setBody = set.json<{
      displayName: string;
      experienceLevel: string;
      primaryGoal: string;
      weeklyDistanceTargetMeters: number;
      maxHeartRateBpm: number;
    }>();
    // Values are trimmed before storage.
    expect(setBody.displayName).toBe('跑者甲');
    expect(setBody.experienceLevel).toBe('INTERMEDIATE');
    expect(setBody.primaryGoal).toBe('完成一场全程马拉松');
    expect(setBody.weeklyDistanceTargetMeters).toBe(50000);
    expect(setBody.maxHeartRateBpm).toBe(190);

    const cleared = await harness.app.inject({
      method: 'PATCH',
      url: '/api/settings/athlete',
      payload: {
        displayName: null,
        experienceLevel: null,
        primaryGoal: null,
        weeklyDistanceTargetMeters: null,
      },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      displayName: null,
      experienceLevel: null,
      primaryGoal: null,
      weeklyDistanceTargetMeters: null,
      // Legacy fields survive the profile update.
      maxHeartRateBpm: 190,
    });
  });

  it('rejects invalid profile values with 400', async () => {
    for (const payload of [
      { displayName: '' },
      { displayName: '   ' },
      { displayName: 'x'.repeat(81) },
      { experienceLevel: 'ELITE' },
      { primaryGoal: '' },
      { primaryGoal: 'x'.repeat(201) },
      { weeklyDistanceTargetMeters: 0 },
      { weeklyDistanceTargetMeters: -1000 },
      { weeklyDistanceTargetMeters: 1000.5 },
      { weeklyDistanceTargetMeters: 1_000_001 },
      { weeklyDistanceTargetMeters: 'many' },
    ]) {
      const response = await harness.app.inject({
        method: 'PATCH',
        url: '/api/settings/athlete',
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('INVALID_ATHLETE_SETTINGS');
    }
  });
});

describe('daily status CRUD API', () => {
  it('creates, reads a bounded ascending range, and returns an empty list without data', async () => {
    const empty = await harness.app.inject({
      method: 'GET',
      url: '/api/daily-status?from=2026-09-01&to=2026-09-07',
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ from: '2026-09-01', to: '2026-09-07', items: [] });

    const first = await putDailyStatus('2026-09-03', {
      sleepQuality: 4,
      fatigueLevel: 2,
      muscleSorenessLevel: null,
      stressLevel: 3,
      motivationLevel: 5,
      restingHeartRateBpm: 52,
      notes: '  睡得不错  ',
    });
    expect(first.status).toBe(200);
    const firstEntry = dailyStatusEntrySchema.parse(first.json);
    expect(firstEntry.localDate).toBe('2026-09-03');
    expect(firstEntry.sleepQuality).toBe(4);
    expect(firstEntry.muscleSorenessLevel).toBeNull();
    // Notes are trimmed server-side.
    expect(firstEntry.notes).toBe('睡得不错');

    await putDailyStatus('2026-09-01', { sleepQuality: 2 });
    const range = await harness.app.inject({
      method: 'GET',
      url: '/api/daily-status?from=2026-09-01&to=2026-09-07',
    });
    const body = range.json<{ items: Array<{ localDate: string }> }>();
    expect(body.items.map((item) => item.localDate)).toEqual(['2026-09-01', '2026-09-03']);
  });

  it('upserts the same date instead of creating a second row', async () => {
    const created = await putDailyStatus('2026-09-05', {
      sleepQuality: 3,
      notes: '第一版',
    });
    const original = dailyStatusEntrySchema.parse(created.json);

    const updated = await putDailyStatus('2026-09-05', {
      sleepQuality: 4,
      restingHeartRateBpm: 55,
    });
    expect(updated.status).toBe(200);
    const updatedEntry = dailyStatusEntrySchema.parse(updated.json);
    // Update semantics: same record, createdAt preserved, updatedAt refreshed,
    // absent fields unchanged, newly provided fields written.
    expect(updatedEntry.id).toBe(original.id);
    expect(updatedEntry.createdAt).toBe(original.createdAt);
    expect(updatedEntry.updatedAt >= original.updatedAt).toBe(true);
    expect(updatedEntry.sleepQuality).toBe(4);
    expect(updatedEntry.restingHeartRateBpm).toBe(55);
    expect(updatedEntry.notes).toBe('第一版');

    // An explicit null clears one field while others survive.
    const cleared = await putDailyStatus('2026-09-05', { restingHeartRateBpm: null });
    const clearedEntry = dailyStatusEntrySchema.parse(cleared.json);
    expect(clearedEntry.restingHeartRateBpm).toBeNull();
    expect(clearedEntry.sleepQuality).toBe(4);

    const rows = harness.database.sqlite
      .prepare('SELECT count(*) AS c FROM daily_status_entries WHERE local_date = ?')
      .get('2026-09-05') as { c: number };
    expect(rows.c).toBe(1);
  });

  it('deletes an entry, returns 404 for a second delete, and touches nothing else', async () => {
    const activityId = createActivity('2026-09-20');
    const planned = harness.repository.createPlannedWorkout({
      scheduledLocalDate: '2026-09-20',
      workoutType: 'EASY_RUN',
      title: '删除隔离',
    });
    await putDailyStatus('2026-09-20', { sleepQuality: 4 });

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/daily-status/2026-09-20',
    });
    expect(deleted.statusCode).toBe(204);
    const range = await harness.app.inject({
      method: 'GET',
      url: '/api/daily-status?from=2026-09-20&to=2026-09-20',
    });
    expect(range.json<{ items: unknown[] }>().items).toHaveLength(0);

    const again = await harness.app.inject({
      method: 'DELETE',
      url: '/api/daily-status/2026-09-20',
    });
    expect(again.statusCode).toBe(404);
    expect(again.json<{ code: string }>().code).toBe('NOT_FOUND');

    // Activities and planned workouts are untouched.
    expect(harness.repository.getActivity(activityId)).not.toBeNull();
    expect(harness.repository.getPlannedWorkout(planned.id)).not.toBeNull();
  });

  it('rejects invalid queries and payloads with the documented error codes', async () => {
    const queryCases: Array<[string, string]> = [
      ['from=2026-09-10&to=2026-09-09', 'from > to'],
      ['from=2026-01-01&to=2026-04-04', '94 days'],
      ['from=not-a-date&to=2026-09-09', 'invalid date'],
      ['to=2026-09-09', 'missing from'],
    ];
    for (const [query, label] of queryCases) {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/daily-status?${query}`,
      });
      expect(response.statusCode, label).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('INVALID_DAILY_STATUS_QUERY');
    }

    // 93 days remain allowed.
    expect(
      (
        await harness.app.inject({
          method: 'GET',
          url: '/api/daily-status?from=2026-01-01&to=2026-04-03',
        })
      ).statusCode,
    ).toBe(200);

    const invalidBodies: Array<[Record<string, unknown>, string]> = [
      [{}, 'empty body'],
      [{ sleepQuality: 0 }, 'scale below range'],
      [{ sleepQuality: 6 }, 'scale above range'],
      [{ sleepQuality: 3.5 }, 'decimal scale'],
      [{ sleepQuality: 'good' }, 'non-numeric scale'],
      [{ fatigueLevel: 6 }, 'fatigue above range'],
      [{ restingHeartRateBpm: 29 }, 'rhr below range'],
      [{ restingHeartRateBpm: 221 }, 'rhr above range'],
      [{ restingHeartRateBpm: 50.5 }, 'decimal rhr'],
      [{ notes: 'x'.repeat(2001) }, 'notes too long'],
      [{ notes: 42 }, 'non-string notes'],
      [{ sleepQuality: 3, localDate: '2026-09-05' }, 'localDate in body'],
      [{ sleepQuality: 3, unknownField: 1 }, 'unknown field'],
      [{ readinessScore: 88 }, 'derived score field'],
    ];
    for (const [payload, label] of invalidBodies) {
      const response = await putDailyStatus('2026-09-05', payload);
      expect(response.status, label).toBe(400);
      expect((response.json as { code: string }).code).toBe('INVALID_DAILY_STATUS');
    }
    // Nothing was written by the rejected requests.
    const rows = harness.database.sqlite
      .prepare('SELECT count(*) AS c FROM daily_status_entries')
      .get() as { c: number };
    expect(rows.c).toBe(0);

    // An invalid path date is also rejected.
    const badPath = await harness.app.inject({
      method: 'PUT',
      url: '/api/daily-status/2026-13-40',
      payload: { sleepQuality: 3 },
    });
    expect(badPath.statusCode).toBe(400);
    expect(badPath.json<{ code: string }>().code).toBe('INVALID_DAILY_STATUS');
  });

  it('keeps the query count constant and never reads samples (no N+1)', () => {
    for (let index = 0; index < 30; index += 1) {
      harness.repository.upsertDailyStatusEntry(
        `2026-09-${(1 + index).toString().padStart(2, '0')}`,
        {
          sleepQuality: (index % 5) + 1,
        },
      );
    }
    let count = 0;
    let sampleQueries = 0;
    const originalPrepare = harness.database.sqlite.prepare.bind(harness.database.sqlite);
    harness.database.sqlite.prepare = (...args: Parameters<typeof originalPrepare>) => {
      count += 1;
      if (String(args[0]).includes('activity_samples')) sampleQueries += 1;
      return originalPrepare(...args);
    };
    try {
      const items = harness.repository.listDailyStatusEntries('2026-09-01', '2026-09-30');
      expect(items).toHaveLength(30);
      expect(items.map((item) => item.localDate)).toEqual(
        items.map((item) => item.localDate).sort(),
      );
    } finally {
      harness.database.sqlite.prepare = originalPrepare;
    }
    expect(count).toBe(1);
    expect(sampleQueries).toBe(0);
  });
});

function createActivity(localDate: string): string {
  // Minimal synthetic activity through the production import path.
  const stored = harness.fileStore.save(
    Buffer.from(`daily-status-${localDate}`),
    `daily-status-${localDate}.fit`,
    'application/octet-stream',
  );
  const rawFileId = harness.repository.ensureRawFile(stored);
  const jobId = harness.repository.createImportJob(
    'FIT',
    `daily-status-${localDate}.fit`,
    rawFileId,
  );
  const itemId = harness.repository.createImportItem(jobId);
  return harness.repository.createActivityFromSource({
    normalized: {
      sourceType: 'FIT',
      sourceExternalId: `daily-status-${localDate}`,
      sourceIdentityKey: `daily-status-${localDate}-identity`,
      activityType: 'RUN',
      startTimeUtc: `${localDate}T00:00:00.000Z`,
      originalStartTime: `${localDate}T08:00:00+08:00`,
      timezoneOffsetMinutes: DEFAULT_OFFSET,
      localDate,
      name: `每日状态隔离 ${localDate}`,
      notes: null,
      distanceMeters: 5000,
      durationSeconds: 1500,
      movingDurationSeconds: 1400,
      averageHeartRateBpm: 150,
      maxHeartRateBpm: null,
      deviceName: 'DailyStatusTest',
      laps: [],
      rawSummary: {},
      samples: [],
    },
    rawFileId,
    fileSha256: stored.sha256,
    rawPayload: {},
    importItemId: itemId,
  }).activityId;
}
