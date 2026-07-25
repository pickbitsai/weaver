# Architecture

The atomic unit in Weaver is a scene. Chapters are ordered aggregates of scenes.

## Canonical source

`project.json` identifies the source root. By default, scenes live at:

```text
manuscript/chapter-01/scene-01/scene.md
```

Each scene has a metadata header and footer separated from its prose by `---`.
Reader releases contain only the prose between the first and last separator.

## Derived narrative state

Every scene may have a human-edited state record at
`narrative-state/<chapter>-<scene>.md`. The state describes only what changed:
facts established, facts last surfaced, character deltas, thread lifecycle,
timeline position, and the closing image.

`narrative-state/manifest.json` is a build stamp, not the source of truth. Each
record binds:

- the scene prose hash;
- the state file hash;
- the accepted upstream dependency hash.

Editing scene K invalidates state K and all state after K. This is the
novel-specific difference from an append-only chat or campaign memory system.

## Grounding injection

Before writing scene N, Weaver assembles:

- the target scene's locked outline beat;
- the previous accepted narrative-state record;
- the project reader-state ledger;
- the previous scene's closing prose;
- negative-framed constraints against re-introduction.

The packet is deterministic and auditable. Models may draft from it, but Weaver
does not hide state in a vector store or silently mutate the manuscript.

## Quality and releases

The check gate validates critical anchors, rejects unapproved high-similarity
cross-scene sentences, and optionally requires all narrative state to be
current. Releases are content-addressed and immutable by ID: a release ID cannot
be reused for a changed manuscript unless the caller explicitly forces a local
rebuild.
