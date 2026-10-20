// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AI_HOST_ENV, AUTHOR_ONLY_COMMANDS, protectedPath, WEAVER_DENY_RULES } from "../engine/guard.mjs";
import { runHook, installHooks } from "../engine/hooks.mjs";
import { initializeProject } from "../engine/init.mjs";
import { runDoctor } from "../engine/doctor.mjs";
import { readProject } from "../engine/project.mjs";
import { collectFindings } from "../engine/findings.mjs";
import { approveChapter } from "../engine/changes.mjs";
import { acceptNarrativeState } from "../engine/state.mjs";
import { authorEnv } from "./helpers/env.mjs";

const ROOT = resolve(".");
const CLI = join(ROOT, "scripts", "weaver.mjs");
const SCENE = "manuscript/chapter-01/scene-01/scene.md";
function fixture(t, empty = false) {
  const base = mkdtempSync(join(tmpdir(), "weaver-guard-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = initializeProject(join(base, "book"), { empty });
  const homeDirectory = join(base, "home");
  mkdirSync(join(homeDirectory, ".claude"), { recursive: true });
  return { root, base, homeDirectory };
}
function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function cli(root, args, env = authorEnv(), input) {
  return spawnSync(process.execPath, [CLI, ...args, "--root", root], { cwd: root, env, input, encoding: "utf8" });
}
function denied(result, label = "") {
  assert.equal(result?.hookSpecificOutput?.hookEventName, "PreToolUse", label);
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny", label);
  const reason = result.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /author|PickBits/u, label);
  assert.match(reason, /ask|tell|can't|belongs/iu, label);
  assert.doesNotMatch(reason, /stack|TypeError|EPERM|EACCES/u, label);
}
function allowed(result, label = "") {
  assert.notEqual(result?.hookSpecificOutput?.permissionDecision, "deny", label);
  assert.notEqual(result?.decision, "block", label);
}
const shell = (root, command, options) => {
  const result = runHook("shell", { cwd: root, tool_name: "Bash", tool_input: { command } }, options);
  const codex = runHook("shell", { hook_event_name: "PreToolUse", session_id: "synthetic", turn_id: "turn", tool_use_id: "call", cwd: root, tool_name: "Bash", tool_input: { command } }, options);
  assert.deepEqual(codex, result, `Codex and Claude shell decisions: ${command}`);
  return result;
};
const edit = (root, path, tool_name = "Edit", options) => runHook("pre", { cwd: root, tool_name, tool_input: { [tool_name === "NotebookEdit" ? "notebook_path" : "file_path"]: path } }, options);
function changeScene(root) {
  const path = join(root, SCENE);
  writeFileSync(path, readFileSync(path, "utf8").replace("different state.", "changed state."));
}
function check(context, id) {
  return runDoctor({ bookRoot: context.root, homeDirectory: context.homeDirectory }).checks.find((entry) => entry.id === id);
}

test("shell guard denies normal author, history, installation, settings, and HTTP writes", (t) => {
  const { root } = fixture(t);
  const commands = [
    "npx weaver approve --chapter 3", "npx --no-install weaver approve",
    "npx weaver proposal accept --chapter 2", "npx.cmd weaver proposal reject --chapter 2",
    "node node_modules/weaver/scripts/weaver.mjs rule F1 --decision allow",
    'cmd /c "npx weaver undo"', "echo ok && npx weaver release --id x",
    'git commit -am "fix"', "git -C . reset --hard HEAD~1", "git config user.name x",
    "npm install weaver@0.1.0", "npm uninstall weaver", "echo {} > quality/rules.json",
    "Set-Content quality/rules.json '{}'", "sed -i s/x/y/ .claude/settings.json",
    "Remove-Item .claude/settings.json", `node -e "require('fs').writeFileSync('quality/rules.json','{}')"`,
    "curl -X POST http://127.0.0.1:4187/api/approve",
    "Invoke-RestMethod -Method Post http://localhost:4187/api/rulings",
    "npx.cmd weaver reject", "node_modules/.bin/weaver.cmd approve", "./node_modules/.bin/weaver undo",
    'powershell -Command "npx weaver state:accept"', "bash -c 'weaver guard seal'",
    "echo ok;weaver import file.md", "echo ok|weaver approve", "false||weaver undo",
    "git branch -D spare", "git branch --move spare", "git -C 'some folder' -c x=y commit",
    "pnpm add weaver", "yarn upgrade", "npx weaver@0.1.0 check", "npx --package weaver check",
    "cat notes.md >> quality/rules.json", "Get-Content notes.md > .claude/settings.local.json",
    "wget http://[::1]:4187/", "iwr http://localhost:4187/", "irm http://localhost:4187/",
    `node -e "fetch('http://localhost:4187/api/approve')"`, "rm ../outside.md",
    `Set-Content '${join(root, "quality", "rules.json")}' '{}'`,
    `bash -c 'git -C "some folder" commit -m change'`,
    `powershell -Command "Set-Content quality/rules.json '{}'"`
  ];
  for (const command of commands) denied(shell(root, command), command);
  for (const subcommand of "commit reset revert rebase restore checkout switch merge cherry-pick stash push pull am apply filter-branch filter-repo update-ref config tag clean gc reflog notes replace".split(" ")) denied(shell(root, `git -C . ${subcommand}`), subcommand);
  for (const manager of ["npm", "pnpm", "yarn"]) for (const subcommand of "install i add uninstall remove update upgrade ci link rebuild".split(" ")) denied(shell(root, `${manager} ${subcommand}`), `${manager} ${subcommand}`);
  for (const command of AUTHOR_ONLY_COMMANDS) denied(shell(root, `npx weaver ${command}`), command);
  assert.match(shell(root, commands[0]).hookSpecificOutput.permissionDecisionReason, /approve chapter 3 on the author page/u);
  assert.match(shell(root, "npm install weaver").hookSpecificOutput.permissionDecisionReason, /installed and maintained by PickBits/u);
});

test("shell guard leaves reads, prose work, checks, review, and studio alone", (t) => {
  const { root } = fixture(t);
  for (const command of [
    "git status", "git diff", "git log --oneline", "git show HEAD:quality/rules.json", "git blame quality/rules.json",
    "npx weaver check", "npx weaver changes", "npx weaver findings --chapter 2", "npx weaver studio",
    "cat quality/rules.json", "Get-Content quality/rules.json", "cd ../unrelated; npm test",
    "npx weaver review --chapter 2 --run", "node node_modules/weaver/scripts/weaver.mjs check",
    "node_modules/.bin/weaver.cmd changes", "Set-Content outline/plot-structure.md 'A note'",
    "curl https://example.invalid:4187/", "curl http://localhost:9000/", "git branch --list",
    'powershell -Command "Get-Content quality/rules.json"', "git -C . diff quality/rules.json",
    "cat quality/rules.json > notes.md"
  ]) allowed(shell(root, command), command);
  for (const reader of "cat type Get-Content gc head tail less more grep rg Select-String sls findstr wc ls dir Get-ChildItem gci Test-Path stat".split(" ")) allowed(shell(root, `${reader} quality/rules.json`), reader);
  allowed(shell(join(root, "outline"), "Set-Content ../notes.md 'A note'"));
  denied(shell(join(root, "outline"), "Set-Content ../quality/rules.json '{}'"));
});

test("studio HTTP guard follows both supported project port settings", (t) => {
  const { root } = fixture(t);
  for (const setting of [{ studio_port: 4199 }, { studio: { port: 4199 } }]) {
    writeFileSync(join(root, "project.json"), JSON.stringify({ ...readProject(root), studio_port: undefined, studio: undefined, ...setting }));
    denied(shell(root, "curl http://localhost:4199/api/approve"));
    allowed(shell(root, "curl http://localhost:4187/api/approve"));
    allowed(shell(root, "curl http://localhost:41990/"));
  }
});

test("all edit tools protect settings and records before scene setup is read", (t) => {
  const { root, base } = fixture(t);
  const paths = [".claude/settings.json", ".claude/settings.local.json", ".claude/rules/nested.md", "CLAUDE.md", "AGENTS.md", "project.json", "package.json", "package-lock.json", ".gitignore", ".git/config", "node_modules/weaver/engine.mjs", "quality/rules.json", "narrative-state/1-1.md", "continuity/rulings.json", ".weaver/guard.json", "releases/one/reader.md", "review/chapter-01-critic.json", "imports/book.json", "world-bible/characters.json", "approve.mjs", "notes/run.ps1", "tools\\go.cmd", "x.sh", "outline/../../outside.md", join(base, "outside.md")];
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    for (const path of paths) {
      denied(edit(root, path, tool), `${tool}: ${path}`);
      denied(runHook("pre", { cwd: root, tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Update File: ${path}\n@@\n-old\n+new\n*** End Patch` } }), `Codex: ${path}`);
    }
    for (const path of [SCENE, "world-bible/locations.md", "outline/plot-structure.md", "style-guide/voice.md", "notes.md"]) allowed(edit(root, path, tool), `${tool}: ${path}`);
  }
  denied(edit(root, join(root, "quality", "rules.json")));
  denied(edit(root, "outline\\..\\quality\\rules.json"));
  denied(runHook("pre", { cwd: root, tool_name: "MultiEdit", tool_input: { edits: [{ file_path: SCENE }, { file_path: "quality/rules.json" }] } }));
  assert.equal(protectedPath("C:\\Book", "c:\\book\\quality\\rules.json"), "quality/rules.json");
  assert.equal(protectedPath("C:\\Book", "D:\\Book\\notes.md"), "outside the book folder");
  assert.equal(protectedPath("C:\\Book", "c:\\book\\outline\\plot.md"), null);
  writeFileSync(join(root, "project.json"), "broken json");
  denied(edit(root, "project.json"), "protection precedes project parsing");
});

test("discrimination: disabling each guard lets its formerly denied case through", (t) => {
  const { root } = fixture(t);
  denied(shell(root, "git commit -am fix"));
  allowed(shell(root, "git commit -am fix", { decideShell: () => null }));
  denied(edit(root, "quality/rules.json"));
  allowed(edit(root, "quality/rules.json", "Edit", { decideEdit: () => null }));
});

test("hooks fail open on malformed payloads and internal errors, including the CLI", (t) => {
  const { root } = fixture(t);
  for (const kind of ["pre", "shell", "post"]) {
    for (const payload of [null, {}, { tool_input: { command: 3, file_path: {} } }]) allowed(runHook(kind, payload));
    const result = cli(root, ["hook", kind], process.env, "not json");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
  const broken = () => { throw new Error("fixture error"); };
  allowed(shell(root, "git commit", { decideShell: broken }));
  allowed(edit(root, "quality/rules.json", "Edit", { decideEdit: broken }));
  const result = cli(root, ["hook", "shell"], process.env, JSON.stringify({ cwd: root, tool_name: "PowerShell", tool_input: { command: "Set-Content quality/rules.json '{}'" } }));
  assert.equal(result.status, 0, result.stderr);
  denied(JSON.parse(result.stdout));
});

for (const marker of AI_HOST_ENV) test(`CLI refuses every author button when ${marker} is present`, (t) => {
  const { root } = fixture(t);
  for (const command of AUTHOR_ONLY_COMMANDS) {
    const result = cli(root, [...command.split(" "), "--json"], { ...authorEnv(), [marker]: "1" });
    assert.equal(result.status, 1, command);
    const output = JSON.parse(result.stdout);
    assert.match(output.error, /author's decision/u);
    assert.match(output.why, /only lets the author/u);
    assert.match(output.fix, /npx weaver studio/u);
  }
  const plain = cli(root, ["approve"], { ...authorEnv(), [marker]: "1" });
  assert.match(plain.stdout, /^error: .+\nwhy: .+\nfix: /u);
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "1");
});

for (const command of AUTHOR_ONLY_COMMANDS) test(`CLI author environment can run ${command}`, (t) => {
  const { root, base } = fixture(t, command === "import");
  const args = command.split(" ");
  if (["approve", "reject", "undo"].includes(command)) changeScene(root);
  if (command === "undo") approveChapter(root, readProject(root), 1);
  if (command === "rule") {
    writeFileSync(join(root, "quality", "rules.json"), JSON.stringify({ version: 1, rules: [{ id: "test-phrase", type: "phrase-list", severity: "warn", message: "Check this phrase.", phrases: ["first line"] }] }));
    args.push(collectFindings(root, readProject(root)).findings[0].id, "--decision", "allow");
  }
  if (command === "proposal") {
    mkdirSync(join(root, ".weaver", "proposals"), { recursive: true });
    writeFileSync(join(root, ".weaver", "proposals", "chapter-01.json"), JSON.stringify({ chapter: 1, status: "nothing-to-repair", edits: [], declined: [], dropped_edits: [] }));
    args.push("reject", "--chapter", "1", "--note", "Author reviewed this proposal.");
  }
  if (command === "release") { acceptNarrativeState(root, readProject(root)); args.push("--id", "guard-test"); }
  if (command === "import") { const source = join(base, "source.md"); writeFileSync(source, "# Chapter 1\n\nAn original scene.\n"); args.push(source); }
  if (command === "backup setup") { const remote = join(base, "backup.git"); assert.equal(spawnSync("git", ["init", "--bare", "-q", remote], { encoding: "utf8", windowsHide: true }).status, 0); args.push("--remote", remote); }
  const result = cli(root, args);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("doctor detects each missing guard and disabled hooks, then recovers", (t) => {
  const context = fixture(t);
  const path = join(context.root, ".claude", "settings.json");
  const original = readFileSync(path, "utf8");
  assert.equal(check(context, "guardrails-installed").status, "pass");
  const mutations = [
    (s) => { s.hooks.PreToolUse = s.hooks.PreToolUse.filter((entry) => entry.matcher !== "Bash|PowerShell"); },
    (s) => { s.permissions.deny = s.permissions.deny.filter((rule) => rule !== "Bash(npx weaver approve:*)"); },
    (s) => { s.disableAllHooks = true; },
    (s) => { delete s.permissions.disableBypassPermissionsMode; }
  ];
  for (const mutate of mutations) {
    const settings = JSON.parse(original); mutate(settings); writeFileSync(path, JSON.stringify(settings));
    assert.equal(check(context, "guardrails-installed").status, "blocking");
    writeFileSync(path, original);
    assert.equal(check(context, "guardrails-installed").status, "pass");
  }
  for (const disabled of [join(context.root, ".claude", "settings.local.json"), join(context.homeDirectory, ".claude", "settings.json")]) {
    writeFileSync(disabled, JSON.stringify({ disableAllHooks: true }));
    const bad = check(context, "guardrails-installed");
    assert.equal(bad.status, "blocking");
    assert.match(bad.findings[0].problem, /turns off all hooks/u);
    if (disabled.includes(context.homeDirectory)) assert.match(bad.findings[0].fix, /Contact PickBits/u);
    rmSync(disabled);
    assert.equal(check(context, "guardrails-installed").status, "pass");
  }
});

test("seal detects changes, absence, added and removed files; CRLF and rulings stay valid", (t) => {
  const context = fixture(t);
  const { root } = context;
  assert.equal(check(context, "book-settings-sealed").status, "warning");
  const rules = join(root, "quality", "rules.json");
  writeFileSync(rules, JSON.stringify({ version: 1, rules: [{ id: "test-phrase", type: "phrase-list", severity: "warn", message: "Check this phrase.", phrases: ["first line"] }] }) + "\n");
  const original = readFileSync(rules, "utf8");
  const finding = collectFindings(root, readProject(root)).findings[0];
  // An unrelated staged manuscript must never ride along with the seal.
  changeScene(root); git(root, "add", "--", SCENE);
  assert.equal(cli(root, ["guard", "seal"]).status, 0);
  assert.deepEqual(git(root, "show", "--format=", "--name-only", "HEAD").split(/\r?\n/u), [".weaver/guard.json"]);
  assert.match(git(root, "log", "-1", "--format=%B"), /Approved-with: PickBits Weaver/u);
  assert.equal(JSON.parse(readFileSync(join(root, ".weaver", "guard.json"), "utf8")).files[".claude/settings.local.json"], null);
  assert.equal(check(context, "book-settings-sealed").status, "pass");
  appendFileSync(rules, " ");
  const changed = check(context, "book-settings-sealed");
  assert.equal(changed.status, "blocking");
  assert.match(changed.findings[0].problem, /quality\/rules.json/u);
  writeFileSync(rules, original.replaceAll("\n", "\r\n"));
  assert.equal(check(context, "book-settings-sealed").status, "pass");
  rmSync(rules);
  assert.equal(check(context, "book-settings-sealed").status, "blocking");
  writeFileSync(rules, original);
  for (const path of ["quality/new-rule.md", ".claude/settings.local.json"]) {
    writeFileSync(join(root, path), "{}\n");
    assert.equal(check(context, "book-settings-sealed").status, "blocking");
    rmSync(join(root, path));
    assert.equal(check(context, "book-settings-sealed").status, "pass");
  }
  const ruling = cli(root, ["rule", finding.id, "--decision", "allow"]);
  assert.equal(ruling.status, 0, ruling.stdout + ruling.stderr);
  assert.equal(check(context, "book-settings-sealed").status, "pass");
  assert.equal(existsSync(join(root, "continuity", "rulings.json")), true);
  appendFileSync(rules, "\n");
  assert.equal(cli(root, ["guard", "seal"]).status, 0, "an author can reseal an intended change");
  assert.equal(check(context, "book-settings-sealed").status, "pass");
});

test("doctor warns about pending settings and names unapproved manuscript commits", (t) => {
  const context = fixture(t);
  const { root } = context;
  assert.equal(check(context, "protected-files-clean").status, "pass");
  appendFileSync(join(root, "quality", "rules.json"), "\n");
  assert.equal(check(context, "protected-files-clean").status, "warning");
  git(root, "restore", "--", "quality/rules.json");
  assert.equal(check(context, "protected-files-clean").status, "pass");
  appendFileSync(join(root, ".gitignore"), "\n.claude/settings.local.json\n");
  writeFileSync(join(root, ".claude", "settings.local.json"), "{}\n");
  assert.equal(check(context, "protected-files-clean").status, "warning", "ignored local settings are still pending settings");
  rmSync(join(root, ".claude", "settings.local.json"));
  git(root, "restore", "--", ".gitignore");
  const before = git(root, "rev-parse", "HEAD");
  changeScene(root);
  git(root, "add", "--", SCENE); git(root, "commit", "-m", "Raw scene change");
  const sha = git(root, "rev-parse", "--short", "HEAD");
  const bad = check(context, "approved-history");
  assert.equal(bad.status, "blocking");
  assert.ok(bad.findings[0].problem.includes(sha));
  assert.match(bad.findings[0].problem, /Raw scene change/u);
  git(root, "reset", "--hard", before);
  assert.equal(check(context, "approved-history").status, "pass");
  changeScene(root); approveChapter(root, readProject(root), 1);
  assert.equal(check(context, "approved-history").status, "pass");
  assert.equal(cli(root, ["undo"]).status, 0);
  assert.equal(check(context, "approved-history").status, "pass");
});

test("history uses the latest import baseline and the configured source root", (t) => {
  const context = fixture(t);
  const { root } = context;
  changeScene(root); git(root, "add", "--", SCENE); git(root, "commit", "-m", "Old raw change");
  git(root, "commit", "--allow-empty", "-m", "New import baseline", "-m", "Imported-with: PickBits Weaver 0.3.0");
  assert.equal(check(context, "approved-history").status, "pass");
  const project = readProject(root); project.source_root = "chapters";
  writeFileSync(join(root, "project.json"), JSON.stringify(project));
  mkdirSync(join(root, "chapters")); writeFileSync(join(root, "chapters", "scene.md"), "A new scene.");
  git(root, "add", "--", "chapters"); git(root, "commit", "-m", "Unapproved custom source");
  assert.equal(check(context, "approved-history").status, "blocking");
});

test("init installs every guard; repeated installation is byte-identical and preserves settings", (t) => {
  const { base, homeDirectory } = fixture(t);
  const root = join(base, "cli-book");
  const result = cli(base, ["init", root]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(check({ root, homeDirectory }, "guardrails-installed").status, "pass");
  const path = join(root, ".claude", "settings.json");
  const settings = JSON.parse(readFileSync(path, "utf8"));
  settings.permissions.allow = ["Bash(echo:*)"];
  settings.permissions.deny.push("Read(/private/**)");
  settings.hooks.PreToolUse.push({ matcher: "Other", hooks: [{ type: "command", command: "other" }] });
  writeFileSync(path, JSON.stringify(settings));
  for (const rule of WEAVER_DENY_RULES) assert.ok(settings.permissions.deny.includes(rule));
  assert.equal(cli(root, ["hooks", "install"]).status, 0);
  const first = readFileSync(path, "utf8");
  assert.equal(cli(root, ["hooks", "install"]).status, 0);
  assert.equal(readFileSync(path, "utf8"), first);
  assert.deepEqual(JSON.parse(first).permissions.allow, ["Bash(echo:*)"]);
  assert.match(first, /Read\(\/private\/\*\*\)/u);
  assert.match(first, /"command":\s*"other"/u);
  // Upgrade existing installations without retaining duplicate Weaver hooks.
  const legacy = { hooks: { PreToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: "npx --no-install weaver hook pre" }, { type: "command", command: "other" }] }] } };
  writeFileSync(path, JSON.stringify(legacy));
  installHooks(root);
  assert.equal(check({ root, homeDirectory }, "guardrails-installed").status, "pass");
  const upgraded = readFileSync(path, "utf8");
  assert.equal(upgraded.match(/weaver hook pre/gu).length, 1);
  assert.match(upgraded, /"command": "other"/u);
});
