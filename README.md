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
3. **You work with an AI that can run commands,** such as Claude Code or local Codex. Chat
   windows that can't run Weaver aren't supported.
4. **Your original files are never changed.** Import reads them; export writes
   new files.

`weaver doctor` checks all of this. Until it passes, Weaver won't write to your
book, and it tells you in plain words what to fix.

## Guardrails

The AI edits prose; the author decides. Author commands (`approve`, `reject`,
`undo`, `rule`, `proposal`, `state:accept`, `release`, `import`, and `guard seal`) refuse in
Claude Code and Codex shells. The author page still works when an AI launches it.
Claude Code and Codex edit and shell hooks block protected settings and records, author
commands, Git history/config writes, tool installation changes, and requests to
the local author page. Ordinary prose edits, notes, checks, and reads stay available.

`weaver init` and `weaver hooks install` install the hooks and permission rules.
Claude's rules use `Bash(npx weaver approve:*)` and the equivalent forms for every
author command (bare `weaver`, `npx`, `npx --no-install`, and `npx.cmd`).
`Edit(/.claude/**)` and `Edit(/quality/**)` are anchored to the book's project
settings, apply to all built-in edit tools, and leave reads available. These use
the documented [Claude Code permission syntax](https://code.claude.com/docs/en/permissions).
Pre-hooks return the documented [deny decision](https://code.claude.com/docs/en/hooks#pretooluse-decision-control).
Claude permission bypass is disabled in the installed project settings.
Codex uses project hooks and forbidden command-prefix rules; see [Hosts](#hosts)
for the required one-time trust step.

At hand-over, PickBits runs `weaver guard seal` from an author shell. It records
CRLF-normalized SHA-256 fingerprints in `.weaver/guard.json` and commits that
seal with an approval trailer. It covers both book Claude settings files
(including an absent local file), `.codex/**`, `CLAUDE.md`, `AGENTS.md`, `project.json`, and
every file under `quality/`. Rulings live separately in `continuity/rulings.json`
and do not invalidate the seal. Intentional settings changes require review and
resealing; sealing commits only the seal, leaving other pending work untouched.

Doctor detects missing hooks or permission rules, disabled hooks in book or user
settings, changed sealed files, and manuscript commits without approval after
the most recent import or initial commit. Unsealed books and pending settings
changes produce warnings. The studio footer shows guardrail status and the first
problem, including warnings.

These guards are pattern matching, not a sandbox. The AI runs as the same user,
so a determined workaround is possible. They stop the normal paths and obvious
disguises; doctor, sealed settings, and approved history make changes that get
through visible. That visibility is the support line, not a tamper-proof audit:
someone able to rewrite both settings and history can also forge the records.

## Quick start

Requirements: Node.js 22 or newer. There are no runtime dependencies.

```bash
npm install --save-dev github:pickbitsai/weaver
npx weaver init ./my-book --id my-book --title "My Book"
npx weaver status --root ./my-book
npx weaver grounding 1-1 --root ./my-book
```

## Setting up a new computer

Authors start with [docs/START-HERE.md](docs/START-HERE.md): what to install,
where the book lives, the one-time steps for each AI, backup, the daily loop,
what never to do, and the words the author page uses.

PickBits runs the setup script with the author, in the author's own terminal:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-book.ps1 -Source <package> -Id my-book -Title "My Book"
```

```sh
sh scripts/setup-book.sh --source <package> --id my-book --title "My Book"
```

`setup-book.ps1` runs in Windows PowerShell 5.1 or later. `setup-book.sh` is POSIX
`sh` for macOS (bash or zsh) and Linux. Both take the same options: the tool
folder (`-ToolFolder`, `--tool-folder`; default `Weaver` in the home folder), the
book folder (`-BookFolder`, `--book-folder`; default the tool folder plus the id),
the package source (`-Source`, `--source`: a registry spec, a GitHub tag URL or a
local `.tgz`; optional once Weaver is installed), and a new book's id and title.
The book folder must be inside the tool folder, because the hooks find Weaver by
looking in the folders above the book.

Before writing anything, the script checks for Node.js 22 or newer, npm and Git,
warns when neither `codex` nor `claude` is on PATH, and refuses: folders in
OneDrive, Dropbox, iCloud Drive or Google Drive; a book folder outside the tool
folder; a non-empty folder that is not a Weaver book; and a run from inside an AI
session. It then installs Weaver in the tool folder, creates the book with
`weaver init --empty` (or uses the existing book), runs
`weaver hooks install --host both`, and runs `scripts/setup-guide.mjs`, which
reads `weaver doctor` and prints the remaining one-time steps in plain words:
folder trust, Codex `/hooks` trust, backup with
`weaver backup setup --remote <url>`, and the hand-over seal. It exits 0 when only
those steps remain. Running it again changes nothing that is already in place,
and it never edits either host's global configuration.

The scripts also refuse a tool or book folder inside `node_modules` (npm replaces
what is in it on every install), a Windows folder whose name has `&` or `^` in it
(npm's `.cmd` launchers, which both hosts' hooks use, can't start from there), and
a Windows reserved name such as `con` as the book id or a folder name. Given a
source, setup puts back the released files when Weaver's own files in the tool
folder were changed; a book folder with only `.DS_Store`, `desktop.ini` or
`Thumbs.db` in it counts as empty. Any other backup problem `weaver doctor`
reports (a failed, late or unchecked backup) is shown with doctor's own fix, and
only a book that has no backup yet gets the create-a-repository step. At the end,
setup prints the command that runs it again on that computer, without the package
source.

An AI session can't run setup: the shell guard refuses any command that names
`setup-book`, and the Claude Code deny rules (`Bash(*setup-book*)`,
`PowerShell(*setup-book*)`) and the Codex command rules cover the same scripts,
because setup installs Weaver itself. The setup tests install packages and start
PowerShell or `sh` many times, so `npm test` runs them as a separate, serial step
(`test/serial/`) after the rest of the suite.

## The studio

Start the local author page with `weaver studio --root ./my-book`. It listens
only on `127.0.0.1:4187`; open `http://127.0.0.1:4187/` on the same computer.
Use `--port N` to choose another port, or set `"studio": { "port": N }` in
`project.json`. The studio works offline and uses no web services for its pages.
Review, bootstrap, repair, and whole-book jobs use the book's configured command-line AI host.

The home page shows approval progress and findings. Book is the reader, with
chapter and scene status. Character pages show aliases, voice evidence, facts,
and spoken scenes. Places and Threads follow the facts ledger and narrative
state. Findings is the decision queue, Changes compares approved and new text,
History shows decisions and offers undo, and Jobs runs review or story-so-far
bootstrap and lets the author read and accept the resulting state. The doctor footer appears on every page. Every button performs the
same engine action as its matching Weaver command and obeys the same doctor
refusal. The author can read and decide entirely on the local page.

## Repair a finished book

Use one Weaver project for each book in a series. Start an empty book, import
the finished Word, Markdown, text, or folder source, then run the book and review its repair proposals.
The original source is read-only and is never changed, moved, or renamed.

```bash
npx weaver init ./my-book --id my-book --title "My Book" --empty
npx weaver import ./finished-book.docx --root ./my-book
npx weaver run --book --run --root ./my-book
npx weaver proposals --root ./my-book
npx weaver studio --root ./my-book
# Review the Proposals page, or accept selected edits from an author shell:
npx weaver proposal accept --chapter 1 --edits 1,3 --root ./my-book
npx weaver export --format docx --out ./repaired-book.docx --root ./my-book
```

The run checks rules, builds voices, records story-so-far state, runs every
review lens (including book reviewers), and proposes repairs chapter by chapter.
It makes one host call at a time. Repeating the command skips current records;
interruptions preserve completed scenes. `--through-chapter N` limits the run.
Omit `--run` to write packets without calling a host; answer a packet with
`weaver submit <packet-id> --file <answer>`. Add `--json` for the run record and
summary. Progress, attempts, errors, and timings live in `.weaver/runs/`.

Host timeouts and non-zero exits get two retries, after 30 and 120 seconds.
Set `"run": { "retry": { "delays_seconds": [30, 120] } }` in `project.json`
to change those waits. An exhausted unit is recorded as failed and the book
continues; a later run retries unfinished units. JSON contract errors get one
correction round. Tests use only synthetic books and fake hosts.

On Jobs, **Check whole book** runs this same process with live progress. On
Proposals, read the before/after word diffs, select edits, and **Accept selected**.
Acceptance applies those edits and records one chapter approval in Git. **Reject**
keeps the proposal in `.weaver/rejected/proposals/`; **Ask again** requests a fresh
proposal and can include an author note. The CLI equivalents are
`weaver proposal reject --chapter N --note "reason"` and
`weaver repair --chapter N --run --note "guidance"`. The AI never applies scene
edits in this flow. Declined findings and dropped edits keep their reasons.
Only proposals with kept edits are `ready`. If every edit is dropped and no
finding is declined, the status is `no-usable-edits`; Proposals and the book-run
summary show the drop reasons and how to **Ask again**. A response with declines
and no kept edits is `declined`.

Proposals cover blocking rules, voice warnings, queued judgments, and every
finding ruled **fix**, excluding **allow** and **intended** rulings. They contain
source Markdown, editorial rules, the character registry, world-bible context,
and voice evidence. Weaver checks exact paragraph matches, flagged locations,
unchanged paragraph counts, and word growth (default zero; configure
`"repair": { "max_growth_words": 0 }`). It reruns rules and voice checks in
memory and uses the same measured regression check as the pre-edit hook: a
blocking rule must not get worse in measured value or finding count. A finding
moving to another paragraph is not a regression. Scene and chapter counting
targets list every paragraph with a counted occurrence and give a numeric goal.
One target can have edits at several listed locations; partial reductions stay
in the proposal as `partly fixed: 6 → 4 (limit 1)`. Judgment repairs remain
proposals for the author to assess.
Changing prose, findings, rules, rulings, or packet context makes a proposal
stale. Acceptance refuses stale proposals, pending scene changes, and selections
that leave blocking findings; use a ruling or Ask again to resolve those.

Story-state acceptance remains explicit on Jobs or with `weaver state:accept`.
It saves the accepted state files, manifest, and facts ledger in one approval
commit. An edited scene makes that scene and all downstream state stale.
The imported book's critical-path check is skipped until a project-specific
path is defined. Export after working through the proposals.

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

## Reviews and triage

Run the continuity, style, critic, and configured book lenses for one chapter with
`weaver review --chapter 1 --run --root ./my-book`. The configured host runs the
review lenses with the configured concurrency. Omit `--run` to write interactive
packets, then use
`weaver submit <packet-id> --file <answer>`. Reviews cite a scene, paragraph,
and verbatim reader-text quote; invalid citations are dropped. A review becomes
out of date when its chapter prose, reviewer instructions, registry, or included
context changes.

`weaver findings --root ./my-book` gives the author one queue across rules,
voice, and reviews. Definite review problems enter the queue. A failing critic
adds at most its first two craft or definite findings. Other review findings
remain notes, visible with `weaver findings --all`. At most six review findings
are queued per chapter, with continuity before style before critic. The queue
also reports out-of-date reviews. Every finding has a stable ID.

## When an AI answer does not fit

Weaver records the verdict from the review's JSON block. It must be one of the
reviewer's words, but it may carry the reviewer's label (`STYLE: CONSISTENT`),
bold, other capitals or trailing punctuation. Anything else, such as
`MOSTLY CONSISTENT`, gets one repair round that names the allowed words. Quotes
are still checked word for word.

Weaver also reads the verdict lines around the JSON block, such as
`STYLE: DRIFT`, `**Style verdict:** drift` or `Verdict: DRIFT`, including
headings, list items and table rows, with `:`, `-`, `=` or `→` between label and
word. The answer's first line may also be just the word, or the label and the
word. If any such line names a different word, Weaver records the JSON verdict
and adds a warning to the review record and the command output. A line that
looks like a verdict line but names none of the words, such as
`STYLE: MOSTLY CONSISTENT`, also gets a warning. A missing verdict line is fine.
State answers may write their required headings as `### Heading`, `**Heading**`
or `## Heading:`; Weaver stores them as `## Heading`.

The latest failed answer to a packet stays in
`.weaver/packets/<packet-id>.answer.txt`, even after a later answer succeeds,
and failure messages give its full path. To try a corrected answer, edit that
file and submit it with `weaver submit <packet-id> --file <that file>`; Weaver
leaves the file you submitted exactly as you wrote it.

## Rulings

Decide once with `weaver rule <finding-id> --decision fix|allow|intended
--root ./my-book`. `fix` keeps the item in `weaver findings --to-fix`; `allow`
and `intended` suppress it while its paragraph stays unchanged. Editing the
paragraph lapses the ruling and shows the finding again with a lapse note.
`weaver rulings` shows active, lapsed, and resolved decisions. Each decision is
its own Git commit containing only `continuity/rulings.json`. Allowed blocking
style findings are listed by ID in `check` and `approve` output.

## Claude Code hooks

Run `weaver hooks install --host claude --root ./my-book` to merge Weaver's PreToolUse and
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

## Story-so-far setup

Imported books have prose but no trusted scene-by-scene story-so-far records.
Bootstrap derives those records and a facts ledger before release. Weaver only
builds packets and checks answers; a configured command-line host does the AI
work, and the author still accepts the resulting state:

```bash
npx weaver state bootstrap --run --root ./my-book
npx weaver state:accept --through 3-2 --root ./my-book
npx weaver facts build --root ./my-book
```

For an interactive Claude Code or Codex session, print one packet and submit its answer:

```bash
npx weaver packet state --scene 1-1 --root ./my-book
npx weaver submit <packet-id> --file ./answer.md --root ./my-book
```

Answers contain a Markdown narrative-state record and a fenced JSON facts
block. Every fact quote must be a verbatim 3–25 word excerpt from that scene;
quotes from elsewhere are rejected, including after the single repair round.
`continuity/facts.json` is deterministic derived state: it keeps facts in scene
order and records the first scene that establishes each normalized value.

## Hosts

Claude Code and Codex are supported for local book work, including local Codex
sessions in the ChatGPT desktop app. The AI edits prose; the author approves,
rejects, rules on findings, accepts story state, and releases the book.

Claude Code remains the default (`claude -p --output-format text`). Choose
Codex in `project.json`:

```json
{
  "hosts": ["claude", "codex"],
  "host": {
    "kind": "codex",
    "reasoning_effort": "medium",
    "timeout_seconds": 600,
    "concurrency": 2,
    "args": []
  }
}
```

`hosts` lists the hosts the author uses; it defaults to both. Doctor blocks
missing or inactive guards only for those hosts. `host.kind` selects the packet
runner. Override it for one call with `--host claude` or `--host codex` on
`run --book --run`, `review`, `repair`, or `state bootstrap`. The Jobs page has
the same selector, initially set to the project choice. An override does not
change the project file. When switching kinds, it uses that host's executable
and arguments instead of carrying the other host's command across.

`host.command` can select a custom executable. Claude's `args` replace its
default arguments; Codex's `args` are extra `exec` options, such as
`["--model", "a-model-you-can-use"]`. Codex receives the packet on stdin, runs
read-only with `--ephemeral` and `--skip-git-repo-check`, and writes its final
answer with `-o` into a temporary directory. Weaver consumes only that file,
cleans it after the attempt, and uses the same validation, repair, and retry
pipeline for either host. Reasoning effort defaults to `medium`; the chosen
model must support the configured level.

Weaver strips `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `CODEX_API_KEY` from host
processes. Codex packet calls select the OpenAI provider and require ChatGPT
login. Custom provider credential settings are outside this supported login
path; do not configure API providers for Weaver packets.

For a fresh machine:

1. Install Node.js 22 or newer, Git, Weaver, and the host CLI(s) you use. Run
   `claude` and finish sign-in for Claude Code. Run `codex login`, choose
   ChatGPT, and verify with `codex login status` for Codex.
2. Create the book with `weaver init <folder>`, which installs both sets of
   guards. For an existing book, run `npx weaver hooks install --host both`
   from its folder. Use `--host claude` or `--host codex` to repair just one.
   The installer merges unrelated configuration and is safe to repeat.
3. For Claude Code, open the book folder, accept its workspace trust prompt,
   and restart an existing session so it loads `.claude/settings.json`.
4. For Codex, open a **local** session in the book folder and trust the folder.
   Type `/hooks`, review and trust each Weaver hook, then restart Codex to load
   the project command rules. New or changed hook definitions require review
   again. `AGENTS.md` is discovered automatically; Weaver leaves it unchanged.
5. Run `npx weaver doctor`. On Windows, interactive writing needs a writable
   workspace: use `codex --sandbox workspace-write` if doctor reports read-only
   mode. Packet calls stay read-only. PickBits seals the installed book settings
   at hand-over with `npx weaver guard seal` from the author's own terminal.

Claude uses pre/post edit and shell hooks plus permission denials. Codex uses
`.codex/hooks.json` and `.codex/rules/weaver.rules`. Its patch handler checks
every file and move destination, reconstructs scene edits in memory, and uses
the same blocking-rule regression comparison as Claude. Remaining blocking
findings and advisory voice warnings are returned after editing. If a patch
cannot be reconstructed, that rule check fails open; path guards still run.

Codex 0.160.1 supports project command rules, so **no global installation is
needed**. The optional `--user-rules` flag explicitly also installs the rules
under `$CODEX_HOME/rules/weaver.rules` (normally `~/.codex/rules`). Those global
rules affect other projects too. Normal installation never changes either
host's global configuration or trusts hooks for you.

These are pattern-based guardrails running as the same operating-system user,
not an isolation boundary. Shell disguises, other tools, or direct changes can
get around them. Doctor, the settings seal (including `.codex/**`), and approved
history make covered changes visible. Codex's local hooks are not supported in
Work Cloud with local computer access; use a local Codex session for this
workflow. See [verified Codex CLI facts and limits](docs/codex-host.md).

## Your own checks

Add a reviewer at `quality/reviewers/<id>.md`, for example:

```markdown
---
id: character-audit
title: Character audit
verdicts: [CLEAR, FLAGS]
context: [world-bible, outline, style-guide, facts, previous-state]
queue: definite
---
Check every speaking character against the registry and world bible.
Report every supported contradiction, with a chapter quote and a small repair.
```

Front matter uses one `key: value` or `key: [a, b]` per line, with plain,
unquoted values and `#` comments, between `---` lines. No nested YAML or
multiline values are supported. `id`, `title`, `verdicts`, and `queue` are
required; ids are kebab-case, match the filename, and cannot replace a built-in.
The two distinct verdict words use letters, digits, underscores or hyphens and
start with a letter; the first means nothing to report. They must differ by more
than capital letters or underscores at their edges. `context` is any subset
of the five keys shown, defaults to `[world-bible]`, and can be `[]`.
The registry and chapter reader text are always included. `world-bible` reads
top-level Markdown notes, excluding voice profiles and unchanged starters;
`outline` reads Markdown recursively, excluding unchanged starters;
`style-guide` reads all top-level Markdown. Continuity and critic also receive
authored outline notes. With no authored outline, their packets keep the old
layout. Invalid reviewers are skipped with named warnings in `check` and `doctor`.

`queue: definite` queues only definite findings. `top-2` or `top-3` queues up to
that many definite and craft findings when the verdict is the second word,
prioritizing definite findings. Built-ins come first, then book reviewers in
filename order; the whole chapter still has at most six queued judgments.
`review --chapter N` and Studio's Run review include every valid reviewer;
`--lenses id,id` selects specific ones. Editing reviewer instructions or their
requested context makes existing records stale. The optional example at
[`templates/examples/reviewers/character-audit.md`](templates/examples/reviewers/character-audit.md)
is shipped with Weaver but is not installed by `init`.

Every rule in `quality/rules.json` can also use these character-registry id lists:

| Field | Applies to |
| --- | --- |
| `speakers: ["grell"]` | Only dialogue attributed to Grell |
| `except_speakers: ["grell"]` | Dialogue except lines attributed to Grell |
| `pov: ["tamsin"]` | Only scenes recorded as Tamsin's POV |
| `except_pov: ["tamsin"]` | Scenes outside Tamsin's POV |

Use ids from your own `world-bible/characters.json`; unknown ids are errors.
The four fields can be combined. Speaker filters restrict the rule to dialogue
and imply `scope: "dialogue"` when scope is omitted; `scope: "narration"` is an
error. **Only confident attribution earns an exemption:** unattributed dialogue
is skipped by `speakers`, but included by `except_speakers`. Likewise, scenes
without a recorded POV are skipped by `pov` and included by `except_pov`.
POV comes from scene metadata, including headings recorded during import;
registry ids, names and unambiguous aliases resolve to the same character.
Counting rules use only the selected text and its words or sentences, so exempt
text cannot trigger or dilute a finding. Findings explain their scope;
`rules --json` and Studio's Rules page show each configured scope.

Both kinds of checks live under `quality/`, part of the sealed book settings.
Changing them after hand-over is reported by `weaver doctor` under the existing
settings-seal checks.

## Commands

| Command | Purpose |
| --- | --- |
| `init <directory>` | Create a generic book workspace |
| `import <source>` | Import a finished DOCX, Markdown, text file, or folder into an empty book |
| `export --format md\|docx --out <file>` | Export the current manuscript without overwriting the source or an existing file |
| `doctor` | Check the book folder, Git, host, and Weaver installation |
| `studio` | Open the local author page (`--port N` supported) |
| `status` | Summarize manuscript hash, words, scenes, and state freshness |
| `check` | Run project, critical-path, repetition, and state gates |
| `rules` | Run deterministic style rules (`--scene`, `--json` supported) |
| `characters seed` | Add imported POV names to the character registry |
| `voices build` | Build deterministic character voice profiles |
| `voices check` | Show voice warnings (`--scene`, `--pending`, `--json` supported) |
| `review --chapter N` | Run or prepare chapter review lenses (`--lenses`, `--run` supported) |
| `findings` | Show the triaged queue (`--chapter`, `--all`, `--to-fix`, `--json` supported) |
| `rule <finding-id>` | Save an author decision (`--decision`, `--note` supported) |
| `rulings` | List active, lapsed, and resolved decisions (`--json` supported) |
| `changes` | Show pending scene edits grouped by chapter (`--json` supported) |
| `approve` | Save one chapter's pending edits as an approval |
| `reject` | Save and restore one chapter's pending edits |
| `undo` | Revert the most recent approval with a new Git commit |
| `history` | Show approvals and undos (`--json` supported) |
| `hooks install` | Install or merge Claude Code and Codex guards (both by default) |
| `state:status` | Show current and stale derived-state records |
| `state bootstrap` | Build story-so-far packets, optionally run them through the host |
| `state:accept` | Stamp reviewed narrative state through a scene |
| `packet state` | Print an interactive story-so-far packet |
| `submit` | Validate and record a packet answer |
| `facts build` | Rebuild the deterministic facts ledger |
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
