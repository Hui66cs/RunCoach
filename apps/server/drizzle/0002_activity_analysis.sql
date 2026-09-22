CREATE TABLE `athlete_settings` (
  `id` TEXT PRIMARY KEY NOT NULL CHECK (`id` = 'default'),
  `max_heart_rate_bpm` INTEGER,
  `resting_heart_rate_bpm` INTEGER,
  `threshold_heart_rate_bpm` INTEGER,
  `heart_rate_zone_method` TEXT NOT NULL DEFAULT 'MAX_HR_PERCENT',
  `distance_unit` TEXT NOT NULL DEFAULT 'METRIC',
  `timezone_offset_minutes` INTEGER NOT NULL DEFAULT 480,
  `updated_at` TEXT NOT NULL
);

INSERT INTO `athlete_settings` (`id`, `updated_at`) VALUES ('default', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE INDEX `activities_list_filter_idx`
  ON `activities` (`activity_type`, `local_date`, `start_time_utc`, `id`);

CREATE INDEX `activity_sources_type_activity_active_idx`
  ON `activity_sources` (`source_type`, `activity_id`, `active`);

CREATE INDEX `activity_samples_activity_elapsed_idx`
  ON `activity_samples` (`activity_id`, `elapsed_seconds`);
