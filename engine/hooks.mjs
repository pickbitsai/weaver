// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { countWords, loadScenes } from "./manuscript.mjs";
import { readProject } from "./project.mjs";
import { loadRules, runRules } from "./rules.mjs";
import { otherPendingChapters } from "./changes.mjs";

const MATCHER = "Edit|Write|MultiEdit";
const PRE_COMMAND = "npx --no-install weaver hook pre";
const POST_COMMAND = "npx --no-install weaver hook post";

export const WEAVER_HOOK_COMMANDS = { pre: PRE_COMMAND, post: POST_COMMAND, matcher: MATCHER };

function hookEntry(matcher, command) {
  return { matcher, hooks: [{ type: "command", command }] };
}

function isWeaverEntry(entry, command) {
  return entry?.matcher === MATCHER && Array.isArray(entry.hooks) && entry.hooks.some((hook) => hook?.type === "command" && hook.command === command);
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
  let changed = false;
  if (!next.hooks.PreToolUse.some((entry) => isWeaverEntry(entry, PRE_COMMAND))) {
    next.hooks.PreToolUse.push(hookEntry(MATCHER, PRE_COMMAND));
    changed = true;
  }
  if (!next.hooks.PostToolUse.some((entry) => isWeaverEntry(entry, POST_COMMAND))) {
    next.hooks.PostToolUse.push(hookEntry(MATCHER, POST_COMMAND));
    changed = true;
  }
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

function preHook(payload) {
  const scene = hookScene(payload);
  if (!scene) return null;
  const rules = loadRules(scene.cwd).rules;
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
  if (result.blocking) {
    const blocking = result.findings.filter((finding) => finding.severity === "block").map(findingText).join("\n");
    return { decision: "block", reason: `${blocking}\nfix these before continuing` };
  }
  if (result.warnings) {
    const warnings = result.findings.filter((finding) => finding.severity === "warn").map(findingText).join("\n");
    return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: warnings } };
  }
  return null;
}

export function runHook(kind, payload) {
  return kind === "pre" ? preHook(payload) : postHook(payload);
}

export function scenePathForHook(root, project, sceneId) {
  const scene = loadScenes(root, project).find((candidate) => candidate.id === sceneId);
  return scene?.path || null;
}
