// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { countWords, extractProse, loadScenes, manuscriptHash, sha256 } from "./manuscript.mjs";
import { readerText } from "./prose.mjs";
import { loadCharacters } from "./characters.mjs";

const VOICES_ROOT = join("world-bible", "voices");
const PROFILE_VERSION = 2;
export const EVIDENCE_MINIMUM = { lines: 8, words: 80 };
export const VOICE_DISTANCE_THRESHOLD = 4;
export const SOUNDS_LIKE_MARGIN = 1;

const BUILTIN_PROFANITY = ["damn", "damned", "hell", "bloody", "shit", "fuck", "bastard", "arse", "piss", "crap", "bugger"];
const BUILTIN_FORMAL = ["shall", "indeed", "perhaps", "whom", "pray", "madam", "sir", "one must", "I daresay"];
const STOPWORDS = new Set(`a an and are as at be been but by can could did do does for from had has have he her hers him his how i if in is it its just me might more most my no not of on one or our ours she should so some than that the their theirs them then there these they this to too us was we were what when which who will with would you your yours`.split(" "));
const VERBS = new Set([
  "said", "asked", "replied", "answered", "shouted", "yelled", "whispered", "muttered", "snapped", "called",
  "growled", "murmured", "added", "continued", "demanded", "cried", "sneered", "laughed", "sighed", "told",
  "says", "asks", "replies", "answers", "shouts", "yells", "whispers", "mutters", "snaps", "calls", "growls",
  "murmurs", "adds", "continues", "demands", "cries", "sneers", "laughs", "sighs", "tells"
]);
const FEATURE_KEYS = [
  "words_per_sentence",
  "contractions_per_100_words",
  "profanity_per_100_words",
  "exclamation_share",
  "question_share",
  "formal_markers_per_100_words"
];

function voiceSettings(root) {
  const path = join(root, "quality", "voice.json");
  if (!existsSync(path)) return { profanity: [], formal: [] };
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid quality/voice.json: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid quality/voice.json: expected an object");
  for (const key of ["profanity", "formal"]) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string" || !item.trim()))) {
      throw new Error(`invalid quality/voice.json: ${key} must be a string array`);
    }
  }
  return { profanity: value.profanity || [], formal: value.formal || [] };
}

function git(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function approvedManuscript(root, project) {
  const head = git(root, ["rev-parse", "--verify", "HEAD"]);
  if (head.status !== 0) {
    const scenes = loadScenes(root, project);
    return { scenes, head_commit: null, manuscript_sha256: manuscriptHash(scenes) };
  }
  const headCommit = head.stdout.trim();
  const sourceRoot = project.source_root.replaceAll("\\", "/").replace(/\/$/u, "");
  const tree = git(root, ["ls-tree", "-r", "--name-only", headCommit, "--", sourceRoot]);
  if (tree.status !== 0) throw new Error("could not read the approved manuscript from Git");
  const paths = tree.stdout.split(/\r?\n/u).filter((path) => new RegExp(`^${escapeRegex(sourceRoot)}/chapter-\\d+/scene-\\d+/scene\\.md$`, "u").test(path));
  const scenes = paths.map((relativePath) => {
    const match = new RegExp(`^${escapeRegex(sourceRoot)}/chapter-(\\d+)/scene-(\\d+)/scene\\.md$`, "u").exec(relativePath);
    const raw = git(root, ["show", `${headCommit}:${relativePath}`]);
    if (raw.status !== 0) throw new Error(`could not read approved scene ${relativePath} from Git`);
    const prose = extractProse(raw.stdout, relativePath);
    return {
      chapter: Number(match[1]),
      scene: Number(match[2]),
      id: `${Number(match[1])}-${Number(match[2])}`,
      path: join(root, relativePath),
      relativePath,
      prose,
      words: countWords(prose),
      hash: sha256(prose)
    };
  });
  return { scenes, head_commit: headCommit, manuscript_sha256: manuscriptHash(scenes) };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function markerRegex(marker) {
  const escaped = escapeRegex(marker.trim()).replaceAll("'", "['’]");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu");
}

function markerCount(text, markers) {
  return markers.reduce((sum, marker) => sum + [...text.matchAll(markerRegex(marker))].length, 0);
}

function profanityCount(text, words) {
  return words.reduce((sum, word) => {
    const normalized = word.trim().toLocaleLowerCase();
    if (!normalized) return sum;
    const pattern = normalized.includes(" ")
      ? markerRegex(normalized)
      : new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(normalized)}[\\p{L}\\p{N}_]*(?![\\p{L}\\p{N}_])`, "giu");
    return sum + [...text.matchAll(pattern)].length;
  }, 0);
}

function sentenceCount(text) {
  const count = [...text.matchAll(/[.!?]+(?:[”"])?(?=\s|$)/gu)].length;
  return count || (text.trim() ? 1 : 0);
}

export function lineFeatures(text, settings = { profanity: [], formal: [] }) {
  const value = String(text);
  const words = countWords(value);
  const sentences = sentenceCount(value);
  const contractions = [...value.matchAll(/\b[\p{L}\p{N}]+['’][\p{L}\p{N}]+\b/gu)].length;
  const profanity = profanityCount(value, [...BUILTIN_PROFANITY, ...settings.profanity]);
  const formal = markerCount(value, [...BUILTIN_FORMAL, ...settings.formal]);
  const exclamations = [...value.matchAll(/!/gu)].length;
  const questions = [...value.matchAll(/\?/gu)].length;
  return {
    words_per_sentence: sentences ? words / sentences : 0,
    contractions_per_100_words: words ? contractions * 100 / words : 0,
    profanity_per_100_words: words ? profanity * 100 / words : 0,
    exclamation_share: sentences ? exclamations / sentences : 0,
    question_share: sentences ? questions / sentences : 0,
    formal_markers_per_100_words: words ? formal * 100 / words : 0,
    words,
    sentences,
    contractions,
    profanity,
    formal_markers: formal,
    questions,
    exclamations
  };
}

function quoteOpening(character) {
  return character === "“" || character === '"';
}

function quoteClosing(character, opening) {
  return opening === "“" ? character === "”" : character === '"';
}

function quoteSpans(paragraphs) {
  const output = [];
  let continuation = null;
  for (const paragraph of paragraphs) {
    const text = paragraph.text;
    const spans = [];
    let cursor = 0;
    if (continuation) {
      const opening = text.match(/^[\t ]*([“"])/u);
      if (!opening) {
        continuation = null;
      } else {
        const start = opening[0].length;
        const close = [...text.slice(start)].findIndex((character) => quoteClosing(character, opening[1]));
        const end = close < 0 ? text.length : start + close;
        spans.push({ text: text.slice(start, end), start, end, continuation: true, speaker: continuation.speaker });
        if (close < 0) {
          continuation = { speaker: continuation.speaker };
          output.push(...spans.map((span) => ({ ...span, paragraph: paragraph.number })));
          continue;
        }
        continuation = null;
        cursor = end + 1;
      }
    }
    while (cursor < text.length) {
      const openingIndex = [...text.slice(cursor)].findIndex((character) => quoteOpening(character));
      if (openingIndex < 0) break;
      const start = cursor + openingIndex + 1;
      const opening = text[cursor + openingIndex];
      const close = [...text.slice(start)].findIndex((character) => quoteClosing(character, opening));
      const end = close < 0 ? text.length : start + close;
      spans.push({ text: text.slice(start, end), start: cursor + openingIndex, end, continuation: false, speaker: null });
      if (close < 0) {
        continuation = { speaker: null };
        break;
      }
      cursor = end + 1;
    }
    output.push(...spans.map((span) => ({ ...span, paragraph: paragraph.number })));
    if (spans.some((span) => span.continuation && span.end === text.length)) continue;
    if (spans.length && spans.at(-1).end === text.length && continuation) continue;
  }
  return output;
}

function termPattern(term, insensitive = false) {
  return `(?<![\\p{L}\\p{N}_])${escapeRegex(term)}(?![\\p{L}\\p{N}_])`;
}

function registryMatches(text, characters) {
  const found = [];
  for (const character of characters) {
    const terms = [{ value: character.name, insensitive: false }, ...(character.aliases || []).map((alias) => ({ value: alias, insensitive: /^the\s/iu.test(alias) }))];
    for (const term of terms) {
      const regex = new RegExp(termPattern(term.value, term.insensitive), term.insensitive ? "giu" : "gu");
      for (const match of text.matchAll(regex)) found.push({ id: character.id, index: match.index, length: match[0].length });
    }
  }
  return found.sort((a, b) => a.index - b.index || b.length - a.length);
}

function outsideText(text, spans) {
  const mask = [...text];
  for (const span of spans) for (let index = span.start; index <= span.end; index += 1) mask[index] = " ";
  return mask.join("");
}

function speakerTag(text, span, characters) {
  const before = text.slice(Math.max(0, span.start - 120), span.start);
  const after = text.slice(span.end + 1, Math.min(text.length, span.end + 121));
  for (const character of characters) {
    const terms = [{ value: character.name, insensitive: false }, ...(character.aliases || []).map((alias) => ({ value: alias, insensitive: /^the\s/iu.test(alias) }))];
    for (const term of terms) {
      const name = termPattern(term.value, term.insensitive);
      const flags = term.insensitive ? "iu" : "u";
      const beforePattern = new RegExp(`(?:${name}\\s+(${[...VERBS].join("|")})|(${[...VERBS].join("|")})\\s+${name})\\s*[,;:—-]?\\s*$`, flags);
      const afterPattern = new RegExp(`^\\s*[,;:—-]?\\s*(?:(${[...VERBS].join("|")})\\s+${name}|${name}\\s+(${[...VERBS].join("|")}))\\s*[.!?]*\\s*$`, flags);
      if (beforePattern.test(before) || afterPattern.test(after)) return character.id;
    }
  }
  return null;
}

function attributeSpans(scene, characters) {
  const paragraphs = scene.prose.split(/\n\s*\n/u).filter((paragraph) => paragraph.trim()).map((paragraph, index) => ({
    number: index + 1,
    text: readerText(paragraph)
  }));
  const spans = quoteSpans(paragraphs);
  const byParagraph = new Map();
  for (const span of spans) {
    if (!byParagraph.has(span.paragraph)) byParagraph.set(span.paragraph, []);
    byParagraph.get(span.paragraph).push(span);
  }
  const lines = [];
  let pendingSpeaker = null;
  for (const paragraph of paragraphs) {
    const paragraphSpans = byParagraph.get(paragraph.number) || [];
    const outside = outsideText(paragraph.text, paragraphSpans);
    const named = new Set(registryMatches(outside, characters).map((match) => match.id));
    for (const span of paragraphSpans) {
      let speaker = span.continuation ? pendingSpeaker : speakerTag(paragraph.text, span, characters);
      if (!span.continuation && !speaker && named.size === 1) speaker = [...named][0];
      lines.push({ scene_id: scene.id, paragraph: paragraph.number, text: span.text, speaker, method: span.continuation ? "continuation" : speaker ? speakerTag(paragraph.text, span, characters) ? "tag" : "beat" : "unattributed" });
      if (span.end === paragraph.text.length && !span.continuation) pendingSpeaker = speaker;
      else if (span.continuation && span.end === paragraph.text.length) pendingSpeaker = speaker;
      else pendingSpeaker = null;
    }
    if (!paragraphSpans.length) pendingSpeaker = null;
  }
  return lines;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values, average = mean(values)) {
  if (values.length < 2) return 0;
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

const PROFILE_TOTAL_KEYS = ["lines", "words", "sentences", "contractions", "profanity", "formal_markers", "questions", "exclamations"];

function normalizedLineText(text) {
  return String(text).trim().replace(/\s+/gu, " ");
}

function lineRecordKey(record) {
  return `${record.scene_id}\u0000${record.paragraph}\u0000${record.text_sha256}`;
}

function lineKey(line) {
  return `${line.scene_id}\u0000${line.paragraph}\u0000${sha256(normalizedLineText(line.text))}`;
}

function lineRecord(line) {
  const features = line.features;
  return {
    scene_id: line.scene_id,
    paragraph: line.paragraph,
    text_sha256: sha256(normalizedLineText(line.text)),
    features: {
      words: features.words,
      sentences: features.sentences,
      contractions: features.contractions,
      profanity: features.profanity,
      formal_markers: features.formal_markers,
      questions: features.questions,
      exclamations: features.exclamations,
      words_per_sentence: features.words_per_sentence,
      contractions_per_100_words: features.contractions_per_100_words,
      profanity_per_100_words: features.profanity_per_100_words,
      exclamation_share: features.exclamation_share,
      question_share: features.question_share,
      formal_markers_per_100_words: features.formal_markers_per_100_words
    }
  };
}

function totalsForLines(lines) {
  return {
    lines: lines.length,
    words: lines.reduce((sum, line) => sum + line.features.words, 0),
    sentences: lines.reduce((sum, line) => sum + line.features.sentences, 0),
    contractions: lines.reduce((sum, line) => sum + line.features.contractions, 0),
    profanity: lines.reduce((sum, line) => sum + line.features.profanity, 0),
    formal_markers: lines.reduce((sum, line) => sum + line.features.formal_markers, 0),
    questions: lines.reduce((sum, line) => sum + line.features.questions, 0),
    exclamations: lines.reduce((sum, line) => sum + line.features.exclamations, 0)
  };
}

function aggregateFeatures(totals) {
  return {
    mean_words_per_sentence: totals.sentences ? totals.words / totals.sentences : 0,
    contractions_per_100_words: totals.words ? totals.contractions * 100 / totals.words : 0,
    profanity_per_100_words: totals.words ? totals.profanity * 100 / totals.words : 0,
    exclamation_share: totals.sentences ? totals.exclamations / totals.sentences : 0,
    question_share: totals.sentences ? totals.questions / totals.sentences : 0,
    formal_markers_per_100_words: totals.words ? totals.formal_markers * 100 / totals.words : 0
  };
}

function sortedLineRecords(lines) {
  return lines.map(lineRecord).sort((left, right) => lineRecordKey(left).localeCompare(lineRecordKey(right)));
}

function profileFor(character, lines, settings, hash, headCommit) {
  const own = lines.filter((line) => line.speaker === character.id).map((line) => ({ ...line, features: lineFeatures(line.text, settings) }));
  const values = Object.fromEntries(FEATURE_KEYS.map((key) => [key, own.map((line) => line.features[key])]));
  const totals = totalsForLines(own);
  const features = aggregateFeatures(totals);
  const distribution = Object.fromEntries(FEATURE_KEYS.map((key) => {
    const average = mean(values[key]);
    return [key, { mean: average, standard_deviation: standardDeviation(values[key], average) }];
  }));
  const typical = own.map((line) => ({
    ...line,
    distance: Math.sqrt(FEATURE_KEYS.reduce((sum, key) => {
      const sd = distribution[key].standard_deviation;
      return sum + (sd ? ((line.features[key] - distribution[key].mean) / sd) ** 2 : 0);
    }, 0))
  })).sort((left, right) => left.distance - right.distance || lineKey(left).localeCompare(lineKey(right)));
  const wordCounts = new Map();
  const otherCounts = new Map();
  for (const line of own) {
    for (const word of (line.text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [])) {
      if (STOPWORDS.has(word)) continue;
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }
  }
  for (const line of lines.filter((candidate) => candidate.speaker && candidate.speaker !== character.id)) {
    for (const word of (line.text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [])) {
      if (!STOPWORDS.has(word)) otherCounts.set(word, (otherCounts.get(word) || 0) + 1);
    }
  }
  const ownTotal = [...wordCounts.values()].reduce((sum, value) => sum + value, 0);
  const otherTotal = [...otherCounts.values()].reduce((sum, value) => sum + value, 0);
  const distinctiveWords = [...wordCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([word, count]) => ({ word, score: Math.log(((count + 0.5) / (ownTotal + 1)) / (((otherCounts.get(word) || 0) + 0.5) / (otherTotal + 1))) }))
    .sort((left, right) => right.score - left.score || left.word.localeCompare(right.word))
    .slice(0, 15)
    .map((entry) => entry.word);
  return {
    version: PROFILE_VERSION,
    character_id: character.id,
    name: character.name,
    manuscript_sha256: hash,
    approved_manuscript_sha256: hash,
    head_commit: headCommit,
    approved_head_commit: headCommit,
    lines: totals.lines,
    words: totals.words,
    enough_evidence: totals.lines >= EVIDENCE_MINIMUM.lines && totals.words >= EVIDENCE_MINIMUM.words,
    totals,
    line_records: sortedLineRecords(own),
    features,
    distribution,
    distinctive_words: distinctiveWords,
    evidence: typical.slice(0, 5).map((line) => ({ text: line.text, scene_id: line.scene_id, paragraph: line.paragraph }))
  };
}

export function buildVoiceProfiles(root, project) {
  const characters = loadCharacters(root).characters;
  const approved = approvedManuscript(root, project);
  const scenes = approved.scenes;
  const hash = approved.manuscript_sha256;
  const settings = voiceSettings(root);
  const lines = scenes.flatMap((scene) => attributeSpans(scene, characters));
  const directory = join(root, VOICES_ROOT);
  mkdirSync(directory, { recursive: true });
  const profiles = [];
  for (const character of characters) {
    const profile = profileFor(character, lines, settings, hash, approved.head_commit);
    writeFileSync(join(directory, `${character.id}.json`), `${JSON.stringify(profile, null, 2)}\n`);
    profiles.push(profile);
  }
  return { manuscript_sha256: hash, profiles };
}

function loadProfiles(root, characters) {
  return characters.flatMap((character) => {
    const path = join(root, VOICES_ROOT, `${character.id}.json`);
    if (!existsSync(path)) return [];
    try {
      return [{ character, profile: JSON.parse(readFileSync(path, "utf8")) }];
    } catch (error) {
      throw new Error(`invalid world-bible/voices/${character.id}.json: ${error.message}`);
    }
  });
}

function recordFeature(record, key) {
  return record.features?.[key] ?? 0;
}

function recordTotals(record) {
  return {
    lines: 1,
    words: recordFeature(record, "words"),
    sentences: recordFeature(record, "sentences"),
    contractions: recordFeature(record, "contractions"),
    profanity: recordFeature(record, "profanity"),
    formal_markers: recordFeature(record, "formal_markers"),
    questions: recordFeature(record, "questions"),
    exclamations: recordFeature(record, "exclamations")
  };
}

function profileTotals(profile, records) {
  return Object.fromEntries(PROFILE_TOTAL_KEYS.map((key) => [
    key,
    Number.isFinite(profile.totals?.[key])
      ? profile.totals[key]
      : key === "lines"
        ? (profile.lines ?? records.length)
        : key === "words"
          ? (profile.words ?? 0)
          : 0
  ]));
}

function comparisonProfile(profile, line) {
  if (!Array.isArray(profile.line_records)) return { profile, matched: false, legacy: true };
  const target = lineKey(line);
  const matches = profile.line_records.filter((record) => lineRecordKey(record) === target);
  if (!matches.length) return { profile, matched: false, legacy: false };

  // Exclude the checked line and every other line by this speaker in its paragraph.
  const excluded = profile.line_records.filter((record) => record.scene_id === line.scene_id && record.paragraph === line.paragraph);
  const excludedSet = new Set(excluded);
  const remaining = profile.line_records.filter((record) => !excludedSet.has(record));
  const totals = profileTotals(profile, profile.line_records);
  for (const record of excluded) {
    const contribution = recordTotals(record);
    for (const key of PROFILE_TOTAL_KEYS) totals[key] = Math.max(0, totals[key] - contribution[key]);
  }
  const features = aggregateFeatures(totals);
  const distribution = Object.fromEntries(FEATURE_KEYS.map((key) => {
    const values = remaining.map((record) => recordFeature(record, key));
    const average = mean(values);
    return [key, { mean: average, standard_deviation: standardDeviation(values, average) }];
  }));
  return {
    matched: true,
    legacy: false,
    profile: {
      ...profile,
      lines: totals.lines,
      words: totals.words,
      enough_evidence: totals.lines >= EVIDENCE_MINIMUM.lines && totals.words >= EVIDENCE_MINIMUM.words,
      totals,
      features,
      distribution
    }
  };
}

function evidenceWithoutLine(profile, line) {
  const target = lineKey(line);
  return (profile.evidence || []).filter((evidence) => {
    if (typeof evidence.text !== "string" || evidence.scene_id === undefined || evidence.paragraph === undefined) return true;
    return lineKey(evidence) !== target;
  });
}

function profileDistance(features, profile) {
  return Math.sqrt(FEATURE_KEYS.reduce((sum, key) => {
    const expected = profile.distribution?.[key]?.mean ?? profile.features?.[key] ?? 0;
    const scale = profile.distribution?.[key]?.standard_deviation || 1;
    return sum + ((features[key] - expected) / scale) ** 2;
  }, 0));
}

function sharedDistinctiveWords(text, profile) {
  const words = new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((word) => !STOPWORDS.has(word)));
  return (profile.distinctive_words || []).filter((word) => words.has(word));
}

function hardContrastMatches(features, profile) {
  return (features.profanity > 0 && profile.features.profanity_per_100_words >= 1)
    || (features.formal_markers > 0 && profile.features.formal_markers_per_100_words >= 1)
    || (features.contractions > 0 && profile.features.contractions_per_100_words >= 1);
}

function oneDecimal(value) {
  return Number(value.toFixed(1));
}

function formalMarkerNames(line, settings) {
  const found = new Map();
  for (const marker of [...BUILTIN_FORMAL, ...settings.formal]) {
    if (markerRegex(marker).test(line)) found.set(marker.trim().toLocaleLowerCase(), marker.trim());
  }
  return [...found.values()];
}

function voiceSignals(line, features, profile, settings) {
  const profileFeatures = profile.features || {};
  const contractionRate = profileFeatures.contractions_per_100_words || 0;
  const profanityRate = profileFeatures.profanity_per_100_words || 0;
  const formalRate = profileFeatures.formal_markers_per_100_words || 0;
  const sentenceRate = profileFeatures.mean_words_per_sentence || 0;
  const formalWords = formalMarkerNames(line, settings);
  const rateEligible = features.words >= 12;
  const hard = {
    profanity: features.profanity > 0
      && profile.words >= 150
      && profanityRate === 0,
    formal: profile.words >= 150
      && formalRate <= 0.2
      && (formalWords.length >= 2 || (formalWords.length >= 1 && features.words >= 15))
  };
  const signals = {
    long: features.words >= 15
      && sentenceRate > 0
      && features.words_per_sentence >= sentenceRate * 3,
    short: rateEligible
      && sentenceRate >= 12
      && features.sentences >= 2
      && features.words_per_sentence <= sentenceRate * 0.25,
    contraction_absence: rateEligible
      && features.words >= 15
      && features.contractions === 0
      && contractionRate >= 4,
    contraction_presence: rateEligible
      && features.contractions > 0
      && contractionRate < 1,
    profanity_presence: rateEligible
      && features.profanity > 0
      && profanityRate === 0,
    formal_presence: rateEligible
      && features.formal_markers > 0
      && formalRate < 1
  };
  const questions = [...line.matchAll(/\?/gu)].length;
  const exclamations = [...line.matchAll(/!/gu)].length;
  return {
    hard,
    signals,
    formalWords,
    questions,
    exclamations,
    supporting: {
      question: rateEligible && questions > 0 && questions / Math.max(features.sentences, 1) > (profileFeatures.question_share || 0),
      exclamation: rateEligible && exclamations > 0 && exclamations / Math.max(features.sentences, 1) > (profileFeatures.exclamation_share || 0)
    }
  };
}

function reasonFor(line, features, profile, settings, analysis) {
  const reasons = [];
  const candidates = [];
  const expected = (key) => profile.distribution?.[key]?.mean ?? profile.features[key];
  const deviation = (key) => Math.abs(features[key] - expected(key)) / (profile.distribution?.[key]?.standard_deviation || 1);
  const { signals, hard, formalWords, questions, exclamations, supporting } = analysis;
  const formalList = formalWords.length ? formalWords.map((word) => `'${word}'`).join(", ") : "formal markers";
  const add = (key, text, priority = 0) => candidates.push({ priority, strength: deviation(key), text });
  const contractionRate = oneDecimal(profile.features.contractions_per_100_words);
  const profanityRate = oneDecimal(profile.features.profanity_per_100_words);
  const formalRate = oneDecimal(profile.features.formal_markers_per_100_words);
  const sentenceRate = oneDecimal(profile.features.mean_words_per_sentence);
  if (hard.profanity) {
    add("profanity_per_100_words", `This line has ${features.profanity} profanity marker${features.profanity === 1 ? "" : "s"}; ${profile.name} has no profanity markers across ${profile.words} words of evidence.`, 100);
  }
  if (hard.formal) {
    add("formal_markers_per_100_words", `This line uses ${formalList}; ${profile.name} uses about ${formalRate} formal markers per 100 words across ${profile.words} words of evidence.`, 100);
  }
  if (signals.long) {
    add("words_per_sentence", `This line averages ${oneDecimal(features.words_per_sentence)} words per sentence; ${profile.name}'s lines average ${sentenceRate}, so this is at least three times longer.`, 50);
  } else if (signals.short) {
    add("words_per_sentence", `This line averages ${oneDecimal(features.words_per_sentence)} words per sentence; ${profile.name}'s lines average ${sentenceRate}, so this is at most one quarter as long.`, 50);
  }
  if (signals.contraction_absence) {
    add("contractions_per_100_words", `This line has no contractions in ${features.words} words; ${profile.name} uses about ${contractionRate} contractions per 100 words.`, 40);
  } else if (signals.contraction_presence) {
    add("contractions_per_100_words", `This line has ${features.contractions} contraction${features.contractions === 1 ? "" : "s"} in ${features.words} words; ${profile.name} uses about ${contractionRate} contractions per 100 words.`, 40);
  }
  if (signals.profanity_presence && !hard.profanity) {
    add("profanity_per_100_words", `This line has ${features.profanity} profanity marker${features.profanity === 1 ? "" : "s"}; ${profile.name} uses about ${profanityRate} profanity markers per 100 words.`, 30);
  }
  if (signals.formal_presence && !hard.formal) {
    add("formal_markers_per_100_words", `This line uses ${formalList} (${features.formal_markers} formal marker${features.formal_markers === 1 ? "" : "s"}); ${profile.name} uses about ${formalRate} formal markers per 100 words.`, 30);
  }
  if (candidates.length && supporting.exclamation) {
    add("exclamation_share", `This line has ${exclamations} exclamation${exclamations === 1 ? "" : "s"}; ${profile.name} averages fewer exclamations per sentence.`, 10);
  }
  if (candidates.length && supporting.question) {
    add("question_share", `This line has ${questions} question${questions === 1 ? "" : "s"}; ${profile.name} averages fewer questions per sentence.`, 10);
  }
  candidates.sort((left, right) => right.priority - left.priority || right.strength - left.strength || left.text.localeCompare(right.text));
  reasons.push(...candidates.slice(0, 3).map((candidate) => candidate.text));
  if (!reasons.length) {
    reasons.push(`This line is out of voice for ${profile.name}'s usual sentence length.`);
  }
  return reasons;
}

function pendingLineFilter(lines, scene, pendingScenes) {
  if (!pendingScenes) return () => true;
  const pending = pendingScenes.find((candidate) => candidate.id === scene.id);
  if (!pending) return () => false;
  const before = pending.beforeProse.split(/\n\s*\n/u).filter((paragraph) => paragraph.trim()).map(readerText);
  const after = scene.prose.split(/\n\s*\n/u).filter((paragraph) => paragraph.trim()).map(readerText);
  const changedParagraphs = new Set(after.map((text, index) => text !== before[index] ? index + 1 : null).filter(Boolean));
  return (line) => changedParagraphs.has(line.paragraph);
}

export function runVoiceCheck(root, project, { sceneIds = null, pendingScenes = null } = {}) {
  const characters = loadCharacters(root).characters;
  const scenes = loadScenes(root, project).filter((scene) => !sceneIds || sceneIds.map(String).includes(scene.id));
  const approved = approvedManuscript(root, project);
  const settings = voiceSettings(root);
  const lines = scenes.flatMap((scene) => attributeSpans(scene, characters));
  const records = loadProfiles(root, characters);
  const profiles = new Map(records.map(({ character, profile }) => [character.id, { character, profile }]));
  const staleProfiles = records.filter(({ profile }) => {
    const profileHash = profile.approved_manuscript_sha256 || profile.manuscript_sha256;
    const hashMismatch = profileHash !== approved.manuscript_sha256;
    const recordedHead = profile.approved_head_commit ?? profile.head_commit;
    const headMismatch = (Object.prototype.hasOwnProperty.call(profile, "approved_head_commit")
      || Object.prototype.hasOwnProperty.call(profile, "head_commit"))
      && recordedHead !== approved.head_commit;
    return hashMismatch || headMismatch;
  }).map(({ character }) => character.name);
  const findings = [];
  const notes = [];
  const legacyNoted = new Set();
  for (const line of lines) {
    const record = profiles.get(line.speaker);
    if (!record) continue;
    const { character, profile } = record;
    const scene = scenes.find((candidate) => candidate.id === line.scene_id);
    if (!pendingLineFilter(lines, scene, pendingScenes)(line)) continue;
    const comparison = comparisonProfile(profile, line);
    if (comparison.legacy && !legacyNoted.has(character.id)) {
      notes.push({ scene_id: line.scene_id, paragraph: line.paragraph, speaker: character.name, message: "voice profile has no per-line data; run weaver voices build" });
      legacyNoted.add(character.id);
    }
    const checkedProfile = comparison.profile;
    if (!checkedProfile.enough_evidence) {
      notes.push({ scene_id: line.scene_id, paragraph: line.paragraph, speaker: character.name, message: `not enough of their lines yet (${checkedProfile.lines} lines, ${checkedProfile.words} words)` });
      continue;
    }
    const features = lineFeatures(line.text, settings);
    const analysis = voiceSignals(line.text, features, checkedProfile, settings);
    const distance = profileDistance(features, checkedProfile);
    const hardContrast = analysis.hard.profanity || analysis.hard.formal;
    const independentSignals = Object.values(analysis.signals).filter(Boolean).length;
    if (!hardContrast && independentSignals < 2) continue;
    const finding = {
      type: "voice",
      severity: "warn",
      scene_id: line.scene_id,
      paragraph: line.paragraph,
      speaker: character.name,
      line: line.text,
      reasons: reasonFor(line.text, features, checkedProfile, settings, analysis),
      evidence: evidenceWithoutLine(checkedProfile, line).slice(0, 3)
    };
    finding.reason = finding.reasons[0];
    const candidates = records.filter(({ character: other, profile: otherProfile }) => other.id !== character.id && otherProfile.enough_evidence)
      .map(({ character: other, profile: otherProfile }) => ({
        character: other,
        profile: otherProfile,
        distance: profileDistance(features, otherProfile),
        shared: sharedDistinctiveWords(line.text, otherProfile),
        contrast: hardContrastMatches(features, otherProfile)
      }))
      .sort((left, right) => Number(right.contrast) - Number(left.contrast)
        || left.distance - right.distance
        || left.character.id.localeCompare(right.character.id));
    const best = candidates[0];
    const margin = distance - (best?.distance ?? Number.POSITIVE_INFINITY);
    if (best && (best.contrast || (best.distance + SOUNDS_LIKE_MARGIN < distance
      && (best.shared.length || margin >= SOUNDS_LIKE_MARGIN * 2)))) {
      finding.maybe_sounds_like = {
        character: best.character.name,
        evidence: evidenceWithoutLine(best.profile, line).slice(0, 2)
      };
    }
    findings.push(finding);
  }
  return { findings, notes, stale_profiles: staleProfiles, warnings: findings.length, hash: approved.manuscript_sha256 };
}

export function attributeDialogue(scene, characters) {
  return attributeSpans(scene, characters);
}

export function voiceProfilesPath(root) {
  return join(root, VOICES_ROOT);
}
