# ADR 0001: Official Garmin FIT JavaScript SDK

## Status

Accepted for the private, personal-use vertical slice.

## Decision

Use `@garmin/fitsdk` behind `GarminFitAdapter`. The adapter is the only code that observes decoder output and immediately narrows it into `NormalizedActivity`, `NormalizedLap`, and `NormalizedSample`.

## Rationale and consequences

The official decoder validates FIT integrity and supports current session, lap, record, developer, and unknown fields. Its generated TypeScript barrel declarations currently omit `.js` extensions and do not resolve correctly under `moduleResolution: NodeNext`, so the repository contains a minimal local declaration for only the runtime surface it uses.

The SDK has a restrictive Garmin license rather than a standard open-source license. This decision is valid only while the application remains private and personal. Public source or binary redistribution requires a new license review and likely an MIT-licensed adapter implementation.
