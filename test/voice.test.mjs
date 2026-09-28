// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { attributeDialogue, buildVoiceProfiles, runVoiceCheck } from "../engine/voice.mjs";
import { loadCharacters } from "../engine/characters.mjs";
import { readProject } from "../engine/project.mjs";

const ROOT = resolve(".");
const CLI = join(ROOT, "scripts", "weaver.mjs");

function scenePath(root, chapter, scene) {
  return join(root, "manuscript", `chapter-${String(chapter).padStart(2, "0")}`, `scene-${String(scene).padStart(2, "0")}`, "scene.md");
}

function writeScene(root, chapter, scene, pov, prose) {
  const path = scenePath(root, chapter, scene);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const header = `# Chapter ${chapter}, Scene ${scene}\n\n**POV:** ${pov}\n\n---\n\n`;
  writeFileSync(path, `${header}${prose}\n\n---\n\n**Words:** 0\n`);
  return path;
}

function voiceBook() {
  const root = mkdtempSync(join(tmpdir(), "weaver-voice-"));
  cpSync(join(ROOT, "templates", "book"), root, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "world-bible", "characters.json"), `${JSON.stringify({
    $schema: "https://pickbits.ai/schemas/weaver/characters-1.json",
    version: 1,
    characters: [
      { id: "brask", name: "Brask", aliases: ["the sergeant"], pov: true },
      { id: "lady-veyra", name: "Lady Veyra", aliases: [], pov: true },
      { id: "oswin", name: "Oswin", aliases: [], pov: false }
    ]
  }, null, 2)}\n`);
  const brask = [
    `Brask said, "Ain't time to dawdle, bloody fools, move your boots!"`,
    `Brask said, "I won't wait, so get your gear."`,
    `Brask checked the gate. "Move, and keep low, you lot."`,
    `Brask said, "We don't need a map, just eyes."`,
    `Brask said, "The rain won't stop us, not today."`,
    `Brask said, "I've got the rope, and it holds."`,
    `Brask said, "Ain't room for cowards here, bloody hell!"`,
    `Brask said, "Keep your head down and follow."`,
    `Brask said, "We'll cross before dark, if we hurry."`,
    `Brask said, "I can't hear the drums, speak up."`,
    `Brask said, "Bloody mud, bloody boots, bloody weather!"`,
    `Brask said, "Let's get moving, before dawn breaks."`
  ];
  const veyra = [
    `"Perhaps we should consider the eastern road, whose stones remain dry, and the messengers must arrive before the gates are closed for the evening watch," said Lady Veyra.`,
    `Lady Veyra asked, "Indeed, shall we permit the council to decide our course?"`,
    `"The arrangement is elegant, and shall satisfy the council," said Lady Veyra.`,
    `Lady Veyra replied, "Whom would you have us trust when every witness has vanished?"`,
    `"Pray, let the lanterns remain lit until the final courier returns," said Lady Veyra.`,
    // Keeps Veyra's evidence clearly above the 150-word hard-contrast minimum (it sat at 149).
    `"We shall record every answer faithfully, whatever the hour," said Lady Veyra.`,
    `Lady Veyra said, "Perhaps the silence contains a warning that patience alone may reveal."`,
    `"One must consider the consequence before choosing an answer that cannot be recalled," said Lady Veyra.`,
    `Lady Veyra continued, "Indeed, the eastern gate shall open only after the bells have sounded."`,
    `"Madam is not the proper address, but the courtesy is appreciated nonetheless," said Lady Veyra.`,
    `Lady Veyra answered, "Perhaps we shall proceed with dignity, regardless of the court's impatience."`,
    `"I daresay the evidence is persuasive, although the conclusion remains morally uncertain," said Lady Veyra.`,
    `Lady Veyra murmured, "Indeed, one must preserve the record so that justice may be measured."`
  ];
  const oswin = [`Oswin said, "I wait."`, `Oswin said, "The lamp is low."`, `Oswin said, "I heard footsteps."`];
  writeScene(root, 1, 1, "Brask", [...brask.slice(0, 6), ...veyra.slice(0, 6), `"No one knows," she said.`].join("\n\n"));
  writeScene(root, 1, 2, "Lady Veyra", [...brask.slice(6), ...veyra.slice(6)].join("\n\n"));
  writeScene(root, 2, 1, "Oswin", oswin.join("\n\n"));
  spawnSync("git", ["config", "--local", "user.name", "Voice Test"], { cwd: root });
  spawnSync("git", ["config", "--local", "user.email", "voice@example.invalid"], { cwd: root });
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-qm", "Voice fixture baseline"], { cwd: root });
  return root;
}

test("dialogue attribution covers tags, beats, continuation, and pronoun limits", () => {
  const characters = [
    { id: "brask", name: "Brask", aliases: ["the sergeant"], pov: true },
    { id: "lady-veyra", name: "Lady Veyra", aliases: [], pov: true }
  ];
  const lines = attributeDialogue({ id: "1-1", prose: [
    `Brask said, "Ain't time!"`,
    `Lady Veyra asked, "Perhaps we should proceed, indeed?"`,
    `Brask checked the gate. "Move, and keep low."`,
    `Brask said, "We cross at dawn, and I ain't afraid.`,
    `"The river is cold, but we'll cross it."`,
    `"No one knows," she said.`
  ].join("\n\n") }, characters);
  assert.deepEqual(lines.map((line) => line.method), ["tag", "tag", "beat", "tag", "continuation", "unattributed"]);
  assert.equal(lines.at(-1).speaker, null);
});

test("profiles and checks are deterministic, evidentiary, stale-aware, and advisory", () => {
  const root = voiceBook();
  try {
    const project = readProject(root);
    const first = buildVoiceProfiles(root, project);
    const before = Object.fromEntries(first.profiles.map((profile) => [profile.character_id, readFileSync(join(root, "world-bible", "voices", `${profile.character_id}.json`), "utf8")]));
    const second = buildVoiceProfiles(root, project);
    for (const profile of second.profiles) assert.equal(readFileSync(join(root, "world-bible", "voices", `${profile.character_id}.json`), "utf8"), before[profile.character_id]);
    assert.equal(first.profiles.find((profile) => profile.character_id === "brask").enough_evidence, true);
    assert.equal(first.profiles.find((profile) => profile.character_id === "lady-veyra").enough_evidence, true);
    assert.equal(first.profiles.find((profile) => profile.character_id === "oswin").enough_evidence, false);

    const path = scenePath(root, 1, 2);
    const raw = readFileSync(path, "utf8");
    const footer = raw.lastIndexOf("\n---");
    writeFileSync(path, `${raw.slice(0, footer)}\nBrask said, "Indeed, the eastern bastion is an imposing and ceremonious structure whose antiquated stones shall perhaps outlast every ordinary ambition."\n\nBrask said, "I ain't done yet!"\n\n"Bloody hell!" said Lady Veyra.\n\nOswin said, "I wait."\n${raw.slice(footer)}`);
    const result = runVoiceCheck(root, project);
    assert.deepEqual(result.stale_profiles, []);
    assert.ok(result.findings.some((finding) => finding.speaker === "Brask" && finding.maybe_sounds_like?.character === "Lady Veyra"));
    assert.ok(result.findings.some((finding) => finding.speaker === "Lady Veyra" && /profanity/i.test(finding.reason)));
    assert.ok(result.findings.flatMap((finding) => finding.reasons || []).some((reason) => /\d+(?:\.\d+)? words per sentence|\d+ profanity|\d+ formal marker|\d+ exclamation|\d+ contraction/u.test(reason)));
    assert.equal(result.findings.some((finding) => finding.speaker === "Oswin"), false);
    assert.ok(result.notes.some((note) => /not enough of their lines yet \(3 lines,/.test(note.message)));
    assert.equal(result.findings.every((finding) => finding.severity === "warn" && finding.type === "voice"), true);

    const changes = spawnSync(process.execPath, [CLI, "changes", "--root", root, "--json"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(changes.status, 0, changes.stderr);
    assert.ok(JSON.parse(changes.stdout).chapters[0].voice_warnings > 0);

    const check = spawnSync(process.execPath, [CLI, "check", "--root", root], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(check.status, 0, "state is stale in this fixture, but voice findings are not the failure");
    assert.doesNotMatch(check.stdout, /voice warning/);
    assert.equal(JSON.parse(check.stdout).voices.warnings, result.warnings);

    const hook = spawnSync(process.execPath, [CLI, "hook", "post"], {
      cwd: root,
      input: JSON.stringify({ cwd: root, tool_name: "Edit", tool_input: { file_path: path } }),
      encoding: "utf8"
    });
    assert.equal(hook.status, 0, hook.stderr);
    const hookOutput = JSON.parse(hook.stdout);
    assert.equal(hookOutput.decision, undefined);
    assert.match(hookOutput.hookSpecificOutput.additionalContext, /Typical lines/);

    const voiceId = result.findings.find((finding) => finding.speaker === "Brask").id;
    const ruling = spawnSync(process.execPath, [CLI, "rule", voiceId, "--decision", "allow", "--root", root], { cwd: ROOT, encoding: "utf8" });
    assert.equal(ruling.status, 0, `${ruling.stdout}\n${ruling.stderr}`);
    assert.equal(runVoiceCheck(root, project).findings.some((finding) => finding.id === voiceId), false);
    writeFileSync(path, readFileSync(path, "utf8").replace('Brask said, "Indeed, the eastern bastion', 'At noon, Brask said, "Indeed, the eastern bastion'));
    assert.equal(runVoiceCheck(root, project).findings.find((finding) => finding.id === voiceId)?.ruling,
      "an earlier ruling no longer applies because the passage changed");

    const approval = spawnSync(process.execPath, [CLI, "approve", "--chapter", "1", "--root", root], { cwd: ROOT, encoding: "utf8" });
    assert.equal(approval.status, 0, `${approval.stdout}\n${approval.stderr}`);
    const approvedProfile = JSON.parse(readFileSync(join(root, "world-bible", "voices", "brask.json"), "utf8"));
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    assert.equal(approvedProfile.approved_head_commit, head);
    assert.equal(runVoiceCheck(root, project).stale_profiles.length, 0);
    approvedProfile.approved_manuscript_sha256 = "simulated-stale-profile";
    writeFileSync(join(root, "world-bible", "voices", "brask.json"), `${JSON.stringify(approvedProfile, null, 2)}\n`);
    assert.ok(runVoiceCheck(root, project).stale_profiles.includes("Brask"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("characters seed adds imported POVs once", () => {
  const root = mkdtempSync(join(tmpdir(), "weaver-voice-seed-"));
  const source = join(root, "finished.md");
  const book = join(root, "book");
  try {
    const initialized = spawnSync(process.execPath, [CLI, "init", book, "--id", "voice-seed", "--title", "Voice Seed", "--empty"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(initialized.status, 0, `${initialized.stdout}\n${initialized.stderr}`);
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: book }).status, 0);
    writeFileSync(source, "# Brask\n\nA short imported scene.\n\n* * *\n\n# Lady Veyra\n\nA formal imported scene.");
    let result = spawnSync(process.execPath, [CLI, "import", source, "--root", book], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    result = spawnSync(process.execPath, [CLI, "characters", "seed", "--root", book, "--json"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(loadCharacters(book).characters.map((character) => character.name), ["Brask", "Lady Veyra"]);
    const registry = readFileSync(join(book, "world-bible", "characters.json"), "utf8");
    result = spawnSync(process.execPath, [CLI, "characters", "seed", "--root", book, "--json"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(book, "world-bible", "characters.json"), "utf8"), registry);
    assert.equal(JSON.parse(result.stdout).added.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
