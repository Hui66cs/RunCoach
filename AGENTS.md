# AGENTS.md

## Project

RunCoach Local is a single-user, local-first running training web application for Windows 11. Communicate with the user in Chinese and use English for code identifiers.

## Current milestone

Follow `PLAN.md`. M1/M1.1 import and merge, M2 formal activity records, deterministic single-activity analysis, athlete settings, and bounded series APIs, and M2.1 performance hardening are complete, accepted, and frozen; all of them must remain compatible (`docs/M2_ACCEPTANCE.md`, `docs/M2_1_PERFORMANCE_BASELINE.md`). M2.1 established a repeatable performance baseline (`pnpm benchmark:m2`); the measured detail/series costs at 50k samples are acceptable for a single-user local application, so no further premature optimization is planned. The baseline and known risks remain recorded for future regression use.

The approved current milestone is M6: bounded training context and a server-side, read-only DeepSeek review. M3 (Dashboard and 12/26/52-week cross-activity trends) and M4 (training calendar, planned workouts, plan completion status, one-to-one plan-to-activity links, adherence rate and weekly rollups via migrations `0003_training_calendar.sql` and `0004_plan_completion.sql`) are stage-accepted (M4 verdict: PASS WITH FOLLOW-UP). M4 rules that must stay compatible: completion status is `PLANNED | COMPLETED | SKIPPED`; one plan links at most one activity and one activity at most one plan (unique index, `ON DELETE SET NULL`); `COMPLETED` may have no linked activity (manual completion); moving to `PLANNED`/`SKIPPED` always clears the link; `eligibleCount = completedCount + skippedCount + overdueCount` and `adherenceRate = completedCount / eligibleCount` (null when eligible is 0) with "today" derived from the athlete settings timezone offset; linking is always an explicit user action.

M5 Batch 1 (accepted) delivered the data/API foundation: migration `0005_daily_training_context.sql` adds four optional athlete profile fields to `athlete_settings` (`displayName`, `experienceLevel` = `BEGINNER|INTERMEDIATE|ADVANCED|null`, `primaryGoal`, `weeklyDistanceTargetMeters` as a positive integer ≤ 1,000,000 in meters) and the `daily_status_entries` table (one self-reported entry per local date, unique `local_date`, five 1–5 scales, resting heart rate 30–220, notes ≤ 2000 chars, no readiness/recovery/injury fields); `PATCH /api/settings/athlete` accepts and can clear the new profile fields; `GET /api/daily-status?from&to` (closed range ≤ 93 days), `PUT /api/daily-status/:localDate` (atomic upsert keyed by the unique date, 400 `INVALID_DAILY_STATUS` on invalid input) and `DELETE /api/daily-status/:localDate` (204, 404 when missing) are implemented in the repository/HTTP layers.

M5 Batch 2 (reviewer-accepted) turned these APIs into user-visible features: `/settings` now has an athlete profile section (name, experience level, primary goal, weekly target entered in km and stored as integer meters; profile PATCHes only send profile fields so heart-rate/timezone settings are never overwritten); a new `/daily-status` route with the 状态 navigation entry lets the user pick a date (default = athlete-timezone canonical today from `apps/web/src/local-date.ts`, a valid `?date=` always wins, max = today), fill the five 1–5 scales (directions labelled, e.g. 睡眠质量 1 很差–5 很好, each with an explicit 未填写 option), resting heart rate, and notes (char count, blank normalized to null by the shared schema), and save/edit/delete the entry with loading/error/empty/saving/delete-confirm states; a fully empty form never creates an all-null record.

M5 Batch 3 (reviewer-accepted) connected these pieces on the Dashboard homepage — frontend composition of the existing `GET /api/dashboard`, `GET /api/settings/athlete`, `GET /api/daily-status` and `GET /api/calendar` endpoints only, no new backend endpoint, schema, or contract change. The canonical today for the whole page is `dashboard.generatedForLocalDate`. New cards: personalized greeting (你好，{displayName}，falling back to 概览) with the primary goal as secondary text; a 今日状态 card (records/edit link carrying the canonical date, non-null fields shown, nulls shown as 未填写, never a readiness score); a 今日训练 card (all of today's plans with type/target/status badges and linked-activity links, handled in the calendar); a 本周跑量 card (actual = positive finite RUN distances within the Monday–Sunday current week from the calendar query, vs the profile weekly target, percent text may exceed 100 while the bar is capped at 100%; no target → link to settings, never a generated one); and a 近期计划 card (PLANNED plans in the next 7 local days excluding today, date/title/id order, max 5 with a calendar link when more). All cards stay visible even with zero activities, and the existing 7/28-day stats, 12-week trend, import guide, and recent activities are unchanged.

M5 Batch 4 (reviewer-accepted) is the daily-loop regression closeout: Calendar mutations also invalidate the `['calendar-plan']` prefix so the Dashboard's daily cards see plan create/edit/complete/relink/delete immediately; CSV/FIT imports and pending-import resolutions also invalidate `['dashboard']` and `['calendar-plan']`; daily-status and settings mutations already invalidated prefixes the Dashboard shares. A full real-flow closed-loop E2E guards the loop. With M5 Batch 4 accepted, M5 is stage-complete.

M6 Batch 1 (implemented, awaiting reviewer acceptance) delivers the bounded training context and server-side read-only DeepSeek integration: `POST /api/ai/review` (user-triggered, body `{windowDays: 7|28}` defaulting to 28) assembles `AiTrainingContext` exclusively from existing deterministic aggregates (dashboard 7/28-day run summaries, Monday-start weekly volumes intersecting the window, training-summary counts) — an explicit numeric/date whitelist that structurally excludes raw imports, samples, GPS, heart rate, daily status, free-text notes, and secrets. The injectable `TrainingReviewProvider` interface has a DeepSeek chat-completions adapter (`apps/server/src/services/ai/deepseek-provider.ts`); real calls require `RUNCOACH_AI_ENABLED=true` + `RUNCOACH_AI_PROVIDER=deepseek` + `RUNCOACH_DEEPSEEK_API_KEY`, are disabled by default, and the key never reaches the frontend, logs, or Git. Every failure maps to a stable sanitized error: 503 `AI_DISABLED`, 400 `INVALID_AI_REVIEW_REQUEST`, 504 `AI_TIMEOUT`, 429 `AI_RATE_LIMITED`, 502 `AI_PROVIDER_ERROR`/`AI_EMPTY_RESPONSE`/`AI_INVALID_OUTPUT` (review text capped at `MAX_AI_REVIEW_CHARS` = 4000). Requests and responses are Zod-validated; no code path writes to SQLite; no chat history table exists. AI output is informational only — never medical advice, readiness scores, or automatic plan adjustments. Do not add AI-generated training plans, additional LLM providers, chat/memory features, automatic data sending, ParroTao online sync, watch or Garmin Connect writes, daily check-ins (in the social sense), authentication/multi-user, cloud deployment, social features, online maps, installers, or medical conclusions.

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
