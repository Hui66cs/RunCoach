import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

const booleanFlagSchema = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

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
  // AI review (M6): disabled by default; the API key never leaves the server
  // process and must not be committed or logged. An empty (or blank) key is
  // treated as absent so the example .env keeps the server startable while AI
  // stays disabled.
  RUNCOACH_AI_ENABLED: booleanFlagSchema,
  RUNCOACH_AI_PROVIDER: z.enum(['none', 'deepseek']).default('none'),
  RUNCOACH_DEEPSEEK_API_KEY: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(1).optional(),
  ),
  RUNCOACH_DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  RUNCOACH_AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  RUNCOACH_AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(2048).default(512),
});

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  localOffsetMinutes: number;
  maxUploadBytes: number;
  ai: {
    enabled: boolean;
    provider: 'none' | 'deepseek';
    deepSeek: { apiKey: string; baseUrl: string } | null;
    timeoutMs: number;
    maxOutputTokens: number;
  };
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
  const deepSeek =
    parsed.RUNCOACH_AI_PROVIDER === 'deepseek' && parsed.RUNCOACH_DEEPSEEK_API_KEY !== undefined
      ? {
          apiKey: parsed.RUNCOACH_DEEPSEEK_API_KEY,
          baseUrl: parsed.RUNCOACH_DEEPSEEK_BASE_URL,
        }
      : null;
  return {
    host: parsed.RUNCOACH_HOST,
    port: parsed.RUNCOACH_PORT,
    dataDir,
    databasePath: path.join(dataDir, 'runcoach.db'),
    localOffsetMinutes: parsed.RUNCOACH_LOCAL_OFFSET_MINUTES,
    maxUploadBytes: parsed.RUNCOACH_MAX_UPLOAD_BYTES,
    ai: {
      // Real calls require the explicit flag AND the deepseek provider AND a
      // configured key; anything else keeps the integration disabled.
      enabled:
        parsed.RUNCOACH_AI_ENABLED &&
        parsed.RUNCOACH_AI_PROVIDER === 'deepseek' &&
        deepSeek !== null,
      provider: parsed.RUNCOACH_AI_PROVIDER,
      deepSeek,
      timeoutMs: parsed.RUNCOACH_AI_TIMEOUT_MS,
      maxOutputTokens: parsed.RUNCOACH_AI_MAX_OUTPUT_TOKENS,
    },
  };
}
