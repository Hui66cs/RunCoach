// Pure form-conversion helpers for the M5 athlete profile and daily status
// pages. They keep the km↔meters and form↔DTO translations in one testable
// place; the API keeps storing meters and English enum values.

import type {
  AthleteSettings,
  AthleteSettingsPatch,
  DailyStatusEntry,
  DailyStatusUpsert,
  ExperienceLevel,
} from '@runcoach/shared';

const MAX_WEEKLY_TARGET_METERS = 1_000_000; // 1000 km per week.

// ---------------------------------------------------------------------------
// Athlete profile
// ---------------------------------------------------------------------------

export interface AthleteProfileFormState {
  displayName: string;
  experienceLevel: string; // '' (未设置) or BEGINNER/INTERMEDIATE/ADVANCED.
  primaryGoal: string;
  weeklyTargetKm: string;
}

/** Formats stored meters as the km input string ('' for null). */
export function metersToKmInput(meters: number | null): string {
  if (meters === null) return '';
  return String(meters / 1000);
}

export function athleteProfileFormState(settings: AthleteSettings): AthleteProfileFormState {
  return {
    displayName: settings.displayName ?? '',
    experienceLevel: settings.experienceLevel ?? '',
    primaryGoal: settings.primaryGoal ?? '',
    weeklyTargetKm: metersToKmInput(settings.weeklyDistanceTargetMeters),
  };
}

/**
 * Converts the km input string into integer meters. Blank input means "clear"
 * (null). Rejects non-numeric, non-positive, and over-limit values with a
 * user-facing Chinese error.
 */
export function weeklyTargetKmToMeters(
  input: string,
): { ok: true; meters: number | null } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: true, meters: null };
  const km = Number(trimmed);
  if (!Number.isFinite(km)) {
    return { ok: false, error: '每周跑量目标必须是数字（单位 km）' };
  }
  if (km <= 0) {
    return { ok: false, error: '每周跑量目标必须大于 0 km' };
  }
  if (km > MAX_WEEKLY_TARGET_METERS / 1000) {
    return { ok: false, error: '每周跑量目标不能超过 1000 km' };
  }
  return { ok: true, meters: Math.round(km * 1000) };
}

/**
 * Builds a profile-only PATCH: blank fields are sent as explicit null so the
 * server clears them; the heart-rate/timezone fields are never touched here.
 */
export function buildAthleteProfilePatch(state: AthleteProfileFormState): {
  patch: AthleteSettingsPatch;
  error: string | null;
} {
  const target = weeklyTargetKmToMeters(state.weeklyTargetKm);
  if (!target.ok) return { patch: {}, error: target.error };
  const displayName = state.displayName.trim();
  const primaryGoal = state.primaryGoal.trim();
  const experienceLevel =
    state.experienceLevel === '' ? null : (state.experienceLevel as ExperienceLevel);
  return {
    patch: {
      displayName: displayName.length > 0 ? displayName : null,
      experienceLevel,
      primaryGoal: primaryGoal.length > 0 ? primaryGoal : null,
      weeklyDistanceTargetMeters: target.meters,
    },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Daily status
// ---------------------------------------------------------------------------

const DAILY_STATUS_SCALE_FIELDS = [
  'sleepQuality',
  'fatigueLevel',
  'muscleSorenessLevel',
  'stressLevel',
  'motivationLevel',
] as const;

export type DailyStatusScaleField = (typeof DAILY_STATUS_SCALE_FIELDS)[number];

export interface DailyStatusFormState {
  sleepQuality: string; // '' or '1'..'5'.
  fatigueLevel: string;
  muscleSorenessLevel: string;
  stressLevel: string;
  motivationLevel: string;
  restingHeartRateBpm: string;
  notes: string;
}

export function dailyStatusFormState(entry: DailyStatusEntry | null): DailyStatusFormState {
  return {
    sleepQuality: entry?.sleepQuality != null ? String(entry.sleepQuality) : '',
    fatigueLevel: entry?.fatigueLevel != null ? String(entry.fatigueLevel) : '',
    muscleSorenessLevel:
      entry?.muscleSorenessLevel != null ? String(entry.muscleSorenessLevel) : '',
    stressLevel: entry?.stressLevel != null ? String(entry.stressLevel) : '',
    motivationLevel: entry?.motivationLevel != null ? String(entry.motivationLevel) : '',
    restingHeartRateBpm:
      entry?.restingHeartRateBpm != null ? String(entry.restingHeartRateBpm) : '',
    notes: entry?.notes ?? '',
  };
}

/**
 * Converts the form into a `DailyStatusUpsert`. Blank scale fields and an
 * empty resting heart rate are simply absent (the server keeps the stored
 * value), notes follow the shared blank-to-null semantics. Returns
 * `upsert: null` with `error: null` when nothing meaningful was filled in
 * (the caller must not create an all-null record), or `error` with a
 * user-facing message for invalid values.
 */
export function buildDailyStatusUpsert(state: DailyStatusFormState): {
  upsert: DailyStatusUpsert | null;
  error: string | null;
} {
  const rhrTrimmed = state.restingHeartRateBpm.trim();
  let restingHeartRateBpm: number | undefined;
  if (rhrTrimmed.length > 0) {
    const value = Number(rhrTrimmed);
    if (!Number.isInteger(value) || value < 30 || value > 220) {
      return { upsert: null, error: '静息心率必须是 30–220 之间的整数 bpm' };
    }
    restingHeartRateBpm = value;
  }
  const upsert: DailyStatusUpsert = {};
  for (const field of DAILY_STATUS_SCALE_FIELDS) {
    const raw = state[field].trim();
    if (raw.length === 0) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      return { upsert: null, error: '每个量表必须是 1–5 之间的整数' };
    }
    upsert[field] = value;
  }
  if (restingHeartRateBpm !== undefined) upsert.restingHeartRateBpm = restingHeartRateBpm;
  // A whitespace-only note counts as empty; a real note is sent as-is and the
  // shared schema trims and normalizes it identically to the backend.
  if (state.notes.trim().length > 0) upsert.notes = state.notes;
  if (Object.keys(upsert).length === 0) return { upsert: null, error: null };
  return { upsert, error: null };
}
