import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/client.js';
import { applyMigrations, resolveMigrationsDirectory } from './db/migrate.js';
import { ActivityRepository } from './repositories/activity-repository.js';
import { ImportService } from './services/import-service.js';
import { RawFileStore } from './storage/raw-file-store.js';

const config = loadConfig();
const database = openDatabase(config.databasePath);
applyMigrations(database.sqlite, resolveMigrationsDirectory());

const repository = new ActivityRepository(database.db);
const fileStore = new RawFileStore(config.dataDir);
const importService = new ImportService(repository, fileStore, config.localOffsetMinutes);
const app = await buildApp({ config, repository, importService });

const shutdown = async () => {
  await app.close();
  database.close();
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ host: config.host, port: config.port });
