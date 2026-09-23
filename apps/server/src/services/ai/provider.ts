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

export interface AiCompletionRequest {
  /** Fixed server-owned instruction text; never contains user free text. */
  systemPrompt: string;
  /** The bounded whitelist context serialized by the service. */
  userPrompt: string;
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
