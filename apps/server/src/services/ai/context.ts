import type { AiTrainingContext, DashboardResponse, TrainingSummaryCounts } from '@runcoach/shared';
import { MAX_AI_CONTEXT_DAYS } from '@runcoach/shared';
import { addDays } from '../../dashboard-dates.js';

/**
 * Builds the bounded AI training context from existing deterministic
 * aggregates (M6). Pure function: no I/O, no database access. The whitelist
 * is the exported schema — numeric run aggregates, Monday-start weekly
 * volumes fully contained in the window, and plan completion counts. A week
 * that only partially intersects the window is dropped (not clipped), since
 * its stored counts cover dates outside the window and no sent number may
 * include out-of-window dates. Activity names, notes, heart rate, GPS,
 * daily-status scales, and profile text are structurally absent because the
 * input types do not contain them.
 */
export function buildAiTrainingContext(params: {
  windowDays: 7 | 28;
  dashboard: DashboardResponse;
  planSummary: TrainingSummaryCounts;
}): AiTrainingContext {
  const { windowDays, dashboard, planSummary } = params;
  const windowEndLocalDate = dashboard.generatedForLocalDate;
  const windowStartLocalDate = addDays(windowEndLocalDate, -(windowDays - 1));
  const weeklyVolumes = dashboard.weeklyVolumes.filter(
    (week) =>
      week.weekStartLocalDate >= windowStartLocalDate &&
      week.weekEndLocalDate <= windowEndLocalDate,
  );
  return {
    generatedForLocalDate: dashboard.generatedForLocalDate,
    timezoneOffsetMinutes: dashboard.timezoneOffsetMinutes,
    windowDays: Math.min(windowDays, MAX_AI_CONTEXT_DAYS),
    windowStartLocalDate,
    windowEndLocalDate,
    running:
      windowDays === 7
        ? {
            runs: dashboard.last7Days.runs,
            totalDistanceMeters: dashboard.last7Days.totalDistanceMeters,
            totalMovingDurationSeconds: dashboard.last7Days.totalMovingDurationSeconds,
            averagePaceSecondsPerKilometer: dashboard.last7Days.averagePaceSecondsPerKilometer,
          }
        : {
            runs: dashboard.last28Days.runs,
            totalDistanceMeters: dashboard.last28Days.totalDistanceMeters,
            totalMovingDurationSeconds: dashboard.last28Days.totalMovingDurationSeconds,
            averagePaceSecondsPerKilometer: dashboard.last28Days.averagePaceSecondsPerKilometer,
          },
    weeklyVolumes,
    planSummary,
  };
}
