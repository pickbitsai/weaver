# Extraction provenance

Weaver was extracted on 2026-07-25 from the local checkout at
`C:\new\silentguardian-`, whose GitHub remote is
`https://github.com/MrPickering/silentguardian-.git`.

The main source points were:

- `c069004a1c21835d6b3f4392a5ecd3f4c185646b` — narrative-engine design
  baseline, including derived reader state and downstream invalidation;
- `be5210ef45361f1b8934e767a97b6e3de7afe3bf` — working Story Engine
  scaffold, canonical scene loader, contracts, tests, and beta release builder;
- the repository's agentic write/review workflow in `CLAUDE.md`,
  `.claude/commands/write-scene.md`, and the continuity/style/critic agents.

This is a clean extraction, not a copy of the whole source repository. The
implementation was made story-agnostic, stripped of external service
dependencies, and tested against a synthetic starter book. No manuscript prose,
Silent Guardian world-bible material, generated releases, audiovisual assets,
environment files, or secrets were transferred.
