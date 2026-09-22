# Product Specification

## Product

RunCoach Local is a Chinese-language, single-user running training manager that stores its database and imported files on the user's Windows computer. It does not require a public server or user account.

## Completed M1/M1.1

The user can import the supplied activities CSV, see canonical activities, import a matching FIT file, and observe that the existing activity is upgraded rather than duplicated. The detail view shows its sources, FIT laps, and heart-rate/speed curves. Re-importing the same FIT is a no-op.

The user can edit an activity name and notes. Later source imports must preserve those edits.

The import report distinguishes created, upgraded, duplicate, pending-confirmation, and failed items. Medium-confidence and ambiguous matches require an explicit decision instead of an automatic merge.

The import workspace exposes three lightweight views: activities, pending decisions, and import history. A pending FIT can be attached only to a displayed candidate, created as a new canonical activity, or skipped after confirmation. Completed decisions are auditable and same-action retries are idempotent.

## Approved M2

The application provides routed activity, import, and settings workspaces. Users can filter and page activities, directly open a durable detail URL, edit name/notes, inspect native or derived splits, explore bounded time-series charts, and view an offline route outline when GPS exists.

All run analysis is deterministic and reports availability and data quality. Heart-rate zones require explicit athlete settings; age-based guesses and medical conclusions are prohibited. Imported summaries remain authoritative, while derived cadence, power, elevation, moving-time, and analysis values are labelled and never written over higher-trust source fields.

## Data guarantees

- A canonical activity can have multiple sources.
- Every original CSV row and FIT file is retained.
- FIT sensor and summary values have priority over CSV values when present.
- User-edited name and notes have priority over every imported source.
- Missing FIT values do not erase existing values.
- A failed merge leaves no partial source, sample, lap, provenance, or canonical update.
- CSV identity survives file rename, row reorder, and incremental export. Changed source content creates a new immutable revision while retaining the canonical activity ID.
- Source and pending JSON contain summaries and counts only; FIT series live in dedicated tables and the retained raw file remains authoritative.

## Out of scope after M2

Dashboard, cross-activity trends, training plans/calendar, daily status, ParroTao network calls, AI, authentication/multi-user, cloud features, social features, watch delivery, backup/restore, online mapping, installers, and medical advice are outside this milestone.
