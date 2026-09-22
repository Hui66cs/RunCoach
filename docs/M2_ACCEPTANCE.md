# M2 acceptance record

M2 turns RunCoach Local from an import verifier into a daily-use local activity browser with deterministic single-activity analysis. This document records what was delivered, the contract changes, the final verification results, and the manual acceptance steps. Algorithm definitions are authoritative in `docs/ARCHITECTURE.md`; this file references them instead of restating formulas.

## Delivered scope

- Routed application shell: `/activities`, `/activities/:activityId`, `/imports`, `/settings`.
- Cursor-paginated, filterable activity list without per-activity source queries.
- Activity detail split from bounded, range-filtered time-series endpoints.
- Deterministic splits, half comparison, pace stability, heart-rate zones, aerobic decoupling, and pause analysis in `packages/analytics`.
- Single-user athlete settings driven by a forward-only migration.
- Charts with legend toggles, linked tooltip, data zoom, zoom-driven refinement requests, and a `min/km` pace axis.
- Offline SVG route outline; no tile service and no GPS upload.

All M1/M1.1 import, refresh, upgrade, pending-resolution, and audit behavior is unchanged and still covered by its original tests.

## API contract changes

| Endpoint                                 | Notes                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/activities`                    | Query: `limit` (1–100, default 30), `cursor`, `dateFrom`, `dateTo` (`YYYY-MM-DD`), `activityType`, `sourceType` (CSV/FIT/PARROTAO), `q` (≤200 chars). Returns `{ items, nextCursor, total }`, ordered by start time descending. `400 INVALID_QUERY` otherwise.               |
| `GET /api/activities/:activityId`        | Returns summary, `sources`, `laps`, `provenance`, `mergeEvents`, `derivedSummary`, and `analysis`. **Never returns `samples`.** `404` when missing.                                                                                                                          |
| `GET /api/activities/:activityId/series` | Query: `metrics` (default `heartRate,pace`), `from`, `to` (elapsed seconds), `maxPoints` (10–5000, default 1000). Returns `{ activityId, metrics, from, to, totalPoints, returnedPoints, points }`. `400 INVALID_SERIES_QUERY` / `INVALID_SERIES_RANGE`, `404` when missing. |
| `GET /api/settings/athlete`              | Returns the single local athlete settings row.                                                                                                                                                                                                                               |
| `PATCH /api/settings/athlete`            | Partial update, at least one key. Bounds: max HR 100–240, resting 30–120, threshold 80–230, UTC offset −840…840. `400 INVALID_ATHLETE_SETTINGS` otherwise.                                                                                                                   |

Shared DTOs and query schemas live in `packages/shared` and are validated with Zod at the HTTP boundary. `ActivityAnalysis` results are structured as `{ status: 'AVAILABLE' | 'UNAVAILABLE', value, reason, dataQuality }`, so the UI never re-implements an analysis formula and never fabricates a value.

## Database migration

`apps/server/drizzle/0002_activity_analysis.sql` is additive and forward-only:

- Creates the single-row `athlete_settings` table (`CHECK (id = 'default')`) and inserts that row.
- Adds `activities_list_filter_idx (activity_type, local_date, start_time_utc, id)`.
- Adds `activity_sources_type_activity_active_idx (source_type, activity_id, active)`.
- Adds `activity_samples_activity_elapsed_idx (activity_id, elapsed_seconds)`.

No historical migration was modified and no derived summary cache columns were added. Cadence, power, elevation gain, and derived moving time are computed from samples on read and labelled as derived in the UI, so old databases remain fully usable after migration.

Back up the data directory before applying the migration to an existing installation.

## Analysis thresholds

All thresholds live in `ANALYSIS_THRESHOLDS` in `packages/analytics`; none are hard-coded in the UI.

| Constant                           | Value | Meaning                                                       |
| ---------------------------------- | ----- | ------------------------------------------------------------- |
| `minimumPaceSpeedMetersPerSecond`  | 0.2   | Below this, pace is unavailable instead of an infinite spike. |
| `movingSpeedMetersPerSecond`       | 0.5   | Below this, an interval counts as paused.                     |
| `pauseDistanceMeters`              | 5     | Distance gain below this supports a pause.                    |
| `maximumSampleGapSeconds`          | 120   | Larger gaps are excluded from analysis segments.              |
| `minimumDecouplingDurationSeconds` | 1200  | Minimum activity duration for decoupling.                     |
| `minimumDecouplingCoverage`        | 0.7   | Minimum valid speed/HR coverage for decoupling.               |
| `stableDecouplingPercent`          | 2     | Below this the drift is reported as `STABLE`.                 |

## Verification record (2026-09-21)

Run from the repository root with PowerShell:

| Command             | Result                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check` | Passed — all files use Prettier style.                                                                          |
| `pnpm typecheck`    | Passed — no diagnostics.                                                                                        |
| `pnpm lint`         | Passed — no ESLint findings.                                                                                    |
| `pnpm test`         | Passed — 5 files / 27 tests (analytics 7, matching 4, FIT adapter 1, import integration 10, API integration 5). |
| `pnpm test:private` | Passed — 1 private-sample test (real CSV rows, FIT upgrade, unrelated FIT).                                     |
| `pnpm test:e2e`     | Passed — 2 Playwright flows.                                                                                    |
| `pnpm build`        | Passed — packages, server, and web production build.                                                            |

Charts keep ECharts on demand: only `LineChart`, `GridComponent`, `LegendComponent`, `TooltipComponent`, `DataZoomComponent`, and `CanvasRenderer` are registered, and the chart module stays a separate dynamic chunk.

A manual browser pass over a synthetic FIT activity additionally confirmed that the chart renders without runtime errors, that the pace axis labels are `min/km` values (`1:40`, `3:20`, `5:00`), and that the linked tooltip reports `配速 6:22 /km` next to bpm and spm values.

## Manual acceptance steps

1. `pnpm dev`, then open `http://127.0.0.1:5173`; the app redirects to `/activities`.
2. On `/imports`, import a CSV row. The activity appears in `/activities` marked `无时序`.
3. Import the matching FIT file. The list row shows `CSV + FIT` and `有时序`.
4. Filter by date range, type, source, and keyword. Filters live in the URL query string and survive a refresh.
5. Open a detail page, then reload the URL directly. Summary cards render, and missing values show `—` rather than `0`.
6. Edit name and notes, save, and reload the page. The values persist and the button reports success without double-submitting.
7. Check the splits section: FIT activities show `FIT 原生圈段`; activities without laps show `派生公里分段` with a note that they are not native laps.
8. Toggle chart metrics and zoom with the slider. After zooming, the series request narrows its `from`/`to` range in the network panel. Pace renders on an inverted `min/km` axis.
9. With GPS present, the offline route outline appears; without GPS the whole section is hidden.
10. Expand `数据详情` for sources, field provenance, and merge events.
11. On `/settings`, set the maximum heart rate and save. Returning to the activity detail shows `Z1…Z5` durations. With no maximum heart rate configured, the detail page states that settings are required instead of showing made-up zones.
12. Open an activity with no heart rate and no samples: analysis cards show `UNAVAILABLE` reasons and the chart and route sections stay hidden.

## Playwright scenario coverage

| Scenario                                               | Where it is asserted                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| List, filter, and open a detail                        | `e2e/upgrade.spec.ts` (`/activities?sourceType=CSV`, name search)    |
| Direct detail URL                                      | `e2e/upgrade.spec.ts` (`page.goto(detailUrl)`, plus `page.reload()`) |
| Edit name/notes and keep them after refresh            | `e2e/upgrade.spec.ts`                                                |
| Splits and chart metric switching                      | `e2e/upgrade.spec.ts` (`FIT 原生圈段`, 功率 toggle)                  |
| Activity without GPS or heart rate                     | `e2e/upgrade.spec.ts` (chart and route outline are absent)           |
| Heart-rate zones after configuring max HR              | `e2e/upgrade.spec.ts` (`/settings` → `Z1`)                           |
| `/imports` still supports import, pending, and history | `e2e/pending.spec.ts`                                                |

E2E fixtures are synthetic. No real personal GPS or FIT data is committed or uploaded.

## Known limitations and risks

- `GET /api/activities/:activityId` loads the activity's samples to compute derived values and analysis. The response stays bounded, but very long activities do a full sample read per detail request. A derived-summary cache column is the natural follow-up if this becomes slow.
- Athlete settings expose a single heart-rate zone method (`MAX_HR_PERCENT`) and metric distance unit as validated literals; the settings page shows them read-only because M2 ships exactly one option each.
- An activity without a source activity ID cannot be distinguished from another activity of the same type starting in the same UTC second; such collisions inside one CSV are rejected explicitly.
- The supplied CSV has no explicit timezone, so its timestamps use the configured local offset (`RUNCOACH_LOCAL_OFFSET_MINUTES`, default `+08:00`) and the offset is recorded as configured rather than source-provided.
- The Playwright scenarios are grouped into two flows, so a failure points at a workflow rather than a single assertion.
- Private Garmin FIT support depends on an SDK whose license requires review before any redistribution; personal use is accepted for this milestone.
- No dashboard, cross-activity trends, training plan, ParroTao sync, AI coach, authentication, cloud sync, online map, or installer exists, and none should be inferred from this milestone.
