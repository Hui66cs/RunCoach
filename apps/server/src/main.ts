import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/client.js';
import { applyMigrations, resolveMigrationsDirectory } from './db/migrate.js';
import { ActivityRepository } from './repositories/activity-repository.js';
import { AiReviewService } from './services/ai/ai-review-service.js';
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

// AI review (M6): disabled unless explicitly enabled with a DeepSeek key in
// the environment; the key stays inside the provider and is never logged.
const unreachableProvider: TrainingReviewProvider = {
  complete: () => Promise.reject(new Error('AI provider is not configured')),
};
const aiProvider: TrainingReviewProvider =
  config.ai.enabled && config.ai.deepSeek !== null
    ? new DeepSeekReviewProvider({
        apiKey: config.ai.deepSeek.apiKey,
        baseUrl: config.ai.deepSeek.baseUrl,
        model: 'deepseek-flash',
      })
    : unreachableProvider;
const aiReview = new AiReviewService(repository, {
  enabled: config.ai.enabled,
  provider: aiProvider,
  timeoutMs: config.ai.timeoutMs,
  maxOutputTokens: config.ai.maxOutputTokens,
});

const app = await buildApp({ config, repository, importService, aiReview });

const shutdown = async () => {
  await app.close();
  database.close();
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ host: config.host, port: config.port });
