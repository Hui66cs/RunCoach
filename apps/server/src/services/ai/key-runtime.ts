import type { AiKeyStatus } from '@runcoach/shared';
import type { AiReviewService } from './ai-review-service.js';
import { DeepSeekReviewProvider } from './deepseek-provider.js';
import type { TrainingReviewProvider } from './provider.js';
import { AiKeyStore, maskKey } from './key-store.js';

/** Runtime for the settings-UI DeepSeek key configuration (M6 Batch 5).
 * The full key never passes through this interface — only masked status
 * views; it is handed solely to the provider constructor. */
export interface AiKeysRuntime {
  status(): AiKeyStatus;
  saveKey(apiKey: string): AiKeyStatus;
  clearKey(): AiKeyStatus;
}

export interface AiKeysRuntimeParams {
  dataDir: string;
  baseUrl: string;
  /** Env-configured key (RUNCOACH_DEEPSEEK_API_KEY), or null. */
  envKey: string | null;
  /** Whether the env path itself is enabled (flag + provider + env key). */
  envEnabled: boolean;
  aiReview: AiReviewService;
  /** Injectable for tests; defaults to the real DeepSeek adapter. */
  createProvider?: (apiKey: string) => TrainingReviewProvider;
}

const deepseekProviderFactory =
  (baseUrl: string) =>
  (apiKey: string): TrainingReviewProvider =>
    new DeepSeekReviewProvider({ apiKey, baseUrl, model: 'deepseek-flash' });

/**
 * Resolution priority: settings-UI key file > env key > disabled. A file key
 * enables the integration without the env flag (recording the key through
 * the confirmed UI flow is the user's informed opt-in); clearing falls back
 * to the env path or to disabled.
 */
export function createAiKeysRuntime(params: AiKeysRuntimeParams): AiKeysRuntime {
  const keyStore = new AiKeyStore(params.dataDir);
  const createProvider = params.createProvider ?? deepseekProviderFactory(params.baseUrl);

  const startupFileKey = keyStore.readApiKey();
  if (startupFileKey !== null) {
    params.aiReview.configureProvider({ enabled: true, provider: createProvider(startupFileKey) });
  }

  return {
    status(): AiKeyStatus {
      const activeFileKey = keyStore.readApiKey();
      const activeKey = activeFileKey ?? params.envKey;
      return {
        aiEnabled: params.aiReview.isEnabled(),
        provider: activeKey !== null ? 'deepseek' : 'none',
        source: activeFileKey !== null ? 'file' : params.envKey !== null ? 'env' : null,
        maskedTail: maskKey(activeKey),
      };
    },
    saveKey(apiKey: string): AiKeyStatus {
      keyStore.writeApiKey(apiKey);
      params.aiReview.configureProvider({ enabled: true, provider: createProvider(apiKey.trim()) });
      return this.status();
    },
    clearKey(): AiKeyStatus {
      keyStore.clear();
      params.aiReview.configureProvider({
        enabled: params.envEnabled,
        provider:
          params.envEnabled && params.envKey !== null
            ? createProvider(params.envKey)
            : { complete: () => Promise.reject(new Error('AI provider is not configured')) },
      });
      return this.status();
    },
  };
}
