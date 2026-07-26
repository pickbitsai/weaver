# Contributing

Weaver is the reusable, story-agnostic engine. Do not contribute real
manuscripts, credentials, generated media, or project-specific world-bible
content.

## Development

Requirements: Node.js 22 or newer.

```bash
npm test
npm run smoke
npm run preflight
```

There are no runtime dependencies. Keep the core on the Node.js standard
library unless a change has a compelling portability benefit.

## Behavioral rules

- `templates/book/` is both the starter project and a synthetic fixture.
- Release IDs are immutable for a given manuscript hash.
- Editing an earlier scene invalidates its derived state and every downstream
  state record.
- State acceptance is explicit. Do not silently stamp model output as current.
- Every new gate needs a known-good fixture and a known-bad fixture that proves
  the gate can reject.
- Update `loop.manifest.json` and `docs/LOOP.md` when the executable workflow
  changes.

Open a focused pull request and describe the behavior being changed, the
evidence added, and the commands used to verify it.
