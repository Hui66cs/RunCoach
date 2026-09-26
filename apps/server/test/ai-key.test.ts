import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase, type DatabaseContext } from '../src/db/client.js';
import { applyMigrations } from '../src/db/migrate.js';
import { ActivityRepository } from '../src/repositories/activity-repository.js';
import { AiReviewService } from '../src/services/ai/ai-review-service.js';
import { createAiKeysRuntime, type AiKeysRuntime } from '../src/services/ai/key-runtime.js';
import { AiKeyStore, maskKey } from '../src/services/ai/key-store.js';
import type {
  AiCompletion,
  AiCompletionRequest,
  TrainingReviewProvider,
} from '../src/services/ai/provider.js';
import { ImportService } from '../src/services/import-service.js';
import { RawFileStore } from '../src/storage/raw-file-store.js';

const DEFAULT_OFFSET = 480;
const TEST_KEY = 'sk-e2e-ui-configured-key-0001';

class RecordingProvider implements TrainingReviewProvider {
  public requests: AiCompletionRequest[] = [];
  complete(request: AiCompletionRequest): Promise<AiCompletion> {
    this.requests.push(request);
    return Promise.resolve({ text: '回顾', model: 'fake' });
  }
}

describe('AiKeyStore and maskKey', () => {
  it('masks only the tail of a sufficiently long key', () => {
    expect(maskKey('sk-abcdefghij')).toBe('****ghij');
    expect(maskKey('short')).toBeNull();
    expect(maskKey(null)).toBeNull();
  });

  it('writes atomically, reads back trimmed, and clears the stored key', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-ai-key-'));
    try {
      const store = new AiKeyStore(directory);
      expect(store.readApiKey()).toBeNull();
      store.writeApiKey(`  ${TEST_KEY}  `);
      expect(fs.existsSync(path.join(directory, 'ai-provider.json'))).toBe(true);
      expect(store.readApiKey()).toBe(TEST_KEY);
      store.clear();
      expect(store.readApiKey()).toBeNull();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads a malformed key file as null instead of throwing', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-ai-key-'));
    try {
      fs.writeFileSync(path.join(directory, 'ai-provider.json'), '{broken', 'utf8');
      const store = new AiKeyStore(directory);
      expect(store.readApiKey()).toBeNull();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

interface Harness {
  app: FastifyInstance;
  aiKeys: AiKeysRuntime;
  directory: string;
  database: DatabaseContext;
  provider: RecordingProvider;
}

async function buildHarness(
  options: { envKey?: string; envEnabled?: boolean } = {},
): Promise<Harness> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-ai-key-api-'));
  const database = openDatabase(path.join(directory, 'runcoach.db'));
  applyMigrations(database.sqlite, path.resolve('apps/server/drizzle'));
  const repository = new ActivityRepository(database.db);
  const fileStore = new RawFileStore(directory);
  const importService = new ImportService(repository, fileStore, DEFAULT_OFFSET);
  const provider = new RecordingProvider();
  const envEnabled = options.envEnabled === true && options.envKey !== undefined;
  const aiReview = new AiReviewService(repository, {
    enabled: envEnabled,
    provider,
    timeoutMs: 5000,
    maxOutputTokens: 512,
  });
  const aiKeys = createAiKeysRuntime({
    dataDir: directory,
    baseUrl: 'https://api.example.com',
    envKey: options.envKey ?? null,
    envEnabled,
    aiReview,
    // Injectable factory: the "configured" provider is the recording fake, so
    // no network call can ever happen in tests.
    createProvider: () => provider,
  });
  const app = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir: directory,
      databasePath: path.join(directory, 'runcoach.db'),
      localOffsetMinutes: DEFAULT_OFFSET,
      maxUploadBytes: 1024,
      ai: {
        enabled: envEnabled,
        provider: 'none',
        deepSeek:
          options.envKey !== undefined && envEnabled
            ? { apiKey: options.envKey, baseUrl: 'https://api.example.com' }
            : null,
        baseUrl: 'https://api.example.com',
        timeoutMs: 5000,
        maxOutputTokens: 512,
      },
    },
    repository,
    importService,
    aiReview,
    aiKeys,
  });
  return { app, aiKeys, directory, database, provider };
}

async function closeHarness(harness: Harness): Promise<void> {
  await harness.app.close();
  harness.database.close();
  fs.rmSync(harness.directory, { recursive: true, force: true });
}

describe('AI key configuration API (M6 Batch 5)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await closeHarness(harness);
      harness = undefined;
    }
  });

  it('reports a disabled, unconfigured status without any key material', async () => {
    harness = await buildHarness();
    const response = await harness.app.inject({ method: 'GET', url: '/api/settings/ai' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      aiEnabled: false,
      provider: 'none',
      source: null,
      maskedTail: null,
    });
  });

  it('enables the integration when a key is saved through the UI', async () => {
    harness = await buildHarness();
    const saved = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings/ai-key',
      payload: { apiKey: TEST_KEY },
    });
    expect(saved.statusCode).toBe(200);
    const body = saved.json<{ aiEnabled: boolean; source: string; maskedTail: string | null }>();
    expect(body.aiEnabled).toBe(true);
    expect(body.source).toBe('file');
    expect(body.maskedTail).toBe('****0001');
    // The full key is written to the data-dir file and never echoed back.
    expect(fs.existsSync(path.join(harness.directory, 'ai-provider.json'))).toBe(true);
    expect(saved.body).not.toContain(TEST_KEY);
    // The review preview flips to enabled without any env change.
    const preview = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/context',
      payload: { windowDays: 7 },
    });
    expect(preview.json<{ aiEnabled: boolean }>().aiEnabled).toBe(true);
  });

  it('rejects an invalid key without changing state', async () => {
    harness = await buildHarness();
    for (const payload of [
      { apiKey: 'short' },
      { apiKey: '' },
      {},
      { apiKey: `${'x'.repeat(201)}` },
    ]) {
      const response = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings/ai-key',
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_AI_KEY' });
    }
    const status = await harness.app.inject({ method: 'GET', url: '/api/settings/ai' });
    expect(status.json()).toMatchObject({ aiEnabled: false, source: null, maskedTail: null });
    expect(fs.existsSync(path.join(harness.directory, 'ai-provider.json'))).toBe(false);
  });

  it('clearing falls back to the env path with its own flag semantics', async () => {
    harness = await buildHarness({ envKey: 'sk-env-configured-key-9999', envEnabled: true });
    const saved = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings/ai-key',
      payload: { apiKey: TEST_KEY },
    });
    expect(saved.json<{ source: string }>().source).toBe('file');

    const cleared = await harness.app.inject({ method: 'DELETE', url: '/api/settings/ai-key' });
    expect(cleared.statusCode).toBe(200);
    const body = cleared.json<{ aiEnabled: boolean; source: string; maskedTail: string | null }>();
    expect(body.aiEnabled).toBe(true); // env path was enabled on its own
    expect(body.source).toBe('env');
    expect(body.maskedTail).toBe('****9999');
    expect(fs.existsSync(path.join(harness.directory, 'ai-provider.json'))).toBe(false);
  });

  it('clearing without an env key returns to the disabled state', async () => {
    harness = await buildHarness();
    await harness.app.inject({
      method: 'PUT',
      url: '/api/settings/ai-key',
      payload: { apiKey: TEST_KEY },
    });
    const cleared = await harness.app.inject({ method: 'DELETE', url: '/api/settings/ai-key' });
    expect(cleared.json()).toMatchObject({
      aiEnabled: false,
      provider: 'none',
      source: null,
      maskedTail: null,
    });
    const preview = await harness.app.inject({
      method: 'POST',
      url: '/api/ai/context',
      payload: { windowDays: 7 },
    });
    expect(preview.json<{ aiEnabled: boolean }>().aiEnabled).toBe(false);
  });

  it('keeps the full key out of every response body and status view', async () => {
    harness = await buildHarness();
    await harness.app.inject({
      method: 'PUT',
      url: '/api/settings/ai-key',
      payload: { apiKey: TEST_KEY },
    });
    for (const url of ['/api/settings/ai', '/api/ai/context']) {
      const response =
        url === '/api/ai/context'
          ? await harness.app.inject({ method: 'POST', url, payload: { windowDays: 7 } })
          : await harness.app.inject({ method: 'GET', url });
      expect(response.body).not.toContain(TEST_KEY);
    }
  });
});
