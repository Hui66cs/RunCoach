import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

function makeEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    RUNCOACH_HOST: '127.0.0.1',
    RUNCOACH_PORT: '3100',
    RUNCOACH_DATA_DIR: '.local-data',
    RUNCOACH_LOCAL_OFFSET_MINUTES: '480',
    RUNCOACH_MAX_UPLOAD_BYTES: '1048576',
    ...overrides,
  };
}

describe('AI configuration (M6)', () => {
  it('treats an empty RUNCOACH_DEEPSEEK_API_KEY as absent and keeps the server startable', () => {
    const config = loadConfig(
      makeEnvironment({ RUNCOACH_AI_PROVIDER: 'deepseek', RUNCOACH_DEEPSEEK_API_KEY: '' }),
    );
    expect(config.ai.enabled).toBe(false);
    expect(config.ai.deepSeek).toBeNull();
  });

  it('treats a blank RUNCOACH_DEEPSEEK_API_KEY as absent', () => {
    const config = loadConfig(
      makeEnvironment({
        RUNCOACH_AI_ENABLED: 'true',
        RUNCOACH_AI_PROVIDER: 'deepseek',
        RUNCOACH_DEEPSEEK_API_KEY: '   ',
      }),
    );
    expect(config.ai.enabled).toBe(false);
    expect(config.ai.deepSeek).toBeNull();
  });

  it('never enables real calls without the explicit flag and provider', () => {
    const config = loadConfig(makeEnvironment({ RUNCOACH_DEEPSEEK_API_KEY: 'sk-test' }));
    expect(config.ai.enabled).toBe(false);
    expect(config.ai.deepSeek).toBeNull();
  });

  it('keeps AI disabled when the flag is set but the key is missing', () => {
    const config = loadConfig(
      makeEnvironment({ RUNCOACH_AI_ENABLED: 'true', RUNCOACH_AI_PROVIDER: 'deepseek' }),
    );
    expect(config.ai.enabled).toBe(false);
    expect(config.ai.deepSeek).toBeNull();
  });

  it('enables the DeepSeek integration only with flag + provider + key together', () => {
    const config = loadConfig(
      makeEnvironment({
        RUNCOACH_AI_ENABLED: 'true',
        RUNCOACH_AI_PROVIDER: 'deepseek',
        RUNCOACH_DEEPSEEK_API_KEY: 'sk-test',
      }),
    );
    expect(config.ai.enabled).toBe(true);
    expect(config.ai.deepSeek).toEqual({ apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' });
    expect(config.ai.timeoutMs).toBe(20_000);
    expect(config.ai.maxOutputTokens).toBe(512);
  });
});
