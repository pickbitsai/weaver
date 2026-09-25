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

## Style rules

Books may define deterministic prose checks in `quality/rules.json`. Rules are
versioned, have a unique id, a severity (`block` or `warn`), and a plain author
message. Weaver supports em-dash counts, phrase lists, sentence-start shares,
repeated sentence starts, per-paragraph counts, and custom regular expressions.
Rules run on reader text: escaped punctuation is unescaped and italic markers
are removed before measuring. A rule can apply to all text, narration, or
dialogue. Dialogue is text inside straight or curly quotes; an opening quote at
the start of the next paragraph continues a multi-paragraph speech. This is a
simple editorial heuristic, not a full Markdown or natural-language parser.

Run `weaver rules --root ./my-book` for a human report or add `--json` for a
machine-readable result. Blocking findings fail `check` and prevent release;
warnings are reported but do not fail the gate.

## Character voice

The character registry at `world-bible/characters.json` is the author's explicit
list of speakers. `weaver characters seed` adds POV names recorded by import;
it never removes or overwrites an entry. Template books start with an empty
registry. A registry entry has an id, display name, optional aliases, and a POV
flag, for example:

```json
{ "id": "brask", "name": "Brask", "aliases": ["the sergeant"], "pov": true }
```

Dialogue attribution is deliberately conservative. A quoted span is attributed
only by a nearby registry name or alias plus a supported speech verb, by an
action beat naming exactly one registry character outside the quote, or by
continuation from a previous paragraph that opened a quote. Names are whole
words, aliases beginning with `the` are case-insensitive, and pronoun-only tags
such as `she said` remain unattributed. Quotes whose speaker cannot be
determined are excluded from profiles and checks. This is a deterministic
heuristic, not a general-purpose dialogue parser.

Build profiles from all attributed reader text with:

```bash
npx weaver voices build --root ./my-book
npx weaver voices check --root ./my-book
npx weaver voices check --pending --root ./my-book
```

Profiles record line and word totals, sentence shape, contractions, profanity,
formal markers, sentence punctuation shares, distinctive words, and up to five
typical evidence lines. Evidence requires at least 8 attributed lines and 80
words. A smaller profile reports `not enough of their lines yet (N lines, M
words)` and produces no finding. Optional author additions live in
`quality/voice.json` under `profanity` and `formal`.

Voice profiles are derived from the last approved Git commit, not the working
tree. `weaver approve` rebuilds them after its approval commit. They are local
derived files under `world-bible/voices/` and are ignored by the book's
`.gitignore`, so editing them never creates pending scene changes.

Voice checks use a combined per-feature z-distance threshold of 4.0, with zero
variance guarded, and call a line “sounds like” another sufficiently evidenced
character only when that character is at least 1.0 distance unit closer and a
distinctive word, hard-contrast feature, or unusually large distance margin
supports the comparison. Hard contrasts cover profanity against a zero-rate
profile with at least 150 words and the long formal/conversational contrast
described by the command output. Profiles are stamped with the approved
manuscript hash and Git commit; working-tree edits do not make them stale.
Voice findings are warnings for the author to judge; Weaver never decides that
a voice is right.

## Claude Code hooks

Run `weaver hooks install --root ./my-book` to merge Weaver's PreToolUse and
PostToolUse hooks into `.claude/settings.json`. The pre-hook supplies the
editorial rules and rule messages before scene edits, and the post-hook checks
the edited scene and blocks only when a blocking rule fires. Hooks fail open on
malformed input or internal errors; `check` and `release` remain authoritative.

The GitHub install works today. The equivalent registry package will be
`@pickbitsai/weaver` after npm publication.

## Approving changes

The author decides what enters the book. AI scene edits stay pending until the
author approves them, and only one chapter is approved or rejected at a time:

```bash
npx weaver changes --root ./my-book
npx weaver approve --chapter 1 --note "Opening pass" --root ./my-book
npx weaver reject --chapter 1 --root ./my-book
npx weaver undo --root ./my-book
npx weaver history --root ./my-book
```

`changes` shows the scenes, word changes, and style findings waiting for the
author. `approve` saves an approval as a Git commit, while `reject` saves the
rejected text under `.weaver/rejected/` before restoring the last approved
text. `undo` creates a Git revert, so history is never rewritten. Rejected
copies are kept on disk and ignored by Git; `history` shows approvals and
undos. Nothing is ever silently discarded.

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
| `rules` | Run deterministic style rules (`--scene`, `--json` supported) |
| `characters seed` | Add imported POV names to the character registry |
| `voices build` | Build deterministic character voice profiles |
| `voices check` | Show voice warnings (`--scene`, `--pending`, `--json` supported) |
| `changes` | Show pending scene edits grouped by chapter (`--json` supported) |
| `approve` | Save one chapter's pending edits as an approval |
| `reject` | Save and restore one chapter's pending edits |
| `undo` | Revert the most recent approval with a new Git commit |
| `history` | Show approvals and undos (`--json` supported) |
| `hooks install` | Install or merge Claude Code scene-edit hooks |
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
