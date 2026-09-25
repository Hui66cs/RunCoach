import { describe, expect, it } from 'vitest';
import type { AiTrainingContext } from '@runcoach/shared';
import { reviewDataHints } from './review-hints.js';

function makeContext(overrides: Partial<AiTrainingContext> = {}): AiTrainingContext {
  return {
    generatedForLocalDate: '2026-09-24',
    timezoneOffsetMinutes: 480,
    windowDays: 7,
    windowStartLocalDate: '2026-09-18',
    windowEndLocalDate: '2026-09-24',
    running: {
      runs: 0,
      totalDistanceMeters: 0,
      totalMovingDurationSeconds: 0,
      averagePaceSecondsPerKilometer: null,
    },
    weeklyVolumes: [],
    planSummary: {
      plannedCount: 0,
      completedCount: 0,
      linkedCompletedCount: 0,
      skippedCount: 0,
      overdueCount: 0,
      upcomingCount: 0,
      eligibleCount: 0,
      adherenceRate: null,
    },
    ...overrides,
  };
}

describe('review data hints (M6 Batch 4)', () => {
  it('reports no runs, no computable adherence, and upcoming plans without calling them missed', () => {
    const hints = reviewDataHints(
      makeContext({
        planSummary: {
          plannedCount: 2,
          completedCount: 0,
          linkedCompletedCount: 0,
          skippedCount: 0,
          overdueCount: 0,
          upcomingCount: 2,
          eligibleCount: 0,
          adherenceRate: null,
        },
      }),
    );
    expect(hints.join('\n')).toContain('没有跑步记录');
    expect(hints.join('\n')).toContain('没有可计算的计划执行率');
    expect(hints.join('\n')).toContain('尚未到期的计划');
    expect(hints.join('\n')).toContain('执行率考核不将其计入');
    expect(hints.join('\n')).not.toContain('未完成');
    expect(hints.join('\n')).not.toContain('未达标');
    // Sparse data reminder applies: no runs and no evaluable plans.
    expect(hints.join('\n')).toContain('可能主要概述');
  });

  it('reports no runs but keeps the adherence remark silent when plans are evaluable', () => {
    const hints = reviewDataHints(
      makeContext({
        planSummary: {
          plannedCount: 3,
          completedCount: 1,
          linkedCompletedCount: 1,
          skippedCount: 0,
          overdueCount: 1,
          upcomingCount: 1,
          eligibleCount: 2,
          adherenceRate: 0.5,
        },
      }),
    );
    const joined = hints.join('\n');
    expect(joined).toContain('没有跑步记录');
    expect(joined).not.toContain('没有可计算的计划执行率');
    // Evaluable plans exist, so only the running side is sparse — the prompt's
    // "both dimensions sparse" reminder must not fire.
    expect(joined).not.toContain('可能主要概述');
  });

  it('never phrases an empty weeklyVolumes as missing running data when runs exist', () => {
    const hints = reviewDataHints(
      makeContext({
        running: {
          runs: 4,
          totalDistanceMeters: 32_000,
          totalMovingDurationSeconds: 9600,
          averagePaceSecondsPerKilometer: 300,
        },
        weeklyVolumes: [],
      }),
    );
    const joined = hints.join('\n');
    expect(joined).toContain('没有可展示的完整自然周汇总');
    expect(joined).toContain('以上方近 7 天汇总为准');
    expect(joined).not.toContain('没有跑步记录');
    expect(joined).not.toContain('缺少跑步数据');
    expect(joined).not.toContain('可能主要概述');
  });

  it('stays silent when the context is rich', () => {
    const hints = reviewDataHints(
      makeContext({
        running: {
          runs: 4,
          totalDistanceMeters: 32_000,
          totalMovingDurationSeconds: 9600,
          averagePaceSecondsPerKilometer: 300,
        },
        weeklyVolumes: [
          {
            weekStartLocalDate: '2026-09-21',
            weekEndLocalDate: '2026-09-27',
            runs: 3,
            totalDistanceMeters: 24_000,
            totalMovingDurationSeconds: 7200,
          },
        ],
        planSummary: {
          plannedCount: 5,
          completedCount: 3,
          linkedCompletedCount: 2,
          skippedCount: 1,
          overdueCount: 1,
          upcomingCount: 0,
          eligibleCount: 5,
          adherenceRate: 0.6,
        },
      }),
    );
    expect(hints).toEqual([]);
  });

  it('carries the actual window dates so hints follow preview changes', () => {
    const hints = reviewDataHints(
      makeContext({ windowDays: 28, windowStartLocalDate: '2026-08-28' }),
    );
    expect(hints[0]).toContain('2026-08-28 ~ 2026-09-24');
  });
});
