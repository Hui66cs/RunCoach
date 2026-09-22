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
