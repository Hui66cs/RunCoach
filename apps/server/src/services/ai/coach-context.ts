import type { AiCoachContext, DashboardResponse } from '@runcoach/shared';
import { MAX_AI_COACH_DAILY_STATUS_DAYS } from '@runcoach/shared';
import { addDays } from '../../dashboard-dates.js';

/**
 * Builds the conversational coach context (M7 Batch 1) from existing
 * deterministic aggregates: all-time RUN totals, deterministic personal
 * bests (including the biggest-week metric derived from the 52-week
 * volumes), a bounded recent-activity list, 52 weekly volumes, the last-28
 * -days plan summary, and the authorized daily-status window (scales and
 * notes — explicitly opted in by the user). Pure function: no I/O.
 */
export function buildAiCoachContext(params: {
  todayLocalDate: string;
  timezoneOffsetMinutes: number;
  dashboard: DashboardResponse;
  trends52WeeklyVolumes: DashboardResponse['weeklyVolumes'];
  totals: AiCoachContext['totals'];
  personalBests: AiCoachContext['personalBests'];
  recentActivities: AiCoachContext['recentActivities'];
  recentActivitiesTotal: number;
  planSummary: AiCoachContext['planSummary'];
  dailyStatus: AiCoachContext['dailyStatus'];
}): AiCoachContext {
  const weeklyVolumes = params.trends52WeeklyVolumes;
  const biggestWeek = weeklyVolumes.reduce<{
    value: number;
    achievedOn: string;
  } | null>((best, week) => {
    if (best === null || week.totalDistanceMeters > best.value) {
      return { value: week.totalDistanceMeters, achievedOn: week.weekStartLocalDate };
    }
    return best;
  }, null);
  const personalBests: AiCoachContext['personalBests'] = [...params.personalBests];
  if (biggestWeek !== null && biggestWeek.value > 0) {
    personalBests.push({
      metric: 'BIGGEST_WEEK_DISTANCE',
      value: biggestWeek.value,
      achievedOn: biggestWeek.achievedOn,
    });
  }
  return {
    generatedForLocalDate: params.todayLocalDate,
    timezoneOffsetMinutes: params.timezoneOffsetMinutes,
    totals: params.totals,
    personalBests,
    recentActivities: params.recentActivities,
    recentActivitiesTotal: params.recentActivitiesTotal,
    weeklyVolumes,
    planSummary: params.planSummary,
    dailyStatus: params.dailyStatus,
  };
}

/** The closed daily-status window ending today (max 28 days). */
export function coachDailyStatusWindow(todayLocalDate: string): {
  from: string;
  to: string;
} {
  return {
    from: addDays(todayLocalDate, -(MAX_AI_COACH_DAILY_STATUS_DAYS - 1)),
    to: todayLocalDate,
  };
}
