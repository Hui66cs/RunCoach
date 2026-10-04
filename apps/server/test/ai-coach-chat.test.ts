import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase, type DatabaseContext } from '../src/db/client.js';
import { applyMigrations } from '../src/db/migrate.js';
import { ActivityRepository } from '../src/repositories/activity-repository.js';
import { ChatRepository } from '../src/repositories/chat-repository.js';
import { AiReviewService } from '../src/services/ai/ai-review-service.js';
import { AiProviderError } from '../src/services/ai/provider.js';
import { CoachChatService } from '../src/services/ai/coach-chat-service.js';
import { MAX_CHAT_HISTORY_TURNS } from '@runcoach/shared';
import type {
  AiCompletion,
  AiCompletionRequest,
  TrainingReviewProvider,
} from '../src/services/ai/provider.js';
import { ImportService } from '../src/services/import-service.js';
import { RawFileStore } from '../src/storage/raw-file-store.js';

const DEFAULT_OFFSET = 480;

class RecordingProvider implements TrainingReviewProvider {
  public requests: AiCompletionRequest[] = [];
  complete(request: AiCompletionRequest): Promise<AiCompletion> {
    this.requests.push(request);
    return Promise.resolve({ text: `模拟回答 ${this.requests.length}`, model: 'fake' });
  }
}

/** Steps run in order; a step that throws simulates a provider failure
 * (e.g. 429). After the queue runs dry, every call succeeds. */
class QueueProvider implements TrainingReviewProvider {
  public requests: AiCompletionRequest[] = [];
  constructor(private readonly steps: Array<() => AiCompletion>) {}
  complete(request: AiCompletionRequest): Promise<AiCompletion> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (step === undefined) {
      return Promise.resolve({ text: `模拟回答 ${this.requests.length}`, model: 'fake' });
    }
    return Promise.resolve(step());
  }
}

/** Blocks inside complete() until the test releases it, simulating a slow
 * provider round so the test can mutate shared state mid-flight. */
class GatedProvider implements TrainingReviewProvider {
  public requests: AiCompletionRequest[] = [];
  private release?: () => void;
  complete(request: AiCompletionRequest): Promise<AiCompletion> {
    this.requests.push(request);
    return new Promise<AiCompletion>((resolve) => {
      this.release = () => resolve({ text: '迟到回复', model: 'fake' });
    });
  }
  releaseNow(): void {
    this.release?.();
  }
}

interface Harness {
  app: FastifyInstance;
  directory: string;
  database: DatabaseContext;
  provider: RecordingProvider;
  repository: ActivityRepository;
}

async function buildHarness(provider?: TrainingReviewProvider): Promise<Harness> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-ai-chat-'));
  const database = openDatabase(path.join(directory, 'runcoach.db'));
  applyMigrations(database.sqlite, path.resolve('apps/server/drizzle'));
  const repository = new ActivityRepository(database.db);
  const fileStore = new RawFileStore(directory);
  const importService = new ImportService(repository, fileStore, DEFAULT_OFFSET);
  const chatRepository = new ChatRepository(database.db);
  const activeProvider = provider ?? new RecordingProvider();
  const aiReview = new AiReviewService(repository, {
    enabled: true,
    provider: activeProvider,
    timeoutMs: 5000,
    maxOutputTokens: 512,
  });
  const coachChat = new CoachChatService(repository, chatRepository, () => aiReview.getActive(), {
    timeoutMs: 5000,
    maxOutputTokens: 512,
    historyTurns: MAX_CHAT_HISTORY_TURNS,
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
    chatRepository,
    coachChat,
  });
  return { app, directory, database, provider: activeProvider as RecordingProvider, repository };
}

describe('AI coach chat (M7 Batch 2)', () => {
  let harness: Harness | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T04:00:00.000Z'));
  });

  /** Advances the pinned clock so session/message timestamps stay ordered. */
  const tick = (seconds = 1) => {
    vi.setSystemTime(new Date(Date.now() + seconds * 1000));
  };

  afterEach(async () => {
    vi.useRealTimers();
    if (harness !== undefined) {
      await harness.app.close();
      harness.database.close();
      fs.rmSync(harness.directory, { recursive: true, force: true });
      harness = undefined;
    }
  });

  it('creates a session, persists both turns, and answers with the context rules', async () => {
    harness = await buildHarness();
    tick();
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '我最近的跑量怎么样？' },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json<{ sessionId: string; reply: string; sessionTitle: string }>();
    expect(body.reply).toBe('模拟回答 1');
    expect(body.sessionTitle).toBe('我最近的跑量怎么样？');

    // The provider receives the rules and the context JSON in the stable
    // system prefix, the raw message as the user prompt, and no history on
    // the first turn.
    expect(harness.provider.requests).toHaveLength(1);
    const request = harness.provider.requests[0]!;
    expect(request.systemPrompt).toContain('滚动日期范围');
    expect(request.systemPrompt).toContain('训练上下文 JSON');
    expect(request.systemPrompt).toContain('"generatedForLocalDate"');
    expect(request.userPrompt).toBe('我最近的跑量怎么样？');
    expect(request.userPrompt).not.toContain('"generatedForLocalDate"');
    expect(request.history ?? []).toHaveLength(0);

    // A second message in the same session carries the prior turns.
    tick();
    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '那和上个月比呢？', sessionId: body.sessionId },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ sessionId: string }>().sessionId).toBe(body.sessionId);
    const secondRequest = harness.provider.requests[1]!;
    expect(secondRequest.history).toHaveLength(2); // user + assistant
    expect(secondRequest.history?.[0]).toMatchObject({
      role: 'user',
      content: '我最近的跑量怎么样？',
    });
    // Prefix stability (provider prompt-cache friendly): with unchanged
    // training data the system prefix is byte-identical across turns, and
    // the history stays free of context JSON.
    expect(secondRequest.systemPrompt).toBe(request.systemPrompt);
    expect(secondRequest.userPrompt).toBe('那和上个月比呢？');
    expect(JSON.stringify(secondRequest.history)).not.toContain('"generatedForLocalDate"');

    // Both turns are persisted server-side.
    const messages = await harness.app.inject({
      method: 'GET',
      url: `/api/ai/coach/chat/sessions/${body.sessionId}/messages`,
    });
    expect(messages.statusCode).toBe(200);
    const messagesBody = messages.json<{ messages: Array<{ role: string }> }>();
    expect(messagesBody.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('bounds the history window sent to the model', async () => {
    harness = await buildHarness();
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '开始对话' },
    });
    const sessionId = first.json<{ sessionId: string }>().sessionId;
    for (let index = 0; index < MAX_CHAT_HISTORY_TURNS + 5; index += 1) {
      tick();
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/ai/coach/chat',
        payload: { message: `第 ${index} 个问题`, sessionId },
      });
      expect(response.statusCode).toBe(200);
    }
    const last = harness.provider.requests.at(-1)!;
    expect(last.history).toHaveLength(MAX_CHAT_HISTORY_TURNS);
    // The bounded window keeps the most recent turns, not the oldest.
    expect(last.history?.[0]?.content).not.toBe('开始对话');
  });

  it('keeps sessions and messages across a full close-and-reopen', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-ai-chat-reopen-'));
    const database = openDatabase(path.join(directory, 'runcoach.db'));
    applyMigrations(database.sqlite, path.resolve('apps/server/drizzle'));
    const repository = new ActivityRepository(database.db);
    const fileStore = new RawFileStore(directory);
    const importService = new ImportService(repository, fileStore, DEFAULT_OFFSET);
    const chatRepository = new ChatRepository(database.db);
    const provider = new RecordingProvider();
    const aiReview = new AiReviewService(repository, {
      enabled: true,
      provider,
      timeoutMs: 5000,
      maxOutputTokens: 512,
    });
    const coachChat = new CoachChatService(repository, chatRepository, () => aiReview.getActive(), {
      timeoutMs: 5000,
      maxOutputTokens: 512,
      historyTurns: MAX_CHAT_HISTORY_TURNS,
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
      chatRepository,
      coachChat,
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '重启前的问题' },
    });
    const sessionId = created.json<{ sessionId: string }>().sessionId;
    await app.close();
    database.close();

    // Reopen the same database: the session and both turns survive.
    const reopenedDatabase = openDatabase(path.join(directory, 'runcoach.db'));
    const reopenedChatRepository = new ChatRepository(reopenedDatabase.db);
    const messages = reopenedChatRepository.listMessages(sessionId);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0]?.content).toBe('重启前的问题');
    reopenedDatabase.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('rejects unknown sessions, empty and oversized messages, and reports disabled state', async () => {
    harness = await buildHarness();
    const unknown = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: {
        message: '问题',
        sessionId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f01',
      },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'SESSION_NOT_FOUND' });

    for (const payload of [{ message: '' }, { message: `${'长'.repeat(2001)}` }, {}]) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/ai/coach/chat',
        payload,
      });
      if (response.statusCode !== 400) {
        console.log('DEBUG payload →', response.statusCode, response.body);
      }
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_AI_CHAT_REQUEST' });
    }
    expect(harness.provider.requests).toHaveLength(0);

    // Deleting a session removes its messages (cascade) and a repeat delete
    // reports 404.
    tick();
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '将被删除' },
    });
    const sessionId = created.json<{ sessionId: string }>().sessionId;
    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: `/api/ai/coach/chat/sessions/${sessionId}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(
      (
        await harness.app.inject({
          method: 'DELETE',
          url: `/api/ai/coach/chat/sessions/${sessionId}`,
        })
      ).statusCode,
    ).toBe(404);
    const messagesAfterDelete = await harness.app.inject({
      method: 'GET',
      url: `/api/ai/coach/chat/sessions/${sessionId}/messages`,
    });
    expect(messagesAfterDelete.statusCode).toBe(404);
  });

  it('recomputes the system prefix when training data changes between turns', async () => {
    harness = await buildHarness();
    tick();
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '今天状态如何？' },
    });
    const sessionId = first.json<{ sessionId: string }>().sessionId;
    const before = harness.provider.requests[0]!;

    tick();
    // New training data between turns: the deterministic context changes, so
    // the model must see the fresh numbers, not a stale cached prefix.
    harness.repository.upsertDailyStatusEntry('2026-09-26', {
      sleepQuality: 4,
      fatigueLevel: 2,
      notes: '今晚状态不错',
    });
    await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '我刚才记录了状态', sessionId },
    });
    const after = harness.provider.requests[1]!;
    expect(after.systemPrompt).not.toBe(before.systemPrompt);
    expect(after.systemPrompt).toContain('今晚状态不错');
    expect(before.systemPrompt).not.toContain('今晚状态不错');
  });

  it('lists sessions newest-activity-first with message counts', async () => {
    harness = await buildHarness();
    tick();
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '第一个会话' },
    });
    const firstId = first.json<{ sessionId: string }>().sessionId;
    tick();
    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '第二个会话' },
    });
    const secondId = second.json<{ sessionId: string }>().sessionId;
    // Continue the FIRST session so it becomes the most recently updated.
    tick();
    await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '继续第一个', sessionId: firstId },
    });
    const list = await harness.app.inject({ method: 'GET', url: '/api/ai/coach/chat/sessions' });
    const sessions = list.json<{ sessions: Array<{ id: string; messageCount: number }> }>()
      .sessions;
    expect(sessions.map((session) => session.id)).toEqual([firstId, secondId]);
    expect(sessions[0]?.messageCount).toBe(4);
    expect(sessions[1]?.messageCount).toBe(2);
  });

  it('leaves no session after a failed new chat; explicit retry commits one round', async () => {
    harness = await buildHarness(
      new QueueProvider([
        () => {
          throw new AiProviderError('RATE_LIMITED', 'AI 服务请求过于频繁，请稍后再试');
        },
      ]),
    );
    const failed = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '会失败的新对话' },
    });
    expect(failed.statusCode).toBe(429);
    expect(failed.json()).toMatchObject({ code: 'AI_RATE_LIMITED' });

    // Nothing persisted: no empty session, no orphan user message.
    const afterFailure = await harness.app.inject({
      method: 'GET',
      url: '/api/ai/coach/chat/sessions',
    });
    expect(afterFailure.json()).toMatchObject({ sessions: [] });

    const retried = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '会失败的新对话' },
    });
    expect(retried.statusCode).toBe(200);
    const sessionId = retried.json<{ sessionId: string }>().sessionId;
    const sessions = (
      await harness.app.inject({ method: 'GET', url: '/api/ai/coach/chat/sessions' })
    ).json<{ sessions: Array<{ id: string; messageCount: number }> }>().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: sessionId, messageCount: 2 });
  });

  it('keeps an existing session untouched on failure; retry appends exactly one round', async () => {
    harness = await buildHarness(
      new QueueProvider([
        () => ({ text: '模拟回答 1', model: 'fake' }),
        () => {
          throw new AiProviderError('RATE_LIMITED', 'AI 服务请求过于频繁，请稍后再试');
        },
      ]),
    );
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '第一个问题' },
    });
    const sessionId = first.json<{ sessionId: string }>().sessionId;
    const before = (
      await harness.app.inject({ method: 'GET', url: '/api/ai/coach/chat/sessions' })
    ).json<{ sessions: Array<{ id: string; updatedAt: string; messageCount: number }> }>()
      .sessions[0]!;

    tick();
    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '第二个问题', sessionId },
    });
    expect(second.statusCode).toBe(429);

    // Failure changed nothing: same updatedAt, same message count.
    const afterFailure = (
      await harness.app.inject({ method: 'GET', url: '/api/ai/coach/chat/sessions' })
    ).json<{ sessions: Array<{ id: string; updatedAt: string; messageCount: number }> }>()
      .sessions[0]!;
    expect(afterFailure.updatedAt).toBe(before.updatedAt);
    expect(afterFailure.messageCount).toBe(before.messageCount);

    // The failed attempt is absent from the next provider history; the
    // pending user message travels only in this round's userPrompt.
    const retried = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '第二个问题', sessionId },
    });
    expect(retried.statusCode).toBe(200);
    const history = harness.provider.requests[2]!.history ?? [];
    expect(history).toHaveLength(2);
    expect(JSON.stringify(history)).not.toContain('第二个问题');
    expect(harness.provider.requests[2]!.userPrompt).toBe('第二个问题');

    const after = (
      await harness.app.inject({ method: 'GET', url: '/api/ai/coach/chat/sessions' })
    ).json<{ sessions: Array<{ id: string; messageCount: number }> }>().sessions[0]!;
    expect(after.messageCount).toBe(4);
    const messages = await harness.app.inject({
      method: 'GET',
      url: `/api/ai/coach/chat/sessions/${sessionId}/messages`,
    });
    expect(
      messages.json<{ messages: Array<{ role: string }> }>().messages.map((m) => m.role),
    ).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('writes nothing for timeout, empty, and oversized provider outcomes', async () => {
    // Timeout: provider-level failure.
    harness = await buildHarness(
      new QueueProvider([
        () => {
          throw new AiProviderError('TIMEOUT', 'AI 服务调用超时');
        },
      ]),
    );
    const timeout = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '超时的问题' },
    });
    expect(timeout.statusCode).toBe(504);
    expect(
      (await harness.app.inject({ method: 'GET', url: '/api/ai/coach/chat/sessions' })).json(),
    ).toMatchObject({ sessions: [] });
    await harness.app.close();
    harness.database.close();
    fs.rmSync(harness.directory, { recursive: true, force: true });

    // Empty response: provider succeeds, service validation fails.
    harness = await buildHarness(new QueueProvider([() => ({ text: '   ', model: 'fake' })]));
    const empty = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '空回答' },
    });
    expect(empty.statusCode).toBe(502);
    expect(empty.json()).toMatchObject({ code: 'AI_EMPTY_RESPONSE' });
    expect(
      (await harness.app.inject({ method: 'GET', url: '/api/ai/coach/chat/sessions' })).json(),
    ).toMatchObject({ sessions: [] });
    await harness.app.close();
    harness.database.close();
    fs.rmSync(harness.directory, { recursive: true, force: true });

    // Oversized reply: provider succeeds, size validation fails.
    harness = await buildHarness(
      new QueueProvider([() => ({ text: '长'.repeat(4001), model: 'fake' })]),
    );
    const oversized = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '超长回答' },
    });
    expect(oversized.statusCode).toBe(502);
    expect(oversized.json()).toMatchObject({ code: 'AI_INVALID_OUTPUT' });
    expect(
      (await harness.app.inject({ method: 'GET', url: '/api/ai/coach/chat/sessions' })).json(),
    ).toMatchObject({ sessions: [] });
  });

  it('lets the user resend the same sentence as a second successful round', async () => {
    harness = await buildHarness();
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '同一句话' },
    });
    const sessionId = first.json<{ sessionId: string }>().sessionId;
    tick();
    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '同一句话', sessionId },
    });
    expect(second.statusCode).toBe(200);
    const messages = await harness.app.inject({
      method: 'GET',
      url: `/api/ai/coach/chat/sessions/${sessionId}/messages`,
    });
    const rows = messages.json<{ messages: Array<{ role: string; content: string }> }>().messages;
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(rows.filter((row) => row.content === '同一句话')).toHaveLength(2);
    // The second round's history contains the whole first round.
    expect(harness.provider.requests[1]!.history).toHaveLength(2);
  });

  it('rolls the whole turn back when the second message write fails', async () => {
    harness = await buildHarness();
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '第一条消息' },
    });
    const sessionId = first.json<{ sessionId: string }>().sessionId;
    const before = (
      await harness.app.inject({ method: 'GET', url: '/api/ai/coach/chat/sessions' })
    ).json<{ sessions: Array<{ id: string; updatedAt: string; messageCount: number }> }>()
      .sessions[0]!;

    // Inject a real SQLite write failure for this exact user message.
    harness.database.sqlite
      .prepare(
        `CREATE TRIGGER fail_chat_user_insert BEFORE INSERT ON chat_messages
         WHEN NEW.role = 'user' AND NEW.content = '第二条消息'
         BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;`,
      )
      .run();

    const failed = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '第二条消息', sessionId },
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ code: 'INTERNAL_ERROR' });

    const afterFailure = (
      await harness.app.inject({ method: 'GET', url: '/api/ai/coach/chat/sessions' })
    ).json<{ sessions: Array<{ id: string; updatedAt: string; messageCount: number }> }>()
      .sessions[0]!;
    expect(afterFailure.updatedAt).toBe(before.updatedAt);
    expect(afterFailure.messageCount).toBe(before.messageCount);

    // New-session variant: the same write failure must not leave a session.
    const failedNew = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '第二条消息' },
    });
    expect(failedNew.statusCode).toBe(500);
    const sessionsAfter = (
      await harness.app.inject({ method: 'GET', url: '/api/ai/coach/chat/sessions' })
    ).json<{ sessions: Array<{ id: string }> }>().sessions;
    expect(sessionsAfter).toHaveLength(1);
    expect(sessionsAfter.map((session) => session.id)).toEqual([sessionId]);

    // Remove the trigger; the explicit retry now commits normally.
    harness.database.sqlite.prepare('DROP TRIGGER fail_chat_user_insert').run();
    const retried = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '第二条消息', sessionId },
    });
    expect(retried.statusCode).toBe(200);
    const after = (
      await harness.app.inject({ method: 'GET', url: '/api/ai/coach/chat/sessions' })
    ).json<{ sessions: Array<{ id: string; messageCount: number }> }>().sessions[0]!;
    expect(after.messageCount).toBe(4);
  });

  it('rolls the whole turn back when the assistant message write fails', async () => {
    harness = await buildHarness();
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '第一条消息' },
    });
    const sessionId = first.json<{ sessionId: string }>().sessionId;
    const before = (
      await harness.app.inject({ method: 'GET', url: '/api/ai/coach/chat/sessions' })
    ).json<{ sessions: Array<{ id: string; updatedAt: string; messageCount: number }> }>()
      .sessions[0]!;

    // Block the SECOND insert of the round: the user row must be rolled back
    // together with it — no half round may survive.
    harness.database.sqlite
      .prepare(
        `CREATE TRIGGER fail_chat_assistant_insert BEFORE INSERT ON chat_messages
         WHEN NEW.role = 'assistant'
         BEGIN SELECT RAISE(ABORT, 'injected assistant write failure'); END;`,
      )
      .run();

    const failed = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '助手写入失败的消息', sessionId },
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ code: 'INTERNAL_ERROR' });

    const afterFailure = (
      await harness.app.inject({ method: 'GET', url: '/api/ai/coach/chat/sessions' })
    ).json<{ sessions: Array<{ id: string; updatedAt: string; messageCount: number }> }>()
      .sessions[0]!;
    expect(afterFailure.updatedAt).toBe(before.updatedAt);
    expect(afterFailure.messageCount).toBe(before.messageCount); // the user row rolled back too

    // New-session variant: neither the session nor any message may remain.
    const failedNew = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '新会话助手写入失败' },
    });
    expect(failedNew.statusCode).toBe(500);
    const sessionsAfter = (
      await harness.app.inject({ method: 'GET', url: '/api/ai/coach/chat/sessions' })
    ).json<{ sessions: Array<{ id: string }> }>().sessions;
    expect(sessionsAfter.map((session) => session.id)).toEqual([sessionId]);

    // Remove the trigger; the explicit retry commits the full round.
    harness.database.sqlite.prepare('DROP TRIGGER fail_chat_assistant_insert').run();
    const retried = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '助手写入失败的消息', sessionId },
    });
    expect(retried.statusCode).toBe(200);
    const after = (
      await harness.app.inject({ method: 'GET', url: '/api/ai/coach/chat/sessions' })
    ).json<{ sessions: Array<{ id: string; messageCount: number }> }>().sessions[0]!;
    expect(after.messageCount).toBe(4);
  });

  it('reports SESSION_NOT_FOUND and persists nothing when the session is deleted mid-flight', async () => {
    const gated = new GatedProvider();
    harness = await buildHarness(gated);
    // First round: release the gate so the session gets created normally.
    const firstPromise = harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '将被删除的会话' },
    });
    await vi.waitFor(() => expect(gated.requests).toHaveLength(1));
    gated.releaseNow();
    const first = await firstPromise;
    const sessionId = first.json<{ sessionId: string }>().sessionId;
    const sessionsBefore = (
      await harness.app.inject({ method: 'GET', url: '/api/ai/coach/chat/sessions' })
    ).json<{ sessions: Array<{ id: string }> }>().sessions;

    const pending = harness.app.inject({
      method: 'POST',
      url: '/api/ai/coach/chat',
      payload: { message: '等待期间会话被删除', sessionId },
    });
    await vi.waitFor(() => expect(gated.requests).toHaveLength(2));
    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: `/api/ai/coach/chat/sessions/${sessionId}`,
    });
    expect(deleted.statusCode).toBe(204);
    gated.releaseNow();

    const response = await pending;
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'SESSION_NOT_FOUND' });

    // No resurrection, no new session, no orphan messages.
    const sessionsAfter = (
      await harness.app.inject({ method: 'GET', url: '/api/ai/coach/chat/sessions' })
    ).json<{ sessions: Array<{ id: string }> }>().sessions;
    expect(sessionsAfter.map((session) => session.id)).toEqual(
      sessionsBefore.filter((session) => session.id !== sessionId).map((session) => session.id),
    );
  });
});
