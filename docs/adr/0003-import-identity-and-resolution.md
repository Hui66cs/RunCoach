# ADR 0003: Stable CSV Identity and Pending Resolution

## Status

Accepted for M1.1.

## Context

The supplied CSV has no stable upstream activity ID. File hash plus row number changes after rename, reorder, or incremental export. Pending FIT matches also need a safe user decision loop without retaining duplicate time-series JSON.

## Decision

Use a versioned hash of activity type and normalized UTC start time as CSV source identity, plus a separately sorted raw-row content hash. Treat changed content as an immutable source revision and never change the canonical activity ID. Reject two equal identities in one upload.

Store only `NormalizedActivitySummary` in source and pending JSON. On pending resolution, verify and decode the retained raw FIT again. Claim and complete the item in the same SQLite immediate transaction as all domain writes. Candidate versions protect attach decisions from stale canonical data.

## Consequences

Renames, row reorder, and incremental exports are idempotent. Summary corrections can refresh CSV-owned fields without overwriting USER, FIT, or PARROTAO provenance. Two same-type activities beginning in the same UTC second remain inherently ambiguous and are reported as collisions. Resolution depends on the retained raw FIT; missing or changed files are conflicts, never a reason to use stale series JSON.
