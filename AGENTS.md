# AGENTS.md

## Project

RunCoach Local is a single-user, local-first running training web application for Windows 11. Communicate with the user in Chinese and use English for code identifiers.

## Current milestone

Follow `PLAN.md`. M1/M1.1 import and merge, M2 formal activity records, deterministic single-activity analysis, athlete settings, and bounded series APIs, and M2.1 performance hardening are complete, accepted, and frozen; all of them must remain compatible (`docs/M2_ACCEPTANCE.md`, `docs/M2_1_PERFORMANCE_BASELINE.md`). M2.1 established a repeatable performance baseline (`pnpm benchmark:m2`); the measured detail/series costs at 50k samples are acceptable for a single-user local application, so no further premature optimization is planned. The baseline and known risks remain recorded for future regression use.

The approved current milestone is M5: athlete profile and daily training context, building the daily-use loop (open the app → see the plan → record daily status → complete the training → link the activity). M3 (Dashboard and 12/26/52-week cross-activity trends) and M4 (training calendar, planned workouts, plan completion status, one-to-one plan-to-activity links, adherence rate and weekly rollups via migrations `0003_training_calendar.sql` and `0004_plan_completion.sql`) are stage-accepted (M4 verdict: PASS WITH FOLLOW-UP). M4 rules that must stay compatible: completion status is `PLANNED | COMPLETED | SKIPPED`; one plan links at most one activity and one activity at most one plan (unique index, `ON DELETE SET NULL`); `COMPLETED` may have no linked activity (manual completion); moving to `PLANNED`/`SKIPPED` always clears the link; `eligibleCount = completedCount + skippedCount + overdueCount` and `adherenceRate = completedCount / eligibleCount` (null when eligible is 0) with "today" derived from the athlete settings timezone offset; linking is always an explicit user action.

M5 Batch 1 (accepted) delivered the data/API foundation: migration `0005_daily_training_context.sql` adds four optional athlete profile fields to `athlete_settings` (`displayName`, `experienceLevel` = `BEGINNER|INTERMEDIATE|ADVANCED|null`, `primaryGoal`, `weeklyDistanceTargetMeters` as a positive integer ≤ 1,000,000 in meters) and the `daily_status_entries` table (one self-reported entry per local date, unique `local_date`, five 1–5 scales, resting heart rate 30–220, notes ≤ 2000 chars, no readiness/recovery/injury fields); `PATCH /api/settings/athlete` accepts and can clear the new profile fields; `GET /api/daily-status?from&to` (closed range ≤ 93 days), `PUT /api/daily-status/:localDate` (atomic upsert keyed by the unique date, 400 `INVALID_DAILY_STATUS` on invalid input) and `DELETE /api/daily-status/:localDate` (204, 404 when missing) are implemented in the repository/HTTP layers.

M5 Batch 2 (implemented, awaiting reviewer acceptance) turned these APIs into user-visible features: `/settings` now has an athlete profile section (name, experience level, primary goal, weekly target entered in km and stored as integer meters; profile PATCHes only send profile fields so heart-rate/timezone settings are never overwritten); a new `/daily-status` route with the 状态 navigation entry lets the user pick a date (default = athlete-timezone canonical today from `apps/web/src/local-date.ts`, a valid `?date=` always wins, max = today), fill the five 1–5 scales (directions labelled, e.g. 睡眠质量 1 很差–5 很好), resting heart rate, and notes (char count, blank normalized to null by the shared schema), and save/edit/delete the entry with loading/error/empty/saving/delete-confirm states; a fully empty form never creates an all-null record. Dashboard integration (daily status card, today's plan, recent plans) is NOT part of Batch 2 and remains future scope. Daily status never feeds medical conclusions, readiness scores, or automatic plan adjustments. Do not add AI-generated training plans, DeepSeek/OpenAI or other model integrations, ParroTao online sync, watch or Garmin Connect writes, daily check-ins (in the social sense), authentication/multi-user, cloud deployment, social features, online maps, installers, or medical conclusions.

## Commands

Run from the repository root with PowerShell:

```powershell
pnpm install
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm test:private
pnpm test:e2e
pnpm build
pnpm benchmark:m2
pnpm dev
```

## Architecture rules

- Keep source adapters, normalization, matching, merge policy, persistence, HTTP handlers, and React UI separate.
- Model canonical activities separately from immutable import sources.
- Preserve original CSV rows and FIT files. FIT imports are idempotent by SHA-256; CSV identity is independent of file name, file hash, row number, and column order.
- Merge in a SQLite transaction; preserve the canonical activity ID and roll back fully on failure.
- Field priority is `USER > FIT > PARROTAO > CSV`; null FIT values never replace non-null values.
- Store UTC timestamps plus the original local representation, offset, and stable local date.
- Validate external input with Zod. Avoid `any`; narrow unknown decoder output at the adapter boundary.
- Keep deterministic analytics as pure functions. Do not use an LLM for metrics.
- Activity detail responses must not include complete samples. Series queries filter ranges in SQL and return bounded, deterministic downsampled points.
- Derived analytics never overwrite imported canonical fields and must report availability, reason, and data quality.

## Safety and privacy

- Bind the server to `127.0.0.1` by default.
- Never commit `.env`, databases, raw imports, private fixtures, API keys, or real GPS data.
- Never log secrets or full private GPS tracks.
- Validate upload type and size and keep all resolved storage paths inside the configured data directory.
- Do not automatically commit Git changes.

## Definition of done

Before reporting completion, run formatter check, typecheck, lint, relevant unit/integration tests, and build. Report exact commands, results, changed files, design decisions, incomplete work, and risks.
