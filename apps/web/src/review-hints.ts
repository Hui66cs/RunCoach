import type { AiTrainingContext } from '@runcoach/shared';

/**
 * Deterministic, pre-send hints describing which facts the current context
 * actually supports (M6 Batch 4). Derived purely from the previewed
 * AiTrainingContext — no AI call, no inference about fitness, health, or
 * injury, and no arbitrary minimum-volume gate: the user can still confirm
 * and send whenever they want.
 *
 * Rules:
 * - running.runs === 0 → the window genuinely has no runs (data is 0).
 * - eligibleCount === 0 && adherenceRate === null → no computable adherence;
 *   upcoming plans are not "missed" or "failed".
 * - runs exist but weeklyVolumes is empty → the window simply contains no
 *   full natural week; this must never be phrased as "no running data".
 * - sparse data (no runs and no evaluable plans) → a restrained reminder
 *   that the AI review will mostly restate the numbers above.
 */
export function reviewDataHints(context: AiTrainingContext): string[] {
  const hints: string[] = [];
  const window = `统计窗口（${context.windowStartLocalDate} ~ ${context.windowEndLocalDate}）`;
  const hasRuns = context.running.runs > 0;
  const hasEvaluablePlans =
    context.planSummary.eligibleCount > 0 || context.planSummary.adherenceRate !== null;

  if (!hasRuns) {
    hints.push(`${window}内没有跑步记录。`);
  } else if (context.weeklyVolumes.length === 0) {
    hints.push(
      `${window}内没有可展示的完整自然周汇总（周一起始）；跑步情况以上方近 ${context.windowDays} 天汇总为准，周汇总缺席不代表数据缺失。`,
    );
  }

  if (context.planSummary.eligibleCount === 0 && context.planSummary.adherenceRate === null) {
    if (context.planSummary.upcomingCount > 0) {
      hints.push(
        `当前没有可计算的计划执行率（执行率基数为 0）；窗口内存在 ${context.planSummary.upcomingCount} 项尚未到期的计划，执行率考核不将其计入。`,
      );
    } else {
      hints.push('当前没有可计算的计划执行率（执行率基数为 0）。');
    }
  }

  if (!hasRuns && !hasEvaluablePlans) {
    hints.push(
      '本次可回顾的事实较少，AI 回顾可能主要概述以上已有数字，仅供参考，不代表训练水平或身体状况。',
    );
  }

  return hints;
}
