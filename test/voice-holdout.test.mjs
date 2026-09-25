// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function writeScene(root, chapter, scene, pov, title, prose) {
  const path = scenePath(root, chapter, scene);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `# Chapter ${chapter}, Scene ${scene}\n\n**POV:** ${pov}\n\n---\n\n# ${title}\n\n${prose}\n\n---\n\n**Words:** 0\n`);
}

function holdoutBook() {
  const root = mkdtempSync(join(tmpdir(), "weaver-voice-holdout-"));
  cpSync(join(ROOT, "templates", "book"), root, { recursive: true });
  writeFileSync(join(root, "world-bible", "characters.json"), `${JSON.stringify({
    $schema: "https://pickbits.ai/schemas/weaver/characters-1.json",
    version: 1,
    characters: [
      { id: "grell", name: "Grell", aliases: [], pov: false },
      { id: "magister-anselm", name: "Magister Anselm", aliases: ["Anselm"], pov: false }
    ]
  }, null, 2)}\n`);
  const grell = [
    `"Pull, you lazy sods!" Grell shouted.`,
    `"Ain't nobody paying us to stand about," Grell said. "Get it done."`,
    `Grell spat over the rail. "Bloody tide's turning. Move!"`,
    `"Don't you look at me like that," Grell growled. "I've hauled bigger."`,
    `"Where's the damn hook?" Grell yelled. "Can't find nothing on this dock."`,
    `"We're done when I say we're done," said Grell.`,
    `Grell laughed. "You'll learn. Everyone does, sooner or later."`,
    `"Hell's teeth, that's heavy!" Grell snapped. "Lift with your legs."`,
    `"Won't be pretty, but it'll float," Grell muttered.`,
    `"Shut it and haul," said Grell. "Now!"`,
    `"Mind the crates, they ain't paid for yet," Grell said.`,
    `"Oi! Keep your bloody hands off the cargo," Grell shouted.`,
    `"Can't stand here all day gawping, can we?" said Grell.`,
    `"You'll get your coin when the job's done, not before," Grell growled.`,
    `"Tie it off. Tighter than that, you daft lump!" Grell snapped.`
  ];
  const anselm = [
    `"One must consider the statutes before deciding whether the proposed action is permissible," said Magister Anselm.`,
    `"Indeed, the council shall require a careful account of every witness before deliberation may properly begin," said Magister Anselm.`,
    `"Perhaps the precedent is not decisive, although it offers guidance whom a prudent magistrate would be wise to consult," Magister Anselm said.`,
    `"I daresay the evidence warrants patience, for haste in such a matter would be imprudent and difficult to remedy," said Magister Anselm.`,
    `"Pray, record the objection precisely, since the statutes distinguish a considered refusal from an accidental omission," said Magister Anselm.`,
    `"One must not confuse a council's authority with the conclusion that its members may reach after full deliberation," said Magister Anselm.`,
    `"Indeed, the precedent requires that we identify the person to whom the obligation belongs before judgment is announced," said Magister Anselm.`,
    `"Perhaps we shall proceed when the record is complete, and I daresay that no responsible scholar would recommend otherwise," said Magister Anselm.`,
    `"Whom the statutes bind, the council must hear, for justice is not improved by excluding a relevant account," said Magister Anselm.`,
    `"It would be imprudent to dismiss the matter before the council has completed its deliberation and considered every applicable precedent," said Magister Anselm.`
  ];
  writeScene(root, 1, 1, "Grell", "Grell", grell.join("\n\n"));
  writeScene(root, 2, 1, "Magister Anselm", "Magister Anselm", anselm.join("\n\n"));
  const project = readProject(root);
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "--local", "user.name", "Voice Holdout"], { cwd: root });
  spawnSync("git", ["config", "--local", "user.email", "voice-holdout@example.invalid"], { cwd: root });
  spawnSync("git", ["add", "-A"], { cwd: root });
  const commit = spawnSync("git", ["commit", "-qm", "Voice hold-out baseline"], { cwd: root, encoding: "utf8" });
  assert.equal(commit.status, 0, commit.stderr);
  buildVoiceProfiles(root, project);
  return { root, project };
}

test("hold-out voice check catches both directions with concrete measurements", () => {
  const { root, project } = holdoutBook();
  try {
    const path = scenePath(root, 3, 1);
    writeScene(root, 3, 1, "Grell", "Chapter 3", [
      `"It would be most imprudent to proceed before the council has deliberated upon the matter in full," said Grell.`,
      `"Bloody fools, the lot of you," said Anselm.`,
      `"Grab the line and don't let go," Grell said.`,
      `"We should go," she said.`
    ].join("\n\n"));
    const result = runVoiceCheck(root, project, { sceneIds: ["3-1"] });
    const formal = result.findings.find((finding) => finding.speaker === "Grell");
    const profanity = result.findings.find((finding) => finding.speaker === "Magister Anselm");
    assert.ok(formal);
    assert.equal(formal.maybe_sounds_like.character, "Magister Anselm");
    assert.match(formal.reasons.join("\n"), /\d+ words per sentence|\d+ formal marker|contractions in \d+ words/u);
    assert.ok(profanity);
    assert.equal(profanity.maybe_sounds_like.character, "Grell");
    assert.match(profanity.reasons.join("\n"), /\d+ profanity/u);
    assert.equal(result.findings.some((finding) => finding.line.includes("Grab the line")), false);
    assert.equal(result.findings.some((finding) => finding.line.includes("We should go")), false);
    assert.equal(result.stale_profiles.length, 0);
    assert.match(readFileSync(path, "utf8"), /most imprudent/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
