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

/**
 * Serializes the coach context for the provider prompt. Semantically a strict
 * subset of the structured context (no key is added, no value is altered):
 * null/undefined values, empty strings, and empty arrays are omitted, and
 * daily-status entries that carry no data beyond their local date are
 * dropped. Meaningful zeros are kept. This shrinks every chat turn's token
 * cost without changing what the whitelist authorizes.
 */
export function serializeCoachContext(context: AiCoachContext): string {
  const dataBearing = context.dailyStatus.filter(
    (entry) =>
      entry.sleepQuality !== null ||
      entry.fatigueLevel !== null ||
      entry.muscleSorenessLevel !== null ||
      entry.stressLevel !== null ||
      entry.motivationLevel !== null ||
      entry.restingHeartRateBpm !== null ||
      (entry.notes !== null && entry.notes.trim() !== ''),
  );
  return JSON.stringify(
    pruneEmpty(
      dataBearing.length === context.dailyStatus.length
        ? context
        : { ...context, dailyStatus: dataBearing },
    ),
  );
}

function pruneEmpty(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return undefined;
  if (Array.isArray(value)) {
    const items = value.map(pruneEmpty).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const pruned = pruneEmpty(item);
      if (pruned !== undefined) result[key] = pruned;
    }
    return Object.keys(result).length === 0 ? undefined : result;
  }
  return value;
}
