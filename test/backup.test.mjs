// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initializeProject } from "../engine/init.mjs";
import { readProject } from "../engine/project.mjs";
import { approveChapter, recordImportBaseline, undoApproval } from "../engine/changes.mjs";
import { importBook } from "../engine/import.mjs";
import { collectFindings } from "../engine/findings.mjs";
import { saveRuling } from "../engine/rulings.mjs";
import { acceptNarrativeState } from "../engine/state.mjs";
import { sealBookSettings, GIT_WRITES, WEAVER_DENY_RULES, GIT_CREDENTIAL_COMMANDS, CREDENTIAL_REASON } from "../engine/guard.mjs";
import { buildRelease } from "../engine/release.mjs";
import { startStudio } from "../engine/studio.mjs";
import { runDoctor } from "../engine/doctor.mjs";
import { acceptProposal, repairChapter } from "../engine/repair.mjs";
import { codexRules, runHook } from "../engine/hooks.mjs";
import { BACKUP_RECORD, BACKUP_REMOTE, BACKUP_TIMEOUT_MS, SETUP_TIMEOUT_MS, backupAfterCommit, backupDoctorCheck, backupNow, backupRunning, backupStatus, describeBackupFailure, formatBackupStatus, readBackupRecord, relativeTime, runBackupWorker, sanitizeGitText, setupBackup, startBackgroundBackup, validateBackupRemote } from "../engine/backup.mjs";
import { authorEnv } from "./helpers/env.mjs";
import { backupNeeded, dropGitOverrides, gitSafeEnv } from "../engine/backup.mjs";
import { makeBook } from "./helpers/book.mjs";

const CLI = resolve("scripts/weaver.mjs");
const SCENE = "manuscript/chapter-01/scene-01/scene.md";
const gitResult = (root, args, env = process.env) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, env });
function git(root, ...args) {
  const result = gitResult(root, args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
const branch = (root) => git(root, "symbolic-ref", "--short", "HEAD");
const head = (root) => git(root, "rev-parse", "HEAD");
function bareRef(bare, name) {
  const result = gitResult(bare, ["rev-parse", "--verify", `refs/heads/${name}`]);
  return result.status === 0 ? result.stdout.trim() : null;
}
async function waitFor(predicate, timeoutMs = 40_000, label = "backup") {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((ready) => setTimeout(ready, 100));
  }
}
const waitIdle = (root) => waitFor(() => !existsSync(join(root, ".weaver/backup.lock")) && !existsSync(join(root, ".weaver/backup.pending")), 40_000, "backup workers to finish");
function bareRepository(path) {
  const result = spawnSync("git", ["init", "--bare", "-q", path], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return path;
}
// A Git process that outlives a timed-out push can still have the bare repository as its
// working folder for a moment; Windows refuses rmdir (EBUSY) until it exits, and rmSync does
// not retry EBUSY on folders, so retry here.
async function removeTree(path) {
  const deadline = Date.now() + 20_000;
  while (true) {
    try { rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); return; }
    catch (error) {
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code) || Date.now() >= deadline) throw error;
      await new Promise((ready) => setTimeout(ready, 250));
    }
  }
}
function fixture(t, empty = false) {
  const base = mkdtempSync(join(tmpdir(), "weaver-backup-"));
  const root = initializeProject(join(base, "book"), { empty });
  const bare = bareRepository(join(base, "backup.git"));
  t.after(async () => { await waitIdle(root); await removeTree(base); });
  return { root, base, bare, project: readProject(root) };
}
const cli = (root, args, env = authorEnv()) => spawnSync(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8", windowsHide: true, env });
function changeScene(root) {
  const path = join(root, SCENE), before = readFileSync(path, "utf8");
  assert.ok(before.includes("different state."));
  writeFileSync(path, before.replace("different state.", "changed state."));
}
function setup(root, bare) {
  const result = setupBackup(root, { remote: bare, interactive: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
function hook(bare, text) {
  git(bare, "config", "core.hooksPath", join(bare, "hooks"));
  writeFileSync(join(bare, "hooks/pre-receive"), `#!/bin/sh\n${text}\n`, { mode: 0o755 });
}
async function backedUp(root, bare, trigger = "decision") {
  const commit = head(root), name = branch(root);
  await waitFor(() => bareRef(bare, name) === commit && readBackupRecord(root)?.attempts.at(-1)?.commit === commit, 40_000, `${trigger} to reach the backup`);
  await waitIdle(root);
  const attempt = readBackupRecord(root).attempts.at(-1);
  assert.equal(attempt.result, "ok");
  assert.equal(attempt.trigger, trigger);
}
const check = (root) => runDoctor({ bookRoot: root }).checks.find((item) => item.id === "backup");
const close = (server) => new Promise((ready) => server.close(ready));
const normalPath = (path) => process.platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path;

test("setup copies history, hides its record, and rejects unsafe addresses without changing settings", (t) => {
  const { root, bare } = fixture(t);
  const result = cli(root, ["backup", "setup", "--remote", bare]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Backup set up/u);
  assert.equal(bareRef(bare, branch(root)), head(root));
  const address = git(root, "remote", "get-url", BACKUP_REMOTE);
  assert.equal(normalPath(address), normalPath(bare));
  const record = readBackupRecord(root);
  assert.equal(record.$schema, "https://pickbits.ai/schemas/weaver/backup-1.json");
  assert.equal(record.generator, "PickBits Weaver 0.3.0");
  assert.equal(record.remote_name, "weaver-backup");
  assert.equal(record.attempts.length, 1);
  assert.equal(record.attempts[0].result, "ok");
  assert.equal(record.attempts[0].trigger, "setup");
  assert.equal(record.attempts[0].commit, head(root));
  assert.equal(record.last_success.commit, head(root));
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(gitResult(root, ["check-ignore", "-q", BACKUP_RECORD]).status, 0);
  for (const remote of ["https://someone:secret@example.invalid/book.git", "https://tokenvalue@example.invalid/book.git", "ext::sh -c true", "-uhttps://example.invalid/x.git", "http://example.invalid/x.git"]) {
    const refused = cli(root, ["backup", "setup", "--remote", remote]);
    assert.equal(refused.status, 1, remote);
    assert.ok(refused.stderr.trim());
    assert.doesNotMatch(refused.stderr + refused.stdout, /    at /u);
    if (remote.includes("@")) assert.match(refused.stderr, /password or access token/u);
    assert.equal(git(root, "remote", "get-url", BACKUP_REMOTE), address);
    assert.equal(readBackupRecord(root).attempts.length, 1);
  }
  assert.doesNotMatch(readFileSync(join(root, BACKUP_RECORD), "utf8"), /secret|tokenvalue/u);
  assert.doesNotMatch(readFileSync(join(root, ".git/config"), "utf8"), /secret|tokenvalue/u);
});

test("approval returns without waiting for a slow backup and without console noise", async (t) => {
  const { root, bare } = fixture(t);
  setup(root, bare);
  const before = head(root);
  hook(bare, "sleep 6");
  changeScene(root);
  const result = cli(root, ["approve", "--chapter", "1"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^Approval [0-9a-f]{7,}: Chapter 1 approved\.\r?\n$/u);
  assert.equal(result.stderr, "");
  assert.equal(bareRef(bare, branch(root)), before, "approval must not wait for the push");
  assert.notEqual(head(root), before);
  await backedUp(root, bare);
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("every engine decision and studio startup starts its own backup", async (t) => {
  const { root, bare, project } = fixture(t);
  setup(root, bare);
  changeScene(root);
  approveChapter(root, project, 1);
  await backedUp(root, bare);
  undoApproval(root);
  await backedUp(root, bare);
  writeFileSync(join(root, "quality/rules.json"), JSON.stringify({ version: 1, rules: [{ id: "test-phrase", type: "phrase-list", severity: "warn", message: "Check this phrase.", phrases: ["first line"] }] }));
  git(root, "add", "quality/rules.json"); git(root, "commit", "-qm", "Add phrase rule");
  assert.notEqual(bareRef(bare, branch(root)), head(root));
  saveRuling(root, project, collectFindings(root, project).findings[0], "allow");
  await backedUp(root, bare);
  acceptNarrativeState(root, project);
  await backedUp(root, bare);
  sealBookSettings(root, project);
  await backedUp(root, bare);
  writeFileSync(join(root, "outline/notes.md"), "Rill follows the Salt Map.\n");
  git(root, "add", "outline/notes.md"); git(root, "commit", "-qm", "Save outline note");
  assert.notEqual(bareRef(bare, branch(root)), head(root));
  buildRelease(root, project, "backup-test");
  await backedUp(root, bare);
  writeFileSync(join(root, "outline/notes.md"), "Tovan follows the Salt Map.\n");
  git(root, "add", "outline/notes.md"); git(root, "commit", "-qm", "Save another note");
  assert.notEqual(bareRef(bare, branch(root)), head(root));
  const server = await startStudio({ root, port: 0 });
  try { await backedUp(root, bare, "studio"); } finally { await close(server); }
});

test("import baseline starts a backup", async (t) => {
  const { root, base, bare, project } = fixture(t, true);
  setup(root, bare);
  const source = join(base, "salt-map.md");
  writeFileSync(source, "# Chapter 1\n\nRill carries the Salt Map across a quiet courtyard.\n");
  const imported = importBook(root, project, source);
  recordImportBaseline(root, imported.project, imported.record, imported.importPath);
  await backedUp(root, bare);
});

test("accepting a repair proposal starts a backup", async (t) => {
  // Own both cleanups so detached workers finish before makeBook's folder is removed.
  const { root, project } = makeBook({ after: () => {} }, { severity: "warn" });
  const base = mkdtempSync(join(tmpdir(), "weaver-proposal-backup-"));
  t.after(async () => {
    await waitIdle(root);
    for (const path of [root, base]) await removeTree(path);
  });
  const bare = bareRepository(join(base, "backup.git"));
  for (const finding of collectFindings(root, project).findings) saveRuling(root, project, finding, "fix");
  const proposal = await repairChapter(root, project, { chapter: 1, run: true, onProgress: () => {} });
  assert.equal(proposal.status, "ready");
  setup(root, bare);
  const before = head(root);
  acceptProposal(root, project, 1, { edits: [1] });
  assert.notEqual(head(root), before);
  await backedUp(root, bare);
});

test("a missing backup folder never stops approval, and a later success clears the warning", async (t) => {
  const { root, base, bare } = fixture(t);
  setup(root, bare);
  await renameFolder(bare, join(base, "unplugged.git"));
  changeScene(root);
  const approval = cli(root, ["approve", "--chapter", "1"]);
  assert.equal(approval.status, 0, approval.stdout + approval.stderr);
  await waitFor(() => readBackupRecord(root).attempts.at(-1)?.result === "failed");
  await waitIdle(root);
  const status = cli(root, ["backup", "status"]);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /your last backup failed/iu);
  assert.match(status.stdout, /couldn't find your backup repository/iu);
  assert.doesNotMatch(status.stdout, /fatal:|    at /u);
  assert.equal(JSON.parse(cli(root, ["backup", "status", "--json"]).stdout).state, "failed");
  assert.equal(check(root).status, "warning");
  assert.equal(runDoctor({ bookRoot: root }).ok, true);
  const failed = cli(root, ["backup", "now"]);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /Backup failed:[\s\S]*Fix:/u);
  await renameFolder(join(base, "unplugged.git"), bare);
  const fixed = cli(root, ["backup", "now"]);
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  assert.match(fixed.stdout, /Backed up: commit/u);
  assert.equal(bareRef(bare, branch(root)), head(root));
  assert.equal(backupStatus(root).state, "up-to-date");
  assert.equal(check(root).status, "pass");
});

test("doctor reports unconfigured, waiting, overdue, stale and missing-address states without blocking", (t) => {
  const { root, bare } = fixture(t);
  assert.equal(check(root).status, "warning");
  assert.equal(check(root).findings[0].problem, "Your book isn't backed up yet");
  assert.equal(backupStatus(root).summary, "Backup: your book isn't backed up yet");
  assert.equal(runDoctor({ bookRoot: root }).ok, true);
  setup(root, bare);
  assert.equal(check(root).status, "pass");
  assert.equal(backupStatus(root).summary, "Backup: up to date · just now");
  const args = ["commit", "--allow-empty", "-m", "Ruling: allow synthetic", "-m", "Approved-with: PickBits Weaver 0.3.0"];
  git(root, ...args);
  assert.equal(check(root).status, "pass");
  assert.match(backupStatus(root).summary, /1 new decision waiting to be backed up/u);
  assert.equal(gitResult(root, args, { ...process.env, GIT_COMMITTER_DATE: new Date(Date.now() - 2 * 3600_000).toISOString() }).status, 0);
  const behind = backupStatus(root);
  assert.equal(behind.state, "behind");
  assert.equal(behind.unpushed.decisions, 2);
  assert.equal(behind.unpushed.overdue_decisions, 1);
  assert.equal(check(root).status, "warning");
  assert.equal(check(root).findings[0].problem, "1 author decision has not reached your backup for over an hour");
  assert.equal(backupNow(root).ok, true);
  assert.equal(check(root).status, "pass");
  const record = readBackupRecord(root), now = Date.now();
  record.last_success.at = record.attempts.at(-1).at = new Date(now - 2 * 86400_000).toISOString();
  writeFileSync(join(root, BACKUP_RECORD), JSON.stringify(record));
  assert.equal(backupStatus(root, { now }).state, "stale");
  assert.match(check(root).findings[0].problem, /last successful backup was 2 days ago/u);
  git(root, "remote", "remove", BACKUP_REMOTE);
  assert.equal(backupStatus(root).state, "remote-missing");
  assert.equal(check(root).findings.length, 1, "missing address suppresses other backup problems");
  assert.equal(check(root).findings[0].problem, "The backup address is missing from your book's Git settings");
});

test("studio footer shows current backup status without exposing the book folder", async (t) => {
  for (const configured of [true, false]) {
    const { root, bare } = fixture(t);
    if (configured) setup(root, bare);
    const original = childProcess.spawn;
    const spawned = t.mock.method(childProcess, "spawn", (...args) => original(...args));
    syncBuiltinESMExports();
    let server;
    try {
      server = await startStudio({ root, port: 0 });
      assert.equal(server.address().address, "127.0.0.1");
      const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.ok(html.includes(configured ? "Backup: up to date · just now" : "Backup: your book isn&#39;t backed up yet"));
      assert.ok(!html.includes(root));
      if (configured) {
        assert.equal(spawned.mock.calls.some((call) => call.arguments[1].some((arg) => arg.includes("backup-worker.mjs"))), false);
        assert.equal(readBackupRecord(root).attempts.length, 1);
      }
    } finally { spawned.mock.restore(); syncBuiltinESMExports(); if (server) await close(server); await waitIdle(root); }
  }
});

test("AI can check or retry backup but cannot choose the destination, edit the record or write Git history", (t) => {
  const { root, bare } = fixture(t);
  const env = { ...authorEnv(), CLAUDECODE: "1" };
  const args = ["backup", "setup", "--remote", bare, "--json"];
  const refused = cli(root, args, env);
  assert.equal(refused.status, 1);
  const refusal = JSON.parse(refused.stdout);
  assert.match(refusal.error, /author's decision/u);
  assert.match(refusal.fix, /npx weaver backup setup/u);
  assert.match(refusal.fix, /npx weaver studio/u);
  assert.notEqual(gitResult(root, ["remote", "get-url", BACKUP_REMOTE]).status, 0);
  assert.equal(cli(root, args).status, 0);
  assert.equal(cli(root, ["backup", "now"], env).status, 0);
  assert.equal(cli(root, ["backup", "status", "--json"], env).status, 0);
  const shell = (command) => runHook("shell", { cwd: root, tool_name: "Bash", tool_input: { command } });
  const denied = (command) => {
    const result = shell(command)?.hookSpecificOutput;
    assert.equal(result?.permissionDecision, "deny", command);
    return result.permissionDecisionReason;
  };
  for (const command of ["npx weaver backup setup --remote https://example.invalid/x.git", "weaver backup setup", "node node_modules/@pickbitsai/weaver/scripts/weaver.mjs backup setup --remote x"]) assert.match(denied(command), /author's decision/u);
  for (const command of ["git remote add origin https://example.invalid/x.git", "git remote set-url weaver-backup x", "git -C . remote remove weaver-backup", "git push weaver-backup main"]) denied(command);
  for (const command of ["npx weaver backup status", "npx weaver backup now", "npx weaver backup status --json", "git status"]) assert.equal(shell(command), null, command);
  try { GIT_WRITES.delete("remote"); assert.equal(shell("git remote add origin x"), null); }
  finally { GIT_WRITES.add("remote"); }
  denied("git remote add origin x");
  for (const [tool_name, tool_input] of [["Edit", { file_path: BACKUP_RECORD }], ["apply_patch", { command: `*** Begin Patch\n*** Update File: ${BACKUP_RECORD}\n@@\n-old\n+new\n*** End Patch` }]]) {
    assert.equal(runHook("pre", { cwd: root, tool_name, tool_input })?.hookSpecificOutput?.permissionDecision, "deny");
  }
});

test("generated backup rules match templates and doctor detects each removed protection", (t) => {
  const { root } = fixture(t);
  for (const rule of ["Bash(weaver backup setup:*)", "Bash(npx weaver backup setup:*)"]) assert.ok(WEAVER_DENY_RULES.includes(rule));
  assert.ok(codexRules().includes('prefix_rule(pattern=["npx","weaver","backup","setup"]'));
  assert.match(codexRules().split("\n").find((line) => line.includes('[["git"')), /"remote"/u);
  assert.equal(readFileSync("templates/book/.codex/rules/weaver.rules", "utf8").replaceAll("\r\n", "\n"), codexRules());
  assert.deepEqual(JSON.parse(readFileSync("templates/book/.claude/settings.json", "utf8")).permissions.deny, WEAVER_DENY_RULES);
  const guard = () => runDoctor({ bookRoot: root }).checks.find((item) => item.id === "guardrails-installed");
  assert.equal(guard().status, "pass");
  const path = join(root, ".claude/settings.json"), original = readFileSync(path, "utf8"), settings = JSON.parse(original);
  settings.permissions.deny = settings.permissions.deny.filter((rule) => rule !== "Bash(npx weaver backup setup:*)");
  writeFileSync(path, JSON.stringify(settings));
  assert.equal(guard().status, "blocking");
  writeFileSync(path, original);
  assert.equal(guard().status, "pass");
  const codexPath = join(root, ".codex/rules/weaver.rules"), rules = readFileSync(codexPath, "utf8");
  writeFileSync(codexPath, rules.split("\n").filter((line) => !line.includes('["weaver","backup","setup"]')).join("\n"));
  assert.equal(guard().status, "blocking");
  writeFileSync(codexPath, rules);
  assert.equal(guard().status, "pass");
});

test("backup failures use plain words, classify in order and redact credentials", () => {
  const cases = [
    ["fatal: Authentication failed for 'https://github.com/example/book.git/'", {}, /sign-in/u, /Git Credential Manager[\s\S]*GitHub/u],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", {}, /sign-in/u, /Git Credential Manager/u],
    ["git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", {}, /SSH key/u, /https/u],
    ["fatal: unable to access 'https://github.com/example/book.git/': Could not resolve host: github.com", {}, /couldn't reach/u, /internet connection/u],
    ["remote: Repository not found.\nfatal: repository 'https://github.com/example/book.git/' not found", {}, /couldn't find/u, /private repository exists/u],
    [" ! [rejected]        main -> main (fetch first)", { trigger: "setup" }, /already has other files/u, /empty private repository/u],
    [" ! [rejected]        main -> main (fetch first)", { trigger: "decision" }, /didn't overwrite/u, /PickBits/u],
    ["[remote rejected] protected branch; updates were rejected", { trigger: "setup" }, /service refused/u, /branch protection/u],
    ["Authentication failed", { timedOut: true }, /took too long/u, /internet connection/u],
    ["an unexpected response", {}, /didn't go through/u, /try again/u]
  ];
  for (const [output, options, error, fix] of cases) {
    const result = describeBackupFailure(output, options);
    assert.match(result.error, error);
    assert.match(result.fix, fix);
  }
  assert.doesNotMatch(describeBackupFailure("fatal: unable to access 'https://someone:secret@example.invalid/x.git/'").detail, /secret|someone/u);
  assert.equal(describeBackupFailure("").detail, null);
  assert.equal(describeBackupFailure("one\n\ntwo\nthree\nfour\n").detail, "two / three / four");
  assert.equal(describeBackupFailure("x".repeat(400)).detail.length, 300);
  assert.equal(sanitizeGitText("SSH://user:secret@example.invalid/x"), "SSH://example.invalid/x");
  const now = Date.now();
  for (const [seconds, expected] of [[-10, "just now"], [10, "just now"], [61, "1 minute ago"], [300, "5 minutes ago"], [3600, "1 hour ago"], [10800, "3 hours ago"], [90000, "1 day ago"], [176400, "2 days ago"]]) {
    assert.equal(relativeTime(now - seconds * 1000, now), expected);
    assert.equal(relativeTime(new Date(now - seconds * 1000).toISOString(), now), expected);
  }
});

test("a push timeout is recorded and its slow receive hook can finish before cleanup", async (t) => {
  const { root, bare } = fixture(t);
  setup(root, bare);
  hook(bare, 'sleep 5\ntouch "$GIT_DIR/hook-done"');
  changeScene(root);
  git(root, "add", SCENE); git(root, "commit", "-qm", "Save timeout fixture");
  const result = backupNow(root, { timeoutMs: 1500 });
  try {
    assert.equal(result.ok, false);
    assert.equal(result.attempt.error, "The backup took too long and was stopped.");
    assert.equal(readBackupRecord(root).attempts.at(-1).result, "failed");
  } finally { await waitFor(() => existsSync(join(bare, "hook-done")), 15_000, "timed-out hook to finish"); }
});

test("unconfigured backup does not start any child and reports a nonblocking setup reminder", (t) => {
  const { root } = fixture(t);
  const sync = t.mock.method(childProcess, "spawnSync", () => { throw new Error("unexpected Git child"); });
  const async = t.mock.method(childProcess, "spawn", () => { throw new Error("unexpected worker"); });
  syncBuiltinESMExports();
  try {
    assert.equal(readBackupRecord(root), null);
    assert.deepEqual(startBackgroundBackup(root), { started: false, reason: "not-configured" });
    assert.deepEqual(backupAfterCommit(root), { started: false, reason: "not-configured" });
    assert.equal(backupNow(root).configured, false);
    assert.equal(backupStatus(root).state, "not-configured");
    runBackupWorker(root);
    assert.equal(backupDoctorCheck(root, { inGit: false }).status, "warning");
    assert.equal(sync.mock.calls.length, 0);
    assert.equal(async.mock.calls.length, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  const result = cli(root, ["backup", "now"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Your book isn't backed up yet/u);
});

test("remote validation accepts secure addresses and folder paths, refusing each unsafe form", () => {
  const cwd = resolve("test");
  assert.equal(validateBackupRemote(" ../backup.git ", { cwd }), resolve(cwd, "../backup.git"));
  for (const value of ["https://example.invalid/book.git", "ssh://git@example.invalid/book.git", "git@example.invalid:book.git", "host:book.git", "file:///backups/book.git"]) assert.equal(validateBackupRemote(value), value);
  if (process.platform === "win32") assert.equal(validateBackupRemote("C:/book.git"), resolve("C:/book.git"));
  for (const [value, message] of [[undefined, /Give the backup address/u], ["-x", /dash/u], ["folder\u0000name", /characters Git can't use/u], ["ext::x", /only to/u], ["ftp://example.invalid/x", /only to/u], ["http://example.invalid/x", /https/u], ["ssh://git:secret@example.invalid/x", /password or access token/u], ["https://[", /valid https or ssh/u]]) assert.throws(() => validateBackupRemote(value), message);
  assert.equal(BACKUP_TIMEOUT_MS, 120_000);
  assert.equal(SETUP_TIMEOUT_MS, 300_000);
});

test("a changed destination clears tracking refs and prior success even when verification fails", (t) => {
  const { root, bare, base } = fixture(t);
  setup(root, bare);
  const other = bareRepository(join(base, "other.git"));
  git(root, "update-ref", `refs/remotes/${BACKUP_REMOTE}/old-branch`, head(root));
  hook(other, "echo 'remote rejected: hook declined' >&2\nexit 1");
  const result = setupBackup(root, { remote: other, interactive: false });
  assert.equal(result.ok, false);
  assert.match(result.attempt.error, /service refused/u);
  assert.equal(readBackupRecord(root).last_success, null);
  assert.equal(git(root, "for-each-ref", "--format=%(refname)", `refs/remotes/${BACKUP_REMOTE}/`), "");
  assert.equal(readBackupRecord(root).attempts.length, 2);
  assert.equal(git(root, "remote", "get-url", BACKUP_REMOTE), other);
  assert.equal(backupStatus(root).unpushed.commits, Number(git(root, "rev-list", "--count", "HEAD")));
  // Returning to the first destination reestablishes tracking even without a fetch refspec.
  git(root, "config", "--unset-all", `remote.${BACKUP_REMOTE}.fetch`);
  setup(root, bare);
  assert.equal(git(root, "rev-parse", `refs/remotes/${BACKUP_REMOTE}/${branch(root)}`), head(root));
  assert.equal(backupStatus(root).state, "up-to-date");
});

test("attempt history is capped while last success survives, and a corrupt record is still configured", (t) => {
  const { root, bare, base } = fixture(t);
  setup(root, bare);
  const record = readBackupRecord(root), success = record.last_success;
  record.attempts = Array.from({ length: 50 }, (_, index) => ({ ...record.attempts[0], at: new Date(1_600_000_000_000 + index * 1000).toISOString() }));
  writeFileSync(join(root, BACKUP_RECORD), JSON.stringify(record));
  git(root, "remote", "set-url", BACKUP_REMOTE, join(base, "absent.git"));
  assert.equal(backupNow(root).ok, false);
  const capped = readBackupRecord(root);
  assert.equal(capped.attempts.length, 50);
  assert.equal(capped.attempts[0].at, record.attempts[1].at);
  assert.equal(capped.attempts.at(-1).result, "failed");
  assert.deepEqual(capped.last_success, success);
  writeFileSync(join(root, BACKUP_RECORD), "{broken");
  assert.deepEqual(readBackupRecord(root), { remote_name: BACKUP_REMOTE, attempts: [], last_success: null });
  assert.equal(backupStatus(root).state, "unchecked");
  git(root, "remote", "set-url", BACKUP_REMOTE, bare);
  assert.equal(backupNow(root).ok, true);
  assert.equal(readBackupRecord(root).attempts.length, 1);
  assert.equal(readBackupRecord(root).last_success.commit, head(root));
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("worker marks a busy lock pending, and stale locks recover without losing the pending backup", (t) => {
  const { root, bare } = fixture(t);
  setup(root, bare);
  const lock = join(root, ".weaver/backup.lock"), pending = join(root, ".weaver/backup.pending");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  assert.equal(backupRunning(root), true);
  assert.match(backupStatus(root).summary, /\(backing up now\)$/u);
  runBackupWorker(root);
  assert.equal(existsSync(pending), true);
  assert.equal(readBackupRecord(root).attempts.length, 1);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 601_000).toISOString() }));
  assert.equal(backupRunning(root), false);
  runBackupWorker(root);
  assert.equal(readBackupRecord(root).attempts.length, 2);
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(pending), false);
  const dead = spawnSync(process.execPath, ["-e", "0"], { windowsHide: true });
  assert.equal(dead.status, 0);
  writeFileSync(lock, JSON.stringify({ pid: dead.pid, at: new Date().toISOString() }));
  assert.equal(backupRunning(root), false);
  assert.equal(backupNow(root).ok, true);
  assert.equal(existsSync(lock), false);
});

test("decisions arriving during a push are backed up by the holder's next round", async (t) => {
  const { root, bare } = fixture(t);
  setup(root, bare);
  hook(bare, 'touch "$GIT_DIR/hook-started"\nsleep 2');
  git(root, "commit", "--allow-empty", "-qm", "First queued change");
  assert.equal(backupAfterCommit(root).started, true);
  await waitFor(() => existsSync(join(bare, "hook-started")), 40_000, "first push to start");
  git(root, "commit", "--allow-empty", "-qm", "Second queued change");
  // Synchronous worker takes the busy path deterministically while the detached holder pushes.
  runBackupWorker(root);
  await backedUp(root, bare);
  assert.ok(readBackupRecord(root).attempts.length >= 3);
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("backup excludes use the book prefix when the book is inside a larger repository", (t) => {
  const { root, base, bare } = fixture(t);
  const nested = join(root, "nested-book");
  mkdirSync(nested);
  writeFileSync(join(nested, "note.md"), "Rill studies the Salt Map.\n");
  git(root, "add", "nested-book/note.md"); git(root, "commit", "-qm", "Add nested book");
  setup(nested, bare);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(gitResult(nested, ["check-ignore", "-q", BACKUP_RECORD]).status, 0);
  const exclude = resolve(nested, git(nested, "rev-parse", "--git-path", "info/exclude"));
  assert.ok(readFileSync(exclude, "utf8").includes("/nested-book/.weaver/backup*"));
  assert.equal(validateBackupRemote("backup.git", { cwd: base }), bare);
  assert.equal(backupNow(nested).ok, true);
});

test("status formatting includes counts and plain fixes, with multiple warnings in priority order", (t) => {
  const { root, bare } = fixture(t);
  setup(root, bare);
  const record = readBackupRecord(root), now = Date.now();
  record.last_success.at = new Date(now - 2 * 86400_000).toISOString();
  record.attempts.push({ ...record.attempts[0], result: "failed", at: new Date(now - 120_000).toISOString(), error: "The backup didn't go through.", fix: "Try again." });
  writeFileSync(join(root, BACKUP_RECORD), JSON.stringify(record));
  const args = ["commit", "--allow-empty", "-m", "Imported synthetic", "-m", "Imported-with: PickBits Weaver 0.3.0"];
  assert.equal(gitResult(root, args, { ...process.env, GIT_COMMITTER_DATE: new Date(now - 2 * 3600_000).toISOString() }).status, 0);
  const status = backupStatus(root, { now });
  assert.equal(status.state, "failed");
  assert.equal(status.problems.length, 3);
  assert.match(status.problems[0].problem, /failed 2 minutes ago: The backup didn't go through$/u);
  assert.match(status.problems[1].problem, /1 author decision has/u);
  assert.match(status.problems[2].problem, /2 days ago/u);
  assert.equal(status.unpushed.decisions, 1);
  const output = formatBackupStatus(status);
  assert.match(output, /Address: .+ \(Git remote weaver-backup\)/u);
  assert.match(output, /Last backup: .+ · commit [a-f0-9]{7} on /u);
  assert.match(output, /Last attempt: .+ · failed: The backup didn't go through\./u);
  assert.match(output, /Waiting to be backed up: 1 author decision, 1 commit/u);
  assert.match(output, /\n! .+\n  Why: .+\n  Fix: /u);
});

test("Git children are bounded and hidden, prompts are opt-in, and writes retry Windows rename contention under the lock", (t) => {
  const { root, bare } = fixture(t);
  setup(root, bare);
  const name = branch(root);
  const spawnOriginal = childProcess.spawnSync, renameOriginal = fs.renameSync;
  const calls = [];
  let renames = 0;
  t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    calls.push({ command, args, options });
    return spawnOriginal(command, args, options);
  });
  t.mock.method(fs, "renameSync", (from, to) => {
    assert.equal(from, `${join(root, BACKUP_RECORD)}.${process.pid}.tmp`);
    assert.equal(to, join(root, BACKUP_RECORD));
    assert.equal(existsSync(join(root, ".weaver/backup.lock")), true);
    if (++renames === 1) throw Object.assign(new Error("Synthetic contention"), { code: "EBUSY" });
    return renameOriginal(from, to);
  });
  syncBuiltinESMExports();
  try {
    const noninteractiveCommit = head(root);
    calls.pop(); // Exclude this test's head query from the backup child checks below.
    assert.equal(backupNow(root, { timeoutMs: 12_345 }).ok, true);
    assert.equal(renames, 2, "the atomic replacement must retry transient Windows contention");
    const pushes = () => calls.filter((call) => call.args.includes("push"));
    assert.equal(pushes().length, 1);
    assert.deepEqual(pushes()[0].args, ["-C", root, "-c", "http.lowSpeedLimit=1", "-c", "http.lowSpeedTime=60", "push", BACKUP_REMOTE, `${noninteractiveCommit}:refs/heads/${name}`]);
    assert.equal(pushes()[0].options.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(pushes()[0].options.env.GCM_INTERACTIVE, "never");
    assert.deepEqual(pushes()[0].options.stdio, ["ignore", "pipe", "pipe"]);
    const interactiveCommit = head(root);
    calls.pop(); // Exclude this test's head query from the backup child checks below.
    assert.equal(backupNow(root, { interactive: true, timeoutMs: 12_345 }).ok, true);
    assert.equal(pushes()[1].options.env, process.env);
    assert.deepEqual(pushes()[1].args, ["-C", root, "push", BACKUP_REMOTE, `${interactiveCommit}:refs/heads/${name}`]);
    for (const call of calls) {
      assert.equal(call.command, "git");
      assert.equal(call.options.windowsHide, true);
      assert.equal(call.options.timeout, call.args.includes("push") ? 12_345 : 30_000);
      assert.notEqual(call.options.shell, true);
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(existsSync(`${join(root, BACKUP_RECORD)}.${process.pid}.tmp`), false);
  assert.equal(existsSync(join(root, ".weaver/backup.lock")), false);
});

test("setup requires saved book history and a missing Git address becomes a recorded failure", (t) => {
  const { root, bare, base } = fixture(t);
  const outside = join(base, "outside");
  mkdirSync(outside);
  assert.throws(() => setupBackup(outside, { remote: bare }), /isn't under Git yet/u);
  git(outside, "init", "-q");
  assert.throws(() => setupBackup(outside, { remote: bare }), /no saved history yet/u);
  assert.equal(existsSync(join(outside, BACKUP_RECORD)), false);
  setup(root, bare);
  git(root, "remote", "remove", BACKUP_REMOTE);
  const result = backupNow(root);
  assert.equal(result.ok, false);
  assert.equal(result.attempt.commit, null);
  assert.equal(result.attempt.error, "The backup address is missing from your book's Git settings.");
  assert.equal(readBackupRecord(root).attempts.at(-1).result, "failed");
});

test("foreground commands time out politely on a busy lock without writing a record", (t) => {
  const { root, bare } = fixture(t);
  setup(root, bare);
  const path = join(root, ".weaver/backup.lock"), before = readFileSync(join(root, BACKUP_RECORD), "utf8");
  const at = Date.now();
  writeFileSync(path, JSON.stringify({ pid: process.pid, at: new Date(at).toISOString() }));
  let now = at;
  t.mock.method(Date, "now", () => now += 31_000);
  try {
    assert.deepEqual(backupNow(root, { timeoutMs: 1 }), { ok: false, configured: true, attempt: null, error: "A backup is already running.", fix: "Check `npx weaver backup status` in a minute." });
    assert.throws(() => setupBackup(root, { remote: bare, timeoutMs: 1 }), /A backup is already running\. Try again in a minute\./u);
    assert.equal(readFileSync(join(root, BACKUP_RECORD), "utf8"), before);
  } finally { t.mock.restoreAll(); rmSync(path, { force: true }); }
});

test("backup doctor catches unexpected read errors and stays a warning", (t) => {
  const { root, bare } = fixture(t);
  setup(root, bare);
  t.mock.method(childProcess, "spawnSync", () => { throw new Error("Synthetic read failure"); });
  syncBuiltinESMExports();
  try {
    const result = backupDoctorCheck(root);
    assert.equal(result.status, "warning");
    assert.equal(result.findings[0].problem, "Your backup couldn't be checked");
    assert.equal(result.summary, "Backup: your backup couldn't be checked");
    assert.doesNotThrow(() => runBackupWorker(root));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

async function renameFolder(from, to) {
  for (let retry = 0; ; retry++) {
    try { renameSync(from, to); return; }
    catch (error) {
      if (!["EBUSY", "EPERM"].includes(error.code) || retry >= 10) throw error;
      await new Promise((ready) => setTimeout(ready, 200));
    }
  }
}

function overrideEnv(t, values) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const restore = () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  t.after(restore);
  Object.assign(process.env, values);
  return restore;
}

async function nestedBook(t) {
  const { base, root: outer, bare } = fixture(t);
  const root = initializeProject(join(outer, "Draft [v2]"));
  const gitDirectory = resolve(root, ".git");
  assert.equal(gitDirectory, join(outer, "Draft [v2]", ".git"));
  await removeTree(gitDirectory);
  git(outer, "add", "--", "Draft [v2]");
  git(outer, "commit", "-qm", "Save nested Salt Map book");
  return { base, root, outer, bare };
}

function refusedInside(root, address) {
  const before = git(root, "status", "--porcelain");
  const exclude = resolve(root, git(root, "rev-parse", "--git-path", "info/exclude"));
  const excluded = existsSync(exclude) ? readFileSync(exclude, "utf8") : null;
  const config = resolve(root, git(root, "rev-parse", "--git-common-dir"), "config");
  const settings = readFileSync(config, "utf8");
  const assertUnchanged = () => {
    assert.notEqual(gitResult(root, ["remote", "get-url", BACKUP_REMOTE]).status, 0, address);
    assert.equal(existsSync(join(root, BACKUP_RECORD)), false, address);
    assert.equal(existsSync(join(root, ".weaver/backup.lock")), false, address);
    assert.equal(git(root, "status", "--porcelain"), before, address);
    assert.equal(readFileSync(config, "utf8"), settings, address);
    assert.equal(existsSync(exclude) ? readFileSync(exclude, "utf8") : null, excluded, address);
  };
  const result = cli(root, ["backup", "setup", "--remote", address]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /separate copy/u);
  assert.match(result.stderr, /outside the book folder/u);
  assert.doesNotMatch(result.stdout + result.stderr, /    at /u);
  assertUnchanged();
  assert.throws(() => setupBackup(root, { remote: address, interactive: false }), (error) => {
    assert.match(error.message, /separate copy/u);
    assert.match(error.message, /outside the book folder/u);
    return true;
  });
  assertUnchanged();
}

test("backup destinations inside the book, linked to it or sharing its history are refused before any write", async (t) => {
  const { root, base } = fixture(t);
  const inside = bareRepository(join(root, "backup.git"));
  const link = join(base, "book-link");
  symlinkSync(root, link, "junction");
  const second = join(base, "second-checkout");
  git(root, "worktree", "add", "-q", second, "-b", "other-line");
  for (const address of [root, inside, join(root, ".git"), pathToFileURL(inside).href, link, second,
    join(root, "not-created", "backup.git"), join(link, "not-created", "backup.git")]) refusedInside(root, address);
  if (process.platform === "win32") refusedInside(root, inside.toUpperCase());
  const nested = await nestedBook(t);
  refusedInside(nested.root, nested.outer);
  const sibling = bareRepository(join(base, "book-backup.git"));
  setup(root, sibling);
  assert.equal(bareRef(sibling, branch(root)), head(root));
  const dotted = bareRepository(join(base, "..notes"));
  setup(root, dotted);
  assert.equal(bareRef(dotted, branch(root)), head(root));
});

test("a matching hand-written address inside the book still cannot be pushed", (t) => {
  const { root } = fixture(t);
  const inside = bareRepository(join(root, "backup.git"));
  git(root, "remote", "add", BACKUP_REMOTE, inside);
  mkdirSync(join(root, ".weaver"), { recursive: true });
  writeFileSync(join(root, BACKUP_RECORD), JSON.stringify({ remote_url: inside, push_url: inside }));
  const result = backupNow(root);
  assert.equal(result.ok, false);
  assert.match(result.attempt.error, /points into the book itself/u);
  assert.equal(result.attempt.commit, null);
  assert.equal(result.attempt.branch, null);
  assert.equal(backupStatus(root).state, "failed");
  assert.equal(git(inside, "for-each-ref"), "");
});

test("author CLI rejects reordered backup subcommands and never seals a reordered guard command", (t) => {
  const { root, bare } = fixture(t);
  const before = head(root);
  for (const args of [
    ["backup", "--root", root, "setup", "--remote", bare],
    ["backup", "--remote", bare, "setup"],
    ["backup", `--remote=${bare}`, "setup"],
    ["backup", "--json", "setup", "--remote", bare]
  ]) {
    const result = cli(root, args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, /Put setup, status or now right after/u);
    assert.notEqual(gitResult(root, ["remote", "get-url", BACKUP_REMOTE]).status, 0);
    assert.equal(existsSync(join(root, BACKUP_RECORD)), false);
  }
  cli(root, ["guard", "--root", root, "seal"]);
  assert.equal(head(root), before);
  assert.equal(existsSync(join(root, ".weaver/guard.json")), false);
});

test("shell guard denies reordered setup and seal forms within their command segment", (t) => {
  const { root } = fixture(t);
  const shell = (command, options) => runHook("shell", { cwd: root, tool_name: "Bash", tool_input: { command } }, options);
  const backupCommands = [
    "npx weaver backup --root . setup --remote https://example.invalid/x.git",
    "npx weaver backup --remote https://example.invalid/x.git setup",
    "npx weaver backup --remote=https://example.invalid/x.git setup",
    "weaver backup --json setup",
    "env -u CLAUDECODE npx weaver backup --root . setup --remote https://example.invalid/x.git",
    "$env:CLAUDECODE=''; npx weaver backup --root . setup --remote https://example.invalid/x.git",
    "node node_modules/@pickbitsai/weaver/scripts/weaver.mjs backup --remote=https://example.invalid/x.git setup",
    "npx weaver backup now --remote https://example.invalid/x.git",
    "weaver.cmd backup --root setup", "weaver backup --json setup=x"
  ];
  for (const command of [...backupCommands, "npx weaver guard --root . seal", "env -u CLAUDECODE npx weaver guard --root . seal"]) {
    const denied = shell(command)?.hookSpecificOutput;
    assert.equal(denied?.permissionDecision, "deny", command);
    assert.match(denied.permissionDecisionReason, /author's decision/u);
    if (backupCommands.includes(command)) assert.match(denied.permissionDecisionReason, /backup setup/u);
    assert.equal(shell(command, { decideShell: () => null }), null, "disabling the guard permits the same command");
  }
  for (const command of ["npx weaver backup status", "npx weaver backup now", "npx weaver backup status --json",
    "npx weaver backup status --root ./setup-notes", "npx weaver backup now --json", "git status",
    "weaver backup status; echo setup", "weaver backup status && echo setup", "weaver backup status | echo setup",
    "weaver backup status\necho setup", "weaver guard --root ./seal-notes"]) assert.equal(shell(command), null, command);
});

test("CLI backup ignores caller Git settings and repository overrides", (t) => {
  const { root, bare, base } = fixture(t);
  setup(root, bare);
  git(root, "commit", "--allow-empty", "-qm", "Rill saves another note");
  const evil = bareRepository(join(base, "other.git"));
  const result = cli(root, ["backup", "now"], { ...authorEnv(), CLAUDECODE: "1", GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `remote.${BACKUP_REMOTE}.pushurl`, GIT_CONFIG_VALUE_0: evil, GIT_DIR: evil });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(bareRef(bare, branch(root)), head(root));
  assert.equal(git(evil, "for-each-ref"), "");
  assert.equal(backupStatus(root).state, "up-to-date");
});

test("studio drops caller Git overrides before approvals and backup children", async (t) => {
  const { root, bare, base } = fixture(t);
  setup(root, bare);
  const evil = bareRepository(join(base, "other.git"));
  const restore = overrideEnv(t, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `remote.${BACKUP_REMOTE}.pushurl`, GIT_CONFIG_VALUE_0: evil });
  const server = await startStudio({ root, port: 0 });
  try {
    assert.equal(process.env.GIT_CONFIG_COUNT, undefined);
    assert.equal(process.env.GIT_CONFIG_KEY_0, undefined);
    assert.equal(process.env.GIT_CONFIG_VALUE_0, undefined);
    changeScene(root);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/approve`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-Weaver-Studio": "1", Origin: baseUrl }, body: JSON.stringify({ chapter: 1 }) });
    assert.equal(response.status, 200, await response.text());
    await backedUp(root, bare);
    assert.equal(git(evil, "for-each-ref"), "");
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<footer>[\s\S]*Backup: up to date/u);
  } finally { restore(); await close(server); }
});

test("Git environment filtering preserves identity and credentials but strips overrides from workers", async (t) => {
  const removed = ["GIT_CONFIG_COUNT", "git_config_key_0", "GIT_DIR", "GIT_SSH_COMMAND", "GIT_EXEC_PATH", "GIT_TRACE2_EVENT"];
  const kept = { PATH: "synthetic-bin", HOME: "synthetic-home", USERPROFILE: "synthetic-profile", GIT_AUTHOR_NAME: "Rill",
    GIT_COMMITTER_NAME: "Tovan", GIT_ASKPASS: "synthetic-askpass", GIT_EDITOR: "synthetic-editor", GCM_INTERACTIVE: "never" };
  const env = { ...kept, ...Object.fromEntries(removed.map((key) => [key, "synthetic"])) };
  assert.deepEqual(gitSafeEnv(env), kept);
  assert.equal(Object.keys(env).length, Object.keys(kept).length + removed.length, "copying must not mutate its input");
  assert.equal(gitSafeEnv(kept), kept);
  assert.deepEqual(dropGitOverrides(env), removed);
  assert.deepEqual(env, kept);
  assert.deepEqual(dropGitOverrides(env), []);
  const { root, bare, base } = fixture(t);
  setup(root, bare);
  const evil = bareRepository(join(base, "other.git"));
  const original = childProcess.spawn;
  const spawned = t.mock.method(childProcess, "spawn", (...args) => original(...args));
  syncBuiltinESMExports();
  const restore = overrideEnv(t, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `remote.${BACKUP_REMOTE}.pushurl`, GIT_CONFIG_VALUE_0: evil });
  try {
    assert.equal(backupAfterCommit(root).started, true);
    assert.equal(spawned.mock.calls.length, 1);
    const [command, args, options] = spawned.mock.calls[0].arguments;
    assert.equal(command, process.execPath);
    assert.ok(args[0].endsWith("backup-worker.mjs"));
    assert.equal(options.env.GIT_CONFIG_COUNT, undefined);
    assert.equal(options.env.GIT_CONFIG_KEY_0, undefined);
    assert.equal(options.env.GIT_CONFIG_VALUE_0, undefined);
    assert.equal(options.windowsHide, true);
    assert.notEqual(options.shell, true);
  } finally { restore(); spawned.mock.restore(); syncBuiltinESMExports(); }
  await waitFor(() => readBackupRecord(root).attempts.length === 2);
  await backedUp(root, bare);
  assert.equal(git(evil, "for-each-ref"), "");
});

for (const redirect of ["pushurl", "pushInsteadOf", "second-url"]) test(`backup stops a config-level ${redirect} redirect independently of environment filtering`, (t) => {
  const { root, bare, base } = fixture(t);
  setup(root, bare);
  const previous = head(root), name = branch(root), success = readBackupRecord(root).last_success;
  const evil = bareRepository(join(base, "other.git"));
  git(root, "commit", "--allow-empty", "-qm", "Rill saves a note before redirect");
  if (redirect === "pushurl") git(root, "config", `remote.${BACKUP_REMOTE}.pushurl`, evil);
  if (redirect === "pushInsteadOf") git(root, "config", `url.${evil}.pushInsteadOf`, bare);
  if (redirect === "second-url") git(root, "config", "--add", `remote.${BACKUP_REMOTE}.url`, evil);
  const result = backupNow(root);
  assert.equal(result.ok, false);
  assert.match(result.attempt.error, /different address than the one you set up/u);
  assert.equal(result.attempt.commit, null);
  assert.equal(result.attempt.branch, null);
  assert.equal(result.attempt.detail, null);
  assert.equal(git(evil, "for-each-ref"), "");
  assert.equal(bareRef(bare, name), previous);
  assert.equal(git(root, "rev-parse", `refs/remotes/${BACKUP_REMOTE}/${name}`), previous);
  assert.deepEqual(readBackupRecord(root).last_success, success);
  const status = backupStatus(root);
  assert.equal(status.state, "address-changed");
  assert.equal(status.problems[0].problem, "Your backup address was changed outside Weaver");
  assert.equal(status.problems.some((item) => /last backup failed/u.test(item.problem)), false);
  const doctor = runDoctor({ bookRoot: root });
  const backup = doctor.checks.find((item) => item.id === "backup");
  assert.equal(backup.status, "warning");
  assert.equal(backup.findings[0].problem, status.problems[0].problem);
  assert.equal(doctor.ok, true);
  if (redirect === "pushInsteadOf") git(root, "config", "--unset-all", `url.${evil}.pushInsteadOf`);
  const confirmed = cli(root, ["backup", "setup", "--remote", bare]);
  assert.equal(confirmed.status, 0, confirmed.stdout + confirmed.stderr);
  assert.equal(gitResult(root, ["config", "--get-all", `remote.${BACKUP_REMOTE}.pushurl`]).status, 1);
  assert.equal(git(root, "config", "--get-all", `remote.${BACKUP_REMOTE}.url`), bare);
  assert.equal(backupStatus(root).state, "up-to-date");
  assert.equal(bareRef(bare, name), head(root));
});

test("a redirect introduced during a push cannot advance the confirmed tracking ref or last success", (t) => {
  const { root, bare, base } = fixture(t);
  setup(root, bare);
  const previous = head(root), name = branch(root), success = readBackupRecord(root).last_success;
  const fetchRules = git(root, "config", "--get-all", `remote.${BACKUP_REMOTE}.fetch`);
  const evil = bareRepository(join(base, "other.git"));
  git(root, "commit", "--allow-empty", "-qm", "Tovan saves a new note");
  const commit = head(root), original = childProcess.spawnSync;
  const calls = [];
  const spy = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    calls.push(args);
    const result = original(command, args, options);
    if (command === "git" && args.includes("push")) {
      assert.equal(result.status, 0, result.stderr);
      const changed = original("git", ["-C", root, "config", `remote.${BACKUP_REMOTE}.pushurl`, evil], { encoding: "utf8", windowsHide: true });
      assert.equal(changed.status, 0, changed.stderr);
    }
    return result;
  });
  syncBuiltinESMExports();
  let result;
  try { result = backupNow(root); }
  finally { spy.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(result.ok, false);
  assert.match(result.attempt.error, /different address than the one you set up/u);
  assert.equal(result.attempt.commit, commit);
  assert.equal(result.attempt.branch, name);
  assert.equal(result.attempt.detail, null);
  assert.deepEqual(calls.filter((args) => args.includes("update-ref")).map((args) => args.slice(args.indexOf("update-ref") + 1)),
    [[`refs/remotes/${BACKUP_REMOTE}/${name}`, previous]], "only puts back the tracking ref Git moved during the push");
  assert.equal(bareRef(bare, name), commit, "the actual push completed before the redirect");
  assert.equal(git(root, "rev-parse", `refs/remotes/${BACKUP_REMOTE}/${name}`), previous);
  assert.equal(git(root, "config", "--get-all", `remote.${BACKUP_REMOTE}.fetch`), fetchRules);
  assert.deepEqual(readBackupRecord(root).last_success, success);
  assert.equal(git(evil, "for-each-ref"), "");
});

test("a damaged record permits one unchanged raw address but refuses redirects without adopting one", (t) => {
  const { root, bare, base } = fixture(t);
  setup(root, bare);
  const evil = bareRepository(join(base, "other.git"));
  writeFileSync(join(root, BACKUP_RECORD), "{broken");
  git(root, "config", `remote.${BACKUP_REMOTE}.pushurl`, evil);
  const result = backupNow(root);
  assert.equal(result.ok, false);
  assert.match(result.attempt.error, /different address than the one you set up/u);
  assert.equal(git(evil, "for-each-ref"), "");
  assert.equal(readBackupRecord(root).remote_url, null);
  assert.equal(readBackupRecord(root).push_url, null);
  git(root, "config", "--unset-all", `remote.${BACKUP_REMOTE}.pushurl`);
  assert.equal(backupNow(root).ok, true);
  assert.equal(readBackupRecord(root).remote_url, null);
  assert.equal(readBackupRecord(root).push_url, null);
});

test("setup captures the effective rewritten address and keeps the author's raw address", (t) => {
  const { root, bare } = fixture(t);
  const address = "ssh://git@example.invalid/salt-map.git";
  git(root, "config", `url.${bare}.insteadOf`, address);
  setup(root, address);
  const record = readBackupRecord(root);
  assert.equal(record.remote_url, sanitizeGitText(address));
  assert.equal(record.push_url, bare);
  assert.equal(Object.keys(JSON.parse(readFileSync(join(root, BACKUP_RECORD), "utf8"))).indexOf("push_url"), 4);
  assert.equal(backupStatus(root).state, "up-to-date");
  assert.equal(backupNow(root).ok, true);
  // Compare raw configuration on repeated setup: rewriting must not erase other tracking refs.
  const ref = `refs/remotes/${BACKUP_REMOTE}/other-line`;
  git(root, "update-ref", ref, head(root));
  setup(root, address);
  assert.equal(git(root, "rev-parse", ref), head(root));
  git(root, "config", "--unset-all", `url.${bare}.insteadOf`);
  assert.equal(backupStatus(root).state, "address-changed");
});

test("a commit made as the push starts stays waiting while the captured commit is backed up", (t) => {
  const { root, bare } = fixture(t);
  setup(root, bare);
  git(root, "commit", "--allow-empty", "-qm", "Rill saves the first note");
  const commit = head(root), name = branch(root), original = childProcess.spawnSync;
  const spy = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    if (command === "git" && args.includes("push")) {
      const changed = original("git", ["-C", root, "commit", "--allow-empty", "-qm", "Tovan saves a concurrent note"], { encoding: "utf8", windowsHide: true });
      assert.equal(changed.status, 0, changed.stderr);
    }
    return original(command, args, options);
  });
  syncBuiltinESMExports();
  let result;
  try { result = backupNow(root); }
  finally { spy.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(result.ok, true);
  assert.notEqual(head(root), commit);
  assert.equal(result.attempt.commit, commit);
  assert.equal(bareRef(bare, name), commit);
  assert.equal(git(root, "rev-parse", `refs/remotes/${BACKUP_REMOTE}/${name}`), commit);
  assert.match(backupStatus(root).summary, /1 new change waiting/u);
});

test("backups never rewrite the book's Git settings, and a redirect during a push leaves no new tracking ref", (t) => {
  const { root, bare, base } = fixture(t);
  setup(root, bare);
  const config = resolve(root, git(root, "rev-parse", "--git-common-dir"), "config");
  const settings = readFileSync(config, "utf8");
  git(root, "commit", "--allow-empty", "-qm", "Rill saves another note");
  assert.equal(backupNow(root).ok, true);
  hook(bare, "echo 'remote rejected: hook declined' >&2\nexit 1");
  git(root, "commit", "--allow-empty", "-qm", "Tovan saves another note");
  assert.equal(backupNow(root).ok, false);
  assert.equal(readFileSync(config, "utf8"), settings, "pushing must not change the book's Git settings");
  rmSync(join(bare, "hooks/pre-receive"));
  const tracking = `refs/remotes/${BACKUP_REMOTE}/${branch(root)}`;
  git(root, "update-ref", "-d", tracking);
  const evil = bareRepository(join(base, "other.git")), original = childProcess.spawnSync;
  const spy = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    const result = original(command, args, options);
    if (command === "git" && args.includes("push")) original("git", ["-C", root, "config", `remote.${BACKUP_REMOTE}.pushurl`, evil], { windowsHide: true });
    return result;
  });
  syncBuiltinESMExports();
  let result;
  try { result = backupNow(root); } finally { spy.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(result.ok, false);
  assert.match(result.attempt.error, /different address than the one you set up/u);
  assert.equal(bareRef(bare, branch(root)), head(root), "the push itself completed before the redirect");
  assert.notEqual(gitResult(root, ["rev-parse", "--verify", "--quiet", tracking]).status, 0, "the tracking ref Git created during the push is removed again");
});

test("nested books escape Git ignore glob characters in the backup exclude", async (t) => {
  const { root, outer, bare } = await nestedBook(t);
  setup(root, bare);
  assert.equal(git(outer, "status", "--porcelain"), "");
  assert.equal(gitResult(root, ["check-ignore", "-q", BACKUP_RECORD]).status, 0);
  const exclude = resolve(root, git(root, "rev-parse", "--git-path", "info/exclude"));
  assert.ok(readFileSync(exclude, "utf8").includes("/Draft \\[v2\\]/.weaver/backup*"));
});

test("odd backup records normalize safely and CLI status remains plain text", (t) => {
  const { root, bare } = fixture(t);
  setup(root, bare);
  const original = readBackupRecord(root);
  for (const last_success of [{ at: "yesterday", branch: "main" }, "saved", [], null]) {
    for (const attempts of ["failed", null, {}, [null, "failed", [], 17, { result: "failed" }], [{ result: "failed", at: { toString: null }, error: {}, fix: [] }]]) {
      writeFileSync(join(root, BACKUP_RECORD), JSON.stringify({ ...original, last_success, attempts }));
      const record = readBackupRecord(root);
      assert.equal(record.last_success, null);
      assert.deepEqual(record.attempts, Array.isArray(attempts) ? attempts.filter((item) => item && !Array.isArray(item) && typeof item === "object") : []);
      const result = cli(root, ["backup", "status"]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /^Backup:/u);
      assert.doesNotMatch(result.stdout + result.stderr, /TypeError|Cannot read|    at /u);
      if (record.attempts.length) {
        assert.match(result.stdout, /the backup didn't go through/u);
        assert.match(result.stdout, /Run `npx weaver backup now` to try again\./u);
      }
    }
  }
  for (const value of ["{broken", "null", "[]", '"saved"', "17"]) {
    writeFileSync(join(root, BACKUP_RECORD), value);
    assert.deepEqual(readBackupRecord(root), { remote_name: BACKUP_REMOTE, attempts: [], last_success: null });
  }
  writeFileSync(join(root, BACKUP_RECORD), JSON.stringify(original));
  assert.deepEqual(readBackupRecord(root).last_success, original.last_success);
});

test("CLI setup refuses a Git folder without a Weaver project", (t) => {
  const { base, bare } = fixture(t);
  const root = join(base, "plain-repository");
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "-c", "user.name=Rill", "-c", "user.email=rill@example.invalid", "commit", "--allow-empty", "-qm", "Save plain history");
  const result = cli(root, ["backup", "setup", "--remote", bare]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /isn't a Weaver book/u);
  assert.notEqual(gitResult(root, ["remote", "get-url", BACKUP_REMOTE]).status, 0);
  assert.equal(existsSync(join(root, BACKUP_RECORD)), false);
  setup(root, bare);
  assert.equal(bareRef(bare, branch(root)), head(root), "the engine remains usable for any repository");
});

test("backup address forms distinguish SSH paths and refuse embedded sign-in material", () => {
  for (const address of ["nas:/srv/git/book.git", "backups:book.git", "my_nas:/srv/book.git", "git@github.com:owner/repo.git"]) assert.equal(validateBackupRemote(address), address);
  assert.throws(() => validateBackupRemote("x-access-token:ghp_SECRET@github.com:owner/repo.git"), /password or access token/u);
  for (const address of ["https://github.com/owner/repo.git?access_token=x", "ssh://git@example.invalid/x.git#frag"]) assert.throws(() => validateBackupRemote(address), /after \? or #/u);
  assert.throws(() => validateBackupRemote("https://mike@bitbucket.org/acme/book.git"), (error) => {
    assert.match(error.message, /part before @/u);
    assert.match(error.message, /password or access token/u);
    return true;
  });
  if (process.platform === "win32") {
    assert.equal(validateBackupRemote("C:/book.git"), resolve("C:/book.git"));
    assert.equal(validateBackupRemote("C:\\book.git"), resolve("C:\\book.git"));
  }
});

test("a plain file destination is a missing repository, with an outside-folder remedy", (t) => {
  const { root, base } = fixture(t);
  const file = join(base, "plain-file");
  writeFileSync(file, "Rill carries the Salt Map.\n");
  const result = setupBackup(root, { remote: file, interactive: false });
  assert.equal(result.ok, false);
  assert.match(result.attempt.error, /couldn't find your backup repository/u);
  assert.doesNotMatch(result.attempt.error, /couldn't reach/u);
  assert.match(result.attempt.fix, /private repository exists/u);
  assert.match(result.attempt.fix, /outside the book folder/u);
  assert.match(describeBackupFailure("fatal: not a git repository\nCould not read from remote repository.").error, /couldn't find/u);
});

test("setup repairs an unborn local bare HEAD so a plain clone restores the book", (t) => {
  const { root, base } = fixture(t);
  const bare = join(base, "fresh.git");
  git(base, "-c", "init.defaultBranch=placeholder", "init", "--bare", "-q", bare);
  assert.notEqual(branch(root), "placeholder");
  setup(root, bare);
  assert.equal(git(bare, "symbolic-ref", "HEAD"), `refs/heads/${branch(root)}`);
  const restored = join(base, "restored");
  git(base, "clone", "-q", bare, restored);
  assert.equal(existsSync(join(restored, "project.json")), true);
  assert.equal(head(restored), head(root));
  git(bare, "update-ref", "refs/heads/existing-line", head(root));
  git(bare, "symbolic-ref", "HEAD", "refs/heads/existing-line");
  setup(root, bare);
  assert.equal(git(bare, "symbolic-ref", "HEAD"), "refs/heads/existing-line", "an existing branch remains the default");
});

test("Codex rules explain terminal backup setup and doctor requires both credential rules", (t) => {
  const { root } = fixture(t);
  const rules = codexRules(), lines = rules.trimEnd().split("\n");
  const backupLines = lines.filter((line) => line.includes('"backup","setup"'));
  assert.equal(backupLines.length, 9);
  for (const line of backupLines) {
    assert.ok(line.endsWith('justification="Choosing where the book is backed up is the author\'s decision; ask them to run npx weaver backup setup in a terminal.")'));
    assert.doesNotMatch(line, /author page/u);
  }
  const patterns = [[["git", "git.exe"], GIT_CREDENTIAL_COMMANDS], [GIT_CREDENTIAL_COMMANDS.flatMap((word) => [`git-${word}`, `git-${word}.exe`])]];
  const writesIndex = lines.findIndex((line) => line.includes(JSON.stringify([["git", "git.exe"], [...GIT_WRITES]])));
  assert.ok(writesIndex >= 0);
  const credentialLines = patterns.map((pattern) => `prefix_rule(pattern=${JSON.stringify(pattern)}, decision="forbidden", justification="Git sign-in details belong to the author; Weaver never needs them.")`);
  for (const line of credentialLines) assert.ok(lines.indexOf(line) > writesIndex);
  assert.equal(readFileSync("templates/book/.codex/rules/weaver.rules", "utf8").replaceAll("\r\n", "\n"), rules);
  const guard = () => runDoctor({ bookRoot: root }).checks.find((item) => item.id === "guardrails-installed");
  const path = join(root, ".codex/rules/weaver.rules");
  assert.equal(guard().status, "pass");
  for (const line of credentialLines) {
    writeFileSync(path, rules.replace(`${line}\n`, ""));
    assert.equal(guard().status, "blocking");
    writeFileSync(path, rules);
    assert.equal(guard().status, "pass");
  }
});

test("shell guard denies Git credential commands and helpers while allowing history reads", (t) => {
  const { root } = fixture(t);
  const shell = (command, options) => runHook("shell", { cwd: root, tool_name: "Bash", tool_input: { command } }, options);
  for (const command of ["git credential fill", "git -C . credential fill", "git credential-manager get", "git-credential-manager get",
    "git-credential-manager.exe erase", 'cmd /c "git credential fill"',
    ...GIT_CREDENTIAL_COMMANDS.flatMap((word) => [`git ${word} get`, `git-${word}.exe get`]), "git credential-future get"]) {
    const result = shell(command)?.hookSpecificOutput;
    assert.equal(result?.permissionDecision, "deny", command);
    assert.match(result.permissionDecisionReason, /sign-in details/u);
    assert.equal(result.permissionDecisionReason, CREDENTIAL_REASON);
    assert.equal(shell(command, { decideShell: () => null }), null);
  }
  assert.equal(shell("git status"), null);
  assert.equal(shell("git log --oneline"), null);
  for (const word of GIT_CREDENTIAL_COMMANDS) assert.equal(GIT_WRITES.has(word), false);
});

test("backupNeeded distinguishes fresh copies from waiting, failed, stale and redirected backups", (t) => {
  const { root, bare, base } = fixture(t);
  assert.equal(backupNeeded(root), false);
  setup(root, bare);
  assert.equal(backupNeeded(root), false);
  git(root, "commit", "--allow-empty", "-qm", "Rill saves a note");
  assert.equal(backupNeeded(root), true);
  assert.equal(backupNow(root).ok, true);
  assert.equal(backupNeeded(root), false);
  const record = readBackupRecord(root), path = join(root, BACKUP_RECORD), now = Date.now();
  writeFileSync(path, JSON.stringify({ ...record, attempts: [...record.attempts, { result: "failed" }] }));
  assert.equal(backupNeeded(root), true);
  writeFileSync(path, JSON.stringify({ ...record, last_success: { ...record.last_success, at: new Date(now - 2 * 86400_000).toISOString() } }));
  assert.equal(backupNeeded(root, { now }), true);
  writeFileSync(path, JSON.stringify(record));
  git(root, "config", `remote.${BACKUP_REMOTE}.pushurl`, join(base, "other.git"));
  assert.equal(backupNeeded(root), true);
  git(root, "config", "--unset-all", `remote.${BACKUP_REMOTE}.pushurl`);
  assert.equal(backupNeeded(root), false);
  const spy = t.mock.method(childProcess, "spawnSync", () => { throw new Error("Synthetic check failure"); });
  syncBuiltinESMExports();
  try { assert.equal(backupNeeded(root), true); }
  finally { spy.mock.restore(); syncBuiltinESMExports(); }
});

test("studio spawns no backup for an up-to-date book and exactly one for a new commit", async (t) => {
  const { root, bare } = fixture(t);
  setup(root, bare);
  for (const changed of [false, true]) {
    if (changed) git(root, "commit", "--allow-empty", "-qm", "Tovan saves a note before studio");
    const original = childProcess.spawn;
    const spy = t.mock.method(childProcess, "spawn", (...args) => original(...args));
    syncBuiltinESMExports();
    let server;
    try {
      server = await startStudio({ root, port: 0 });
      const workers = spy.mock.calls.filter((call) => call.arguments[1].some((arg) => arg.includes("backup-worker.mjs")));
      assert.equal(workers.length, changed ? 1 : 0);
      if (changed) {
        assert.ok(workers[0].arguments[1].includes("studio"));
        await backedUp(root, bare, "studio");
      } else assert.equal(readBackupRecord(root).attempts.length, 1);
    } finally { spy.mock.restore(); syncBuiltinESMExports(); if (server) await close(server); }
  }
});
