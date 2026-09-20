import { sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const activities = sqliteTable(
  'activities',
  {
    id: text('id').primaryKey(),
    activityType: text('activity_type').notNull(),
    startTimeUtc: text('start_time_utc').notNull(),
    originalStartTime: text('original_start_time').notNull(),
    timezoneOffsetMinutes: integer('timezone_offset_minutes'),
    localDate: text('local_date').notNull(),
    name: text('name'),
    notes: text('notes'),
    userEditedName: integer('user_edited_name', { mode: 'boolean' }).notNull().default(false),
    userEditedNotes: integer('user_edited_notes', { mode: 'boolean' }).notNull().default(false),
    distanceMeters: real('distance_meters'),
    durationSeconds: real('duration_seconds'),
    movingDurationSeconds: real('moving_duration_seconds'),
    averageHeartRateBpm: integer('average_heart_rate_bpm'),
    maxHeartRateBpm: integer('max_heart_rate_bpm'),
    deviceName: text('device_name'),
    hasTimeSeries: integer('has_time_series', { mode: 'boolean' }).notNull().default(false),
    primaryTimeSeriesSourceId: text('primary_time_series_source_id'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('activities_started_at_idx').on(table.startTimeUtc),
    index('activities_local_date_idx').on(table.localDate),
  ],
);

export const rawFiles = sqliteTable('raw_files', {
  id: text('id').primaryKey(),
  sha256: text('sha256').notNull().unique(),
  relativePath: text('relative_path').notNull().unique(),
  originalName: text('original_name').notNull(),
  mediaType: text('media_type').notNull(),
  byteLength: integer('byte_length').notNull(),
  createdAt: text('created_at').notNull(),
});

export const importJobs = sqliteTable('import_jobs', {
  id: text('id').primaryKey(),
  sourceType: text('source_type').notNull(),
  status: text('status').notNull(),
  originalFileName: text('original_file_name').notNull(),
  rawFileId: text('raw_file_id').references(() => rawFiles.id, { onDelete: 'restrict' }),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
});

export const importItems = sqliteTable(
  'import_items',
  {
    id: text('id').primaryKey(),
    importJobId: text('import_job_id')
      .notNull()
      .references(() => importJobs.id, { onDelete: 'cascade' }),
    rowNumber: integer('row_number'),
    status: text('status').notNull(),
    outcome: text('outcome'),
    activityId: text('activity_id').references(() => activities.id, { onDelete: 'restrict' }),
    sourceId: text('source_id'),
    matchScore: real('match_score'),
    matchDetails: text('match_details'),
    normalizedPayload: text('normalized_payload'),
    errorMessage: text('error_message'),
    createdAt: text('created_at').notNull(),
    completedAt: text('completed_at'),
  },
  (table) => [index('import_items_job_idx').on(table.importJobId)],
);

export const activitySources = sqliteTable(
  'activity_sources',
  {
    id: text('id').primaryKey(),
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').notNull(),
    externalId: text('external_id'),
    fileSha256: text('file_sha256'),
    rawFileId: text('raw_file_id').references(() => rawFiles.id, { onDelete: 'restrict' }),
    rawPayload: text('raw_payload').notNull(),
    normalizedPayload: text('normalized_payload').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('activity_sources_activity_idx').on(table.activityId),
    uniqueIndex('activity_sources_external_identity_uq')
      .on(table.sourceType, table.externalId)
      .where(sql`${table.externalId} is not null`),
    uniqueIndex('activity_sources_fit_sha_uq')
      .on(table.fileSha256)
      .where(sql`${table.sourceType} = 'FIT' and ${table.fileSha256} is not null`),
    uniqueIndex('activity_sources_id_activity_uq').on(table.id, table.activityId),
  ],
);

export const activitySamples = sqliteTable(
  'activity_samples',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull(),
    sequence: integer('sequence').notNull(),
    timestampUtc: text('timestamp_utc').notNull(),
    elapsedSeconds: real('elapsed_seconds'),
    distanceMeters: real('distance_meters'),
    speedMetersPerSecond: real('speed_meters_per_second'),
    heartRateBpm: integer('heart_rate_bpm'),
    cadenceStepsPerMinute: real('cadence_steps_per_minute'),
    powerWatts: real('power_watts'),
    altitudeMeters: real('altitude_meters'),
    latitudeDegrees: real('latitude_degrees'),
    longitudeDegrees: real('longitude_degrees'),
  },
  (table) => [
    uniqueIndex('activity_samples_source_sequence_uq').on(table.sourceId, table.sequence),
    index('activity_samples_activity_time_idx').on(table.activityId, table.timestampUtc),
    foreignKey({
      columns: [table.sourceId, table.activityId],
      foreignColumns: [activitySources.id, activitySources.activityId],
      name: 'activity_samples_source_activity_fk',
    }).onDelete('cascade'),
  ],
);

export const activityLaps = sqliteTable(
  'activity_laps',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull(),
    sequence: integer('sequence').notNull(),
    startTimeUtc: text('start_time_utc'),
    durationSeconds: real('duration_seconds'),
    distanceMeters: real('distance_meters'),
    averageHeartRateBpm: integer('average_heart_rate_bpm'),
    maxHeartRateBpm: integer('max_heart_rate_bpm'),
    averageSpeedMetersPerSecond: real('average_speed_meters_per_second'),
  },
  (table) => [
    uniqueIndex('activity_laps_source_sequence_uq').on(table.sourceId, table.sequence),
    foreignKey({
      columns: [table.sourceId, table.activityId],
      foreignColumns: [activitySources.id, activitySources.activityId],
      name: 'activity_laps_source_activity_fk',
    }).onDelete('cascade'),
  ],
);

export const activityFieldProvenance = sqliteTable(
  'activity_field_provenance',
  {
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'cascade' }),
    fieldName: text('field_name').notNull(),
    originType: text('origin_type').notNull(),
    sourceId: text('source_id'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.activityId, table.fieldName] }),
    foreignKey({
      columns: [table.sourceId, table.activityId],
      foreignColumns: [activitySources.id, activitySources.activityId],
      name: 'activity_field_provenance_source_activity_fk',
    }).onDelete('cascade'),
  ],
);

export const activityMergeEvents = sqliteTable(
  'activity_merge_events',
  {
    id: text('id').primaryKey(),
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'cascade' }),
    importItemId: text('import_item_id').references(() => importItems.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    sourceId: text('source_id'),
    beforeSnapshot: text('before_snapshot'),
    afterSnapshot: text('after_snapshot').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('merge_events_activity_idx').on(table.activityId, table.createdAt),
    foreignKey({
      columns: [table.sourceId, table.activityId],
      foreignColumns: [activitySources.id, activitySources.activityId],
      name: 'activity_merge_events_source_activity_fk',
    }).onDelete('cascade'),
  ],
);
