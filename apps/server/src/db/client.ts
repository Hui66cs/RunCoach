import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type RunCoachDatabase = ReturnType<typeof createDrizzleDatabase>;

function createDrizzleDatabase(sqlite: BetterSqlite3.Database) {
  return drizzle({ client: sqlite, schema });
}

export interface DatabaseContext {
  sqlite: BetterSqlite3.Database;
  db: RunCoachDatabase;
  close(): void;
}

export function openDatabase(databasePath: string): DatabaseContext {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const sqlite = new BetterSqlite3(databasePath, { timeout: 5_000 });
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  const db = createDrizzleDatabase(sqlite);
  return {
    sqlite,
    db,
    close: () => sqlite.close(),
  };
}
