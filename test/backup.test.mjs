// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeProject } from "../engine/init.mjs";
import { readProject } from "../engine/project.mjs";
import { approveChapter, recordImportBaseline, undoApproval } from "../engine/changes.mjs";
import { importBook } from "../engine/import.mjs";
import { collectFindings } from "../engine/findings.mjs";
import { saveRuling } from "../engine/rulings.mjs";
import { acceptNarrativeState } from "../engine/state.mjs";
import { sealBookSettings, GIT_WRITES, WEAVER_DENY_RULES } from "../engine/guard.mjs";
import { buildRelease } from "../engine/release.mjs";
import { startStudio } from "../engine/studio.mjs";
import { runDoctor } from "../engine/doctor.mjs";
import { acceptProposal, repairChapter } from "../engine/repair.mjs";
import { codexRules, runHook } from "../engine/hooks.mjs";
import { BACKUP_RECORD, BACKUP_REMOTE, BACKUP_TIMEOUT_MS, SETUP_TIMEOUT_MS, backupAfterCommit, backupDoctorCheck, backupNow, backupRunning, backupStatus, describeBackupFailure, formatBackupStatus, readBackupRecord, relativeTime, runBackupWorker, sanitizeGitText, setupBackup, startBackgroundBackup, validateBackupRemote } from "../engine/backup.mjs";
import { authorEnv } from "./helpers/env.mjs";
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
  git(root, "remote", "set-url", BACKUP_REMOTE, join(base, "missing.git"));
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
  git(root, "remote", "set-url", BACKUP_REMOTE, bare);
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
    const server = await startStudio({ root, port: 0 });
    try {
      assert.equal(server.address().address, "127.0.0.1");
      const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.ok(html.includes(configured ? "Backup: up to date · just now" : "Backup: your book isn&#39;t backed up yet"));
      assert.ok(!html.includes(root));
      if (configured) await waitFor(() => readBackupRecord(root).attempts.at(-1)?.trigger === "studio");
    } finally { await close(server); await waitIdle(root); }
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
    assert.equal(backupNow(root, { timeoutMs: 12_345 }).ok, true);
    assert.equal(renames, 2, "the atomic replacement must retry transient Windows contention");
    const pushes = () => calls.filter((call) => call.args.includes("push"));
    assert.equal(pushes().length, 1);
    assert.deepEqual(pushes()[0].args, ["-C", root, "-c", "http.lowSpeedLimit=1", "-c", "http.lowSpeedTime=60", "push", BACKUP_REMOTE, `refs/heads/${name}:refs/heads/${name}`]);
    assert.equal(pushes()[0].options.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(pushes()[0].options.env.GCM_INTERACTIVE, "never");
    assert.deepEqual(pushes()[0].options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(backupNow(root, { interactive: true, timeoutMs: 12_345 }).ok, true);
    assert.equal(pushes()[1].options.env, process.env);
    assert.deepEqual(pushes()[1].args, ["-C", root, "push", BACKUP_REMOTE, `refs/heads/${name}:refs/heads/${name}`]);
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
