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
const CLI = join(ROOT, "scripts", "weaver.mjs");

function scenePath(root, chapter, scene) {
  return join(root, "manuscript", `chapter-${String(chapter).padStart(2, "0")}`, `scene-${String(scene).padStart(2, "0")}`, "scene.md");
}

function writeScene(root, chapter, scene, pov, prose) {
  const path = scenePath(root, chapter, scene);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `# Chapter ${chapter}, Scene ${scene}\n\n**POV:** ${pov}\n\n---\n\n# ${pov}\n\n${prose}\n\n---\n\n**Words:** 0\n`);
}

function looBook() {
  const root = mkdtempSync(join(tmpdir(), "weaver-voice-loo-"));
  cpSync(join(ROOT, "templates", "book"), root, { recursive: true });
  writeFileSync(join(root, "world-bible", "characters.json"), `${JSON.stringify({
    $schema: "https://pickbits.ai/schemas/weaver/characters-1.json",
    version: 1,
    characters: [
      { id: "quenlor", name: "Quenlor", aliases: [], pov: false },
      { id: "tervik", name: "Tervik", aliases: [], pov: false },
      { id: "bravax", name: "Bravax", aliases: [], pov: false }
    ]
  }, null, 2)}\n`);

  const scholarLines = [
    `"Sit down, you bloody fool," said Quenlor.`,
    ...Array.from({ length: 9 }, (_, index) => `"The council reviewed the harbor ledger before sunrise, and every witness received a patient hearing from the assembled clerks in record ${index + 1}," said Quenlor.`)
  ];
  const terseLines = [
    `"Indeed, one must examine the river accounts before the committee can approve this course, because each detail remains relevant to the public record and to the obligations of every office," said Tervik.`,
    ...Array.from({ length: 9 }, (_, index) => `"The committee reviewed the harbor ledger before sunrise, and every witness received a patient hearing from the assembled clerks in record ${index + 1}," said Tervik.`)
  ];
  const swearingLines = [
    `"Damn this rotten lock, it will not turn for any honest hand," said Bravax.`,
    `"Hell, the blasted cart is stuck again beside the northern gate," said Bravax.`,
    `"Bloody weather makes every simple crossing a miserable affair," said Bravax.`,
    `"Damn the broken rope, someone fetch a stronger length from storage," said Bravax.`,
    `"This shit will not move unless we push together on three," said Bravax.`,
    `"Hell's teeth, the watch has left another crate across the road," said Bravax.`,
    `"Bloody fools, keep your hands clear while I shift the heavy beam," said Bravax.`,
    `"Damn it, the signal lantern has gone dark beside the outer wall," said Bravax.`,
    `"The bastard hinge is bent, but a hammer should set it straight," said Bravax.`,
    `"Crap, the last cart has vanished before we loaded the final bundle," said Bravax.`
  ];
  writeScene(root, 1, 1, "Quenlor", scholarLines.join("\n\n"));
  writeScene(root, 1, 2, "Tervik", terseLines.join("\n\n"));
  writeScene(root, 1, 3, "Bravax", swearingLines.join("\n\n"));

  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["config", "--local", "user.name", "Voice Loo Test"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["config", "--local", "user.email", "voice-loo@example.invalid"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["add", "-A"], { cwd: root }).status, 0);
  const commit = spawnSync("git", ["commit", "-qm", "Voice leave-one-out baseline"], { cwd: root, encoding: "utf8" });
  assert.equal(commit.status, 0, commit.stderr);
  const project = readProject(root);
  const built = buildVoiceProfiles(root, project);
  return { root, project, built };
}

test("voice profiles leave the checked line out of hard contrasts and evidence", () => {
  const { root, project, built } = looBook();
  try {
    const quenlorProfile = built.profiles.find((profile) => profile.character_id === "quenlor");
    assert.deepEqual(Object.keys(quenlorProfile.totals), ["lines", "words", "sentences", "contractions", "profanity", "formal_markers", "questions", "exclamations"]);
    assert.equal(quenlorProfile.totals.profanity, 1);
    assert.equal(quenlorProfile.line_records.length, quenlorProfile.lines);

    const result = runVoiceCheck(root, project);
    const profanity = result.findings.find((finding) => finding.speaker === "Quenlor");
    const formal = result.findings.find((finding) => finding.speaker === "Tervik");
    assert.ok(profanity);
    assert.match(profanity.line, /Sit down, you bloody fool/u);
    assert.match(profanity.reason, /profanity/u);
    assert.equal(profanity.evidence.some((line) => /Sit down, you bloody fool/u.test(line.text)), false);
    assert.ok(formal);
    assert.match(formal.line, /Indeed, one must/u);
    assert.match(formal.reasons.join("\n"), /formal marker/u);
    assert.equal(formal.evidence.some((line) => /Indeed, one must/u.test(line.text)), false);
    assert.equal(result.findings.some((finding) => finding.speaker === "Bravax"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("old voice profiles remain readable and request a rebuild", () => {
  const { root, project } = looBook();
  try {
    const path = join(root, "world-bible", "voices", "quenlor.json");
    const profile = JSON.parse(readFileSync(path, "utf8"));
    delete profile.line_records;
    delete profile.totals;
    profile.version = 1;
    writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`);

    const result = runVoiceCheck(root, project);
    assert.ok(result.notes.some((note) => /run weaver voices build/u.test(note.message)));
    const check = spawnSync(process.execPath, [CLI, "voices", "check", "--root", root], { cwd: ROOT, encoding: "utf8" });
    assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
    assert.match(check.stdout, /run weaver voices build/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
