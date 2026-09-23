// Pure "canonical today" helpers for the calendar page. They intentionally
// mirror the server's `dashboard-dates.ts` semantics: a local date is derived
// from an absolute epoch time shifted by the athlete settings timezone offset,
// never from the browser's own timezone, so the overdue badges and the
// training-summary's overdue/upcoming classification cannot disagree.

/** `YYYY-MM-DD` for an epoch time shifted into the athlete timezone. */
export function localDateFromEpoch(epochMs: number, timezoneOffsetMinutes: number): string {
  return new Date(epochMs + timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** Canonical current month (`YYYY-MM`) for the athlete timezone. */
export function canonicalMonth(epochMs: number, timezoneOffsetMinutes: number): string {
  return localDateFromEpoch(epochMs, timezoneOffsetMinutes).slice(0, 7);
}

/**
 * A PLANNED workout scheduled before `today` is overdue; scheduled on today
 * is upcoming, not overdue. This is exactly the server-side training-summary
 * rule (`scheduled_local_date < today`).
 */
export function isOverdue(scheduledLocalDate: string, today: string): boolean {
  return scheduledLocalDate < today;
}

/**
 * Deterministic browser offset, used only as a transient fallback while the
 * athlete settings request is in flight or has failed; it never feeds the
 * overdue classification once settings are known.
 */
export function browserOffsetMinutes(nowMs: number = Date.now()): number {
  return -new Date(nowMs).getTimezoneOffset();
}

/** True when `value` is a real `YYYY-MM-DD` calendar date (rejects 2026-02-30 etc.). */
export function isValidLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const epochMs = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(epochMs) && new Date(epochMs).toISOString().slice(0, 10) === value;
}

/** Shifts a `YYYY-MM-DD` local date by whole days (UTC-based, DST-free). */
export function addDays(localDate: string, days: number): string {
  return new Date(Date.parse(`${localDate}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** ISO weekday of a `YYYY-MM-DD` date: 1 = Monday … 7 = Sunday. */
export function isoDayOfWeek(localDate: string): number {
  const weekday = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** Monday of the week containing `localDate` (weeks start on Monday). */
export function mondayOfSameWeek(localDate: string): string {
  return addDays(localDate, -(isoDayOfWeek(localDate) - 1));
}

/** Sunday of the week containing `localDate` (weeks start on Monday). */
export function sundayOfSameWeek(localDate: string): string {
  return addDays(mondayOfSameWeek(localDate), 6);
}

/** `YYYY-MM` part of a `YYYY-MM-DD` local date. */
export function monthOf(localDate: string): string {
  return localDate.slice(0, 7);
}
