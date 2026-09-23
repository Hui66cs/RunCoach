import { z } from 'zod';
import {
  AiProviderError,
  type AiCompletion,
  type AiCompletionRequest,
  type TrainingReviewProvider,
} from './provider.js';

/**
 * Server-side DeepSeek chat-completions adapter (M6). Read-only: it only
 * sends the prompt assembled by the service from the numeric whitelist and
 * never writes anywhere. The API key is kept in memory and used solely in the
 * Authorization header — it never appears in error messages or logs. The
 * upstream response is parsed through a Zod schema at the boundary; anything
 * missing, malformed, or empty becomes a stable AiProviderError.
 */
export class DeepSeekReviewProvider implements TrainingReviewProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl: string;
      model: string;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletion> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userPrompt },
          ],
          max_tokens: request.maxOutputTokens,
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AiProviderError('TIMEOUT', 'AI 服务调用超时');
      }
      throw new AiProviderError('PROVIDER_ERROR', 'AI 服务无法访问');
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new AiProviderError('RATE_LIMITED', 'AI 服务请求过于频繁，请稍后再试');
    }
    if (!response.ok) {
      // Only the HTTP status is surfaced; the body may echo prompts or keys.
      throw new AiProviderError('PROVIDER_ERROR', `AI 服务返回错误（状态 ${response.status}）`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AiProviderError('INVALID_OUTPUT', 'AI 服务返回了无法解析的内容');
    }
    const parsed = deepSeekResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AiProviderError('INVALID_OUTPUT', 'AI 服务返回格式无效');
    }
    const text = parsed.data.choices[0]?.message.content.trim() ?? '';
    if (text.length === 0) {
      throw new AiProviderError('EMPTY_RESPONSE', 'AI 服务返回了空内容');
    }
    return { text, model: parsed.data.model ?? this.options.model };
  }
}

const deepSeekResponseSchema = z.object({
  model: z.string().max(100).optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().max(100_000),
        }),
      }),
    )
    .min(1)
    .max(10),
});
