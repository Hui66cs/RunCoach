import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { NormalizedActivity } from '@runcoach/shared';
import { dashboardResponseSchema } from '@runcoach/shared';
import { buildApp } from '../src/app.js';
import { localDateFromUtcTime } from '../src/dashboard-dates.js';
import { openDatabase, type DatabaseContext } from '../src/db/client.js';
import { applyMigrations } from '../src/db/migrate.js';
import { ActivityRepository } from '../src/repositories/activity-repository.js';
import { ImportService } from '../src/services/import-service.js';
import { RawFileStore } from '../src/storage/raw-file-store.js';

const TODAY = '2026-09-22'; // Tuesday; current week runs 2026-09-21 .. 2026-09-27.
const DEFAULT_OFFSET = 480;

let sourceCounter = 0;

interface SyntheticActivity {
  localDate: string;
  activityType?: 'RUN' | 'STRENGTH' | 'OTHER';
  name?: string;
  distanceMeters?: number | null;
  durationSeconds?: number | null;
  movingDurationSeconds?: number | null;
}

function createActivity(
  repository: ActivityRepository,
  fileStore: RawFileStore,
  activity: SyntheticActivity,
): string {
  sourceCounter += 1;
  const label = `dashboard-${sourceCounter}`;
  const stored = fileStore.save(Buffer.from(label), `${label}.fit`, 'application/octet-stream');
  const rawFileId = repository.ensureRawFile(stored);
  const jobId = repository.createImportJob('FIT', `${label}.fit`, rawFileId);
  const itemId = repository.createImportItem(jobId);
  const normalized: NormalizedActivity = {
    sourceType: 'FIT',
    sourceExternalId: `${label}-external`,
    sourceIdentityKey: `${label}-identity`,
    activityType: activity.activityType ?? 'RUN',
    startTimeUtc: `${activity.localDate}T00:00:00.000Z`,
    originalStartTime: `${activity.localDate}T08:00:00+08:00`,
    timezoneOffsetMinutes: DEFAULT_OFFSET,
    localDate: activity.localDate,
    name: activity.name ?? `合成 ${label}`,
    notes: null,
    distanceMeters: activity.distanceMeters ?? null,
    durationSeconds: activity.durationSeconds ?? null,
    movingDurationSeconds: activity.movingDurationSeconds ?? null,
    averageHeartRateBpm: null,
    maxHeartRateBpm: null,
    deviceName: 'DashboardTest',
    laps: [],
    rawSummary: {},
    samples: [],
  };
  const created = repository.createActivityFromSource({
    normalized,
    rawFileId,
    fileSha256: stored.sha256,
    rawPayload: {},
    importItemId: itemId,
  });
  return created.activityId;
}

describe('dashboard aggregation', () => {
  let directory: string;
  let database: DatabaseContext;
  let repository: ActivityRepository;
  let fileStore: RawFileStore;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-dashboard-'));
    database = openDatabase(path.join(directory, 'runcoach.db'));
    applyMigrations(database.sqlite, path.resolve('apps/server/drizzle'));
    repository = new ActivityRepository(database.db);
    fileStore = new RawFileStore(directory);
  });

  afterEach(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('returns zero-filled windows and an empty recent list for an empty database', () => {
    const dashboard = repository.getDashboard(TODAY);
    expect(() => dashboardResponseSchema.parse(dashboard)).not.toThrow();
    expect(dashboard.generatedForLocalDate).toBe(TODAY);
    expect(dashboard.timezoneOffsetMinutes).toBe(DEFAULT_OFFSET);
    expect(dashboard.last7Days).toEqual({
      runs: 0,
      totalDistanceMeters: 0,
      totalMovingDurationSeconds: 0,
      averagePaceSecondsPerKilometer: null,
    });
    expect(dashboard.last28Days.runs).toBe(0);
    expect(dashboard.weeklyVolumes).toHaveLength(12);
    expect(dashboard.weeklyVolumes.at(-1)?.weekStartLocalDate).toBe('2026-09-21');
    expect(
      dashboard.weeklyVolumes.every(
        (week) =>
          week.runs === 0 &&
          week.totalDistanceMeters === 0 &&
          week.totalMovingDurationSeconds === 0,
      ),
    ).toBe(true);
    expect(dashboard.recentActivities).toEqual([]);
  });

  it('applies inclusive 7/28-day boundaries', () => {
    createActivity(repository, fileStore, { localDate: TODAY, distanceMeters: 1000 });
    createActivity(repository, fileStore, { localDate: '2026-09-16', distanceMeters: 1000 }); // today-6, in 7d
    createActivity(repository, fileStore, { localDate: '2026-09-15', distanceMeters: 1000 }); // today-7, only 28d
    createActivity(repository, fileStore, { localDate: '2026-08-26', distanceMeters: 1000 }); // today-27, in 28d
    createActivity(repository, fileStore, { localDate: '2026-08-25', distanceMeters: 1000 }); // today-28, outside
    const dashboard = repository.getDashboard(TODAY);
    expect(dashboard.last7Days.runs).toBe(2);
    expect(dashboard.last28Days.runs).toBe(4);
    expect(dashboard.last28Days.totalDistanceMeters).toBe(4000);
  });

  it('groups Monday-start weeks and separates adjacent weeks', () => {
    createActivity(repository, fileStore, { localDate: '2026-09-20', distanceMeters: 2000 }); // Sunday, previous week
    createActivity(repository, fileStore, { localDate: '2026-09-21', distanceMeters: 3000 }); // Monday, current week
    const dashboard = repository.getDashboard(TODAY);
    const currentWeek = dashboard.weeklyVolumes.at(-1)!;
    const previousWeek = dashboard.weeklyVolumes.at(-2)!;
    expect(currentWeek.weekStartLocalDate).toBe('2026-09-21');
    expect(currentWeek.weekEndLocalDate).toBe('2026-09-27');
    expect(currentWeek.runs).toBe(1);
    expect(currentWeek.totalDistanceMeters).toBe(3000);
    expect(previousWeek.weekStartLocalDate).toBe('2026-09-14');
    expect(previousWeek.runs).toBe(1);
    expect(previousWeek.totalDistanceMeters).toBe(2000);
  });

  it('keeps weekly windows continuous across year boundaries', () => {
    createActivity(repository, fileStore, { localDate: '2025-12-29', distanceMeters: 1500 });
    createActivity(repository, fileStore, { localDate: '2026-01-01', distanceMeters: 2500 });
    const dashboard = repository.getDashboard('2026-01-01');
    const currentWeek = dashboard.weeklyVolumes.at(-1)!;
    expect(currentWeek.weekStartLocalDate).toBe('2025-12-29');
    expect(currentWeek.weekEndLocalDate).toBe('2026-01-04');
    expect(currentWeek.runs).toBe(2);
    expect(currentWeek.totalDistanceMeters).toBe(4000);
    expect(dashboard.weeklyVolumes).toHaveLength(12);
    expect(dashboard.weeklyVolumes[0]?.weekStartLocalDate).toBe('2025-10-13');
  });

  it('zero-fills all twelve weeks when only the current week has runs', () => {
    createActivity(repository, fileStore, { localDate: TODAY, distanceMeters: 1000 });
    const dashboard = repository.getDashboard(TODAY);
    expect(dashboard.weeklyVolumes).toHaveLength(12);
    expect(dashboard.weeklyVolumes.filter((week) => week.runs === 1)).toHaveLength(1);
    for (let index = 1; index < dashboard.weeklyVolumes.length; index += 1) {
      const previous = dashboard.weeklyVolumes[index - 1]!;
      const current = dashboard.weeklyVolumes[index]!;
      expect(new Date(current.weekStartLocalDate).getTime()).toBeGreaterThan(
        new Date(previous.weekStartLocalDate).getTime(),
      );
    }
  });

  it('counts only RUN activities towards volume statistics', () => {
    createActivity(repository, fileStore, { localDate: TODAY, distanceMeters: 1000 });
    createActivity(repository, fileStore, {
      localDate: TODAY,
      activityType: 'STRENGTH',
      distanceMeters: 1000,
      durationSeconds: 1800,
    });
    createActivity(repository, fileStore, {
      localDate: TODAY,
      activityType: 'OTHER',
      distanceMeters: 1000,
      durationSeconds: 1800,
    });
    const dashboard = repository.getDashboard(TODAY);
    expect(dashboard.last7Days.runs).toBe(1);
    expect(dashboard.last7Days.totalDistanceMeters).toBe(1000);
    expect(dashboard.recentActivities).toHaveLength(3);
  });

  it('falls back from movingDurationSeconds to durationSeconds and then to zero', () => {
    createActivity(repository, fileStore, {
      localDate: TODAY,
      distanceMeters: 1000,
      durationSeconds: 400,
      movingDurationSeconds: 300,
    });
    createActivity(repository, fileStore, {
      localDate: TODAY,
      distanceMeters: 1000,
      durationSeconds: 500,
      movingDurationSeconds: null,
    });
    createActivity(repository, fileStore, {
      localDate: TODAY,
      distanceMeters: 1000,
      durationSeconds: null,
      movingDurationSeconds: null,
    });
    const dashboard = repository.getDashboard(TODAY);
    expect(dashboard.last7Days.totalMovingDurationSeconds).toBe(300 + 500 + 0);
  });

  it('returns null average pace when total distance is zero', () => {
    createActivity(repository, fileStore, { localDate: TODAY, durationSeconds: 1800 });
    const dashboard = repository.getDashboard(TODAY);
    expect(dashboard.last7Days.runs).toBe(1);
    expect(dashboard.last7Days.totalDistanceMeters).toBe(0);
    expect(dashboard.last7Days.averagePaceSecondsPerKilometer).toBeNull();
  });

  it('computes pace from summed duration and distance, not per-activity averages', () => {
    createActivity(repository, fileStore, {
      localDate: TODAY,
      distanceMeters: 1000,
      durationSeconds: 300,
    });
    createActivity(repository, fileStore, {
      localDate: TODAY,
      distanceMeters: 3000,
      durationSeconds: 1500,
    });
    const dashboard = repository.getDashboard(TODAY);
    // (300 + 1500) / 4000 * 1000 = 450 s/km — the arithmetic mean of the two
    // paces (300 and 500) would wrongly be 400.
    expect(dashboard.last7Days.averagePaceSecondsPerKilometer).toBe(450);
  });

  it('returns at most five recent activities ordered by date descending', () => {
    for (let index = 0; index < 7; index += 1) {
      createActivity(repository, fileStore, {
        localDate: `2026-09-${11 + index}`,
        distanceMeters: 1000,
        name: `活动 ${index}`,
      });
    }
    const dashboard = repository.getDashboard(TODAY);
    expect(dashboard.recentActivities).toHaveLength(5);
    const dates = dashboard.recentActivities.map((activity) => activity.localDate);
    expect([...dates].sort((a, b) => (a < b ? 1 : -1))).toEqual(dates);
    expect(dates[0]).toBe('2026-09-17');
  });

  it('keeps the query count constant regardless of activity count (no N+1)', () => {
    const countQueries = (activityCount: number): number => {
      for (let index = 0; index < activityCount; index += 1) {
        createActivity(repository, fileStore, {
          localDate: `2026-09-${10 + (index % 20)}`,
          distanceMeters: 1000,
        });
      }
      let count = 0;
      const originalPrepare = database.sqlite.prepare.bind(database.sqlite);
      database.sqlite.prepare = (...args: Parameters<typeof originalPrepare>) => {
        count += 1;
        return originalPrepare(...args);
      };
      try {
        repository.getDashboard(TODAY);
      } finally {
        database.sqlite.prepare = originalPrepare;
      }
      return count;
    };
    const smallCount = countQueries(1);
    sourceCounter = 100;
    const largeCount = countQueries(30);
    expect(smallCount).toBeLessThanOrEqual(5);
    expect(largeCount).toBeLessThanOrEqual(5);
  });

  it('derives today from athlete settings timezone when not injected', () => {
    const now = Date.UTC(2026, 8, 22, 17, 30); // 2026-09-23 01:30 at +08:00
    const realDateNow = Date.now;
    Date.now = () => now;
    try {
      const dashboard = repository.getDashboard();
      expect(dashboard.generatedForLocalDate).toBe('2026-09-23');
      expect(dashboard.timezoneOffsetMinutes).toBe(DEFAULT_OFFSET);
    } finally {
      Date.now = realDateNow;
    }
  });
});

describe('dashboard HTTP API', () => {
  let directory: string;
  let database: DatabaseContext;
  let app: FastifyInstance;
  let repository: ActivityRepository;
  let fileStore: RawFileStore;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-dashboard-api-'));
    database = openDatabase(path.join(directory, 'runcoach.db'));
    applyMigrations(database.sqlite, path.resolve('apps/server/drizzle'));
    repository = new ActivityRepository(database.db);
    fileStore = new RawFileStore(directory);
    app = await buildApp({
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
  });

  afterEach(async () => {
    await app.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('serves an empty bounded dashboard without samples', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/dashboard' });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(() => dashboardResponseSchema.parse(body)).not.toThrow();
    expect(body).not.toHaveProperty('samples');
    expect(body.recentActivities).toEqual([]);
  });

  it('includes today runs in the window and recent activities', async () => {
    const today = localDateFromUtcTime(Date.now(), DEFAULT_OFFSET);
    createActivity(repository, fileStore, {
      localDate: today,
      distanceMeters: 5000,
      durationSeconds: 1500,
      movingDurationSeconds: 1400,
      name: '今日合成跑',
    });
    const response = await app.inject({ method: 'GET', url: '/api/dashboard' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      generatedForLocalDate: string;
      last7Days: { runs: number; averagePaceSecondsPerKilometer: number | null };
      recentActivities: Array<{ name: string | null; samples?: unknown }>;
    }>();
    expect(body.generatedForLocalDate).toBe(today);
    expect(body.last7Days.runs).toBe(1);
    expect(body.last7Days.averagePaceSecondsPerKilometer).toBeCloseTo(280);
    expect(body.recentActivities).toHaveLength(1);
    expect(body.recentActivities[0]?.name).toBe('今日合成跑');
    expect(body.recentActivities[0]).not.toHaveProperty('samples');
  });
});
