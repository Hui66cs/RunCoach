import { describe, expect, it } from 'vitest';
import {
  addDays,
  browserOffsetMinutes,
  canonicalMonth,
  isOverdue,
  isoDayOfWeek,
  isValidLocalDate,
  localDateFromEpoch,
  monthOf,
  mondayOfSameWeek,
  sundayOfSameWeek,
} from './local-date.js';

describe('canonical local date from athlete timezone offset', () => {
  it('differs from the UTC date for a positive +08:00 offset', () => {
    const epochMs = Date.parse('2026-09-21T20:30:00Z'); // UTC date is 2026-09-21.
    expect(localDateFromEpoch(epochMs, 0)).toBe('2026-09-21');
    expect(localDateFromEpoch(epochMs, 480)).toBe('2026-09-22');
    expect(canonicalMonth(epochMs, 480)).toBe('2026-09');
    expect(canonicalMonth(epochMs, 0)).toBe('2026-09');
  });

  it('differs from the UTC date for a negative UTC-05:00 offset', () => {
    const epochMs = Date.parse('2026-09-21T02:30:00Z'); // UTC date is 2026-09-21.
    expect(localDateFromEpoch(epochMs, 0)).toBe('2026-09-21');
    expect(localDateFromEpoch(epochMs, -300)).toBe('2026-09-20');
    // The late-UTC-time direction also crosses the month boundary.
    const monthBoundary = Date.parse('2026-10-01T00:30:00Z');
    expect(localDateFromEpoch(monthBoundary, -300)).toBe('2026-09-30');
    expect(canonicalMonth(monthBoundary, -300)).toBe('2026-09');
  });

  it('keeps the same date when the shifted time stays within one day', () => {
    const epochMs = Date.parse('2026-09-22T10:00:00Z');
    expect(localDateFromEpoch(epochMs, 480)).toBe('2026-09-22');
    expect(localDateFromEpoch(epochMs, -300)).toBe('2026-09-22');
    expect(localDateFromEpoch(epochMs, 0)).toBe('2026-09-22');
  });

  it('classifies a plan scheduled exactly on today as upcoming, not overdue', () => {
    const today = '2026-09-22';
    expect(isOverdue('2026-09-22', today)).toBe(false);
    // Future plans are never overdue either.
    expect(isOverdue('2026-09-23', today)).toBe(false);
  });

  it('classifies a plan scheduled before today as overdue', () => {
    const today = '2026-09-22';
    expect(isOverdue('2026-09-21', today)).toBe(true);
    expect(isOverdue('2026-01-01', today)).toBe(true);
  });

  it('exposes a deterministic browser offset fallback without touching global state', () => {
    const epochMs = Date.parse('2026-09-22T10:00:00Z');
    const offset = browserOffsetMinutes(epochMs);
    expect(Number.isInteger(offset)).toBe(true);
    // The fallback alone must reproduce a valid local date through the same
    // pure pipeline, whatever the host timezone is.
    expect(localDateFromEpoch(epochMs, offset)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('validates real calendar dates for the ?date= parameter', () => {
    expect(isValidLocalDate('2026-09-22')).toBe(true);
    expect(isValidLocalDate('2024-02-29')).toBe(true); // leap year.
    expect(isValidLocalDate('2026-09-31')).toBe(false); // impossible day.
    expect(isValidLocalDate('2026-13-01')).toBe(false);
    expect(isValidLocalDate('2026-9-1')).toBe(false);
    expect(isValidLocalDate('not-a-date')).toBe(false);
  });

  it('adds whole days on a UTC basis across month and year boundaries', () => {
    expect(addDays('2026-09-22', 7)).toBe('2026-09-29');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01'); // month boundary.
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01'); // year boundary.
    expect(addDays('2026-09-22', -22)).toBe('2026-08-31'); // backwards.
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28'); // non-leap February.
  });

  it('finds the Monday of the week containing a date', () => {
    expect(isoDayOfWeek('2026-09-21')).toBe(1); // Monday.
    expect(mondayOfSameWeek('2026-09-21')).toBe('2026-09-21');
    expect(isoDayOfWeek('2026-09-23')).toBe(3); // Wednesday.
    expect(mondayOfSameWeek('2026-09-23')).toBe('2026-09-21');
    expect(isoDayOfWeek('2026-09-27')).toBe(7); // Sunday.
    expect(mondayOfSameWeek('2026-09-27')).toBe('2026-09-21');
    // Year boundary: 2027-01-01 is a Friday in the week starting 2026-12-28.
    expect(isoDayOfWeek('2027-01-01')).toBe(5);
    expect(mondayOfSameWeek('2027-01-01')).toBe('2026-12-28');
  });

  it('finds the Sunday of the week containing a date', () => {
    expect(sundayOfSameWeek('2026-09-21')).toBe('2026-09-27'); // Monday input.
    expect(sundayOfSameWeek('2026-09-23')).toBe('2026-09-27'); // mid-week.
    expect(sundayOfSameWeek('2026-09-27')).toBe('2026-09-27'); // Sunday input.
    expect(sundayOfSameWeek('2027-01-01')).toBe('2027-01-03'); // year boundary.
  });

  it('extracts the month part of a local date', () => {
    expect(monthOf('2026-09-23')).toBe('2026-09');
    expect(monthOf('2027-01-01')).toBe('2027-01');
  });
});
