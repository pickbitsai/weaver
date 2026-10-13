// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { parseCodexPatch, applyCodexHunks } from "./codex-patch.mjs";
import { countWords, loadScenes } from "./manuscript.mjs";
import { readProject } from "./project.mjs";
import { loadRules, runRules, runRulesForScene } from "./rules.mjs";
import { blockingRuleRegression } from "./rule-regression.mjs";
import { otherPendingChapters } from "./changes.mjs";
import { runVoiceCheck } from "./voice.mjs";
import { deny, editGuard, shellGuard, hookBookRoot, AUTHOR_ONLY_COMMANDS, GIT_WRITES, INSTALL_WRITES, WEAVER_DENY_RULES } from "./guard.mjs";

const MATCHER = "Edit|Write|MultiEdit|NotebookEdit";
const SHELL_MATCHER = "Bash|PowerShell";
const PRE_COMMAND = "npx --no-install weaver hook pre";
const POST_COMMAND = "npx --no-install weaver hook post";
const SHELL_COMMAND = "npx --no-install weaver hook shell";

export const WEAVER_HOOK_COMMANDS = { pre: PRE_COMMAND, post: POST_COMMAND, shell: SHELL_COMMAND, matcher: MATCHER, shellMatcher: SHELL_MATCHER };

function hookEntry(matcher, command) {
  return { matcher, hooks: [{ type: "command", command }] };
}

function isWeaverEntry(entry, command, matcher) {
  return entry?.matcher === matcher && Array.isArray(entry.hooks) && entry.hooks.some((hook) => hook?.type === "command" && hook.command === command && hook.async !== true);
}

function installClaudeHooks(root) {
  const directory = join(root, ".claude");
  const path = join(directory, "settings.json");
  let settings = {};
  const existed = existsSync(path);
  if (existed) {
    try {
      settings = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`invalid .claude/settings.json: ${error.message}`);
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("invalid .claude/settings.json: expected an object");
  }
  const next = structuredClone(settings);
  if (!next.hooks || typeof next.hooks !== "object" || Array.isArray(next.hooks)) next.hooks = {};
  if (!Array.isArray(next.hooks.PreToolUse)) next.hooks.PreToolUse = [];
  if (!Array.isArray(next.hooks.PostToolUse)) next.hooks.PostToolUse = [];
  for (const [event, matcher, command] of [["PreToolUse", MATCHER, PRE_COMMAND], ["PostToolUse", MATCHER, POST_COMMAND], ["PreToolUse", SHELL_MATCHER, SHELL_COMMAND]]) {
    // Upgrade an old Weaver matcher without changing unrelated hooks in it.
    for (const entry of next.hooks[event]) {
      if (entry?.matcher === "Edit|Write|MultiEdit" && Array.isArray(entry.hooks)) {
        entry.hooks = entry.hooks.filter((hook) => hook?.command !== command);
      }
    }
    next.hooks[event] = next.hooks[event].filter((entry) => !Array.isArray(entry?.hooks) || entry.hooks.length);
    if (!next.hooks[event].some((entry) => isWeaverEntry(entry, command, matcher))) next.hooks[event].push(hookEntry(matcher, command));
  }
  if (!next.permissions || typeof next.permissions !== "object" || Array.isArray(next.permissions)) next.permissions = {};
  if (!Array.isArray(next.permissions.deny)) next.permissions.deny = [];
  for (const rule of WEAVER_DENY_RULES) if (!next.permissions.deny.includes(rule)) next.permissions.deny.push(rule);
  next.permissions.disableBypassPermissionsMode = "disable";
  const changed = JSON.stringify(next) !== JSON.stringify(settings);
  if (changed || !existed) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  }
  return { path, changed, created: !existed };
}

export const CODEX_HOOK_COMMANDS = {
  pre: `${PRE_COMMAND} --host codex`, post: `${POST_COMMAND} --host codex`,
  shell: `${SHELL_COMMAND} --host codex`, matcher: "^apply_patch$", shellMatcher: "^Bash$"
};

export function codexRules() {
  const patterns = AUTHOR_ONLY_COMMANDS.flatMap((command) => [
    ["weaver"], ["weaver.cmd"], ["npx", "weaver"], ["npx", "--no-install", "weaver"],
    ["npx.cmd", "weaver"], ["npx.cmd", "--no-install", "weaver"],
    ["node_modules/.bin/weaver"], ["node_modules/.bin/weaver.cmd"],
    ["node", "node_modules/@pickbitsai/weaver/scripts/weaver.mjs"]
  ].map((prefix) => [...prefix, ...command.split(" ")]));
  patterns.push([["git", "git.exe"], [...GIT_WRITES]], [["git", "git.exe"], "branch", ["-D", "-d", "-m", "-M", "--delete", "--move"]],
    [["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd"], [...INSTALL_WRITES]]);
  return `# Weaver author guardrails. Project-scoped; restart Codex after installation.\n${patterns.map((pattern) => `prefix_rule(pattern=${JSON.stringify(pattern)}, decision="forbidden", justification="Leave book decisions, history, settings and tool installation to the author; use the Weaver author page.")`).join("\n")}\n`;
}

function installCodexHooks(root, { userRules = false, codexHome = process.env.CODEX_HOME || join(homedir(), ".codex") } = {}) {
  const path = join(root, ".codex", "hooks.json");
  const existed = existsSync(path);
  const settings = existed ? JSON.parse(readFileSync(path, "utf8")) : {};
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("invalid .codex/hooks.json: expected an object");
  const next = structuredClone(settings);
  next.hooks ||= {};
  for (const [event, matcher, command] of [
    ["PreToolUse", CODEX_HOOK_COMMANDS.matcher, CODEX_HOOK_COMMANDS.pre],
    ["PostToolUse", CODEX_HOOK_COMMANDS.matcher, CODEX_HOOK_COMMANDS.post],
    ["PreToolUse", CODEX_HOOK_COMMANDS.shellMatcher, CODEX_HOOK_COMMANDS.shell]
  ]) {
    next.hooks[event] ||= [];
    if (!next.hooks[event].some((entry) => isWeaverEntry(entry, command, matcher))) next.hooks[event].push(hookEntry(matcher, command));
  }
  let changed = JSON.stringify(next) !== JSON.stringify(settings);
  mkdirSync(join(root, ".codex", "rules"), { recursive: true });
  if (changed || !existed) writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  for (const directory of [join(root, ".codex"), ...(userRules ? [codexHome] : [])]) {
    const rulesPath = join(directory, "rules", "weaver.rules");
    const existing = existsSync(rulesPath) ? readFileSync(rulesPath, "utf8") : "";
    const missing = codexRules().split("\n").filter((line) => line && !existing.split(/\r?\n/u).includes(line));
    if (missing.length) {
      // Merge even when an author has put unrelated rules in our named file.
      mkdirSync(join(directory, "rules"), { recursive: true });
      writeFileSync(rulesPath, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
      changed = true;
    }
  }
  return { path, changed, created: !existed };
}

export function installHooks(root, { host = "both", ...options } = {}) {
  if (!["claude", "codex", "both"].includes(host)) throw new Error("Choose claude, codex or both for hook installation.");
  const results = [];
  if (host !== "codex") results.push({ host: "claude", ...installClaudeHooks(root) });
  if (host !== "claude") results.push({ host: "codex", ...installCodexHooks(root, options) });
  return { path: results[0].path, changed: results.some((result) => result.changed), hosts: results };
}

function hookScene(payload) {
  const cwd = hookBookRoot(payload);
  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== "string" || !filePath) return null;
  const absolute = resolve(payload?.cwd || cwd, filePath);
  const project = readProject(cwd);
  const sourceRoot = resolve(cwd, project.source_root);
  const relativePath = relative(sourceRoot, absolute).replaceAll("\\", "/");
  if (relativePath.startsWith("../") || isAbsolute(relativePath) || !/^chapter-\d+\/scene-\d+\/scene\.md$/u.test(relativePath)) return null;
  const sceneId = relativePath.match(/^chapter-(\d+)\/scene-(\d+)\/scene\.md$/u);
  return { cwd, project, absolute, sceneId: `${Number(sceneId[1])}-${Number(sceneId[2])}` };
}

function proposedSceneText(payload, current) {
  const input = payload.tool_input;
  if (payload.tool_name === "Write") return typeof input.content === "string" ? input.content : null;
  const edits = payload.tool_name === "MultiEdit" ? input.edits : [input];
  if (!Array.isArray(edits) || !edits.length) return null;
  let proposed = current;
  for (const edit of edits) {
    if (!edit || typeof edit.old_string !== "string" || !edit.old_string || typeof edit.new_string !== "string"
      || (edit.replace_all !== undefined && typeof edit.replace_all !== "boolean")) return null;
    if (!proposed.includes(edit.old_string)) return null;
    // A callback keeps $&, $' and other replacement markers literal.
    proposed = edit.replace_all
      ? proposed.replaceAll(edit.old_string, () => edit.new_string)
      : proposed.replace(edit.old_string, () => edit.new_string);
  }
  return proposed;
}

function preHook(payload, decide, compareRules) {
  const denial = decide(payload);
  if (denial) return denial;
  const scene = hookScene(payload);
  if (!scene) return null;
  const rules = loadRules(scene.cwd).rules;
  if (["Edit", "Write", "MultiEdit"].includes(payload.tool_name)) {
    const current = readFileSync(scene.absolute, "utf8");
    const proposed = proposedSceneText(payload, current);
    if (proposed === null) return null;
    const before = runRulesForScene(scene.cwd, scene.project, scene.sceneId, current);
    const after = runRulesForScene(scene.cwd, scene.project, scene.sceneId, proposed);
    const reason = compareRules(rules, before, after);
    if (reason) return deny(reason);
  }
  const editorialPath = join(scene.cwd, "quality", "editorial-rules.md");
  const editorial = existsSync(editorialPath) ? readFileSync(editorialPath, "utf8").trim() : "";
  const messages = rules.length ? `Rule messages: ${rules.map((rule) => rule.message).join("; ")}` : "Rule messages: none";
  const input = payload.tool_input || {};
  const oldWords = typeof input.old_string === "string" ? countWords(input.old_string) : null;
  const newWords = typeof input.new_string === "string" ? countWords(input.new_string) : null;
  const growth = oldWords !== null && newWords !== null ? newWords - oldWords : 0;
  const growthLine = payload.tool_name === "Edit" && growth > 0
    ? `\nNet word count: +${growth}. See R1/R2 before continuing.`
    : "";
  const additionalContext = `${editorial}${editorial && messages ? "\n\n" : ""}${messages}${growthLine}`;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext }, suppressOutput: true };
}

function findingText(finding) {
  return `${finding.rule_id} (paragraph ${finding.paragraph}): ${finding.excerpt} — ${finding.message}`;
}

function postHook(payload) {
  const scene = hookScene(payload);
  if (!scene) return null;
  const otherChapters = otherPendingChapters(scene.cwd, scene.project, Number(scene.sceneId.split("-")[0]));
  if (otherChapters.length) {
    const chapters = otherChapters.join(", ");
    return {
      decision: "block",
      reason: `Chapter ${chapters} has changes waiting for the author. Finish that chapter and ask the author to approve or reject it before editing chapter ${scene.sceneId.split("-")[0]}.`
    };
  }
  const result = runRules(scene.cwd, scene.project, { sceneIds: [scene.sceneId] });
  const voices = runVoiceCheck(scene.cwd, scene.project, { sceneIds: [scene.sceneId] });
  const warnings = [
      ...result.findings.filter((finding) => finding.severity === "warn").map(findingText),
      ...voices.findings.map((finding) => `voice warning (paragraph ${finding.paragraph}, ${finding.speaker}): ${finding.reason}${finding.reasons?.length ? `\nReasons:\n${finding.reasons.map((reason) => `  - ${reason}`).join("\n")}` : ""}\nLine: ${finding.line}\nTypical lines:\n${finding.evidence.map((line) => `  - ${line.text} [${line.scene_id}, paragraph ${line.paragraph}]`).join("\n")}${finding.maybe_sounds_like ? `\nMaybe sounds like ${finding.maybe_sounds_like.character}:\n${finding.maybe_sounds_like.evidence.map((line) => `  - ${line.text} [${line.scene_id}, paragraph ${line.paragraph}]`).join("\n")}` : ""}`)
  ].join("\n");
  const context = warnings ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: warnings } } : {};
  if (result.blocking) {
    const blocking = result.findings.filter((finding) => finding.severity === "block").map(findingText).join("\n");
    return { decision: "block", reason: `${blocking}\nfix these before continuing`, ...context };
  }
  return warnings ? context : null;
}

function codexEditHook(kind, payload, decideEdit, compareRules) {
  const files = parseCodexPatch(payload?.tool_input?.command);
  if (kind === "pre") {
    for (const file of files) {
      const denial = decideEdit({ ...payload, tool_input: { file_path: file.path } });
      if (denial) return denial;
    }
  }
  const contexts = [], feedback = [];
  for (const file of files) {
    if (file.kind === "Move" || (kind === "post" && file.kind === "Delete")) continue;
    const target = kind === "post" ? file.move || file.path : file.path;
    const normalized = { ...payload, tool_name: "Write", tool_input: { file_path: target } };
    let result;
    if (kind === "pre") {
      const path = resolve(payload?.cwd || process.cwd(), file.path);
      let current = "";
      try { current = readFileSync(path, "utf8"); } catch { if (file.kind !== "Add") continue; }
      const content = applyCodexHunks(current, file);
      if (content === null) continue;
      normalized.tool_input.content = content;
      result = preHook(normalized, () => null, compareRules);
    } else result = postHook(normalized);
    if (result?.hookSpecificOutput?.permissionDecision === "deny") return result;
    if (result?.decision === "block") feedback.push(result.reason);
    if (result?.hookSpecificOutput?.additionalContext) contexts.push(result.hookSpecificOutput.additionalContext);
  }
  if (feedback.length) return { decision: "block", reason: feedback.join("\n\n"), ...(contexts.length ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: contexts.join("\n\n") } } : {}) };
  return contexts.length ? { hookSpecificOutput: { hookEventName: kind === "pre" ? "PreToolUse" : "PostToolUse", additionalContext: [...new Set(contexts)].join("\n\n") } } : null;
}

export function runHook(kind, payload, { decideEdit = editGuard, decideShell = shellGuard, compareRules = blockingRuleRegression } = {}) {
  try {
    if (kind === "shell") return decideShell(payload);
    if (payload?.tool_name === "apply_patch" && ["pre", "post"].includes(kind)) return codexEditHook(kind, payload, decideEdit, compareRules);
    if (kind === "pre") return preHook(payload, decideEdit, compareRules);
    return kind === "post" ? postHook(payload) : null;
  } catch {
    // Malformed payloads and internal errors fail open; doctor reports damage.
    return null;
  }
}

export function scenePathForHook(root, project, sceneId) {
  const scene = loadScenes(root, project).find((candidate) => candidate.id === sceneId);
  return scene?.path || null;
}
