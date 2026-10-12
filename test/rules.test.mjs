// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { authorEnv } from "./helpers/env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readProject } from "../engine/project.mjs";
import { runRules, runRulesForScene } from "../engine/rules.mjs";
import { seedCharacters } from "../engine/characters.mjs";
import { initializeProject } from "../engine/init.mjs";
import { importBook } from "../engine/import.mjs";

const ROOT = resolve(".");
const CLI = join(ROOT, "scripts", "weaver.mjs");

function fixture(rules, prose) {
  const root = mkdtempSync(join(tmpdir(), "weaver-rules-"));
  cpSync(resolve("templates/book"), root, { recursive: true });
  writeFileSync(join(root, "quality", "rules.json"), `${JSON.stringify({ version: 1, rules }, null, 2)}\n`);
  const path = join(root, "manuscript", "chapter-01", "scene-01", "scene.md");
  const original = readFileSync(path, "utf8");
  const separators = original.split("\n");
  const first = separators.indexOf("---");
  const last = separators.lastIndexOf("---");
  writeFileSync(path, `${separators.slice(0, first + 1).join("\n")}\n\n${prose}\n\n${separators.slice(last).join("\n")}`);
  return root;
}

function one(rule, prose) {
  const root = fixture([rule], prose);
  try {
    return runRules(root, readProject(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("every rules type has a clean fixture and a violating fixture", () => {
  const base = { severity: "block", message: "test message" };
  assert.equal(one({ ...base, id: "dash", type: "count-per-words", text: "—", max: 1, per_words: 10, unit: "scene" }, "One — two — three — four five six seven eight nine ten.").findings[0].count, 3);
  assert.equal(one({ ...base, id: "phrase", type: "phrase-list", phrases: ["couldn't help but", "delve"] }, "She couldn’t help but *delve*.").findings.length, 2);
  assert.equal(one({ ...base, id: "share", type: "sentence-start-share", word: "I", max_share: 0.3, min_sentences: 5, unit: "paragraph" }, "I ran. I waited. I listened. I turned. I left.").findings[0].paragraph, 1);
  assert.equal(one({ ...base, id: "starts", type: "repeated-sentence-starts", max_run: 2 }, "I ran. I waited. I listened.").findings[0].count, 3);
  assert.equal(one({ ...base, id: "paragraph", type: "max-per-paragraph", text: "—", max: 1 }, "One — two — three.").findings[0].limit, 1);
  assert.equal(one({ ...base, id: "digits", type: "regex", pattern: "\\d+", flags: "g" }, "There are 42 doors.").findings.length, 1);
  assert.equal(one({ ...base, id: "clean", type: "phrase-list", phrases: ["delve"] }, "She stayed with the plain words.").findings.length, 0);
});

test("scope and multi-paragraph dialogue use reader text", () => {
  const root = fixture([
    { id: "narration", type: "phrase-list", severity: "block", message: "narration", scope: "narration", phrases: ["delve"] },
    { id: "dialogue", type: "phrase-list", severity: "block", message: "dialogue", scope: "dialogue", phrases: ["delve"] }
  ], "“delve in here\n\n“delve again.” The f\\*\\*\\* stayed literal.");
  try {
    const result = runRules(root, readProject(root));
    assert.equal(result.findings.filter((finding) => finding.rule_id === "narration").length, 0);
    assert.equal(result.findings.filter((finding) => finding.rule_id === "dialogue").length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid regular expressions are plain configuration errors", () => {
  const root = fixture([{ id: "bad-regex", type: "regex", severity: "block", message: "bad", pattern: "[" }], "Text.");
  try {
    assert.throws(() => runRules(root, readProject(root)), /invalid quality[\\/]rules\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocking rules fail check and release while warnings remain advisory", () => {
  const root = fixture([{ id: "block-delve", type: "phrase-list", severity: "block", message: "Use specific prose.", phrases: ["delve"] }], "The first line creates a pressure the protagonist cannot ignore. Delve.");
  try {
    assert.equal(existsSync(join(root, "quality", "rules.json")), true);
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
    let result = spawnSync(process.execPath, [CLI, "state:accept", "--root", root], { env: authorEnv(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    result = spawnSync(process.execPath, [CLI, "check", "--root", root], { env: authorEnv(), encoding: "utf8" });
    assert.equal(result.status, 1);
    const check = JSON.parse(result.stdout);
    assert.deepEqual(check.issues, ["style rules: 1 blocking finding(s)"]);
    assert.deepEqual(check.rules, { blocking: 1, warnings: 0 });
    result = spawnSync(process.execPath, [CLI, "release", "--root", root, "--id", "blocked"], { env: authorEnv(), encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /style rules: 1 blocking finding\(s\)/);

    const warningRoot = fixture([{ id: "warn-delve", type: "phrase-list", severity: "warn", message: "Use specific prose.", phrases: ["delve"] }], "The first line creates a pressure the protagonist cannot ignore. Delve.");
    try {
      assert.equal(spawnSync("git", ["init", "-q"], { cwd: warningRoot }).status, 0);
      result = spawnSync(process.execPath, [CLI, "state:accept", "--root", warningRoot], { env: authorEnv(), encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      result = spawnSync(process.execPath, [CLI, "check", "--root", warningRoot], { env: authorEnv(), encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).rules, { blocking: 0, warnings: 1 });
    } finally {
      rmSync(warningRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const SWEAR = { id: "swear-words", type: "phrase-list", severity: "warn", message: "Check rough speech.", phrases: ["damn"] };
function writeRules(root, rules) {
  writeFileSync(join(root, "quality", "rules.json"), JSON.stringify({ version: 1, rules }));
}

test("speaker exemptions include unattributed dialogue and dropping the scope flags the exempt line", () => {
  const root = fixture([{ ...SWEAR, except_speakers: ["grell"] }], 'Grell said, "Damn the locked gate."\n\nTorven said, "Damn the broken key."\n\n"Damn the waiting."\n\nThe damn gate remained shut.');
  try {
    seedCharacters(root, ["Grell", "Torven"]);
    const project = readProject(root);
    let result = runRules(root, project);
    assert.deepEqual(result.findings.map((finding) => finding.paragraph), [2, 3]);
    assert.equal(result.rules[0].scope, "dialogue");
    assert.match(result.findings[0].scope_reason, /Skips dialogue attributed to Grell; unattributed dialogue is included/u);
    writeRules(root, [{ ...SWEAR, speakers: ["grell"] }]);
    result = runRules(root, project);
    assert.deepEqual(result.findings.map((finding) => finding.paragraph), [1]);
    assert.match(result.findings[0].message, /Applies to dialogue by Grell/u);
    writeRules(root, [{ ...SWEAR, speakers: ["grell", "torven"], except_speakers: ["grell"], scope: "all" }]);
    assert.deepEqual(runRules(root, project).findings.map((finding) => finding.paragraph), [2]);
    writeRules(root, [SWEAR]);
    assert.deepEqual(runRules(root, project).findings.map((finding) => finding.paragraph), [1, 2, 3, 4]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("speaker scopes work for all six rule types and use only selected words and sentences", () => {
  const base = { severity: "warn", message: "Check this line.", speakers: ["grell"] };
  const rules = [
    { ...base, id: "rate", type: "count-per-words", text: "I", max: 40, per_words: 100, unit: "scene" },
    { ...base, id: "phrase", type: "phrase-list", phrases: ["wait"] },
    { ...base, id: "share", type: "sentence-start-share", word: "I", max_share: 0.75, min_sentences: 3, unit: "scene" },
    { ...base, id: "repeat", type: "repeated-sentence-starts", max_run: 2 },
    { ...base, id: "paragraph", type: "max-per-paragraph", text: "I", max: 2 },
    { ...base, id: "pattern", type: "regex", pattern: "wait", flags: "g" }
  ];
  const root = fixture(rules, 'Torven said, "The birds wheel above us. The road opens into the hills. The dawn arrives softly."\n\nGrell said, "I wait. I listen. I leave."');
  try {
    seedCharacters(root, ["Grell", "Torven"]);
    const project = readProject(root);
    const result = runRules(root, project, { includeMeasurements: true });
    assert.deepEqual(result.findings.map((finding) => finding.rule_id).sort(), rules.map((rule) => rule.id).sort());
    assert.equal(result.measurements.find((item) => item.rule_id === "rate").value, 50);
    assert.equal(result.measurements.find((item) => item.rule_id === "share").value, 1);
    // Scene-wide sentence findings must link to an included paragraph too.
    assert.ok(result.findings.every((finding) => finding.paragraph === 2));
    writeRules(root, rules.map(({ speakers, ...rule }) => rule));
    const unscoped = runRules(root, project, { includeMeasurements: true });
    assert.ok(unscoped.measurements.find((item) => item.rule_id === "rate").value < 40);
    assert.ok(unscoped.measurements.find((item) => item.rule_id === "share").value < 0.75);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("POV scopes read scene metadata, combine with speakers, and preserve chapter denominators and locations", () => {
  const share = { id: "i-start", type: "sentence-start-share", severity: "warn", message: "Vary sentence openings.", word: "I", max_share: 0.75, min_sentences: 3, unit: "scene", pov: ["tamsin"], speakers: ["grell"] };
  const prose = 'Torven said, "Birds circle. Rain falls. Gates close. Guards wait."\n\nGrell said, "I wait. I listen. I leave."';
  const root = fixture([share], prose);
  try {
    seedCharacters(root, ["Grell", "Torven", "Tamsin"]);
    const first = join(root, "manuscript", "chapter-01", "scene-01", "scene.md");
    const raw = readFileSync(first, "utf8");
    writeFileSync(first, raw.replace("**POV:** Protagonist", "**POV:** Torven"));
    for (const [number, pov] of [[2, "Tamsin"], [3, ""]]) {
      const directory = join(root, "manuscript", "chapter-01", `scene-0${number}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "scene.md"), raw.replace("**POV:** Protagonist", `**POV:** ${pov}`));
    }
    const project = readProject(root);
    const result = runRules(root, project, { includeMeasurements: true });
    assert.deepEqual(result.findings.map((finding) => finding.scene_id), ["1-2"]);
    assert.equal(result.measurements[0].value, 1);
    assert.match(result.findings[0].scope_reason, /Tamsin's POV chapters/u);
    writeRules(root, [{ ...share, pov: undefined, except_pov: ["tamsin"] }]);
    assert.deepEqual(runRules(root, project).findings.map((finding) => finding.scene_id), ["1-1", "1-3"]);
    writeRules(root, [{ ...share, except_pov: ["torven"] }]);
    assert.deepEqual(runRules(root, project).findings.map((finding) => finding.scene_id), ["1-2"]);
    const rate = { id: "chapter-rate", type: "count-per-words", severity: "warn", message: "Check the rate.", text: "I", max: 40, per_words: 100, unit: "chapter", pov: ["tamsin"], speakers: ["grell"] };
    writeRules(root, [rate]);
    const chapter = runRules(root, project, { includeMeasurements: true });
    assert.equal(chapter.findings.length, 1);
    assert.equal(chapter.findings[0].scene_id, "1-2");
    assert.equal(chapter.findings[0].paragraph, 2);
    assert.equal(chapter.measurements[0].value, 50);
    const second = join(root, "manuscript", "chapter-01", "scene-02", "scene.md");
    const memory = runRulesForScene(root, project, "1-2", readFileSync(second, "utf8"));
    assert.deepEqual(memory.findings, chapter.findings, "pre-edit checks must retain POV metadata");
    writeRules(root, [{ ...rate, pov: undefined, speakers: undefined }]);
    assert.equal(runRules(root, project).findings.length, 0, "out-of-scope words would incorrectly dilute this rate");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("POV rules resolve headings recorded by import", () => {
  const root = mkdtempSync(join(tmpdir(), "weaver-rule-import-"));
  try {
    initializeProject(root, { empty: true });
    const source = join(root, "source.md");
    writeFileSync(source, "# Tamsin\n\nI wait. I listen. I leave.\n\n# Torven\n\nI run. I stop. I turn.");
    importBook(root, readProject(root), source);
    seedCharacters(root, ["Tamsin", "Torven"]);
    writeRules(root, [{ id: "i-start", type: "sentence-start-share", severity: "warn", message: "Vary openings.", word: "I", max_share: 0.5, min_sentences: 3, unit: "scene", pov: ["tamsin"] }]);
    assert.deepEqual(runRules(root, readProject(root)).findings.map((finding) => finding.scene_id), ["1-1"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid scope ids and narration-speaker combinations name the rule, while JSON reports scopes", () => {
  const root = fixture([SWEAR], 'Grell said, "Damn this gate."');
  try {
    seedCharacters(root, ["Grell"]);
    for (const key of ["speakers", "except_speakers", "pov", "except_pov"]) {
      writeRules(root, [{ ...SWEAR, [key]: ["unknown-person"] }]);
      assert.throws(() => runRules(root, readProject(root)), /rule swear-words .*unknown character id unknown-person/u);
    }
    for (const key of ["speakers", "except_speakers"]) {
      writeRules(root, [{ ...SWEAR, [key]: ["grell"], scope: "narration" }]);
      assert.throws(() => runRules(root, readProject(root)), /rule swear-words.*cannot be used with scope narration/u);
    }
    writeRules(root, [{ ...SWEAR, speakers: ["grell"] }]);
    const result = spawnSync(process.execPath, [CLI, "rules", "--root", root, "--json"], { env: authorEnv(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.rules[0].scope, "dialogue");
    assert.deepEqual(json.rules[0].speakers, ["grell"]);
    assert.equal(json.rules[0].scope_description, "Applies to dialogue by Grell");
    assert.deepEqual(json.findings[0].speakers, ["grell"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
