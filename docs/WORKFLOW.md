# Writing and revision workflow

## 0. Check the setup

Before working on a book, run:

```bash
weaver doctor --root ./my-book
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

Write only the delta. Do not re-introduce familiar characters, settings,
relationships, or rules unless the scene deliberately re-anchors something the
reader may have forgotten. Preserve the project's voice constraints and end on
a changed state or resonant image.

## 4. Review

Run three independent lenses:

1. Continuity — facts, timeline, geography, knowledge boundaries, and active
   threads.
2. Style — voice, rhythm, imagery, dialogue, and project prohibitions.
3. Critic — scene function, causation, pacing, clarity, emotion, and hook.

Revise until continuity is clear, style drift is resolved or accepted, and the
critic passes. Major structural changes remain human-gated.
The reviewer prompts live under `prompts/reviewers/`.

## 5. Update derived state

Update only what changed in `narrative-state/<scene-id>.md` and the cumulative
reader ledger. Then accept reviewed state:

```bash
weaver state:accept --root ./my-book --through 1-1
```

If an early scene is revised later, re-derive every stale scene in order.
`prompts/state-extractor.md` defines the generic delta format.

## 6. Verify and release

```bash
weaver check --root ./my-book
weaver release --root ./my-book --id beta-01
```

Use a new release ID whenever the manuscript changes. The generated manifest
records source and artifact hashes for traceability. Each release also contains
per-scene prose, the accepted narrative-state snapshot, and per-scene hashes in
reading order.
