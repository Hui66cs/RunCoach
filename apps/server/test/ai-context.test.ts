import { describe, expect, it } from 'vitest';
import type { DashboardResponse, TrainingSummaryCounts } from '@runcoach/shared';
import { MAX_AI_CONTEXT_DAYS, aiTrainingContextSchema } from '@runcoach/shared';
import { buildAiTrainingContext } from '../src/services/ai/context.js';
import { buildReviewUserPrompt } from '../src/services/ai/ai-review-service.js';
import {
  AiProviderError,
  type AiCompletionRequest,
  type TrainingReviewProvider,
} from '../src/services/ai/provider.js';
import { DeepSeekReviewProvider } from '../src/services/ai/deepseek-provider.js';

const TODAY = '2026-09-23'; // Wednesday.

function makeDashboard(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    generatedForLocalDate: TODAY,
    timezoneOffsetMinutes: 480,
    last7Days: {
      runs: 3,
      totalDistanceMeters: 21_000,
      totalMovingDurationSeconds: 6300,
      averagePaceSecondsPerKilometer: 300,
    },
    last28Days: {
      runs: 12,
      totalDistanceMeters: 96_000,
      totalMovingDurationSeconds: 27_600,
      averagePaceSecondsPerKilometer: 287.5,
    },
    weeklyVolumes: [
      {
        weekStartLocalDate: '2026-08-31',
        weekEndLocalDate: '2026-09-06',
        runs: 2,
        totalDistanceMeters: 16_000,
        totalMovingDurationSeconds: 4800,
      },
      {
        weekStartLocalDate: '2026-09-07',
        weekEndLocalDate: '2026-09-13',
        runs: 3,
        totalDistanceMeters: 24_000,
        totalMovingDurationSeconds: 7200,
      },
      {
        weekStartLocalDate: '2026-09-14',
        weekEndLocalDate: '2026-09-20',
        runs: 4,
        totalDistanceMeters: 32_000,
        totalMovingDurationSeconds: 9600,
      },
      {
        weekStartLocalDate: '2026-09-21',
        weekEndLocalDate: '2026-09-27',
        runs: 2,
        totalDistanceMeters: 18_000,
        totalMovingDurationSeconds: 5400,
      },
      {
        weekStartLocalDate: '2026-09-28',
        weekEndLocalDate: '2026-10-04',
        runs: 0,
        totalDistanceMeters: 0,
        totalMovingDurationSeconds: 0,
      },
    ],
    recentActivities: [
      {
        id: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f01',
        localDate: TODAY,
        name: '机密活动名称',
        activityType: 'RUN',
        distanceMeters: 5000,
        durationSeconds: 1500,
        movingDurationSeconds: 1450,
      },
    ],
    ...overrides,
  };
}

function makePlanSummary(overrides: Partial<TrainingSummaryCounts> = {}): TrainingSummaryCounts {
  return {
    plannedCount: 6,
    completedCount: 4,
    linkedCompletedCount: 3,
    skippedCount: 1,
    overdueCount: 1,
    upcomingCount: 0,
    eligibleCount: 6,
    adherenceRate: 4 / 6,
    ...overrides,
  };
}

describe('AI training context whitelist and date boundaries', () => {
  it('keeps a 7-day window inclusive of both boundary dates', () => {
    const context = buildAiTrainingContext({
      windowDays: 7,
      dashboard: makeDashboard(),
      planSummary: makePlanSummary(),
    });
    expect(context.windowStartLocalDate).toBe('2026-09-17'); // today-6
    expect(context.windowEndLocalDate).toBe(TODAY);
    expect(context.windowDays).toBe(7);
  });

  it('keeps a 28-day window inclusive of both boundary dates and never exceeds the cap', () => {
    const context = buildAiTrainingContext({
      windowDays: 28,
      dashboard: makeDashboard(),
      planSummary: makePlanSummary(),
    });
    expect(context.windowStartLocalDate).toBe('2026-08-27'); // today-27
    expect(context.windowDays).toBeLessThanOrEqual(MAX_AI_CONTEXT_DAYS);
    expect(() => aiTrainingContextSchema.parse(context)).not.toThrow();
  });

  it('handles a month boundary inside the window', () => {
    const context = buildAiTrainingContext({
      windowDays: 7,
      dashboard: makeDashboard({ generatedForLocalDate: '2026-10-02' }),
      planSummary: makePlanSummary(),
    });
    expect(context.windowStartLocalDate).toBe('2026-09-26');
    expect(context.windowEndLocalDate).toBe('2026-10-02');
  });

  it('selects the run summary matching the requested window', () => {
    const seven = buildAiTrainingContext({
      windowDays: 7,
      dashboard: makeDashboard(),
      planSummary: makePlanSummary(),
    });
    expect(seven.running.runs).toBe(3);
    const twentyEight = buildAiTrainingContext({
      windowDays: 28,
      dashboard: makeDashboard(),
      planSummary: makePlanSummary(),
    });
    expect(twentyEight.running.runs).toBe(12);
  });

  it('includes only weekly volumes intersecting the window', () => {
    const seven = buildAiTrainingContext({
      windowDays: 7,
      dashboard: makeDashboard(),
      planSummary: makePlanSummary(),
    });
    // 7-day window 2026-09-17..09-23 intersects only the 09-14 and 09-21 weeks.
    expect(seven.weeklyVolumes.map((week) => week.weekStartLocalDate)).toEqual([
      '2026-09-14',
      '2026-09-21',
    ]);
    const twentyEight = buildAiTrainingContext({
      windowDays: 28,
      dashboard: makeDashboard(),
      planSummary: makePlanSummary(),
    });
    // 28-day window 2026-08-27..09-23 excludes the future 09-28 week.
    expect(
      twentyEight.weeklyVolumes.every((week) => week.weekStartLocalDate !== '2026-09-28'),
    ).toBe(true);
    expect(twentyEight.weeklyVolumes.length).toBeLessThanOrEqual(5);
  });

  it('serializes only whitelisted numeric and date fields (no forbidden content)', () => {
    const context = buildAiTrainingContext({
      windowDays: 28,
      dashboard: makeDashboard(),
      planSummary: makePlanSummary(),
    });
    const serialized = JSON.stringify(context);
    for (const forbidden of [
      '机密活动名称',
      'recentActivities',
      'name',
      'notes',
      'heartRate',
      'latitude',
      'longitude',
      'gps',
      'sleepQuality',
      'fatigueLevel',
      'stressLevel',
      'motivationLevel',
      'muscleSorenessLevel',
      'restingHeartRate',
      'displayName',
      'primaryGoal',
      'experienceLevel',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.keys(context).sort()).toEqual(
      [
        'generatedForLocalDate',
        'timezoneOffsetMinutes',
        'windowDays',
        'windowStartLocalDate',
        'windowEndLocalDate',
        'running',
        'weeklyVolumes',
        'planSummary',
      ].sort(),
    );
  });

  it('builds the user prompt from the whitelisted context only', () => {
    const context = buildAiTrainingContext({
      windowDays: 7,
      dashboard: makeDashboard(),
      planSummary: makePlanSummary(),
    });
    const prompt = buildReviewUserPrompt(JSON.stringify(context));
    expect(prompt).toContain('"runs":3');
    expect(prompt).not.toContain('机密活动名称');
  });
});

describe('DeepSeek review provider adapter', () => {
  const options = {
    apiKey: 'sk-test-secret',
    baseUrl: 'https://api.example.com',
    model: 'deepseek-chat',
  };

  function makeFetch(handler: (request: Request) => Response | Promise<Response>): typeof fetch {
    return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      return handler(request);
    };
  }

  const successBody = {
    model: 'deepseek-chat',
    choices: [{ message: { content: '  最近四周训练量稳定上升，注意恢复。 ' } }],
  };

  it('sends the bounded request with the key only in the authorization header', async () => {
    let seenAuthorization = '';
    let seenBody: string | null = null;
    const provider = new DeepSeekReviewProvider({
      ...options,
      fetchImpl: makeFetch(async (request) => {
        seenAuthorization = request.headers.get('authorization') ?? '';
        seenBody = await request.text();
        return new Response(JSON.stringify(successBody), { status: 200 });
      }),
    });
    const result = await provider.complete({
      systemPrompt: 'system',
      userPrompt: 'user prompt',
      maxOutputTokens: 512,
      timeoutMs: 5000,
    });
    expect(seenAuthorization).toBe('Bearer sk-test-secret');
    expect(seenBody).not.toBeNull();
    const sent = JSON.parse(seenBody!) as {
      model: string;
      max_tokens: number;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    expect(sent.model).toBe('deepseek-chat');
    expect(sent.max_tokens).toBe(512);
    expect(sent.stream).toBe(false);
    expect(sent.messages).toHaveLength(2);
    expect(result.text).toBe('最近四周训练量稳定上升，注意恢复。');
    expect(result.model).toBe('deepseek-chat');
  });

  it('maps 429 to RATE_LIMITED', async () => {
    const provider = new DeepSeekReviewProvider({
      ...options,
      fetchImpl: makeFetch(() => new Response('{}', { status: 429 })),
    });
    await expect(
      provider.complete({
        systemPrompt: 's',
        userPrompt: 'u',
        maxOutputTokens: 64,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('maps upstream failures to PROVIDER_ERROR without leaking the key or body', async () => {
    const provider = new DeepSeekReviewProvider({
      ...options,
      fetchImpl: makeFetch(() => new Response('upstream says sk-test-secret', { status: 500 })),
    });
    const error = await provider
      .complete({ systemPrompt: 's', userPrompt: 'u', maxOutputTokens: 64, timeoutMs: 1000 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe('PROVIDER_ERROR');
    expect((error as AiProviderError).message).not.toContain('sk-test-secret');
    expect((error as AiProviderError).message).not.toContain('upstream');
  });

  it('maps an aborted request to TIMEOUT', async () => {
    const provider = new DeepSeekReviewProvider({
      ...options,
      fetchImpl: () => {
        const abortError = new Error('This operation was aborted');
        abortError.name = 'AbortError';
        throw abortError;
      },
    });
    await expect(
      provider.complete({
        systemPrompt: 's',
        userPrompt: 'u',
        maxOutputTokens: 64,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('maps an empty model answer to EMPTY_RESPONSE', async () => {
    const provider = new DeepSeekReviewProvider({
      ...options,
      fetchImpl: makeFetch(
        () =>
          new Response(
            JSON.stringify({ model: 'deepseek-chat', choices: [{ message: { content: '   ' } }] }),
            {
              status: 200,
            },
          ),
      ),
    });
    await expect(
      provider.complete({
        systemPrompt: 's',
        userPrompt: 'u',
        maxOutputTokens: 64,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' });
  });

  it('maps a malformed model answer to INVALID_OUTPUT', async () => {
    const provider = new DeepSeekReviewProvider({
      ...options,
      fetchImpl: makeFetch(() => new Response('{"unexpected":true}', { status: 200 })),
    });
    await expect(
      provider.complete({
        systemPrompt: 's',
        userPrompt: 'u',
        maxOutputTokens: 64,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
});

describe('fake provider contract', () => {
  it('records completion requests for integration assertions', async () => {
    const requests: AiCompletionRequest[] = [];
    const provider: TrainingReviewProvider = {
      complete: (request) => {
        requests.push(request);
        return Promise.resolve({ text: '回顾', model: 'fake' });
      },
    };
    const result = await provider.complete({
      systemPrompt: 's',
      userPrompt: 'u',
      maxOutputTokens: 64,
      timeoutMs: 1000,
    });
    expect(result.text).toBe('回顾');
    expect(requests).toHaveLength(1);
  });
});
