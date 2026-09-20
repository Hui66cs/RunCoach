# ADR 0002: Drizzle with better-sqlite3

## Status

Accepted for the first vertical slice.

## Decision

Use stable Drizzle ORM with `better-sqlite3`. Enable foreign keys, WAL, `synchronous=NORMAL`, and a five-second busy timeout.

## Rationale and consequences

The installed stable Drizzle 0.44 release supports `better-sqlite3` but does not expose the planned `node:sqlite` adapter. Moving to an unstable Drizzle release would create more migration risk than using the established synchronous driver in this single-user local server. The package's prebuilt binary installs successfully on the target Windows x64 and Node 24 environment.

This introduces a native dependency. Node upgrades must be verified against an available prebuild before adoption. Revisit `node:sqlite` after it is present in the pinned stable Drizzle version.
