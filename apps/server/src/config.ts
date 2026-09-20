import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

const configSchema = z.object({
  RUNCOACH_HOST: z.string().default('127.0.0.1'),
  RUNCOACH_PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
  RUNCOACH_DATA_DIR: z.string().optional(),
  RUNCOACH_LOCAL_OFFSET_MINUTES: z.coerce.number().int().min(-840).max(840).default(480),
  RUNCOACH_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
});

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  localOffsetMinutes: number;
  maxUploadBytes: number;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  if (environment === process.env) {
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  }
  const parsed = configSchema.parse(environment);
  const dataDir =
    parsed.RUNCOACH_DATA_DIR === undefined
      ? path.join(projectRoot, '.local-data')
      : path.resolve(parsed.RUNCOACH_DATA_DIR);
  return {
    host: parsed.RUNCOACH_HOST,
    port: parsed.RUNCOACH_PORT,
    dataDir,
    databasePath: path.join(dataDir, 'runcoach.db'),
    localOffsetMinutes: parsed.RUNCOACH_LOCAL_OFFSET_MINUTES,
    maxUploadBytes: parsed.RUNCOACH_MAX_UPLOAD_BYTES,
  };
}
