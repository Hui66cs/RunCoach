import { describe, expect, it } from 'vitest';
import type { AthleteSettings, DailyStatusEntry } from '@runcoach/shared';
import { dailyStatusUpsertSchema } from '@runcoach/shared';
import {
  athleteProfileFormState,
  buildAthleteProfilePatch,
  buildDailyStatusUpsert,
  dailyStatusFormState,
  metersToKmInput,
  weeklyTargetKmToMeters,
} from './form-conversion.js';

const SETTINGS: AthleteSettings = {
  maxHeartRateBpm: 190,
  restingHeartRateBpm: null,
  thresholdHeartRateBpm: null,
  heartRateZoneMethod: 'MAX_HR_PERCENT',
  distanceUnit: 'METRIC',
  timezoneOffsetMinutes: 480,
  displayName: '跑者甲',
  experienceLevel: 'INTERMEDIATE',
  primaryGoal: '恢复稳定跑量',
  weeklyDistanceTargetMeters: 25500,
  updatedAt: '2026-09-22T00:00:00.000Z',
};

describe('weekly target km ↔ meters', () => {
  it('converts decimal km input to integer meters', () => {
    expect(weeklyTargetKmToMeters('25.5')).toEqual({ ok: true, meters: 25500 });
    expect(weeklyTargetKmToMeters(' 30 ')).toEqual({ ok: true, meters: 30000 });
    expect(weeklyTargetKmToMeters('1000')).toEqual({ ok: true, meters: 1_000_000 });
  });

  it('treats blank input as clearing the target', () => {
    expect(weeklyTargetKmToMeters('')).toEqual({ ok: true, meters: null });
    expect(weeklyTargetKmToMeters('   ')).toEqual({ ok: true, meters: null });
  });

  it('rejects non-numeric, zero, negative, and over-limit values', () => {
    for (const input of ['abc', 'NaN', '0', '-5', '1000.1', 'Infinity']) {
      expect(weeklyTargetKmToMeters(input).ok, input).toBe(false);
    }
    expect(weeklyTargetKmToMeters('abc')).toMatchObject({ error: /必须是数字/ });
    expect(weeklyTargetKmToMeters('0')).toMatchObject({ error: /大于 0/ });
    expect(weeklyTargetKmToMeters('-5')).toMatchObject({ error: /大于 0/ });
    expect(weeklyTargetKmToMeters('1000.1')).toMatchObject({ error: /1000 km/ });
  });

  it('round-trips stored meters back into the km input', () => {
    expect(metersToKmInput(25500)).toBe('25.5');
    expect(metersToKmInput(50000)).toBe('50');
    expect(metersToKmInput(null)).toBe('');
  });
});

describe('athlete profile form conversion', () => {
  it('fills the form state from settings and back to a profile-only patch', () => {
    const state = athleteProfileFormState(SETTINGS);
    expect(state).toEqual({
      displayName: '跑者甲',
      experienceLevel: 'INTERMEDIATE',
      primaryGoal: '恢复稳定跑量',
      weeklyTargetKm: '25.5',
    });
    const { patch, error } = buildAthleteProfilePatch(state);
    expect(error).toBeNull();
    expect(patch).toEqual({
      displayName: '跑者甲',
      experienceLevel: 'INTERMEDIATE',
      primaryGoal: '恢复稳定跑量',
      weeklyDistanceTargetMeters: 25500,
    });
  });

  it('normalizes blank profile fields to explicit nulls for clearing', () => {
    const { patch } = buildAthleteProfilePatch({
      displayName: '   ',
      experienceLevel: '',
      primaryGoal: '',
      weeklyTargetKm: '',
    });
    expect(patch).toEqual({
      displayName: null,
      experienceLevel: null,
      primaryGoal: null,
      weeklyDistanceTargetMeters: null,
    });
  });

  it('trims non-blank text values', () => {
    const { patch } = buildAthleteProfilePatch({
      displayName: '  跑者甲  ',
      experienceLevel: 'BEGINNER',
      primaryGoal: '  完成首场半马  ',
      weeklyTargetKm: '40',
    });
    expect(patch).toMatchObject({
      displayName: '跑者甲',
      experienceLevel: 'BEGINNER',
      primaryGoal: '完成首场半马',
      weeklyDistanceTargetMeters: 40000,
    });
  });
});

const ENTRY: DailyStatusEntry = {
  id: '11111111-1111-4111-8111-111111111111',
  localDate: '2026-09-22',
  sleepQuality: 1,
  fatigueLevel: 5,
  muscleSorenessLevel: null,
  stressLevel: 3,
  motivationLevel: null,
  restingHeartRateBpm: 52,
  notes: '睡眠正常',
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
};

describe('daily status form conversion', () => {
  it('fills the form state from an entry and treats a missing entry as empty', () => {
    const state = dailyStatusFormState(ENTRY);
    expect(state.sleepQuality).toBe('1');
    expect(state.fatigueLevel).toBe('5');
    expect(state.muscleSorenessLevel).toBe('');
    expect(state.restingHeartRateBpm).toBe('52');
    expect(state.notes).toBe('睡眠正常');
    expect(dailyStatusFormState(null)).toEqual({
      sleepQuality: '',
      fatigueLevel: '',
      muscleSorenessLevel: '',
      stressLevel: '',
      motivationLevel: '',
      restingHeartRateBpm: '',
      notes: '',
    });
  });

  it('sends every field for a partially filled new record, blanks as null, and passes the shared schema', () => {
    const { upsert, error } = buildDailyStatusUpsert({
      sleepQuality: '1',
      fatigueLevel: '',
      muscleSorenessLevel: '',
      stressLevel: '',
      motivationLevel: '',
      restingHeartRateBpm: '',
      notes: '',
    });
    expect(error).toBeNull();
    expect(upsert).toEqual({
      sleepQuality: 1,
      fatigueLevel: null,
      muscleSorenessLevel: null,
      stressLevel: null,
      motivationLevel: null,
      restingHeartRateBpm: null,
      notes: null,
    });
    // The payload must be accepted by the shared upsert contract unchanged.
    expect(dailyStatusUpsertSchema.parse(upsert)).toEqual(upsert);
  });

  it('accepts the 1 and 5 scale boundaries and converts them to numbers', () => {
    const { upsert, error } = buildDailyStatusUpsert({
      sleepQuality: '1',
      fatigueLevel: '5',
      muscleSorenessLevel: '',
      stressLevel: '',
      motivationLevel: '',
      restingHeartRateBpm: '',
      notes: '',
    });
    expect(error).toBeNull();
    expect(upsert).toMatchObject({ sleepQuality: 1, fatigueLevel: 5 });
  });

  it('rejects out-of-range and decimal scale values', () => {
    for (const value of ['0', '6', '3.5', 'abc']) {
      const { upsert, error } = buildDailyStatusUpsert({
        sleepQuality: value,
        fatigueLevel: '',
        muscleSorenessLevel: '',
        stressLevel: '',
        motivationLevel: '',
        restingHeartRateBpm: '',
        notes: '',
      });
      expect(upsert, value).toBeNull();
      expect(error, value).toMatch(/1–5/);
    }
  });

  it('accepts resting heart rate bounds 30 and 220 and rejects 29, 221, and decimals', () => {
    const min = buildDailyStatusUpsert({
      ...dailyStatusFormState(null),
      restingHeartRateBpm: '30',
    });
    expect(min.upsert).toMatchObject({ restingHeartRateBpm: 30 });
    const max = buildDailyStatusUpsert({
      ...dailyStatusFormState(null),
      restingHeartRateBpm: '220',
    });
    expect(max.upsert).toMatchObject({ restingHeartRateBpm: 220 });
    for (const value of ['29', '221', '30.5', 'abc']) {
      const { upsert, error } = buildDailyStatusUpsert({
        ...dailyStatusFormState(null),
        restingHeartRateBpm: value,
      });
      expect(upsert, value).toBeNull();
      expect(error, value).toMatch(/30–220/);
    }
  });

  it('clears a scale by sending null for the 未填写 selection', () => {
    // A previously filled scale switched back to 未填写 becomes explicit null.
    const { upsert, error } = buildDailyStatusUpsert({
      ...dailyStatusFormState(ENTRY),
      sleepQuality: '',
    });
    expect(error).toBeNull();
    expect(upsert).toMatchObject({
      sleepQuality: null,
      fatigueLevel: 5,
      stressLevel: 3,
      restingHeartRateBpm: 52,
      notes: '睡眠正常',
    });
    expect(dailyStatusUpsertSchema.parse(upsert)).toEqual(upsert);
  });

  it('clears resting heart rate with null when the input is emptied', () => {
    const { upsert, error } = buildDailyStatusUpsert({
      ...dailyStatusFormState(ENTRY),
      restingHeartRateBpm: '   ',
    });
    expect(error).toBeNull();
    expect(upsert).toMatchObject({ restingHeartRateBpm: null, fatigueLevel: 5 });
    expect(dailyStatusUpsertSchema.parse(upsert)).toEqual(upsert);
  });

  it('clears notes with null when they are empty or whitespace-only', () => {
    for (const notes of ['', '   ']) {
      const { upsert, error } = buildDailyStatusUpsert({
        ...dailyStatusFormState(ENTRY),
        notes,
      });
      expect(error, JSON.stringify(notes)).toBeNull();
      expect(upsert, JSON.stringify(notes)).toMatchObject({ notes: null, fatigueLevel: 5 });
      expect(dailyStatusUpsertSchema.parse(upsert)).toEqual(upsert);
    }
  });

  it('sends a meaningful note as-is and the shared schema trims it identically', () => {
    const { upsert, error } = buildDailyStatusUpsert({
      ...dailyStatusFormState(null),
      notes: '  睡眠正常  ',
    });
    expect(error).toBeNull();
    expect(upsert).toMatchObject({ notes: '  睡眠正常  ' });
    expect(dailyStatusUpsertSchema.parse(upsert)).toMatchObject({ notes: '睡眠正常' });
  });

  it('returns upsert null without error for a fully empty form', () => {
    const { upsert, error } = buildDailyStatusUpsert(dailyStatusFormState(null));
    expect(upsert).toBeNull();
    expect(error).toBeNull();
    // A whitespace-only note does not make the form meaningful either.
    const blankNotes = buildDailyStatusUpsert({ ...dailyStatusFormState(null), notes: '   ' });
    expect(blankNotes.upsert).toBeNull();
    expect(blankNotes.error).toBeNull();
  });
});
