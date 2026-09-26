// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "scripts", "weaver.mjs");

function book() {
  const root = mkdtempSync(join(tmpdir(), "weaver-hooks-"));
  cpSync(join(ROOT, "templates", "book"), root, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  return root;
}

function cli(args, root, input) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, input, encoding: "utf8" });
}

function scenePath(root) {
  return join(root, "manuscript", "chapter-01", "scene-01", "scene.md");
}

test("hooks pre and post are fail-open and enforce the edited scene", () => {
  const root = book();
  try {
    const payload = JSON.stringify({
      cwd: root,
      tool_name: "Edit",
      tool_input: { file_path: scenePath(root), old_string: "short", new_string: "a much longer replacement" }
    });
    const pre = cli(["hook", "pre"], root, payload);
    assert.equal(pre.status, 0, pre.stderr);
    const preOutput = JSON.parse(pre.stdout);
    assert.equal(preOutput.suppressOutput, true);
    assert.match(preOutput.hookSpecificOutput.additionalContext, /# Editorial rules/);
    assert.match(preOutput.hookSpecificOutput.additionalContext, /Net word count: \+3/);
    assert.match(preOutput.hookSpecificOutput.additionalContext, /R1\/R2/);

    const rules = {
      version: 1,
      rules: [{ id: "banned-delve", type: "phrase-list", severity: "block", message: "Use specific prose.", phrases: ["delve"] }]
    };
    writeFileSync(join(root, "quality", "rules.json"), `${JSON.stringify(rules)}\n`);
    const path = scenePath(root);
    const raw = readFileSync(path, "utf8");
    const first = raw.indexOf("---");
    const last = raw.lastIndexOf("---");
    writeFileSync(path, `${raw.slice(0, first + 3)}\n\nThey delve into the problem.\n\n${raw.slice(last)}`);
    const post = cli(["hook", "post"], root, JSON.stringify({ cwd: root, tool_name: "Edit", tool_input: { file_path: path } }));
    assert.equal(post.status, 0, post.stderr);
    const postOutput = JSON.parse(post.stdout);
    assert.equal(postOutput.decision, "block");
    assert.match(postOutput.reason, /paragraph 1/);
    assert.match(postOutput.reason, /fix these before continuing/);

    const nonScene = cli(["hook", "post"], root, JSON.stringify({ cwd: root, tool_input: { file_path: join(root, "README.md") } }));
    assert.equal(nonScene.status, 0);
    assert.equal(nonScene.stdout, "");
    const malformed = cli(["hook", "post"], root, "not json");
    assert.equal(malformed.status, 0);
    assert.equal(malformed.stdout, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hooks install merges unrelated settings and is idempotent", () => {
  const root = book();
  try {
    const settingsPath = join(root, ".claude", "settings.json");
    const directory = dirname(settingsPath);
    mkdirSync(directory, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ unrelated: true, hooks: { PreToolUse: [{ matcher: "Other", hooks: [{ type: "command", command: "other" }] }] } }));
    assert.equal(cli(["hooks", "install"], root).status, 0);
    const first = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(first.unrelated, true);
    assert.equal(cli(["hooks", "install"], root).status, 0);
    const second = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(second, first);
    assert.equal(second.hooks.PreToolUse.filter((entry) => entry.hooks?.some((hook) => hook.command === "npx --no-install weaver hook pre")).length, 1);
    assert.equal(second.hooks.PostToolUse.filter((entry) => entry.hooks?.some((hook) => hook.command === "npx --no-install weaver hook post")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post hook blocks editing another chapter while one chapter is pending", () => {
  const root = book();
  try {
    const secondDirectory = join(root, "manuscript", "chapter-02", "scene-01");
    mkdirSync(secondDirectory, { recursive: true });
    writeFileSync(join(secondDirectory, "scene.md"), `# Chapter 2, Scene 1\n\n**POV:** Protagonist\n\n---\n\nA second chapter scene carries the consequence forward.\n\n---\n\n**Words:** 9\n`);
    const first = scenePath(root);
    writeFileSync(first, readFileSync(first, "utf8").replace("different state.", "different and changed state."));
    const result = cli(["hook", "post"], root, JSON.stringify({ cwd: root, tool_name: "Edit", tool_input: { file_path: join(secondDirectory, "scene.md") } }));
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /Chapter 1 has changes waiting/);
    assert.match(output.reason, /editing chapter 2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hooks install still uses the doctor refusal for a broken book", () => {
  const root = book();
  try {
    rmSync(join(root, ".git"), { recursive: true, force: true });
    // New books ship with hooks, so strip them first: a real install would add them back, which
    // makes "byte-identical afterwards" prove the refused command wrote nothing.
    const settingsPath = join(root, ".claude", "settings.json");
    const stripped = `${JSON.stringify({ marker: "kept", hooks: {} }, null, 2)}\n`;
    writeFileSync(settingsPath, stripped);
    const result = cli(["hooks", "install"], root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Your book folder is not under Git/);
    assert.equal(readFileSync(settingsPath, "utf8"), stripped);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
