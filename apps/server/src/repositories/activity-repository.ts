import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, like, lt, lte, or, sql } from 'drizzle-orm';
import type {
  ActivityListPage,
  ActivityListQuery,
  ActivityDetail,
  ActivityListItem,
  ActivityPatch,
  ActivitySeriesQuery,
  ActivitySeriesResponse,
  AthleteSettings,
  AthleteSettingsPatch,
  DashboardPeriodSummary,
  DashboardResponse,
  DashboardWeeklyVolume,
  ImportOutcome,
  ImportHistoryPage,
  MatchDecision,
  NormalizedActivity,
  NormalizedActivitySummary,
  PendingImportsPage,
  ResolveImportRequest,
  ResolveImportResult,
  SourceType,
  TrendsQuery,
  TrendsResponse,
  TrendsWeeklyPoint,
  CalendarQuery,
  CalendarResponse,
  PlannedWorkout,
  PlannedWorkoutCreate,
  PlannedWorkoutPatch,
} from '@runcoach/shared';
import {
  importOutcomeSchema,
  matchDecisionSchema,
  normalizedActivitySummarySchema,
} from '@runcoach/shared';
import { summarizeActivity, type ActivityMatchView } from '@runcoach/importers';
import {
  analyzePauses,
  calculateAerobicDecoupling,
  calculateHeartRateZones,
  calculatePaceStability,
  compareHalves,
  deriveKilometerSplits,
  deriveSummary,
  downsampleSeries,
  paceSecondsPerKilometer,
} from '@runcoach/analytics';
import type { RunCoachDatabase } from '../db/client.js';
import {
  eachLocalDate,
  lastDaysWindow,
  localDateFromUtcTime,
  weeklyWindows,
  type LocalDateWindow,
} from '../dashboard-dates.js';
import {
  activities,
  activityFieldProvenance,
  activityLaps,
  activityMergeEvents,
  activitySamples,
  activitySources,
  athleteSettings,
  importItems,
  importJobs,
  plannedWorkouts,
  rawFiles,
} from '../db/schema.js';
import type { StoredRawFile } from '../storage/raw-file-store.js';

export interface ApplySourceInput {
  normalized: NormalizedActivity;
  rawFileId: string;
  fileSha256: string;
  rawPayload: Record<string, unknown>;
  importItemId: string;
}

export class RepositoryConflictError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface PendingResolutionInput {
  itemId: string;
  request: ResolveImportRequest;
  normalized: NormalizedActivity | null;
  rawFileId: string;
  fileSha256: string;
  legacyMatch?: MatchDecision;
}

export interface ApplySourceResult {
  activityId: string;
  sourceId: string;
}

export interface MergeHooks {
  afterSeriesInserted?: () => void;
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): [string, string] | null {
  if (cursor === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((value) => typeof value === 'string')
      ? [parsed[0] as string, parsed[1] as string]
      : null;
  } catch {
    return null;
  }
}

function parseStoredMatch(
  raw: string | null,
  activityVersions: ReadonlyMap<string, number>,
): MatchDecision | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    const current = matchDecisionSchema.safeParse(value);
    if (current.success) return current.data;
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    const candidates = record['candidates'];
    if (record['kind'] !== 'PENDING_CONFIRMATION' || !Array.isArray(candidates)) return null;
    const upgraded = {
      ...record,
      candidates: candidates.map((candidate: unknown) => {
        if (typeof candidate !== 'object' || candidate === null || !('activityId' in candidate))
          return candidate;
        const activityId = candidate.activityId;
        return typeof activityId === 'string' && activityVersions.has(activityId)
          ? { ...candidate, activityVersion: activityVersions.get(activityId) }
          : candidate;
      }),
    };
    const legacy = matchDecisionSchema.safeParse(upgraded);
    return legacy.success ? legacy.data : null;
  } catch {
    return null;
  }
}

const provenanceFields = [
  'activityType',
  'startTimeUtc',
  'name',
  'notes',
  'distanceMeters',
  'durationSeconds',
  'movingDurationSeconds',
  'averageHeartRateBpm',
  'maxHeartRateBpm',
  'deviceName',
] as const;

const sourcePriority: Record<SourceType | 'USER', number> = {
  CSV: 100,
  PARROTAO: 200,
  FIT: 300,
  USER: 400,
};

function now(): string {
  return new Date().toISOString();
}

function adapterVersion(activity: NormalizedActivity): string {
  return activity.sourceType === 'FIT' ? 'garmin-fit-sdk:21' : 'supplied-csv:v1';
}

function summaryPayload(activity: NormalizedActivity): string {
  return JSON.stringify(summarizeActivity(activity, adapterVersion(activity)));
}

function compactSnapshot(activity: typeof activities.$inferSelect): Record<string, unknown> {
  return {
    id: activity.id,
    activityType: activity.activityType,
    startTimeUtc: activity.startTimeUtc,
    name: activity.name,
    notes: activity.notes,
    distanceMeters: activity.distanceMeters,
    durationSeconds: activity.durationSeconds,
    movingDurationSeconds: activity.movingDurationSeconds,
    averageHeartRateBpm: activity.averageHeartRateBpm,
    maxHeartRateBpm: activity.maxHeartRateBpm,
    hasTimeSeries: activity.hasTimeSeries,
    version: activity.version,
  };
}

function fieldHasValue(
  activity: NormalizedActivity,
  field: (typeof provenanceFields)[number],
): boolean {
  return activity[field] !== null && activity[field] !== undefined;
}

function snapshotRecord(serialized: string | null): Record<string, unknown> {
  if (serialized === null) return {};
  const parsed: unknown = JSON.parse(serialized);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function changedFields(before: string | null, after: string): string[] {
  const beforeRecord = snapshotRecord(before);
  const afterRecord = snapshotRecord(after);
  return [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].filter(
    (key) => JSON.stringify(beforeRecord[key]) !== JSON.stringify(afterRecord[key]),
  );
}

export class ActivityRepository {
  constructor(private readonly db: RunCoachDatabase) {}

  ensureRawFile(file: StoredRawFile): string {
    const existing = this.db.select().from(rawFiles).where(eq(rawFiles.sha256, file.sha256)).get();
    if (existing !== undefined) return existing.id;
    this.db
      .insert(rawFiles)
      .values({ ...file, createdAt: now() })
      .run();
    return file.id;
  }

  createImportJob(sourceType: SourceType, originalFileName: string, rawFileId: string): string {
    const id = randomUUID();
    this.db
      .insert(importJobs)
      .values({
        id,
        sourceType,
        status: 'RUNNING',
        originalFileName,
        rawFileId,
        createdAt: now(),
      })
      .run();
    return id;
  }

  createImportItem(jobId: string, rowNumber?: number): string {
    const id = randomUUID();
    this.db
      .insert(importItems)
      .values({
        id,
        importJobId: jobId,
        rowNumber: rowNumber ?? null,
        status: 'PROCESSING',
        createdAt: now(),
      })
      .run();
    return id;
  }

  completeImportItem(
    itemId: string,
    outcome: ImportOutcome,
    values: {
      activityId?: string | null;
      sourceId?: string | null;
      matchScore?: number | null;
      matchDetails?: unknown;
      normalizedPayload?: NormalizedActivitySummary | null;
      errorMessage?: string | null;
      errorCode?: string | null;
    } = {},
  ): void {
    this.db
      .update(importItems)
      .set({
        status: outcome === 'PENDING_CONFIRMATION' ? 'PENDING' : 'COMPLETED',
        outcome,
        activityId: values.activityId ?? null,
        sourceId: values.sourceId ?? null,
        matchScore: values.matchScore ?? null,
        matchDetails:
          values.matchDetails === undefined ? null : JSON.stringify(values.matchDetails),
        normalizedPayload:
          values.normalizedPayload === undefined || values.normalizedPayload === null
            ? null
            : JSON.stringify(values.normalizedPayload),
        errorMessage: values.errorMessage ?? null,
        errorCode: values.errorCode ?? null,
        completedAt: outcome === 'PENDING_CONFIRMATION' ? null : now(),
      })
      .where(eq(importItems.id, itemId))
      .run();
  }

  completeImportJob(jobId: string, hasErrors: boolean): void {
    this.db
      .update(importJobs)
      .set({
        status: hasErrors ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
        completedAt: now(),
      })
      .where(eq(importJobs.id, jobId))
      .run();
  }

  findActiveFitByHash(fileSha256: string): typeof activitySources.$inferSelect | undefined {
    return this.db
      .select()
      .from(activitySources)
      .where(
        and(
          eq(activitySources.sourceType, 'FIT'),
          eq(activitySources.fileSha256, fileSha256),
          eq(activitySources.active, true),
        ),
      )
      .get();
  }

  findSourceByExternalIdentity(
    sourceType: SourceType,
    externalId: string,
  ): typeof activitySources.$inferSelect | undefined {
    return this.db
      .select()
      .from(activitySources)
      .where(
        and(eq(activitySources.sourceType, sourceType), eq(activitySources.externalId, externalId)),
      )
      .get();
  }

  findActiveSourceByIdentity(
    sourceType: SourceType,
    identityKey: string,
  ): typeof activitySources.$inferSelect | undefined {
    return this.db
      .select()
      .from(activitySources)
      .where(
        and(
          eq(activitySources.sourceType, sourceType),
          eq(activitySources.identityKey, identityKey),
          eq(activitySources.active, true),
        ),
      )
      .get();
  }

  adoptLegacyCsvIdentity(
    normalized: NormalizedActivity,
  ): typeof activitySources.$inferSelect | undefined {
    if (normalized.sourceIdentityKey === null || normalized.sourceIdentityKey === undefined)
      return undefined;
    const candidates = this.db
      .select({ source: activitySources })
      .from(activitySources)
      .innerJoin(activities, eq(activitySources.activityId, activities.id))
      .where(
        and(
          eq(activitySources.sourceType, 'CSV'),
          eq(activitySources.active, true),
          eq(activities.activityType, normalized.activityType),
          eq(activities.startTimeUtc, normalized.startTimeUtc),
        ),
      )
      .all();
    if (candidates.length !== 1) return undefined;
    const source = candidates[0]?.source;
    if (source === undefined) return undefined;
    this.db
      .update(activitySources)
      .set({ identityKey: normalized.sourceIdentityKey })
      .where(eq(activitySources.id, source.id))
      .run();
    return { ...source, identityKey: normalized.sourceIdentityKey };
  }

  getMatchViews(): ActivityMatchView[] {
    const rows = this.db.select().from(activities).all();
    const fitActivityIds = new Set(
      this.db
        .select({ activityId: activitySources.activityId })
        .from(activitySources)
        .where(and(eq(activitySources.sourceType, 'FIT'), eq(activitySources.active, true)))
        .all()
        .map((source) => source.activityId),
    );
    return rows.map((activity) => ({
      id: activity.id,
      activityType: activity.activityType as ActivityMatchView['activityType'],
      startTimeUtc: activity.startTimeUtc,
      distanceMeters: activity.distanceMeters,
      durationSeconds: activity.durationSeconds,
      deviceName: activity.deviceName,
      hasFitSource: fitActivityIds.has(activity.id),
      version: activity.version,
    }));
  }

  createActivityFromSource(input: ApplySourceInput): ApplySourceResult {
    return this.db.transaction((tx) => {
      const timestamp = now();
      const activityId = randomUUID();
      const sourceId = randomUUID();
      const normalized = input.normalized;
      tx.insert(activities)
        .values({
          id: activityId,
          activityType: normalized.activityType,
          startTimeUtc: normalized.startTimeUtc,
          originalStartTime: normalized.originalStartTime,
          timezoneOffsetMinutes: normalized.timezoneOffsetMinutes,
          localDate: normalized.localDate,
          name: normalized.name ?? null,
          notes: normalized.notes ?? null,
          distanceMeters: normalized.distanceMeters ?? null,
          durationSeconds: normalized.durationSeconds ?? null,
          movingDurationSeconds: normalized.movingDurationSeconds ?? null,
          averageHeartRateBpm: normalized.averageHeartRateBpm ?? null,
          maxHeartRateBpm: normalized.maxHeartRateBpm ?? null,
          deviceName: normalized.deviceName ?? null,
          hasTimeSeries: normalized.samples.length > 0,
          primaryTimeSeriesSourceId: normalized.samples.length > 0 ? sourceId : null,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      tx.insert(activitySources)
        .values({
          id: sourceId,
          activityId,
          sourceType: normalized.sourceType,
          externalId: normalized.sourceExternalId ?? null,
          identityKey: normalized.sourceIdentityKey ?? null,
          contentSha256: normalized.sourceContentSha256 ?? null,
          fileSha256: normalized.sourceType === 'FIT' ? input.fileSha256 : null,
          rawFileId: input.rawFileId,
          rawPayload: JSON.stringify(input.rawPayload),
          normalizedPayload: summaryPayload(normalized),
          createdAt: timestamp,
        })
        .run();
      this.insertSeries(tx, activityId, sourceId, normalized);
      for (const field of provenanceFields) {
        if (!fieldHasValue(normalized, field)) continue;
        tx.insert(activityFieldProvenance)
          .values({
            activityId,
            fieldName: field,
            originType: normalized.sourceType,
            sourceId,
            updatedAt: timestamp,
          })
          .run();
      }
      const created = tx.select().from(activities).where(eq(activities.id, activityId)).get();
      if (created === undefined) throw new Error('创建活动后无法读取记录');
      tx.insert(activityMergeEvents)
        .values({
          id: randomUUID(),
          activityId,
          importItemId: input.importItemId,
          action: 'CREATE',
          sourceId,
          beforeSnapshot: null,
          afterSnapshot: JSON.stringify(compactSnapshot(created)),
          createdAt: timestamp,
        })
        .run();
      return { activityId, sourceId };
    });
  }

  mergeSourceIntoActivity(
    activityId: string,
    input: ApplySourceInput,
    hooks: MergeHooks = {},
  ): ApplySourceResult {
    return this.db.transaction((tx) => {
      const before = tx.select().from(activities).where(eq(activities.id, activityId)).get();
      if (before === undefined) throw new Error('待升级活动不存在');
      const timestamp = now();
      const sourceId = randomUUID();
      const normalized = input.normalized;
      tx.insert(activitySources)
        .values({
          id: sourceId,
          activityId,
          sourceType: normalized.sourceType,
          externalId: normalized.sourceExternalId ?? null,
          identityKey: normalized.sourceIdentityKey ?? null,
          contentSha256: normalized.sourceContentSha256 ?? null,
          fileSha256: normalized.sourceType === 'FIT' ? input.fileSha256 : null,
          rawFileId: input.rawFileId,
          rawPayload: JSON.stringify(input.rawPayload),
          normalizedPayload: summaryPayload(normalized),
          createdAt: timestamp,
        })
        .run();
      this.insertSeries(tx, activityId, sourceId, normalized);
      hooks.afterSeriesInserted?.();

      const currentProvenance = new Map(
        tx
          .select()
          .from(activityFieldProvenance)
          .where(eq(activityFieldProvenance.activityId, activityId))
          .all()
          .map((row) => [row.fieldName, row.originType as SourceType | 'USER']),
      );
      const canReplace = (field: (typeof provenanceFields)[number]): boolean => {
        const current = currentProvenance.get(field);
        return (
          current === undefined || sourcePriority[normalized.sourceType] >= sourcePriority[current]
        );
      };

      const updates = {
        activityType: canReplace('activityType') ? normalized.activityType : before.activityType,
        startTimeUtc: canReplace('startTimeUtc') ? normalized.startTimeUtc : before.startTimeUtc,
        originalStartTime: canReplace('startTimeUtc')
          ? normalized.originalStartTime
          : before.originalStartTime,
        timezoneOffsetMinutes: canReplace('startTimeUtc')
          ? normalized.timezoneOffsetMinutes
          : before.timezoneOffsetMinutes,
        localDate: canReplace('startTimeUtc') ? normalized.localDate : before.localDate,
        name:
          before.userEditedName ||
          !canReplace('name') ||
          normalized.name === null ||
          normalized.name === undefined
            ? before.name
            : normalized.name,
        notes:
          before.userEditedNotes ||
          !canReplace('notes') ||
          normalized.notes === null ||
          normalized.notes === undefined
            ? before.notes
            : normalized.notes,
        distanceMeters: canReplace('distanceMeters')
          ? (normalized.distanceMeters ?? before.distanceMeters)
          : before.distanceMeters,
        durationSeconds: canReplace('durationSeconds')
          ? (normalized.durationSeconds ?? before.durationSeconds)
          : before.durationSeconds,
        movingDurationSeconds: canReplace('movingDurationSeconds')
          ? (normalized.movingDurationSeconds ?? before.movingDurationSeconds)
          : before.movingDurationSeconds,
        averageHeartRateBpm: canReplace('averageHeartRateBpm')
          ? (normalized.averageHeartRateBpm ?? before.averageHeartRateBpm)
          : before.averageHeartRateBpm,
        maxHeartRateBpm: canReplace('maxHeartRateBpm')
          ? (normalized.maxHeartRateBpm ?? before.maxHeartRateBpm)
          : before.maxHeartRateBpm,
        deviceName: canReplace('deviceName')
          ? (normalized.deviceName ?? before.deviceName)
          : before.deviceName,
        hasTimeSeries: before.hasTimeSeries || normalized.samples.length > 0,
        primaryTimeSeriesSourceId:
          normalized.samples.length > 0 ? sourceId : before.primaryTimeSeriesSourceId,
        version: before.version + 1,
        updatedAt: timestamp,
      };
      tx.update(activities).set(updates).where(eq(activities.id, activityId)).run();

      for (const field of provenanceFields) {
        if (!fieldHasValue(normalized, field)) continue;
        if (!canReplace(field)) continue;
        if (field === 'name' && before.userEditedName) continue;
        if (field === 'notes' && before.userEditedNotes) continue;
        tx.insert(activityFieldProvenance)
          .values({
            activityId,
            fieldName: field,
            originType: normalized.sourceType,
            sourceId,
            updatedAt: timestamp,
          })
          .onConflictDoUpdate({
            target: [activityFieldProvenance.activityId, activityFieldProvenance.fieldName],
            set: { originType: normalized.sourceType, sourceId, updatedAt: timestamp },
          })
          .run();
      }
      const after = tx.select().from(activities).where(eq(activities.id, activityId)).get();
      if (after === undefined) throw new Error('升级活动后无法读取记录');
      tx.insert(activityMergeEvents)
        .values({
          id: randomUUID(),
          activityId,
          importItemId: input.importItemId,
          action: 'UPGRADE',
          sourceId,
          beforeSnapshot: JSON.stringify(compactSnapshot(before)),
          afterSnapshot: JSON.stringify(compactSnapshot(after)),
          createdAt: timestamp,
        })
        .run();
      return { activityId, sourceId };
    });
  }

  refreshCsvSource(existingSourceId: string, input: ApplySourceInput): ApplySourceResult {
    return this.db.transaction((tx) => {
      const existingSource = tx
        .select()
        .from(activitySources)
        .where(
          and(
            eq(activitySources.id, existingSourceId),
            eq(activitySources.sourceType, 'CSV'),
            eq(activitySources.active, true),
          ),
        )
        .get();
      if (existingSource === undefined) {
        throw new RepositoryConflictError('CSV_SOURCE_STALE', 'CSV source is no longer active');
      }
      const before = tx
        .select()
        .from(activities)
        .where(eq(activities.id, existingSource.activityId))
        .get();
      if (before === undefined) throw new Error('CSV activity does not exist');
      const timestamp = now();
      const sourceId = randomUUID();
      tx.update(activitySources)
        .set({ active: false })
        .where(and(eq(activitySources.id, existingSourceId), eq(activitySources.active, true)))
        .run();
      tx.insert(activitySources)
        .values({
          id: sourceId,
          activityId: before.id,
          sourceType: 'CSV',
          externalId: input.normalized.sourceExternalId ?? null,
          identityKey: input.normalized.sourceIdentityKey ?? null,
          contentSha256: input.normalized.sourceContentSha256 ?? null,
          fileSha256: null,
          rawFileId: input.rawFileId,
          rawPayload: JSON.stringify(input.rawPayload),
          normalizedPayload: summaryPayload(input.normalized),
          createdAt: timestamp,
        })
        .run();

      const provenanceRows = tx
        .select()
        .from(activityFieldProvenance)
        .where(eq(activityFieldProvenance.activityId, before.id))
        .all();
      const provenance = new Map(provenanceRows.map((row) => [row.fieldName, row.originType]));
      const updates: Record<string, unknown> = {};
      for (const field of provenanceFields) {
        const value = input.normalized[field];
        if (value === null || value === undefined) continue;
        const currentOrigin = provenance.get(field);
        if (currentOrigin !== undefined && currentOrigin !== 'CSV') continue;
        updates[field] = value;
        tx.insert(activityFieldProvenance)
          .values({
            activityId: before.id,
            fieldName: field,
            originType: 'CSV',
            sourceId,
            updatedAt: timestamp,
          })
          .onConflictDoUpdate({
            target: [activityFieldProvenance.activityId, activityFieldProvenance.fieldName],
            set: { originType: 'CSV', sourceId, updatedAt: timestamp },
          })
          .run();
      }
      tx.update(activities)
        .set({ ...updates, version: before.version + 1, updatedAt: timestamp })
        .where(eq(activities.id, before.id))
        .run();
      const after = tx.select().from(activities).where(eq(activities.id, before.id)).get();
      if (after === undefined) throw new Error('CSV refresh could not read activity');
      tx.insert(activityMergeEvents)
        .values({
          id: randomUUID(),
          activityId: before.id,
          importItemId: input.importItemId,
          action: 'CSV_REFRESH',
          sourceId,
          beforeSnapshot: JSON.stringify(compactSnapshot(before)),
          afterSnapshot: JSON.stringify(compactSnapshot(after)),
          createdAt: timestamp,
        })
        .run();
      return { activityId: before.id, sourceId };
    });
  }

  private insertSeries(
    tx: Parameters<Parameters<RunCoachDatabase['transaction']>[0]>[0],
    activityId: string,
    sourceId: string,
    normalized: NormalizedActivity,
  ): void {
    if (normalized.samples.length > 0) {
      const sampleRows = normalized.samples.map((sample) => ({
        activityId,
        sourceId,
        sequence: sample.sequence,
        timestampUtc: sample.timestampUtc,
        elapsedSeconds: sample.elapsedSeconds ?? null,
        distanceMeters: sample.distanceMeters ?? null,
        speedMetersPerSecond: sample.speedMetersPerSecond ?? null,
        heartRateBpm: sample.heartRateBpm ?? null,
        cadenceStepsPerMinute: sample.cadenceStepsPerMinute ?? null,
        powerWatts: sample.powerWatts ?? null,
        altitudeMeters: sample.altitudeMeters ?? null,
        latitudeDegrees: sample.latitudeDegrees ?? null,
        longitudeDegrees: sample.longitudeDegrees ?? null,
      }));
      const batchSize = 500;
      for (let offset = 0; offset < sampleRows.length; offset += batchSize) {
        tx.insert(activitySamples)
          .values(sampleRows.slice(offset, offset + batchSize))
          .run();
      }
    }
    if (normalized.laps.length > 0) {
      tx.insert(activityLaps)
        .values(
          normalized.laps.map((lap) => ({
            activityId,
            sourceId,
            sequence: lap.sequence,
            startTimeUtc: lap.startTimeUtc ?? null,
            durationSeconds: lap.durationSeconds ?? null,
            distanceMeters: lap.distanceMeters ?? null,
            averageHeartRateBpm: lap.averageHeartRateBpm ?? null,
            maxHeartRateBpm: lap.maxHeartRateBpm ?? null,
            averageSpeedMetersPerSecond: lap.averageSpeedMetersPerSecond ?? null,
          })),
        )
        .run();
    }
  }

  updateUserFields(activityId: string, patch: ActivityPatch): void {
    this.db.transaction((tx) => {
      const current = tx.select().from(activities).where(eq(activities.id, activityId)).get();
      if (current === undefined) throw new Error('活动不存在');
      const timestamp = now();
      tx.update(activities)
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name, userEditedName: true }),
          ...(patch.notes === undefined ? {} : { notes: patch.notes, userEditedNotes: true }),
          version: current.version + 1,
          updatedAt: timestamp,
        })
        .where(eq(activities.id, activityId))
        .run();
      for (const field of ['name', 'notes'] as const) {
        if (patch[field] === undefined) continue;
        tx.insert(activityFieldProvenance)
          .values({
            activityId,
            fieldName: field,
            originType: 'USER',
            sourceId: null,
            updatedAt: timestamp,
          })
          .onConflictDoUpdate({
            target: [activityFieldProvenance.activityId, activityFieldProvenance.fieldName],
            set: { originType: 'USER', sourceId: null, updatedAt: timestamp },
          })
          .run();
      }
    });
  }

  listActivities(): ActivityListItem[] {
    const rows = this.db.select().from(activities).orderBy(desc(activities.startTimeUtc)).all();
    const sources = this.db
      .select({ activityId: activitySources.activityId, sourceType: activitySources.sourceType })
      .from(activitySources)
      .where(eq(activitySources.active, true))
      .all();
    const byActivity = new Map<string, SourceType[]>();
    for (const source of sources) {
      const values = byActivity.get(source.activityId) ?? [];
      values.push(source.sourceType as SourceType);
      byActivity.set(source.activityId, values);
    }
    return rows.map((activity) => ({
      id: activity.id,
      activityType: activity.activityType as ActivityListItem['activityType'],
      startTimeUtc: activity.startTimeUtc,
      localDate: activity.localDate,
      name: activity.name,
      notes: activity.notes,
      distanceMeters: activity.distanceMeters,
      durationSeconds: activity.durationSeconds,
      movingDurationSeconds: activity.movingDurationSeconds,
      averageHeartRateBpm: activity.averageHeartRateBpm,
      maxHeartRateBpm: activity.maxHeartRateBpm,
      hasTimeSeries: activity.hasTimeSeries,
      sourceTypes: [...new Set(byActivity.get(activity.id) ?? [])],
    }));
  }

  listActivitiesPage(query: ActivityListQuery): ActivityListPage {
    const cursor = decodeCursor(query.cursor);
    if (query.cursor !== undefined && cursor === null)
      throw new RepositoryConflictError('INVALID_CURSOR', 'Invalid pagination cursor');
    if (query.dateFrom !== undefined && query.dateTo !== undefined && query.dateFrom > query.dateTo)
      throw new RepositoryConflictError('INVALID_DATE_RANGE', 'dateFrom must not exceed dateTo');
    const filters = [
      query.dateFrom === undefined ? undefined : gte(activities.localDate, query.dateFrom),
      query.dateTo === undefined ? undefined : lte(activities.localDate, query.dateTo),
      query.activityType === undefined
        ? undefined
        : eq(activities.activityType, query.activityType),
      query.q === undefined || query.q === '' ? undefined : like(activities.name, `%${query.q}%`),
      query.sourceType === undefined
        ? undefined
        : sql`exists (select 1 from activity_sources s where s.activity_id = ${activities.id} and s.active = 1 and s.source_type = ${query.sourceType})`,
      cursor === null
        ? undefined
        : or(
            lt(activities.startTimeUtc, cursor[0]),
            and(eq(activities.startTimeUtc, cursor[0]), lt(activities.id, cursor[1])),
          ),
    ].filter((value) => value !== undefined);
    const where = filters.length === 0 ? undefined : and(...filters);
    const rows = this.db
      .select()
      .from(activities)
      .where(where)
      .orderBy(desc(activities.startTimeUtc), desc(activities.id))
      .limit(query.limit + 1)
      .all();
    const pageRows = rows.slice(0, query.limit);
    const ids = pageRows.map((row) => row.id);
    const sourceRows =
      ids.length === 0
        ? []
        : this.db
            .select({
              activityId: activitySources.activityId,
              sourceType: activitySources.sourceType,
            })
            .from(activitySources)
            .where(and(inArray(activitySources.activityId, ids), eq(activitySources.active, true)))
            .all();
    const sourceTypes = new Map<string, SourceType[]>();
    for (const row of sourceRows) {
      const values = sourceTypes.get(row.activityId) ?? [];
      values.push(row.sourceType as SourceType);
      sourceTypes.set(row.activityId, values);
    }
    const countFilters = filters.slice(0, cursor === null ? filters.length : filters.length - 1);
    const total = this.db
      .select({ count: sql<number>`count(*)` })
      .from(activities)
      .where(countFilters.length === 0 ? undefined : and(...countFilters))
      .get();
    const items = pageRows.map((activity) => ({
      id: activity.id,
      activityType: activity.activityType as ActivityListItem['activityType'],
      startTimeUtc: activity.startTimeUtc,
      localDate: activity.localDate,
      name: activity.name,
      notes: activity.notes,
      distanceMeters: activity.distanceMeters,
      durationSeconds: activity.durationSeconds,
      movingDurationSeconds: activity.movingDurationSeconds,
      averageHeartRateBpm: activity.averageHeartRateBpm,
      maxHeartRateBpm: activity.maxHeartRateBpm,
      hasTimeSeries: activity.hasTimeSeries,
      sourceTypes: [...new Set(sourceTypes.get(activity.id) ?? [])],
    }));
    const last = pageRows.at(-1);
    return {
      items,
      total: Number(total?.count ?? 0),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor(last.startTimeUtc, last.id)
          : null,
    };
  }

  getActivity(activityId: string): ActivityDetail | null {
    const activity = this.db.select().from(activities).where(eq(activities.id, activityId)).get();
    if (activity === undefined) return null;
    const sources = this.db
      .select()
      .from(activitySources)
      .where(and(eq(activitySources.activityId, activityId), eq(activitySources.active, true)))
      .orderBy(asc(activitySources.createdAt))
      .all();
    const laps = this.db
      .select()
      .from(activityLaps)
      .where(eq(activityLaps.activityId, activityId))
      .orderBy(asc(activityLaps.sequence))
      .all();
    const samples = this.db
      .select()
      .from(activitySamples)
      .where(eq(activitySamples.activityId, activityId))
      .orderBy(asc(activitySamples.sequence))
      .all();
    const normalizedSamples = samples.map((sample) => ({
      sequence: sample.sequence,
      timestampUtc: sample.timestampUtc,
      elapsedSeconds: sample.elapsedSeconds,
      distanceMeters: sample.distanceMeters,
      speedMetersPerSecond: sample.speedMetersPerSecond,
      heartRateBpm: sample.heartRateBpm,
      cadenceStepsPerMinute: sample.cadenceStepsPerMinute,
      powerWatts: sample.powerWatts,
      altitudeMeters: sample.altitudeMeters,
      latitudeDegrees: sample.latitudeDegrees,
      longitudeDegrees: sample.longitudeDegrees,
    }));
    const settings = this.getAthleteSettings();
    const splits = deriveKilometerSplits(normalizedSamples);
    const provenanceRows = this.db
      .select()
      .from(activityFieldProvenance)
      .where(eq(activityFieldProvenance.activityId, activityId))
      .all();
    const mergeEventRows = this.db
      .select()
      .from(activityMergeEvents)
      .where(eq(activityMergeEvents.activityId, activityId))
      .orderBy(desc(activityMergeEvents.createdAt))
      .all();
    const provenance = Object.fromEntries(
      provenanceRows.map((row) => [row.fieldName, row.originType as SourceType | 'USER']),
    );
    return {
      id: activity.id,
      activityType: activity.activityType as ActivityDetail['activityType'],
      startTimeUtc: activity.startTimeUtc,
      originalStartTime: activity.originalStartTime,
      timezoneOffsetMinutes: activity.timezoneOffsetMinutes,
      localDate: activity.localDate,
      name: activity.name,
      notes: activity.notes,
      userEditedName: activity.userEditedName,
      userEditedNotes: activity.userEditedNotes,
      distanceMeters: activity.distanceMeters,
      durationSeconds: activity.durationSeconds,
      movingDurationSeconds: activity.movingDurationSeconds,
      averageHeartRateBpm: activity.averageHeartRateBpm,
      maxHeartRateBpm: activity.maxHeartRateBpm,
      hasTimeSeries: activity.hasTimeSeries,
      sourceTypes: [...new Set(sources.map((source) => source.sourceType as SourceType))],
      sources: sources.map((source) => ({
        id: source.id,
        sourceType: source.sourceType as SourceType,
        externalId: source.externalId,
        fileSha256: source.fileSha256,
        rawFilePath:
          source.rawFileId === null
            ? null
            : (this.db.select().from(rawFiles).where(eq(rawFiles.id, source.rawFileId)).get()
                ?.relativePath ?? null),
        createdAt: source.createdAt,
      })),
      laps: laps.map((lap) => ({
        sequence: lap.sequence,
        startTimeUtc: lap.startTimeUtc,
        durationSeconds: lap.durationSeconds,
        distanceMeters: lap.distanceMeters,
        averageHeartRateBpm: lap.averageHeartRateBpm,
        maxHeartRateBpm: lap.maxHeartRateBpm,
        averageSpeedMetersPerSecond: lap.averageSpeedMetersPerSecond,
      })),
      provenance,
      mergeEvents: mergeEventRows.map((event) => ({
        id: event.id,
        action: event.action,
        changedFields: changedFields(event.beforeSnapshot, event.afterSnapshot),
        createdAt: event.createdAt,
      })),
      derivedSummary: deriveSummary(normalizedSamples),
      analysis: {
        splits,
        halfComparison: compareHalves(normalizedSamples),
        paceStability:
          splits.value === null
            ? {
                status: 'UNAVAILABLE',
                value: null,
                reason: splits.reason,
                dataQuality: splits.dataQuality,
              }
            : calculatePaceStability(splits.value),
        heartRateZones: calculateHeartRateZones(normalizedSamples, settings.maxHeartRateBpm),
        aerobicDecoupling: calculateAerobicDecoupling(normalizedSamples),
        pauses: analyzePauses(normalizedSamples),
      },
    };
  }

  getActivitySeries(activityId: string, query: ActivitySeriesQuery): ActivitySeriesResponse | null {
    const activity = this.db
      .select({ id: activities.id })
      .from(activities)
      .where(eq(activities.id, activityId))
      .get();
    if (activity === undefined) return null;
    if (query.from !== undefined && query.to !== undefined && query.from >= query.to)
      throw new RepositoryConflictError('INVALID_SERIES_RANGE', 'from must be less than to');
    const filters = [
      eq(activitySamples.activityId, activityId),
      query.from === undefined ? undefined : gte(activitySamples.elapsedSeconds, query.from),
      query.to === undefined ? undefined : lte(activitySamples.elapsedSeconds, query.to),
    ].filter((value) => value !== undefined);
    const rows = this.db
      .select()
      .from(activitySamples)
      .where(and(...filters))
      .orderBy(asc(activitySamples.sequence))
      .all();
    const normalized = rows.map((sample) => ({
      sequence: sample.sequence,
      timestampUtc: sample.timestampUtc,
      elapsedSeconds: sample.elapsedSeconds,
      distanceMeters: sample.distanceMeters,
      speedMetersPerSecond: sample.speedMetersPerSecond,
      heartRateBpm: sample.heartRateBpm,
      cadenceStepsPerMinute: sample.cadenceStepsPerMinute,
      powerWatts: sample.powerWatts,
      altitudeMeters: sample.altitudeMeters,
      latitudeDegrees: sample.latitudeDegrees,
      longitudeDegrees: sample.longitudeDegrees,
    }));
    const points = downsampleSeries(normalized, query.maxPoints, query.metrics).map((sample) => ({
      sequence: sample.sequence,
      timestampUtc: sample.timestampUtc,
      elapsedSeconds: sample.elapsedSeconds ?? null,
      distanceMeters: sample.distanceMeters ?? null,
      ...(query.metrics.includes('heartRate') ? { heartRateBpm: sample.heartRateBpm ?? null } : {}),
      ...(query.metrics.includes('speed')
        ? { speedMetersPerSecond: sample.speedMetersPerSecond ?? null }
        : {}),
      ...(query.metrics.includes('pace')
        ? { paceSecondsPerKilometer: paceSecondsPerKilometer(sample.speedMetersPerSecond) }
        : {}),
      ...(query.metrics.includes('cadence')
        ? { cadenceStepsPerMinute: sample.cadenceStepsPerMinute ?? null }
        : {}),
      ...(query.metrics.includes('power') ? { powerWatts: sample.powerWatts ?? null } : {}),
      ...(query.metrics.includes('altitude')
        ? { altitudeMeters: sample.altitudeMeters ?? null }
        : {}),
      ...(query.metrics.includes('gps')
        ? {
            latitudeDegrees: sample.latitudeDegrees ?? null,
            longitudeDegrees: sample.longitudeDegrees ?? null,
          }
        : {}),
    }));
    return {
      activityId,
      metrics: query.metrics,
      from: query.from ?? null,
      to: query.to ?? null,
      totalPoints: rows.length,
      returnedPoints: points.length,
      points,
    };
  }

  /**
   * One bounded daily-aggregation query over RUN activities, shared by the
   * dashboard and trends pages so their statistics cannot drift apart.
   * `effectiveDuration = coalesce(movingDurationSeconds, durationSeconds)`;
   * the heart-rate columns accumulate duration-weighted sums for activities
   * with a positive average heart rate and positive effective duration.
   */
  private aggregateDailyRuns(
    earliestLocalDate: string,
    todayLocalDate: string,
  ): Map<
    string,
    {
      runs: number;
      totalDistanceMeters: number;
      totalMovingDurationSeconds: number;
      heartRateWeighted: number;
      heartRateDurationSeconds: number;
    }
  > {
    const effectiveDuration = sql`coalesce(${activities.movingDurationSeconds}, ${activities.durationSeconds})`;
    const hasHeartRate = sql`${activities.averageHeartRateBpm} > 0 and ${effectiveDuration} > 0`;
    const dailyRows = this.db
      .select({
        localDate: activities.localDate,
        runs: sql<number>`count(*)`,
        totalDistanceMeters: sql<number>`coalesce(sum(${activities.distanceMeters}), 0)`,
        totalMovingDurationSeconds: sql<number>`coalesce(sum(${effectiveDuration}), 0)`,
        heartRateWeighted: sql<number>`coalesce(sum(case when ${hasHeartRate} then ${activities.averageHeartRateBpm} * ${effectiveDuration} else 0 end), 0)`,
        heartRateDurationSeconds: sql<number>`coalesce(sum(case when ${hasHeartRate} then ${effectiveDuration} else 0 end), 0)`,
      })
      .from(activities)
      .where(
        and(
          eq(activities.activityType, 'RUN'),
          gte(activities.localDate, earliestLocalDate),
          lte(activities.localDate, todayLocalDate),
        ),
      )
      .groupBy(activities.localDate)
      .all();
    return new Map(
      dailyRows.map((row) => [
        row.localDate,
        {
          runs: Number(row.runs),
          totalDistanceMeters: Number(row.totalDistanceMeters),
          totalMovingDurationSeconds: Number(row.totalMovingDurationSeconds),
          heartRateWeighted: Number(row.heartRateWeighted),
          heartRateDurationSeconds: Number(row.heartRateDurationSeconds),
        },
      ]),
    );
  }

  /** Sums the daily aggregates inside a closed local-date window. */
  private aggregateWindow(
    window: LocalDateWindow,
    byDate: ReturnType<ActivityRepository['aggregateDailyRuns']>,
  ): {
    runs: number;
    totalDistanceMeters: number;
    totalMovingDurationSeconds: number;
    heartRateWeighted: number;
    heartRateDurationSeconds: number;
  } {
    let runs = 0;
    let totalDistanceMeters = 0;
    let totalMovingDurationSeconds = 0;
    let heartRateWeighted = 0;
    let heartRateDurationSeconds = 0;
    for (const date of eachLocalDate(window)) {
      const row = byDate.get(date);
      if (row === undefined) continue;
      runs += row.runs;
      totalDistanceMeters += row.totalDistanceMeters;
      totalMovingDurationSeconds += row.totalMovingDurationSeconds;
      heartRateWeighted += row.heartRateWeighted;
      heartRateDurationSeconds += row.heartRateDurationSeconds;
    }
    return {
      runs,
      totalDistanceMeters,
      totalMovingDurationSeconds,
      heartRateWeighted,
      heartRateDurationSeconds,
    };
  }

  /**
   * Bounded cross-activity dashboard summary. Runs are aggregated in SQLite by
   * `local_date` over the 12-week window; a fixed number of queries (athlete
   * settings, daily aggregation, recent activities), no per-activity source
   * lookups and no samples. `todayLocalDate` defaults to the local date
   * derived from the athlete settings timezone offset and may be injected in
   * tests for deterministic windows.
   */
  getDashboard(todayLocalDate?: string): DashboardResponse {
    const settings = this.getAthleteSettings();
    const today =
      todayLocalDate ?? localDateFromUtcTime(Date.now(), settings.timezoneOffsetMinutes);
    const weeks = weeklyWindows(today, 12);
    const byDate = this.aggregateDailyRuns(weeks[0]!.startLocalDate, today);
    const toPeriodSummary = (window: LocalDateWindow): DashboardPeriodSummary => {
      const totals = this.aggregateWindow(window, byDate);
      return {
        runs: totals.runs,
        totalDistanceMeters: totals.totalDistanceMeters,
        totalMovingDurationSeconds: totals.totalMovingDurationSeconds,
        // A meaningful pace needs both positive distance and positive
        // effective moving duration; otherwise the schema's positive-or-null
        // contract (and the UI) must receive null instead of 0.
        averagePaceSecondsPerKilometer:
          totals.totalDistanceMeters > 0 && totals.totalMovingDurationSeconds > 0
            ? (totals.totalMovingDurationSeconds / totals.totalDistanceMeters) * 1000
            : null,
      };
    };
    const weeklyVolumes: DashboardWeeklyVolume[] = weeks.map((week) => {
      const summary = toPeriodSummary(week);
      return {
        weekStartLocalDate: week.startLocalDate,
        weekEndLocalDate: week.endLocalDate,
        runs: summary.runs,
        totalDistanceMeters: summary.totalDistanceMeters,
        totalMovingDurationSeconds: summary.totalMovingDurationSeconds,
      };
    });
    const recentRows = this.db
      .select({
        id: activities.id,
        localDate: activities.localDate,
        name: activities.name,
        activityType: activities.activityType,
        distanceMeters: activities.distanceMeters,
        durationSeconds: activities.durationSeconds,
        movingDurationSeconds: activities.movingDurationSeconds,
      })
      .from(activities)
      .orderBy(desc(activities.localDate), desc(activities.startTimeUtc))
      .limit(5)
      .all();
    return {
      generatedForLocalDate: today,
      timezoneOffsetMinutes: settings.timezoneOffsetMinutes,
      last7Days: toPeriodSummary(lastDaysWindow(today, 7)),
      last28Days: toPeriodSummary(lastDaysWindow(today, 28)),
      weeklyVolumes,
      recentActivities: recentRows.map((row) => ({
        id: row.id,
        localDate: row.localDate,
        name: row.name,
        activityType:
          row.activityType as DashboardResponse['recentActivities'][number]['activityType'],
        distanceMeters: row.distanceMeters,
        durationSeconds: row.durationSeconds,
        movingDurationSeconds: row.movingDurationSeconds,
      })),
    };
  }

  /**
   * Bounded cross-activity trends. Weekly windows are Monday-start and include
   * the current week; activities with a future local date are excluded by the
   * daily-aggregation upper bound. Pace and heart rate follow the same
   * statistics as the dashboard: pace needs positive distance and effective
   * duration, heart rate is duration-weighted and null without valid coverage.
   */
  getTrends(query: TrendsQuery, todayLocalDate?: string): TrendsResponse {
    const settings = this.getAthleteSettings();
    const today =
      todayLocalDate ?? localDateFromUtcTime(Date.now(), settings.timezoneOffsetMinutes);
    const weeks = weeklyWindows(today, query.weeks);
    const byDate = this.aggregateDailyRuns(weeks[0]!.startLocalDate, today);
    const toPoint = (week: LocalDateWindow): TrendsWeeklyPoint => {
      const totals = this.aggregateWindow(week, byDate);
      return {
        weekStartLocalDate: week.startLocalDate,
        weekEndLocalDate: week.endLocalDate,
        runs: totals.runs,
        totalDistanceMeters: totals.totalDistanceMeters,
        totalMovingDurationSeconds: totals.totalMovingDurationSeconds,
        averagePaceSecondsPerKilometer:
          totals.totalDistanceMeters > 0 && totals.totalMovingDurationSeconds > 0
            ? (totals.totalMovingDurationSeconds / totals.totalDistanceMeters) * 1000
            : null,
        averageHeartRateBpm:
          totals.heartRateDurationSeconds > 0
            ? totals.heartRateWeighted / totals.heartRateDurationSeconds
            : null,
      };
    };
    const weeklyPoints = weeks.map(toPoint);
    const summaryWindow: LocalDateWindow = {
      startLocalDate: weeks[0]!.startLocalDate,
      endLocalDate: today,
    };
    const totals = this.aggregateWindow(summaryWindow, byDate);
    return {
      generatedForLocalDate: today,
      timezoneOffsetMinutes: settings.timezoneOffsetMinutes,
      weeks: query.weeks,
      summary: {
        runs: totals.runs,
        totalDistanceMeters: totals.totalDistanceMeters,
        totalMovingDurationSeconds: totals.totalMovingDurationSeconds,
        averagePaceSecondsPerKilometer:
          totals.totalDistanceMeters > 0 && totals.totalMovingDurationSeconds > 0
            ? (totals.totalMovingDurationSeconds / totals.totalDistanceMeters) * 1000
            : null,
        averageHeartRateBpm:
          totals.heartRateDurationSeconds > 0
            ? totals.heartRateWeighted / totals.heartRateDurationSeconds
            : null,
      },
      weeklyPoints,
    };
  }

  /**
   * Bounded calendar projection for a closed local-date range: planned
   * workouts plus activity summaries, both filtered and ordered in SQL. A
   * fixed two queries, no per-record lookups, no samples or source data.
   */
  getCalendarRange(query: CalendarQuery): CalendarResponse {
    const plannedRows = this.db
      .select()
      .from(plannedWorkouts)
      .where(
        and(
          gte(plannedWorkouts.scheduledLocalDate, query.from),
          lte(plannedWorkouts.scheduledLocalDate, query.to),
        ),
      )
      .orderBy(
        asc(plannedWorkouts.scheduledLocalDate),
        asc(plannedWorkouts.title),
        asc(plannedWorkouts.id),
      )
      .all();
    const activityRows = this.db
      .select({
        id: activities.id,
        localDate: activities.localDate,
        activityType: activities.activityType,
        name: activities.name,
        distanceMeters: activities.distanceMeters,
        durationSeconds: activities.durationSeconds,
        movingDurationSeconds: activities.movingDurationSeconds,
      })
      .from(activities)
      .where(and(gte(activities.localDate, query.from), lte(activities.localDate, query.to)))
      .orderBy(asc(activities.localDate), asc(activities.startTimeUtc), asc(activities.id))
      .all();
    return {
      from: query.from,
      to: query.to,
      plannedWorkouts: plannedRows.map((row) => ({
        id: row.id,
        scheduledLocalDate: row.scheduledLocalDate,
        workoutType: row.workoutType as PlannedWorkout['workoutType'],
        title: row.title,
        notes: row.notes,
        targetDistanceMeters: row.targetDistanceMeters,
        targetDurationSeconds: row.targetDurationSeconds,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      activities: activityRows.map((row) => ({
        id: row.id,
        localDate: row.localDate,
        activityType: row.activityType as CalendarResponse['activities'][number]['activityType'],
        name: row.name,
        distanceMeters: row.distanceMeters,
        durationSeconds: row.durationSeconds,
        movingDurationSeconds: row.movingDurationSeconds,
      })),
    };
  }

  getPlannedWorkout(workoutId: string): PlannedWorkout | null {
    const row = this.db
      .select()
      .from(plannedWorkouts)
      .where(eq(plannedWorkouts.id, workoutId))
      .get();
    return row === undefined ? null : this.toPlannedWorkout(row);
  }

  createPlannedWorkout(input: PlannedWorkoutCreate): PlannedWorkout {
    const id = randomUUID();
    const timestamp = now();
    this.db
      .insert(plannedWorkouts)
      .values({
        id,
        scheduledLocalDate: input.scheduledLocalDate,
        workoutType: input.workoutType,
        title: input.title,
        notes: input.notes ?? null,
        targetDistanceMeters: input.targetDistanceMeters ?? null,
        targetDurationSeconds: input.targetDurationSeconds ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    const created = this.getPlannedWorkout(id);
    if (created === null) throw new Error('创建计划训练后无法读取记录');
    return created;
  }

  updatePlannedWorkout(workoutId: string, patch: PlannedWorkoutPatch): PlannedWorkout | null {
    const current = this.getPlannedWorkout(workoutId);
    if (current === null) return null;
    this.db
      .update(plannedWorkouts)
      .set({
        ...(patch.scheduledLocalDate === undefined
          ? {}
          : { scheduledLocalDate: patch.scheduledLocalDate }),
        ...(patch.workoutType === undefined ? {} : { workoutType: patch.workoutType }),
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.notes === undefined ? {} : { notes: patch.notes }),
        ...(patch.targetDistanceMeters === undefined
          ? {}
          : { targetDistanceMeters: patch.targetDistanceMeters }),
        ...(patch.targetDurationSeconds === undefined
          ? {}
          : { targetDurationSeconds: patch.targetDurationSeconds }),
        updatedAt: now(),
      })
      .where(eq(plannedWorkouts.id, workoutId))
      .run();
    return this.getPlannedWorkout(workoutId);
  }

  deletePlannedWorkout(workoutId: string): boolean {
    const result = this.db.delete(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId)).run();
    return result.changes === 1;
  }

  private toPlannedWorkout(row: typeof plannedWorkouts.$inferSelect): PlannedWorkout {
    return {
      id: row.id,
      scheduledLocalDate: row.scheduledLocalDate,
      workoutType: row.workoutType as PlannedWorkout['workoutType'],
      title: row.title,
      notes: row.notes,
      targetDistanceMeters: row.targetDistanceMeters,
      targetDurationSeconds: row.targetDurationSeconds,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  getAthleteSettings(): AthleteSettings {
    const row = this.db
      .select()
      .from(athleteSettings)
      .where(eq(athleteSettings.id, 'default'))
      .get();
    if (row === undefined) throw new Error('Athlete settings row is missing');
    return {
      maxHeartRateBpm: row.maxHeartRateBpm,
      restingHeartRateBpm: row.restingHeartRateBpm,
      thresholdHeartRateBpm: row.thresholdHeartRateBpm,
      heartRateZoneMethod: 'MAX_HR_PERCENT',
      distanceUnit: 'METRIC',
      timezoneOffsetMinutes: row.timezoneOffsetMinutes,
      updatedAt: row.updatedAt,
    };
  }

  updateAthleteSettings(patch: AthleteSettingsPatch): AthleteSettings {
    this.db
      .update(athleteSettings)
      .set({ ...patch, updatedAt: now() })
      .where(eq(athleteSettings.id, 'default'))
      .run();
    return this.getAthleteSettings();
  }

  getPendingRawContext(itemId: string): {
    item: typeof importItems.$inferSelect;
    job: typeof importJobs.$inferSelect;
    rawFile: typeof rawFiles.$inferSelect;
  } | null {
    const row = this.db
      .select({ item: importItems, job: importJobs, rawFile: rawFiles })
      .from(importItems)
      .innerJoin(importJobs, eq(importItems.importJobId, importJobs.id))
      .innerJoin(rawFiles, eq(importJobs.rawFileId, rawFiles.id))
      .where(eq(importItems.id, itemId))
      .get();
    return row ?? null;
  }

  getPendingItem(itemId: string): PendingImportsPage['items'][number] | null {
    const row = this.db
      .select({ item: importItems, job: importJobs })
      .from(importItems)
      .innerJoin(importJobs, eq(importItems.importJobId, importJobs.id))
      .where(and(eq(importItems.id, itemId), eq(importItems.status, 'PENDING')))
      .get();
    if (row === undefined) return null;
    const summary = normalizedActivitySummarySchema.safeParse(
      row.item.normalizedPayload === null ? null : JSON.parse(row.item.normalizedPayload),
    );
    const activitiesById = new Map(
      this.listActivities().map((activity) => [activity.id, activity]),
    );
    const match = parseStoredMatch(
      row.item.matchDetails,
      new Map(this.getMatchViews().map((activity) => [activity.id, activity.version])),
    );
    if (!summary.success || match === null || match.kind !== 'PENDING_CONFIRMATION') return null;
    return {
      itemId: row.item.id,
      jobId: row.job.id,
      importedAt: row.item.createdAt,
      originalFileName: row.job.originalFileName,
      status: row.item.status,
      reason: match.reason,
      summary: summary.data,
      candidates: match.candidates.flatMap((candidate) => {
        const activity = activitiesById.get(candidate.activityId);
        return activity === undefined ? [] : [{ ...candidate, activity }];
      }),
      errorCode: row.item.errorCode,
      errorMessage: row.item.errorMessage,
    };
  }

  recordPendingError(itemId: string, errorCode: string, errorMessage: string): void {
    this.db
      .update(importItems)
      .set({ errorCode, errorMessage })
      .where(and(eq(importItems.id, itemId), eq(importItems.status, 'PENDING')))
      .run();
  }

  listPending(limit: number, cursor?: string): PendingImportsPage {
    const decodedCursor = decodeCursor(cursor);
    if (cursor !== undefined && decodedCursor === null) {
      throw new RepositoryConflictError('INVALID_CURSOR', 'Invalid pagination cursor');
    }
    const cursorFilter =
      decodedCursor === null
        ? undefined
        : or(
            lt(importItems.createdAt, decodedCursor[0]),
            and(eq(importItems.createdAt, decodedCursor[0]), lt(importItems.id, decodedCursor[1])),
          );
    const rows = this.db
      .select({ item: importItems, job: importJobs })
      .from(importItems)
      .innerJoin(importJobs, eq(importItems.importJobId, importJobs.id))
      .where(and(eq(importItems.status, 'PENDING'), cursorFilter))
      .orderBy(desc(importItems.createdAt), desc(importItems.id))
      .limit(limit + 1)
      .all();
    const activitiesById = new Map(
      this.listActivities().map((activity) => [activity.id, activity]),
    );
    const activityVersions = new Map(
      this.getMatchViews().map((activity) => [activity.id, activity.version]),
    );
    const pageRows = rows.slice(0, limit);
    const items = pageRows.flatMap(({ item, job }) => {
      const summary = normalizedActivitySummarySchema.safeParse(
        item.normalizedPayload === null ? null : JSON.parse(item.normalizedPayload),
      );
      const match = parseStoredMatch(item.matchDetails, activityVersions);
      if (!summary.success || match === null || match.kind !== 'PENDING_CONFIRMATION') return [];
      return [
        {
          itemId: item.id,
          jobId: job.id,
          importedAt: item.createdAt,
          originalFileName: job.originalFileName,
          status: item.status,
          reason: match.reason,
          summary: summary.data,
          candidates: match.candidates.flatMap((candidate) => {
            const activity = activitiesById.get(candidate.activityId);
            return activity === undefined ? [] : [{ ...candidate, activity }];
          }),
          errorCode: item.errorCode,
          errorMessage: item.errorMessage,
        },
      ];
    });
    const totalRow = this.db
      .select({ count: sql<number>`count(*)` })
      .from(importItems)
      .where(eq(importItems.status, 'PENDING'))
      .get();
    const last = pageRows.at(-1);
    return {
      items,
      total: Number(totalRow?.count ?? 0),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor(last.item.createdAt, last.item.id)
          : null,
    };
  }

  listImportHistory(limit: number, cursor?: string): ImportHistoryPage {
    const decodedCursor = decodeCursor(cursor);
    if (cursor !== undefined && decodedCursor === null) {
      throw new RepositoryConflictError('INVALID_CURSOR', 'Invalid pagination cursor');
    }
    const cursorFilter =
      decodedCursor === null
        ? undefined
        : or(
            lt(importJobs.createdAt, decodedCursor[0]),
            and(eq(importJobs.createdAt, decodedCursor[0]), lt(importJobs.id, decodedCursor[1])),
          );
    const rows = this.db
      .select()
      .from(importJobs)
      .where(cursorFilter)
      .orderBy(desc(importJobs.createdAt), desc(importJobs.id))
      .limit(limit + 1)
      .all();
    const pageRows = rows.slice(0, limit);
    const jobs = pageRows.map((job) => {
      const itemRows = this.db
        .select()
        .from(importItems)
        .where(eq(importItems.importJobId, job.id))
        .orderBy(asc(importItems.createdAt))
        .all();
      const counts: ImportHistoryPage['jobs'][number]['counts'] = {};
      for (const item of itemRows) {
        const parsed = importOutcomeSchema.safeParse(item.outcome);
        if (parsed.success) counts[parsed.data] = (counts[parsed.data] ?? 0) + 1;
      }
      return {
        jobId: job.id,
        sourceType: job.sourceType as SourceType,
        originalFileName: job.originalFileName,
        status: job.status,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        requiresAction: itemRows.some((item) => item.status === 'PENDING'),
        counts,
        items: itemRows.map((item) => ({
          itemId: item.id,
          outcome: importOutcomeSchema.safeParse(item.outcome).success
            ? (item.outcome as ImportOutcome)
            : null,
          activityId: item.activityId,
          status: item.status,
          errorCode: item.errorCode,
          errorMessage: item.errorMessage,
        })),
      };
    });
    const last = pageRows.at(-1);
    return {
      jobs,
      nextCursor:
        rows.length > limit && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  resolvePending(input: PendingResolutionInput): ResolveImportResult {
    return this.db.transaction((tx) => {
      const item = tx.select().from(importItems).where(eq(importItems.id, input.itemId)).get();
      if (item === undefined)
        throw new RepositoryConflictError('NOT_FOUND', 'Import item not found');
      if (
        item.status === 'COMPLETED' &&
        item.resolutionAction !== null &&
        item.resolvedAt !== null
      ) {
        const sameAction =
          item.resolutionAction === input.request.action &&
          (input.request.action !== 'ATTACH' ||
            item.resolutionActivityId === input.request.activityId);
        if (!sameAction) {
          throw new RepositoryConflictError('ALREADY_RESOLVED', 'Import item was already resolved');
        }
        return {
          itemId: item.id,
          status: item.status,
          outcome: importOutcomeSchema.parse(item.outcome),
          action: input.request.action,
          activityId: item.activityId,
          sourceId: item.sourceId,
          resolvedAt: item.resolvedAt,
          idempotent: true,
        };
      }
      const claimed = tx
        .update(importItems)
        .set({ status: 'RESOLVING', errorCode: null, errorMessage: null })
        .where(and(eq(importItems.id, input.itemId), eq(importItems.status, 'PENDING')))
        .run();
      if (claimed.changes !== 1) {
        throw new RepositoryConflictError('RESOLUTION_CONFLICT', 'Import item is not pending');
      }
      const resolvedAt = now();
      if (input.request.action === 'SKIP') {
        tx.update(importItems)
          .set({
            status: 'COMPLETED',
            outcome: 'SKIPPED',
            resolutionAction: 'SKIP',
            resolvedAt,
            completedAt: resolvedAt,
          })
          .where(eq(importItems.id, input.itemId))
          .run();
        return {
          itemId: input.itemId,
          status: 'COMPLETED',
          outcome: 'SKIPPED',
          action: 'SKIP',
          activityId: null,
          sourceId: null,
          resolvedAt,
          idempotent: false,
        };
      }
      if (input.normalized === null) throw new Error('Decoded FIT activity is required');
      const duplicate = tx
        .select()
        .from(activitySources)
        .where(
          and(
            eq(activitySources.sourceType, 'FIT'),
            eq(activitySources.fileSha256, input.fileSha256),
            eq(activitySources.active, true),
          ),
        )
        .get();
      if (duplicate !== undefined) {
        throw new RepositoryConflictError('FIT_ALREADY_ATTACHED', 'FIT file is already attached');
      }

      let applied: ApplySourceResult;
      if (input.request.action === 'ATTACH') {
        const targetActivityId = input.request.activityId;
        const match =
          input.legacyMatch ?? matchDecisionSchema.parse(JSON.parse(item.matchDetails ?? 'null'));
        if (match.kind !== 'PENDING_CONFIRMATION')
          throw new Error('Pending match details are invalid');
        const candidate = match.candidates.find((entry) => entry.activityId === targetActivityId);
        if (candidate === undefined) {
          throw new RepositoryConflictError(
            'INVALID_CANDIDATE',
            'Activity is not a recorded candidate',
          );
        }
        const target = tx
          .select()
          .from(activities)
          .where(eq(activities.id, targetActivityId))
          .get();
        if (target === undefined)
          throw new RepositoryConflictError('NOT_FOUND', 'Activity not found');
        if (target.version !== candidate.activityVersion) {
          throw new RepositoryConflictError('STALE_CANDIDATE', 'Candidate activity changed');
        }
        applied = this.mergeSourceIntoActivity(targetActivityId, {
          normalized: input.normalized,
          rawFileId: input.rawFileId,
          fileSha256: input.fileSha256,
          rawPayload: input.normalized.rawSummary,
          importItemId: input.itemId,
        });
      } else {
        applied = this.createActivityFromSource({
          normalized: input.normalized,
          rawFileId: input.rawFileId,
          fileSha256: input.fileSha256,
          rawPayload: input.normalized.rawSummary,
          importItemId: input.itemId,
        });
      }
      const outcome = input.request.action === 'ATTACH' ? 'UPGRADED' : 'CREATED';
      tx.update(importItems)
        .set({
          status: 'COMPLETED',
          outcome,
          activityId: applied.activityId,
          sourceId: applied.sourceId,
          resolutionAction: input.request.action,
          resolutionActivityId: input.request.action === 'ATTACH' ? input.request.activityId : null,
          resolvedAt,
          completedAt: resolvedAt,
        })
        .where(eq(importItems.id, input.itemId))
        .run();
      return {
        itemId: input.itemId,
        status: 'COMPLETED',
        outcome,
        action: input.request.action,
        activityId: applied.activityId,
        sourceId: applied.sourceId,
        resolvedAt,
        idempotent: false,
      };
    });
  }

  countRows(): {
    activities: number;
    sources: number;
    samples: number;
    laps: number;
    mergeEvents: number;
  } {
    return {
      activities: this.db.select().from(activities).all().length,
      sources: this.db.select().from(activitySources).all().length,
      samples: this.db.select().from(activitySamples).all().length,
      laps: this.db.select().from(activityLaps).all().length,
      mergeEvents: this.db.select().from(activityMergeEvents).all().length,
    };
  }
}
