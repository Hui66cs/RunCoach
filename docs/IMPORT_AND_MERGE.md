# Import and Merge

## Pipeline

1. Limit and read an upload, calculate SHA-256, and save it in content-addressed storage.
2. Decode it through a source-specific adapter.
3. Validate a `NormalizedActivity` at the adapter boundary.
4. Find plausible canonical candidates and score them with the centralized matching policy.
5. Produce `AUTO_MERGE`, `PENDING_CONFIRMATION`, or `CREATE_NEW`.
6. Recheck identities and apply one item in a SQLite transaction.
7. Write a merge audit and import result.

## Source identities

- FIT identity is the raw file SHA-256 and is globally unique.
- Supplied CSV identity is `file-sha256:row-number`, unique within source type.
- Original raw rows are stored on `activity_sources`; the complete CSV file is retained in `raw_files`.

## Matching

Candidates must be type-compatible, within 30 minutes, and have distance or duration evidence. Scores total 100:

- start time: 40;
- distance: 25;
- duration: 20;
- type: 10;
- device: 5.

Automatic matching requires a score of at least 85, sufficient evidence, and a 15-point lead over the second candidate. Scores from 65 to 84, close competing candidates, uncertain time, or a second distinct FIT become pending confirmation. Lower scores create a new activity.

## Merge policy

Priority is `USER > FIT > PARROTAO > CSV`. Each field is considered separately. Null or missing values never replace a non-null canonical value. Name and notes with user-edit flags are never changed by import.

Attaching FIT to CSV keeps `activities.id`, adds a FIT source, inserts FIT-owned samples and laps, updates reliable summary fields, sets `has_time_series`, records current field provenance, and writes before/after audit snapshots.

## Idempotency and rollback

A repeated FIT hash returns `DUPLICATE_SKIPPED` and inserts no source, sample, or lap. Database constraints provide a second line of defense against concurrent duplicate imports.

Any exception during source, sample, lap, canonical, provenance, or audit writes aborts the complete item transaction. The import item can record failure afterward without preserving partial domain changes.

## Pending decisions

A pending import item retains the normalized candidate and raw-file reference. Resolution must explicitly attach it to a selected activity, create a new activity, or skip it. No candidate is silently selected.
