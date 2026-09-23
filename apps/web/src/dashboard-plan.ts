// Pure selection helpers for the Dashboard daily loop. They derive the
// bounded calendar window from the canonical today returned by
// `GET /api/dashboard` (`generatedForLocalDate`) and pick today's plans, the
// upcoming week's plans, and the current week's real RUN distance. No scores,
// advice, or medical conclusions are produced anywhere here.

import type { CalendarActivitySummary, CalendarPlannedWorkout } from '@runcoach/shared';
import { addDays, mondayOfSameWeek, sundayOfSameWeek } from './local-date.js';

export interface DashboardPlanWindow {
  today: string;
  weekMonday: string;
  weekSunday: string;
  rangeFrom: string;
  rangeTo: string;
}

/**
 * The closed calendar window supporting today's plans, the current week's
 * real distance, and the next 7 days of plans in one bounded query:
 * from = current week's Monday, to = max(week Sunday, today + 7 days).
 * The span is at most 14 inclusive local dates — well inside the 93-day
 * calendar limit.
 */
export function dashboardPlanWindow(today: string): DashboardPlanWindow {
  const weekMonday = mondayOfSameWeek(today);
  const weekSunday = sundayOfSameWeek(today);
  const in7Days = addDays(today, 7);
  return {
    today,
    weekMonday,
    weekSunday,
    rangeFrom: weekMonday,
    rangeTo: weekSunday > in7Days ? weekSunday : in7Days,
  };
}

/** All plans scheduled on `today` (a day may have several). */
export function todaysPlannedWorkouts(
  plans: CalendarPlannedWorkout[],
  today: string,
): CalendarPlannedWorkout[] {
  return plans.filter((plan) => plan.scheduledLocalDate === today);
}

export const UPCOMING_PLANS_LIMIT = 5;

export interface UpcomingPlans {
  items: CalendarPlannedWorkout[];
  hasMore: boolean;
}

/**
 * Plans strictly after `today`, within the next 7 local dates, still
 * PLANNED, ordered by date then title then id (deterministic codepoint
 * order); at most {@link UPCOMING_PLANS_LIMIT} items plus a hasMore flag.
 */
export function upcomingPlannedWorkouts(
  plans: CalendarPlannedWorkout[],
  today: string,
): UpcomingPlans {
  const until = addDays(today, 7);
  const byDateThenTitleThenId = (a: CalendarPlannedWorkout, b: CalendarPlannedWorkout): number =>
    a.scheduledLocalDate.localeCompare(b.scheduledLocalDate) ||
    (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) ||
    a.id.localeCompare(b.id);
  const filtered = plans
    .filter(
      (plan) =>
        plan.completionStatus === 'PLANNED' &&
        plan.scheduledLocalDate > today &&
        plan.scheduledLocalDate <= until,
    )
    .sort(byDateThenTitleThenId);
  return {
    items: filtered.slice(0, UPCOMING_PLANS_LIMIT),
    hasMore: filtered.length > UPCOMING_PLANS_LIMIT,
  };
}

/**
 * Sum of positive, finite RUN distances whose `localDate` falls inside the
 * closed [weekMonday, weekSunday] window. Planned workouts are never counted.
 */
export function weeklyRunDistanceMeters(
  activities: CalendarActivitySummary[],
  weekMonday: string,
  weekSunday: string,
): number {
  let total = 0;
  for (const activity of activities) {
    if (activity.activityType !== 'RUN') continue;
    if (activity.localDate < weekMonday || activity.localDate > weekSunday) continue;
    const distance = activity.distanceMeters;
    if (typeof distance !== 'number' || !Number.isFinite(distance) || distance <= 0) continue;
    total += distance;
  }
  return total;
}

/** Completion percentage against a positive weekly target; can exceed 100. */
export function weeklyTargetPercent(actualMeters: number, targetMeters: number): number {
  if (!(targetMeters > 0)) return 0;
  return (actualMeters / targetMeters) * 100;
}
