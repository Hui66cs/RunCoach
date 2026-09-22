import { z } from 'zod';

export const sourceTypeSchema = z.enum(['USER', 'CSV', 'FIT', 'PARROTAO']);
export type SourceType = z.infer<typeof sourceTypeSchema>;

export const activityTypeSchema = z.enum(['RUN', 'STRENGTH', 'OTHER']);
export type ActivityType = z.infer<typeof activityTypeSchema>;

export const importOutcomeSchema = z.enum([
  'CREATED',
  'REFRESHED',
  'UPGRADED',
  'DUPLICATE_SKIPPED',
  'PENDING_CONFIRMATION',
  'FAILED',
  'SKIPPED',
]);
export type ImportOutcome = z.infer<typeof importOutcomeSchema>;

const optionalFiniteNumber = z.number().finite().nonnegative().nullable().optional();

export const normalizedSampleSchema = z.object({
  sequence: z.number().int().nonnegative(),
  timestampUtc: z.iso.datetime(),
  elapsedSeconds: optionalFiniteNumber,
  distanceMeters: optionalFiniteNumber,
  speedMetersPerSecond: optionalFiniteNumber,
  heartRateBpm: z.number().int().nonnegative().nullable().optional(),
  cadenceStepsPerMinute: optionalFiniteNumber,
  powerWatts: optionalFiniteNumber,
  altitudeMeters: z.number().finite().nullable().optional(),
  latitudeDegrees: z.number().finite().min(-90).max(90).nullable().optional(),
  longitudeDegrees: z.number().finite().min(-180).max(180).nullable().optional(),
});
export type NormalizedSample = z.infer<typeof normalizedSampleSchema>;

export const normalizedLapSchema = z.object({
  sequence: z.number().int().nonnegative(),
  startTimeUtc: z.iso.datetime().nullable().optional(),
  durationSeconds: optionalFiniteNumber,
  distanceMeters: optionalFiniteNumber,
  averageHeartRateBpm: z.number().int().nonnegative().nullable().optional(),
  maxHeartRateBpm: z.number().int().nonnegative().nullable().optional(),
  averageSpeedMetersPerSecond: optionalFiniteNumber,
});
export type NormalizedLap = z.infer<typeof normalizedLapSchema>;

export const normalizedActivitySchema = z.object({
  sourceType: sourceTypeSchema,
  sourceExternalId: z.string().min(1).nullable().optional(),
  sourceIdentityKey: z.string().min(1).nullable().optional(),
  sourceContentSha256: z.string().length(64).nullable().optional(),
  activityType: activityTypeSchema,
  startTimeUtc: z.iso.datetime(),
  originalStartTime: z.string().min(1),
  timezoneOffsetMinutes: z.number().int().min(-840).max(840).nullable(),
  localDate: z.iso.date(),
  name: z.string().trim().min(1).nullable().optional(),
  notes: z.string().nullable().optional(),
  distanceMeters: optionalFiniteNumber,
  durationSeconds: optionalFiniteNumber,
  movingDurationSeconds: optionalFiniteNumber,
  averageHeartRateBpm: z.number().int().nonnegative().nullable().optional(),
  maxHeartRateBpm: z.number().int().nonnegative().nullable().optional(),
  deviceName: z.string().nullable().optional(),
  samples: z.array(normalizedSampleSchema),
  laps: z.array(normalizedLapSchema),
  rawSummary: z.record(z.string(), z.unknown()),
});
export type NormalizedActivity = z.infer<typeof normalizedActivitySchema>;

export const normalizedActivitySummarySchema = normalizedActivitySchema
  .omit({ samples: true, laps: true, rawSummary: true })
  .extend({
    schemaVersion: z.literal(1),
    adapterVersion: z.string().min(1),
    sampleCount: z.number().int().nonnegative(),
    lapCount: z.number().int().nonnegative(),
  });
export type NormalizedActivitySummary = z.infer<typeof normalizedActivitySummarySchema>;

export const matchCandidateSchema = z.object({
  activityId: z.string().uuid(),
  activityVersion: z.number().int().positive(),
  score: z.number().min(0).max(100),
  timeDifferenceSeconds: z.number().nonnegative(),
  distanceDifferenceRatio: z.number().nonnegative().nullable(),
  durationDifferenceRatio: z.number().nonnegative().nullable(),
  components: z.object({
    time: z.number().min(0).max(40),
    distance: z.number().min(0).max(25),
    duration: z.number().min(0).max(20),
    type: z.number().min(0).max(10),
    device: z.number().min(0).max(5),
  }),
});
export type MatchCandidate = z.infer<typeof matchCandidateSchema>;

export const matchDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('AUTO_MERGE'), candidate: matchCandidateSchema }),
  z.object({
    kind: z.literal('PENDING_CONFIRMATION'),
    candidates: z.array(matchCandidateSchema).min(1),
    reason: z.string(),
  }),
  z.object({ kind: z.literal('CREATE_NEW'), reason: z.string() }),
]);
export type MatchDecision = z.infer<typeof matchDecisionSchema>;

export const importItemResultSchema = z.object({
  itemId: z.string().uuid(),
  outcome: importOutcomeSchema,
  activityId: z.string().uuid().nullable(),
  canonicalActivityIdBefore: z.string().uuid().nullable(),
  sourceId: z.string().uuid().nullable(),
  message: z.string(),
  match: matchDecisionSchema.nullable(),
});
export type ImportItemResult = z.infer<typeof importItemResultSchema>;

export const importReportSchema = z.object({
  jobId: z.string().uuid(),
  sourceType: sourceTypeSchema,
  status: z.enum(['RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED']),
  items: z.array(importItemResultSchema),
});
export type ImportReport = z.infer<typeof importReportSchema>;

export const activityPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    notes: z.string().max(10_000).optional(),
  })
  .refine((value) => value.name !== undefined || value.notes !== undefined, {
    message: '至少需要修改名称或备注',
  });
export type ActivityPatch = z.infer<typeof activityPatchSchema>;

export const resolveImportSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('ATTACH'), activityId: z.string().uuid() }),
  z.object({ action: z.literal('CREATE_NEW') }),
  z.object({ action: z.literal('SKIP') }),
]);
export type ResolveImportRequest = z.infer<typeof resolveImportSchema>;

export interface PendingCandidateView extends MatchCandidate {
  activity: ActivityListItem;
}

export interface PendingImportView {
  itemId: string;
  jobId: string;
  importedAt: string;
  originalFileName: string;
  status: string;
  reason: string;
  summary: NormalizedActivitySummary;
  candidates: PendingCandidateView[];
  errorCode: string | null;
  errorMessage: string | null;
}

export interface PendingImportsPage {
  items: PendingImportView[];
  total: number;
  nextCursor: string | null;
}

export interface ResolveImportResult {
  itemId: string;
  status: string;
  outcome: ImportOutcome;
  action: ResolveImportRequest['action'];
  activityId: string | null;
  sourceId: string | null;
  resolvedAt: string;
  idempotent: boolean;
}

export interface ImportHistoryItemView {
  itemId: string;
  outcome: ImportOutcome | null;
  activityId: string | null;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ImportHistoryJobView {
  jobId: string;
  sourceType: SourceType;
  originalFileName: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  requiresAction: boolean;
  counts: Partial<Record<ImportOutcome, number>>;
  items: ImportHistoryItemView[];
}

export interface ImportHistoryPage {
  jobs: ImportHistoryJobView[];
  nextCursor: string | null;
}

export interface ActivityListItem {
  id: string;
  activityType: ActivityType;
  startTimeUtc: string;
  localDate: string;
  name: string | null;
  notes: string | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  movingDurationSeconds: number | null;
  averageHeartRateBpm: number | null;
  maxHeartRateBpm: number | null;
  hasTimeSeries: boolean;
  sourceTypes: SourceType[];
}

export const activityListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  activityType: activityTypeSchema.optional(),
  sourceType: sourceTypeSchema.exclude(['USER']).optional(),
  q: z.string().trim().max(200).optional(),
});
export type ActivityListQuery = z.infer<typeof activityListQuerySchema>;

export interface ActivityListPage {
  items: ActivityListItem[];
  nextCursor: string | null;
  total: number;
}

export interface ActivitySourceView {
  id: string;
  sourceType: SourceType;
  externalId: string | null;
  fileSha256: string | null;
  rawFilePath: string | null;
  createdAt: string;
}

export interface ActivityMergeEventView {
  id: string;
  action: string;
  changedFields: string[];
  createdAt: string;
}

export interface ActivityDetail extends ActivityListItem {
  originalStartTime: string;
  timezoneOffsetMinutes: number | null;
  userEditedName: boolean;
  userEditedNotes: boolean;
  sources: ActivitySourceView[];
  laps: NormalizedLap[];
  provenance: Record<string, SourceType | 'USER'>;
  mergeEvents: ActivityMergeEventView[];
  derivedSummary: DerivedActivitySummary;
  analysis: ActivityAnalysis;
}

export const seriesMetricSchema = z.enum([
  'heartRate',
  'speed',
  'pace',
  'cadence',
  'power',
  'altitude',
  'distance',
  'gps',
]);
export type SeriesMetric = z.infer<typeof seriesMetricSchema>;

export const activitySeriesQuerySchema = z.object({
  metrics: z
    .string()
    .default('heartRate,pace')
    .transform((value, context) => {
      const parsed = [...new Set(value.split(',').filter(Boolean))];
      const result = z.array(seriesMetricSchema).min(1).max(8).safeParse(parsed);
      if (!result.success) {
        context.addIssue({ code: 'custom', message: 'Invalid series metrics' });
        return z.NEVER;
      }
      return result.data;
    }),
  from: z.coerce.number().finite().nonnegative().optional(),
  to: z.coerce.number().finite().positive().optional(),
  maxPoints: z.coerce.number().int().min(10).max(5000).default(1000),
});
export type ActivitySeriesQuery = z.infer<typeof activitySeriesQuerySchema>;

export interface ActivitySeriesPoint {
  sequence: number;
  timestampUtc: string;
  elapsedSeconds: number | null;
  distanceMeters: number | null;
  heartRateBpm?: number | null;
  speedMetersPerSecond?: number | null;
  paceSecondsPerKilometer?: number | null;
  cadenceStepsPerMinute?: number | null;
  powerWatts?: number | null;
  altitudeMeters?: number | null;
  latitudeDegrees?: number | null;
  longitudeDegrees?: number | null;
}

export interface ActivitySeriesResponse {
  activityId: string;
  metrics: SeriesMetric[];
  from: number | null;
  to: number | null;
  totalPoints: number;
  returnedPoints: number;
  points: ActivitySeriesPoint[];
}

export type AnalysisStatus = 'AVAILABLE' | 'UNAVAILABLE';

export interface AnalysisResult<T> {
  status: AnalysisStatus;
  value: T | null;
  reason: string | null;
  dataQuality: Record<string, number | string | boolean | null>;
}

export interface DerivedActivitySummary {
  averageCadenceStepsPerMinute: number | null;
  averagePowerWatts: number | null;
  elevationGainMeters: number | null;
  derivedMovingDurationSeconds: number | null;
}

export interface ActivityAnalysis {
  splits: AnalysisResult<DerivedSplit[]>;
  halfComparison: AnalysisResult<HalfComparisonValue>;
  paceStability: AnalysisResult<PaceStabilityValue>;
  heartRateZones: AnalysisResult<HeartRateZoneValue[]>;
  aerobicDecoupling: AnalysisResult<AerobicDecouplingValue>;
  pauses: AnalysisResult<PauseAnalysisValue>;
}

export interface DerivedSplit {
  sequence: number;
  distanceMeters: number;
  durationSeconds: number;
  paceSecondsPerKilometer: number | null;
  averageHeartRateBpm: number | null;
  partial: boolean;
  source: 'DERIVED_KILOMETER';
}

export interface HalfComparisonValue {
  basis: 'DISTANCE' | 'TIME';
  firstPaceSecondsPerKilometer: number | null;
  secondPaceSecondsPerKilometer: number | null;
  firstAverageHeartRateBpm: number | null;
  secondAverageHeartRateBpm: number | null;
  paceChangePercent: number | null;
}

export interface PaceStabilityValue {
  averagePaceSecondsPerKilometer: number;
  standardDeviationSeconds: number;
  coefficientOfVariation: number;
  conclusion: string;
}

export interface HeartRateZoneValue {
  zone: number;
  minimumBpm: number;
  maximumBpm: number | null;
  durationSeconds: number;
}

export interface AerobicDecouplingValue {
  percent: number;
  firstEfficiency: number;
  secondEfficiency: number;
  direction: 'POSITIVE_DRIFT' | 'NEGATIVE_DRIFT' | 'STABLE';
}

export interface PauseAnalysisValue {
  movingDurationSeconds: number;
  pausedDurationSeconds: number;
  pauseCount: number;
}

export const dashboardPeriodSummarySchema = z.object({
  runs: z.number().int().nonnegative(),
  totalDistanceMeters: z.number().nonnegative(),
  totalMovingDurationSeconds: z.number().nonnegative(),
  averagePaceSecondsPerKilometer: z.number().positive().nullable(),
});
export type DashboardPeriodSummary = z.infer<typeof dashboardPeriodSummarySchema>;

export const dashboardWeeklyVolumeSchema = z.object({
  weekStartLocalDate: z.iso.date(),
  weekEndLocalDate: z.iso.date(),
  runs: z.number().int().nonnegative(),
  totalDistanceMeters: z.number().nonnegative(),
  totalMovingDurationSeconds: z.number().nonnegative(),
});
export type DashboardWeeklyVolume = z.infer<typeof dashboardWeeklyVolumeSchema>;

export const dashboardRecentActivitySchema = z.object({
  id: z.string().uuid(),
  localDate: z.iso.date(),
  name: z.string().nullable(),
  activityType: activityTypeSchema,
  distanceMeters: optionalFiniteNumber,
  durationSeconds: optionalFiniteNumber,
  movingDurationSeconds: optionalFiniteNumber,
});
export type DashboardRecentActivity = z.infer<typeof dashboardRecentActivitySchema>;

export const dashboardResponseSchema = z.object({
  generatedForLocalDate: z.iso.date(),
  timezoneOffsetMinutes: z.number().int().min(-840).max(840),
  last7Days: dashboardPeriodSummarySchema,
  last28Days: dashboardPeriodSummarySchema,
  weeklyVolumes: z.array(dashboardWeeklyVolumeSchema).max(12),
  recentActivities: z.array(dashboardRecentActivitySchema).max(5),
});
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;

export const trendsQuerySchema = z.object({
  weeks: z.coerce
    .number()
    .int()
    .refine((value): value is 12 | 26 | 52 => value === 12 || value === 26 || value === 52, {
      message: 'weeks 仅允许 12、26 或 52',
    })
    .default(12),
});
export type TrendsQuery = z.infer<typeof trendsQuerySchema>;

export const trendsSummarySchema = z.object({
  runs: z.number().int().nonnegative(),
  totalDistanceMeters: z.number().nonnegative(),
  totalMovingDurationSeconds: z.number().nonnegative(),
  averagePaceSecondsPerKilometer: z.number().positive().nullable(),
  averageHeartRateBpm: z.number().positive().nullable(),
});
export type TrendsSummary = z.infer<typeof trendsSummarySchema>;

export const trendsWeeklyPointSchema = z.object({
  weekStartLocalDate: z.iso.date(),
  weekEndLocalDate: z.iso.date(),
  runs: z.number().int().nonnegative(),
  totalDistanceMeters: z.number().nonnegative(),
  totalMovingDurationSeconds: z.number().nonnegative(),
  averagePaceSecondsPerKilometer: z.number().positive().nullable(),
  averageHeartRateBpm: z.number().positive().nullable(),
});
export type TrendsWeeklyPoint = z.infer<typeof trendsWeeklyPointSchema>;

export const trendsResponseSchema = z.object({
  generatedForLocalDate: z.iso.date(),
  timezoneOffsetMinutes: z.number().int().min(-840).max(840),
  weeks: z.union([z.literal(12), z.literal(26), z.literal(52)]),
  summary: trendsSummarySchema,
  weeklyPoints: z.array(trendsWeeklyPointSchema).max(52),
});
export type TrendsResponse = z.infer<typeof trendsResponseSchema>;

export const plannedWorkoutTypeSchema = z.enum([
  'EASY_RUN',
  'LONG_RUN',
  'TEMPO_RUN',
  'INTERVAL_RUN',
  'RECOVERY_RUN',
  'RACE',
  'STRENGTH',
  'REST',
  'OTHER',
]);
export type PlannedWorkoutType = z.infer<typeof plannedWorkoutTypeSchema>;

export const plannedWorkoutCompletionStatusSchema = z.enum(['PLANNED', 'COMPLETED', 'SKIPPED']);
export type PlannedWorkoutCompletionStatus = z.infer<typeof plannedWorkoutCompletionStatusSchema>;

export const plannedWorkoutSchema = z.object({
  id: z.string().uuid(),
  scheduledLocalDate: z.iso.date(),
  workoutType: plannedWorkoutTypeSchema,
  title: z.string().min(1).max(120),
  notes: z.string().max(2000).nullable(),
  targetDistanceMeters: z.number().finite().positive().nullable(),
  targetDurationSeconds: z.number().finite().positive().nullable(),
  completionStatus: plannedWorkoutCompletionStatusSchema,
  linkedActivityId: z.string().uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PlannedWorkout = z.infer<typeof plannedWorkoutSchema>;

/**
 * Completion-only patch. A COMPLETED request must state explicitly whether an
 * activity is linked; PLANNED/SKIPPED always clear the link server-side, so
 * clients cannot submit contradictory combinations.
 */
export const plannedWorkoutCompletionPatchSchema = z.discriminatedUnion('completionStatus', [
  z.strictObject({ completionStatus: z.literal('PLANNED') }),
  z.strictObject({ completionStatus: z.literal('SKIPPED') }),
  z.strictObject({
    completionStatus: z.literal('COMPLETED'),
    linkedActivityId: z.string().uuid().nullable(),
  }),
]);
export type PlannedWorkoutCompletionPatch = z.infer<typeof plannedWorkoutCompletionPatchSchema>;

const targetDistanceMetersSchema = z.number().finite().positive().nullable().optional();
const targetDurationSecondsSchema = z.number().finite().positive().nullable().optional();

export const plannedWorkoutCreateSchema = z.object({
  scheduledLocalDate: z.iso.date(),
  workoutType: plannedWorkoutTypeSchema,
  title: z.string().trim().min(1).max(120),
  notes: z.string().max(2000).nullable().optional(),
  targetDistanceMeters: targetDistanceMetersSchema,
  targetDurationSeconds: targetDurationSecondsSchema,
});
export type PlannedWorkoutCreate = z.infer<typeof plannedWorkoutCreateSchema>;

export const plannedWorkoutPatchSchema = z
  .object({
    scheduledLocalDate: z.iso.date().optional(),
    workoutType: plannedWorkoutTypeSchema.optional(),
    title: z.string().trim().min(1).max(120).optional(),
    notes: z.string().max(2000).nullable().optional(),
    targetDistanceMeters: targetDistanceMetersSchema,
    targetDurationSeconds: targetDurationSecondsSchema,
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: '至少需要修改一个字段',
  });
export type PlannedWorkoutPatch = z.infer<typeof plannedWorkoutPatchSchema>;

/** A calendar range spans at most 93 closed local dates (13 full weeks). */
export const MAX_CALENDAR_DAYS = 93;

export const calendarQuerySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .refine((value) => value.from <= value.to, {
    message: 'from 不能晚于 to',
  })
  .refine(
    (value) =>
      (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000 <=
      MAX_CALENDAR_DAYS - 1,
    { message: `日期范围最多 ${MAX_CALENDAR_DAYS} 天` },
  );
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;

export const calendarActivitySummarySchema = z.object({
  id: z.string().uuid(),
  localDate: z.iso.date(),
  activityType: activityTypeSchema,
  name: z.string().nullable(),
  distanceMeters: optionalFiniteNumber,
  durationSeconds: optionalFiniteNumber,
  movingDurationSeconds: optionalFiniteNumber,
});
export type CalendarActivitySummary = z.infer<typeof calendarActivitySummarySchema>;

/**
 * Calendar projection of a planned workout. `linkedActivity` is a bounded
 * summary of the linked real activity — returned even when that activity's
 * own date falls outside the queried calendar range, because the plan is in
 * range.
 */
export const calendarPlannedWorkoutSchema = plannedWorkoutSchema.extend({
  linkedActivity: calendarActivitySummarySchema.nullable(),
});
export type CalendarPlannedWorkout = z.infer<typeof calendarPlannedWorkoutSchema>;

export const calendarResponseSchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  plannedWorkouts: z.array(calendarPlannedWorkoutSchema),
  activities: z.array(calendarActivitySummarySchema),
});
export type CalendarResponse = z.infer<typeof calendarResponseSchema>;

export const trainingSummaryQuerySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .refine((value) => value.from <= value.to, {
    message: 'from 不能晚于 to',
  })
  .refine(
    (value) =>
      (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000 <=
      MAX_CALENDAR_DAYS - 1,
    { message: `日期范围最多 ${MAX_CALENDAR_DAYS} 天` },
  );
export type TrainingSummaryQuery = z.infer<typeof trainingSummaryQuerySchema>;

const trainingSummaryCountsSchema = z.object({
  plannedCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
  linkedCompletedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  overdueCount: z.number().int().nonnegative(),
  upcomingCount: z.number().int().nonnegative(),
  eligibleCount: z.number().int().nonnegative(),
  adherenceRate: z.number().min(0).max(1).nullable(),
});
export type TrainingSummaryCounts = z.infer<typeof trainingSummaryCountsSchema>;

export const trainingSummaryWeeklyRollupSchema = trainingSummaryCountsSchema.extend({
  weekStartLocalDate: z.iso.date(),
  weekEndLocalDate: z.iso.date(),
});
export type TrainingSummaryWeeklyRollup = z.infer<typeof trainingSummaryWeeklyRollupSchema>;

export const trainingSummaryResponseSchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  generatedForLocalDate: z.iso.date(),
  timezoneOffsetMinutes: z.number().int().min(-840).max(840),
  summary: trainingSummaryCountsSchema,
  weeklyRollups: z.array(trainingSummaryWeeklyRollupSchema).max(15),
});
export type TrainingSummaryResponse = z.infer<typeof trainingSummaryResponseSchema>;

export const experienceLevelSchema = z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']);
export type ExperienceLevel = z.infer<typeof experienceLevelSchema>;

export const athleteSettingsPatchSchema = z
  .object({
    maxHeartRateBpm: z.number().int().min(100).max(240).nullable().optional(),
    restingHeartRateBpm: z.number().int().min(30).max(120).nullable().optional(),
    thresholdHeartRateBpm: z.number().int().min(80).max(230).nullable().optional(),
    heartRateZoneMethod: z.literal('MAX_HR_PERCENT').optional(),
    distanceUnit: z.literal('METRIC').optional(),
    timezoneOffsetMinutes: z.number().int().min(-840).max(840).optional(),
    // Athlete profile (M5): null clears a field; trimmed empty strings are
    // rejected so an empty value never reaches the database.
    displayName: z.string().trim().min(1).max(80).nullable().optional(),
    experienceLevel: experienceLevelSchema.nullable().optional(),
    primaryGoal: z.string().trim().min(1).max(200).nullable().optional(),
    weeklyDistanceTargetMeters: z.number().int().positive().max(1_000_000).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one setting is required',
  });
export type AthleteSettingsPatch = z.infer<typeof athleteSettingsPatchSchema>;

export interface AthleteSettings {
  maxHeartRateBpm: number | null;
  restingHeartRateBpm: number | null;
  thresholdHeartRateBpm: number | null;
  heartRateZoneMethod: 'MAX_HR_PERCENT';
  distanceUnit: 'METRIC';
  timezoneOffsetMinutes: number;
  displayName: string | null;
  experienceLevel: ExperienceLevel | null;
  primaryGoal: string | null;
  weeklyDistanceTargetMeters: number | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Daily status (M5): one self-reported entry per athlete local date. Purely
// user-editable observations — no derived readiness/recovery score, training
// advice, or medical judgement exists anywhere in this contract.
// ---------------------------------------------------------------------------

/** Shared 1–5 self-report scale; null means "not filled in". */
export const dailyStatusScaleSchema = z.number().int().min(1).max(5).nullable();

/**
 * Daily-status notes: non-empty strings are trimmed; a string that is empty
 * after trimming is normalized to null (clearing the field) so a blank value
 * is never stored as "". Explicit null clears; absent keeps the old value.
 */
export const dailyStatusNotesSchema = z
  .string()
  .trim()
  .max(2000)
  .transform((value) => (value.length === 0 ? null : value))
  .nullable()
  .optional();

export const dailyStatusEntrySchema = z.object({
  id: z.string().uuid(),
  localDate: z.iso.date(),
  sleepQuality: dailyStatusScaleSchema,
  fatigueLevel: dailyStatusScaleSchema,
  muscleSorenessLevel: dailyStatusScaleSchema,
  stressLevel: dailyStatusScaleSchema,
  motivationLevel: dailyStatusScaleSchema,
  restingHeartRateBpm: z.number().int().min(30).max(220).nullable(),
  notes: z.string().max(2000).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DailyStatusEntry = z.infer<typeof dailyStatusEntrySchema>;

/**
 * Upsert body for one local date (the date itself comes from the URL path).
 * Absent fields keep their stored value; explicit nulls clear a field. At
 * least one editable field is required; unknown fields are rejected.
 */
export const dailyStatusUpsertSchema = z
  .strictObject({
    sleepQuality: dailyStatusScaleSchema.optional(),
    fatigueLevel: dailyStatusScaleSchema.optional(),
    muscleSorenessLevel: dailyStatusScaleSchema.optional(),
    stressLevel: dailyStatusScaleSchema.optional(),
    motivationLevel: dailyStatusScaleSchema.optional(),
    restingHeartRateBpm: z.number().int().min(30).max(220).nullable().optional(),
    notes: dailyStatusNotesSchema,
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: '至少需要提供一个每日状态字段',
  });
export type DailyStatusUpsert = z.infer<typeof dailyStatusUpsertSchema>;

export const dailyStatusRangeQuerySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .refine((value) => value.from <= value.to, {
    message: 'from 不能晚于 to',
  })
  .refine(
    (value) =>
      (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000 <=
      MAX_CALENDAR_DAYS - 1,
    { message: `日期范围最多 ${MAX_CALENDAR_DAYS} 天` },
  );
export type DailyStatusRangeQuery = z.infer<typeof dailyStatusRangeQuerySchema>;

export const dailyStatusRangeResponseSchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  items: z.array(dailyStatusEntrySchema),
});
export type DailyStatusRangeResponse = z.infer<typeof dailyStatusRangeResponseSchema>;
