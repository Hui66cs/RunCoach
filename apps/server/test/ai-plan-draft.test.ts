import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase, type DatabaseContext } from '../src/db/client.js';
import { applyMigrations } from '../src/db/migrate.js';
import { ActivityRepository } from '../src/repositories/activity-repository.js';
import { AiReviewService } from '../src/services/ai/ai-review-service.js';
import {
  PLAN_DRAFT_PROMPT_MARKER,
  parseDraftItems,
  PlanDraftService,
} from '../src/services/ai/plan-draft-service.js';
import type {
  AiCompletion,
  AiCompletionRequest,
  TrainingReviewProvider,
} from '../src/services/ai/provider.js';
import { ImportService } from '../src/services/import-service.js';
import { RawFileStore } from '../src/storage/raw-file-store.js';
import type { NormalizedActivity } from '@runcoach/shared';

const TODAY = '2026-09-26'; // Saturday; pinned via fake Date clock.
const DEFAULT_OFFSET = 480;

let sourceCounter = 0;

function createActivity(
  repository: ActivityRepository,
  fileStore: RawFileStore,
  activity: {
    localDate: string;
    distanceMeters?: number | null;
    durationSeconds?: number | null;
  },
): void {
  sourceCounter += 1;
  const label = `draft-${sourceCounter}`;
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
    name: `机密活动名 ${label}`,
    notes: '机密备注内容',
    distanceMeters: activity.distanceMeters ?? null,
    durationSeconds: activity.durationSeconds ?? null,
    movingDurationSeconds: null,
    averageHeartRateBpm: 150,
    maxHeartRateBpm: 180,
    deviceName: 'DraftTest',
    laps: [],
    rawSummary: {},
    samples: [],
  };
  repository.createActivityFromSource({
    normalized,
    rawFileId,
    fileSha256: stored.sha256,
    rawPayload: {},
    importItemId: itemId,
  });
}

class FakeProvider implements TrainingReviewProvider {
  public requests: AiCompletionRequest[] = [];
  constructor(private readonly respond: (request: AiCompletionRequest) => AiCompletion) {}
  complete(request: AiCompletionRequest): Promise<AiCompletion> {
    this.requests.push(request);
    return Promise.resolve(this.respond(request));
  }
}

interface Harness {
  app: FastifyInstance;
  repository: ActivityRepository;
  fileStore: RawFileStore;
  database: DatabaseContext;
  directory: string;
  provider: FakeProvider;
}

const DRAFT_TABLES = [
  'activities',
  'activity_sources',
  'activity_samples',
  'planned_workouts',
  'daily_status_entries',
  'athlete_settings',
  'import_jobs',
  'chat_sessions',
  'chat_messages',
];

function rowCounts(harness: Harness): Record<string, number> {
  return Object.fromEntries(
    DRAFT_TABLES.map((table) => [
      table,
      Number(harness.database.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1),
    ]),
  );
}

async function buildHarness(
  options: {
    provider?: TrainingReviewProvider;
    withPlanDraft?: boolean;
  } = {},
): Promise<Harness> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-plan-draft-'));
  const database = openDatabase(path.join(directory, 'runcoach.db'));
  applyMigrations(database.sqlite, path.resolve('apps/server/drizzle'));
  const repository = new ActivityRepository(database.db);
  const fileStore = new RawFileStore(directory);
  const importService = new ImportService(repository, fileStore, DEFAULT_OFFSET);
  const provider =
    options.provider ??
    new FakeProvider(() => ({
      text: JSON.stringify({
        items: [
          {
            scheduledLocalDate: TODAY,
            workoutType: 'EASY_RUN',
            title: '轻松跑 40 分钟',
            notes: null,
            targetDistanceMeters: 6000,
            targetDurationSeconds: 2400,
          },
        ],
      }),
      model: 'fake',
    }));
  const aiReview = new AiReviewService(repository, {
    enabled: true,
    provider,
    timeoutMs: 5000,
    maxOutputTokens: 512,
  });
  const app = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir: directory,
      databasePath: path.join(directory, 'runcoach.db'),
      localOffsetMinutes: DEFAULT_OFFSET,
      maxUploadBytes: 1_000_000,
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
    aiReview,
    planDraft:
      options.withPlanDraft === false
        ? undefined
        : new PlanDraftService(repository, () => aiReview.getActive(), {
            timeoutMs: 5000,
            maxOutputTokens: 512,
          }),
  });
  return {
    app,
    repository,
    fileStore,
    database,
    directory,
    provider: provider as FakeProvider,
  };
}

describe('plan draft service (M7 Batch 3)', () => {
  let harness: Harness | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T04:00:00.000Z'));
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

  it('parses a valid draft reply, including code-fenced JSON', () => {
    const payload = {
      items: [
        { scheduledLocalDate: TODAY, workoutType: 'EASY_RUN', title: '轻松跑' },
        {
          scheduledLocalDate: '2026-10-02',
          workoutType: 'LONG_RUN',
          title: '长距离',
          targetDistanceMeters: 15_000,
        },
      ],
    };
    expect(parseDraftItems(JSON.stringify(payload), TODAY, '2026-10-02')).toHaveLength(2);
    const fenced = '```json\n' + JSON.stringify(payload) + '\n```';
    expect(parseDraftItems(fenced, TODAY, '2026-10-02')).toHaveLength(2);
  });

  it('rejects malformed, empty, oversized, and out-of-horizon replies', () => {
    expect(() => parseDraftItems('这不是 JSON', TODAY, '2026-10-02')).toThrowError(
      '计划草稿格式无效',
    );
    expect(() => parseDraftItems('{"items":[]}', TODAY, '2026-10-02')).toThrowError(
      'AI 未返回任何计划草稿',
    );
    expect(() =>
      parseDraftItems(
        '{"items":[{"scheduledLocalDate":"2026-10-20","workoutType":"EASY_RUN","title":"越界"}]}',
        TODAY,
        '2026-10-02',
      ),
    ).toThrowError('超出草稿区间');
    expect(() =>
      parseDraftItems(
        '{"items":[{"scheduledLocalDate":"2026-09-27","workoutType":"MAGIC","title":"x"}]}',
        TODAY,
        '2026-10-02',
      ),
    ).toThrowError('计划草稿格式无效');
    const oversized = {
      items: Array.from({ length: 15 }, (_, index) => ({
        scheduledLocalDate: TODAY,
        workoutType: 'EASY_RUN',
        title: `第 ${index} 条`,
      })),
    };
    expect(() => parseDraftItems(JSON.stringify(oversized), TODAY, '2026-10-02')).toThrowError(
      '计划草稿格式无效',
    );
  });

  it('previews a draft from the provider without writing to SQLite, and the prompt carries no names or notes', async () => {
    harness = await buildHarness();
    createActivity(harness.repository, harness.fileStore, {
      localDate: '2026-09-25',
      distanceMeters: 8000,
      durationSeconds: 2400,
    });
    const before = rowCounts(harness);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/plan-draft',
      payload: { horizonDays: 7 },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      items: Array<{ scheduledLocalDate: string; workoutType: string; title: string }>;
      model: string;
      draftStartLocalDate: string;
      draftEndLocalDate: string;
      horizonDays: number;
    }>();
    expect(body.model).toBe('fake');
    expect(body.horizonDays).toBe(7);
    expect(body.draftStartLocalDate).toBe(TODAY);
    expect(body.draftEndLocalDate).toBe('2026-10-02');
    expect(body.items[0]).toMatchObject({ workoutType: 'EASY_RUN', title: '轻松跑 40 分钟' });

    // The prompt carries the marker, the draft window, and the slim context —
    // but never the activity names or notes.
    const request = harness.provider.requests[0]!;
    expect(request.systemPrompt).toContain(PLAN_DRAFT_PROMPT_MARKER);
    expect(request.systemPrompt).toContain('禁止医疗建议');
    expect(request.userPrompt).toContain(`草稿区间：${TODAY} 到 2026-10-02`);
    expect(request.userPrompt).toContain('"totalDistanceMeters":8000');
    expect(request.userPrompt).not.toContain('机密活动名');
    expect(request.userPrompt).not.toContain('机密备注内容');
    expect(request.userPrompt).not.toContain('DraftTest');

    // Read-only: nothing was written anywhere.
    expect(rowCounts(harness)).toEqual(before);
  });

  it('maps disabled state, invalid requests, and provider failures to stable errors', async () => {
    harness = await buildHarness({ withPlanDraft: false });
    const disabled = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/plan-draft',
      payload: { horizonDays: 7 },
    });
    expect(disabled.statusCode).toBe(503);
    expect(disabled.json()).toMatchObject({ code: 'AI_DISABLED' });

    harness = await buildHarness();
    const invalid = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/plan-draft',
      payload: { horizonDays: 9 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'INVALID_AI_PLAN_DRAFT_REQUEST' });

    const failing = await buildHarness({
      provider: new FakeProvider(() => {
        throw new Error('boom');
      }),
    });
    try {
      const failure = await failing.app.inject({
        method: 'POST',
        url: '/api/ai/coach/plan-draft',
        payload: { horizonDays: 7 },
      });
      expect(failure.statusCode).toBe(502);
      expect(failure.json()).toMatchObject({ code: 'AI_PROVIDER_ERROR' });
    } finally {
      await failing.app.close();
      failing.database.close();
      fs.rmSync(failing.directory, { recursive: true, force: true });
    }

    const malformed = await buildHarness({
      provider: new FakeProvider(() => ({ text: 'not json', model: 'fake' })),
    });
    try {
      const response = await malformed.app.inject({
        method: 'POST',
        url: '/api/ai/coach/plan-draft',
        payload: { horizonDays: 7 },
      });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ code: 'AI_INVALID_OUTPUT' });
    } finally {
      await malformed.app.close();
      malformed.database.close();
      fs.rmSync(malformed.directory, { recursive: true, force: true });
    }
  });

  it('imports a draft item through the existing planned-workout API', async () => {
    harness = await buildHarness();
    const draft = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/plan-draft',
      payload: { horizonDays: 7 },
    });
    const item = draft.json<{ items: Array<Record<string, unknown>> }>().items[0]!;
    // The draft item maps 1:1 onto the existing create API — no translation.
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/planned-workouts',
      payload: item,
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      scheduledLocalDate: TODAY,
      workoutType: 'EASY_RUN',
      title: '轻松跑 40 分钟',
    });
    const calendar = await harness.app.inject({
      method: 'GET',
      url: `/api/calendar?from=${TODAY}&to=${TODAY}`,
    });
    expect(calendar.json()).toMatchObject({
      plannedWorkouts: [{ scheduledLocalDate: TODAY, workoutType: 'EASY_RUN' }],
    });
  });
});
