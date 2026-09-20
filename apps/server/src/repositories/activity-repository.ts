import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import type {
  ActivityDetail,
  ActivityListItem,
  ActivityPatch,
  ImportOutcome,
  NormalizedActivity,
  SourceType,
} from '@runcoach/shared';
import type { ActivityMatchView } from '@runcoach/importers';
import type { RunCoachDatabase } from '../db/client.js';
import {
  activities,
  activityFieldProvenance,
  activityLaps,
  activityMergeEvents,
  activitySamples,
  activitySources,
  importItems,
  importJobs,
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

export interface ApplySourceResult {
  activityId: string;
  sourceId: string;
}

export interface MergeHooks {
  afterSeriesInserted?: () => void;
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

function now(): string {
  return new Date().toISOString();
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
      normalizedPayload?: NormalizedActivity | null;
      errorMessage?: string | null;
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
          fileSha256: normalized.sourceType === 'FIT' ? input.fileSha256 : null,
          rawFileId: input.rawFileId,
          rawPayload: JSON.stringify(input.rawPayload),
          normalizedPayload: JSON.stringify(normalized),
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
          fileSha256: normalized.sourceType === 'FIT' ? input.fileSha256 : null,
          rawFileId: input.rawFileId,
          rawPayload: JSON.stringify(input.rawPayload),
          normalizedPayload: JSON.stringify(normalized),
          createdAt: timestamp,
        })
        .run();
      this.insertSeries(tx, activityId, sourceId, normalized);
      hooks.afterSeriesInserted?.();

      const updates = {
        activityType: normalized.activityType,
        startTimeUtc: normalized.startTimeUtc,
        originalStartTime: normalized.originalStartTime,
        timezoneOffsetMinutes: normalized.timezoneOffsetMinutes,
        localDate: normalized.localDate,
        name:
          before.userEditedName || normalized.name === null || normalized.name === undefined
            ? before.name
            : normalized.name,
        notes:
          before.userEditedNotes || normalized.notes === null || normalized.notes === undefined
            ? before.notes
            : normalized.notes,
        distanceMeters: normalized.distanceMeters ?? before.distanceMeters,
        durationSeconds: normalized.durationSeconds ?? before.durationSeconds,
        movingDurationSeconds: normalized.movingDurationSeconds ?? before.movingDurationSeconds,
        averageHeartRateBpm: normalized.averageHeartRateBpm ?? before.averageHeartRateBpm,
        maxHeartRateBpm: normalized.maxHeartRateBpm ?? before.maxHeartRateBpm,
        deviceName: normalized.deviceName ?? before.deviceName,
        hasTimeSeries: before.hasTimeSeries || normalized.samples.length > 0,
        primaryTimeSeriesSourceId:
          normalized.samples.length > 0 ? sourceId : before.primaryTimeSeriesSourceId,
        version: before.version + 1,
        updatedAt: timestamp,
      };
      tx.update(activities).set(updates).where(eq(activities.id, activityId)).run();

      for (const field of provenanceFields) {
        if (!fieldHasValue(normalized, field)) continue;
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
    return this.db
      .select()
      .from(activities)
      .orderBy(desc(activities.startTimeUtc))
      .all()
      .map((activity) => {
        const sources = this.db
          .select({ sourceType: activitySources.sourceType })
          .from(activitySources)
          .where(and(eq(activitySources.activityId, activity.id), eq(activitySources.active, true)))
          .all();
        return {
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
          sourceTypes: [...new Set(sources.map((source) => source.sourceType as SourceType))],
        };
      });
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
      samples: samples.map((sample) => ({
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
      })),
      provenance,
      mergeEvents: mergeEventRows.map((event) => ({
        id: event.id,
        action: event.action,
        changedFields: changedFields(event.beforeSnapshot, event.afterSnapshot),
        createdAt: event.createdAt,
      })),
    };
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
