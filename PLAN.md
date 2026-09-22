# RunCoach Local Plan

## Approved milestone

M1/M1.1 and M2 are complete and frozen. M2.1 is complete: a repeatable performance baseline was established and accepted; premature optimization is deferred and the baseline remains in `docs/M2_1_PERFORMANCE_BASELINE.md`. M3 is complete and reviewer-accepted: Dashboard homepage, 12/26/52-week cross-activity trends, and activity-level canonical average heart rate weighted by effective moving duration; record-level heart-rate trends are explicitly future scope.

The approved current milestone is M4: training calendar and local training plans.

### M3 scope and batches (completed and reviewer-accepted)

1. [x] Batch 1: Dashboard homepage — `/` route, `GET /api/dashboard` (bounded, SQLite-aggregated), 7/28-day summaries, 12-week Monday-start volume trend with zero-filled weeks, up to five recent activities, and full loading/error/empty states.
2. [x] Batch 2: cross-activity trends — `/trends` with 12/26/52-week ranges, weekly volume/runs/pace/heart-rate trends.

M3 statistics scope: only `activityType = RUN` counts towards volume; windows are closed intervals of local dates ending today (derived from athlete settings timezone offset); activities are attributed by existing `activities.local_date`; moving duration falls back to duration; average pace is summed duration over summed distance. Trends added duration-weighted weekly/range heart rate: `sum(averageHeartRate × effectiveDuration) / sum(effectiveDuration)` over RUN activities with positive heart rate and positive effective duration, null without valid coverage; range summaries use range totals, never averages of weekly values. Trends reuses the dashboard's daily RUN aggregation so the two pages cannot drift.

### M4 scope and batches

1. [x] Batch 1: training calendar (`/calendar`), `0003_training_calendar.sql` with the `planned_workouts` table, planned-workout CRUD APIs, and the calendar projection of actual activities. **Reviewer-accepted.**
2. [x] Batch 2: plan completion status, manual one-to-one plan-to-activity links, adherence rate, and weekly rollups. **Implemented, awaiting reviewer acceptance.**

M4 Batch 2 design record:

- `0004_plan_completion.sql` (forward-only) adds `completion_status TEXT NOT NULL DEFAULT 'PLANNED'` and `linked_activity_id TEXT NULL REFERENCES activities(id) ON DELETE SET NULL` to `planned_workouts`, plus a partial unique index on `linked_activity_id` (one activity links to at most one plan; multiple NULLs allowed) and a `(scheduled_local_date, completion_status)` index for bounded rollups. Migrations 0000–0003 are untouched; legacy rows upgrade to `PLANNED` and re-running the migration set is idempotent.
- Status model: `PLANNED | COMPLETED | SKIPPED`. Linking an activity forces `COMPLETED`; `COMPLETED` may be manual (`linkedActivityId = null`); moving to `PLANNED` or `SKIPPED` always clears the link; the link can be swapped or removed; deleting a plan never touches the activity, sources, samples, laps, or import history. If the underlying activity is deleted, the foreign key sets the link to null and `COMPLETED` degrades to manual completion. "已逾期" (overdue) is a derived display of `PLANNED + scheduledLocalDate < today`, not a stored state.
- `PATCH /api/planned-workouts/:workoutId/completion` accepts a discriminated union (`{completionStatus:"PLANNED"}`, `{completionStatus:"SKIPPED"}`, `{completionStatus:"COMPLETED", linkedActivityId: string|null}`); status and link changes run in one transaction; missing plan 404, missing activity 404 `ACTIVITY_NOT_FOUND`, activity already linked to another plan 409 `ACTIVITY_ALREADY_LINKED` (no silent takeover). The ordinary PATCH keeps handling metadata fields only.
- `GET /api/training-summary?from&to`: closed interval, `from <= to`, at most 93 days, else 400. Returns `from`, `to`, `generatedForLocalDate`, `timezoneOffsetMinutes`, `summary`, `weeklyRollups`. "Today" is derived from the athlete settings `timezoneOffsetMinutes`, never server UTC. `eligibleCount = completedCount + skippedCount + overdueCount`; `adherenceRate = completedCount / eligibleCount`, a 0–1 fraction formatted by the frontend, `null` when `eligibleCount` is 0 (never 0/NaN/Infinity). Plans still `PLANNED` on today or later count as upcoming, never overdue, and never lower the current rate; manual and linked completions both count; all workout types (including REST/STRENGTH) use the same status semantics. Weekly rollups are Monday-start natural weeks covering every week intersecting the range (labels may extend past the range, counts only include `[from, to]`), oldest first, zero-filled weeks included.
- The calendar projection now carries `linkedActivity: CalendarActivitySummary | null` for in-range plans — a bounded summary (no samples/laps/sources) returned even when the linked activity's own date lies outside the queried range. Calendar and training summary keep a fixed query count independent of plan/activity counts and never read samples.
- Frontend: plan entries show text badges (待完成/已完成/已跳过/已逾期) with distinct styles; the plan editor offers 标记为已完成, 关联实际活动并完成, 标记为已跳过, 恢复为待完成, and 解除活动关联, using the in-range activities as link candidates; 409 errors surface as readable messages. The calendar page requests the training summary over the real month first-to-last dates (grid filler days excluded) and shows 本月计划数/已完成数/已跳过与逾期数/执行率 plus a weekly rollup table, with loading, error, empty, and `adherenceRate = null` ("暂无可计算计划") states; mobile uses a stacked list with no horizontal overflow.
- Still out of scope: automatic matching/suggestions, drag-and-drop or batch completion, one-plan-to-many-activities links, AI-generated plans, watch/Garmin writes, and all excluded items below.

M4 excludes AI-generated plans, watch/Garmin Connect writes, and all other items in the excluded list below.

### M2 included

- Routed `/activities`, `/activities/:activityId`, `/imports`, and `/settings` application pages.
- Cursor-paginated and filterable activities without source N+1 queries.
- Activity detail metadata separated from bounded, range-filtered series endpoints.
- Deterministic splits, half comparison, pace stability, heart-rate zones, aerobic decoupling, and pause analysis.
- Local athlete settings for heart-rate analysis, metric units, and UTC offset.
- Native FIT laps plus clearly labelled derived kilometre splits, chart zoom refinement, and offline route outline.
- Unit, API/integration, Playwright, build, and CI coverage while preserving all M1/M1.1 behavior.

### Excluded

- AI-generated training plans, DeepSeek/OpenAI or other model integrations, daily check-ins, ParroTao online synchronization, watch or Garmin Connect writes, authentication/multi-user, cloud synchronization, social features, online maps, installers, medical diagnosis, and injury advice.

## Acceptance flow

M1/M1.1 import and merge acceptance:

1. Import a CSV row and create one activity without time-series data.
2. Import its matching FIT file and retain the canonical activity ID.
3. Confirm sources are CSV and FIT, `hasTimeSeries` is true, and samples/laps exist.
4. Confirm FIT summary fields win while user-edited name and notes remain unchanged.
5. Confirm raw CSV data and FIT file remain available.
6. Re-import the FIT and receive an idempotent duplicate result without new samples.
7. Inject a merge failure and confirm the entire database transaction rolls back.

M2 acceptance, recorded results, and manual verification steps: `docs/M2_ACCEPTANCE.md`.

## Status

- [x] Requirements and architecture approved.
- [x] Workspace and persistent documentation.
- [x] Database schema and migration.
- [x] Import adapters, matching, merge, and audit.
- [x] REST API and minimal UI.
- [x] Automated verification, real private-sample smoke test, and handoff documentation.
- [x] M1.1 stable CSV identity, immutable refresh revisions, and compact source summaries.
- [x] M1.1 pending query/resolve loop, import history, UI, and Playwright/CI coverage.
- [x] M2 shared contracts, forward migration, and deterministic analytics.
- [x] M2 paginated activity and bounded series APIs plus athlete settings.
- [x] M2 routed application UI, charts, splits, route outline, and data details.
- [x] M2 final full-suite/private-fixture acceptance and handoff documentation.
- [x] M2.1 documentation sync and repeatable M2 performance baseline.
- [x] M2.1 closed: baseline accepted, premature optimization deferred with risks recorded.
- [x] M3 Batch 1: Dashboard homepage with bounded dashboard API, stats, weekly trend, and recent activities.
- [x] M3 Batch 2 and M3 acceptance: cross-activity trends page verified by reviewer.
- [x] M4 Batch 1: training calendar, planned-workout CRUD, and calendar projection (reviewer-accepted).
- [x] M4 Batch 2: plan completion status, one-to-one manual activity links, adherence rate, weekly rollups, and E2E coverage (implemented, awaiting reviewer acceptance; M4 as a whole is not yet accepted).

## M2 implementation record

- `0002_activity_analysis.sql` adds the one-row athlete settings table and list/source/series indexes without altering earlier migrations.
- Activity metadata no longer contains samples. `/series` validates requested metrics/range, filters in SQLite, and returns at most `maxPoints` extrema-preserving points.
- Deterministic analysis lives in `packages/analytics`; imported canonical values remain unchanged and derived values are labelled.
- The React application now routes `/activities`, `/activities/:activityId`, `/imports`, and `/settings`; the complete M1.1 import loop remains under `/imports`.
- Final acceptance on the M2 working tree: 27 public tests, 1 private-fixture smoke test, 2 Playwright flows, and all build/format/lint/typecheck commands pass. See `docs/M2_ACCEPTANCE.md` for the recorded results, API changes, and manual acceptance steps.
- Charts render pace on a dedicated inverted `min/km` axis so no series shows raw seconds per kilometre.

## Known constraints

- The project is private/personal, so the Garmin SDK license is acceptable for this milestone. Reassess before any redistribution.
- The supplied CSV has no explicit timezone. This adapter interprets its timestamps with the configured local offset, defaulting to `+08:00`, and records that the offset was configured rather than present in the source.
- Raw private samples live under `private-fixtures/` and are never committed.
- Migration `0001_import_hardening.sql` is forward-only. Back up the data directory before applying it; restoring that backup is the rollback strategy.
- Stable Drizzle 0.44 does not expose the later `node:sqlite` adapter, so this slice uses its supported `better-sqlite3` adapter. The native package installed successfully on the target Windows/Node 24 environment.
