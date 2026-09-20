# Product Specification

## Product

RunCoach Local is a Chinese-language, single-user running training manager that stores its database and imported files on the user's Windows computer. It does not require a public server or user account.

## Approved first vertical slice

The user can import the supplied activities CSV, see canonical activities, import a matching FIT file, and observe that the existing activity is upgraded rather than duplicated. The detail view shows its sources, FIT laps, and heart-rate/speed curves. Re-importing the same FIT is a no-op.

The user can edit an activity name and notes. Later source imports must preserve those edits.

The import report distinguishes created, upgraded, duplicate, pending-confirmation, and failed items. Medium-confidence and ambiguous matches require an explicit decision instead of an automatic merge.

## Data guarantees

- A canonical activity can have multiple sources.
- Every original CSV row and FIT file is retained.
- FIT sensor and summary values have priority over CSV values when present.
- User-edited name and notes have priority over every imported source.
- Missing FIT values do not erase existing values.
- A failed merge leaves no partial source, sample, lap, provenance, or canonical update.

## Out of scope

Dashboard, training plans, daily status, trend analysis beyond displayed imported curves, ParroTao network calls, AI, authentication, cloud features, social features, watch delivery, backup/restore, and formal mapping are outside this milestone.
