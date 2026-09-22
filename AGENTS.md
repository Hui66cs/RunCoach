# AGENTS.md

## Project

RunCoach Local is a single-user, local-first running training web application for Windows 11. Communicate with the user in Chinese and use English for code identifiers.

## Current milestone

Follow `PLAN.md`. M1/M1.1 import and merge, M2 formal activity records, deterministic single-activity analysis, athlete settings, and bounded series APIs, and M2.1 performance hardening are complete, accepted, and frozen; all of them must remain compatible (`docs/M2_ACCEPTANCE.md`, `docs/M2_1_PERFORMANCE_BASELINE.md`). M2.1 established a repeatable performance baseline (`pnpm benchmark:m2`); the measured detail/series costs at 50k samples are acceptable for a single-user local application, so no further premature optimization is planned. The baseline and known risks remain recorded for future regression use.

The approved current milestone is M3: Dashboard and cross-activity trends; the dashboard is no longer excluded scope. Batch 1 delivers the user-facing Dashboard homepage (`/` route backed by `GET /api/dashboard`). Later M3 batches cover broader cross-activity trends; do not mark unplanned M3 features as done. Do not add training plans/calendar, daily check-ins, ParroTao online sync, AI providers, authentication/multi-user, cloud deployment, social features, online maps, installers, or medical conclusions.

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
