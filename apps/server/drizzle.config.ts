import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env['RUNCOACH_DB_PATH'] ?? '../../.local-data/runcoach.db',
  },
});
