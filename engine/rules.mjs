// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadScenes, countWords, extractProse, scenePov } from "./manuscript.mjs";
import { readerText } from "./prose.mjs";
import { applyRulings } from "./rulings.mjs";
import { loadCharacters } from "./characters.mjs";
import { attributeSpans } from "./voice.mjs";

const RULES_PATH = join("quality", "rules.json");
const RULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SCOPES = new Set(["all", "narration", "dialogue"]);
const CHARACTER_SCOPES = ["speakers", "except_speakers", "pov", "except_pov"];
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

function validateRule(rule, index, ids, characterIds) {
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
  for (const key of CHARACTER_SCOPES) {
    if (rule[key] === undefined) continue;
    const label = `rule ${rule.id || index} ${key}`;
    if (!Array.isArray(rule[key]) || rule[key].some((id) => typeof id !== "string" || !RULE_ID.test(id))) {
      errors.push(`${label} must be a list of character ids`);
    } else {
      for (const id of rule[key]) if (!characterIds.has(id)) errors.push(`${label}: unknown character id ${id}`);
    }
  }
  if ((rule.speakers !== undefined || rule.except_speakers !== undefined) && rule.scope === "narration") {
    errors.push(`rule ${rule.id || index}: speakers and except_speakers cannot be used with scope narration`);
  }
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

export function validateRules(document, characters = []) {
  const errors = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) return ["rules file must contain an object"];
  if (document.version !== 1) errors.push("version must be 1");
  if (!Array.isArray(document.rules)) errors.push("rules must be an array");
  if (Array.isArray(document.rules)) {
    const ids = new Set();
    const characterIds = new Set(characters.map((character) => character.id));
    document.rules.forEach((rule, index) => errors.push(...validateRule(rule, index, ids, characterIds)));
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
  const errors = validateRules(document, loadCharacters(root).characters);
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

function effectiveScope(rule) {
  return rule.speakers !== undefined || rule.except_speakers !== undefined ? "dialogue" : rule.scope || "all";
}

export function ruleScopeDescription(rule, characters = []) {
  const names = (ids) => ids.map((id) => characters.find((character) => character.id === id)?.name || id).join(", ") || "no characters";
  const parts = [];
  if (rule.speakers) parts.push(`Applies to dialogue by ${names(rule.speakers)}`);
  else if (effectiveScope(rule) !== "all") parts.push(`Applies to ${effectiveScope(rule)}`);
  if (rule.except_speakers) parts.push(`Skips dialogue attributed to ${names(rule.except_speakers)}; unattributed dialogue is included`);
  if (rule.pov) parts.push(`Applies in ${names(rule.pov)}'s POV chapters`);
  if (rule.except_pov) parts.push(`Skips ${names(rule.except_pov)}'s POV chapters; scenes without a POV are included`);
  return parts.join(". ") || "Applies to all text";
}

function scopedText(paragraph, rule) {
  const scope = effectiveScope(rule);
  if (!scope || scope === "all") return [{ text: paragraph.text, start: 0, scope: "all" }];
  return paragraph.segments.filter((segment) => segment.scope === scope &&
    (!rule.speakers || (segment.speaker && rule.speakers.includes(segment.speaker))) &&
    (!rule.except_speakers || !segment.speaker || !rule.except_speakers.includes(segment.speaker)));
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
  scene = paragraph.scene || scene;
  const value = paragraph.text;
  const inParagraph = Math.max(0, Math.min(value.length - 1, index));
  return {
    rule_id: rule.id,
    severity: rule.severity,
    scene_id: scene.id,
    chapter: scene.chapter,
    paragraph: paragraph.number,
    excerpt: excerpt(value, inParagraph, length),
    sentence: splitSentences(value).find((sentence) => inParagraph >= sentence.start && inParagraph < sentence.start + sentence.text.length)?.text || value,
    matched_text: value.slice(inParagraph, inParagraph + length),
    message: rule.scope_reason ? `${rule.message} ${rule.scope_reason}.` : rule.message,
    ...(rule.scope_reason ? { scope: effectiveScope(rule), scope_reason: rule.scope_reason,
      ...Object.fromEntries(CHARACTER_SCOPES.filter((key) => rule[key] !== undefined).map((key) => [key, rule[key]])) } : {}),
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
      records.push({ ...sentence, paragraph, start: sentence.start + segment.start, scope: segment.scope });
    }
  }
  return records.sort((a, b) => a.start - b.start);
}

function countedLocations(matches) {
  const locations = new Map();
  for (const { paragraph } of matches) {
    const key = `${paragraph.scene.id}:${paragraph.number}`;
    if (!locations.has(key)) locations.set(key, { scene_id: paragraph.scene.id, paragraph: paragraph.number, count: 0 });
    locations.get(key).count++;
  }
  return [...locations.values()];
}

function evaluateRule(rule, scene, paragraphs, unitParagraphs, measurements) {
  const findings = [];
  const scope = rule;
  const measured = (finding, value, exceeded) => {
    // Keep below-limit counts too, so a pre-edit comparison can report the
    // actual starting count, even after the last occurrence is removed.
    measurements?.push({ ...finding, value, exceeded });
    if (exceeded) findings.push(finding);
  };
  if (rule.type === "count-per-words") {
    const groups = rule.unit === "scene" ? [[scene, paragraphs]] : [[scene, unitParagraphs]];
    for (const [, groupParagraphs] of groups) {
      const parts = groupParagraphs.flatMap((paragraph) => scopedText(paragraph, scope).map((segment) => ({ paragraph, segment })));
      const words = parts.reduce((sum, part) => sum + countWords(part.segment.text), 0);
      const matches = parts.flatMap((part) => occurrences(part.segment.text, rule.text).map((match) => ({ ...match, index: match.index + part.segment.start, paragraph: part.paragraph })));
      const count = matches.length;
      if (groupParagraphs.length) {
        const match = matches[0] || { paragraph: groupParagraphs[0], index: 0, length: 0 };
        const value = words > 0 ? count * rule.per_words / words : 0;
        const countLimit = Math.floor(rule.max * words / rule.per_words);
        const label = rule.text === "—" ? "em dashes" : `occurrences of ${JSON.stringify(rule.text)}`;
        measured(makeFinding(rule, scene, match.paragraph, match.index, match.length, { count, limit: rule.max,
          measurement: { unit: rule.unit, value, limit: rule.max, count_limit: countLimit, words, per_words: rule.per_words },
          locations: countedLocations(matches),
          goal: `${rule.unit} has ${count} ${label} in ${effectiveScope(rule) === "all" ? "all text" : effectiveScope(rule)}, limit ${countLimit} for its length (${words} words); remove at least ${Math.max(0, count - countLimit)}.` }),
          value,
          words > 0 && count * rule.per_words > rule.max * words && count > 0);
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
      const match = firstMatchInParagraph(paragraph, matches);
      measured(makeFinding(rule, scene, paragraph, match.index, match.length, { count: matches.length, limit: rule.max }),
        matches.length, matches.length > rule.max);
    }
  } else if (rule.type === "sentence-start-share") {
    const records = rule.unit === "paragraph"
      ? paragraphs.flatMap((paragraph) => [{ paragraph, records: sentenceRecords(paragraph, scope) }])
      : [{ paragraph: paragraphs[0], records: paragraphs.flatMap((paragraph) => sentenceRecords(paragraph, scope)) }];
    for (const group of records) {
      const paragraph = group.records[0]?.paragraph || group.paragraph || paragraphs[0];
      if (!paragraph) continue;
      const matches = group.records.filter((sentence) => sentenceStart(sentence.text).toLocaleLowerCase() === rule.word.toLocaleLowerCase());
      const wanted = matches.length;
      const share = group.records.length ? wanted / group.records.length : 0;
      const countLimit = Math.floor(rule.max_share * group.records.length);
      measured(makeFinding(rule, scene, paragraph, group.records[0]?.start || 0, 0, { count: wanted, limit: rule.max_share,
        ...(rule.unit === "scene" ? {
          measurement: { unit: rule.unit, value: share, limit: rule.max_share, count_limit: countLimit, sentences: group.records.length },
          locations: countedLocations(matches),
          goal: `scene has ${wanted} sentences starting with ${JSON.stringify(rule.word)} in ${effectiveScope(rule) === "all" ? "all text" : effectiveScope(rule)} out of ${group.records.length} sentences, limit ${countLimit} (${rule.max_share * 100}%); change at least ${Math.max(0, wanted - countLimit)} openings, keeping the same sentence total.`
        } : {}) }),
        share, group.records.length >= rule.min_sentences && share > rule.max_share);
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
        if (word) {
          measured(makeFinding(rule, scene, paragraph, records[runStart].start, 0, { count: run, limit: rule.max_run }),
            run, run > rule.max_run);
        }
        runStart = end;
      }
    }
  }
  return findings;
}

function prepareScene(scene, characters) {
  const paragraphs = [];
  const attributed = attributeSpans(scene, characters);
  let continuingDialogue = false;
  for (const proseParagraph of scene.prose.split(/\n\s*\n/u).filter((value) => value.trim())) {
    const classified = paragraphScopes(proseParagraph, continuingDialogue);
    const number = paragraphs.length + 1;
    const lines = attributed.filter((line) => line.paragraph === number && line.text.length);
    let index = 0;
    for (const segment of classified.segments) {
      if (segment.scope !== "dialogue") continue;
      const line = lines[index++];
      segment.speaker = line?.text === segment.text && line.method !== "unattributed" ? line.speaker : null;
    }
    paragraphs.push({ number, scene, text: classified.text, segments: classified.segments });
    continuingDialogue = classified.continues;
  }
  return paragraphs.filter((paragraph) => paragraph.text.trim());
}

export function runRulesOnScenes(root, project, allScenes, { sceneIds = null, includeMeasurements = false } = {}) {
  const document = loadRules(root);
  const characters = loadCharacters(root).characters;
  const rules = document.rules.map((rule) => ({ ...rule,
    ...((rule.scope && rule.scope !== "all") || CHARACTER_SCOPES.some((key) => rule[key] !== undefined)
      ? { scope_reason: ruleScopeDescription(rule, characters) } : {}) }));
  const povId = (scene) => {
    const value = scene.pov?.toLocaleLowerCase();
    const matches = characters.filter((character) => [character.id, character.name, ...character.aliases].some((name) => name.toLocaleLowerCase() === value));
    return matches.length === 1 ? matches[0].id : null;
  };
  const inPov = (scene, rule) => (!rule.pov || rule.pov.includes(povId(scene))) && (!rule.except_pov || !rule.except_pov.includes(povId(scene)));
  const wanted = sceneIds ? new Set(sceneIds.map(String)) : null;
  const scenes = wanted ? allScenes.filter((scene) => wanted.has(scene.id)) : allScenes;
  const prepared = new Map(scenes.map((scene) => [scene.id, prepareScene(scene, characters)]));
  const findings = [];
  const measurements = includeMeasurements ? [] : null;
  const chapterRulesEvaluated = new Set();
  for (const scene of scenes) {
    const paragraphs = prepared.get(scene.id);
    for (const rule of rules) {
      if (!inPov(scene, rule)) continue;
      if (rule.type === "count-per-words" && rule.unit === "chapter") {
        const chapterKey = `${scene.chapter}:${rule.id}`;
        if (chapterRulesEvaluated.has(chapterKey)) continue;
        chapterRulesEvaluated.add(chapterKey);
      }
      let unitParagraphs = paragraphs;
      if (rule.type === "count-per-words" && rule.unit === "chapter") {
        unitParagraphs = scenes.filter((candidate) => candidate.chapter === scene.chapter && inPov(candidate, rule)).flatMap((candidate) => prepared.get(candidate.id));
      }
      findings.push(...evaluateRule(rule, scene, paragraphs, unitParagraphs, measurements));
    }
  }
  const rulingOptions = { kind: "rule", sourceOf: (finding) => finding.rule_id, quoteOf: (finding) => finding.excerpt, scenes: allScenes };
  const filtered = applyRulings(root, project, findings, rulingOptions);
  const blocking = filtered.findings.filter((finding) => finding.severity === "block").length;
  const warnings = filtered.findings.filter((finding) => finding.severity === "warn").length;
  return {
    ok: blocking === 0, findings: filtered.findings, blocking, warnings,
    allowed_blocking: filtered.allowed_blocking, rules_checked: document.rules.length,
    rules: document.rules.map((rule) => ({ ...rule, scope: effectiveScope(rule), scope_description: ruleScopeDescription(rule, characters) })),
    ...(includeMeasurements ? { measurements: applyRulings(root, project, measurements, rulingOptions).findings } : {})
  };
}

export function runRules(root, project, options = {}) {
  return runRulesOnScenes(root, project, loadScenes(root, project), options);
}

export function runRulesForScene(root, project, sceneId, text) {
  const [chapter, scene] = sceneId.split("-").map(Number);
  const prose = extractProse(text, `scene ${sceneId}`);
  // Like runRules({ sceneIds: [sceneId] }), chapter rules see only this scene.
  // Passing it to applyRulings also hashes the proposed passage, not disk text.
  return runRulesOnScenes(root, project, [{ id: sceneId, chapter, scene, prose, pov: scenePov(text) }], { includeMeasurements: true });
}

export function rulesPath() {
  return RULES_PATH;
}
