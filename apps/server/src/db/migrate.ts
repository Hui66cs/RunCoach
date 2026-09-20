import fs from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

export function resolveMigrationsDirectory(): string {
  const candidates = [
    path.resolve(process.cwd(), 'drizzle'),
    path.resolve(process.cwd(), 'apps/server/drizzle'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found === undefined) throw new Error('找不到 apps/server/drizzle migration 目录');
  return found;
}

export function applyMigrations(sqlite: BetterSqlite3.Database, migrationsDirectory: string): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _runcoach_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const appliedRows = sqlite.prepare('SELECT name FROM _runcoach_migrations').all() as Array<{
    name: string;
  }>;
  const applied = new Set(appliedRows.map((row) => row.name));
  const files = fs
    .readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const insertMigration = sqlite.prepare(
    'INSERT INTO _runcoach_migrations (name, applied_at) VALUES (?, ?)',
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDirectory, file), 'utf8');
    sqlite.exec('BEGIN IMMEDIATE;');
    try {
      sqlite.exec(sql);
      insertMigration.run(file, new Date().toISOString());
      sqlite.exec('COMMIT;');
    } catch (error) {
      sqlite.exec('ROLLBACK;');
      throw error;
    }
  }
}
