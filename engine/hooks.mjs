// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { countWords, loadScenes } from "./manuscript.mjs";
import { readProject } from "./project.mjs";
import { loadRules, runRules, runRulesForScene } from "./rules.mjs";
import { otherPendingChapters } from "./changes.mjs";
import { runVoiceCheck } from "./voice.mjs";
import { deny, editGuard, shellGuard, WEAVER_DENY_RULES } from "./guard.mjs";

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
  return entry?.matcher === matcher && Array.isArray(entry.hooks) && entry.hooks.some((hook) => hook?.type === "command" && hook.command === command);
}

export function installHooks(root) {
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

function hookScene(payload) {
  const cwd = resolve(payload?.cwd || process.cwd());
  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== "string" || !filePath) return null;
  const absolute = resolve(cwd, filePath);
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

const numberText = (value) => value.toLocaleString("en-US", { maximumFractionDigits: 6 });

function measurementChange(rule, before, after) {
  let detail = `the count from ${before?.count ?? 0} to ${after.count}`;
  if (rule.type === "count-per-words") {
    detail += ` (rate from ${numberText(before?.value ?? 0)} to ${numberText(after.value)} per ${numberText(rule.per_words)} words; limit ${numberText(rule.max)} per ${numberText(rule.per_words)} words)`;
  } else if (rule.type === "sentence-start-share") {
    detail += ` (sentence share from ${numberText((before?.value ?? 0) * 100)}% to ${numberText(after.value * 100)}%; limit ${numberText(rule.max_share * 100)}%)`;
  } else {
    detail += ` (limit ${after.limit})`;
  }
  return detail;
}

function blockingRuleRegression(rules, before, after) {
  for (const rule of rules.filter((rule) => rule.severity === "block")) {
    const previous = before.findings.filter((finding) => finding.rule_id === rule.id);
    const proposed = after.findings.filter((finding) => finding.rule_id === rule.id);
    if (!proposed.length) continue;
    // Rank measured units by severity so inserting a paragraph cannot turn an
    // unchanged finding into a regression just by moving its paragraph number.
    // Compare each rank, not just the maximum or total. Findings come first:
    // a short paragraph below min_sentences must not mask a worsening finding.
    const measurements = (result) => result.measurements.filter((item) => item.rule_id === rule.id)
      .sort((a, b) => Number(b.exceeded) - Number(a.exceeded) || b.value - a.value);
    const oldMeasurements = measurements(before);
    const newMeasurements = measurements(after).filter((item) => item.exceeded);
    const increased = newMeasurements.findIndex((item, index) => item.value > (oldMeasurements[index]?.value ?? 0));
    const change = increased >= 0
      ? measurementChange(rule, oldMeasurements[increased], newMeasurements[increased])
      : proposed.length > previous.length ? `blocking findings from ${previous.length} to ${proposed.length}` : null;
    if (change) return `${rule.id}: ${rule.message} This edit would change ${change}. Blocking rules can't be waived by the AI; if this is intended, ask the author to rule on it.`;
  }
  return null;
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
  if (result.blocking) {
    const blocking = result.findings.filter((finding) => finding.severity === "block").map(findingText).join("\n");
    return { decision: "block", reason: `${blocking}\nfix these before continuing` };
  }
  if (result.warnings || voices.warnings) {
    const warnings = [
      ...result.findings.filter((finding) => finding.severity === "warn").map(findingText),
      ...voices.findings.map((finding) => `voice warning (paragraph ${finding.paragraph}, ${finding.speaker}): ${finding.reason}${finding.reasons?.length ? `\nReasons:\n${finding.reasons.map((reason) => `  - ${reason}`).join("\n")}` : ""}\nLine: ${finding.line}\nTypical lines:\n${finding.evidence.map((line) => `  - ${line.text} [${line.scene_id}, paragraph ${line.paragraph}]`).join("\n")}${finding.maybe_sounds_like ? `\nMaybe sounds like ${finding.maybe_sounds_like.character}:\n${finding.maybe_sounds_like.evidence.map((line) => `  - ${line.text} [${line.scene_id}, paragraph ${line.paragraph}]`).join("\n")}` : ""}`)
    ].join("\n");
    return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: warnings } };
  }
  return null;
}

export function runHook(kind, payload, { decideEdit = editGuard, decideShell = shellGuard, compareRules = blockingRuleRegression } = {}) {
  try {
    if (kind === "shell") return decideShell(payload);
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
