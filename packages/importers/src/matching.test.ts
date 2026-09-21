import { describe, expect, it } from 'vitest';
import type { NormalizedActivity } from '@runcoach/shared';
import { matchActivity } from './matching.js';
import type { ActivityMatchView } from './types.js';

const incoming: NormalizedActivity = {
  sourceType: 'FIT',
  sourceExternalId: null,
  activityType: 'RUN',
  startTimeUtc: '2026-09-18T09:24:55.000Z',
  originalStartTime: '2026-09-18T09:24:55.000Z',
  timezoneOffsetMinutes: 480,
  localDate: '2026-09-18',
  name: null,
  notes: null,
  distanceMeters: 8012,
  durationSeconds: 3055,
  movingDurationSeconds: 3034,
  averageHeartRateBpm: 164,
  maxHeartRateBpm: 191,
  deviceName: null,
  samples: [],
  laps: [],
  rawSummary: {},
};

function candidate(overrides: Partial<ActivityMatchView> = {}): ActivityMatchView {
  return {
    id: '0f697052-bf68-4c15-8306-e74c846e2db7',
    activityType: 'RUN',
    startTimeUtc: '2026-09-18T09:24:55.000Z',
    distanceMeters: 8010,
    durationSeconds: 3054,
    deviceName: null,
    hasFitSource: false,
    version: 1,
    ...overrides,
  };
}

describe('matchActivity', () => {
  it('auto merges one high-confidence candidate', () => {
    const result = matchActivity(incoming, [candidate()]);
    expect(result.decision.kind).toBe('AUTO_MERGE');
  });

  it('requires confirmation for two close candidates', () => {
    const result = matchActivity(incoming, [
      candidate(),
      candidate({ id: 'dd8f3579-8012-48b1-b35d-bb0da7b3567a', distanceMeters: 8050 }),
    ]);
    expect(result.decision.kind).toBe('PENDING_CONFIRMATION');
  });

  it('creates a new activity for a low-confidence candidate', () => {
    const result = matchActivity(incoming, [
      candidate({ startTimeUtc: '2026-09-18T09:54:00.000Z', distanceMeters: 2000 }),
    ]);
    expect(result.decision.kind).toBe('CREATE_NEW');
  });

  it('uses a custom candidate window instead of the default window', () => {
    const result = matchActivity(
      incoming,
      [candidate({ startTimeUtc: '2026-09-18T09:34:55.000Z' })],
      {
        candidateWindowSeconds: 5 * 60,
        autoMergeMinimum: 85,
        pendingMinimum: 65,
        requiredLead: 15,
      },
    );
    expect(result.decision.kind).toBe('CREATE_NEW');
  });
});
