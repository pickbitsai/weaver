// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readProject } from "../engine/project.mjs";
import { runRules } from "../engine/rules.mjs";

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
    let result = spawnSync(process.execPath, [CLI, "state:accept", "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    result = spawnSync(process.execPath, [CLI, "check", "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 1);
    const check = JSON.parse(result.stdout);
    assert.deepEqual(check.issues, ["style rules: 1 blocking finding(s)"]);
    assert.deepEqual(check.rules, { blocking: 1, warnings: 0 });
    result = spawnSync(process.execPath, [CLI, "release", "--root", root, "--id", "blocked"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /style rules: 1 blocking finding\(s\)/);

    const warningRoot = fixture([{ id: "warn-delve", type: "phrase-list", severity: "warn", message: "Use specific prose.", phrases: ["delve"] }], "The first line creates a pressure the protagonist cannot ignore. Delve.");
    try {
      assert.equal(spawnSync("git", ["init", "-q"], { cwd: warningRoot }).status, 0);
      result = spawnSync(process.execPath, [CLI, "state:accept", "--root", warningRoot], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      result = spawnSync(process.execPath, [CLI, "check", "--root", warningRoot], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).rules, { blocking: 0, warnings: 1 });
    } finally {
      rmSync(warningRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
