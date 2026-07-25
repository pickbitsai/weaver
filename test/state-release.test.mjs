import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRelease } from "../engine/release.mjs";
import { readProject } from "../engine/project.mjs";
import {
  acceptNarrativeState,
  buildGroundingPacket,
  narrativeStateStatus
} from "../engine/state.mjs";

function withBook(run) {
  const root = mkdtempSync(join(tmpdir(), "weaver-test-"));
  cpSync(resolve("templates/book"), root, { recursive: true });
  try {
    return run(root, readProject(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepting state stamps it current and a prose edit invalidates it", () => withBook((root, project) => {
  assert.equal(narrativeStateStatus(root, project).first_stale, "1-1");
  const accepted = acceptNarrativeState(root, project);
  assert.equal(accepted.stale, 0);
  appendFileSync(join(root, "manuscript", "chapter-01", "scene-01", "scene.md"), "\n");
  assert.equal(narrativeStateStatus(root, project).stale, 0, "metadata-only changes do not invalidate prose");
  const path = join(root, "manuscript", "chapter-01", "scene-01", "scene.md");
  const changed = readFileSync(path, "utf8").replace(
    "The closing image leaves the story in a different state.",
    "The closing image leaves the story in a changed and uncertain state."
  );
  writeFileSync(path, changed);
  const stale = narrativeStateStatus(root, project);
  assert.equal(stale.first_stale, "1-1");
  assert.equal(stale.records[0].reason, "source-changed");
}));

test("grounding packet includes locked outline and anti-reset constraints", () => withBook((root, project) => {
  const packet = buildGroundingPacket(root, project, "1-1");
  assert.match(packet, /Locked scene outline/);
  assert.match(packet, /do not restart the book/i);
  assert.match(packet, /Establish the protagonist's ordinary pressure/);
}));

test("an early edit invalidates every downstream scene and blocks stale grounding", () => withBook((root, project) => {
  const sceneDirectory = join(root, "manuscript", "chapter-01", "scene-02");
  mkdirSync(sceneDirectory, { recursive: true });
  writeFileSync(join(sceneDirectory, "scene.md"), `# Chapter 1, Scene 2

**POV:** Protagonist

---

The second scene carries the first scene's consequence into a harder choice.

---

**Status:** Test
`);
  mkdirSync(join(root, "narrative-state"), { recursive: true });
  writeFileSync(join(root, "narrative-state", "1-2.md"), `# Narrative state after scene 1-2

## Newly established

- The first consequence creates a harder choice.
`);
  mkdirSync(join(root, "outline", "scenes"), { recursive: true });
  writeFileSync(join(root, "outline", "scenes", "1-2.md"), "# Scene 1-2\n\n- Required change: Choose.\n");
  acceptNarrativeState(root, project);
  assert.equal(narrativeStateStatus(root, project).stale, 0);

  const firstPath = join(root, "manuscript", "chapter-01", "scene-01", "scene.md");
  writeFileSync(firstPath, readFileSync(firstPath, "utf8").replace(
    "The closing image leaves the story in a different state.",
    "The closing image leaves the story in a dangerous new state."
  ));
  const status = narrativeStateStatus(root, project);
  assert.equal(status.stale, 2);
  assert.equal(status.records[0].reason, "source-changed");
  assert.equal(status.records[1].reason, "upstream-stale");
  assert.throws(() => buildGroundingPacket(root, project, "1-2"), /upstream narrative state is stale/);
}));

test("release is immutable for a changed manuscript hash", () => withBook((root, project) => {
  acceptNarrativeState(root, project);
  const manifest = buildRelease(root, project, "beta-01");
  assert.equal(manifest.source.scene_count, 1);
  assert.equal(manifest.artifacts.length, 2);
  const path = join(root, "manuscript", "chapter-01", "scene-01", "scene.md");
  const changed = readFileSync(path, "utf8").replace(
    "The closing image leaves the story in a different state.",
    "The closing image leaves the story permanently altered."
  );
  writeFileSync(path, changed);
  acceptNarrativeState(root, project);
  assert.throws(
    () => buildRelease(root, project, "beta-01"),
    /already exists for a different manuscript hash/
  );
}));
