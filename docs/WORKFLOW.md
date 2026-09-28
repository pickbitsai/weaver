# Writing and revision workflow

## The author's daily loop in the studio

Open the local page started by `weaver studio --root ./my-book`. On Home, check
approved chapters, open findings, and the doctor footer. Read Book by chapter
and scene; paragraph markers lead to the relevant finding. Character, Place,
and Thread pages provide the current story context.

On Jobs, run a chapter review or bootstrap story-so-far state. Read each new
state record there and explicitly accept it before release. Return to
Findings, read the cited passage and suggested repair, then choose **Fix this**,
**It's intended**, or **Allow**. Recheck a changed passage because its earlier
ruling may lapse. Open Changes to compare approved and new paragraphs and
their style findings. Approve or reject one chapter there. History records the
decisions and offers a confirmed undo of the last approval. The studio calls
the same engine operations as the matching commands below, including their
doctor refusal.

## 0. Check the setup

Before working on a book, run:

```bash
weaver doctor --root ./my-book
```

## Repair path

For each chapter, run `weaver review --chapter N --run`, then inspect
`weaver findings --chapter N`. Use `--all` to see lower-priority review notes.
Decide an item with `weaver rule <finding-id> --decision fix|allow|intended`.
Work from `weaver findings --to-fix --chapter N` for requested repairs, rerun
the reviews after prose changes, then approve the chapter. An allowed blocking
style finding appears in the approval and check audit output by ID.

For a finished book, create a separate Weaver project with `--empty`; this
removes the starter scene and starter critical-path fixture while preserving
the generic project configuration. Importing never merges with existing scene
files and never writes to the source document. A series uses one project per
book.

```bash
weaver init ./my-book --id my-book --title "My Book" --empty
weaver import ./finished-book.docx --root ./my-book
weaver status --root ./my-book
weaver check --root ./my-book
weaver export --format docx --out ./repaired-book.docx --root ./my-book
```

The repair path uses the same deterministic style-rules gate: `check` reports
blocking findings and `release` refuses them, while warnings remain advisory.

The import record under `imports/` preserves the source hash, front matter,
chapter and scene counts, POV decisions, and scene word counts. Imported books
begin with missing or stale narrative state by design; `check` reports that
state but does not fail on it until the project's state workflow is bootstrapped.

Before release, bootstrap the story-so-far records and facts ledger. The host
answers deterministic packets, then the author reviews and accepts the records:

```bash
weaver state bootstrap --run --root ./my-book
weaver state:accept --through 3-2 --root ./my-book
weaver facts build --root ./my-book
```

The interactive route is `weaver packet state --scene 1-1`, followed by
`weaver submit <packet-id> --file answer.md`. A malformed or deterministic
validation failure gets one host repair attempt. Scene facts must use registry
IDs (or `world`) and every quote must be a verbatim excerpt from that scene;
invalid answers are skipped and never written. Editing an earlier scene makes
its state and downstream state stale again, so bootstrap in reading order.

The repair path uses the same author approval boundary: imported or AI-edited
scene changes appear in `weaver changes`, and the author approves or rejects
one chapter at a time before continuing to state review and export.

For imported books, seed the registry from the imported POV headers, then build
profiles after the prose is in place:

```bash
weaver characters seed --root ./my-book
weaver voices build --root ./my-book
weaver voices check --root ./my-book
```

## 1. Lock the architecture

Before drafting, define the ending, scene-level beat map, reveal/reframe ledger,
and forward seed plan. Forward drafting is good at local continuity; it cannot
invent retroactive setup for an ending it did not know.

## 2. Prepare a scene

Run:

```bash
weaver grounding 1-1 --root ./my-book
```

Use the packet to establish the scene's structural position, entering character
states, prior reader knowledge, required change, and causal beat chain. Beats
should connect through complication or consequence, not merely chronology.
The reusable role prompt is in `prompts/architect.md`.

## 3. Draft

Install the Claude Code hooks once for this book so style rules run around AI
prose edits:

```bash
weaver hooks install --root ./my-book
```

The pre-hook supplies the editorial rules before an edit. The post-hook checks
the edited scene and reports or blocks deterministic findings. Hooks fail open,
so a hook problem never interrupts an edit; the rules gate in `check` and
`release` remains authoritative.

Write only the delta. Do not re-introduce familiar characters, settings,
relationships, or rules unless the scene deliberately re-anchors something the
reader may have forgotten. Preserve the project's voice constraints and end on
a changed state or resonant image.

## 4. Review

Run `weaver rules --root ./my-book` during drafting or repair to inspect style
findings directly. A blocking style finding makes `check` fail; warnings remain
visible without failing the gate.

Run `weaver voices check --scene <scene-id> --root ./my-book` while revising a
scene, or use `--pending` to inspect changed dialogue only. Voice findings show
the evidence lines that informed the warning and never block `check`, `approve`,
or release. Rebuild profiles after an accepted prose change with
`weaver voices build --root ./my-book`.

Profiles are built from the approved manuscript at `HEAD`. Working-tree edits
are checked against those profiles without making them stale; after
`weaver approve` succeeds, Weaver rebuilds the ignored derived profiles from
the new approval commit.

Run three independent lenses:

1. Continuity — facts, timeline, geography, knowledge boundaries, and active
   threads.
2. Style — voice, rhythm, imagery, dialogue, and project prohibitions.
3. Critic — scene function, causation, pacing, clarity, emotion, and hook.

Revise until continuity is clear, style drift is resolved or accepted, and the
critic passes. Major structural changes remain human-gated.
The reviewer prompts live under `prompts/reviewers/`.

## 5. Approve or reject the chapter

The author controls when AI edits enter the book. Inspect pending scene edits
with `weaver changes --root ./my-book`. Work on one chapter at a time:

```bash
weaver approve --chapter 1 --note "Reviewed opening" --root ./my-book
```

Approval creates a Git snapshot and refreshes each changed scene's derived word
footer. If the author does not want the edits, use
`weaver reject --chapter 1 --root ./my-book`; Weaver saves the rejected files
under `.weaver/rejected/` and restores the last approved text. Rejected copies
stay on disk and are ignored by Git. `weaver undo` creates a new revert commit,
and `weaver history` lists approvals and undos. Nothing is silently lost.

## 6. Update derived state

Update only what changed in `narrative-state/<scene-id>.md` and the cumulative
reader ledger. Then accept reviewed state:

```bash
weaver state:accept --root ./my-book --through 1-1
```

If an early scene is revised later, re-derive every stale scene in order.
`prompts/state-extractor.md` defines the generic delta format.

## 7. Verify and release

```bash
weaver check --root ./my-book
weaver release --root ./my-book --id beta-01
```

Use a new release ID whenever the manuscript changes. The generated manifest
records source and artifact hashes for traceability. Each release also contains
per-scene prose, the accepted narrative-state snapshot, and per-scene hashes in
reading order.
