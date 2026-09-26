import fs from 'node:fs';
import path from 'node:path';

/**
 * Server-side storage for the DeepSeek API key configured through the UI
 * (M6 Batch 5). The key lives in a single JSON file inside the configured
 * data directory (gitignored via the `.local-data` and `.e2e-data-*` glob
 * patterns), never in the browser, logs, or Git. Writes are atomic
 * (tmp + rename); reads of a missing or malformed file yield null.
 */
export class AiKeyStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'ai-provider.json');
  }

  readApiKey(): string | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as {
        deepseekApiKey?: unknown;
      };
      if (typeof raw.deepseekApiKey !== 'string') return null;
      const trimmed = raw.deepseekApiKey.trim();
      return trimmed === '' ? null : trimmed;
    } catch {
      return null;
    }
  }

  writeApiKey(apiKey: string): void {
    const trimmed = apiKey.trim();
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ deepseekApiKey: trimmed }, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  clear(): void {
    fs.rmSync(this.filePath, { force: true });
  }
}

/** Masked tail for display: at most the last 4 characters; null when the key
 * is too short to be safely identifiable. */
export function maskKey(apiKey: string | null): string | null {
  if (apiKey === null) return null;
  const trimmed = apiKey.trim();
  if (trimmed.length < 8) return null;
  return `****${trimmed.slice(-4)}`;
}
