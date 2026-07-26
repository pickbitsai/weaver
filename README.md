# Weaver

Weaver is a reusable book-writing pipeline extracted from a production
long-form narrative system. It keeps a manuscript coherent across many writing
and revision sessions by treating reader knowledge as derived state with
explicit provenance and invalidation.

The initial extraction includes:

- canonical scene discovery and metadata-free reader assembly;
- manuscript and artifact hashing;
- downstream narrative-state invalidation after an earlier scene changes;
- grounding packets for the next writing pass;
- critical-path and high-similarity repetition gates;
- immutable Markdown and HTML reader releases;
- a generic project starter with outline, world-bible, style, and state files.
- reusable architect, continuity, style, critic, and state-extractor prompts.

It deliberately excludes Silent Guardian prose, characters, art, audio, secrets,
and project-specific production routes.

## Quick start

Requirements: Node.js 22 or newer. There are no runtime dependencies.

```bash
npm install --global @pickbitsai/weaver
weaver init ./my-book --id my-book --title "My Book"
weaver status --root ./my-book
weaver grounding 1-1 --root ./my-book
```

After writing or revising a scene, update its corresponding
`narrative-state/<chapter>-<scene>.md`, then explicitly accept the derived state:

```bash
weaver state:accept --root ./my-book
weaver check --root ./my-book
weaver release --root ./my-book --id beta-01
```

If an earlier scene changes, `state:status` marks it and all later scenes stale.
Re-derive them in order before accepting state again.

## Commands

| Command | Purpose |
| --- | --- |
| `init <directory>` | Create a generic book workspace |
| `status` | Summarize manuscript hash, words, scenes, and state freshness |
| `check` | Run project, critical-path, repetition, and state gates |
| `state:status` | Show current and stale derived-state records |
| `state:accept` | Stamp reviewed narrative state through a scene |
| `grounding <scene-id>` | Assemble the context packet for a writing pass |
| `release --id <id>` | Build an immutable Markdown/HTML reader release |

All commands except `init` accept `--root <book-directory>`. See
[docs/WORKFLOW.md](docs/WORKFLOW.md) for the full writing and revision loop and
[docs/ORIGIN.md](docs/ORIGIN.md) for extraction provenance.

## Inspect the loop

[`loop.manifest.json`](loop.manifest.json) describes the workflow as a
machine-readable graph: deterministic stages, model-assisted stages,
operator-controlled transitions, rejection paths, stop conditions, and the
evidence produced by every gate. [docs/LOOP.md](docs/LOOP.md) renders the same
contract for humans.

This is intentionally not another orchestration framework. The manifest makes
the shipped behavior inspectable and gives portfolio tools a stable surface to
visualize. The CLI remains plain Node.js.

## Release evidence

```bash
npm run preflight
```

The preflight scans the exact npm publish allowlist for local paths and
credential-shaped material, runs the behavioral and known-bad-fixture tests,
checks the starter project, then packs and installs the tarball into a blank
consumer project. A source checkout passing while the package is broken is not
considered a release.

## License

MIT © Mark Pickering and PickBits.AI
