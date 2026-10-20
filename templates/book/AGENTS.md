# Working on this book

This book uses PickBits Weaver. The author decides what goes into the book.

- Edit only the chapter scenes under `manuscript/` and the notes in `world-bible/`, `outline/`
  and `style-guide/`.
- Work on one chapter at a time. When it's ready, ask the author to review it on the author page
  (`npx weaver studio`, then open http://127.0.0.1:4187).
- Approving, rejecting, undoing, accepting story state, ruling on findings, releasing and setting
  up backups (`npx weaver backup setup`) are the author's decisions, not yours. You may run
  `npx weaver backup status` and `npx weaver backup now`.
- Weaver checks every edit. When it reports a problem, fix the prose. Never change a rule, a
  setting or a record to make a check pass.
- If Weaver itself seems broken, stop and tell the author to contact PickBits support. Don't try
  to repair the tool.
