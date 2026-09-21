import {
  normalizedActivitySummarySchema,
  type NormalizedActivity,
  type NormalizedActivitySummary,
} from '@runcoach/shared';

export function summarizeActivity(
  activity: NormalizedActivity,
  adapterVersion: string,
): NormalizedActivitySummary {
  return normalizedActivitySummarySchema.parse({
    ...activity,
    schemaVersion: 1,
    adapterVersion,
    sampleCount: activity.samples.length,
    lapCount: activity.laps.length,
  });
}
