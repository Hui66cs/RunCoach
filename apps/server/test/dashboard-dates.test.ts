import { describe, expect, it } from 'vitest';
import {
  addDays,
  eachLocalDate,
  isoDayOfWeek,
  lastDaysWindow,
  localDateFromUtcTime,
  mondayOfSameWeek,
  weeklyWindows,
} from '../src/dashboard-dates.js';

describe('dashboard local-date helpers', () => {
  it('derives the local date from a UTC timestamp and offset', () => {
    // 2026-09-22 17:30 UTC == 2026-09-23 01:30 at +08:00.
    expect(localDateFromUtcTime(Date.UTC(2026, 8, 22, 17, 30), 480)).toBe('2026-09-23');
    // Negative offsets roll the date backwards.
    expect(localDateFromUtcTime(Date.UTC(2026, 8, 22, 1, 0), -300)).toBe('2026-09-21');
    expect(localDateFromUtcTime(Date.UTC(2026, 8, 22, 0, 0), 480)).toBe('2026-09-22');
  });

  it('adds and subtracts days across month and year boundaries', () => {
    expect(addDays('2026-09-01', -1)).toBe('2026-08-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('treats Monday as the first weekday', () => {
    expect(isoDayOfWeek('2026-09-21')).toBe(1); // Monday
    expect(isoDayOfWeek('2026-09-22')).toBe(2); // Tuesday
    expect(isoDayOfWeek('2026-09-27')).toBe(7); // Sunday
    expect(mondayOfSameWeek('2026-09-25')).toBe('2026-09-21');
    expect(mondayOfSameWeek('2026-09-21')).toBe('2026-09-21');
  });

  it('builds closed 7/28-day windows ending today', () => {
    expect(lastDaysWindow('2026-09-22', 7)).toEqual({
      startLocalDate: '2026-09-16',
      endLocalDate: '2026-09-22',
    });
    expect(lastDaysWindow('2026-09-22', 28)).toEqual({
      startLocalDate: '2026-08-26',
      endLocalDate: '2026-09-22',
    });
  });

  it('returns twelve Monday-start windows including the current week, oldest first', () => {
    const windows = weeklyWindows('2026-09-22', 12);
    expect(windows).toHaveLength(12);
    expect(windows[0]).toEqual({ startLocalDate: '2026-07-06', endLocalDate: '2026-07-12' });
    expect(windows.at(-1)).toEqual({ startLocalDate: '2026-09-21', endLocalDate: '2026-09-27' });
    for (const window of windows) {
      expect(isoDayOfWeek(window.startLocalDate)).toBe(1);
      expect(isoDayOfWeek(window.endLocalDate)).toBe(7);
    }
  });

  it('keeps weekly windows continuous across year boundaries', () => {
    const windows = weeklyWindows('2026-01-01', 12);
    expect(windows.at(-1)).toEqual({ startLocalDate: '2025-12-29', endLocalDate: '2026-01-04' });
    for (let index = 1; index < windows.length; index += 1) {
      const previous = windows[index - 1]!;
      const current = windows[index]!;
      expect(addDays(previous.endLocalDate, 1)).toBe(current.startLocalDate);
    }
  });

  it('enumerates every date inside a window exactly once', () => {
    const dates = eachLocalDate({ startLocalDate: '2026-09-28', endLocalDate: '2026-10-02' });
    expect(dates).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });
});
