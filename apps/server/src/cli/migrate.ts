import { loadConfig } from '../config.js';
import { openDatabase } from '../db/client.js';
import { applyMigrations, resolveMigrationsDirectory } from '../db/migrate.js';

const config = loadConfig();
const database = openDatabase(config.databasePath);
try {
  applyMigrations(database.sqlite, resolveMigrationsDirectory());
  console.log(`数据库迁移完成：${config.databasePath}`);
} finally {
  database.close();
}
