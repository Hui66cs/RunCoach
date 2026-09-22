import type {
  AerobicDecouplingValue,
  AnalysisResult,
  DerivedSplit,
  HalfComparisonValue,
  HeartRateZoneValue,
  NormalizedSample,
  PaceStabilityValue,
  PauseAnalysisValue,
  SeriesMetric,
} from '@runcoach/shared';

export const ANALYSIS_THRESHOLDS = {
  minimumPaceSpeedMetersPerSecond: 0.2,
  movingSpeedMetersPerSecond: 0.5,
  pauseDistanceMeters: 5,
  maximumSampleGapSeconds: 120,
  minimumDecouplingDurationSeconds: 20 * 60,
  minimumDecouplingCoverage: 0.7,
  stableDecouplingPercent: 2,
} as const;

const unavailable = <T>(
  reason: string,
  dataQuality: Record<string, number | string | boolean | null> = {},
): AnalysisResult<T> => ({
  status: 'UNAVAILABLE',
  value: null,
  reason,
  dataQuality,
});

const available = <T>(
  value: T,
  dataQuality: Record<string, number | string | boolean | null> = {},
): AnalysisResult<T> => ({
  status: 'AVAILABLE',
  value,
  reason: null,
  dataQuality,
});

export function paceSecondsPerKilometer(
  speedMetersPerSecond: number | null | undefined,
): number | null {
  return speedMetersPerSecond !== null &&
    speedMetersPerSecond !== undefined &&
    Number.isFinite(speedMetersPerSecond) &&
    speedMetersPerSecond >= ANALYSIS_THRESHOLDS.minimumPaceSpeedMetersPerSecond
    ? 1000 / speedMetersPerSecond
    : null;
}

function elapsed(sample: NormalizedSample): number | null {
  if (sample.elapsedSeconds !== null && sample.elapsedSeconds !== undefined)
    return sample.elapsedSeconds;
  const milliseconds = Date.parse(sample.timestampUtc);
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : null;
}

function interpolateTime(samples: NormalizedSample[], distance: number): number | null {
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous === undefined || current === undefined) continue;
    const d0 = previous.distanceMeters;
    const d1 = current.distanceMeters;
    const t0 = elapsed(previous);
    const t1 = elapsed(current);
    if (d0 == null || d1 == null || t0 == null || t1 == null || d1 <= d0) continue;
    if (distance < d0 || distance > d1) continue;
    return t0 + ((distance - d0) / (d1 - d0)) * (t1 - t0);
  }
  return null;
}

export function deriveKilometerSplits(samples: NormalizedSample[]): AnalysisResult<DerivedSplit[]> {
  const usable = samples
    .filter((sample) => sample.distanceMeters != null && elapsed(sample) != null)
    .sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0));
  const first = usable[0];
  const last = usable.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    (last.distanceMeters ?? 0) <= (first.distanceMeters ?? 0)
  )
    return unavailable('缺少可用的累计距离和时间数据');
  const startDistance = first.distanceMeters ?? 0;
  const totalDistance = (last.distanceMeters ?? 0) - startDistance;
  const splitCount = Math.ceil(totalDistance / 1000);
  const splits: DerivedSplit[] = [];
  for (let index = 0; index < splitCount; index += 1) {
    const fromDistance = startDistance + index * 1000;
    const toDistance = Math.min(startDistance + (index + 1) * 1000, last.distanceMeters ?? 0);
    const startTime = index === 0 ? elapsed(first) : interpolateTime(usable, fromDistance);
    const endTime =
      interpolateTime(usable, toDistance) ??
      (toDistance === last.distanceMeters ? elapsed(last) : null);
    if (startTime == null || endTime == null || endTime <= startTime) continue;
    const heartRates = usable
      .filter(
        (sample) =>
          (sample.distanceMeters ?? -1) >= fromDistance &&
          (sample.distanceMeters ?? Infinity) <= toDistance,
      )
      .map((sample) => sample.heartRateBpm)
      .filter((value): value is number => value != null && value > 0);
    const distanceMeters = toDistance - fromDistance;
    const durationSeconds = endTime - startTime;
    splits.push({
      sequence: index,
      distanceMeters,
      durationSeconds,
      paceSecondsPerKilometer:
        distanceMeters > 0 ? (durationSeconds / distanceMeters) * 1000 : null,
      averageHeartRateBpm:
        heartRates.length > 0
          ? heartRates.reduce((sum, value) => sum + value, 0) / heartRates.length
          : null,
      partial: distanceMeters < 999.5,
      source: 'DERIVED_KILOMETER',
    });
  }
  return splits.length > 0
    ? available(splits, { usableSamples: usable.length, totalDistanceMeters: totalDistance })
    : unavailable('无法插值得到有效分段', { usableSamples: usable.length });
}

interface Segment {
  duration: number;
  distance: number;
  heartRate: number | null;
  endDistance: number | null;
  endTime: number;
}

function segments(
  samples: NormalizedSample[],
  maximumGapSeconds: number = ANALYSIS_THRESHOLDS.maximumSampleGapSeconds,
): Segment[] {
  const result: Segment[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const a = samples[index - 1];
    const b = samples[index];
    if (a === undefined || b === undefined) continue;
    const ta = elapsed(a);
    const tb = elapsed(b);
    if (ta == null || tb == null) continue;
    const duration = tb - ta;
    if (duration <= 0 || duration > maximumGapSeconds) continue;
    const distance =
      a.distanceMeters != null && b.distanceMeters != null
        ? Math.max(0, b.distanceMeters - a.distanceMeters)
        : 0;
    result.push({
      duration,
      distance,
      heartRate: b.heartRateBpm ?? null,
      endDistance: b.distanceMeters ?? null,
      endTime: tb,
    });
  }
  return result;
}

function halfMetrics(items: Segment[]): { pace: number | null; heartRate: number | null } {
  const duration = items.reduce((sum, item) => sum + item.duration, 0);
  const distance = items.reduce((sum, item) => sum + item.distance, 0);
  const hrItems = items.filter((item) => item.heartRate != null && item.heartRate > 0);
  const hrDuration = hrItems.reduce((sum, item) => sum + item.duration, 0);
  return {
    pace: distance > 0 ? (duration / distance) * 1000 : null,
    heartRate:
      hrDuration > 0
        ? hrItems.reduce((sum, item) => sum + (item.heartRate ?? 0) * item.duration, 0) / hrDuration
        : null,
  };
}

export function compareHalves(samples: NormalizedSample[]): AnalysisResult<HalfComparisonValue> {
  const items = segments(samples);
  if (items.length < 2) return unavailable('有效时序区间不足');
  const totalDistance = items.reduce((sum, item) => sum + item.distance, 0);
  const totalDuration = items.reduce((sum, item) => sum + item.duration, 0);
  const basis = totalDistance >= 1000 ? 'DISTANCE' : 'TIME';
  const midpoint = basis === 'DISTANCE' ? totalDistance / 2 : totalDuration / 2;
  let accumulated = 0;
  const first: Segment[] = [];
  const second: Segment[] = [];
  for (const item of items) {
    accumulated += basis === 'DISTANCE' ? item.distance : item.duration;
    (accumulated <= midpoint ? first : second).push(item);
  }
  if (first.length === 0 || second.length === 0) return unavailable('无法形成有效的前后半程');
  const a = halfMetrics(first);
  const b = halfMetrics(second);
  return available(
    {
      basis,
      firstPaceSecondsPerKilometer: a.pace,
      secondPaceSecondsPerKilometer: b.pace,
      firstAverageHeartRateBpm: a.heartRate,
      secondAverageHeartRateBpm: b.heartRate,
      paceChangePercent:
        a.pace != null && b.pace != null ? ((b.pace - a.pace) / a.pace) * 100 : null,
    },
    {
      validSegments: items.length,
      totalDistanceMeters: totalDistance,
      totalDurationSeconds: totalDuration,
    },
  );
}

export function calculatePaceStability(splits: DerivedSplit[]): AnalysisResult<PaceStabilityValue> {
  const values = splits
    .filter((split) => !split.partial && split.paceSecondsPerKilometer != null)
    .map((split) => split.paceSecondsPerKilometer as number);
  if (values.length < 2)
    return unavailable('至少需要两个有效完整公里分段', { validFullSplits: values.length });
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  const standardDeviation = Math.sqrt(variance);
  const coefficient = standardDeviation / average;
  const conclusion =
    coefficient <= 0.03 ? '配速非常稳定' : coefficient <= 0.06 ? '配速较稳定' : '配速波动较明显';
  return available(
    {
      averagePaceSecondsPerKilometer: average,
      standardDeviationSeconds: standardDeviation,
      coefficientOfVariation: coefficient,
      conclusion,
    },
    { validFullSplits: values.length },
  );
}

export function calculateHeartRateZones(
  samples: NormalizedSample[],
  maxHeartRateBpm: number | null,
): AnalysisResult<HeartRateZoneValue[]> {
  if (maxHeartRateBpm == null) return unavailable('请先在设置中填写最大心率');
  const bounds = [0, 0.6, 0.7, 0.8, 0.9, Infinity];
  const durations = [0, 0, 0, 0, 0];
  let covered = 0;
  for (const item of segments(samples, 15 * 60)) {
    if (item.heartRate == null || item.heartRate <= 0 || item.heartRate > maxHeartRateBpm * 1.1)
      continue;
    const ratio = item.heartRate / maxHeartRateBpm;
    const zone = Math.max(0, bounds.findIndex((bound, index) => index > 0 && ratio < bound) - 1);
    durations[Math.min(4, zone)] = (durations[Math.min(4, zone)] ?? 0) + item.duration;
    covered += item.duration;
  }
  if (covered <= 0) return unavailable('没有有效的心率时间区间');
  return available(
    durations.map((durationSeconds, index) => ({
      zone: index + 1,
      minimumBpm: Math.round(maxHeartRateBpm * bounds[index]!),
      maximumBpm: index === 4 ? null : Math.round(maxHeartRateBpm * bounds[index + 1]!) - 1,
      durationSeconds,
    })),
    { coveredSeconds: covered, method: 'MAX_HR_PERCENT' },
  );
}

export function calculateAerobicDecoupling(
  samples: NormalizedSample[],
): AnalysisResult<AerobicDecouplingValue> {
  const items = segments(samples);
  const totalDuration = items.reduce((sum, item) => sum + item.duration, 0);
  if (totalDuration < ANALYSIS_THRESHOLDS.minimumDecouplingDurationSeconds)
    return unavailable('活动时长不足 20 分钟', { totalDurationSeconds: totalDuration });
  const paired = items.filter(
    (item) =>
      item.heartRate != null &&
      item.heartRate > 40 &&
      item.distance / item.duration >= ANALYSIS_THRESHOLDS.minimumPaceSpeedMetersPerSecond,
  );
  const covered = paired.reduce((sum, item) => sum + item.duration, 0);
  const coverage = covered / totalDuration;
  if (coverage < ANALYSIS_THRESHOLDS.minimumDecouplingCoverage)
    return unavailable('有效速度与心率配对覆盖率不足', { coverage });
  let accumulated = 0;
  const first: Segment[] = [];
  const second: Segment[] = [];
  for (const item of paired) {
    accumulated += item.duration;
    (accumulated <= covered / 2 ? first : second).push(item);
  }
  const efficiency = (part: Segment[]): number => {
    const duration = part.reduce((sum, item) => sum + item.duration, 0);
    const speed = part.reduce((sum, item) => sum + item.distance, 0) / duration;
    const heartRate =
      part.reduce((sum, item) => sum + (item.heartRate ?? 0) * item.duration, 0) / duration;
    return speed / heartRate;
  };
  const firstEfficiency = efficiency(first);
  const secondEfficiency = efficiency(second);
  const percent = ((firstEfficiency - secondEfficiency) / firstEfficiency) * 100;
  return available(
    {
      percent,
      firstEfficiency,
      secondEfficiency,
      direction:
        Math.abs(percent) <= ANALYSIS_THRESHOLDS.stableDecouplingPercent
          ? 'STABLE'
          : percent > 0
            ? 'POSITIVE_DRIFT'
            : 'NEGATIVE_DRIFT',
    },
    { coverage, pairedSeconds: covered },
  );
}

export function analyzePauses(samples: NormalizedSample[]): AnalysisResult<PauseAnalysisValue> {
  const items = segments(samples);
  if (items.length === 0) return unavailable('缺少连续时间数据');
  let pausedDurationSeconds = 0;
  let movingDurationSeconds = 0;
  let pauseCount = 0;
  let wasPaused = false;
  for (const item of items) {
    const paused =
      item.distance < ANALYSIS_THRESHOLDS.pauseDistanceMeters &&
      item.distance / item.duration < ANALYSIS_THRESHOLDS.movingSpeedMetersPerSecond;
    if (paused) {
      pausedDurationSeconds += item.duration;
      if (!wasPaused) pauseCount += 1;
    } else movingDurationSeconds += item.duration;
    wasPaused = paused;
  }
  return available(
    { movingDurationSeconds, pausedDurationSeconds, pauseCount },
    { validSegments: items.length },
  );
}

type DownsampleField = Extract<
  keyof NormalizedSample,
  | 'heartRateBpm'
  | 'speedMetersPerSecond'
  | 'cadenceStepsPerMinute'
  | 'powerWatts'
  | 'altitudeMeters'
  | 'distanceMeters'
  | 'latitudeDegrees'
  | 'longitudeDegrees'
>;

const downsampleAllFields: DownsampleField[] = [
  'heartRateBpm',
  'speedMetersPerSecond',
  'cadenceStepsPerMinute',
  'powerWatts',
  'altitudeMeters',
  'distanceMeters',
];

const downsampleMetricFields: Record<SeriesMetric, readonly DownsampleField[]> = {
  heartRate: ['heartRateBpm'],
  speed: ['speedMetersPerSecond'],
  pace: ['speedMetersPerSecond'],
  cadence: ['cadenceStepsPerMinute'],
  power: ['powerWatts'],
  altitude: ['altitudeMeters'],
  distance: ['distanceMeters'],
  gps: ['latitudeDegrees', 'longitudeDegrees'],
};

function resolveDownsampleFields(metrics: readonly SeriesMetric[] | undefined): DownsampleField[] {
  if (metrics === undefined) return [...downsampleAllFields];
  const fields = new Set<DownsampleField>();
  for (const metric of metrics) {
    for (const field of downsampleMetricFields[metric]) fields.add(field);
  }
  return fields.size > 0 ? [...fields] : [...downsampleAllFields];
}

/**
 * Deterministic, bounded, extrema-preserving downsampling.
 *
 * Endpoints are always retained. The interior is split into buckets and, for
 * every requested metric field independently, the bucket minimum and maximum
 * samples are retained. A metric may map to several fields: `gps` selects on
 * `latitudeDegrees` and `longitudeDegrees` separately, so a route turn that is
 * a latitude or longitude extremum is kept. Fields are never compared against
 * each other, so a high-magnitude field such as cumulative distance cannot
 * suppress a heart-rate, power, or speed spike in another requested metric.
 * Every field gets an equal share of the `maxPoints` budget, so the result
 * stays within `maxPoints` without a trimming pass in normal cases. Ties keep
 * the earliest index, keeping the output deterministic.
 */
export function downsampleSeries(
  samples: NormalizedSample[],
  maxPoints = 1000,
  metrics?: readonly SeriesMetric[],
): NormalizedSample[] {
  if (samples.length <= maxPoints) return [...samples];
  if (maxPoints <= 2) return [samples[0]!, samples.at(-1)!].slice(0, maxPoints);
  const fields = resolveDownsampleFields(metrics);
  const bucketCount = Math.max(1, Math.floor((maxPoints - 2) / (2 * fields.length)));
  const selected = new Set<number>([0, samples.length - 1]);
  const bucketSize = (samples.length - 2) / bucketCount;
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = 1 + Math.floor(bucket * bucketSize);
    const end = Math.min(samples.length - 1, 1 + Math.floor((bucket + 1) * bucketSize));
    for (const field of fields) {
      let minIndex = -1;
      let maxIndex = -1;
      let minValue = Infinity;
      let maxValue = -Infinity;
      for (let index = start; index < end; index += 1) {
        const value = samples[index]![field];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        if (value < minValue) {
          minValue = value;
          minIndex = index;
        }
        if (value > maxValue) {
          maxValue = value;
          maxIndex = index;
        }
      }
      if (minIndex !== -1) selected.add(minIndex);
      if (maxIndex !== -1) selected.add(maxIndex);
    }
  }
  const indexes = [...selected].sort((a, b) => a - b);
  if (indexes.length <= maxPoints) return indexes.map((index) => samples[index]!);
  const keep = new Set<number>([indexes[0]!, indexes.at(-1)!]);
  const step = (indexes.length - 2) / (maxPoints - 2);
  for (let index = 0; index < maxPoints - 2; index += 1)
    keep.add(indexes[1 + Math.floor(index * step)]!);
  return [...keep].sort((a, b) => a - b).map((index) => samples[index]!);
}

export function deriveSummary(samples: NormalizedSample[]): {
  averageCadenceStepsPerMinute: number | null;
  averagePowerWatts: number | null;
  elevationGainMeters: number | null;
  derivedMovingDurationSeconds: number | null;
} {
  const average = (values: Array<number | null | undefined>): number | null => {
    const valid = values.filter(
      (value): value is number => value != null && Number.isFinite(value) && value > 0,
    );
    return valid.length > 0 ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
  };
  let gain = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]?.altitudeMeters;
    const current = samples[index]?.altitudeMeters;
    if (previous != null && current != null && current > previous) gain += current - previous;
  }
  const pauses = analyzePauses(samples);
  return {
    averageCadenceStepsPerMinute: average(samples.map((sample) => sample.cadenceStepsPerMinute)),
    averagePowerWatts: average(samples.map((sample) => sample.powerWatts)),
    elevationGainMeters: samples.some((sample) => sample.altitudeMeters != null) ? gain : null,
    derivedMovingDurationSeconds:
      pauses.status === 'AVAILABLE' && pauses.value !== null
        ? pauses.value.movingDurationSeconds
        : null,
  };
}
