import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AiReviewResponse, NormalizedActivity } from '@runcoach/shared';
import { buildApp } from '../src/app.js';
import { openDatabase, type DatabaseContext } from '../src/db/client.js';
import { applyMigrations } from '../src/db/migrate.js';
import { ActivityRepository } from '../src/repositories/activity-repository.js';
import {
  AiReviewService,
  type AiReviewServiceOptions,
} from '../src/services/ai/ai-review-service.js';
import {
  AiProviderError,
  type AiCompletion,
  type AiCompletionRequest,
  type TrainingReviewProvider,
} from '../src/services/ai/provider.js';
import { ImportService } from '../src/services/import-service.js';
import { RawFileStore } from '../src/storage/raw-file-store.js';

const TODAY = '2026-09-23'; // Wednesday; pinned as the canonical today via the fake clock below.
const DEFAULT_OFFSET = 480;

let sourceCounter = 0;

function createActivity(
  repository: ActivityRepository,
  fileStore: RawFileStore,
  activity: { localDate: string; distanceMeters?: number | null; name?: string },
): string {
  sourceCounter += 1;
  const label = `ai-review-${sourceCounter}`;
  const stored = fileStore.save(Buffer.from(label), `${label}.fit`, 'application/octet-stream');
  const rawFileId = repository.ensureRawFile(stored);
  const jobId = repository.createImportJob('FIT', `${label}.fit`, rawFileId);
  const itemId = repository.createImportItem(jobId);
  const normalized: NormalizedActivity = {
    sourceType: 'FIT',
    sourceExternalId: `${label}-external`,
    sourceIdentityKey: `${label}-identity`,
    activityType: 'RUN',
    startTimeUtc: `${activity.localDate}T00:00:00.000Z`,
    originalStartTime: `${activity.localDate}T08:00:00+08:00`,
    timezoneOffsetMinutes: DEFAULT_OFFSET,
    localDate: activity.localDate,
    name: activity.name ?? `合成 ${label}`,
    notes: '私密训练备注，绝不能离开本机',
    distanceMeters: activity.distanceMeters ?? 5000,
    durationSeconds: 1500,
    movingDurationSeconds: 1450,
    averageHeartRateBpm: 155,
    maxHeartRateBpm: 178,
    deviceName: 'AiReviewTest',
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

class FakeProvider implements TrainingReviewProvider {
  public requests: AiCompletionRequest[] = [];

  constructor(private readonly respond: (request: AiCompletionRequest) => AiCompletion) {}

  complete(request: AiCompletionRequest): Promise<AiCompletion> {
    this.requests.push(request);
    return Promise.resolve(this.respond(request));
  }
}

function makeService(
  repository: ActivityRepository,
  provider: TrainingReviewProvider,
  overrides: Partial<AiReviewServiceOptions> = {},
): AiReviewService {
  return new AiReviewService(repository, {
    enabled: true,
    provider,
    timeoutMs: 5000,
    maxOutputTokens: 512,
    ...overrides,
  });
}

interface Harness {
  app: FastifyInstance;
  repository: ActivityRepository;
  fileStore: RawFileStore;
  database: DatabaseContext;
  directory: string;
}

async function buildHarness(
  serviceFactory?: (repository: ActivityRepository) => AiReviewService,
): Promise<Harness> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-ai-review-'));
  const database = openDatabase(path.join(directory, 'runcoach.db'));
  applyMigrations(database.sqlite, path.resolve('apps/server/drizzle'));
  const repository = new ActivityRepository(database.db);
  const fileStore = new RawFileStore(directory);
  const importService = new ImportService(repository, fileStore, DEFAULT_OFFSET);
  const app = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir: directory,
      databasePath: path.join(directory, 'runcoach.db'),
      localOffsetMinutes: DEFAULT_OFFSET,
      maxUploadBytes: 1024,
      ai: {
        enabled: serviceFactory !== undefined,
        provider: 'none',
        deepSeek: null,
        timeoutMs: 5000,
        maxOutputTokens: 512,
      },
    },
    repository,
    importService,
    ...(serviceFactory === undefined ? {} : { aiReview: serviceFactory(repository) }),
  });
  return { app, repository, fileStore, database, directory };
}

function rowCounts(harness: Harness): Record<string, number> {
  const tables = [
    'activities',
    'activity_sources',
    'activity_samples',
    'planned_workouts',
    'daily_status_entries',
    'athlete_settings',
    'import_jobs',
  ];
  return Object.fromEntries(
    tables.map((table) => [
      table,
      Number(harness.database.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1),
    ]),
  );
}

describe('AI review API (M6)', () => {
  let harness: Harness | undefined;

  // The HTTP route derives canonical today from Date.now(); pinning only the
  // clock (not timers) keeps every date assertion tied to the fixed
  // 2026-09-23 fixtures regardless of the day the suite runs, and the real
  // clock is restored afterwards.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T04:00:00.000Z')); // 2026-09-23 at UTC+8
  });

  /** Preview-then-confirm flow: returns the fingerprint along with the
   * review response so tests exercise the real client contract. */
  async function confirmReview(
    target: Harness,
    windowDays: number,
    fingerprintOverride?: string,
  ): Promise<{ review: Awaited<ReturnType<FastifyInstance['inject']>>; fingerprint: string }> {
    const preview = await target.app.inject({
      method: 'POST',
      url: '/api/ai/context',
      payload: { windowDays },
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json<{ contextFingerprint: string }>();
    const fingerprint = fingerprintOverride ?? previewBody.contextFingerprint;
    const review = await target.app.inject({
      method: 'POST',
      url: '/api/ai/review',
      payload: { windowDays, contextFingerprint: fingerprint },
    });
    return { review, fingerprint };
  }

  afterEach(async () => {
    vi.useRealTimers();
    if (harness !== undefined) {
      await harness.app.close();
      harness.database.close();
      fs.rmSync(harness.directory, { recursive: true, force: true });
      harness = undefined;
    }
  });

  it('stays disabled by default: no service means 503 AI_DISABLED', async () => {
    harness = await buildHarness();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/review',
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'AI_DISABLED' });
  });

  it('rejects an invalid window with 400 and never calls the provider', async () => {
    const provider = new FakeProvider(() => ({ text: 'x', model: 'fake' }));
    harness = await buildHarness((repository) => makeService(repository, provider));
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/review',
      payload: { windowDays: 10 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_AI_REVIEW_REQUEST' });
    expect(provider.requests).toHaveLength(0);
  });

  it('returns a whitelisted-context review for 28 days without leaking names or notes', async () => {
    const provider = new FakeProvider((request) => {
      expect(request.systemPrompt).not.toContain('私密');
      return { text: '近四周训练量稳定，建议保持。', model: 'fake-model' };
    });
    harness = await buildHarness((repository) => makeService(repository, provider));
    createActivity(harness.repository, harness.fileStore, {
      localDate: TODAY,
      distanceMeters: 8000,
      name: '机密活动名称',
    });
    createActivity(harness.repository, harness.fileStore, {
      localDate: '2026-08-28',
      distanceMeters: 6000,
    });
    harness.repository.createPlannedWorkout({
      scheduledLocalDate: TODAY,
      workoutType: 'EASY_RUN',
      title: '今日轻松跑',
    });
    const response = await confirmReview(harness, 28);
    expect(response.review.statusCode).toBe(200);
    const body = response.review.json<AiReviewResponse>();
    expect(body.review).toBe('近四周训练量稳定，建议保持。');
    expect(body.model).toBe('fake-model');
    expect(body.context.generatedForLocalDate).toBe(TODAY);
    expect(body.context.windowStartLocalDate).toBe('2026-08-27');
    expect(body.context.running.runs).toBe(2);
    expect(body.context.running.totalDistanceMeters).toBe(14_000);
    expect(body.context.planSummary.plannedCount).toBe(1);
    expect(body.context.planSummary.completedCount).toBe(0);
    // The prompt only ever contains the numeric whitelist.
    expect(provider.requests).toHaveLength(1);
    const prompt = provider.requests[0]?.userPrompt ?? '';
    expect(prompt).toContain('"runs":2');
    expect(prompt).not.toContain('机密活动名称');
    expect(prompt).not.toContain('私密训练备注');
    expect(prompt).not.toContain('今日轻松跑');
    // The model receives the factual interpretation rules with the context.
    const systemPromptSent = provider.requests[0]?.systemPrompt ?? '';
    expect(systemPromptSent).toContain('滚动日期范围');
    expect(systemPromptSent).toContain('不得把滚动范围称为“本周”“本月”');
    expect(systemPromptSent).toContain('绝不代表这段时间没有跑步');
    expect(systemPromptSent).toContain('暂无可计算执行率的计划');
    // The response itself carries no forbidden fields either.
    const serialized = response.review.body;
    expect(serialized).not.toContain('机密活动名称');
    expect(serialized).not.toContain('私密训练备注');
    expect(serialized).not.toContain('averageHeartRateBpm');
  });

  it('previews the context without calling the provider, even while disabled', async () => {
    const provider = new FakeProvider(() => {
      throw new Error('provider must never be called by preview');
    });
    const previewHarness = await buildHarness((repository) =>
      makeService(repository, provider, { enabled: false }),
    );
    createActivity(previewHarness.repository, previewHarness.fileStore, {
      localDate: TODAY,
      distanceMeters: 8000,
      name: '机密活动名称',
    });
    const before = rowCounts(previewHarness);
    const response = await previewHarness.app.inject({
      method: 'POST',
      url: '/api/ai/context',
      payload: { windowDays: 28 },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ context: { running: { runs: number } }; aiEnabled: boolean }>();
    expect(body.aiEnabled).toBe(false);
    expect(body.context.running.runs).toBe(1);
    expect(body.context.windowStartLocalDate).toBe('2026-08-27');
    expect(provider.requests).toHaveLength(0);
    expect(rowCounts(previewHarness)).toEqual(before);
    await previewHarness.app.close();
    previewHarness.database.close();
    fs.rmSync(previewHarness.directory, { recursive: true, force: true });
  });

  it('previews the same context the review would send when enabled', async () => {
    const provider = new FakeProvider(() => ({ text: '回顾', model: 'fake' }));
    const enabledHarness = await buildHarness((repository) => makeService(repository, provider));
    createActivity(enabledHarness.repository, enabledHarness.fileStore, { localDate: TODAY });
    const preview = await enabledHarness.app.inject({
      method: 'POST',
      url: '/api/ai/context',
      payload: { windowDays: 7 },
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json<{
      context: { running: { runs: number } };
      aiEnabled: boolean;
    }>();
    expect(previewBody.aiEnabled).toBe(true);
    expect(provider.requests).toHaveLength(0);

    const confirmed = await confirmReview(enabledHarness, 7);
    expect(confirmed.review.statusCode).toBe(200);
    const reviewBody = confirmed.review.json<{ context: { running: { runs: number } } }>();
    expect(reviewBody.context).toEqual(previewBody.context);
    expect(provider.requests).toHaveLength(1);
    await enabledHarness.app.close();
    enabledHarness.database.close();
    fs.rmSync(enabledHarness.directory, { recursive: true, force: true });
  });

  it('applies inclusive 7-day boundaries', async () => {
    const provider = new FakeProvider(() => ({ text: '回顾', model: 'fake' }));
    harness = await buildHarness((repository) => makeService(repository, provider));
    createActivity(harness.repository, harness.fileStore, {
      localDate: '2026-09-17',
      distanceMeters: 4000,
    }); // today-6, inside
    createActivity(harness.repository, harness.fileStore, {
      localDate: '2026-09-16',
      distanceMeters: 4000,
    }); // today-7, outside
    const response = await confirmReview(harness, 7);
    expect(response.review.statusCode).toBe(200);
    const body = response.review.json<AiReviewResponse>();
    expect(body.context.windowStartLocalDate).toBe('2026-09-17');
    expect(body.context.running.runs).toBe(1);
    expect(body.context.running.totalDistanceMeters).toBe(4000);
  });

  it('rejects a review without the confirmed fingerprint with 400', async () => {
    const provider = new FakeProvider(() => ({ text: '回顾', model: 'fake' }));
    harness = await buildHarness((repository) => makeService(repository, provider));
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/review',
      payload: { windowDays: 7 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_AI_REVIEW_REQUEST' });
    expect(provider.requests).toHaveLength(0);
  });

  it('rejects a stale fingerprint with 409 and never calls the provider', async () => {
    const provider = new FakeProvider(() => ({ text: '回顾', model: 'fake' }));
    harness = await buildHarness((repository) => makeService(repository, provider));
    createActivity(harness.repository, harness.fileStore, {
      localDate: TODAY,
      distanceMeters: 3000,
    });
    const preview = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/context',
      payload: { windowDays: 7 },
    });
    const staleFingerprint = preview.json<{ contextFingerprint: string }>().contextFingerprint;
    // The data changes after the preview: a new activity lands inside the
    // window, so the confirmed context no longer matches.
    createActivity(harness.repository, harness.fileStore, {
      localDate: TODAY,
      distanceMeters: 2000,
    });
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/review',
      payload: { windowDays: 7, contextFingerprint: staleFingerprint },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'AI_CONTEXT_STALE' });
    expect(provider.requests).toHaveLength(0);
  });

  it('maps provider failures to stable sanitized codes', async () => {
    for (const failure of [
      { error: new AiProviderError('TIMEOUT', 'AI 服务调用超时'), status: 504, code: 'AI_TIMEOUT' },
      {
        error: new AiProviderError('RATE_LIMITED', 'too many'),
        status: 429,
        code: 'AI_RATE_LIMITED',
      },
      {
        error: new AiProviderError('PROVIDER_ERROR', 'status 500'),
        status: 502,
        code: 'AI_PROVIDER_ERROR',
      },
      {
        error: new AiProviderError('EMPTY_RESPONSE', 'empty'),
        status: 502,
        code: 'AI_EMPTY_RESPONSE',
      },
      { error: new Error('unexpected crash'), status: 502, code: 'AI_PROVIDER_ERROR' },
    ]) {
      const provider = new FakeProvider(() => {
        throw failure.error;
      });
      const current = await buildHarness((repository) => makeService(repository, provider));
      const { review } = await confirmReview(current, 7);
      expect(review.statusCode, failure.code).toBe(failure.status);
      expect(review.json()).toMatchObject({ code: failure.code });
      await current.app.close();
      current.database.close();
      fs.rmSync(current.directory, { recursive: true, force: true });
    }
  });

  it('rejects an empty model answer and an oversized answer', async () => {
    const emptyProvider = new FakeProvider(() => ({ text: '   ', model: 'fake' }));
    const emptyHarness = await buildHarness((repository) => makeService(repository, emptyProvider));
    const emptyResponse = await confirmReview(emptyHarness, 28);
    expect(emptyResponse.review.statusCode).toBe(502);
    expect(emptyResponse.review.json()).toMatchObject({ code: 'AI_EMPTY_RESPONSE' });
    await emptyHarness.app.close();
    emptyHarness.database.close();
    fs.rmSync(emptyHarness.directory, { recursive: true, force: true });

    const oversizeProvider = new FakeProvider(() => ({
      text: '长'.repeat(4001),
      model: 'fake',
    }));
    const oversizeHarness = await buildHarness((repository) =>
      makeService(repository, oversizeProvider),
    );
    const oversizeResponse = await confirmReview(oversizeHarness, 28);
    expect(oversizeResponse.review.statusCode).toBe(502);
    expect(oversizeResponse.review.json()).toMatchObject({ code: 'AI_INVALID_OUTPUT' });
    await oversizeHarness.app.close();
    oversizeHarness.database.close();
    fs.rmSync(oversizeHarness.directory, { recursive: true, force: true });
  });

  it('never writes to SQLite on success or failure', async () => {
    const provider = new FakeProvider(() => ({ text: '成功的回顾', model: 'fake' }));
    harness = await buildHarness((repository) => makeService(repository, provider));
    createActivity(harness.repository, harness.fileStore, { localDate: TODAY });
    const before = rowCounts(harness);

    const success = await confirmReview(harness, 28);
    expect(success.review.statusCode).toBe(200);
    expect(rowCounts(harness)).toEqual(before);

    const failingProvider = new FakeProvider(() => {
      throw new AiProviderError('TIMEOUT', 'timeout');
    });
    const failingService = makeService(harness.repository, failingProvider);
    const failingApp = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 0,
        dataDir: harness.directory,
        databasePath: path.join(harness.directory, 'runcoach.db'),
        localOffsetMinutes: DEFAULT_OFFSET,
        maxUploadBytes: 1024,
        ai: {
          enabled: true,
          provider: 'none',
          deepSeek: null,
          timeoutMs: 5000,
          maxOutputTokens: 512,
        },
      },
      repository: harness.repository,
      importService: new ImportService(harness.repository, harness.fileStore, DEFAULT_OFFSET),
      aiReview: failingService,
    });
    const failure = await confirmReview({ ...harness, app: failingApp }, 28);
    expect(failure.review.statusCode).toBe(504);
    expect(rowCounts(harness)).toEqual(before);
    await failingApp.close();
  });
});
