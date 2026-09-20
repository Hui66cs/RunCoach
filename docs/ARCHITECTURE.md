# Architecture

## Components

- `apps/web`: React/Vite UI and TanStack Query client.
- `apps/server`: Fastify REST API, SQLite persistence, file storage, and import orchestration.
- `packages/shared`: Zod contracts, domain types, units, and result types.
- `packages/importers`: source adapters, canonical normalization, pure candidate matching, and merge planning.
- `packages/analytics`: deterministic series utilities; initially chart downsampling only.

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

All changes for one import item use one database transaction. The original file is placed before the transaction, so the database never references a missing file. A failed transaction can leave only an unreferenced content-addressed blob, never partial activity data.

## Time and units

- UTC timestamps: ISO-8601 strings in the current schema.
- Stable local date: `YYYY-MM-DD` stored separately.
- CSV timezone: configured offset, recorded alongside the original timestamp.
- Distance: metres; duration: seconds; speed: metres/second; heart rate: bpm; cadence: steps/min; power: watts; elevation: metres.

## Trust boundaries

Multipart uploads, CSV rows, FIT decoder output, environment configuration, route parameters, and request bodies are validated or narrowed before domain use. Full GPS records and secrets are not logged.
