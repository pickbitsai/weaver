// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { authorEnv } from "./helpers/env.mjs";
import { AI_HOST_ENV, SETUP_DENY_RULES, WEAVER_DENY_RULES } from "../engine/guard.mjs";
import { runHook, installHooks, codexRules } from "../engine/hooks.mjs";
import { initializeProject } from "../engine/init.mjs";
import { classifySetup, renderSetupGuidance, setupCommand, gitRemotes, findHostsOnPath } from "../engine/setup-guide.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function nodeResult(file, args, env) {
  const result = spawnSync(process.execPath, [file, ...args], { env, cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 120000 });
  return { ...result, output: result.stdout + result.stderr };
}

const ids = (items) => items.map(({ id }) => id);
const finding = (id) => ({ id, problem: `Problem for ${id}`, why: "It matters.", fix: "Fix this." });
function report({ warnings = [], blocking = [], codex = [], claude = [], passing = [] } = {}) {
  return { checks: [...warnings.map((id) => ({ id, status: "warning", findings: [finding(id)] })),
    ...blocking.map((id) => ({ id, status: "blocking", findings: [finding(id)] })),
    ...passing.map((id) => ({ id, status: "pass", findings: [] }))], blocking: blocking.map(finding),
  guardrails: { codex: { problems: codex }, claude: { problems: claude } } };
}
const fresh = () => report({ warnings: ["host", "codex-hook-trust", "book-settings-sealed"], blocking: ["guardrails-installed"],
  codex: ["project hooks are not trusted or could not be verified; open /hooks in this book folder"] });
const classify = (value, options = {}) => classifySetup({ report: value, hostsOnPath: { codex: true, claude: true }, bookRoot: "/books/ash", ...options });

test("setup scripts have portable ASCII source and the author-session guard", () => {
  const sh = readFileSync(join(ROOT, "scripts/setup-book.sh"));
  const ps = readFileSync(join(ROOT, "scripts/setup-book.ps1"));
  for (const bytes of [sh, ps]) assert.ok(bytes.every((byte) => byte < 0x80), "scripts must be ASCII");
  const header = "# SPDX-License-Identifier: Apache-2.0\n# Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.\n";
  assert.ok(sh.toString().startsWith(`#!/bin/sh\n${header}`));
  assert.ok(ps.toString().replaceAll("\r\n", "\n").startsWith(header + "#Requires -Version 5.1\n"));
  assert.equal(sh.includes(13), false);
  assert.equal(sh.toString().trimEnd().split("\n").at(-1), 'main "$@"; exit $?');
  assert.doesNotMatch(sh.toString(), /\[\[|\blocal\s|\bfunction\s|\bdeclare\s|<<<|\$'|==/);
  assert.doesNotMatch(sh.toString(), /^\s*(path|status|argv|options|commands|functions|aliases|prompt)=/m);
  for (const name of AI_HOST_ENV) for (const bytes of [sh, ps]) assert.ok(bytes.toString().includes(name), name);
  for (const bytes of [sh, ps]) for (const value of ["--no-update-notifier", "node_modules", ".DS_Store", "con|prn|aux|nul|com[0-9]|lpt[0-9]"]) {
    assert.ok(bytes.toString().includes(value), value);
  }
  assert.match(ps.toString(), /folder's name has & or \^ in it/);
});

test("setup guidance distinguishes missing one-time steps from broken checks", () => {
  const untrusted = classify(fresh());
  assert.equal(untrusted.ok, true);
  assert.deepEqual(ids(untrusted.steps), ["codex-trust", "backup", "seal"]);
  assert.deepEqual(ids(untrusted.reminders), ["claude-trust"]);
  assert.deepEqual(untrusted.problems, []);
  const disabled = fresh(); disabled.guardrails.codex.problems = ["Codex has turned off hooks"];
  assert.equal(classify(disabled).ok, false);
  assert.deepEqual(classify(disabled).problems, [finding("guardrails-installed")]);
  const brokenClaude = fresh(); brokenClaude.guardrails.claude.problems.push("A required hook is missing");
  assert.equal(classify(brokenClaude).ok, false);
  for (const id of ["book-in-git", "something-new"]) {
    const result = classify(report({ blocking: [id, id] }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems, [finding(id)]);
  }
  const unrunnable = classify(report({ warnings: ["hooks-runnable"] }), { toolRoot: "/books/tools" });
  assert.equal(unrunnable.ok, false);
  assert.equal(unrunnable.problems[0].id, "hooks-runnable");
  for (const result of [unrunnable, classify(report({ warnings: ["hooks-runnable"] }))]) {
    assert.equal(result.ok, false);
    assert.match(result.problems[0].fix, /contact PickBits/);
    assert.doesNotMatch(result.problems[0].fix, /inside the tool folder/);
  }
  const backup = classify(report({ blocking: ["backup-configured"] }), { remotes: ["origin"] });
  assert.equal(backup.ok, false);
  assert.deepEqual(backup.problems, [finding("backup-configured")]);
  assert.equal(ids(backup.steps).includes("backup"), false);
  assert.equal(ids(classify(report(), { remotes: ["origin"] }).steps).includes("backup"), false);
  assert.equal(ids(classify(report({ passing: ["backup-configured"] })).steps).includes("backup"), false);
  assert.deepEqual(classify(report({ warnings: ["backup-configured"] }), { remotes: ["origin"] }).problems, [finding("backup-configured")]);
  for (const [platform, launcher] of [["win32", "npx.cmd"], ["darwin", "npx"]]) {
    const result = classify(report(), { platform });
    assert.ok(result.steps.find(({ id }) => id === "backup").lines.some((line) => line.includes(`${launcher} weaver backup setup --remote`)));
  }
  assert.equal(ids(classify(report({ passing: ["codex-hook-trust"] })).steps).includes("codex-trust"), false);
  assert.ok(ids(classify(report(), { hostsOnPath: { codex: false, claude: true } }).steps).includes("codex-install"));
  assert.ok(ids(classify(report({ warnings: ["codex-available"] })).steps).includes("codex-login"));
  assert.equal(ids(classify(fresh(), { project: { hosts: ["claude"] } }).steps).some((id) => id.startsWith("codex-")), false);
  assert.ok(ids(classify(fresh(), { project: { hosts: [] } }).steps).includes("codex-trust"));
  assert.ok(ids(classify(report({ warnings: ["codex-windows-sandbox"] })).steps).includes("codex-sandbox"));
  const noHosts = fresh(); noHosts.guardrails.codex.problems = ["Codex is not installed, so hook trust cannot be checked"];
  const missing = classify(noHosts, { hostsOnPath: { codex: false, claude: false } });
  assert.equal(missing.ok, true);
  assert.deepEqual(ids(missing.steps), ["codex-install", "codex-trust", "claude-install", "backup", "seal"]);
  assert.ok(ids(classify(report({ warnings: ["host-available"] })).steps).includes("packet-host"));
  assert.equal(ids(classify(report({ warnings: ["host-available"] }), { hostsOnPath: { codex: true, claude: false } }).steps).includes("packet-host"), false);
  const unknown = report({ warnings: ["something-new", "something-new", "host"] });
  assert.deepEqual(classify(unknown).notes, [{ id: "something-new", problem: "Problem for something-new", fix: "Fix this." }]);
  const details = { generator: "PickBits Weaver", title: "Ash", id: "ash", bookRoot: "/books/ash", toolRoot: null, guidePath: "docs/START-HERE.md" };
  for (const guidance of [untrusted, unrunnable, classify(report(), { remotes: ["origin"] }), classify(unknown)]) {
    const text = renderSetupGuidance(guidance, details);
    assert.equal(text.includes("Please fix this first:"), guidance.problems.length > 0);
    assert.equal(text.includes("One-time steps still to do:"), guidance.steps.length > 0);
    assert.ok([...text].every((char) => char.charCodeAt(0) < 0x80));
    assert.ok(text.endsWith("\n"));
    assert.equal(text.includes("Tool folder:"), false);
  }
  assert.match(renderSetupGuidance(untrusted, { ...details, title: undefined, id: undefined }), /\(unknown\)/);
  assert.deepEqual(gitRemotes(join(ROOT, "missing-book-folder")), []);
});

test("setup guide gives a plain error when the book folder is missing", () => {
  const result = nodeResult(join(ROOT, "scripts/setup-guide.mjs"), [], authorEnv());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--root/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("backup guidance keeps R4 problems and fixes, with pre-R4 fallback", () => {
  const details = { generator: "PickBits Weaver", bookRoot: "/books/ash", guidePath: "/guide" };
  const r4 = (findings) => ({ ...report(), checks: [{ id: "backup", title: "Book is backed up", status: "warning", findings }] });
  for (const problem of ["Your book isn't backed up yet", "Your book is not backed up yet"]) {
    const result = classify(r4([{ problem, why: "Keep a safe copy.", fix: "Create your private backup." }]), { remotes: [] });
    assert.equal(result.ok, true);
    assert.ok(ids(result.steps).includes("backup"));
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.notes, []);
    const blocking = r4([]);
    blocking.checks = [];
    blocking.blocking = [{ id: "backup", problem, why: "Keep a safe copy.", fix: "Create your private backup." }];
    assert.equal(classify(blocking, { remotes: ["origin"] }).ok, true);
    assert.ok(ids(classify(blocking, { remotes: ["origin"] }).steps).includes("backup"));
  }
  const problems = [
    "Your last backup failed 2 hours ago: GitHub refused the sign-in",
    "2 author decisions have not reached your backup for over an hour",
    "Your last successful backup was 3 days ago", "Your backup hasn't been checked yet",
    "The backup address is missing from your book's Git settings", "Your backup couldn't be checked"
  ];
  for (const problem of problems) for (const platform of ["darwin", "win32"]) {
    const fix = "Sign in to GitHub again, then run `npx weaver backup now` in a terminal.";
    const value = r4([{ problem, why: "Your safe copy needs attention.", fix }]);
    value.blocking = [{ id: "backup", ...value.checks[0].findings[0] }];
    const result = classify(value, { remotes: ["weaver-backup"], platform });
    assert.equal(result.ok, false);
    assert.equal(ids(result.steps).includes("backup"), false);
    assert.deepEqual(result.problems, [{ id: "backup", problem, why: "Your safe copy needs attention.",
      fix: platform === "win32" ? fix.replace("npx weaver", "npx.cmd weaver") : fix }]);
    assert.deepEqual(result.notes, []);
    assert.ok(renderSetupGuidance(result, details).includes(problem));
    // Warning findings alone must also block setup, without a duplicate in report.blocking.
    value.blocking = [];
    assert.deepEqual(classify(value, { remotes: ["weaver-backup"], platform }).problems, result.problems);
  }
  for (const remotes of [[], ["origin"]]) {
    const result = classify(report(), { remotes });
    assert.equal(ids(result.steps).includes("backup"), remotes.length === 0);
    assert.deepEqual(result.problems, []);
  }
  for (const title of ["Book is backed up", undefined]) {
    const value = r4([]); value.checks[0].title = title;
    const result = classify(value, { platform: "darwin" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems, [{ id: "backup", problem: `${title || "Backup"} needs attention`,
      why: "Weaver's health check found a problem with your backup.",
      fix: "Run `npx weaver backup status` to see what is wrong, or contact PickBits." }]);
  }
});

test("Windows fixes use the unblocked npx launcher in problems and notes", () => {
  const value = report({ blocking: ["broken"], warnings: ["notice"] });
  const fix = "Run `npx weaver check`, then `npx --no-install weaver doctor`; npx.cmd weaver check and other-npx weaver stay unchanged.";
  value.blocking[0].fix = fix;
  value.checks.find(({ id }) => id === "notice").findings[0].fix = fix;
  for (const platform of ["win32", "darwin"]) {
    const result = classify(value, { platform });
    const expected = platform === "win32" ? fix.replace("`npx weaver", "`npx.cmd weaver").replace("`npx --no-install", "`npx.cmd --no-install") : fix;
    assert.equal(result.problems[0].fix, expected);
    assert.equal(result.notes[0].fix, expected);
  }
});

test("host steps use standalone installers and the detected launcher", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const result = classify(report(), { platform, hostsOnPath: { codex: false, claude: false } });
    for (const [host, base] of [["codex", "https://chatgpt.com/codex"], ["claude", "https://claude.ai"]]) {
      const text = result.steps.find(({ id }) => id === `${host}-install`).lines.join("\n");
      assert.ok(text.includes(`${base}/install.${platform === "win32" ? "ps1" : "sh"}`));
      assert.doesNotMatch(text, /npm install -g/);
      if (platform === "win32" && host === "codex") assert.match(text, /ExecutionPolicy ByPass/);
    }
  }
  for (const command of [undefined, "codex.cmd"]) {
    const result = classify(report({ warnings: ["codex-available", "codex-windows-sandbox"] }), {
      hostsOnPath: { codex: true, claude: true, codexCommand: command, claudeCommand: "claude.cmd" }
    });
    const lines = (id) => result.steps.find((item) => item.id === id).lines.join("\n");
    assert.ok(lines("codex-login").includes(`${command || "codex"} login`));
    assert.ok(lines("codex-login").includes(`${command || "codex"} login status`));
    assert.ok(lines("codex-sandbox").includes(`${command || "codex"} --sandbox`));
    const trust = result.reminders.find(({ id }) => id === "claude-trust").lines.join("\n");
    assert.match(trust, /run  claude\.cmd  /);
    assert.match(trust, /sign in with your\nClaude account/);
  }
  assert.match(classify(report()).reminders[0].lines[0], /run  claude  /);
});

test("setup re-run commands quote both paths without a package source", () => {
  const windows = { platform: "win32", toolRoot: "D:\\Books\\T\u00ebst O'Brien\\Weaver", bookRoot: "D:\\Books\\T\u00ebst O'Brien\\Weaver\\ash" };
  assert.equal(setupCommand(windows), "powershell -NoProfile -ExecutionPolicy Bypass -File 'D:\\Books\\T\u00ebst O''Brien\\Weaver\\node_modules\\@pickbitsai\\weaver\\scripts\\setup-book.ps1' -ToolFolder 'D:\\Books\\T\u00ebst O''Brien\\Weaver' -BookFolder 'D:\\Books\\T\u00ebst O''Brien\\Weaver\\ash'");
  const mac = { platform: "darwin", toolRoot: "/books/O'Brien/Weaver", bookRoot: "/books/O'Brien/Weaver/ash" };
  assert.equal(setupCommand(mac), "sh '/books/O'\\''Brien/Weaver/node_modules/@pickbitsai/weaver/scripts/setup-book.sh' --tool-folder '/books/O'\\''Brien/Weaver' --book-folder '/books/O'\\''Brien/Weaver/ash'");
  for (const details of [windows, mac]) {
    assert.doesNotMatch(setupCommand(details), /-Source|--source/);
    const text = renderSetupGuidance(classify(report()), { ...details, generator: "PickBits Weaver", title: "Ash", id: "ash", guidePath: "/guide" });
    assert.match(text, /run setup again yourself, in a terminal \(your AI can't run it\):/);
    assert.ok(text.includes(`  ${setupCommand(details)}\nFor help, contact PickBits.\n`));
  }
  assert.match(renderSetupGuidance(classify(report()), { toolRoot: null }), /To check everything again later, run setup again\. For help, contact PickBits\.\n$/);
});

test("host discovery ignores extensionless Windows shims and selects an executable launcher", (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  let answer, calls;
  const mock = t.mock.method(childProcess, "spawnSync", (file, args) => {
    calls.push([file, args]);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  syncBuiltinESMExports();
  try {
    for (const value of ["win32", "darwin", "linux"]) {
      Object.defineProperty(process, "platform", { value });
      for (const [output, status, available, suffix] of [
        ["C:\\tools\\shim\r\nC:\\tools\\native.EXE\r\nC:\\tools\\shim.cmd\r\n", 0, true, ""],
        ["C:\\tools\\shim\r\nC:\\tools\\shim.CMD\r\n", 0, true, ".cmd"],
        ["C:\\tools\\shim\r\nC:\\tools\\shim.BAT\r\n", 0, true, ".cmd"],
        ["C:\\tools\\shim\r\nC:\\tools\\shim.ps1\r\n", 0, false, ""],
        ["", 1, false, ""]
      ]) {
        answer = { status, stdout: output }; calls = [];
        const found = value === "win32" ? available : status === 0;
        const commandSuffix = value === "win32" ? suffix : "";
        assert.deepEqual(findHostsOnPath(), { codex: found, claude: found, codexCommand: `codex${commandSuffix}`, claudeCommand: `claude${commandSuffix}` });
        for (const [i, name] of ["codex", "claude"].entries()) assert.deepEqual(calls[i], value === "win32"
          ? ["where.exe", [name]] : ["sh", ["-c", 'command -v "$1"', "setup-guide", name]]);
      }
      answer = new Error("Unavailable"); calls = [];
      assert.deepEqual(findHostsOnPath(), { codex: false, claude: false, codexCommand: "codex", claudeCommand: "claude" });
    }
  } finally {
    Object.defineProperty(process, "platform", platform);
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

const setupCommands = [
  "env -u CLAUDECODE sh ~/Weaver/node_modules/@pickbitsai/weaver/scripts/setup-book.sh --source https://example.invalid/weaver.tgz --book-folder .",
  "Remove-Item Env:CLAUDECODE; & ~\\Weaver\\node_modules\\@pickbitsai\\weaver\\scripts\\setup-book.ps1 -Source https://example.invalid/weaver.tgz -BookFolder .",
  "powershell -NoProfile -ExecutionPolicy Bypass -File $HOME\\Weaver\\node_modules\\@pickbitsai\\weaver\\scripts\\setup-book.ps1 -Source @pickbitsai/weaver@0.2.0 -BookFolder .",
  '& "$env:USERPROFILE\\Weaver\\node_modules\\@pickbitsai\\weaver\\scripts\\setup-book.ps1" -Source x.tgz',
  'sh "$HOME/Weaver/node_modules/@pickbitsai/weaver/scripts/setup-book.sh" --source x.tgz',
  "unset CLAUDECODE CODEX_THREAD_ID; zsh ~/Weaver/node_modules/@pickbitsai/weaver/scripts/setup-book.sh",
  "D:\\Books\\Weaver\\node_modules\\@pickbitsai\\weaver\\scripts\\setup-book.ps1 -Source x.tgz",
  "bash -c 'CLAUDECODE= ./setup-book.sh --source x.tgz'",
  'cmd /c "powershell -File setup-book.ps1 -Source x.tgz"',
  "pwsh -File SETUP-BOOK.PS1",
  "Start-Process powershell -ArgumentList '-File', 'setup-book.ps1'",
  "cp ~/Weaver/node_modules/@pickbitsai/weaver/scripts/setup-book.sh run.sh"
];
const payloads = (cwd, command) => [
  { cwd, tool_name: "Bash", tool_input: { command } },
  { cwd, tool_name: "PowerShell", tool_input: { command } },
  { hook_event_name: "PreToolUse", session_id: "synthetic", turn_id: "turn", tool_use_id: "call", cwd, tool_name: "Bash", tool_input: { command } }
];
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "weaver-setup-guide-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function assertSetupDeny(result, label) {
  assert.equal(result?.hookSpecificOutput?.permissionDecision, "deny", label);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /installed and maintained by PickBits/, label);
}

test("setup shell guard denies bypasses for both hosts and allows daily work", (t) => {
  const book = initializeProject(join(temporary(t), "book"), { id: "the-glass-orchard", title: "The Glass Orchard", empty: true });
  for (const command of setupCommands) for (const payload of payloads(book, command)) {
    assertSetupDeny(runHook("shell", payload), `${payload.tool_name}: ${command}`);
  }
  for (const command of ["npx weaver check", "npx weaver studio", "npx weaver doctor", "git status", "cat notes.md",
    "Get-Content outline/plot-structure.md", "node node_modules/@pickbitsai/weaver/scripts/weaver.mjs check"]) {
    for (const payload of payloads(book, command)) assert.notEqual(runHook("shell", payload)?.hookSpecificOutput?.permissionDecision, "deny", command);
  }
  for (const host of ["claude", "codex"]) {
    const result = spawnSync(process.execPath, [join(ROOT, "scripts/weaver.mjs"), "hook", "shell", ...(host === "codex" ? ["--host", "codex"] : [])], {
      cwd: book, env: authorEnv(), input: JSON.stringify(payloads(book, setupCommands[0])[host === "codex" ? 2 : 0]), encoding: "utf8", windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    assertSetupDeny(JSON.parse(result.stdout), host);
  }
});

test("Claude setup deny rules match wildcard commands and ship in the template", () => {
  for (const rule of SETUP_DENY_RULES) assert.ok(WEAVER_DENY_RULES.includes(rule));
  const matches = (host, command) => WEAVER_DENY_RULES.some((rule) => {
    if (!rule.startsWith(`${host}(`)) return false;
    const pattern = rule.slice(host.length + 1, -1).split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${pattern}$`, host === "PowerShell" ? "i" : "").test(command);
  });
  for (const host of ["Bash", "PowerShell"]) {
    for (const command of setupCommands) assert.equal(matches(host, host === "Bash" ? command.toLowerCase() : command), true, `${host}: ${command}`);
    assert.equal(matches(host, "npx weaver check"), false);
  }
  const settings = JSON.parse(readFileSync(join(ROOT, "templates/book/.claude/settings.json"), "utf8"));
  for (const rule of WEAVER_DENY_RULES) assert.ok(settings.permissions.deny.includes(rule), rule);
});

test("Codex setup prefixes forbid literal launchers and ship exactly in the template", () => {
  const rules = codexRules();
  const patterns = rules.trim().split("\n").filter((line) => line.startsWith("prefix_rule(")).map((line) => {
    assert.match(line, /decision="forbidden"/);
    return JSON.parse(line.match(/^prefix_rule\(pattern=(.*), decision=/)[1]);
  });
  const forbidden = (argv) => patterns.some((pattern) => argv.length >= pattern.length && pattern.every((part, i) =>
    Array.isArray(part) ? part.includes(argv[i]) : part === argv[i]));
  for (const argv of [
    ["sh", "../node_modules/@pickbitsai/weaver/scripts/setup-book.sh", "--source", "x.tgz"],
    ["bash", "setup-book.sh"], ["./setup-book.sh", "--id", "ash"], ["setup-book.ps1"], [".\\setup-book.ps1", "-Id", "ash"],
    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "setup-book.ps1", "-Source", "x.tgz"],
    ["pwsh", "-File", "..\\node_modules\\@pickbitsai\\weaver\\scripts\\setup-book.ps1"],
    ["powershell.exe", "-ExecutionPolicy", "Bypass", "-File", "../node_modules/@pickbitsai/weaver/scripts/setup-book.ps1"]
  ]) assert.equal(forbidden(argv), true, JSON.stringify(argv));
  for (const argv of [["git", "status"], ["npx", "weaver", "check"], ["sh", "build.sh"]]) assert.equal(forbidden(argv), false, JSON.stringify(argv));
  assert.equal(readFileSync(join(ROOT, "templates/book/.codex/rules/weaver.rules"), "utf8"), rules);
});

test("template hooks stay byte-identical after installation", (t) => {
  const book = join(temporary(t), "book");
  cpSync(join(ROOT, "templates/book"), book, { recursive: true });
  const files = [".claude/settings.json", ".codex/rules/weaver.rules"];
  const before = files.map((file) => readFileSync(join(book, file)));
  installHooks(book);
  assert.deepEqual(files.map((file) => readFileSync(join(book, file))), before);
});
