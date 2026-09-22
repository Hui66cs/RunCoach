CREATE TABLE planned_workouts (
  id TEXT PRIMARY KEY NOT NULL,
  scheduled_local_date TEXT NOT NULL,
  workout_type TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT,
  target_distance_meters REAL,
  target_duration_seconds REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX planned_workouts_date_idx ON planned_workouts (scheduled_local_date);
