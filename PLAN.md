# RunCoach Local Plan

## Approved milestone

M1/M1.1 and M2 are complete and frozen. M2.1 is complete: a repeatable performance baseline was established and accepted; premature optimization is deferred and the baseline remains in `docs/M2_1_PERFORMANCE_BASELINE.md`. M3 is complete and reviewer-accepted: Dashboard homepage, 12/26/52-week cross-activity trends, and activity-level canonical average heart rate weighted by effective moving duration; record-level heart-rate trends are explicitly future scope.

M4 (training calendar and local training plans) has completed stage acceptance with the verdict PASS WITH FOLLOW-UP: Batch 1 (calendar, planned-workout CRUD, calendar projection) and Batch 2 (plan completion status, manual one-to-one plan-to-activity links, adherence rate, weekly rollups) are both accepted at milestone-stage level, with follow-up items recorded for future batches.

The approved current milestone is M5: athlete profile and daily training context. Its overall goal is the daily-use loop — open the app, see today's plan, record daily status, complete the training, and link the activity — by (1) completing the athlete profile and daily status data model, (2) later surfacing daily status, today's plan, and recent plans on the Dashboard, and (3) keeping all determinism, privacy, and no-AI/no-medical rules intact.

### M3 scope and batches (completed and reviewer-accepted)

1. [x] Batch 1: Dashboard homepage — `/` route, `GET /api/dashboard` (bounded, SQLite-aggregated), 7/28-day summaries, 12-week Monday-start volume trend with zero-filled weeks, up to five recent activities, and full loading/error/empty states.
2. [x] Batch 2: cross-activity trends — `/trends` with 12/26/52-week ranges, weekly volume/runs/pace/heart-rate trends.

M3 statistics scope: only `activityType = RUN` counts towards volume; windows are closed intervals of local dates ending today (derived from athlete settings timezone offset); activities are attributed by existing `activities.local_date`; moving duration falls back to duration; average pace is summed duration over summed distance. Trends added duration-weighted weekly/range heart rate: `sum(averageHeartRate × effectiveDuration) / sum(effectiveDuration)` over RUN activities with positive heart rate and positive effective duration, null without valid coverage; range summaries use range totals, never averages of weekly values. Trends reuses the dashboard's daily RUN aggregation so the two pages cannot drift.

### M4 scope and batches

1. [x] Batch 1: training calendar (`/calendar`), `0003_training_calendar.sql` with the `planned_workouts` table, planned-workout CRUD APIs, and the calendar projection of actual activities. **Stage-accepted (M4 verdict: PASS WITH FOLLOW-UP).**
2. [x] Batch 2: plan completion status, manual one-to-one plan-to-activity links, adherence rate, and weekly rollups. **Stage-accepted (M4 verdict: PASS WITH FOLLOW-UP).**

M4 Batch 2 design record:

- `0004_plan_completion.sql` (forward-only) adds `completion_status TEXT NOT NULL DEFAULT 'PLANNED'` and `linked_activity_id TEXT NULL REFERENCES activities(id) ON DELETE SET NULL` to `planned_workouts`, plus a partial unique index on `linked_activity_id` (one activity links to at most one plan; multiple NULLs allowed) and a `(scheduled_local_date, completion_status)` index for bounded rollups. Migrations 0000–0003 are untouched; legacy rows upgrade to `PLANNED` and re-running the migration set is idempotent.
- Status model: `PLANNED | COMPLETED | SKIPPED`. Linking an activity forces `COMPLETED`; `COMPLETED` may be manual (`linkedActivityId = null`); moving to `PLANNED` or `SKIPPED` always clears the link; the link can be swapped or removed; deleting a plan never touches the activity, sources, samples, laps, or import history. If the underlying activity is deleted, the foreign key sets the link to null and `COMPLETED` degrades to manual completion. "已逾期" (overdue) is a derived display of `PLANNED + scheduledLocalDate < today`, not a stored state.
- `PATCH /api/planned-workouts/:workoutId/completion` accepts a discriminated union (`{completionStatus:"PLANNED"}`, `{completionStatus:"SKIPPED"}`, `{completionStatus:"COMPLETED", linkedActivityId: string|null}`); status and link changes run in one transaction; missing plan 404, missing activity 404 `ACTIVITY_NOT_FOUND`, activity already linked to another plan 409 `ACTIVITY_ALREADY_LINKED` (no silent takeover). The ordinary PATCH keeps handling metadata fields only.
- `GET /api/training-summary?from&to`: closed interval, `from <= to`, at most 93 days, else 400. Returns `from`, `to`, `generatedForLocalDate`, `timezoneOffsetMinutes`, `summary`, `weeklyRollups`. "Today" is derived from the athlete settings `timezoneOffsetMinutes`, never server UTC. `eligibleCount = completedCount + skippedCount + overdueCount`; `adherenceRate = completedCount / eligibleCount`, a 0–1 fraction formatted by the frontend, `null` when `eligibleCount` is 0 (never 0/NaN/Infinity). Plans still `PLANNED` on today or later count as upcoming, never overdue, and never lower the current rate; manual and linked completions both count; all workout types (including REST/STRENGTH) use the same status semantics. Weekly rollups are Monday-start natural weeks covering every week intersecting the range (labels may extend past the range, counts only include `[from, to]`), oldest first, zero-filled weeks included.
- Frontend canonical today: the calendar page derives "today" with the same athlete settings `timezoneOffsetMinutes` as the server (`epochMs + offset` shifted to a UTC date in `apps/web/src/local-date.ts`, never the browser timezone). This feeds the default/fallback month, the 今天 button, the 添加训练 default date, the today highlight, and the 待完成/已逾期 badges, so a plan shown as 已逾期 can never be counted as upcoming by the same page's summary; the summary's `generatedForLocalDate` is rendered as visible proof of the shared source. A valid `?month=YYYY-MM` always wins; only a missing or invalid parameter falls back to the athlete-timezone current month, with a deterministic browser-offset fallback while settings load and a single URL replace once they settle.
- The calendar projection now carries `linkedActivity: CalendarActivitySummary | null` for in-range plans — a bounded summary (no samples/laps/sources) returned even when the linked activity's own date lies outside the queried range. Calendar and training summary keep a fixed query count independent of plan/activity counts and never read samples.
- Frontend: plan entries show text badges (待完成/已完成/已跳过/已逾期) with distinct styles; the plan editor offers 标记为已完成, 关联实际活动并完成 (PLANNED), 标记为已跳过, 恢复为待完成, 解除活动关联（保持已完成）, and — for COMPLETED plans — a direct 补充关联活动 (no link yet) / 更换关联活动 (already linked) picker that attaches or swaps the activity without restoring to PLANNED; SKIPPED must be restored before linking. Candidates are the in-range activities; 409 errors surface as readable messages; metadata form state is never submitted by completion actions. The calendar page requests the training summary over the real month first-to-last dates (grid filler days excluded) and shows 本月计划数/已完成数/已跳过与逾期数/执行率 plus a weekly rollup table, with loading, error, empty, and `adherenceRate = null` ("暂无可计算计划") states; mobile uses a stacked list with no horizontal overflow.
- Still out of scope: automatic matching/suggestions, drag-and-drop or batch completion, one-plan-to-many-activities links, AI-generated plans, watch/Garmin writes, and all excluded items below.

M4 excludes AI-generated plans, watch/Garmin Connect writes, and all other items in the excluded list below.

### M5 scope and batches

Overall goal: complete the athlete profile and daily training context, then connect daily status, today's plan, and recent plans into the Dashboard so the daily loop becomes: open the app → view the plan → record status → complete the training → link the activity.

1. [x] Batch 1: athlete profile fields and daily status data/API foundation — **reviewer-accepted**. Delivered:
   - `0005_daily_training_context.sql` (forward-only, 0000–0004 untouched): adds `display_name`, `experience_level` (`BEGINNER|INTERMEDIATE|ADVANCED`, nullable), `primary_goal`, and `weekly_distance_target_meters` (positive integer ≤ 1,000,000 meters, frontend converts to km) to `athlete_settings`; creates `daily_status_entries` with a unique `local_date` index, five nullable 1–5 self-report scales (sleep quality, fatigue, muscle soreness, stress, motivation), resting heart rate 30–220, notes ≤ 2000 chars, and DB CHECK constraints. No `athleteId`, no readiness/recovery/injury-risk fields.
   - `PATCH /api/settings/athlete` (existing endpoint) now also accepts the profile fields; explicit `null` clears them; trimmed empty strings are rejected so empty values never reach the database.
   - `GET /api/daily-status?from&to`: closed local-date range, `from <= to`, at most 93 days, ascending by `local_date`, no zero-filling; invalid query → `400 INVALID_DAILY_STATUS_QUERY`.
   - `PUT /api/daily-status/:localDate`: atomic upsert keyed by the unique date (repeat submissions never create a second row); `createdAt` survives updates, `updatedAt` refreshes; absent fields keep their value, explicit `null` clears a field; at least one editable field required; unknown fields rejected; invalid date/body → `400 INVALID_DAILY_STATUS`.
   - `DELETE /api/daily-status/:localDate`: 204 on success, `404 NOT_FOUND` when missing; never touches activities, planned workouts, sources, samples, laps, or import history.
   - Range queries filter in SQL over the unique `local_date` index with a fixed query count (no N+1) and never read samples.
2. [x] Batch 2: frontend entry points for the athlete profile and daily status — **reviewer-accepted**. Delivered:
   - `/settings`: an athlete profile section editing `displayName`, `experienceLevel`, `primaryGoal`, and `weeklyDistanceTargetMeters` (km input, integer meters on the wire, blank sends null to clear). Profile saves PATCH profile fields only, so the existing heart-rate/timezone form and its data are never overwritten; loading never clobbers existing values; success/error feedback is in Chinese and fields refill after reload.
   - `/daily-status` route + 状态 navigation entry: date picker (valid `?date=YYYY-MM-DD` always wins; missing/invalid falls back to the athlete-timezone canonical today via `apps/web/src/local-date.ts`, browser-offset fallback while settings load, single URL replace; date input max = canonical today; 今天 button), five 1–5 scales with visible direction labels, resting heart rate 30–220 bpm with frontend validation, notes with char count (blank normalized to null by the shared schema), save/edit/delete through `GET/PUT/DELETE /api/daily-status` with the query cache keyed by date; loading/error/empty ("当天尚未记录")/saving/delete-confirm states; a fully empty form is blocked with guidance instead of creating an all-null row; date switching never leaks another date's data; mobile has no horizontal overflow.
   - Still not implemented (later M5 batch): Dashboard daily-status card, today's plan, and recent plans.
3. [x] Batch 3: Dashboard 日常训练闭环整合 — **implemented, awaiting reviewer acceptance**. Delivered:
   - Frontend composition of existing APIs only (`/api/dashboard`, `/api/settings/athlete`, `/api/daily-status`, `/api/calendar`); no new endpoint, schema, or contract change.
   - Canonical today for the whole page is `dashboard.generatedForLocalDate`; a new pure module `apps/web/src/dashboard-plan.ts` derives the bounded calendar window (`from` = current week Monday, `to` = max(week Sunday, today + 7 days), ≤14 inclusive dates) and selects today's plans, upcoming plans (PLANNED only, next 7 local days excluding today, date/title/id order, max 5 with hasMore), and the week's positive finite RUN distance (planned targets never count). All helpers have Vitest coverage including Monday boundaries and year rollover.
   - Dashboard cards: personalized greeting (你好，{displayName}，falls back to 概览) with the primary goal as secondary text; 今日状态 (today = canonical date, 未记录 → 记录今日状态 link carrying the date, recorded → non-null fields shown with nulls as 未填写, local error only in the card); 今日训练 (all of today's plans with title/type/target/status badge and linked-activity links; 在日历中处理 link to the month); 本周跑量 (actual vs profile target with percentage; the progress bar is capped at 100% while the text may exceed it; no target → settings link, never a generated one); 近期计划 (max 5 + 在日历中查看 when more, explicit empty state).
   - All daily-loop cards remain visible with zero activities; the existing 7/28-day stats, 12-week trend, import guide, and recent activities are unchanged.
   - Still not implemented: readiness/recovery scores, training advice, medical conclusions, automatic plan adjustments — permanently out of scope.

M5 still excludes: readiness/recovery composite scores, training advice or automatic plan adjustments, medical or injury judgements, auto-linking plans to activities, and every item in the excluded list below.

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
- [x] M4 Batch 1: training calendar, planned-workout CRUD, and calendar projection (stage-accepted; M4 verdict PASS WITH FOLLOW-UP).
- [x] M4 Batch 2: plan completion status, one-to-one manual activity links, adherence rate, weekly rollups, and E2E coverage (stage-accepted; M4 verdict PASS WITH FOLLOW-UP).
- [x] M4 stage acceptance recorded (PASS WITH FOLLOW-UP); M5 approved as the current milestone.
- [x] M5 Batch 1: athlete profile fields and daily status data/API foundation (reviewer-accepted).
- [x] M5 Batch 2: `/settings` athlete profile form and `/daily-status` create/edit/delete page (reviewer-accepted).
- [x] M5 Batch 3: Dashboard daily-loop integration (implemented, awaiting reviewer acceptance).

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
