/**
 * Injectable training-review provider interface (M6). The service layer only
 * sees this interface, so tests inject deterministic fakes and the DeepSeek
 * adapter stays swappable. All error messages are sanitized: they must never
 * contain the API key, raw upstream bodies, or local paths.
 */

export type AiProviderErrorCode =
  'TIMEOUT' | 'RATE_LIMITED' | 'PROVIDER_ERROR' | 'EMPTY_RESPONSE' | 'INVALID_OUTPUT';

export class AiProviderError extends Error {
  constructor(
    public readonly code: AiProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export interface AiHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiCompletionRequest {
  /** Fixed server-owned instruction text plus the serialized authorized
   * context. Stable across turns when training data is unchanged, so
   * provider-side prefix caches can serve it; never contains names, GPS,
   * samples, or raw imports (daily-status notes are user-authorized). */
  systemPrompt: string;
  /** The user's new message (chat) or the review instruction (review). */
  userPrompt: string;
  /** Optional bounded prior conversation turns (oldest first, chat only). */
  history?: AiHistoryTurn[];
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface AiCompletion {
  text: string;
  /** Provider model identifier (safe to return to the client). */
  model: string;
}

export interface TrainingReviewProvider {
  complete(request: AiCompletionRequest): Promise<AiCompletion>;
}
