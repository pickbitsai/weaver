# Extraction provenance

Weaver was extracted on 2026-07-25 from an internal long-form narrative
production system.

This is a clean extraction, not a copy of the whole source repository. The
implementation was made story-agnostic, stripped of external service
dependencies, and tested against a synthetic starter book. No manuscript prose,
Silent Guardian world-bible material, generated releases, audiovisual assets,
environment files, or secrets were transferred.

The public extraction keeps only the reusable mechanisms:

- derived reader state with source and upstream hashes;
- downstream invalidation after an earlier scene changes;
- deterministic grounding packets;
- explicit state acceptance;
- quality gates and immutable release IDs;
- generic prompts and a synthetic starter book.

The release preflight scans the exact npm package allowlist and installs the
resulting tarball into a blank project. That test is the executable boundary
between the private production system and this repository.
