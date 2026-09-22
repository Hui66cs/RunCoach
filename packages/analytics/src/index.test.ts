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
    const result = downsampleSeries(input, 30, ['heartRate']);
    expect(result).toHaveLength(30);
    expect(result[0]?.sequence).toBe(0);
    expect(result.at(-1)?.sequence).toBe(199);
    expect(result.some((sample) => sample.heartRateBpm === 220)).toBe(true);
  });

  it('keeps a heart-rate spike placed inside a bucket, away from bucket boundaries', () => {
    const input = samples(200);
    for (const sample of input) sample.powerWatts = 3000;
    input[101] = { ...input[101]!, heartRateBpm: 220 };
    const result = downsampleSeries(input, 30, ['heartRate']);
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result.some((sample) => sample.heartRateBpm === 220)).toBe(true);
    expect(result[0]?.sequence).toBe(0);
    expect(result.at(-1)?.sequence).toBe(199);
  });

  it('keeps a heart-rate valley placed inside a bucket', () => {
    const input = samples(200);
    input[101] = { ...input[101]!, heartRateBpm: 60 };
    const result = downsampleSeries(input, 30, ['heartRate']);
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result.some((sample) => sample.heartRateBpm === 60)).toBe(true);
  });

  it('keeps isolated power spikes and speed valleys for their own requested metrics', () => {
    const input = samples(200);
    input[50] = { ...input[50]!, powerWatts: 900 };
    input[65] = { ...input[65]!, speedMetersPerSecond: 0.4 };
    const power = downsampleSeries(input, 30, ['power']);
    expect(power.length).toBeLessThanOrEqual(30);
    expect(power.some((sample) => sample.powerWatts === 900)).toBe(true);
    const speed = downsampleSeries(input, 30, ['speed']);
    expect(speed.length).toBeLessThanOrEqual(30);
    expect(speed.some((sample) => sample.speedMetersPerSecond === 0.4)).toBe(true);
  });

  it('is deterministic, ordered, and bounded across repeated calls', () => {
    const input = samples(500);
    input[137] = { ...input[137]!, heartRateBpm: 210 };
    input[251] = { ...input[251]!, powerWatts: 800 };
    const first = downsampleSeries(input, 40, ['heartRate', 'power']);
    const second = downsampleSeries(input, 40, ['heartRate', 'power']);
    expect(first).toEqual(second);
    expect(first.length).toBeLessThanOrEqual(40);
    expect(first[0]?.sequence).toBe(0);
    expect(first.at(-1)?.sequence).toBe(499);
    const sequences = first.map((sample) => sample.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    expect(first.some((sample) => sample.heartRateBpm === 210)).toBe(true);
    expect(first.some((sample) => sample.powerWatts === 800)).toBe(true);
  });

  it('keeps the default no-metrics path bounded with endpoints and per-field extrema', () => {
    const input = samples(200);
    input[101] = { ...input[101]!, heartRateBpm: 220 };
    const result = downsampleSeries(input, 30);
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result[0]?.sequence).toBe(0);
    expect(result.at(-1)?.sequence).toBe(199);
    expect(result.some((sample) => sample.heartRateBpm === 220)).toBe(true);
  });

  it('keeps GPS-only interior route turns instead of collapsing to endpoints', () => {
    const input: NormalizedSample[] = Array.from({ length: 2000 }, (_, index) => ({
      sequence: index,
      timestampUtc: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
      elapsedSeconds: index,
      latitudeDegrees: 30 + Math.min(index, 1999 - index) * 0.0001,
      longitudeDegrees: 120 + index * 0.0001,
    }));
    const peakLatitude = Math.max(...input.map((sample) => sample.latitudeDegrees!));
    const first = downsampleSeries(input, 1000, ['gps']);
    const second = downsampleSeries(input, 1000, ['gps']);
    expect(first).toEqual(second);
    expect(first.length).toBeLessThanOrEqual(1000);
    expect(first.length).toBeGreaterThan(2);
    expect(first[0]?.sequence).toBe(0);
    expect(first.at(-1)?.sequence).toBe(1999);
    const sequences = first.map((sample) => sample.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    expect(first.some((sample) => sample.latitudeDegrees === peakLatitude)).toBe(true);
    expect(first.every((sample) => sample.longitudeDegrees != null)).toBe(true);
  });

  it('keeps GPS turns and heart-rate spikes together when both metrics are requested', () => {
    const input: NormalizedSample[] = Array.from({ length: 500 }, (_, index) => ({
      sequence: index,
      timestampUtc: new Date(Date.UTC(2026, 0, 3, 0, 0, index)).toISOString(),
      elapsedSeconds: index,
      latitudeDegrees: 30 + Math.min(index, 499 - index) * 0.0001,
      longitudeDegrees: 120 + index * 0.0001,
      heartRateBpm: index === 137 ? 200 : 150,
    }));
    const peakLatitude = Math.max(...input.map((sample) => sample.latitudeDegrees!));
    const result = downsampleSeries(input, 100, ['gps', 'heartRate']);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.length).toBeGreaterThan(2);
    expect(result[0]?.sequence).toBe(0);
    expect(result.at(-1)?.sequence).toBe(499);
    expect(result.some((sample) => sample.latitudeDegrees === peakLatitude)).toBe(true);
    expect(result.some((sample) => sample.heartRateBpm === 200)).toBe(true);
  });
});
