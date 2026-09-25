// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { buildVoiceProfiles, runVoiceCheck } from "../engine/voice.mjs";
import { readProject } from "../engine/project.mjs";

const ROOT = resolve(".");

function scenePath(root, chapter, scene) {
  return join(root, "manuscript", `chapter-${String(chapter).padStart(2, "0")}`, `scene-${String(scene).padStart(2, "0")}`, "scene.md");
}

function writeScene(root, chapter, scene, pov, prose) {
  const path = scenePath(root, chapter, scene);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `# Chapter ${chapter}, Scene ${scene}\n\n**POV:** ${pov}\n\n---\n\n${prose}\n\n---\n\n**Words:** 0\n`);
}

function precisionBook() {
  const root = mkdtempSync(join(tmpdir(), "weaver-voice-precision-"));
  cpSync(join(ROOT, "templates", "book"), root, { recursive: true });
  writeFileSync(join(root, "world-bible", "characters.json"), `${JSON.stringify({
    $schema: "https://pickbits.ai/schemas/weaver/characters-1.json",
    version: 1,
    characters: [
      { id: "brask", name: "Brask", aliases: [], pov: true },
      { id: "lady-veyra", name: "Lady Veyra", aliases: [], pov: true },
      { id: "hollis", name: "Hollis", aliases: [], pov: true }
    ]
  }, null, 2)}\n`);
  const brask = Array.from({ length: 24 }, () => `Brask said, "I ain't waiting; haul the rope, bloody fools."`);
  const veyra = Array.from({ length: 12 }, () => `Lady Veyra said, "Indeed, perhaps the council shall consider the matter with patience before the appointed witnesses arrive this evening."`);
  const hollis = Array.from({ length: 32 }, () => `Hollis said, "Hold the gate until dawn."`);
  writeScene(root, 1, 1, "Brask", [...brask, ...veyra, ...hollis].join("\n\n"));
  const project = readProject(root);
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "--local", "user.name", "Voice Precision"], { cwd: root });
  spawnSync("git", ["config", "--local", "user.email", "voice-precision@example.invalid"], { cwd: root });
  spawnSync("git", ["add", "-A"], { cwd: root });
  const commit = spawnSync("git", ["commit", "-qm", "Voice precision baseline"], { cwd: root, encoding: "utf8" });
  assert.equal(commit.status, 0, commit.stderr);
  buildVoiceProfiles(root, project);
  return { root, project };
}

test("voice precision ignores short quirks and requires independent long-line signals", () => {
  const { root, project } = precisionBook();
  try {
    writeScene(root, 2, 1, "Brask", [
      `Brask said, "Hell,"`,
      `Brask said, "Bloody hell,"`,
      `Brask said, "Where'd you get this?"`,
      `Brask said, "Tide turns; keep moving out before dawn."`,
      `Lady Veyra said, "Perhaps,"`,
      `Lady Veyra said, "Indeed, the council shall review the evidence before we permit any witness to depart from this chamber at sunset tonight. Perhaps the record remains incomplete, but one must preserve every testimony until the appointed clerk has verified each seal properly. Whom the magistrate summons, we shall answer with courtesy, for justice requires patience when the final question has been considered."`,
      `Lady Veyra said, "Sit down, you bloody fool,"`,
      `Brask said, "Indeed, one must consider the ancient harbor ledger before we depart, because every marked crate conceals a debt that patient hands alone can settle; perhaps the watchmen shall close the western gate against us again when the tide withdraws tonight."`,
      `Hollis said, "How many?"`,
      `Hollis said, "What did you see?"`,
      `Hollis said, "Stand aside; the bridge is unsafe, and indeed we shall secure the prisoners before anyone crosses until the signal arrives from command."`
    ].join("\n\n"));

    const result = runVoiceCheck(root, project, { sceneIds: ["2-1"] });
    const finding = (text) => result.findings.find((entry) => entry.line.includes(text));
    for (const text of ["Hell,", "Bloody hell,", "Where'd you get this?", "Tide turns", "Perhaps,", "the council shall review", "How many?", "What did you see?"]) {
      assert.equal(finding(text), undefined, `unexpected finding for ${text}`);
    }
    const brask = finding("ancient harbor ledger");
    assert.ok(brask);
    assert.match(brask.reasons.join("\n"), /three times longer|formal marker/u);
    assert.ok(brask.maybe_sounds_like, JSON.stringify(result.findings));
    assert.equal(brask.maybe_sounds_like.character, "Lady Veyra");

    const veyra = finding("Sit down, you bloody fool");
    assert.ok(veyra);
    assert.match(veyra.reason, /profanity/u);

    const hollis = finding("Stand aside; the bridge");
    assert.ok(hollis);
    assert.match(hollis.reasons.join("\n"), /three times longer|formal marker/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
