// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
// Runs serially after the main suite because it installs packages and starts PowerShell/sh many times.
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, symlinkSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { authorEnv } from "../helpers/env.mjs";
import { AI_HOST_ENV } from "../../engine/guard.mjs";
import { WEAVER_HOOK_COMMANDS, CODEX_HOOK_COMMANDS } from "../../engine/hooks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
  return { ...env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"), NPM_CONFIG_CACHE: join(sandbox, "npm-cache"), NPM_CONFIG_OFFLINE: "true",
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

function doctor(tool, book, env, expectedStatus = 1) {
  const result = nodeResult(installed(tool, "scripts/weaver.mjs"), ["doctor", "--json", "--root", book], env);
  assert.equal(result.status, expectedStatus, result.output);
  return JSON.parse(result.stdout);
}

function git(book, args, env) {
  const result = spawnSync("git", ["-C", book, ...args], { env, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

const ids = (items) => items.map(({ id }) => id);

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
  await t.test("packed setup creates a clean book and is idempotent from its installed copy", async (t) => {
    const sandbox = temporary(t), tool = join(sandbox, "tool folder"), book = join(tool, "my book");
    const options = { tool, book, source, title: TITLE, id: ID };
    const env = scriptEnv(sandbox, { WEAVER_FAKE_CODEX_TRUST: "untrusted" });
    mkdirSync(book, { recursive: true });
    for (const name of [".DS_Store", "desktop.ini", "Thumbs.db"]) writeFileSync(join(book, name), "OS metadata");
    const first = runSetup(script, options, env);
    assert.equal(first.status, 0, first.output);
    const project = JSON.parse(readFileSync(join(book, "project.json"), "utf8"));
    assert.equal(project.project_id, ID);
    assert.equal(project.title, TITLE);
    assert.ok(existsSync(join(book, ".git")));
    for (const name of [".DS_Store", "desktop.ini", "Thumbs.db", "narrative-state/1-1.md", "outline/scenes/1-1.md", "quality/critical-path.json"]) {
      assert.equal(existsSync(join(book, name)), false, name);
    }
    assert.equal(readdirSync(join(book, "manuscript")).some((name) => name.startsWith("chapter-")), false);
    assert.match(first.output, /run setup again yourself/);
    const rerun = first.output.split(/\r?\n/).find((line) => line.includes("setup-book") && line.includes(tool) && line.includes(book));
    assert.ok(rerun, first.output);
    assert.doesNotMatch(rerun, /-Source|--source/);
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
    assert.equal(guidance.rerun, rerun.trim());
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
      assert.match(next.output, /id and title you gave are not used/);
      if (!withSource) assert.match(next.output, /Keeping the Weaver already installed/);
      assert.equal(git(book, ["rev-parse", "HEAD"], env), head);
      assert.deepEqual(files.map((file) => readFileSync(file)), before);
      assert.equal(git(book, ["status", "--porcelain"], env), "");
      assert.equal(ids(guide(tool, book, env).steps).includes("codex-trust"), false);
    }
    await t.test("adopts a book whose hooks are missing", () => {
      rmSync(join(book, ".codex/hooks.json"));
      rmSync(join(book, ".codex/rules/weaver.rules"));
      const settingsPath = join(book, ".claude/settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      settings.hooks = {};
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      const result = runSetup(script, { tool, book }, env);
      assert.equal(result.status, 0, result.output);
      assert.doesNotMatch(result.output, /id and title you gave are not used/);
      for (const [file, commands] of [[".claude/settings.json", WEAVER_HOOK_COMMANDS], [".codex/hooks.json", CODEX_HOOK_COMMANDS]]) {
        const config = readFileSync(join(book, file), "utf8");
        for (const key of ["pre", "post", "shell"]) assert.ok(config.includes(commands[key]), `${file}: ${commands[key]}`);
      }
      assert.ok(existsSync(join(book, ".codex/rules/weaver.rules")));
      const health = doctor(tool, book, env, 0);
      assert.equal(health.guardrails.claude.on, true);
      assert.equal(health.guardrails.codex.on, true);
      assert.equal(git(book, ["status", "--porcelain"], env), "");
    });
    await t.test("hooks install failure is a plain setup error", () => {
      writeFileSync(join(book, ".claude/settings.json"), "{ not json");
      try {
        const result = runSetup(script, { tool, book }, env);
        assert.equal(result.status, 1, result.output);
        assert.match(result.output, /Weaver could not finish installing its safety checks/);
      } finally { git(book, ["checkout", "--", ".claude/settings.json"], env); }
    });
    await t.test("older Weaver is refused without changing the book", () => {
      const before = git(book, ["status", "--porcelain"], env);
      const contents = files.map((file) => readFileSync(file));
      rmSync(installed(tool, "scripts/setup-guide.mjs"));
      const result = runSetup(script, { tool, book }, env);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /older version/);
      assert.equal(git(book, ["rev-parse", "HEAD"], env), head);
      assert.equal(git(book, ["status", "--porcelain"], env), before);
      assert.deepEqual(files.map((file) => readFileSync(file)), contents);
    });
    await t.test("source repairs a changed installation", () => {
      const result = runSetup(script, { tool, book, source }, env);
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /puts back the released files/);
      assert.ok(existsSync(installed(tool, "scripts/setup-guide.mjs")));
      assert.equal(doctor(tool, book, env, 0).checks.find(({ id }) => id === "install-integrity").status, "pass");
      assert.equal(git(book, ["rev-parse", "HEAD"], env), head);
    });
    await t.test("book is re-checked after npm prunes a linked target", () => {
      const target = join(tool, "node_modules/book-two"), link = join(tool, "linked-book");
      cpSync(book, target, { recursive: true });
      symlinkSync(target, link, WIN ? "junction" : "dir");
      const result = runSetup(script, { tool, book: link, source }, env);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /disappeared/);
      assert.equal(existsSync(join(link, "project.json")), false);
      assert.equal(git(book, ["rev-parse", "HEAD"], env), head);
    });
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
    assert.doesNotMatch(result.output, /(?:^|[\s(])docs\/START-HERE\.md/);
    assert.match(result.output, /where to find the author's guide/);
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
      { name: "reserved id", pattern: /Windows keeps/, options: () => ({ id: "con" }) },
      { name: "blank title", pattern: /book title is empty/, options: () => ({ title: "  " }) },
      { name: "outside tool", pattern: /must be inside the tool folder/, options: (s) => ({ book: join(s, "elsewhere", "book") }) },
      { name: "same folder", pattern: /its own folder inside the tool folder/, options: (s) => ({ book: join(s, "tool") }) },
      { name: "book in node_modules", pattern: /inside a node_modules folder/, options: (s) => ({ book: join(s, "tool", "node_modules", "book-two") }) },
      { name: "book in installed package", pattern: /inside a node_modules folder/, options: (s) => ({ book: join(s, "tool", "node_modules", "@pickbitsai", "weaver", "my-book") }) },
      { name: "tool in node_modules", pattern: /The tool folder is inside a node_modules folder/, options: (s) => ({ tool: join(s, "NODE_MODULES", "tool"), book: join(s, "NODE_MODULES", "tool", "book") }) },
      { name: "whole home", pattern: /whole home folder/, options: (s) => ({ tool: join(s, "home"), book: join(s, "home", "book") }) },
      ...["Dropbox", "Dropbox (Personal)", "Dropbox (Example Co)", "OneDrive - Example", "iCloud Drive", "Google Drive"].map((provider) => ({ name: provider,
        pattern: new RegExp(provider.split(/ -| \(/)[0]), options: (s) => ({ tool: join(s, provider, "tool"), book: join(s, provider, "tool", "book") }) })),
      ...(WIN ? [{ name: "OneDrive environment", pattern: /OneDrive/, options: (s) => ({ tool: join(s, "cloud", "tool"), book: join(s, "cloud", "tool", "book") }), environment: (s) => ({ OneDrive: join(s, "cloud") }) }] : []),
      ...(WIN ? [
        { name: "tool with ampersand", pattern: /& or \^/, options: (s) => ({ tool: join(s, "R&D", "tool"), book: join(s, "R&D", "tool", "book") }) },
        { name: "book with caret", pattern: /& or \^/, options: (s) => ({ book: join(s, "tool", "a^b") }) },
        { name: "reserved book folder", pattern: /Windows keeps/, options: (s) => ({ book: join(s, "tool", "aux") }) },
        { name: "reserved folder with extension", pattern: /Windows keeps/, options: (s) => ({ tool: join(s, "CoM0.txt", "tool"), book: join(s, "CoM0.txt", "tool", "book") }) }
      ] : []),
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
      if (entry.name === "missing tarball") assert.match(result.output, /leave out/);
      assert.deepEqual(tree(sandbox), before, result.output);
      if (entry.name === "defaults use home") assert.ok(result.output.includes(join(sandbox, "home", "Weaver", ID)), result.output);
    });
  });
});
