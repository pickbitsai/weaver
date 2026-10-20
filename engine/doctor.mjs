// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareIntegrity } from "./integrity.mjs";
import { GENERATOR } from "./identity.mjs";
import { WEAVER_HOOK_COMMANDS, CODEX_HOOK_COMMANDS, codexRules } from "./hooks.mjs";
import { probeCodex } from "./codex-status.mjs";
import { hostAvailable } from "./host.mjs";
import { reviewerWarnings } from "./reviewers.mjs";
import { compareBookSettings, dirtyGuardedConfig, unapprovedHistory, WEAVER_DENY_RULES } from "./guard.mjs";
import { backupDoctorCheck } from "./backup.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FINDINGS = {
  guardrailsInstalled: {
    id: "guardrails-installed", title: "Author guardrails installed",
    problem: "Weaver's author guardrails are missing or turned off",
    why: "The AI must leave decisions and book settings to the author.",
    fix: "Ask PickBits to restore the guardrails with `weaver hooks install`."
  },
  settingsSealed: {
    id: "book-settings-sealed", title: "Book settings match their seal",
    problem: "Your book's settings were changed after they were sealed",
    why: "Changed settings can hide problems in the prose or turn off the checks.",
    fix: "Contact PickBits to review and restore the settings, or seal an intended change with `weaver guard seal`."
  },
  settingsUnsealed: {
    id: "book-settings-sealed", title: "Book settings match their seal",
    problem: "Settings not sealed yet; PickBits seals them at hand-over",
    why: "A seal makes later changes to the book's settings visible.",
    fix: "Ask PickBits to run `weaver guard seal` at hand-over."
  },
  approvedHistory: {
    id: "approved-history", title: "Manuscript history has author approval",
    problem: "Changes entered the book without the author's approval",
    why: "Every manuscript change after the starting point needs an author approval record.",
    fix: "Contact PickBits to review the listed commits and recover the approved book."
  },
  protectedFilesClean: {
    id: "protected-files-clean", title: "Book settings have no pending changes",
    problem: "Your book's settings have uncommitted changes",
    why: "These settings changes have not been saved in the book's history.",
    fix: "Tell the author and contact PickBits to review the changed settings."
  },
  node: {
    id: "node-version",
    problem: "Node.js is older than version 22",
    title: "Node.js 22 or newer",
    why: "This version of Weaver needs Node.js 22 or newer to run.",
    fix: "Install Node.js 22 or newer, then run Weaver again."
  },
  git: {
    id: "git-available",
    problem: "Git is not installed",
    title: "Git is available",
    why: "Git is needed to protect your book's history.",
    fix: "Install Git, then run Weaver again."
  },
  bookGit: {
    id: "book-in-git",
    problem: "Your book folder is not under Git",
    title: "Book is under Git",
    why: "Without Git, Weaver can't keep a history of your book or undo changes.",
    fix: "For a new book, run `weaver init` so Git is set up. For an existing folder, run `git init` in the book folder, or ask your AI to."
  },
  separation: {
    id: "tool-book-separation",
    problem: "The tool and your book share a folder",
    title: "Tool and book are separate",
    why: "The tool and your book are in the same folder, so an AI editing your book can change the tool too.",
    fix: "Install Weaver as a package outside the book folder and remove any copied Weaver files from the book folder."
  },
  integrityModified: {
    id: "install-integrity",
    title: "Weaver install is unchanged",
    problem: "Weaver's own files have been changed",
    why: "Weaver's own files have been changed since this version was released. PickBits can only support an unmodified install.",
    fix: "Reinstall the released version of Weaver."
  },
  integrityUnverifiable: {
    id: "install-integrity",
    title: "Weaver install can be checked",
    problem: "Weaver cannot check its own files",
    why: "Weaver cannot confirm that its own files are the released files.",
    fix: "Reinstall the released version of Weaver."
  },
  host: {
    id: "host",
    problem: "Use an AI that can run commands",
    title: "Command-running AI host",
    why: "PickBits Weaver runs with Claude Code or local Codex sessions that can run commands. Chat-only windows are not supported.",
    fix: "Use Claude Code or a local Codex session."
  },
  hostAvailable: {
    id: "host-available",
    problem: "The configured command-line AI host is not available",
    title: "Command-line AI host is available",
    why: "Bootstrap needs the configured command-line AI host to answer work packets.",
    fix: "Install the configured command-line AI host (Claude Code or Codex) or set host.kind in project.json."
  },
  hooksInstalled: {
    id: "hooks-installed",
    problem: "Weaver's Claude Code hooks are not installed",
    title: "Claude Code hooks installed",
    why: "Without Weaver's hooks, AI scene edits are not protected by the chapter and style checks.",
    fix: "Run `weaver hooks install` from the book folder."
  },
  hooksRunnable: {
    id: "hooks-runnable",
    problem: "Weaver's hooks cannot run from this book folder",
    title: "Weaver hooks can run",
    why: "Both hosts run the hooks from the book folder, so Weaver must be available there.",
    fix: "Install Weaver in the book folder with npm."
  }
};

function isInside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function checkResult(id, title, status, findings = []) {
  return { id, title, status, ok: status !== "blocking", findings };
}

function finding(template, details = {}) {
  return { ...template, ...details };
}

export function gitAvailable(executable = "git") {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0;
}

function bookIsInGit(bookRoot) {
  const result = spawnSync("git", ["-C", bookRoot, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

function copiedWeaverEngine(bookRoot) {
  const ignored = new Set(["node_modules", ".git", "releases"]);
  function walk(directory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (walk(path)) return true;
      } else if (entry.isFile() && entry.name === "identity.mjs") {
        try {
          if (readFileSync(path, "utf8").includes('PRODUCT_NAME = "PickBits Weaver"')) return true;
        } catch {
          // An unreadable copy cannot be mistaken for the engine identity.
        }
      }
    }
    return false;
  }
  return walk(bookRoot);
}

function hookEntryInstalled(entries, command, matcher = WEAVER_HOOK_COMMANDS.matcher) {
  return Array.isArray(entries) && entries.some((entry) => entry?.matcher === matcher
    && Array.isArray(entry.hooks)
    && entry.hooks.some((hook) => hook?.type === "command" && hook.command === command && hook.async !== true));
}

function claudeGuardProblems(root, homeDirectory) {
  const problems = [];
  let settings = {};
  for (const [path, label] of [[join(root, ".claude", "settings.json"), ".claude/settings.json"], [join(root, ".claude", "settings.local.json"), ".claude/settings.local.json"], [join(homeDirectory, ".claude", "settings.json"), "~/.claude/settings.json"]]) {
    if (!existsSync(path)) continue;
    try {
      const document = JSON.parse(readFileSync(path, "utf8"));
      if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("expected settings");
      if (label === ".claude/settings.json") settings = document;
      if (document.disableAllHooks === true) problems.push(`${label} turns off all hooks`);
    } catch { problems.push(`${label} cannot be read`); }
  }
  if (!hookEntryInstalled(settings.hooks?.PreToolUse, WEAVER_HOOK_COMMANDS.pre)
    || !hookEntryInstalled(settings.hooks?.PostToolUse, WEAVER_HOOK_COMMANDS.post)
    || !hookEntryInstalled(settings.hooks?.PreToolUse, WEAVER_HOOK_COMMANDS.shell, WEAVER_HOOK_COMMANDS.shellMatcher)) problems.push("a required edit or shell hook is missing");
  if (!Array.isArray(settings.permissions?.deny) || !WEAVER_DENY_RULES.every((rule) => settings.permissions.deny.includes(rule))) problems.push("an author permission rule is missing");
  if (settings.permissions?.disableBypassPermissionsMode !== "disable") problems.push("permission bypass has not been disabled");
  return problems;
}

function codexGuardProblems(root) {
  const problems = [];
  try {
    const settings = JSON.parse(readFileSync(join(root, ".codex", "hooks.json"), "utf8"));
    for (const [event, command, matcher] of [
      ["PreToolUse", CODEX_HOOK_COMMANDS.pre, CODEX_HOOK_COMMANDS.matcher],
      ["PostToolUse", CODEX_HOOK_COMMANDS.post, CODEX_HOOK_COMMANDS.matcher],
      ["PreToolUse", CODEX_HOOK_COMMANDS.shell, CODEX_HOOK_COMMANDS.shellMatcher]
    ]) if (!hookEntryInstalled(settings.hooks?.[event], command, matcher)) problems.push(`the ${command.split(" ")[4]} hook is missing`);
  } catch { problems.push(".codex/hooks.json is missing or cannot be read"); }
  try {
    const rules = readFileSync(join(root, ".codex", "rules", "weaver.rules"), "utf8");
    if (!codexRules().split("\n").filter((line) => line.startsWith("prefix_rule")).every((line) => rules.includes(line))) problems.push("an author command rule is missing from .codex/rules/weaver.rules");
  } catch { problems.push(".codex/rules/weaver.rules is missing or cannot be read"); }
  return problems;
}

function hooksInstalled(bookRoot) {
  try {
    const settings = JSON.parse(readFileSync(join(bookRoot, ".claude", "settings.json"), "utf8"));
    return Boolean(settings && typeof settings === "object" && !Array.isArray(settings)
      && hookEntryInstalled(settings.hooks?.PreToolUse, WEAVER_HOOK_COMMANDS.pre)
      && hookEntryInstalled(settings.hooks?.PostToolUse, WEAVER_HOOK_COMMANDS.post));
  } catch {
    return false;
  }
}

function hooksRunnable(bookRoot) {
  // npx can consult the package registry even with --no-install. Resolve the
  // installed launcher first so doctor never needs package resolution.
  let directory = resolve(bookRoot), executable;
  while (true) {
    const candidate = join(directory, "node_modules", ".bin", process.platform === "win32" ? "weaver.cmd" : "weaver");
    if (existsSync(candidate)) { executable = candidate; break; }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!executable) {
    const located = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["weaver"], { encoding: "utf8", timeout: 2000, windowsHide: true });
    if (located.status !== 0) return false;
    executable = located.stdout.trim().split(/\r?\n/u)[0];
  }
  const result = spawnSync(process.platform === "win32" ? `"${executable}"` : executable, ["--version"], {
    cwd: bookRoot,
    shell: process.platform === "win32",
    windowsHide: true,
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return result.status === 0 && result.stdout.includes(GENERATOR);
}

export function runDoctor({ bookRoot, packageRoot = PACKAGE_ROOT, nodeVersion = process.versions.node, homeDirectory = homedir(),
  codexHome = homeDirectory === homedir() ? process.env.CODEX_HOME || join(homeDirectory, ".codex") : join(homeDirectory, ".codex"),
  codexStatus, platform = process.platform } = {}) {
  const root = resolve(bookRoot || process.cwd());
  const blocking = [];
  const warnings = [];
  const checks = [];
  let project = {};
  try { project = JSON.parse(readFileSync(join(root, "project.json"), "utf8")); } catch { /* Reported by project checks. */ }
  const requiredHosts = project.hosts || ["claude", "codex"];

  const nodeOk = Number.parseInt(String(nodeVersion).split(".")[0], 10) >= 22;
  const nodeFinding = nodeOk ? [] : [finding(FINDINGS.node)];
  if (!nodeOk) blocking.push(...nodeFinding);
  checks.push(checkResult(FINDINGS.node.id, FINDINGS.node.title, nodeOk ? "pass" : "blocking", nodeFinding));

  const gitOk = gitAvailable();
  const gitFinding = gitOk ? [] : [finding(FINDINGS.git)];
  if (!gitOk) blocking.push(...gitFinding);
  checks.push(checkResult(FINDINGS.git.id, FINDINGS.git.title, gitOk ? "pass" : "blocking", gitFinding));

  const inGit = gitOk && bookIsInGit(root);
  const bookGitFinding = inGit ? [] : [finding(FINDINGS.bookGit)];
  if (!inGit) blocking.push(...bookGitFinding);
  checks.push(checkResult(FINDINGS.bookGit.id, FINDINGS.bookGit.title, inGit ? "pass" : "blocking", bookGitFinding));

  const separate = !isInside(packageRoot, root) && !copiedWeaverEngine(root);
  const separationFinding = separate ? [] : [finding(FINDINGS.separation)];
  if (!separate) blocking.push(...separationFinding);
  checks.push(checkResult(FINDINGS.separation.id, FINDINGS.separation.title, separate ? "pass" : "blocking", separationFinding));

  const integrity = compareIntegrity(packageRoot);
  let integrityFinding = [];
  if (integrity.status === "modified") {
    integrityFinding = [finding(FINDINGS.integrityModified, { paths: integrity.paths })];
    blocking.push(...integrityFinding);
  } else if (integrity.status === "unverifiable") {
    integrityFinding = [finding(FINDINGS.integrityUnverifiable)];
    blocking.push(...integrityFinding);
  }
  checks.push(checkResult(
    FINDINGS.integrityModified.id,
    integrity.status === "unverifiable" ? FINDINGS.integrityUnverifiable.title : FINDINGS.integrityModified.title,
    integrity.status === "intact" ? "pass" : "blocking",
    integrityFinding
  ));

  const installed = hooksInstalled(root);
  const hooksInstalledFinding = installed ? [] : [finding(FINDINGS.hooksInstalled)];
  if (!installed) (requiredHosts.includes("claude") ? blocking : warnings).push(...hooksInstalledFinding);
  checks.push(checkResult(FINDINGS.hooksInstalled.id, FINDINGS.hooksInstalled.title, installed ? "pass" : requiredHosts.includes("claude") ? "blocking" : "warning", hooksInstalledFinding));

  const runnable = hooksRunnable(root);
  const hooksRunnableFinding = runnable ? [] : [finding(FINDINGS.hooksRunnable)];
  if (!runnable) warnings.push(...hooksRunnableFinding);
  checks.push(checkResult(FINDINGS.hooksRunnable.id, FINDINGS.hooksRunnable.title, runnable ? "pass" : "warning", hooksRunnableFinding));

  const hostFinding = [finding(FINDINGS.host)];
  warnings.push(...hostFinding);
  checks.push(checkResult(FINDINGS.host.id, FINDINGS.host.title, "warning", hostFinding));

  const addGuardCheck = (template, status, details = {}) => {
    const findings = status === "pass" ? [] : [finding(template, details)];
    if (status === "blocking") blocking.push(...findings);
    if (status === "warning") warnings.push(...findings);
    checks.push(checkResult(template.id, template.title, status, findings));
  };
  const codex = codexStatus ?? probeCodex(root, codexHome);
  const guardrails = {
    claude: { problems: claudeGuardProblems(root, homeDirectory) },
    codex: { problems: codexGuardProblems(root) }
  };
  const codexInstalled = guardrails.codex.problems.length === 0;
  const expectedHooks = [CODEX_HOOK_COMMANDS.pre, CODEX_HOOK_COMMANDS.post, CODEX_HOOK_COMMANDS.shell];
  const liveHooks = codex.hooks?.hooks || [];
  const trusted = expectedHooks.every((command) => liveHooks.some((hook) => hook.command === command
    && resolve(hook.sourcePath || "") === join(root, ".codex", "hooks.json")
    && hook.enabled && hook.async !== true && ["trusted", "managed"].includes(hook.trustStatus)));
  if (codex.config?.hooksEnabled === false) guardrails.codex.problems.push("Codex has turned off hooks");
  else if (codexInstalled && !trusted) guardrails.codex.problems.push(codex.available
    ? "project hooks are not trusted or could not be verified; open /hooks in this book folder"
    : "Codex is not installed, so hook trust cannot be checked");
  const trustFix = "Open a local Codex session in the book folder, trust the folder when asked, then type /hooks and review and trust each Weaver hook. Restart Codex. Changed hooks need review again.";
  addGuardCheck({ id: "codex-hook-trust", title: "Codex project hooks trusted", why: "Codex skips project hooks until the folder and the current hook definitions are trusted.", fix: trustFix },
    codexInstalled && !trusted ? "warning" : "pass", { problem: "Codex project hooks are present but not trusted or their trust could not be checked" });
  for (const [kind, item] of Object.entries(guardrails)) {
    item.on = item.problems.length === 0;
    item.required = requiredHosts.includes(kind);
    item.label = `${kind === "claude" ? "Claude Code" : "Codex"} guardrails: ${item.on ? "on" : "off"}${item.problems.length ? ` (${item.problems[0]})` : ""}`;
  }
  const guardProblems = Object.values(guardrails).filter((item) => item.required).flatMap((item) => item.problems.length ? [item.label] : []);
  addGuardCheck(FINDINGS.guardrailsInstalled, guardProblems.length ? "blocking" : "pass", {
    problem: `${FINDINGS.guardrailsInstalled.problem}: ${guardProblems.join("; ")}`,
    fix: guardrails.claude.problems.some((problem) => problem.startsWith("~")) ? "Your user-level Claude settings disable or prevent the checks. Contact PickBits to restore them."
      : codexInstalled && !trusted && requiredHosts.includes("codex") ? trustFix : FINDINGS.guardrailsInstalled.fix
  });
  const guardCheck = checks.at(-1);
  guardCheck.hosts = guardrails;
  guardCheck.title = Object.values(guardrails).map((item) => item.label).join("; ");
  addGuardCheck({ id: "codex-available", title: "Codex installed and logged in", why: "Codex packet calls use the author's ChatGPT login.", fix: "Install Codex CLI, run `codex login`, choose ChatGPT, then run `codex login status`." },
    codex.available && codex.loggedIn && codex.chatgpt ? "pass" : "warning", { problem: !codex.available ? "Codex is not installed or cannot start" : !codex.loggedIn ? "Codex is not logged in" : "Codex is using API credentials instead of ChatGPT" });
  if (platform === "win32" && codex.config?.sandboxMode === "read-only") addGuardCheck({ id: "codex-windows-sandbox", title: "Codex can edit book prose on Windows", why: "The interactive read-only sandbox prevents file edits. Weaver packet calls deliberately remain read-only.", fix: "For interactive writing, start `codex --sandbox workspace-write` in the book folder (or select workspace-write in Codex permissions)." }, "warning", { problem: "Codex is configured read-only, so interactive prose edits are blocked" });
  try {
    const seal = compareBookSettings(root);
    addGuardCheck(seal.status === "warning" ? FINDINGS.settingsUnsealed : FINDINGS.settingsSealed, seal.status, seal.paths.length ? {
      paths: seal.paths, problem: `${FINDINGS.settingsSealed.problem}: ${seal.paths.join(", ")}`
    } : {});
  } catch {
    addGuardCheck(FINDINGS.settingsSealed, "blocking", { problem: "Your book's settings seal cannot be checked" });
  }
  try {
    const commits = inGit ? unapprovedHistory(root, project.source_root || "manuscript") : [];
    addGuardCheck(FINDINGS.approvedHistory, commits.length ? "blocking" : "pass", {
      commits, problem: `${FINDINGS.approvedHistory.problem}: ${commits.map((commit) => `${commit.sha} ${commit.subject}`).join("; ")}`
    });
  } catch {
    addGuardCheck(FINDINGS.approvedHistory, "blocking", { problem: "Your book's approval history cannot be checked" });
  }
  try {
    const paths = inGit ? dirtyGuardedConfig(root) : [];
    addGuardCheck(FINDINGS.protectedFilesClean, paths.length ? "warning" : "pass", {
      paths, problem: `${FINDINGS.protectedFilesClean.problem}: ${paths.join(", ")}`
    });
  } catch {
    addGuardCheck(FINDINGS.protectedFilesClean, "warning", { problem: "Pending book settings changes cannot be checked" });
  }
  const available = hostAvailable(project);
  const availableFinding = available ? [] : [finding(FINDINGS.hostAvailable)];
  if (!available) warnings.push(...availableFinding);
  checks.push(checkResult(FINDINGS.hostAvailable.id, FINDINGS.hostAvailable.title, available ? "pass" : "warning", availableFinding));

  const reviewerFindings = reviewerWarnings(root).map((problem) => ({
    id: "book-reviewers", title: "Book reviewer settings", problem,
    why: "This reviewer is skipped; other reviewers still run.",
    fix: "Correct the named reviewer file in quality/reviewers."
  }));
  warnings.push(...reviewerFindings);
  checks.push(checkResult("book-reviewers", "Book reviewer settings", reviewerFindings.length ? "warning" : "pass", reviewerFindings));
  const backup = backupDoctorCheck(root, { inGit });
  if (backup.status === "warning") warnings.push(...backup.findings);
  checks.push({ ...checkResult(backup.id, backup.title, backup.status, backup.findings), summary: backup.summary });
  return { generator: GENERATOR, ok: blocking.length === 0, blocking, warnings, checks, guardrails };
}

export { FINDINGS, PACKAGE_ROOT };
