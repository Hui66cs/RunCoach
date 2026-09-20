import type { MatchCandidate, MatchDecision, NormalizedActivity } from '@runcoach/shared';
import type { ActivityMatchView, MatchResult, MatchingPolicy } from './types.js';

export const defaultMatchingPolicy: MatchingPolicy = {
  candidateWindowSeconds: 30 * 60,
  autoMergeMinimum: 85,
  pendingMinimum: 65,
  requiredLead: 15,
};

function linearScore(value: number, fullAt: number, zeroAt: number, weight: number): number {
  if (value <= fullAt) return weight;
  if (value >= zeroAt) return 0;
  return weight * (1 - (value - fullAt) / (zeroAt - fullAt));
}

function differenceRatio(left: number | null | undefined, right: number | null): number | null {
  if (left === null || left === undefined || right === null || left === 0 || right === 0) {
    return null;
  }
  return Math.abs(left - right) / Math.max(left, right);
}

function scoreCandidate(
  incoming: NormalizedActivity,
  candidate: ActivityMatchView,
): MatchCandidate | null {
  if (incoming.activityType !== candidate.activityType) return null;

  const timeDifferenceSeconds =
    Math.abs(
      new Date(incoming.startTimeUtc).getTime() - new Date(candidate.startTimeUtc).getTime(),
    ) / 1000;
  if (timeDifferenceSeconds > defaultMatchingPolicy.candidateWindowSeconds) return null;

  const distanceDifferenceRatio = differenceRatio(
    incoming.distanceMeters,
    candidate.distanceMeters,
  );
  const durationDifferenceRatio = differenceRatio(
    incoming.durationSeconds,
    candidate.durationSeconds,
  );
  if (distanceDifferenceRatio === null && durationDifferenceRatio === null) return null;

  const components = {
    time: linearScore(timeDifferenceSeconds, 60, 15 * 60, 40),
    distance:
      distanceDifferenceRatio === null ? 0 : linearScore(distanceDifferenceRatio, 0.01, 0.1, 25),
    duration:
      durationDifferenceRatio === null ? 0 : linearScore(durationDifferenceRatio, 0.01, 0.1, 20),
    type: 10,
    device:
      incoming.deviceName !== null &&
      incoming.deviceName !== undefined &&
      candidate.deviceName !== null &&
      incoming.deviceName === candidate.deviceName
        ? 5
        : 0,
  };
  const score =
    Math.round(
      (components.time +
        components.distance +
        components.duration +
        components.type +
        components.device) *
        100,
    ) / 100;

  return {
    activityId: candidate.id,
    score,
    timeDifferenceSeconds,
    distanceDifferenceRatio,
    durationDifferenceRatio,
    components,
  };
}

export function matchActivity(
  incoming: NormalizedActivity,
  activities: ActivityMatchView[],
  policy: MatchingPolicy = defaultMatchingPolicy,
): MatchResult {
  const candidates = activities
    .map((activity) => ({ activity, score: scoreCandidate(incoming, activity) }))
    .filter(
      (entry): entry is { activity: ActivityMatchView; score: MatchCandidate } =>
        entry.score !== null,
    )
    .sort((left, right) => right.score.score - left.score.score);

  const best = candidates[0];
  if (best === undefined || best.score.score < policy.pendingMinimum) {
    return {
      decision: { kind: 'CREATE_NEW', reason: '没有达到待确认阈值的候选活动' },
      consideredCandidates: candidates.length,
    };
  }

  const second = candidates[1];
  const lead = second === undefined ? 100 : best.score.score - second.score.score;
  if (
    best.score.score >= policy.autoMergeMinimum &&
    lead >= policy.requiredLead &&
    !best.activity.hasFitSource
  ) {
    return {
      decision: { kind: 'AUTO_MERGE', candidate: best.score },
      consideredCandidates: candidates.length,
    };
  }

  const reason = best.activity.hasFitSource
    ? '候选活动已经包含不同的 FIT 来源'
    : lead < policy.requiredLead
      ? '存在分数接近的多个候选活动'
      : '最高分需要用户确认';
  const decision: MatchDecision = {
    kind: 'PENDING_CONFIRMATION',
    candidates: candidates.slice(0, 5).map((entry) => entry.score),
    reason,
  };
  return { decision, consideredCandidates: candidates.length };
}
