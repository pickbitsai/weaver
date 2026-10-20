// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { spawnSync } from "node:child_process";
import path from "node:path";

const BACKUP_NOT_SET_UP = /\b(?:isn't|is not) backed up yet\b/iu;

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
  const backupChecks = report.checks.filter(({ id }) => id.includes("backup"));
  const backupFindings = [
    ...report.blocking.filter(({ id }) => id.includes("backup")),
    ...backupChecks.filter(({ status }) => status !== "pass").flatMap((check) =>
      (check.findings?.length ? check.findings : [{ problem: `${check.title || "Backup"} needs attention`,
        why: "Weaver's health check found a problem with your backup.",
        fix: "Run `npx weaver backup status` to see what is wrong, or contact PickBits." }])
        .map((finding) => ({ ...finding, id: check.id })))
  ];
  for (const { id, problem, why, fix } of report.blocking) {
    if (id.includes("backup") && BACKUP_NOT_SET_UP.test(problem)) continue;
    if (id === "guardrails-installed" && codexTrustPending && claudeGuardOk) continue;
    addUnique(problems, { id, problem, why, fix });
  }
  for (const { id, problem, why, fix } of backupFindings) {
    if (!BACKUP_NOT_SET_UP.test(problem)) addUnique(problems, { id, problem, why, fix });
  }
  if (status("hooks-runnable") === "warning") addUnique(problems, {
    id: "hooks-runnable", problem: "Weaver's safety checks cannot start from your book folder",
    why: "Your AI runs Weaver's checks from the book folder. They could not start there, so your AI's edits would not be checked.",
    fix: "Run setup again. If this message comes back, contact PickBits and send them this message. Until it is fixed, don't ask your AI to edit your book."
  });
  const step = (id, lines) => steps.push({ id, lines });
  const codex = hostsOnPath.codexCommand || "codex", claude = hostsOnPath.claudeCommand || "claude";
  if (requiredHosts.includes("codex") && !hostsOnPath.codex) step("codex-install", [
    "Codex: install the Codex command-line tool, so Weaver can check Codex's safety checks.",
    platform === "win32" ? 'In PowerShell, run:  powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"'
      : "In Terminal, run:  curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    "If it asks whether to start Codex now, answer n. Then open a new terminal window, run:  codex login",
    "and sign in with your ChatGPT account. If you only use Claude Code, ask PickBits to set your book to Claude Code only instead."
  ]);
  if (requiredHosts.includes("codex") && hostsOnPath.codex && status("codex-available") === "warning") step("codex-login", [
    "Codex: sign Codex in with your ChatGPT account.",
    `In a terminal, run:  ${codex} login  and sign in with your ChatGPT account, then check with:  ${codex} login status`,
    "Weaver uses your ChatGPT plan, never an API key."
  ]);
  if (codexTrustPending) step("codex-trust", [
    "Codex: open a local Codex session in your book folder (on this computer, not a cloud task)",
    "and trust the folder when Codex asks. Then type /hooks, read each Weaver hook and trust it.",
    "Close Codex and open it again so it loads Weaver's rules."
  ]);
  if (status("codex-windows-sandbox") === "warning") step("codex-sandbox", [
    "Codex: to write with Codex on Windows, let it edit files in the book folder:",
    `start it with  ${codex} --sandbox workspace-write  or choose workspace-write in Codex's permissions.`
  ]);
  if (requiredHosts.includes("claude") && !hostsOnPath.claude) step("claude-install", [
    "Claude Code: install Claude Code (it needs a paid Claude plan, Pro or Max).",
    platform === "win32" ? "In PowerShell, run:  irm https://claude.ai/install.ps1 | iex"
      : "In Terminal, run:  curl -fsSL https://claude.ai/install.sh | bash",
    "Then open a new terminal window in your book folder, run  claude  and sign in with your Claude account.",
    "If you only use Codex, ask PickBits to set your book to Codex only instead."
  ]);
  const packetHost = project.host?.kind || "claude";
  if (status("host-available") === "warning" && !steps.some(({ id }) => id === `${packetHost}-install`)) step("packet-host", [
    `Whole-book checks are set to use ${packetHost === "codex" ? "Codex" : "Claude Code"}, which was not found on this computer.`,
    "Install it, or ask PickBits to switch whole-book checks to the AI you use."
  ]);
  if (backupFindings.some(({ problem }) => BACKUP_NOT_SET_UP.test(problem))
    || (backupChecks.length === 0 && remotes.length === 0)) step("backup", [
    "Backup: create a private repository for this book on GitHub, then run these two lines in a terminal:",
    `  cd "${bookRoot}"`,
    `  ${platform === "win32" ? "npx.cmd" : "npx"} weaver backup setup --remote <your repository address>`
  ]);
  if (status("book-settings-sealed") === "warning") step("seal", [
    "Hand-over: when the steps above are done, PickBits seals your book settings",
    "by running  weaver guard seal  in your own terminal."
  ]);
  if (requiredHosts.includes("claude")) reminders.push({ id: "claude-trust", lines: [
    `Claude Code: open Claude Code in your book folder (run  ${claude}  in a terminal there), sign in with your`,
    "Claude account if it asks, and answer yes when it asks whether you trust the folder.",
    "If Claude Code was already open there, close it and open it again."
  ] });
  const explained = new Set(["host", "codex-hook-trust", "codex-available", "codex-windows-sandbox", "book-settings-sealed", "host-available", "hooks-runnable"]);
  for (const check of report.checks) {
    if (check.status !== "warning" || explained.has(check.id) || check.id.includes("backup")) continue;
    for (const { problem, fix } of check.findings || []) addUnique(notes, { id: check.id, problem, fix });
  }
  if (platform === "win32") for (const item of [...problems, ...notes]) {
    if (typeof item.fix === "string") item.fix = item.fix.replace(/(^|[^\w.-])npx(?= (?:--no-install )?weaver\b)/gu, "$1npx.cmd");
  }
  return { ok: problems.length === 0, steps, reminders, problems, notes };
}

export function setupCommand({ platform = process.platform, toolRoot, bookRoot }) {
  if (platform === "win32") {
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    return `powershell -NoProfile -ExecutionPolicy Bypass -File ${quote(path.win32.join(toolRoot, "node_modules", "@pickbitsai", "weaver", "scripts", "setup-book.ps1"))} -ToolFolder ${quote(toolRoot)} -BookFolder ${quote(bookRoot)}`;
  }
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  return `sh ${quote(path.posix.join(toolRoot, "node_modules", "@pickbitsai", "weaver", "scripts", "setup-book.sh"))} --tool-folder ${quote(toolRoot)} --book-folder ${quote(bookRoot)}`;
}

export function renderSetupGuidance(guidance, { generator, title, id, bookRoot, toolRoot, guidePath, platform = process.platform }) {
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
    `Then review and decide on the author page. The author's guide: ${guidePath}`);
  if (toolRoot != null) lines.push("To check everything again later, run setup again yourself, in a terminal (your AI can't run it):",
    `  ${setupCommand({ platform, toolRoot, bookRoot })}`, "For help, contact PickBits.");
  else lines.push("To check everything again later, run setup again. For help, contact PickBits.");
  lines.push("");
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
      const result = spawnSync(process.platform === "win32" ? "where.exe" : "sh",
        process.platform === "win32" ? [name] : ["-c", 'command -v "$1"', "setup-guide", name],
        { encoding: "utf8", windowsHide: true, timeout: 10000 });
      if (result.status !== 0) return { available: false, command: name };
      if (process.platform !== "win32") return { available: true, command: name };
      const executable = result.stdout.split(/\r?\n/u).map((line) => line.trim()).find((line) => /\.(?:exe|cmd|bat)$/iu.test(line));
      return { available: Boolean(executable), command: /\.(?:cmd|bat)$/iu.test(executable || "") ? `${name}.cmd` : name };
    } catch { return { available: false, command: name }; }
  };
  const codex = found("codex"), claude = found("claude");
  return { codex: codex.available, claude: claude.available, codexCommand: codex.command, claudeCommand: claude.command };
}
