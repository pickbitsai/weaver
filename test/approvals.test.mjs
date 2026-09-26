// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(".");
const CLI = join(ROOT, "scripts", "weaver.mjs");

function git(root, args, env = {}) {
  return spawnSync("git", ["-C", root, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8" });
}

function book({ baseline = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "weaver-approvals-"));
  cpSync(join(ROOT, "templates", "book"), root, { recursive: true });
  assert.equal(git(root, ["init", "-q"]).status, 0);
  if (baseline) {
    git(root, ["config", "--local", "user.name", "Test Author"]);
    git(root, ["config", "--local", "user.email", "test@example.invalid"]);
    assert.equal(git(root, ["add", "-A"]).status, 0);
    assert.equal(git(root, ["commit", "-m", "Baseline"]).status, 0);
  }
  return root;
}

function scenePath(root, chapter = 1, scene = 1) {
  return join(root, "manuscript", `chapter-${String(chapter).padStart(2, "0")}`, `scene-${String(scene).padStart(2, "0")}`, "scene.md");
}

function addScene(root, chapter, scene, prose) {
  const path = scenePath(root, chapter, scene);
  const directory = dirname(path);
  const source = `# Chapter ${chapter}, Scene ${scene}\n\n**POV:** Protagonist\n\n---\n\n${prose}\n\n---\n\n**Words:** 0\n`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, source);
  return path;
}

function run(root, args, globalConfig = join(tmpdir(), `weaver-global-${process.pid}-${Math.random().toString(16).slice(2)}.config`)) {
  writeFileSync(globalConfig, "");
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig },
    encoding: "utf8"
  });
}

test("changes and approve commit only one chapter, recompute words, add trailer, and set local identity", () => {
  const root = book();
  try {
    const second = addScene(root, 2, 1, "A second chapter scene waits for its own decision.");
    const first = scenePath(root);
    writeFileSync(first, readFileSync(first, "utf8").replace("different state.", "different and uncertain state."));
    let result = run(root, ["changes", "--root", root, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const pending = JSON.parse(result.stdout);
    assert.deepEqual(pending.chapters.map((chapter) => chapter.chapter), [1, 2]);

    result = run(root, ["approve", "--root", root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /more than one chapter/i);

    const globalConfig = join(root, "empty-global-config");
    result = run(root, ["approve", "--root", root, "--chapter", "1", "--note", "Opening pass"], globalConfig);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const show = git(root, ["show", "--format=%B", "--name-only", "HEAD"], { GIT_CONFIG_GLOBAL: globalConfig });
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /Approve chapter 1: Opening pass/);
    assert.match(show.stdout, /Approved-with: PickBits Weaver 0\.3\.0/);
    assert.match(show.stdout, /manuscript[\\/]chapter-01[\\/]scene-01[\\/]scene\.md/);
    assert.doesNotMatch(show.stdout, /chapter-02/);
    assert.equal(git(root, ["config", "--local", "--get", "user.name"], { GIT_CONFIG_GLOBAL: globalConfig }).stdout.trim(), "Author");
    assert.equal(git(root, ["config", "--local", "--get", "user.email"], { GIT_CONFIG_GLOBAL: globalConfig }).stdout.trim(), "author@weaver.local");
    assert.equal(readFileSync(first, "utf8").match(/\*\*Words:\*\* (\d+)/u)[1], "22");
    assert.equal(readFileSync(second, "utf8").includes("second chapter"), true);
    assert.equal(readFileSync(globalConfig, "utf8"), "");
    const after = JSON.parse(run(root, ["changes", "--root", root, "--json"], globalConfig).stdout);
    assert.deepEqual(after.chapters.map((chapter) => chapter.chapter), [2]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approve refuses no pending changes and blocking style findings", () => {
  const root = book({ baseline: true });
  try {
    let result = run(root, ["approve", "--root", root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /no scene changes/i);
    writeFileSync(join(root, "quality", "rules.json"), JSON.stringify({ version: 1, rules: [{ id: "ban-delve", type: "phrase-list", severity: "block", message: "Use specific prose.", phrases: ["delve"] }] }));
    const path = scenePath(root);
    writeFileSync(path, readFileSync(path, "utf8").replace("first line creates", "They delve before the first line creates"));
    result = run(root, ["approve", "--root", root, "--chapter", "1"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /blocking style findings/i);
    assert.equal(git(root, ["log", "--format=%s"]).stdout.trim(), "Baseline");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reject restores modified text and moves an untracked scene into rejected", () => {
  const root = book({ baseline: true });
  try {
    const original = readFileSync(scenePath(root), "utf8");
    const changed = original.replace("different state.", "rejected different state.");
    writeFileSync(scenePath(root), changed);
    let result = run(root, ["reject", "--root", root, "--chapter", "1"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(scenePath(root), "utf8").replace(/\r\n/gu, "\n"), original.replace(/\r\n/gu, "\n"));
    const rejectedPath = join(root, result.stdout.match(/in (.+)\.$/m)[1], "manuscript", "chapter-01", "scene-01", "scene.md");
    assert.equal(readFileSync(rejectedPath, "utf8"), changed);

    const newPath = addScene(root, 2, 1, "A new scene that the author rejects.");
    const newText = readFileSync(newPath, "utf8");
    result = run(root, ["reject", "--root", root, "--chapter", "2"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(newPath), false);
    const newRejected = join(root, result.stdout.match(/in (.+)\.$/m)[1], "manuscript", "chapter-02", "scene-01", "scene.md");
    assert.equal(readFileSync(newRejected, "utf8"), newText);
    const history = JSON.parse(run(root, ["history", "--root", root, "--json"]).stdout);
    assert.equal(history.some((entry) => entry.type === "rejection" && entry.chapter === 2), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("undo creates a revert commit, preserves approval history, restores prose, and refuses pending work", () => {
  const root = book({ baseline: true });
  try {
    const path = scenePath(root);
    const before = readFileSync(path, "utf8");
    const edited = before.replace("different state.", "approved changed state.");
    writeFileSync(path, edited);
    let result = run(root, ["approve", "--root", root, "--chapter", "1"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const approvalSha = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    result = run(root, ["undo", "--root", root]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(path, "utf8").replace(/\r\n/gu, "\n"), before.replace(/\r\n/gu, "\n"));
    assert.equal(git(root, ["rev-list", "--count", "HEAD"]).stdout.trim(), "3");
    assert.equal(git(root, ["cat-file", "-t", approvalSha]).stdout.trim(), "commit");
    assert.match(git(root, ["log", "--format=%s"]).stdout, /Revert "Approve chapter 1"/);

    writeFileSync(path, before.replace("different state.", "pending state."));
    result = run(root, ["undo", "--root", root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /pending changes/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approve keeps an author's existing Git identity instead of overriding it locally", () => {
  const root = book();
  const globalConfig = join(tmpdir(), `weaver-global-identity-${process.pid}.config`);
  writeFileSync(globalConfig, "[user]\n\tname = Real Person\n\temail = real@example.invalid\n");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig };
  try {
    const first = scenePath(root);
    writeFileSync(first, readFileSync(first, "utf8").replace("different state.", "different and uncertain state."));
    const result = spawnSync(process.execPath, [CLI, "approve", "--root", root], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(root, ["log", "-1", "--format=%an <%ae>"], env).stdout.trim(), "Real Person <real@example.invalid>");
    assert.notEqual(git(root, ["config", "--local", "--get", "user.name"], env).status, 0, "no local override when an identity exists");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(globalConfig, { force: true });
  }
});

test("import records the original book as the approved starting point", () => {
  const root = mkdtempSync(join(tmpdir(), "weaver-import-baseline-"));
  const source = join(tmpdir(), `weaver-baseline-source-${process.pid}.md`);
  try {
    let result = run(ROOT, ["init", join(root, "book"), "--id", "baseline", "--title", "Baseline", "--empty"]);
    assert.equal(result.status, 0, result.stderr);
    const book = join(root, "book");
    writeFileSync(source, "# Wren\n\nThe original first scene.\n\n* * *\n\nThe original second scene.\n");
    result = run(ROOT, ["import", source, "--root", book]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Saved your original as the starting point/);
    assert.match(git(book, ["log", "-1", "--format=%s"]).stdout, /^Import original manuscript: /);
    result = run(ROOT, ["changes", "--root", book, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const afterImport = JSON.parse(result.stdout);
    assert.equal(afterImport.pending, false, "nothing is pending right after import");
    assert.equal(afterImport.chapters.length, 0);
    const scene = join(book, "manuscript", "chapter-01", "scene-01", "scene.md");
    writeFileSync(scene, readFileSync(scene, "utf8").replace("original first", "repaired first"));
    result = run(ROOT, ["approve", "--root", book, "--chapter", "1"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { force: true });
  }
});
