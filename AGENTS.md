# AGENTS.md

## Project

RunCoach Local is a single-user, local-first running training web application for Windows 11. Communicate with the user in Chinese and use English for code identifiers.

## Current milestone

Follow `PLAN.md`. Only the first vertical slice is approved: CSV/FIT import, canonical activity merge, minimal activity UI, and tests. Do not add dashboard, training plans, ParroTao online sync, AI providers, authentication, cloud deployment, social features, or a production map.

## Commands

Run from the repository root with PowerShell:

```powershell
pnpm install
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm dev
```

## Architecture rules

- Keep source adapters, normalization, matching, merge policy, persistence, HTTP handlers, and React UI separate.
- Model canonical activities separately from immutable import sources.
- Preserve original CSV rows and FIT files. FIT imports are idempotent by SHA-256.
- Merge in a SQLite transaction; preserve the canonical activity ID and roll back fully on failure.
- Field priority is `USER > FIT > PARROTAO > CSV`; null FIT values never replace non-null values.
- Store UTC timestamps plus the original local representation, offset, and stable local date.
- Validate external input with Zod. Avoid `any`; narrow unknown decoder output at the adapter boundary.
- Keep deterministic analytics as pure functions. Do not use an LLM for metrics.

## Safety and privacy

- Bind the server to `127.0.0.1` by default.
- Never commit `.env`, databases, raw imports, private fixtures, API keys, or real GPS data.
- Never log secrets or full private GPS tracks.
- Validate upload type and size and keep all resolved storage paths inside the configured data directory.
- Do not automatically commit Git changes.

## Definition of done

Before reporting completion, run formatter check, typecheck, lint, relevant unit/integration tests, and build. Report exact commands, results, changed files, design decisions, incomplete work, and risks.
