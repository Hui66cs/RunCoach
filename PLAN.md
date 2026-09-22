# RunCoach Local Plan

## Approved milestone

M1/M1.1 and M2 are complete and frozen. M2.1 is complete: a repeatable performance baseline was established and accepted; the measured 50k-sample detail/series costs are acceptable for a single-user local application, so premature optimization is deferred. The baseline and known risks remain in `docs/M2_1_PERFORMANCE_BASELINE.md` for future regression use.

The approved current milestone is M3: Dashboard and cross-activity trends.

### M3 scope and batches

1. [x] Batch 1: Dashboard homepage — `/` route, `GET /api/dashboard` (bounded, SQLite-aggregated), 7/28-day summaries, 12-week Monday-start volume trend with zero-filled weeks, up to five recent activities, and full loading/error/empty states.
2. [x] Batch 2: cross-activity trends page — `/trends` route with 12/26/52-week range switch (`?weeks=` in URL), `GET /api/trends` (bounded, SQLite-aggregated), weekly volume/runs chart, weekly pace (inverted min/km axis) and duration-weighted heart-rate trends with explicit empty states. **Awaiting reviewer acceptance; the rest of M3 is not complete.**

Statistics scope for Batch 1: only `activityType = RUN` counts towards volume; windows are closed intervals of local dates ending today (derived from athlete settings timezone offset); activities are attributed by existing `activities.local_date`; moving duration falls back to duration; average pace is summed duration over summed distance.

Batch 2 inherits the same scope and adds duration-weighted weekly/range heart rate: `sum(averageHeartRate × effectiveDuration) / sum(effectiveDuration)` over RUN activities with positive heart rate and positive effective duration, null without valid coverage; range summaries use range totals, never averages of weekly values. Trends reuses the dashboard's daily RUN aggregation so the two pages cannot drift.

### M2 included

- Routed `/activities`, `/activities/:activityId`, `/imports`, and `/settings` application pages.
- Cursor-paginated and filterable activities without source N+1 queries.
- Activity detail metadata separated from bounded, range-filtered series endpoints.
- Deterministic splits, half comparison, pace stability, heart-rate zones, aerobic decoupling, and pause analysis.
- Local athlete settings for heart-rate analysis, metric units, and UTC offset.
- Native FIT laps plus clearly labelled derived kilometre splits, chart zoom refinement, and offline route outline.
- Unit, API/integration, Playwright, build, and CI coverage while preserving all M1/M1.1 behavior.

### Excluded

- Training plans/calendar, daily check-ins, ParroTao online synchronization, DeepSeek, Codex App Server, any AI coach, authentication/multi-user, cloud synchronization, social features, online maps, installers, medical diagnosis, and injury advice.

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
