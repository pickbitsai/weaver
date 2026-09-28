// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { initializeProject } from "../engine/init.mjs";
import { readProject } from "../engine/project.mjs";
import { collectFindings } from "../engine/findings.mjs";

const ROOT = resolve(".");
const CLI = join(ROOT, "scripts", "weaver.mjs");

function book() {
  const root = mkdtempSync(join(tmpdir(), "weaver-ruling-"));
  initializeProject(root, { projectId: "ruling-book", title: "Ruling Book" });
  const rulesPath = join(root, "quality", "rules.json");
  const rules = JSON.parse(readFileSync(rulesPath, "utf8"));
  rules.rules.push({ id: "pressure-block", type: "phrase-list", severity: "block", message: "Avoid this pressure phrase.", phrases: ["creates a pressure"] });
  rules.rules.push({ id: "closing-warn", type: "phrase-list", severity: "warn", message: "Check the closing image.", phrases: ["closing image"] });
  writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`);
  return root;
}

function cli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args, "--root", root], { cwd: ROOT, encoding: "utf8" });
}

function git(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

test("rulings suppress allowed blocks, audit approval, lapse after edits, and commit only the ledger", () => {
  const root = book();
  try {
    const project = readProject(root);
    const initial = collectFindings(root, project);
    const block = initial.findings.find((item) => item.source === "pressure-block");
    const warn = initial.findings.find((item) => item.source === "closing-warn");
    assert.ok(block && warn);
    const unknown = cli(root, ["rule", "0000000000", "--decision", "allow"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown finding id/);
    let result = cli(root, ["rule", block.id, "--decision", "allow", "--note", "Deliberate phrasing"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(git(root, ["show", "--format=", "--name-only", "HEAD"]).stdout.trim().split(/\r?\n/u), ["continuity/rulings.json"]);
    assert.match(git(root, ["log", "-1", "--format=%B"]).stdout, /Approved-with: PickBits Weaver/);
    assert.equal(cli(root, ["state:accept"]).status, 0);
    result = cli(root, ["check"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /1 blocking finding\(s\) allowed by author rulings: /);
    const scene = join(root, "manuscript", "chapter-01", "scene-01", "scene.md");
    writeFileSync(scene, readFileSync(scene, "utf8").replace("Starter placeholder", "Reviewed placeholder"));
    result = cli(root, ["approve", "--chapter", "1"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /1 blocking finding\(s\) allowed by author rulings/);
    result = cli(root, ["rule", warn.id, "--decision", "fix"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(git(root, ["show", "--format=", "--name-only", "HEAD"]).stdout.trim().split(/\r?\n/u), ["continuity/rulings.json"]);
    assert.equal(JSON.parse(cli(root, ["findings", "--to-fix", "--json"]).stdout).findings.length, 1);
    writeFileSync(scene, readFileSync(scene, "utf8").replace("closing image", "last sight"));
    const status = JSON.parse(cli(root, ["rulings", "--json"]).stdout);
    assert.equal(status.find((item) => item.finding_id === warn.id).status, "resolved");
    writeFileSync(scene, readFileSync(scene, "utf8").replace("first line creates a pressure", "first line still creates a pressure"));
    const lapsed = cli(root, ["findings"]);
    assert.match(lapsed.stdout, /an earlier ruling no longer applies because the passage changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
