// Pure local-date helpers for dashboard aggregation. All functions operate on
// `YYYY-MM-DD` strings treated as UTC midnights so they stay deterministic and
// free of daylight-saving surprises.

const DAY_MS = 86_400_000;

/** Shifts a UTC timestamp into the configured local offset and returns its local date. */
export function localDateFromUtcTime(utcMilliseconds: number, offsetMinutes: number): string {
  return new Date(utcMilliseconds + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function addDays(localDate: string, days: number): string {
  return new Date(Date.parse(`${localDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export function isoDayOfWeek(localDate: string): number {
  const weekday = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** Monday of the week that contains `localDate`. */
export function mondayOfSameWeek(localDate: string): string {
  return addDays(localDate, -(isoDayOfWeek(localDate) - 1));
}

export interface LocalDateWindow {
  startLocalDate: string;
  endLocalDate: string;
}

/** Closed interval of the last `days` local dates, ending today. */
export function lastDaysWindow(todayLocalDate: string, days: number): LocalDateWindow {
  return { startLocalDate: addDays(todayLocalDate, -(days - 1)), endLocalDate: todayLocalDate };
}

/** `weeks` Monday-start windows, oldest first; the last window contains today. */
export function weeklyWindows(todayLocalDate: string, weeks: number): LocalDateWindow[] {
  const currentMonday = mondayOfSameWeek(todayLocalDate);
  return Array.from({ length: weeks }, (_, index) => {
    const startLocalDate = addDays(currentMonday, (index - (weeks - 1)) * 7);
    return { startLocalDate, endLocalDate: addDays(startLocalDate, 6) };
  });
}

/** Every local date inside a closed window, ascending. */
export function eachLocalDate(window: LocalDateWindow): string[] {
  const dates: string[] = [];
  for (let date = window.startLocalDate; date <= window.endLocalDate; date = addDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}
