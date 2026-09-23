import { createHash } from 'node:crypto';
import {
  MAX_AI_REVIEW_CHARS,
  aiTrainingContextSchema,
  dashboardResponseSchema,
  type AiContextPreviewRequest,
  type AiContextPreviewResponse,
  type AiReviewRequest,
  type AiReviewResponse,
  type AiTrainingContext,
} from '@runcoach/shared';
import type { ActivityRepository } from '../../repositories/activity-repository.js';
import { localDateFromUtcTime } from '../../dashboard-dates.js';
import { buildAiTrainingContext } from './context.js';
import { AiProviderError, type TrainingReviewProvider } from './provider.js';

/** Stable, sanitized service-level error; `code` maps to an HTTP error code. */
export class AiServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AiServiceError';
  }
}

const systemPrompt = [
  '你是跑步训练回顾助理。',
  '用户会提供一段仅包含数值聚合的近 7 或 28 天训练上下文（不含任何个人信息、GPS、心率明细或自由文本）。',
  '请基于这些数值用中文写一段简短的训练回顾。',
  '要求：不提供医疗建议或诊断；不评判伤病风险；不修改训练计划；不编造上下文中不存在的数字。',
  '输出为纯文本，不超过 500 字。',
].join('\n');

/** Builds the user prompt from the whitelisted context only (pure, testable). */
export function buildReviewUserPrompt(contextJson: string): string {
  return [
    '以下是训练上下文 JSON（字段白名单，均为数值聚合）：',
    contextJson,
    '请按系统指令输出训练回顾。',
  ].join('\n');
}

/** Bounded fingerprint of the exact context (SHA-256 of its stable JSON). */
export function contextFingerprint(context: AiTrainingContext): string {
  return createHash('sha256').update(JSON.stringify(context)).digest('hex');
}

export interface AiReviewServiceOptions {
  enabled: boolean;
  provider: TrainingReviewProvider;
  timeoutMs: number;
  maxOutputTokens: number;
}

/**
 * User-triggered, read-only AI training review (M6). The context is assembled
 * exclusively from existing deterministic aggregates; the provider is only
 * called when the operator has enabled the integration; every failure maps to
 * a stable sanitized AiServiceError; no code path writes to SQLite.
 */
export class AiReviewService {
  constructor(
    private readonly repository: ActivityRepository,
    private readonly options: AiReviewServiceOptions,
  ) {}

  /**
   * Read-only preview of exactly what a review request would send. Never
   * calls the provider — it works even while the integration is disabled, so
   * a future UI can show the context ("先看发送内容") before any confirm
   * step ("再确认") actually triggers the model call.
   */
  preview(request: AiContextPreviewRequest, todayLocalDate?: string): AiContextPreviewResponse {
    const context = this.buildContext(request, todayLocalDate);
    return {
      context,
      aiEnabled: this.options.enabled,
      contextFingerprint: contextFingerprint(context),
    };
  }

  async review(request: AiReviewRequest, todayLocalDate?: string): Promise<AiReviewResponse> {
    if (!this.options.enabled) {
      throw new AiServiceError('AI_DISABLED', 'AI 回顾未启用');
    }
    const context = this.buildContext(request, todayLocalDate);
    // Server-side fingerprint comparison: when data or the canonical today
    // changed since the confirmed preview, the request is rejected before
    // the provider is called — a changed context is never silently sent.
    const expected = contextFingerprint(context);
    if (request.contextFingerprint !== expected) {
      throw new AiServiceError('AI_CONTEXT_STALE', '训练上下文已变化，请重新预览并确认');
    }
    const userPrompt = buildReviewUserPrompt(JSON.stringify(context));

    let completion;
    try {
      completion = await this.options.provider.complete({
        systemPrompt,
        userPrompt,
        maxOutputTokens: this.options.maxOutputTokens,
        timeoutMs: this.options.timeoutMs,
      });
    } catch (error) {
      if (error instanceof AiProviderError) {
        throw new AiServiceError(`AI_${error.code}`, error.message);
      }
      throw new AiServiceError('AI_PROVIDER_ERROR', 'AI 服务调用失败');
    }

    const text = completion.text.trim();
    if (text.length === 0) {
      throw new AiServiceError('AI_EMPTY_RESPONSE', 'AI 服务返回了空内容');
    }
    if (text.length > MAX_AI_REVIEW_CHARS) {
      throw new AiServiceError('AI_INVALID_OUTPUT', 'AI 服务返回内容超出大小限制');
    }
    return {
      context,
      review: text,
      model: completion.model.slice(0, 100),
      generatedAt: new Date().toISOString(),
    };
  }

  /** Shared context assembly for preview and review: same canonical today,
   * same aggregates, same whitelist. Provider is never touched here. */
  private buildContext(
    request: AiContextPreviewRequest,
    todayLocalDate?: string,
  ): AiTrainingContext {
    const settings = this.repository.getAthleteSettings();
    const today =
      todayLocalDate ?? localDateFromUtcTime(Date.now(), settings.timezoneOffsetMinutes);
    // The same canonical today feeds every aggregate so the context window
    // cannot drift between sources.
    const dashboard = dashboardResponseSchema.parse(this.repository.getDashboard(today));
    const startLocalDate = new Date(
      Date.parse(`${today}T00:00:00Z`) - (request.windowDays - 1) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const planSummary = this.repository.getTrainingSummary(
      { from: startLocalDate, to: today },
      today,
    ).summary;
    return aiTrainingContextSchema.parse(
      buildAiTrainingContext({ windowDays: request.windowDays, dashboard, planSummary }),
    );
  }
}
