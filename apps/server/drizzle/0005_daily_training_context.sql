ALTER TABLE `athlete_settings` ADD COLUMN `display_name` text;
ALTER TABLE `athlete_settings` ADD COLUMN `experience_level` text;
ALTER TABLE `athlete_settings` ADD COLUMN `primary_goal` text;
ALTER TABLE `athlete_settings` ADD COLUMN `weekly_distance_target_meters` integer;

CREATE TABLE `daily_status_entries` (
  `id` text PRIMARY KEY NOT NULL,
  `local_date` text NOT NULL,
  `sleep_quality` integer CHECK (`sleep_quality` IS NULL OR `sleep_quality` BETWEEN 1 AND 5),
  `fatigue_level` integer CHECK (`fatigue_level` IS NULL OR `fatigue_level` BETWEEN 1 AND 5),
  `muscle_soreness_level` integer CHECK (`muscle_soreness_level` IS NULL OR `muscle_soreness_level` BETWEEN 1 AND 5),
  `stress_level` integer CHECK (`stress_level` IS NULL OR `stress_level` BETWEEN 1 AND 5),
  `motivation_level` integer CHECK (`motivation_level` IS NULL OR `motivation_level` BETWEEN 1 AND 5),
  `resting_heart_rate_bpm` integer CHECK (`resting_heart_rate_bpm` IS NULL OR `resting_heart_rate_bpm` BETWEEN 30 AND 220),
  `notes` text CHECK (`notes` IS NULL OR length(`notes`) <= 2000),
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
CREATE UNIQUE INDEX `daily_status_entries_local_date_uq` ON `daily_status_entries` (`local_date`);
