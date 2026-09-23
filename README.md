# RunCoach Local

RunCoach Local is a single-user, local-first running activity manager. M1/M1.1 provide durable CSV/FIT import and canonical merging. M2 adds formal activity browsing, bounded time-series retrieval, deterministic single-run analysis, and local athlete settings. M3 adds the Dashboard homepage and 12/26/52-week cross-activity trends. M4 adds the training calendar, planned workouts, plan completion status, manual plan-to-activity links, and adherence rollups. M5 Batch 1 adds athlete profile fields and the daily-status data/API foundation (frontend entry points come in a later batch). Everything runs and stays on this machine.

## Requirements

- Windows 11 and PowerShell 5.1 or later
- Node.js 24
- pnpm version pinned in `package.json`

Do not install dependencies while `NODE_TLS_REJECT_UNAUTHORIZED=0`. Fix the local certificate or proxy configuration first.

## Setup

```powershell
corepack enable
pnpm install
Copy-Item .env.example .env
pnpm db:migrate
pnpm dev
```

The web application uses `http://127.0.0.1:5173`; the API uses `http://127.0.0.1:3100`.

## Private samples

Place private files in:

```text
private-fixtures/Activities.csv
private-fixtures/exist_test.fit
private-fixtures/non_exist_test.fit
```

This directory is ignored by Git. Never put API keys, private FIT files, GPS exports, or databases in committed fixtures.

The supported CSV adapter is intentionally tied to the supplied sample headers. Other CSV formats must receive a separate adapter or an explicit mapping flow; they are not guessed.

## Commands

```powershell
pnpm dev
pnpm format
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm test:private
pnpm exec playwright install chromium
pnpm test:e2e
pnpm build
pnpm db:migrate
```

Runtime data defaults to `.local-data` in development. Override it with `RUNCOACH_DATA_DIR`. CSV timestamps use `RUNCOACH_LOCAL_OFFSET_MINUTES`, defaulting to `480` (`+08:00`).

Before applying a new migration to an existing data directory, stop the development server and copy the complete data directory as a backup. M2 migration `0002_activity_analysis.sql` is additive and forward-only.

## Import management

The UI has Activity, Pending, and Import History views. Medium-confidence FIT matches can be attached to a recorded candidate, created as a new activity, or skipped. Resolution always re-reads and verifies the retained FIT file. CSV re-exports use a stable activity identity, so renaming or reordering an export does not duplicate canonical activities; changed rows create immutable source revisions.

## Application

- `/`: Dashboard with the daily training loop — today's status, today's plans, weekly distance vs the profile target, upcoming plans — plus 7/28-day summaries, a 12-week Monday-start volume trend, and recent activities. Deterministic data only: no readiness scores, training advice, or medical conclusions.
- `/activities`: paginated, filterable formal activity list.
- `/activities/:activityId`: summary, native/derived splits, deterministic analysis, bounded interactive charts, offline route outline, and folded data provenance.
- `/calendar`: monthly training calendar with planned workouts, completion status (待完成/已完成/已跳过/已逾期), manual plan-to-activity links, and monthly/weekly adherence.
- `/daily-status`: private, local daily self-report (sleep, fatigue, muscle soreness, stress, motivation on 1–5 scales, resting heart rate, notes) with per-date create/edit/delete; no medical conclusions and no training advice.
- `/trends`: 12/26/52-week cross-activity volume, pace, and heart-rate trends.
- `/imports`: the complete M1.1 upload, pending-resolution, and history loop.
- `/settings`: local athlete heart-rate and timezone settings used by deterministic analysis, plus the athlete profile editor (name, experience level, primary goal, weekly distance target in km, stored as meters).

Complete samples remain in SQLite. Activity detail metadata does not return them; `/series` applies SQL range filtering and bounded deterministic downsampling. The daily-status REST API exists since M5 Batch 1, and its frontend entry point landed in M5 Batch 2; the Dashboard daily-status card and today's plan are still a later M5 batch.

Charts render pace on a dedicated inverted `min/km` axis. Acceptance results, API changes, and manual verification steps are recorded in `docs/M2_ACCEPTANCE.md`.

## Current limitations

- No AI coach, automatic training suggestions, readiness/recovery scores, medical conclusions, ParroTao online sync, watch/Garmin Connect writes, authentication, backup/restore, online map, or cloud services.
- A source system without an activity ID cannot distinguish two activities of the same type starting in the same UTC second. A collision within one CSV is rejected explicitly.
- Distribution is not supported because the selected Garmin FIT SDK has license restrictions that require review before redistribution.
