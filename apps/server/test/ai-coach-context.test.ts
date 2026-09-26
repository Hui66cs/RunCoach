import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AiCoachContext, NormalizedActivity } from '@runcoach/shared';
import { buildApp } from '../src/app.js';
import { openDatabase, type DatabaseContext } from '../src/db/client.js';
import { applyMigrations } from '../src/db/migrate.js';
import { ActivityRepository } from '../src/repositories/activity-repository.js';
import { AiReviewService } from '../src/services/ai/ai-review-service.js';
import { serializeCoachContext } from '../src/services/ai/coach-context.js';
import type { TrainingReviewProvider } from '../src/services/ai/provider.js';
import { ImportService } from '../src/services/import-service.js';
import { RawFileStore } from '../src/storage/raw-file-store.js';

const TODAY = '2026-09-26'; // Saturday; pinned via fake Date clock.
const DEFAULT_OFFSET = 480;

let sourceCounter = 0;

function createActivity(
  repository: ActivityRepository,
  fileStore: RawFileStore,
  activity: {
    localDate: string;
    activityType?: 'RUN' | 'STRENGTH' | 'OTHER';
    distanceMeters?: number | null;
    durationSeconds?: number | null;
    movingDurationSeconds?: number | null;
    name?: string;
  },
): string {
  sourceCounter += 1;
  const label = `coach-${sourceCounter}`;
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
    notes: '私密备注，不上云之外的字段不出现在上下文',
    distanceMeters: activity.distanceMeters ?? null,
    durationSeconds: activity.durationSeconds ?? null,
    movingDurationSeconds: activity.movingDurationSeconds ?? null,
    averageHeartRateBpm: 150,
    maxHeartRateBpm: 180,
    deviceName: 'CoachTest',
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

interface Harness {
  app: FastifyInstance;
  repository: ActivityRepository;
  fileStore: RawFileStore;
  database: DatabaseContext;
  directory: string;
}

async function buildHarness(): Promise<Harness> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-ai-coach-'));
  const database = openDatabase(path.join(directory, 'runcoach.db'));
  applyMigrations(database.sqlite, path.resolve('apps/server/drizzle'));
  const repository = new ActivityRepository(database.db);
  const fileStore = new RawFileStore(directory);
  const importService = new ImportService(repository, fileStore, DEFAULT_OFFSET);
  const provider: TrainingReviewProvider = {
    complete: () => Promise.resolve({ text: '回顾', model: 'fake' }),
  };
  const app = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir: directory,
      databasePath: path.join(directory, 'runcoach.db'),
      localOffsetMinutes: DEFAULT_OFFSET,
      maxUploadBytes: 1024,
      ai: {
        enabled: true,
        provider: 'none',
        deepSeek: null,
        baseUrl: 'https://api.example.com',
        timeoutMs: 5000,
        maxOutputTokens: 512,
      },
    },
    repository,
    importService,
    aiReview: new AiReviewService(repository, {
      enabled: true,
      provider,
      timeoutMs: 5000,
      maxOutputTokens: 512,
    }),
  });
  return { app, repository, fileStore, database, directory };
}

describe('AI coach context (M7 Batch 1)', () => {
  let harness: Harness | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T04:00:00.000Z')); // 2026-09-26 at UTC+8
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (harness !== undefined) {
      await harness.app.close();
      harness.database.close();
      fs.rmSync(harness.directory, { recursive: true, force: true });
      harness = undefined;
    }
  });

  it('returns an empty-but-valid context for an empty database', async () => {
    harness = await buildHarness();
    const response = await harness.app.inject({ method: 'GET', url: '/api/ai/coach-context' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ context: AiCoachContext; aiEnabled: boolean }>();
    expect(body.aiEnabled).toBe(true);
    expect(body.context.totals).toMatchObject({
      runs: 0,
      totalDistanceMeters: 0,
      firstActivityLocalDate: null,
    });
    expect(body.context.personalBests).toEqual([]);
    expect(body.context.recentActivities).toEqual([]);
    expect(body.context.recentActivitiesTotal).toBe(0);
    expect(body.context.dailyStatus).toEqual([]);
  });

  it('computes deterministic personal bests over the whole history', async () => {
    harness = await buildHarness();
    createActivity(harness.repository, harness.fileStore, {
      localDate: '2026-06-10',
      distanceMeters: 12_000,
      durationSeconds: 3600,
      movingDurationSeconds: 3500,
    });
    createActivity(harness.repository, harness.fileStore, {
      localDate: '2026-08-01',
      distanceMeters: 15_000,
      durationSeconds: 4500,
      movingDurationSeconds: 4400,
    }); // longest distance
    createActivity(harness.repository, harness.fileStore, {
      localDate: '2026-05-20',
      distanceMeters: 10_000,
      durationSeconds: 3000,
      movingDurationSeconds: 2900,
    }); // fastest pace 0.3 s/m
    createActivity(harness.repository, harness.fileStore, {
      localDate: '2026-04-10',
      activityType: 'STRENGTH',
      distanceMeters: null,
      durationSeconds: 7200,
    }); // non-RUN: excluded from PBs
    const response = await harness.app.inject({ method: 'GET', url: '/api/ai/coach-context' });
    expect(response.statusCode).toBe(200);
    const { context } = response.json<{ context: AiCoachContext }>();
    const byMetric = Object.fromEntries(context.personalBests.map((best) => [best.metric, best]));
    expect(byMetric.LONGEST_DISTANCE).toMatchObject({ value: 15_000, achievedOn: '2026-08-01' });
    expect(byMetric.LONGEST_DURATION).toMatchObject({ value: 4400, achievedOn: '2026-08-01' });
    expect(byMetric.FASTEST_AVG_PACE).toMatchObject({ value: 0.3, achievedOn: '2026-05-20' });
    // The biggest week comes from the 52-week volumes; with these three runs
    // the week of 2026-08-03..09 holds 15 km.
    expect(byMetric.BIGGEST_WEEK_DISTANCE?.value).toBeGreaterThan(0);
  });

  it('keeps the whitelisted fields only and bounds the recent list', async () => {
    harness = await buildHarness();
    for (let index = 0; index < 65; index += 1) {
      const day = new Date(Date.parse(`2026-09-26T00:00:00Z`) - index * 86_400_000)
        .toISOString()
        .slice(0, 10);
      createActivity(harness.repository, harness.fileStore, {
        localDate: day,
        distanceMeters: 5000,
        durationSeconds: 1500,
      });
    }
    const response = await harness.app.inject({ method: 'GET', url: '/api/ai/coach-context' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ context: AiCoachContext }>();
    expect(body.context.recentActivities).toHaveLength(60);
    expect(body.context.recentActivitiesTotal).toBe(65);
    // Newest first: the first item is today.
    expect(body.context.recentActivities[0]?.localDate).toBe(TODAY);
    // Whitelist: no names, notes, GPS, or device fields anywhere.
    const serialized = response.body;
    expect(serialized).not.toContain('合成 coach-');
    expect(serialized).not.toContain('私密备注');
    for (const forbidden of [
      'name',
      'notes',
      'latitude',
      'longitude',
      'gps',
      'deviceName',
      'maxHeartRateBpm',
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
    expect(body.context.totals.runs).toBe(65);
    expect(body.context.totals.firstActivityLocalDate).not.toBeNull();
  });

  it('includes the authorized daily-status window with notes', async () => {
    harness = await buildHarness();
    harness.repository.upsertDailyStatusEntry(TODAY, {
      sleepQuality: 4,
      fatigueLevel: 2,
      notes: '今天的自报状态备注',
    });
    const response = await harness.app.inject({ method: 'GET', url: '/api/ai/coach-context' });
    expect(response.statusCode).toBe(200);
    const { context } = response.json<{ context: AiCoachContext }>();
    expect(context.dailyStatus).toHaveLength(1);
    expect(context.dailyStatus[0]).toMatchObject({
      localDate: TODAY,
      sleepQuality: 4,
      fatigueLevel: 2,
      notes: '今天的自报状态备注',
    });
  });
});

describe('serializeCoachContext (prompt-only slimming)', () => {
  function makeContext(overrides: Partial<AiCoachContext> = {}): AiCoachContext {
    return {
      generatedForLocalDate: '2026-09-26',
      timezoneOffsetMinutes: 480,
      totals: {
        runs: 2,
        totalDistanceMeters: 10_000,
        totalMovingDurationSeconds: 3000,
        firstActivityLocalDate: '2026-09-25',
      },
      personalBests: [{ metric: 'LONGEST_DISTANCE', value: 6000, achievedOn: '2026-09-25' }],
      recentActivities: [
        {
          localDate: '2026-09-26',
          activityType: 'RUN',
          distanceMeters: 4000,
          durationSeconds: 1200,
          movingDurationSeconds: 1180,
          averageHeartRateBpm: null,
        },
        {
          localDate: '2026-09-25',
          activityType: 'STRENGTH',
          distanceMeters: null,
          durationSeconds: null,
          movingDurationSeconds: null,
          averageHeartRateBpm: null,
        },
      ],
      recentActivitiesTotal: 2,
      weeklyVolumes: [
        {
          weekStartLocalDate: '2026-09-21',
          weekEndLocalDate: '2026-09-27',
          runs: 2,
          totalDistanceMeters: 10_000,
          totalMovingDurationSeconds: 3000,
        },
      ],
      planSummary: {
        plannedCount: 1,
        completedCount: 1,
        linkedCompletedCount: 0,
        skippedCount: 0,
        overdueCount: 0,
        upcomingCount: 0,
        eligibleCount: 1,
        adherenceRate: null,
      },
      dailyStatus: [
        {
          localDate: '2026-09-26',
          sleepQuality: null,
          fatigueLevel: null,
          muscleSorenessLevel: null,
          stressLevel: null,
          motivationLevel: null,
          restingHeartRateBpm: null,
          notes: null,
        },
        {
          localDate: '2026-09-25',
          sleepQuality: 4,
          fatigueLevel: 2,
          muscleSorenessLevel: null,
          stressLevel: null,
          motivationLevel: null,
          restingHeartRateBpm: 55,
          notes: '感觉不错',
        },
      ],
      ...overrides,
    };
  }

  it('omits null and empty values, empty arrays, and dataless daily entries', () => {
    const context = makeContext({
      personalBests: [],
      recentActivitiesTotal: 0,
      dailyStatus: [
        {
          localDate: '2026-09-26',
          sleepQuality: null,
          fatigueLevel: null,
          muscleSorenessLevel: null,
          stressLevel: null,
          motivationLevel: null,
          restingHeartRateBpm: null,
          notes: null,
        },
      ],
    });
    const serialized = serializeCoachContext(context);
    expect(serialized).not.toContain('"personalBests"');
    expect(serialized).not.toContain('"dailyStatus"');
    expect(serialized).not.toContain('"averageHeartRateBpm"');
    expect(serialized).not.toContain('"adherenceRate"');
    // The dataless STRENGTH activity is pruned to its date and type only.
    expect(serialized).toContain('{"localDate":"2026-09-25","activityType":"STRENGTH"}');
    // The remaining activity item keeps only the fields that carry data.
    expect(serialized).toContain('"distanceMeters":4000');
    expect(serialized).toContain('"runs":2');
    // Deterministic and parseable back.
    expect(() => JSON.parse(serialized) as unknown).not.toThrow();
    expect(serializeCoachContext(context)).toBe(serialized);
  });

  it('keeps meaningful zeros and all data-bearing whitelist keys', () => {
    const context = makeContext({
      weeklyVolumes: [
        {
          weekStartLocalDate: '2026-09-21',
          weekEndLocalDate: '2026-09-27',
          runs: 0,
          totalDistanceMeters: 0,
          totalMovingDurationSeconds: 0,
        },
      ],
      dailyStatus: [
        {
          localDate: '2026-09-26',
          sleepQuality: null,
          fatigueLevel: 3,
          muscleSorenessLevel: null,
          stressLevel: null,
          motivationLevel: null,
          restingHeartRateBpm: null,
          notes: null,
        },
      ],
    });
    const serialized = serializeCoachContext(context);
    // Zeros are real information (a zero-volume week) and must survive.
    expect(serialized).toContain('"totalDistanceMeters":0');
    // A single data-bearing scale keeps the entry and its date.
    expect(serialized).toContain('"fatigueLevel":3');
    expect(serialized).toContain('"localDate":"2026-09-26"');
    // The output is a strict subset: every top-level key is whitelisted.
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      expect([
        'generatedForLocalDate',
        'timezoneOffsetMinutes',
        'totals',
        'personalBests',
        'recentActivities',
        'recentActivitiesTotal',
        'weeklyVolumes',
        'planSummary',
        'dailyStatus',
      ]).toContain(key);
    }
  });
});
