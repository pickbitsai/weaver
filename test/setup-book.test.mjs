// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { authorEnv } from "./helpers/env.mjs";
import { AI_HOST_ENV } from "../engine/guard.mjs";
import { WEAVER_HOOK_COMMANDS, CODEX_HOOK_COMMANDS } from "../engine/hooks.mjs";
import { classifySetup, renderSetupGuidance, gitRemotes } from "../engine/setup-guide.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const SCRIPT = WIN ? "setup-book.ps1" : "setup-book.sh";
const POWERSHELL = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const TITLE = 'Ash & "Ember": the keeper\'s caf\u00e9';
const ID = "ash-and-ember";
const platformOptions = ["win32", "darwin", "linux"].includes(process.platform) ? {} : { skip: "Setup supports Windows, macOS and Linux." };
const installed = (tool, file) => join(tool, "node_modules", "@pickbitsai", "weaver", ...file.split("/"));

function temporary(t, prefix = "weaver setup-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

let tarball;
function pack(t) {
  if (tarball) return tarball;
  const destination = temporary(t, "weaver pack-");
  const args = ["pack", "--json", "--ignore-scripts", "--pack-destination", destination];
  const npmCli = process.env.npm_execpath;
  const result = spawnSync(npmCli ? process.execPath : "npm", npmCli ? [npmCli, ...args] : WIN ? args.map((arg) => `"${arg}"`) : args,
    { cwd: ROOT, env: scriptEnv(destination), shell: !npmCli && WIN, encoding: "utf8", windowsHide: true, timeout: 120000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  tarball = join(destination, basename(JSON.parse(result.stdout)[0].filename));
  assert.ok(existsSync(tarball));
  return tarball;
}

function scriptEnv(sandbox, extra = {}) {
  const env = authorEnv();
  for (const key of Object.keys(env)) if (/^npm_/i.test(key) || key === "INIT_CWD") delete env[key];
  const home = join(sandbox, "home");
  mkdirSync(home, { recursive: true });
  // PowerShell creates these during startup, before the setup script runs.
  // Prepare them in the fixture and keep its module cache off the working tree.
  const windowsEnv = WIN ? { APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), PSModuleAnalysisCachePath: "NUL" } : {};
  if (WIN) for (const directory of [windowsEnv.APPDATA, join(windowsEnv.LOCALAPPDATA, "Microsoft", "Windows", "PowerShell")]) mkdirSync(directory, { recursive: true });
  return { ...env, HOME: home, USERPROFILE: home, NPM_CONFIG_CACHE: join(sandbox, "npm-cache"), NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false", NPM_CONFIG_UPDATE_NOTIFIER: "false", ...windowsEnv, ...extra };
}

function setPath(env, value) {
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  env.PATH = value;
}

function runSetup(script, options, env, shell = "sh", extraArgs = []) {
  const flags = WIN ? { tool: "-ToolFolder", book: "-BookFolder", source: "-Source", title: "-Title", id: "-Id" }
    : { tool: "--tool-folder", book: "--book-folder", source: "--source", title: "--title", id: "--id" };
  const args = Object.entries(options).filter(([, value]) => value !== undefined).flatMap(([key, value]) => [flags[key], value]);
  const result = spawnSync(WIN ? POWERSHELL : shell,
    WIN ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args, ...extraArgs] : [script, ...args, ...extraArgs],
    { env, cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 300000 });
  return { status: result.status, output: (result.stdout || "") + (result.stderr || "") + (result.error ? `\n${result.error.message}` : "") };
}

function locate(name, env = process.env) {
  const result = spawnSync(WIN ? "where.exe" : "sh", WIN ? [name] : ["-c", 'command -v "$1"', "setup-test", name],
    { env, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : null;
}

function nodeResult(file, args, env) {
  const result = spawnSync(process.execPath, [file, ...args], { env, cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 120000 });
  return { ...result, output: result.stdout + result.stderr };
}

function guide(tool, book, env, withTool = true) {
  const result = nodeResult(installed(tool, "scripts/setup-guide.mjs"), ["--root", book, ...(withTool ? ["--tool", tool] : []), "--json"], env);
  assert.equal(result.status, 0, result.output);
  return JSON.parse(result.stdout);
}

function doctor(tool, book, env) {
  const result = nodeResult(installed(tool, "scripts/weaver.mjs"), ["doctor", "--json", "--root", book], env);
  assert.equal(result.status, 1, result.output);
  return JSON.parse(result.stdout);
}

function git(book, args, env) {
  const result = spawnSync("git", ["-C", book, ...args], { env, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
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
  assert.match(unrunnable.problems[0].fix, /\/books\/tools/);
  assert.match(classify(report({ warnings: ["hooks-runnable"] })).problems[0].fix, /folder where Weaver is installed/);
  const backup = classify(report({ blocking: ["backup-configured"] }), { remotes: ["origin"] });
  assert.equal(backup.ok, true);
  assert.ok(ids(backup.steps).includes("backup"));
  assert.equal(ids(classify(report(), { remotes: ["origin"] }).steps).includes("backup"), false);
  assert.equal(ids(classify(report({ passing: ["backup-configured"] })).steps).includes("backup"), false);
  assert.ok(ids(classify(report({ warnings: ["backup-configured"] }), { remotes: ["origin"] }).steps).includes("backup"));
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

test("author setup on this platform", platformOptions, async (t) => {
  const source = pack(t);
  const script = join(ROOT, "scripts", SCRIPT);
  await t.test("help works even in an AI session", (t) => {
    const env = scriptEnv(temporary(t), { CLAUDECODE: "1" });
    const result = runSetup(script, {}, env, "sh", [WIN ? "-Help" : "--help"]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Usage:/);
    assert.match(result.output, /Setup is safe to run again/);
  });
  await t.test("packed setup creates a clean book and is idempotent from its installed copy", (t) => {
    const sandbox = temporary(t), tool = join(sandbox, "tool folder"), book = join(tool, "my book");
    const options = { tool, book, source, title: TITLE, id: ID };
    const env = scriptEnv(sandbox, { WEAVER_FAKE_CODEX_TRUST: "untrusted" });
    const first = runSetup(script, options, env);
    assert.equal(first.status, 0, first.output);
    const project = JSON.parse(readFileSync(join(book, "project.json"), "utf8"));
    assert.equal(project.project_id, ID);
    assert.equal(project.title, TITLE);
    assert.ok(existsSync(join(book, ".git")));
    assert.equal(git(book, ["status", "--porcelain"], env), "");
    for (const [file, commands] of [[".claude/settings.json", WEAVER_HOOK_COMMANDS], [".codex/hooks.json", CODEX_HOOK_COMMANDS]]) {
      const config = readFileSync(join(book, file), "utf8");
      for (const key of ["pre", "post", "shell"]) assert.ok(config.includes(commands[key]), `${file}: ${commands[key]}`);
    }
    assert.ok(existsSync(join(book, ".codex/rules/weaver.rules")));
    const health = doctor(tool, book, env);
    assert.deepEqual(ids(health.blocking), ["guardrails-installed"]);
    assert.equal(health.guardrails.claude.on, true);
    assert.equal(health.guardrails.codex.problems.length, 1);
    assert.match(health.guardrails.codex.problems[0], /trust/);
    for (const id of ["hooks-runnable", "install-integrity", "tool-book-separation"]) assert.equal(health.checks.find((c) => c.id === id).status, "pass", id);
    const guidance = guide(tool, book, env);
    assert.equal(guidance.ok, true);
    for (const id of ["codex-trust", "backup", "seal"]) assert.ok(ids(guidance.steps).includes(id));
    assert.deepEqual(guidance.problems, []);
    assert.match(first.output, /weaver backup setup --remote/);
    // Node resolves the guide's own path through symlinks (macOS /var is /private/var), so compare real paths.
    assert.equal(realpathSync(guide(tool, book, env, false).tool.folder), realpathSync(tool), "installed guide discovers its tool folder");
    const files = ["project.json", ".claude/settings.json", ".codex/hooks.json", ".codex/rules/weaver.rules"].map((file) => join(book, file));
    files.push(join(tool, "package.json"));
    const before = files.map((file) => readFileSync(file));
    const head = git(book, ["rev-parse", "HEAD"], env);
    const shell = WIN ? "sh" : locate("zsh") || locate("bash") || "sh";
    env.WEAVER_FAKE_CODEX_TRUST = "trusted";
    for (const withSource of [true, false]) {
      const next = runSetup(installed(tool, `scripts/${SCRIPT}`), { ...options, source: withSource ? source : undefined }, env, shell);
      assert.equal(next.status, 0, next.output);
      assert.match(next.output, /Using the book that is already in/);
      if (!withSource) assert.match(next.output, /Keeping the Weaver already installed/);
      assert.equal(git(book, ["rev-parse", "HEAD"], env), head);
      assert.deepEqual(files.map((file) => readFileSync(file)), before);
      assert.equal(git(book, ["status", "--porcelain"], env), "");
      assert.equal(ids(guide(tool, book, env).steps).includes("codex-trust"), false);
    }
    for (const file of [".claude", ".codex", ".gitconfig", ".npmrc"]) assert.equal(existsSync(join(env.HOME, file)), false, file);
  });
  await t.test("setup continues when neither AI host is on PATH", (t) => {
    const sandbox = temporary(t), tool = join(sandbox, "tool folder"), book = join(tool, "my book");
    const env = scriptEnv(sandbox);
    const npm = locate(WIN ? "npm.cmd" : "npm"), gitPath = locate("git");
    assert.ok(npm && gitPath, "test needs npm and git");
    const system = WIN ? [join(process.env.SystemRoot, "System32"), dirname(POWERSHELL)] : ["/usr/bin", "/bin"];
    setPath(env, [...new Set([dirname(process.execPath), dirname(npm), dirname(gitPath), ...system])].join(delimiter));
    if (locate("codex", env) || locate("claude", env)) { t.skip("An AI host shares a required system tool directory."); return; }
    const result = runSetup(script, { tool, book, source, title: TITLE, id: ID }, env);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /neither Codex nor Claude Code/);
    const guidance = guide(tool, book, env);
    assert.equal(guidance.ok, true);
    for (const id of ["codex-install", "codex-trust", "claude-install"]) assert.ok(ids(guidance.steps).includes(id));
    const health = doctor(tool, book, env);
    assert.deepEqual(ids(health.blocking), ["guardrails-installed"]);
    assert.equal(health.guardrails.codex.problems.length, 1);
    assert.match(health.guardrails.codex.problems[0], /not installed/);
  });
  await t.test("refusals leave folders and existing files untouched", async (t) => {
    const cases = [
      { name: "AI session", pattern: /own terminal/, env: { CLAUDECODE: "1" } },
      ...AI_HOST_ENV.map((name) => ({ name: `defined ${name}`, pattern: /own terminal/, env: { [name]: "1" } })),
      { name: "empty AI marker", pattern: /own terminal/, env: { CODEX_THREAD_ID: "" } },
      { name: "no source", pattern: /where to get Weaver/, options: () => ({ source: undefined }) },
      { name: "invalid id", pattern: /lowercase letters, numbers and hyphens/, options: () => ({ id: "Ash And Ember" }) },
      { name: "blank title", pattern: /book title is empty/, options: () => ({ title: "  " }) },
      { name: "outside tool", pattern: /must be inside the tool folder/, options: (s) => ({ book: join(s, "elsewhere", "book") }) },
      { name: "same folder", pattern: /its own folder inside the tool folder/, options: (s) => ({ book: join(s, "tool") }) },
      { name: "whole home", pattern: /whole home folder/, options: (s) => ({ tool: join(s, "home"), book: join(s, "home", "book") }) },
      ...["Dropbox", "OneDrive - Example", "iCloud Drive", "Google Drive"].map((provider) => ({ name: provider,
        pattern: new RegExp(provider.split(" -")[0]), options: (s) => ({ tool: join(s, provider, "tool"), book: join(s, provider, "tool", "book") }) })),
      ...(WIN ? [{ name: "OneDrive environment", pattern: /OneDrive/, options: (s) => ({ tool: join(s, "cloud", "tool"), book: join(s, "cloud", "tool", "book") }), environment: (s) => ({ OneDrive: join(s, "cloud") }) }] : []),
      { name: "non-book files", pattern: /not a Weaver book/, prepare: (s, o) => { mkdirSync(o.book, { recursive: true }); writeFileSync(join(o.book, "notes.txt"), "Keep these notes."); } },
      { name: "old Node", pattern: /Node\.js 22 or newer/, shim: "node" },
      { name: "broken Git", pattern: /Git is not installed or does not start/, shim: "git" },
      { name: "missing tarball", pattern: /Can't find the Weaver package file/, options: (s) => ({ source: join(s, "missing.tgz") }) },
      { name: "defaults use home", pattern: /not a Weaver book/, options: (s) => ({ tool: undefined, book: undefined, source: join(s, "missing.tgz") }),
        prepare: (s) => { const book = join(s, "home", "Weaver", ID); mkdirSync(book, { recursive: true }); writeFileSync(join(book, "notes.txt"), "Keep these notes."); } },
      { name: "unknown option", pattern: /Setup does not understand/, args: [WIN ? "-Soruce" : "--soruce"] }
    ];
    for (const entry of cases) await t.test(entry.name, (t) => {
      const sandbox = temporary(t);
      const options = { tool: join(sandbox, "tool"), book: join(sandbox, "tool", "book"), source, title: TITLE, id: ID, ...entry.options?.(sandbox) };
      const env = scriptEnv(sandbox, { ...entry.env, ...entry.environment?.(sandbox) });
      entry.prepare?.(sandbox, options);
      if (entry.shim) {
        const shimDir = join(sandbox, "shims"); mkdirSync(shimDir);
        const content = WIN ? entry.shim === "node" ? "@echo v20.11.1\r\n" : "@exit /b 1\r\n"
          : entry.shim === "node" ? "#!/bin/sh\nprintf '%s\\n' v20.11.1\n" : "#!/bin/sh\nexit 1\n";
        writeFileSync(join(shimDir, entry.shim + (WIN ? ".cmd" : "")), content, { mode: 0o755 });
        setPath(env, `${shimDir}${delimiter}${env.PATH || env.Path}`);
      }
      // The PowerShell runtime writes its startup profile even for "exit 0".
      // Only that OS cache is excluded; all book/tool files remain in the snapshot.
      const startupCache = WIN ? join(env.LOCALAPPDATA, "Microsoft", "Windows", "PowerShell", "StartupProfileData-NonInteractive") : null;
      const tree = (directory) => !existsSync(directory) ? null : readdirSync(directory, { withFileTypes: true })
        .filter((item) => item.name !== "npm-cache" && join(directory, item.name) !== startupCache).sort((a, b) => a.name.localeCompare(b.name))
        .map((item) => [item.name, item.isDirectory() ? tree(join(directory, item.name)) : readFileSync(join(directory, item.name))]);
      const before = tree(sandbox);
      const result = runSetup(script, options, env, "sh", entry.args || []);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, entry.pattern);
      assert.deepEqual(tree(sandbox), before, result.output);
      if (entry.name === "defaults use home") assert.ok(result.output.includes(join(sandbox, "home", "Weaver", ID)), result.output);
    });
  });
});
