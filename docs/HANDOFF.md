# What a release guarantees downstream consumers

Weaver releases are immutable and content-addressed. Reusing a release ID for a
different manuscript hash throws instead of replacing the earlier release.

Each release contains extracted prose at `scenes/<scene-id>.md`. The
`source.scenes` array preserves reading order and records the source path, word
count, and SHA-256 hash for every scene.

The `narrative_state` field snapshots the accepted narrative-state manifest,
and the release copies available per-scene state deltas. That snapshot is
guaranteed current when `require_current_state_for_release` is true and
`gates.narrative_state_stale` is zero, reporting no stale scenes.

Every release payload is listed in `artifacts` with its byte size and SHA-256
hash. Consumers should validate `release-manifest.json` against
`contracts/release-manifest.schema.json` and read only immutable releases,
never the live project tree.
