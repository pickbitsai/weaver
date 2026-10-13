// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { initializeProject } from "../../engine/init.mjs";
import { countWords } from "../../engine/manuscript.mjs";
import { readProject } from "../../engine/project.mjs";

export const git = (root, ...args) => {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};
export const first = "Rill keeps the *murky* silver map.";
export const middle = "The lantern stays beside the door.";
export const last = "Rill folds the murky paper carefully.";
export function makeBook(t, { severity = "block", mode = "happy" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "weaver-proposals-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initializeProject(root, { projectId: "synthetic-book", title: "Synthetic Book", empty: true });
  const project = readProject(root);
  project.host = { command: process.execPath, args: [resolve("test/fixtures/proposal-host.mjs"), mode], concurrency: 4, timeout_seconds: 1 };
  project.run = { retry: { delays_seconds: [0, 0] } };
  writeFileSync(join(root, "project.json"), JSON.stringify(project, null, 2));
  const paths = [];
  for (const [id, prose] of [["1-1", `${first}\n\n${middle}\n\n${last}`], ["1-2", "Rill crosses the narrow bridge before sunrise."], ["2-1", "Tovan watches the quiet hill through rain."]]) {
    const [chapter, scene] = id.split("-");
    const path = join(root, "manuscript", `chapter-${chapter.padStart(2, "0")}`, `scene-${scene.padStart(2, "0")}`, "scene.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `# Scene ${id}\n\n**POV:** Rill\n\n---\n\n${prose}\n\n---\n\n**Words:** ${countWords(prose)}\n`);
    paths.push(path);
  }
  writeFileSync(join(root, "quality", "rules.json"), JSON.stringify({ version: 1, rules: [
    { id: "murky", type: "phrase-list", severity, phrases: ["murky"], message: "Choose a precise description." },
    { id: "forbidden", type: "phrase-list", severity: "block", phrases: ["forbidden"], message: "Do not use forbidden." }
  ] }));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "Import original manuscript: synthetic", "-m", "Imported-with: PickBits Weaver 0.3.0");
  return { root, project, paths, bytes: paths.map((path) => readFileSync(path, "utf8")) };
}
