ALTER TABLE `activity_sources` ADD COLUMN `identity_key` text;
ALTER TABLE `activity_sources` ADD COLUMN `content_sha256` text;

ALTER TABLE `import_items` ADD COLUMN `error_code` text;
ALTER TABLE `import_items` ADD COLUMN `resolution_action` text;
ALTER TABLE `import_items` ADD COLUMN `resolution_activity_id` text REFERENCES `activities`(`id`) ON DELETE restrict;
ALTER TABLE `import_items` ADD COLUMN `resolved_at` text;

UPDATE `activity_sources`
SET `normalized_payload` = json_set(
  json_remove(`normalized_payload`, '$.samples', '$.laps', '$.rawSummary'),
  '$.schemaVersion', 1,
  '$.adapterVersion', 'legacy',
  '$.sampleCount', COALESCE(json_array_length(json_extract(`normalized_payload`, '$.samples')), 0),
  '$.lapCount', COALESCE(json_array_length(json_extract(`normalized_payload`, '$.laps')), 0)
)
WHERE json_valid(`normalized_payload`);

UPDATE `import_items`
SET `normalized_payload` = json_set(
  json_remove(`normalized_payload`, '$.samples', '$.laps', '$.rawSummary'),
  '$.schemaVersion', 1,
  '$.adapterVersion', 'legacy',
  '$.sampleCount', COALESCE(json_array_length(json_extract(`normalized_payload`, '$.samples')), 0),
  '$.lapCount', COALESCE(json_array_length(json_extract(`normalized_payload`, '$.laps')), 0)
)
WHERE `normalized_payload` IS NOT NULL AND json_valid(`normalized_payload`);

UPDATE `activity_sources`
SET `identity_key` = (
  SELECT 'csv:legacy:' || a.`activity_type` || ':' || a.`start_time_utc`
  FROM `activities` a
  WHERE a.`id` = `activity_sources`.`activity_id`
)
WHERE `source_type` = 'CSV'
  AND `active` = 1
  AND `id` = (
    SELECT s2.`id`
    FROM `activity_sources` s2
    JOIN `activities` a2 ON a2.`id` = s2.`activity_id`
    JOIN `activities` a1 ON a1.`id` = `activity_sources`.`activity_id`
    WHERE s2.`source_type` = 'CSV'
      AND s2.`active` = 1
      AND a2.`activity_type` = a1.`activity_type`
      AND a2.`start_time_utc` = a1.`start_time_utc`
    ORDER BY s2.`created_at`, s2.`id`
    LIMIT 1
  );

CREATE UNIQUE INDEX `activity_sources_active_identity_uq`
ON `activity_sources` (`source_type`, `identity_key`)
WHERE `identity_key` IS NOT NULL AND `active` = 1;

CREATE INDEX `import_items_status_created_idx`
ON `import_items` (`status`, `created_at`);

CREATE INDEX `import_jobs_created_idx`
ON `import_jobs` (`created_at`, `id`);
