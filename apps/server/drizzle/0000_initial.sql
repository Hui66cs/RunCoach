CREATE TABLE `activities` (
  `id` text PRIMARY KEY NOT NULL,
  `activity_type` text NOT NULL,
  `start_time_utc` text NOT NULL,
  `original_start_time` text NOT NULL,
  `timezone_offset_minutes` integer,
  `local_date` text NOT NULL,
  `name` text,
  `notes` text,
  `user_edited_name` integer DEFAULT 0 NOT NULL,
  `user_edited_notes` integer DEFAULT 0 NOT NULL,
  `distance_meters` real,
  `duration_seconds` real,
  `moving_duration_seconds` real,
  `average_heart_rate_bpm` integer,
  `max_heart_rate_bpm` integer,
  `device_name` text,
  `has_time_series` integer DEFAULT 0 NOT NULL,
  `primary_time_series_source_id` text,
  `version` integer DEFAULT 1 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
CREATE INDEX `activities_started_at_idx` ON `activities` (`start_time_utc`);
CREATE INDEX `activities_local_date_idx` ON `activities` (`local_date`);

CREATE TABLE `raw_files` (
  `id` text PRIMARY KEY NOT NULL,
  `sha256` text NOT NULL,
  `relative_path` text NOT NULL,
  `original_name` text NOT NULL,
  `media_type` text NOT NULL,
  `byte_length` integer NOT NULL,
  `created_at` text NOT NULL
);
CREATE UNIQUE INDEX `raw_files_sha256_unique` ON `raw_files` (`sha256`);
CREATE UNIQUE INDEX `raw_files_relative_path_unique` ON `raw_files` (`relative_path`);

CREATE TABLE `import_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `source_type` text NOT NULL,
  `status` text NOT NULL,
  `original_file_name` text NOT NULL,
  `raw_file_id` text,
  `created_at` text NOT NULL,
  `completed_at` text,
  FOREIGN KEY (`raw_file_id`) REFERENCES `raw_files`(`id`) ON UPDATE no action ON DELETE restrict
);

CREATE TABLE `import_items` (
  `id` text PRIMARY KEY NOT NULL,
  `import_job_id` text NOT NULL,
  `row_number` integer,
  `status` text NOT NULL,
  `outcome` text,
  `activity_id` text,
  `source_id` text,
  `match_score` real,
  `match_details` text,
  `normalized_payload` text,
  `error_message` text,
  `created_at` text NOT NULL,
  `completed_at` text,
  FOREIGN KEY (`import_job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE INDEX `import_items_job_idx` ON `import_items` (`import_job_id`);

CREATE TABLE `activity_sources` (
  `id` text PRIMARY KEY NOT NULL,
  `activity_id` text NOT NULL,
  `source_type` text NOT NULL,
  `external_id` text,
  `file_sha256` text,
  `raw_file_id` text,
  `raw_payload` text NOT NULL,
  `normalized_payload` text NOT NULL,
  `active` integer DEFAULT 1 NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`raw_file_id`) REFERENCES `raw_files`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE INDEX `activity_sources_activity_idx` ON `activity_sources` (`activity_id`);
CREATE UNIQUE INDEX `activity_sources_external_identity_uq` ON `activity_sources` (`source_type`,`external_id`) WHERE `external_id` is not null;
CREATE UNIQUE INDEX `activity_sources_fit_sha_uq` ON `activity_sources` (`file_sha256`) WHERE `source_type` = 'FIT' and `file_sha256` is not null;
CREATE UNIQUE INDEX `activity_sources_id_activity_uq` ON `activity_sources` (`id`,`activity_id`);

CREATE TABLE `activity_samples` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `activity_id` text NOT NULL,
  `source_id` text NOT NULL,
  `sequence` integer NOT NULL,
  `timestamp_utc` text NOT NULL,
  `elapsed_seconds` real,
  `distance_meters` real,
  `speed_meters_per_second` real,
  `heart_rate_bpm` integer,
  `cadence_steps_per_minute` real,
  `power_watts` real,
  `altitude_meters` real,
  `latitude_degrees` real,
  `longitude_degrees` real,
  FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`source_id`,`activity_id`) REFERENCES `activity_sources`(`id`,`activity_id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `activity_samples_source_sequence_uq` ON `activity_samples` (`source_id`,`sequence`);
CREATE INDEX `activity_samples_activity_time_idx` ON `activity_samples` (`activity_id`,`timestamp_utc`);

CREATE TABLE `activity_laps` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `activity_id` text NOT NULL,
  `source_id` text NOT NULL,
  `sequence` integer NOT NULL,
  `start_time_utc` text,
  `duration_seconds` real,
  `distance_meters` real,
  `average_heart_rate_bpm` integer,
  `max_heart_rate_bpm` integer,
  `average_speed_meters_per_second` real,
  FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`source_id`,`activity_id`) REFERENCES `activity_sources`(`id`,`activity_id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `activity_laps_source_sequence_uq` ON `activity_laps` (`source_id`,`sequence`);

CREATE TABLE `activity_field_provenance` (
  `activity_id` text NOT NULL,
  `field_name` text NOT NULL,
  `origin_type` text NOT NULL,
  `source_id` text,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`activity_id`,`field_name`),
  FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`source_id`,`activity_id`) REFERENCES `activity_sources`(`id`,`activity_id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `activity_merge_events` (
  `id` text PRIMARY KEY NOT NULL,
  `activity_id` text NOT NULL,
  `import_item_id` text,
  `action` text NOT NULL,
  `source_id` text,
  `before_snapshot` text,
  `after_snapshot` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`import_item_id`) REFERENCES `import_items`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`source_id`,`activity_id`) REFERENCES `activity_sources`(`id`,`activity_id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `merge_events_activity_idx` ON `activity_merge_events` (`activity_id`,`created_at`);
