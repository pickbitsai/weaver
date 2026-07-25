# Weaver

Weaver is the reusable book-writing pipeline extracted from
`MrPickering/silentguardian-`. It keeps a long-form manuscript coherent across
many writing and revision sessions by treating reader knowledge as derived
state with explicit provenance and invalidation.

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

```powershell
npm test
node scripts/weaver.mjs init C:\new\my-book --id my-book --title "My Book"
node scripts/weaver.mjs status --root C:\new\my-book
node scripts/weaver.mjs grounding 1-1 --root C:\new\my-book
```

After writing or revising a scene, update its corresponding
`narrative-state/<chapter>-<scene>.md`, then explicitly accept the derived state:

```powershell
node C:\new\Weaver\scripts\weaver.mjs state:accept --root C:\new\my-book
node C:\new\Weaver\scripts\weaver.mjs check --root C:\new\my-book
node C:\new\Weaver\scripts\weaver.mjs release --root C:\new\my-book --id beta-01
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
