import type { ActivityType, MatchDecision, NormalizedActivity, SourceType } from '@runcoach/shared';

export interface SourceAdapter<TInput> {
  readonly sourceType: SourceType;
  decode(input: TInput): Promise<NormalizedActivity[]>;
}

export interface ActivityMatchView {
  id: string;
  activityType: ActivityType;
  startTimeUtc: string;
  distanceMeters: number | null;
  durationSeconds: number | null;
  deviceName: string | null;
  hasFitSource: boolean;
}

export interface MatchingPolicy {
  candidateWindowSeconds: number;
  autoMergeMinimum: number;
  pendingMinimum: number;
  requiredLead: number;
}

export interface MatchResult {
  decision: MatchDecision;
  consideredCandidates: number;
}
