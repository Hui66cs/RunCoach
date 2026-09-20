import type { NormalizedSample } from '@runcoach/shared';

export function downsampleSeries(
  samples: NormalizedSample[],
  maxPoints = 1_000,
): NormalizedSample[] {
  if (samples.length <= maxPoints) return samples;
  const step = samples.length / maxPoints;
  const result: NormalizedSample[] = [];
  for (let index = 0; index < maxPoints; index += 1) {
    const sample = samples[Math.floor(index * step)];
    if (sample !== undefined) result.push(sample);
  }
  const last = samples.at(-1);
  if (last !== undefined && result.at(-1)?.sequence !== last.sequence) result.push(last);
  return result;
}
