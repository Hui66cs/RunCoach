# RunCoach Local Plan

## Approved milestone

The only approved work is the first vertical slice.

### Included

- pnpm workspace with React/Vite, Fastify, shared contracts, SQLite, Drizzle, Vitest, and a minimal UI.
- Import the supplied Chinese `Activities.csv` format through an explicit adapter and preserve every raw row.
- Decode FIT session, lap, and record messages with the official Garmin JavaScript FIT SDK.
- Store original files by SHA-256, detect duplicate FIT files, match candidates, and upgrade a CSV activity in place.
- Protect user-edited name and notes, track important field provenance, and audit merge changes.
- Show activities, sources, laps, and heart-rate/speed series.
- Unit and integration tests for matching, idempotency, transactional rollback, and user-edit protection.

### Excluded

- Dashboard, training plans, daily check-ins, trends, ParroTao online synchronization, DeepSeek, Codex App Server, authentication, cloud synchronization, backup/restore, and a production map.

## Acceptance flow

1. Import a CSV row and create one activity without time-series data.
2. Import its matching FIT file and retain the canonical activity ID.
3. Confirm sources are CSV and FIT, `hasTimeSeries` is true, and samples/laps exist.
4. Confirm FIT summary fields win while user-edited name and notes remain unchanged.
5. Confirm raw CSV data and FIT file remain available.
6. Re-import the FIT and receive an idempotent duplicate result without new samples.
7. Inject a merge failure and confirm the entire database transaction rolls back.

## Status

- [x] Requirements and architecture approved.
- [x] Workspace and persistent documentation.
- [x] Database schema and migration.
- [x] Import adapters, matching, merge, and audit.
- [x] REST API and minimal UI.
- [x] Automated verification, real private-sample smoke test, and handoff documentation.
- [x] M1.1 stable CSV identity, immutable refresh revisions, and compact source summaries.
- [x] M1.1 pending query/resolve loop, import history, UI, and Playwright/CI coverage.

## Known constraints

- The project is private/personal, so the Garmin SDK license is acceptable for this milestone. Reassess before any redistribution.
- The supplied CSV has no explicit timezone. This adapter interprets its timestamps with the configured local offset, defaulting to `+08:00`, and records that the offset was configured rather than present in the source.
- Raw private samples live under `private-fixtures/` and are never committed.
- Migration `0001_import_hardening.sql` is forward-only. Back up the data directory before applying it; restoring that backup is the rollback strategy.
- Stable Drizzle 0.44 does not expose the later `node:sqlite` adapter, so this slice uses its supported `better-sqlite3` adapter. The native package installed successfully on the target Windows/Node 24 environment.
