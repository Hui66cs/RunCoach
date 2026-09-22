import { describe, expect, it } from 'vitest';
import type { NormalizedSample } from '@runcoach/shared';
import {
  analyzePauses,
  calculateAerobicDecoupling,
  calculateHeartRateZones,
  calculatePaceStability,
  compareHalves,
  deriveKilometerSplits,
  downsampleSeries,
  paceSecondsPerKilometer,
} from './index.js';

function samples(count: number, distanceStep = 100, secondsStep = 30): NormalizedSample[] {
  return Array.from({ length: count }, (_, index) => ({
    sequence: index,
    timestampUtc: new Date(Date.UTC(2026, 0, 1, 0, 0, index * secondsStep)).toISOString(),
    elapsedSeconds: index * secondsStep,
    distanceMeters: index * distanceStep,
    speedMetersPerSecond: distanceStep / secondsStep,
    heartRateBpm: 130 + Math.floor(index / 10),
    cadenceStepsPerMinute: 170,
  }));
}

describe('activity analytics', () => {
  it('calculates pace and rejects zero or implausibly low speed', () => {
    expect(paceSecondsPerKilometer(4)).toBe(250);
    expect(paceSecondsPerKilometer(0)).toBeNull();
    expect(paceSecondsPerKilometer(0.1)).toBeNull();
  });

  it('interpolates full and partial kilometre splits', () => {
    const result = deriveKilometerSplits(samples(26));
    expect(result.status).toBe('AVAILABLE');
    expect(result.value).toHaveLength(3);
    expect(result.value?.map((split) => split.partial)).toEqual([false, false, true]);
    expect(result.value?.[2]?.distanceMeters).toBe(500);
  });

  it('compares halves and calculates pace stability', () => {
    expect(compareHalves(samples(31)).status).toBe('AVAILABLE');
    const splits = deriveKilometerSplits(samples(31));
    if (splits.value === null) throw new Error('missing splits');
    const stability = calculatePaceStability(splits.value);
    expect(stability.status).toBe('AVAILABLE');
    expect(stability.value?.coefficientOfVariation).toBeCloseTo(0);
  });

  it('accumulates heart-rate zone time from intervals instead of point count', () => {
    const result = calculateHeartRateZones(samples(11), 200);
    expect(result.status).toBe('AVAILABLE');
    expect(result.value?.reduce((sum, zone) => sum + zone.durationSeconds, 0)).toBe(300);
    expect(calculateHeartRateZones(samples(11), null).status).toBe('UNAVAILABLE');
  });

  it('gates decoupling on duration and coverage', () => {
    expect(calculateAerobicDecoupling(samples(20)).status).toBe('UNAVAILABLE');
    expect(calculateAerobicDecoupling(samples(61, 100, 30)).status).toBe('AVAILABLE');
  });

  it('detects conservative pauses', () => {
    const input = samples(5);
    input[2] = { ...input[2]!, distanceMeters: input[1]!.distanceMeters };
    const result = analyzePauses(input);
    expect(result.status).toBe('AVAILABLE');
    expect(result.value?.pauseCount).toBe(1);
  });

  it('preserves endpoints and a local spike while respecting maxPoints', () => {
    const input = samples(200);
    input[100] = { ...input[100]!, heartRateBpm: 220 };
    const result = downsampleSeries(input, 30);
    expect(result).toHaveLength(30);
    expect(result[0]?.sequence).toBe(0);
    expect(result.at(-1)?.sequence).toBe(199);
    expect(result.some((sample) => sample.heartRateBpm === 220)).toBe(true);
  });
});
