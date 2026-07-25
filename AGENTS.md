# Weaver contributor notes

Weaver is the reusable book-writing pipeline extracted from Silent Guardian. Keep it story-agnostic.

- Do not add real manuscripts, credentials, generated media, or project-specific world-bible content.
- Keep the core runnable with the Node.js standard library.
- Treat `templates/book/` as both the starter project and a test fixture; changes there must remain generic.
- Release IDs are immutable. Never silently overwrite a release built from a different manuscript hash.
- Narrative-state acceptance is explicit. A changed scene makes that scene and every downstream scene stale.
- Run `npm test` and `npm run smoke` after changing engine or template behavior.
