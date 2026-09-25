// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareIntegrity } from "./integrity.mjs";
import { GENERATOR } from "./identity.mjs";
import { WEAVER_HOOK_COMMANDS } from "./hooks.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FINDINGS = {
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
    why: "PickBits Weaver runs with an AI that can run commands, such as Claude Code. Chat-only AIs (web chat windows) are not supported.",
    fix: "Use an AI that can run commands, such as Claude Code."
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
    problem: "Weaver's Claude Code hooks cannot run from this book folder",
    title: "Claude Code hooks can run",
    why: "Claude Code runs the hooks from the book folder, so Weaver must be installed there.",
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

function hookEntryInstalled(entries, command) {
  return Array.isArray(entries) && entries.some((entry) => entry?.matcher === WEAVER_HOOK_COMMANDS.matcher
    && Array.isArray(entry.hooks)
    && entry.hooks.some((hook) => hook?.type === "command" && hook.command === command));
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
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(executable, ["--no-install", "weaver", "--version"], {
    cwd: bookRoot,
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return result.status === 0 && result.stdout.includes(GENERATOR);
}

export function runDoctor({ bookRoot, packageRoot = PACKAGE_ROOT, nodeVersion = process.versions.node } = {}) {
  const root = resolve(bookRoot || process.cwd());
  const blocking = [];
  const warnings = [];
  const checks = [];

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
  if (!installed) blocking.push(...hooksInstalledFinding);
  checks.push(checkResult(FINDINGS.hooksInstalled.id, FINDINGS.hooksInstalled.title, installed ? "pass" : "blocking", hooksInstalledFinding));

  const runnable = hooksRunnable(root);
  const hooksRunnableFinding = runnable ? [] : [finding(FINDINGS.hooksRunnable)];
  if (!runnable) warnings.push(...hooksRunnableFinding);
  checks.push(checkResult(FINDINGS.hooksRunnable.id, FINDINGS.hooksRunnable.title, runnable ? "pass" : "warning", hooksRunnableFinding));

  const hostFinding = [finding(FINDINGS.host)];
  warnings.push(...hostFinding);
  checks.push(checkResult(FINDINGS.host.id, FINDINGS.host.title, "warning", hostFinding));

  return { generator: GENERATOR, ok: blocking.length === 0, blocking, warnings, checks };
}

export { FINDINGS, PACKAGE_ROOT };
