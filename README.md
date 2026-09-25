# PickBits Weaver

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

## How PickBits Weaver works

Weaver is opinionated about setup so that it can be trusted with a manuscript.
These are requirements, not suggestions:

1. **Your book lives in its own folder, under Git.** Every change has a
   history and can be undone. `weaver init` sets this up for you.
2. **Weaver is installed as a package, never copied into your book.** The AI
   that works on your book cannot change the tool.
3. **You work with an AI that can run commands,** such as Claude Code. Chat
   windows that can't run Weaver aren't supported.
4. **Your original files are never changed.** Import reads them; export writes
   new files.

`weaver doctor` checks all of this. Until it passes, Weaver won't write to your
book, and it tells you in plain words what to fix.

## Quick start

Requirements: Node.js 22 or newer. There are no runtime dependencies.

```bash
npm install --save-dev github:pickbitsai/weaver
npx weaver init ./my-book --id my-book --title "My Book"
npx weaver status --root ./my-book
npx weaver grounding 1-1 --root ./my-book
```

## Repair a finished book

Use one Weaver project for each book in a series. Start an empty book, import
the finished Word, Markdown, text, or folder source, then check and export it.
The original source is read-only and is never changed, moved, or renamed.

```bash
npx weaver init ./my-book --id my-book --title "My Book" --empty
npx weaver import ./finished-book.docx --root ./my-book
npx weaver check --root ./my-book
npx weaver export --format docx --out ./repaired-book.docx --root ./my-book
```

An imported book reports its narrative state as stale until a later workflow
bootstraps that derived state; this is expected, and its critical-path check
is skipped until a project-specific path is defined.

Scene prose uses Markdown-style `*italics*`; literal asterisks and backslashes
are escaped. Bold Markdown is intentionally unsupported and is imported as
literal text.

The GitHub install works today. The equivalent registry package will be
`@pickbitsai/weaver` after npm publication.

## Keep narrative state current

After writing or revising a scene, update its corresponding
`narrative-state/<chapter>-<scene>.md`, then explicitly accept the derived state:

```bash
npx weaver state:accept --root ./my-book
npx weaver check --root ./my-book
npx weaver release --root ./my-book --id beta-01
```

If an earlier scene changes, `state:status` marks it and all later scenes stale.
Re-derive them in order before accepting state again.

## Commands

| Command | Purpose |
| --- | --- |
| `init <directory>` | Create a generic book workspace |
| `import <source>` | Import a finished DOCX, Markdown, text file, or folder into an empty book |
| `export --format md\|docx --out <file>` | Export the current manuscript without overwriting the source or an existing file |
| `doctor` | Check the book folder, Git, host, and Weaver installation |
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

Each release contains per-scene prose, the accepted narrative-state snapshot,
and per-scene hashes in manifest reading order.

```bash
npm run preflight
```

The preflight scans the exact npm publish allowlist for local paths and
credential-shaped material, runs the behavioral and known-bad-fixture tests,
checks the starter project, then packs and installs the tarball into a blank
consumer project. A source checkout passing while the package is broken is not
considered a release.

## License

Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE). Keep NOTICE with any
copy or derivative. Versions up to and including 0.2.0 were released under the
MIT License.
