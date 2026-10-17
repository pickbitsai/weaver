// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { spawnSync } from "node:child_process";

export function classifySetup({ report, project = {}, remotes = [], hostsOnPath = { codex: false, claude: false },
  platform = process.platform, bookRoot = "", toolRoot = null }) {
  const checks = new Map(report.checks.map((check) => [check.id, check]));
  const status = (id) => checks.get(id)?.status || "pass";
  const requiredHosts = Array.isArray(project.hosts) && project.hosts.length ? project.hosts : ["claude", "codex"];
  const g = report.guardrails || {};
  const codexTrustPending = requiredHosts.includes("codex") && status("codex-hook-trust") === "warning"
    && Array.isArray(g.codex?.problems) && g.codex.problems.length === 1 && /trust/i.test(g.codex.problems[0]);
  const claudeGuardOk = !requiredHosts.includes("claude") || (Array.isArray(g.claude?.problems) && g.claude.problems.length === 0);
  const steps = [], reminders = [], problems = [], notes = [];
  const addUnique = (list, item) => {
    if (!list.some((entry) => entry.id === item.id && entry.problem === item.problem)) list.push(item);
  };
  let backupBlocked = false;
  for (const { id, problem, why, fix } of report.blocking) {
    if (id.includes("backup")) { backupBlocked = true; continue; }
    if (id === "guardrails-installed" && codexTrustPending && claudeGuardOk) continue;
    addUnique(problems, { id, problem, why, fix });
  }
  if (status("hooks-runnable") === "warning") addUnique(problems, {
    id: "hooks-runnable", problem: "Weaver's safety checks cannot start from your book folder",
    why: "Your AI runs Weaver's checks from the book folder, and they cannot find Weaver there, so its edits would not be checked.",
    fix: toolRoot ? `Keep the book folder inside the tool folder (${toolRoot}) and run setup again.`
      : "Keep the book folder inside the folder where Weaver is installed and run setup again."
  });
  const step = (id, lines) => steps.push({ id, lines });
  if (requiredHosts.includes("codex") && !hostsOnPath.codex) step("codex-install", [
    "Codex: install the Codex command-line tool, so Weaver can check its safety hooks.",
    "In a terminal, run:  npm install -g @openai/codex",
    "then run:  codex login  and choose ChatGPT."
  ]);
  if (requiredHosts.includes("codex") && hostsOnPath.codex && status("codex-available") === "warning") step("codex-login", [
    "Codex: sign Codex in with your ChatGPT account.",
    "In a terminal, run:  codex login  and choose ChatGPT, then check with:  codex login status",
    "Weaver uses your ChatGPT plan, never an API key."
  ]);
  if (codexTrustPending) step("codex-trust", [
    "Codex: open a local Codex session in your book folder (on this computer, not a cloud task)",
    "and trust the folder when Codex asks. Then type /hooks, read each Weaver hook and trust it.",
    "Close Codex and open it again so it loads Weaver's rules."
  ]);
  if (status("codex-windows-sandbox") === "warning") step("codex-sandbox", [
    "Codex: to write with Codex on Windows, let it edit files in the book folder:",
    "start it with  codex --sandbox workspace-write  or choose workspace-write in Codex's permissions."
  ]);
  if (requiredHosts.includes("claude") && !hostsOnPath.claude) step("claude-install", [
    "Claude Code: install Claude Code (https://claude.com/claude-code) and sign in with your Claude account."
  ]);
  const packetHost = project.host?.kind || "claude";
  if (status("host-available") === "warning" && !steps.some(({ id }) => id === `${packetHost}-install`)) step("packet-host", [
    `Whole-book checks are set to use ${packetHost === "codex" ? "Codex" : "Claude Code"}, which was not found on this computer.`,
    "Install it, or ask PickBits to switch whole-book checks to the AI you use."
  ]);
  const backupChecks = report.checks.filter(({ id }) => id.includes("backup"));
  if (backupBlocked || backupChecks.some(({ status }) => status !== "pass")
    || (remotes.length === 0 && !backupChecks.some(({ status }) => status === "pass"))) step("backup", [
    "Backup: create a private repository for this book on GitHub, then run these two lines in a terminal:",
    `  cd "${bookRoot}"`,
    `  ${platform === "win32" ? "npx.cmd" : "npx"} weaver backup setup --remote <your repository address>`
  ]);
  if (status("book-settings-sealed") === "warning") step("seal", [
    "Hand-over: when the steps above are done, PickBits seals your book settings",
    "by running  weaver guard seal  in your own terminal."
  ]);
  if (requiredHosts.includes("claude")) reminders.push({ id: "claude-trust", lines: [
    "Claude Code: open Claude Code in your book folder and answer yes when it asks whether you trust",
    "the folder. If Claude Code was already open there, close it and open it again."
  ] });
  const explained = new Set(["host", "codex-hook-trust", "codex-available", "codex-windows-sandbox", "book-settings-sealed", "host-available", "hooks-runnable"]);
  for (const check of report.checks) {
    if (check.status !== "warning" || explained.has(check.id) || check.id.includes("backup")) continue;
    for (const { problem, fix } of check.findings || []) addUnique(notes, { id: check.id, problem, fix });
  }
  return { ok: problems.length === 0, steps, reminders, problems, notes };
}

export function renderSetupGuidance(guidance, { generator, title, id, bookRoot, toolRoot, guidePath }) {
  const { problems, steps, reminders, notes } = guidance;
  const lines = [problems.length ? "Weaver is installed, but something needs fixing before you start."
    : steps.length ? "Weaver is set up. A few one-time steps are left." : "Weaver is set up and ready.", "",
  `  Book:        ${title || "(unknown)"} (${id || "(unknown)"})`, `  Book folder: ${bookRoot}`];
  if (toolRoot != null) lines.push(`  Tool folder: ${toolRoot}`);
  lines.push(`  Weaver:      ${generator}`);
  if (problems.length) {
    lines.push("", "Please fix this first:");
    for (const item of problems) lines.push(`  - ${item.problem}`, `    Why: ${item.why}`, `    Fix: ${item.fix}`);
  }
  if (steps.length) {
    lines.push("", "One-time steps still to do:");
    steps.forEach((item, index) => {
      const prefix = `  ${index + 1}. `;
      lines.push(prefix + item.lines[0], ...item.lines.slice(1).map((line) => " ".repeat(prefix.length) + line));
    });
  }
  if (reminders.length) {
    lines.push("", "If you have not done these yet:");
    for (const item of reminders) lines.push(`  - ${item.lines[0]}`, ...item.lines.slice(1).map((line) => `    ${line}`));
  }
  if (notes.length) {
    lines.push("", "Also worth knowing:");
    for (const item of notes) lines.push(`  - ${item.problem}`, `    ${item.fix}`);
  }
  lines.push("", "Every day: open your AI in your book folder and ask it to check or fix a chapter.",
    `Then review and decide on the author page. The author's guide: ${guidePath}`,
    "To check everything again later, run setup again. For help, contact PickBits.", "");
  return lines.join("\n");
}

export function gitRemotes(bookRoot) {
  try {
    const result = spawnSync("git", ["-C", bookRoot, "remote"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    return result.status === 0 ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  } catch { return []; }
}

export function findHostsOnPath() {
  const found = (name) => {
    try {
      return spawnSync(process.platform === "win32" ? "where.exe" : "sh",
        process.platform === "win32" ? [name] : ["-c", 'command -v "$1"', "setup-guide", name],
        { encoding: "utf8", windowsHide: true, timeout: 10000 }).status === 0;
    } catch { return false; }
  };
  return { codex: found("codex"), claude: found("claude") };
}
