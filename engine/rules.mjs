// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadScenes, countWords } from "./manuscript.mjs";
import { readerText } from "./prose.mjs";
import { applyRulings } from "./rulings.mjs";

const RULES_PATH = join("quality", "rules.json");
const RULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SCOPES = new Set(["all", "narration", "dialogue"]);
const TYPES = new Set([
  "count-per-words",
  "phrase-list",
  "sentence-start-share",
  "repeated-sentence-starts",
  "max-per-paragraph",
  "regex"
]);

function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function requireString(rule, key, errors) {
  if (typeof rule[key] !== "string" || !rule[key]) errors.push(`${key} must be a non-empty string`);
}

function validateRule(rule, index, ids) {
  const errors = [];
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    return [`rules[${index}] must be an object`];
  }
  if (typeof rule.id !== "string" || !RULE_ID.test(rule.id)) errors.push(`rules[${index}].id must be kebab-case`);
  else if (ids.has(rule.id)) errors.push(`rules[${index}].id must be unique`);
  else ids.add(rule.id);
  if (!TYPES.has(rule.type)) errors.push(`rules[${index}].type is unsupported`);
  if (!["block", "warn"].includes(rule.severity)) errors.push(`rules[${index}].severity must be block or warn`);
  requireString(rule, "message", errors);
  if (rule.scope !== undefined && !SCOPES.has(rule.scope)) errors.push(`rules[${index}].scope must be all, narration, or dialogue`);
  if (rule.type === "count-per-words") {
    requireString(rule, "text", errors);
    if (typeof rule.max !== "number" || !Number.isFinite(rule.max) || rule.max < 0) errors.push(`rules[${index}].max must be a non-negative number`);
    if (!positiveNumber(rule.per_words)) errors.push(`rules[${index}].per_words must be a positive number`);
    if (!["scene", "chapter"].includes(rule.unit)) errors.push(`rules[${index}].unit must be scene or chapter`);
  } else if (rule.type === "phrase-list") {
    if (!Array.isArray(rule.phrases) || !rule.phrases.length || rule.phrases.some((phrase) => typeof phrase !== "string" || !phrase)) {
      errors.push(`rules[${index}].phrases must be a non-empty string array`);
    }
    if (rule.case_sensitive !== undefined && typeof rule.case_sensitive !== "boolean") errors.push(`rules[${index}].case_sensitive must be boolean`);
  } else if (rule.type === "sentence-start-share") {
    requireString(rule, "word", errors);
    if (typeof rule.max_share !== "number" || !Number.isFinite(rule.max_share) || rule.max_share < 0 || rule.max_share > 1) errors.push(`rules[${index}].max_share must be between 0 and 1`);
    if (!Number.isInteger(rule.min_sentences) || rule.min_sentences < 1) errors.push(`rules[${index}].min_sentences must be a positive integer`);
    if (!["paragraph", "scene"].includes(rule.unit)) errors.push(`rules[${index}].unit must be paragraph or scene`);
  } else if (rule.type === "repeated-sentence-starts") {
    if (!Number.isInteger(rule.max_run) || rule.max_run < 1) errors.push(`rules[${index}].max_run must be a positive integer`);
  } else if (rule.type === "max-per-paragraph") {
    requireString(rule, "text", errors);
    if (!nonNegativeInteger(rule.max)) errors.push(`rules[${index}].max must be a non-negative integer`);
  } else if (rule.type === "regex") {
    requireString(rule, "pattern", errors);
    if (rule.flags !== undefined && typeof rule.flags !== "string") errors.push(`rules[${index}].flags must be a string`);
    if (typeof rule.pattern === "string") {
      try {
        // Validate exactly what the author supplied, including flags.
        new RegExp(rule.pattern, rule.flags || "");
      } catch (error) {
        errors.push(`rules[${index}] has an invalid regex: ${error.message}`);
      }
    }
  }
  return errors;
}

export function validateRules(document) {
  const errors = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) return ["rules file must contain an object"];
  if (document.version !== 1) errors.push("version must be 1");
  if (!Array.isArray(document.rules)) errors.push("rules must be an array");
  if (Array.isArray(document.rules)) {
    const ids = new Set();
    document.rules.forEach((rule, index) => errors.push(...validateRule(rule, index, ids)));
  }
  return errors;
}

export function loadRules(root) {
  const path = join(root, RULES_PATH);
  if (!existsSync(path)) return { version: 1, rules: [] };
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid ${RULES_PATH}: ${error.message}`);
  }
  const errors = validateRules(document);
  if (errors.length) throw new Error(`invalid ${RULES_PATH}:\n- ${errors.join("\n- ")}`);
  return document;
}

function normaliseApostrophes(value) {
  return value.replaceAll("’", "'");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function phrasePattern(phrase, caseSensitive) {
  const escaped = escapeRegex(normaliseApostrophes(phrase)).replaceAll("'", "['’]");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, `${caseSensitive ? "" : "i"}gu`);
}

function excerpt(text, index, length = 0) {
  const start = Math.max(0, index - 48);
  const end = Math.min(text.length, Math.max(index + length + 48, start + 120));
  let value = text.slice(start, end).replace(/\s+/gu, " ").trim();
  if (value.length > 120) value = value.slice(0, 117).trimEnd() + "...";
  return value;
}

function occurrences(text, needle) {
  const found = [];
  if (!needle) return found;
  let index = 0;
  while ((index = text.indexOf(needle, index)) >= 0) {
    found.push({ index, length: needle.length });
    index += Math.max(needle.length, 1);
  }
  return found;
}

function regexOccurrences(text, pattern, flags) {
  const effectiveFlags = flags?.includes("g") ? flags : `${flags || ""}g`;
  const regex = new RegExp(pattern, effectiveFlags);
  return [...text.matchAll(regex)].map((match) => ({ index: match.index, length: match[0].length }));
}

function paragraphScopes(value, continuingDialogue = false) {
  const text = readerText(value);
  const segments = [];
  let start = 0;
  let dialogue = false;
  let index = 0;
  if (continuingDialogue && /^[\t ]*[“"]/u.test(text)) {
    const opening = text.search(/[“"]/u);
    if (opening > 0) segments.push({ text: text.slice(0, opening), scope: "narration", start: 0 });
    start = opening + 1;
    dialogue = true;
    index = start;
  }
  const push = (end, scope) => {
    if (end > start) segments.push({ text: text.slice(start, end), scope, start });
  };
  while (index < text.length) {
    const character = text[index];
    const isOpening = character === "“" || character === "\"";
    const isClosing = character === "”" || character === "\"";
    if (!dialogue && isOpening) {
      push(index, "narration");
      dialogue = true;
      start = index + 1;
    } else if (dialogue && isClosing) {
      push(index, "dialogue");
      dialogue = false;
      start = index + 1;
    }
    index += 1;
  }
  push(text.length, dialogue ? "dialogue" : "narration");
  return { text, segments, continues: dialogue };
}

function scopedText(paragraph, scope) {
  if (!scope || scope === "all") return [{ text: paragraph.text, start: 0, scope: "all" }];
  return paragraph.segments.filter((segment) => segment.scope === scope);
}

function splitSentences(text) {
  const sentences = [];
  let start = 0;
  const boundary = /[.!?…]+(?:[”"])?(?=\s|$)/gu;
  let match;
  while ((match = boundary.exec(text))) {
    const end = match.index + match[0].length;
    const value = text.slice(start, end).trim();
    if (value) sentences.push({ text: value, start: start + text.slice(start, end).search(/\S/u) });
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail) sentences.push({ text: tail, start: start + text.slice(start).search(/\S/u) });
  return sentences;
}

function sentenceStart(sentence) {
  return sentence.match(/^[^\p{L}\p{N}]*(\p{L}|\p{N})(?:[\p{L}\p{N}]|['’](?=[\p{L}\p{N}]))*/u)?.[0]
    ?.replace(/^[^\p{L}\p{N}]+/u, "") || "";
}

function makeFinding(rule, scene, paragraph, index, length, extra = {}) {
  const value = paragraph.text;
  const inParagraph = Math.max(0, Math.min(value.length - 1, index));
  return {
    rule_id: rule.id,
    severity: rule.severity,
    scene_id: scene.id,
    chapter: scene.chapter,
    paragraph: paragraph.number,
    excerpt: excerpt(value, inParagraph, length),
    message: rule.message,
    ...extra
  };
}

function firstMatchInParagraph(paragraph, matches) {
  const match = matches[0] || { index: 0, length: 0 };
  return { index: match.index, length: match.length };
}

function sentenceRecords(paragraph, scope) {
  const records = [];
  for (const segment of scopedText(paragraph, scope)) {
    for (const sentence of splitSentences(segment.text)) {
      records.push({ ...sentence, start: sentence.start + segment.start, scope: segment.scope });
    }
  }
  return records.sort((a, b) => a.start - b.start);
}

function evaluateRule(rule, scene, paragraphs, unitParagraphs) {
  const findings = [];
  const scope = rule.scope || "all";
  if (rule.type === "count-per-words") {
    const groups = rule.unit === "scene" ? [[scene, paragraphs]] : [[scene, unitParagraphs]];
    for (const [, groupParagraphs] of groups) {
      const parts = groupParagraphs.flatMap((paragraph) => scopedText(paragraph, scope).map((segment) => ({ paragraph, segment })));
      const words = parts.reduce((sum, part) => sum + countWords(part.segment.text), 0);
      const matches = parts.flatMap((part) => occurrences(part.segment.text, rule.text).map((match) => ({ ...match, paragraph: part.paragraph })));
      const count = matches.length;
      if (words > 0 && count * rule.per_words > rule.max * words && count > 0) {
        const match = matches[0];
        findings.push(makeFinding(rule, scene, match.paragraph, match.index, match.length, { count, limit: rule.max }));
      }
    }
  } else if (rule.type === "phrase-list") {
    for (const paragraph of paragraphs) {
      for (const segment of scopedText(paragraph, scope)) {
        for (const phrase of rule.phrases) {
          const matches = [...segment.text.matchAll(phrasePattern(phrase, rule.case_sensitive))];
          for (const match of matches) findings.push(makeFinding(rule, scene, paragraph, segment.start + match.index, match[0].length));
        }
      }
    }
  } else if (rule.type === "regex") {
    for (const paragraph of paragraphs) {
      for (const segment of scopedText(paragraph, scope)) {
        for (const match of regexOccurrences(segment.text, rule.pattern, rule.flags)) {
          findings.push(makeFinding(rule, scene, paragraph, segment.start + match.index, match.length));
        }
      }
    }
  } else if (rule.type === "max-per-paragraph") {
    for (const paragraph of paragraphs) {
      const parts = scopedText(paragraph, scope);
      const matches = parts.flatMap((part) => occurrences(part.text, rule.text).map((match) => ({ ...match, index: match.index + part.start })));
      if (matches.length > rule.max) {
        const match = firstMatchInParagraph(paragraph, matches);
        findings.push(makeFinding(rule, scene, paragraph, match.index, match.length, { count: matches.length, limit: rule.max }));
      }
    }
  } else if (rule.type === "sentence-start-share") {
    const records = rule.unit === "paragraph"
      ? paragraphs.flatMap((paragraph) => [{ paragraph, records: sentenceRecords(paragraph, scope) }])
      : [{ paragraph: paragraphs[0], records: paragraphs.flatMap((paragraph) => sentenceRecords(paragraph, scope)) }];
    for (const group of records) {
      if (group.records.length < rule.min_sentences) continue;
      const wanted = group.records.filter((sentence) => sentenceStart(sentence.text).toLocaleLowerCase() === rule.word.toLocaleLowerCase()).length;
      if (wanted / group.records.length > rule.max_share) {
        const paragraph = group.paragraph || paragraphs[0];
        findings.push(makeFinding(rule, scene, paragraph, group.records[0]?.start || 0, 0, { count: wanted, limit: rule.max_share }));
      }
    }
  } else if (rule.type === "repeated-sentence-starts") {
    for (const paragraph of paragraphs) {
      const records = sentenceRecords(paragraph, scope);
      let runStart = 0;
      while (runStart < records.length) {
        const word = sentenceStart(records[runStart].text).toLocaleLowerCase();
        let end = runStart + 1;
        while (end < records.length && sentenceStart(records[end].text).toLocaleLowerCase() === word) end += 1;
        const run = end - runStart;
        if (word && run > rule.max_run) {
          findings.push(makeFinding(rule, scene, paragraph, records[runStart].start, 0, { count: run, limit: rule.max_run }));
        }
        runStart = end;
      }
    }
  }
  return findings;
}

function prepareScene(scene) {
  const paragraphs = [];
  let continuingDialogue = false;
  for (const proseParagraph of scene.prose.split(/\n\s*\n/u)) {
    const classified = paragraphScopes(proseParagraph, continuingDialogue);
    paragraphs.push({ number: paragraphs.length + 1, text: classified.text, segments: classified.segments });
    continuingDialogue = classified.continues;
  }
  return paragraphs.filter((paragraph) => paragraph.text.trim());
}

export function runRules(root, project, { sceneIds = null } = {}) {
  const document = loadRules(root);
  const allScenes = loadScenes(root, project);
  const wanted = sceneIds ? new Set(sceneIds.map(String)) : null;
  const scenes = wanted ? allScenes.filter((scene) => wanted.has(scene.id)) : allScenes;
  const prepared = new Map(scenes.map((scene) => [scene.id, prepareScene(scene)]));
  const findings = [];
  const chapterRulesEvaluated = new Set();
  for (const scene of scenes) {
    const paragraphs = prepared.get(scene.id);
    for (const rule of document.rules) {
      if (rule.type === "count-per-words" && rule.unit === "chapter") {
        const chapterKey = `${scene.chapter}:${rule.id}`;
        if (chapterRulesEvaluated.has(chapterKey)) continue;
        chapterRulesEvaluated.add(chapterKey);
      }
      let unitParagraphs = paragraphs;
      if (rule.type === "count-per-words" && rule.unit === "chapter") {
        unitParagraphs = scenes.filter((candidate) => candidate.chapter === scene.chapter).flatMap((candidate) => prepared.get(candidate.id));
      }
      findings.push(...evaluateRule(rule, scene, paragraphs, unitParagraphs));
    }
  }
  const filtered = applyRulings(root, project, findings, { kind: "rule", sourceOf: (finding) => finding.rule_id, quoteOf: (finding) => finding.excerpt, scenes: allScenes });
  const blocking = filtered.findings.filter((finding) => finding.severity === "block").length;
  const warnings = filtered.findings.filter((finding) => finding.severity === "warn").length;
  return { ok: blocking === 0, findings: filtered.findings, blocking, warnings, allowed_blocking: filtered.allowed_blocking, rules_checked: document.rules.length };
}

export function rulesPath() {
  return RULES_PATH;
}
