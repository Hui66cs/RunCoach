import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { NormalizedActivity } from '@runcoach/shared';
import { trendsResponseSchema } from '@runcoach/shared';
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
  distanceMeters?: number | null;
  durationSeconds?: number | null;
  movingDurationSeconds?: number | null;
  averageHeartRateBpm?: number | null;
}

function createActivity(
  repository: ActivityRepository,
  fileStore: RawFileStore,
  activity: SyntheticActivity,
): string {
  sourceCounter += 1;
  const label = `trends-${sourceCounter}`;
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
    name: `合成 ${label}`,
    notes: null,
    distanceMeters: activity.distanceMeters ?? null,
    durationSeconds: activity.durationSeconds ?? null,
    movingDurationSeconds: activity.movingDurationSeconds ?? null,
    averageHeartRateBpm: activity.averageHeartRateBpm ?? null,
    maxHeartRateBpm: null,
    deviceName: 'TrendsTest',
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

describe('trends aggregation', () => {
  let directory: string;
  let database: DatabaseContext;
  let repository: ActivityRepository;
  let fileStore: RawFileStore;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-trends-'));
    database = openDatabase(path.join(directory, 'runcoach.db'));
    applyMigrations(database.sqlite, path.resolve('apps/server/drizzle'));
    repository = new ActivityRepository(database.db);
    fileStore = new RawFileStore(directory);
  });

  afterEach(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('returns exactly 12/26/52 zero-filled weekly points for an empty database', () => {
    for (const weeks of [12, 26, 52] as const) {
      const trends = repository.getTrends({ weeks }, TODAY);
      expect(() => trendsResponseSchema.parse(trends)).not.toThrow();
      expect(trends.weeks).toBe(weeks);
      expect(trends.weeklyPoints).toHaveLength(weeks);
      expect(trends.summary).toEqual({
        runs: 0,
        totalDistanceMeters: 0,
        totalMovingDurationSeconds: 0,
        averagePaceSecondsPerKilometer: null,
        averageHeartRateBpm: null,
      });
      expect(
        trends.weeklyPoints.every(
          (point) =>
            point.runs === 0 &&
            point.totalDistanceMeters === 0 &&
            point.totalMovingDurationSeconds === 0 &&
            point.averagePaceSecondsPerKilometer === null &&
            point.averageHeartRateBpm === null,
        ),
      ).toBe(true);
    }
  });

  it('orders weekly points oldest first with the current week last', () => {
    const trends = repository.getTrends({ weeks: 12 }, TODAY);
    expect(trends.weeklyPoints.at(-1)).toMatchObject({
      weekStartLocalDate: '2026-09-21',
      weekEndLocalDate: '2026-09-27',
    });
    for (let index = 1; index < trends.weeklyPoints.length; index += 1) {
      const previous = trends.weeklyPoints[index - 1]!;
      const current = trends.weeklyPoints[index]!;
      expect(new Date(previous.weekStartLocalDate).getTime()).toBeLessThan(
        new Date(current.weekStartLocalDate).getTime(),
      );
      expect(new Date(previous.weekEndLocalDate).getTime()).toBeLessThan(
        new Date(current.weekEndLocalDate).getTime(),
      );
    }
  });

  it('separates Sunday and Monday runs across Monday-start weeks', () => {
    createActivity(repository, fileStore, { localDate: '2026-09-20', distanceMeters: 2000 });
    createActivity(repository, fileStore, { localDate: '2026-09-21', distanceMeters: 3000 });
    const trends = repository.getTrends({ weeks: 12 }, TODAY);
    expect(trends.weeklyPoints.at(-1)).toMatchObject({ runs: 1, totalDistanceMeters: 3000 });
    expect(trends.weeklyPoints.at(-2)).toMatchObject({ runs: 1, totalDistanceMeters: 2000 });
  });

  it('keeps weekly windows continuous across year boundaries', () => {
    createActivity(repository, fileStore, { localDate: '2025-12-29', distanceMeters: 1500 });
    createActivity(repository, fileStore, { localDate: '2026-01-01', distanceMeters: 2500 });
    const trends = repository.getTrends({ weeks: 12 }, '2026-01-01');
    expect(trends.weeklyPoints.at(-1)).toMatchObject({
      weekStartLocalDate: '2025-12-29',
      weekEndLocalDate: '2026-01-04',
      runs: 2,
      totalDistanceMeters: 4000,
    });
    expect(trends.weeklyPoints[0]?.weekStartLocalDate).toBe('2025-10-13');
  });

  it('excludes activities with a future local date from the current week', () => {
    createActivity(repository, fileStore, { localDate: TODAY, distanceMeters: 1000 });
    createActivity(repository, fileStore, { localDate: '2026-09-25', distanceMeters: 9000 });
    const trends = repository.getTrends({ weeks: 12 }, TODAY);
    expect(trends.summary.runs).toBe(1);
    expect(trends.summary.totalDistanceMeters).toBe(1000);
    expect(trends.weeklyPoints.at(-1)).toMatchObject({ runs: 1, totalDistanceMeters: 1000 });
  });

  it('counts only RUN activities towards trends', () => {
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
    const trends = repository.getTrends({ weeks: 12 }, TODAY);
    expect(trends.summary.runs).toBe(1);
    expect(trends.summary.totalDistanceMeters).toBe(1000);
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
    const trends = repository.getTrends({ weeks: 12 }, TODAY);
    expect(trends.summary.totalMovingDurationSeconds).toBe(300 + 500 + 0);
  });

  it('computes weekly pace from summed duration and distance, never null as 0', () => {
    createActivity(repository, fileStore, {
      localDate: '2026-09-21',
      distanceMeters: 1000,
      durationSeconds: 300,
    });
    createActivity(repository, fileStore, {
      localDate: '2026-09-22',
      distanceMeters: 3000,
      durationSeconds: 1500,
    });
    const trends = repository.getTrends({ weeks: 12 }, TODAY);
    expect(trends.weeklyPoints.at(-1)?.averagePaceSecondsPerKilometer).toBe(450);
  });

  it('returns null weekly pace when weekly distance or effective duration is zero', () => {
    // Current week: positive distance but no effective duration at all.
    createActivity(repository, fileStore, {
      localDate: '2026-09-21',
      distanceMeters: 1000,
      durationSeconds: null,
      movingDurationSeconds: null,
    });
    // An earlier week: duration but no distance.
    createActivity(repository, fileStore, {
      localDate: '2026-09-07',
      distanceMeters: null,
      durationSeconds: 600,
    });
    const trends = repository.getTrends({ weeks: 12 }, TODAY);
    expect(trends.weeklyPoints.at(-1)?.averagePaceSecondsPerKilometer).toBeNull();
    expect(trends.weeklyPoints.at(-3)?.averagePaceSecondsPerKilometer).toBeNull();
  });

  it('weights weekly heart rate by effective moving duration and skips invalid records', () => {
    // Injected today is the Sunday of the current week so all fixtures inside
    // the same Monday-start week are within the local-date upper bound.
    createActivity(repository, fileStore, {
      localDate: '2026-09-21',
      distanceMeters: 1000,
      durationSeconds: 300,
      movingDurationSeconds: 300,
      averageHeartRateBpm: 150,
    });
    createActivity(repository, fileStore, {
      localDate: '2026-09-22',
      distanceMeters: 1000,
      durationSeconds: 100,
      movingDurationSeconds: 100,
      averageHeartRateBpm: 160,
    });
    createActivity(repository, fileStore, {
      localDate: '2026-09-23',
      distanceMeters: 1000,
      durationSeconds: 200,
      movingDurationSeconds: 200,
      averageHeartRateBpm: null, // no heart rate: excluded
    });
    createActivity(repository, fileStore, {
      localDate: '2026-09-24',
      distanceMeters: 1000,
      durationSeconds: 200,
      movingDurationSeconds: 200,
      averageHeartRateBpm: 0, // non-positive heart rate: excluded
    });
    createActivity(repository, fileStore, {
      localDate: '2026-09-25',
      distanceMeters: 1000,
      durationSeconds: 300,
      movingDurationSeconds: null,
      averageHeartRateBpm: 170, // duration falls back to 300, still counted
    });
    const trends = repository.getTrends({ weeks: 12 }, '2026-09-27');
    // (150*300 + 160*100 + 170*300) / (300 + 100 + 300) = 112000 / 700 = 160
    expect(trends.weeklyPoints.at(-1)?.averageHeartRateBpm).toBeCloseTo(112000 / 700, 6);
  });

  it('returns null heart rate without any valid heart-rate coverage', () => {
    createActivity(repository, fileStore, {
      localDate: TODAY,
      distanceMeters: 1000,
      durationSeconds: 300,
      averageHeartRateBpm: null,
    });
    createActivity(repository, fileStore, {
      localDate: TODAY,
      distanceMeters: 1000,
      durationSeconds: null,
      movingDurationSeconds: null,
      averageHeartRateBpm: 150, // no effective duration: excluded
    });
    const trends = repository.getTrends({ weeks: 12 }, TODAY);
    expect(trends.summary.averageHeartRateBpm).toBeNull();
    expect(trends.weeklyPoints.every((point) => point.averageHeartRateBpm === null)).toBe(true);
  });

  it('computes the range summary from totals, not by averaging weekly values', () => {
    // Week A: 1000 m / 300 s -> 300 s/km; Week B: 3000 m / 1500 s -> 500 s/km.
    createActivity(repository, fileStore, {
      localDate: '2026-09-21',
      distanceMeters: 1000,
      durationSeconds: 300,
      movingDurationSeconds: 300,
      averageHeartRateBpm: 150,
    });
    createActivity(repository, fileStore, {
      localDate: '2026-09-07',
      distanceMeters: 3000,
      durationSeconds: 1500,
      movingDurationSeconds: 1500,
      averageHeartRateBpm: 160,
    });
    const trends = repository.getTrends({ weeks: 12 }, TODAY);
    const paceA = trends.weeklyPoints.at(-1)?.averagePaceSecondsPerKilometer;
    const paceB = trends.weeklyPoints.at(-3)?.averagePaceSecondsPerKilometer;
    expect(paceA).toBe(300);
    expect(paceB).toBe(500);
    // Summary: 1800 s / 4000 m * 1000 = 450, not (300 + 500) / 2 = 400.
    expect(trends.summary.averagePaceSecondsPerKilometer).toBe(450);
    // Summary heart rate: (150*300 + 160*1500) / 1800, not (150+160)/2 = 155.
    expect(trends.summary.averageHeartRateBpm).toBeCloseTo((150 * 300 + 160 * 1500) / 1800, 6);
    expect(trends.summary.runs).toBe(2);
    expect(trends.summary.totalDistanceMeters).toBe(4000);
  });

  it('keeps the query count constant regardless of activity count (no N+1)', () => {
    const countQueries = (activityCount: number): number => {
      for (let index = 0; index < activityCount; index += 1) {
        createActivity(repository, fileStore, {
          localDate: `2026-09-${10 + (index % 10)}`,
          distanceMeters: 1000,
          durationSeconds: 300,
          averageHeartRateBpm: 150,
        });
      }
      let count = 0;
      const originalPrepare = database.sqlite.prepare.bind(database.sqlite);
      database.sqlite.prepare = (...args: Parameters<typeof originalPrepare>) => {
        count += 1;
        return originalPrepare(...args);
      };
      try {
        repository.getTrends({ weeks: 52 }, TODAY);
      } finally {
        database.sqlite.prepare = originalPrepare;
      }
      return count;
    };
    const smallCount = countQueries(1);
    sourceCounter = 100;
    const largeCount = countQueries(30);
    expect(smallCount).toBeLessThanOrEqual(4);
    expect(largeCount).toBeLessThanOrEqual(4);
    expect(smallCount).toBe(largeCount);
  });
});

describe('trends HTTP API', () => {
  let directory: string;
  let database: DatabaseContext;
  let app: FastifyInstance;
  let repository: ActivityRepository;
  let fileStore: RawFileStore;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-trends-api-'));
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

  it('defaults to 12 weeks and validates the response against the shared schema', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/trends' });
    expect(response.statusCode).toBe(200);
    const parsed = trendsResponseSchema.parse(response.json());
    expect(parsed.weeks).toBe(12);
    expect(parsed.weeklyPoints).toHaveLength(12);
    expect(JSON.stringify(parsed)).not.toContain('samples');
  });

  it('accepts explicit valid week ranges and returns the matching length', async () => {
    for (const weeks of [12, 26, 52] as const) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/trends?weeks=${weeks}`,
      });
      expect(response.statusCode).toBe(200);
      const parsed = trendsResponseSchema.parse(response.json());
      expect(parsed.weeks).toBe(weeks);
      expect(parsed.weeklyPoints).toHaveLength(weeks);
    }
  });

  it('rejects invalid weeks values with 400', async () => {
    for (const weeks of ['0', '13', '53', 'abc', '-12', '12.5']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/trends?weeks=${weeks}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('INVALID_TRENDS_QUERY');
    }
  });

  it('returns real data without samples for today runs', async () => {
    const today = localDateFromUtcTime(Date.now(), DEFAULT_OFFSET);
    createActivity(repository, fileStore, {
      localDate: today,
      distanceMeters: 5000,
      durationSeconds: 1500,
      movingDurationSeconds: 1400,
      averageHeartRateBpm: 150,
      name: '今日合成跑',
    });
    const response = await app.inject({ method: 'GET', url: '/api/trends?weeks=12' });
    expect(response.statusCode).toBe(200);
    const parsed = trendsResponseSchema.parse(response.json());
    expect(parsed.summary.runs).toBe(1);
    expect(parsed.summary.totalDistanceMeters).toBe(5000);
    expect(parsed.summary.averagePaceSecondsPerKilometer).toBeCloseTo(280);
    expect(parsed.summary.averageHeartRateBpm).toBe(150);
    expect(parsed.weeklyPoints.at(-1)?.runs).toBe(1);
    expect(Object.keys(parsed)).not.toContain('samples');
    expect(Object.keys(parsed.weeklyPoints[0]!)).not.toContain('samples');
  });
});
