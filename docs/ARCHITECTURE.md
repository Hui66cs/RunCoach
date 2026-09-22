# Architecture

## Components

- `apps/web`: React/Vite UI and TanStack Query client.
- `apps/server`: Fastify REST API, SQLite persistence, file storage, and import orchestration.
- `packages/shared`: Zod contracts, domain types, units, and result types.
- `packages/importers`: source adapters, canonical normalization, pure candidate matching, and merge planning.
- `packages/analytics`: pure deterministic downsampling, splits, run comparison, heart-rate zones, decoupling, and pause analysis.

HTTP handlers never contain matching or merge rules. Adapters do not write the database. The import service coordinates files, adapters, matching, and a repository transaction.

## Runtime data

Production data belongs under `%LOCALAPPDATA%\RunCoach Local\data`; development defaults to `.local-data`.

```text
data-root/
  runcoach.db
  raw/{sha256-prefix}/{sha256}.{extension}
  staging/
```

Raw files are immutable and content-addressed. Database paths are relative to the data root. The server binds to `127.0.0.1` unless explicitly configured otherwise.

## Persistence

SQLite uses Drizzle with `better-sqlite3`, foreign keys, WAL, a busy timeout, and explicit migrations. The stable Drizzle release used by this project does not yet expose its later `node:sqlite` adapter; `better-sqlite3` installed from a Windows/Node 24 prebuilt binary. Canonical summary columns remain queryable on `activities`; raw source values and current provenance remain separate. FIT samples are normalized rows indexed by activity/source/time rather than a single JSON document and are inserted in bounded batches inside one transaction.

All changes for one import item use one database transaction. Pending resolution claims an item with `PENDING -> RESOLVING` in the same immediate write transaction as source, canonical, series, provenance, audit, and completion writes. The original file is placed before the transaction, so the database never references a missing file. A failed transaction can leave only an unreferenced content-addressed blob, never partial activity data; a sanitized retryable error may be recorded after rollback.

`activity_sources.normalized_payload` and pending payloads use `NormalizedActivitySummary`, not record/lap arrays. Dedicated sample/lap tables and the verified raw FIT file are authoritative. Resolve verifies path containment, size, and SHA-256, then decodes outside the write transaction and rechecks state inside it.

The React shell coordinates queries and navigation. Import, pending, history, confirmation, and lazy series-chart components are separate. ECharts uses core-only line/grid/tooltip/legend/canvas registrations and is split into a dynamic chunk.

M2 separates activity metadata from time series. List queries aggregate active source types in one query path. Detail returns summary, laps, provenance, audit, and structured analysis but no sample rows. Series requests validate metrics/ranges, filter by activity and timestamp in SQL, then apply deterministic extrema-preserving downsampling to a bounded response. GPS is rendered locally as SVG and is never requested from a tile service.

Single-user athlete settings live in their own one-row table. They influence analysis output only; derived results never overwrite canonical imported fields.

## Deterministic analysis definitions

- Pace is `1000 / speed` in seconds per kilometre; speeds below `0.2 m/s` are unavailable rather than infinite pace.
- Kilometre splits interpolate elapsed time at each 1000 m boundary. A final shorter split is retained and marked partial. Native FIT laps and derived splits remain distinct.
- Half comparison uses cumulative distance when at least 1 km is available and elapsed time otherwise. It compares duration-weighted pace and heart rate across valid segments.
- Pace stability uses only complete valid kilometre splits. It reports population standard deviation and coefficient of variation, and is unavailable with fewer than two splits.
- Maximum-heart-rate zones use `[<60%, 60–70%, 70–80%, 80–90%, >=90%]`. Duration is accumulated from adjacent timestamps, not sample counts. Gaps above 15 minutes are excluded.
- Aerobic decoupling is experimental: `(first speed/HR - second speed/HR) / first speed/HR * 100`. It requires at least 20 minutes and 70% valid moving speed/heart-rate coverage; positive values mean lower efficiency in the second half.
- Pause analysis treats an interval as paused only when speed is below `0.5 m/s` and distance gain is below 5 m. Gaps above 120 seconds are excluded.
- Downsampling always retains endpoints and bucket extrema; it never changes rows stored in SQLite.

## M2 migration

`0002_activity_analysis.sql` creates the single `athlete_settings` row and adds composite indexes for activity filters, active source filters, and activity/elapsed series ranges. It is additive and forward-only. No imported summary or derived analysis cache columns are added; cadence, power, elevation gain, and derived moving time are computed from samples and labelled as derived.

## Time and units

- UTC timestamps: ISO-8601 strings in the current schema.
- Stable local date: `YYYY-MM-DD` stored separately.
- CSV timezone: configured offset, recorded alongside the original timestamp.
- Distance: metres; duration: seconds; speed: metres/second; heart rate: bpm; cadence: steps/min; power: watts; elevation: metres.

## Trust boundaries

Multipart uploads, CSV rows, FIT decoder output, environment configuration, route parameters, and request bodies are validated or narrowed before domain use. Full GPS records and secrets are not logged.
