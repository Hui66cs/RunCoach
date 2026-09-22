ALTER TABLE planned_workouts ADD COLUMN completion_status TEXT NOT NULL DEFAULT 'PLANNED';
ALTER TABLE planned_workouts ADD COLUMN linked_activity_id TEXT REFERENCES activities(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX planned_workouts_linked_activity_uq
  ON planned_workouts (linked_activity_id)
  WHERE linked_activity_id IS NOT NULL;
CREATE INDEX planned_workouts_date_status_idx ON planned_workouts (scheduled_local_date, completion_status);
