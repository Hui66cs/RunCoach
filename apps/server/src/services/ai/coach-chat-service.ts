import { MAX_AI_REVIEW_CHARS, aiCoachContextSchema } from '@runcoach/shared';
import { addDays, localDateFromUtcTime } from '../../dashboard-dates.js';
import type { ActivityRepository } from '../../repositories/activity-repository.js';
import type { ChatRepository } from '../../repositories/chat-repository.js';
import type { TrainingReviewProvider } from './provider.js';
import { AiProviderError } from './provider.js';
import { AiServiceError, reviewSystemPrompt } from './ai-review-service.js';
import {
  buildAiCoachContext,
  coachDailyStatusWindow,
  serializeCoachContext,
} from './coach-context.js';

/** Chat system prompt: the factual interpretation rules from the review
 * prompt, the conversational boundaries, and the serialized coach context.
 * The context lives here — as the first message of every request — so the
 * prefix stays byte-identical across turns whenever training data is
 * unchanged, which lets the provider's prompt cache serve the bulk of the
 * request instead of re-billing the full context every turn. It never
 * contains names, GPS, samples, or raw imports. Structured plan generation
 * is a separate feature — the chat must not emit importable plans or claim
 * to modify the calendar. */
export function buildCoachChatSystemPrompt(contextJson: string): string {
  return [
    reviewSystemPrompt,
    '',
    '对话规则：',
    '- 你在一次多轮对话中回答用户关于其训练数据的问题；下方提供的训练上下文 JSON 是唯一事实来源。',
    '- 训练上下文 JSON 附于本条消息，每轮重新计算以保证数据最新；不要假装记得上下文之外的信息。',
    '- 回答要直接、简洁；用户问什么答什么，不必每次复述全部数字。',
    '- 禁止输出可导入日历的结构化训练计划；如用户请求计划，说明计划生成功能另行提供，可给出一般性文字建议。',
    '- 禁止医疗建议、伤病判断、readiness 评分；不编造数据。',
    '',
    '训练上下文 JSON（字段白名单，含每日状态与备注；空值与无数据条目已省略）：',
    contextJson,
  ].join('\n');
}

/** Builds the per-turn user prompt: only the user's new message. Prior turns
 * travel in `history` with the same raw format, and the context JSON travels
 * in the stable system prefix — not repeated here every turn. */
export function buildCoachChatUserPrompt(message: string): string {
  return message;
}

export interface CoachChatInput {
  sessionId?: string | null | undefined;
  message: string;
}

export interface CoachChatResult {
  sessionId: string;
  sessionTitle: string;
  reply: string;
  model: string;
  createdAt: string;
}

export interface CoachChatServiceOptions {
  timeoutMs: number;
  maxOutputTokens: number;
  /** Bounded number of prior turns sent with each request. */
  historyTurns: number;
}

/**
 * Persistent conversational coach (M7 Batch 2). Each explicit user message:
 * resolves/creates the session, snapshots the deterministic coach context,
 * sends [rules + context] + bounded history + the new message to the
 * provider, and persists both turns. Read-only with respect to training
 * data; failures map to stable sanitized AiServiceError codes.
 */
export class CoachChatService {
  constructor(
    private readonly repository: ActivityRepository,
    private readonly chatRepository: ChatRepository,
    private readonly getActive: () => { enabled: boolean; provider: TrainingReviewProvider },
    private readonly options: CoachChatServiceOptions,
  ) {}

  async chat(input: CoachChatInput, todayLocalDate?: string): Promise<CoachChatResult> {
    const active = this.getActive();
    if (!active.enabled) {
      throw new AiServiceError('AI_DISABLED', 'AI 回顾未启用');
    }
    const settings = this.repository.getAthleteSettings();
    const today =
      todayLocalDate ?? localDateFromUtcTime(Date.now(), settings.timezoneOffsetMinutes);
    const now = new Date().toISOString();

    const requestedSessionId = input.sessionId ?? null;
    const session =
      requestedSessionId === null ? null : this.chatRepository.getSession(requestedSessionId);
    if (requestedSessionId !== null && session === null) {
      throw new AiServiceError('SESSION_NOT_FOUND', '对话会话不存在或已被删除');
    }
    const current = session ?? this.chatRepository.createSession(input.message.slice(0, 30), now);

    const dashboard = this.repository.getDashboard(today);
    const trends = this.repository.getTrends({ weeks: 52 }, today);
    const totals = this.repository.getRunTotals();
    const personalBests = this.repository.getRunPersonalBests();
    const recent = this.repository.listRecentCoachActivitySummaries(60);
    const statusWindow = coachDailyStatusWindow(today);
    const dailyStatus = this.repository
      .listDailyStatusEntries(statusWindow.from, statusWindow.to)
      .map((entry) => ({
        localDate: entry.localDate,
        sleepQuality: entry.sleepQuality,
        fatigueLevel: entry.fatigueLevel,
        muscleSorenessLevel: entry.muscleSorenessLevel,
        stressLevel: entry.stressLevel,
        motivationLevel: entry.motivationLevel,
        restingHeartRateBpm: entry.restingHeartRateBpm,
        notes: entry.notes,
      }));
    const planSummary = this.repository.getTrainingSummary(
      { from: addDays(today, -27), to: today },
      today,
    ).summary;
    const context = aiCoachContextSchema.parse(
      buildAiCoachContext({
        todayLocalDate: today,
        timezoneOffsetMinutes: dashboard.timezoneOffsetMinutes,
        dashboard,
        trends52WeeklyVolumes: trends.weeklyPoints.map((point) => ({
          weekStartLocalDate: point.weekStartLocalDate,
          weekEndLocalDate: point.weekEndLocalDate,
          runs: point.runs,
          totalDistanceMeters: point.totalDistanceMeters,
          totalMovingDurationSeconds: point.totalMovingDurationSeconds,
        })),
        totals,
        personalBests,
        recentActivities: recent.items,
        recentActivitiesTotal: recent.total,
        planSummary,
        dailyStatus,
      }),
    );

    const history = this.chatRepository
      .recentMessages(current.id, this.options.historyTurns)
      .map((row) => ({ role: row.role, content: row.content }));

    this.chatRepository.appendMessage(current.id, 'user', input.message, now);

    let completion;
    try {
      completion = await active.provider.complete({
        systemPrompt: buildCoachChatSystemPrompt(serializeCoachContext(context)),
        userPrompt: buildCoachChatUserPrompt(input.message),
        history,
        maxOutputTokens: this.options.maxOutputTokens,
        timeoutMs: this.options.timeoutMs,
      });
    } catch (error) {
      if (error instanceof AiProviderError) {
        throw new AiServiceError(`AI_${error.code}`, error.message);
      }
      throw new AiServiceError('AI_PROVIDER_ERROR', 'AI 服务调用失败');
    }

    const replyText = completion.text.trim();
    if (replyText.length === 0) {
      throw new AiServiceError('AI_EMPTY_RESPONSE', 'AI 服务返回了空内容');
    }
    if (replyText.length > MAX_AI_REVIEW_CHARS) {
      throw new AiServiceError('AI_INVALID_OUTPUT', 'AI 服务返回内容超出大小限制');
    }
    const assistantRow = this.chatRepository.appendMessage(
      current.id,
      'assistant',
      replyText,
      new Date().toISOString(),
    );
    return {
      sessionId: current.id,
      sessionTitle: current.title,
      reply: replyText,
      model: completion.model.slice(0, 100),
      createdAt: assistantRow.createdAt,
    };
  }
}
