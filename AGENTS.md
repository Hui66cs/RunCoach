# AGENTS.md

## Project

RunCoach Local is a single-user, local-first running training web application for Windows 11. Communicate with the user in Chinese and use English for code identifiers.

## Current milestone

Follow `PLAN.md`. M1/M1.1 import and merge, M2 formal activity records, deterministic single-activity analysis, athlete settings, and bounded series APIs, and M2.1 performance hardening are complete, accepted, and frozen; all of them must remain compatible (`docs/M2_ACCEPTANCE.md`, `docs/M2_1_PERFORMANCE_BASELINE.md`). M2.1 established a repeatable performance baseline (`pnpm benchmark:m2`); the measured detail/series costs at 50k samples are acceptable for a single-user local application, so no further premature optimization is planned. The baseline and known risks remain recorded for future regression use.

The approved current milestone is M4: training calendar and local training plans; training calendars and manual planned workouts are no longer excluded scope. M3 (Dashboard and 12/26/52-week cross-activity trends) is complete and reviewer-accepted; record-level heart-rate trends remain future scope. M4 Batch 1 delivered the training calendar (`/calendar`), the `planned_workouts` table (`0003_training_calendar.sql`), and planned-workout CRUD — it is reviewer-accepted. Batch 2 (plan completion status, one-to-one plan-to-activity links, adherence rate, and weekly rollups, migration `0004_plan_completion.sql`, `PATCH /api/planned-workouts/:workoutId/completion`, `GET /api/training-summary`) is implemented and awaiting reviewer acceptance, so do not mark M4 done. Batch 2 rules: completion status is `PLANNED | COMPLETED | SKIPPED`; one plan links at most one activity and one activity at most one plan (unique index, `ON DELETE SET NULL`); `COMPLETED` may have no linked activity (manual completion); moving to `PLANNED`/`SKIPPED` always clears the link; `eligibleCount = completedCount + skippedCount + overdueCount` and `adherenceRate = completedCount / eligibleCount` (null when eligible is 0) with "today" derived from the athlete settings timezone offset; linking is always an explicit user action — automatic matching, multi-activity links, and AI-generated plans stay out of scope. Do not add AI-generated training plans, DeepSeek/OpenAI or other model integrations, ParroTao online sync, watch or Garmin Connect writes, daily check-ins, authentication/multi-user, cloud deployment, social features, online maps, installers, or medical conclusions.

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
