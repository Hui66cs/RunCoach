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
  samples: NormalizedSample[];
  provenance: Record<string, SourceType | 'USER'>;
  mergeEvents: ActivityMergeEventView[];
}
