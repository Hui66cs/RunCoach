import { describe, expect, it } from 'vitest';
import {
  browserOffsetMinutes,
  canonicalMonth,
  isOverdue,
  localDateFromEpoch,
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
});
