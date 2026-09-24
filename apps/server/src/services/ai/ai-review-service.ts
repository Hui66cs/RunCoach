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

/**
 * Server-owned system prompt. Encodes the factual interpretation rules for
 * the bounded numeric context: rolling windows (never "本周/本月"), fully
 * contained natural weeks only, the adherence denominator semantics, and the
 * distinction between "数据为 0", "暂无可计算结果" and "上下文未提供".
 * Exported so tests can assert exactly which rules reach the model.
 */
export const reviewSystemPrompt = [
  '你是跑步训练回顾助理。',
  '用户会提供一段仅包含数值聚合的训练上下文 JSON（不含任何个人信息、GPS、心率明细或自由文本）。',
  '请基于这些数值用中文写一段简短的训练回顾。',
  '',
  '事实口径（必须严格遵守）：',
  '1. 跑步汇总的字段覆盖从 windowStartLocalDate 到 windowEndLocalDate 的滚动日期范围（近 7 天或近 28 天）。描述这段时间时必须使用实际起止日期或“近 7 天”“近 28 天”，不得把滚动范围称为“本周”“本月”或其他固定周期。',
  '2. weeklyVolumes 只包含完整落在窗口内的自然周（周一起始）。weeklyVolumes 为空数组仅表示该窗口内没有可展示的完整自然周汇总，绝不代表这段时间没有跑步；是否有跑步只依据 running 字段（如 runs、totalDistanceMeters）判断。',
  '3. 计划执行率只依据 planSummary 的现有口径解释：eligibleCount = completedCount + skippedCount + overdueCount，adherenceRate = completedCount / eligibleCount。当 eligibleCount 为 0 或 adherenceRate 为 null 时，必须说明当前暂无可计算执行率的计划；处于今天或未来且仍为待完成的计划（upcomingCount）不能被评价为未达标。',
  '4. 区分三种情况并如实表述：“数据为 0”（字段存在且值为 0）、“该指标暂无可计算结果”（如 adherenceRate 为 null）、“上下文未提供该信息”（白名单中没有的字段一律不要提及或推断）。',
  '5. 不编造训练变化、完成情况、比赛计划或个人背景；上下文没有的信息不得推测。',
  '',
  '禁止：医疗建议或诊断；伤病风险判断；未经用户请求调整或生成训练计划。',
  '输出为中文纯文本，不超过 500 字。',
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
        systemPrompt: reviewSystemPrompt,
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
