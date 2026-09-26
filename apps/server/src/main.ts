import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/client.js';
import { applyMigrations, resolveMigrationsDirectory } from './db/migrate.js';
import { ActivityRepository } from './repositories/activity-repository.js';
import { ChatRepository } from './repositories/chat-repository.js';
import { AiReviewService } from './services/ai/ai-review-service.js';
import { CoachChatService } from './services/ai/coach-chat-service.js';
import { PlanDraftService } from './services/ai/plan-draft-service.js';
import { createAiKeysRuntime } from './services/ai/key-runtime.js';
import { DeepSeekReviewProvider } from './services/ai/deepseek-provider.js';
import type { TrainingReviewProvider } from './services/ai/provider.js';
import { ImportService } from './services/import-service.js';
import { RawFileStore } from './storage/raw-file-store.js';

const config = loadConfig();
const database = openDatabase(config.databasePath);
applyMigrations(database.sqlite, resolveMigrationsDirectory());

const repository = new ActivityRepository(database.db);
const fileStore = new RawFileStore(config.dataDir);
const importService = new ImportService(repository, fileStore, config.localOffsetMinutes);

// AI review (M6): disabled unless enabled via env or a settings-UI key; the
// key stays inside the provider/keystore — never in logs, responses, or Git.
const unreachableProvider: TrainingReviewProvider = {
  complete: () => Promise.reject(new Error('AI provider is not configured')),
};
const envProvider: TrainingReviewProvider =
  config.ai.deepSeek !== null
    ? new DeepSeekReviewProvider({
        apiKey: config.ai.deepSeek.apiKey,
        baseUrl: config.ai.baseUrl,
        model: 'deepseek-flash',
      })
    : unreachableProvider;

const aiReview = new AiReviewService(repository, {
  enabled: config.ai.enabled,
  provider: envProvider,
  timeoutMs: config.ai.timeoutMs,
  maxOutputTokens: config.ai.maxOutputTokens,
});

const aiKeys = createAiKeysRuntime({
  dataDir: config.dataDir,
  baseUrl: config.ai.baseUrl,
  envKey: config.ai.deepSeek?.apiKey ?? null,
  envEnabled: config.ai.enabled,
  aiReview,
});

const chatRepository = new ChatRepository(database.db);
const coachChat = new CoachChatService(repository, chatRepository, () => aiReview.getActive(), {
  timeoutMs: config.ai.timeoutMs,
  maxOutputTokens: config.ai.maxOutputTokens,
  historyTurns: 20,
});

const planDraft = new PlanDraftService(repository, () => aiReview.getActive(), {
  timeoutMs: config.ai.timeoutMs,
  maxOutputTokens: config.ai.maxOutputTokens,
});

const app = await buildApp({
  config,
  repository,
  importService,
  aiReview,
  aiKeys,
  chatRepository,
  coachChat,
  planDraft,
});

const shutdown = async () => {
  await app.close();
  database.close();
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ host: config.host, port: config.port });
