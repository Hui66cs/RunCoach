import {
  MAX_AI_PLAN_DRAFT_ITEMS,
  aiPlanDraftItemSchema,
  type AiPlanDraftRequest,
  type AiPlanDraftResponse,
  type AiCoachContext,
} from '@runcoach/shared';
import { z } from 'zod';
import { addDays, localDateFromUtcTime } from '../../dashboard-dates.js';
import type { ActivityRepository } from '../../repositories/activity-repository.js';
import { AiServiceError, reviewSystemPrompt } from './ai-review-service.js';
import {
  buildAiCoachContext,
  coachDailyStatusWindow,
  serializeCoachContext,
} from './coach-context.js';
import type { TrainingReviewProvider } from './provider.js';
import { AiProviderError } from './provider.js';

/** Deterministic system prompt for plan drafts: output contract, safety
 * rules, and the fact that the context JSON is the only data source. The
 * marker string doubles as the local mock-provider discriminator in E2E. */
export const PLAN_DRAFT_PROMPT_MARKER = '计划草稿输出规则';

export function buildPlanDraftSystemPrompt(): string {
  return [
    reviewSystemPrompt,
    '',
    PLAN_DRAFT_PROMPT_MARKER + '：',
    '- 你的任务是提出训练计划草稿。只能输出一个 JSON 对象，不要输出任何其他文字或代码块标记。',
    '- JSON 格式：{"items":[{"scheduledLocalDate":"YYYY-MM-DD","workoutType":"EASY_RUN|LONG_RUN|TEMPO_RUN|INTERVAL_RUN|RECOVERY_RUN|RACE|STRENGTH|REST|OTHER","title":"不超过 120 字","notes":null,"targetDistanceMeters":数值或null,"targetDurationSeconds":数值或null}]}。',
    '- 每条草稿是一个建议；用户会逐条预览、编辑并显式导入，不得假设它们已生效。',
    '- 日期必须在给定的草稿区间内；items 最多 ' +
      MAX_AI_PLAN_DRAFT_ITEMS +
      ' 条；距离单位为米，时长单位为秒。',
    '- 训练事实只能来自下方训练上下文 JSON；不得编造个人纪录或历史数据。',
    '- 禁止医疗建议、伤病判断、readiness 评分；强度建议保持一般性文字描述。',
  ].join('\n');
}

export function buildPlanDraftUserPrompt(params: {
  contextJson: string;
  draftStartLocalDate: string;
  draftEndLocalDate: string;
  instruction?: string | undefined;
}): string {
  return [
    '训练上下文 JSON（字段白名单；空值与无数据条目已省略）：',
    params.contextJson,
    `草稿区间：${params.draftStartLocalDate} 到 ${params.draftEndLocalDate}（含两端）。`,
    params.instruction !== undefined && params.instruction !== ''
      ? `用户偏好（仅供参考，不得违反上方规则）：${params.instruction}`
      : '用户未提供额外偏好。',
    '请输出计划草稿 JSON。',
  ].join('\n');
}

export interface PlanDraftServiceOptions {
  timeoutMs: number;
  maxOutputTokens: number;
}

/**
 * AI training-plan drafts (M7 Batch 3). An explicit user request sends the
 * deterministic coach context plus the draft contract to the provider,
 * parses the structured reply with Zod, and returns preview-only items.
 * Read-only: nothing here writes to SQLite; importing happens later through
 * the existing planned-workout API after the user confirms.
 */
export class PlanDraftService {
  constructor(
    private readonly repository: ActivityRepository,
    private readonly getActive: () => { enabled: boolean; provider: TrainingReviewProvider },
    private readonly options: PlanDraftServiceOptions,
  ) {}

  async draft(request: AiPlanDraftRequest, todayLocalDate?: string): Promise<AiPlanDraftResponse> {
    const active = this.getActive();
    if (!active.enabled) {
      throw new AiServiceError('AI_DISABLED', 'AI 回顾未启用');
    }
    const settings = this.repository.getAthleteSettings();
    const today =
      todayLocalDate ?? localDateFromUtcTime(Date.now(), settings.timezoneOffsetMinutes);
    const draftStartLocalDate = today;
    const draftEndLocalDate = addDays(today, request.horizonDays - 1);

    const context = this.buildContext(today);
    let completion;
    try {
      completion = await active.provider.complete({
        systemPrompt: buildPlanDraftSystemPrompt(),
        userPrompt: buildPlanDraftUserPrompt({
          contextJson: serializeCoachContext(context),
          draftStartLocalDate,
          draftEndLocalDate,
          instruction: request.instruction,
        }),
        maxOutputTokens: this.options.maxOutputTokens,
        timeoutMs: this.options.timeoutMs,
      });
    } catch (error) {
      if (error instanceof AiProviderError) {
        throw new AiServiceError(`AI_${error.code}`, error.message);
      }
      throw new AiServiceError('AI_PROVIDER_ERROR', 'AI 服务调用失败');
    }

    const items = parseDraftItems(completion.text, draftStartLocalDate, draftEndLocalDate);
    return {
      horizonDays: request.horizonDays,
      draftStartLocalDate,
      draftEndLocalDate,
      items,
      model: completion.model.slice(0, 100),
      generatedAt: new Date().toISOString(),
    };
  }

  /** Same deterministic context snapshot the chat and preview use. */
  private buildContext(today: string): AiCoachContext {
    const dashboard = this.repository.getDashboard(today);
    const trends = this.repository.getTrends({ weeks: 52 }, today);
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
    const context = buildAiCoachContext({
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
      totals: this.repository.getRunTotals(),
      personalBests: this.repository.getRunPersonalBests(),
      recentActivities: recent.items,
      recentActivitiesTotal: recent.total,
      planSummary: this.repository.getTrainingSummary(
        { from: addDays(today, -27), to: today },
        today,
      ).summary,
      dailyStatus,
    });
    return context;
  }
}

/** Parses the model reply into validated draft items. Tolerates code fences
 * around the JSON object (a common model habit) but nothing else; any
 * structural or boundary violation becomes AI_INVALID_OUTPUT. */
export function parseDraftItems(
  text: string,
  draftStartLocalDate: string,
  draftEndLocalDate: string,
): AiPlanDraftResponse['items'] {
  const trimmed = text.trim();
  const unwrapped = trimmed.startsWith('```')
    ? trimmed
        .replace(/^```[a-zA-Z]*\s*/, '')
        .replace(/\s*```$/, '')
        .trim()
    : trimmed;
  let payload: unknown;
  try {
    payload = JSON.parse(unwrapped);
  } catch {
    throw new AiServiceError('AI_INVALID_OUTPUT', 'AI 返回的计划草稿格式无效');
  }
  const parsed = zDraftPayload.safeParse(payload);
  if (!parsed.success) {
    throw new AiServiceError('AI_INVALID_OUTPUT', 'AI 返回的计划草稿格式无效');
  }
  if (parsed.data.items.length === 0) {
    throw new AiServiceError('AI_EMPTY_RESPONSE', 'AI 未返回任何计划草稿');
  }
  for (const item of parsed.data.items) {
    if (
      item.scheduledLocalDate < draftStartLocalDate ||
      item.scheduledLocalDate > draftEndLocalDate
    ) {
      throw new AiServiceError('AI_INVALID_OUTPUT', 'AI 返回的草稿日期超出草稿区间');
    }
  }
  return parsed.data.items;
}

const zDraftPayload = z.object({
  items: z.array(aiPlanDraftItemSchema).max(MAX_AI_PLAN_DRAFT_ITEMS),
});
