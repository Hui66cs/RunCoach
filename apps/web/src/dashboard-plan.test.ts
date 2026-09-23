import { describe, expect, it } from 'vitest';
import type { CalendarPlannedWorkout } from '@runcoach/shared';
import {
  dashboardPlanWindow,
  todaysPlannedWorkouts,
  upcomingPlannedWorkouts,
  weeklyRunDistanceMeters,
  weeklyTargetPercent,
} from './dashboard-plan.js';

function plan(overrides: Partial<CalendarPlannedWorkout>): CalendarPlannedWorkout {
  return {
    id: overrides.id ?? '00000000-0000-4000-8000-000000000001',
    scheduledLocalDate: '2026-09-23',
    workoutType: 'EASY_RUN',
    title: '计划',
    notes: null,
    targetDistanceMeters: null,
    targetDurationSeconds: null,
    completionStatus: 'PLANNED',
    linkedActivityId: null,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    linkedActivity: null,
    ...overrides,
  };
}

describe('dashboardPlanWindow', () => {
  it('covers the whole current week plus the next 7 days in one bounded window', () => {
    // Wednesday: Monday is two days back; today+7 wins over the week Sunday.
    expect(dashboardPlanWindow('2026-09-23')).toEqual({
      today: '2026-09-23',
      weekMonday: '2026-09-21',
      weekSunday: '2026-09-27',
      rangeFrom: '2026-09-21',
      rangeTo: '2026-09-30',
    });
    // Sunday: the week Monday is six days back; today+7 still wins.
    expect(dashboardPlanWindow('2026-09-27')).toMatchObject({
      weekMonday: '2026-09-21',
      rangeFrom: '2026-09-21',
      rangeTo: '2026-10-04',
    });
    // Monday: the week Sunday (today+6) and today+7 differ by one day.
    expect(dashboardPlanWindow('2026-09-21')).toMatchObject({
      weekMonday: '2026-09-21',
      rangeFrom: '2026-09-21',
      rangeTo: '2026-09-28',
    });
  });

  it('keeps the window within the bounded calendar limit even in the worst case', () => {
    for (const [month, day] of [
      ['01', '01'],
      ['02', '28'],
      ['12', '31'],
    ] as const) {
      const window = dashboardPlanWindow(`2026-${month}-${day}`);
      expect(window.rangeFrom <= window.rangeTo).toBe(true);
      const spanDays =
        (Date.parse(`${window.rangeTo}T00:00:00Z`) - Date.parse(`${window.rangeFrom}T00:00:00Z`)) /
        86_400_000;
      expect(spanDays).toBeLessThanOrEqual(13);
    }
  });

  it('handles year boundaries around the current week', () => {
    expect(dashboardPlanWindow('2027-01-01')).toMatchObject({
      weekMonday: '2026-12-28',
      rangeFrom: '2026-12-28',
      rangeTo: '2027-01-08',
    });
  });
});

describe('todaysPlannedWorkouts', () => {
  it('returns only plans scheduled on today, keeping several per day', () => {
    const plans = [
      plan({ id: '1', scheduledLocalDate: '2026-09-22', title: '昨天' }),
      plan({ id: '2', scheduledLocalDate: '2026-09-23', title: 'B' }),
      plan({ id: '3', scheduledLocalDate: '2026-09-23', title: 'A' }),
      plan({ id: '4', scheduledLocalDate: '2026-09-24', title: '明天' }),
    ];
    const todays = todaysPlannedWorkouts(plans, '2026-09-23');
    expect(todays.map((entry) => entry.title)).toEqual(['B', 'A']);
  });
});

describe('upcomingPlannedWorkouts', () => {
  it('excludes today and plans beyond 7 days, keeps only PLANNED, sorts deterministically', () => {
    const plans = [
      plan({ id: '1', scheduledLocalDate: '2026-09-23', title: '今天' }),
      plan({
        id: '2',
        scheduledLocalDate: '2026-09-24',
        title: 'B',
        completionStatus: 'COMPLETED',
      }),
      plan({
        id: '3',
        scheduledLocalDate: '2026-09-24',
        title: '跳过',
        completionStatus: 'SKIPPED',
      }),
      plan({ id: '4', scheduledLocalDate: '2026-10-01', title: '第八天' }),
      plan({ id: '5', scheduledLocalDate: '2026-09-25', title: '乙' }),
      plan({ id: '6', scheduledLocalDate: '2026-09-24', title: 'A' }),
      plan({ id: '7', scheduledLocalDate: '2026-09-24', title: 'A' }),
    ];
    const { items, hasMore } = upcomingPlannedWorkouts(plans, '2026-09-23');
    expect(items.map((entry) => entry.id)).toEqual(['6', '7', '5']);
    expect(hasMore).toBe(false);
  });

  it('caps the list at five items and reports hasMore', () => {
    const plans = Array.from({ length: 7 }, (_, index) =>
      plan({
        id: `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
        scheduledLocalDate: '2026-09-24',
        title: `计划 ${index + 1}`,
      }),
    );
    const { items, hasMore } = upcomingPlannedWorkouts(plans, '2026-09-23');
    expect(items).toHaveLength(5);
    expect(items.map((entry) => entry.title)).toEqual([
      '计划 1',
      '计划 2',
      '计划 3',
      '计划 4',
      '计划 5',
    ]);
    expect(hasMore).toBe(true);
  });
});

describe('weeklyRunDistanceMeters', () => {
  const activities = [
    { localDate: '2026-09-20', activityType: 'RUN', distanceMeters: 9999 }, // before the week
    { localDate: '2026-09-21', activityType: 'RUN', distanceMeters: 5000 },
    { localDate: '2026-09-23', activityType: 'RUN', distanceMeters: 2500.5 },
    { localDate: '2026-09-23', activityType: 'STRENGTH', distanceMeters: 10000 }, // not RUN
    { localDate: '2026-09-24', activityType: 'RUN', distanceMeters: 0 }, // non-positive
    { localDate: '2026-09-24', activityType: 'RUN', distanceMeters: -3000 }, // negative
    { localDate: '2026-09-24', activityType: 'RUN', distanceMeters: Number.POSITIVE_INFINITY },
    { localDate: '2026-09-24', activityType: 'RUN', distanceMeters: null },
    { localDate: '2026-09-27', activityType: 'RUN', distanceMeters: 1500 },
    { localDate: '2026-09-28', activityType: 'RUN', distanceMeters: 7000 }, // next week
  ] as unknown as Parameters<typeof weeklyRunDistanceMeters>[0];

  it('sums only positive finite RUN distances inside the closed week window', () => {
    expect(weeklyRunDistanceMeters(activities, '2026-09-21', '2026-09-27')).toBeCloseTo(9000.5, 6);
  });

  it('returns 0 for an empty selection', () => {
    expect(weeklyRunDistanceMeters([], '2026-09-21', '2026-09-27')).toBe(0);
  });
});

describe('weeklyTargetPercent', () => {
  it('computes the completion percentage and allows values above 100', () => {
    expect(weeklyTargetPercent(25000, 50000)).toBe(50);
    expect(weeklyTargetPercent(60000, 50000)).toBe(120);
    expect(weeklyTargetPercent(0, 50000)).toBe(0);
  });

  it('never fabricates a percentage for a missing or non-positive target', () => {
    expect(weeklyTargetPercent(25000, 0)).toBe(0);
    expect(weeklyTargetPercent(25000, -1000)).toBe(0);
  });
});
