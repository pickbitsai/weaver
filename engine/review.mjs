// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCharacters } from "./characters.mjs";
import { runHostBatch } from "./host.mjs";
import { GENERATOR, SCHEMA_BASE } from "./identity.mjs";
import { countWords, loadScenes, sha256 } from "./manuscript.mjs";
import { buildPacket, extractJsonBlock, validateAndRepair } from "./packets.mjs";
import { readerText } from "./prose.mjs";
import { factsLedgerPath, statePath } from "./state.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LENSES = ["continuity", "style", "critic"];
export const VERDICTS = { continuity: ["CLEAR", "FLAGS"], style: ["CONSISTENT", "DRIFT"], critic: ["PASS", "FAIL"] };
const SEVERITIES = new Set(["definite", "ambiguity", "minor", "craft"]);

export function reviewParagraphs(scene) {
  return scene.prose.split(/\n\s*\n/u).filter((value) => value.trim()).map((value, index) => ({
    scene_id: scene.id, paragraph: index + 1, text: readerText(value).replace(/\s+/gu, " ").trim()
  }));
}

export function chapterProseHash(scenes, chapter) {
  return sha256(scenes.filter((scene) => scene.chapter === chapter).map((scene) => `${scene.id}:${scene.hash}`).join("\n"));
}

function factsContext(root, chapter) {
  const path = factsLedgerPath(root);
  if (!existsSync(path)) return { text: "_No facts ledger._", hash: null };
  const ledger = JSON.parse(readFileSync(path, "utf8"));
  const lines = [];
  for (const subject of Object.keys(ledger.subjects || {}).sort()) {
    const prior = ledger.subjects[subject].filter((fact) => Number(String(fact.scene_id).split("-")[0]) < chapter);
    const location = prior.filter((fact) => fact.kind === "location").at(-1);
    const knowledge = prior.filter((fact) => fact.kind === "knowledge").slice(-5);
    if (location) lines.push(`${subject} location: ${location.value} [${location.scene_id}]`);
    for (const fact of knowledge) lines.push(`${subject} knowledge: ${fact.value} [${fact.scene_id}]`);
  }
  const text = lines.join("\n") || "_No earlier facts._";
  return { text, hash: sha256(text) };
}

function worldBible(root) {
  const lines = [];
  for (const name of ["characters.md", "locations.md", "terminology.md"]) {
    const path = join(root, "world-bible", name);
    const starter = join(PACKAGE_ROOT, "templates", "book", "world-bible", name);
    if (existsSync(path) && (!existsSync(starter) || readFileSync(path, "utf8") !== readFileSync(starter, "utf8"))) {
      lines.push(`### ${name}\n${readFileSync(path, "utf8").trim()}`);
    }
  }
  return lines.join("\n\n") || "_No project world-bible notes._";
}

export function reviewInputs(root, project, chapter, scenes = loadScenes(root, project)) {
  const chapterScenes = scenes.filter((scene) => scene.chapter === chapter);
  if (!chapterScenes.length) throw new Error(`unknown chapter: ${chapter}`);
  const facts = factsContext(root, chapter);
  const previous = scenes.filter((scene) => scene.chapter === chapter - 1).map((scene) => {
    const path = statePath(root, project, scene.id);
    return `### ${scene.id}\n${existsSync(path) ? readFileSync(path, "utf8").trim() : "_No state record._"}`;
  }).join("\n\n") || "_No previous chapter state records._";
  return { chapterScenes, proseHash: chapterProseHash(scenes, chapter), facts, previous };
}

export function reviewRecordPath(root, chapter, lens) {
  return join(root, "review", `chapter-${String(chapter).padStart(2, "0")}-${lens}.json`);
}

export function reviewIsCurrent(record, inputs) {
  return record?.chapter_prose_sha256 === inputs.proseHash &&
    (record.lens !== "continuity" || record.facts_sha256 === inputs.facts.hash);
}

export function buildReviewPacket(root, project, chapter, lens, inputs = reviewInputs(root, project, chapter)) {
  if (!LENSES.includes(lens)) throw new Error(`unknown review lens: ${lens}`);
  const lensPrompt = readFileSync(join(PACKAGE_ROOT, "prompts", "reviewers", `${lens}.md`), "utf8").trim();
  const registry = JSON.stringify(loadCharacters(root).characters, null, 2);
  const bible = worldBible(root);
  const paragraphs = inputs.chapterScenes.flatMap(reviewParagraphs);
  const context = lens === "continuity" ? `## Earlier facts\n${inputs.facts.text}\n\n## Previous chapter narrative state\n${inputs.previous}\n\n` : "";
  const prompt = `# REVIEW packet chapter ${chapter} lens ${lens}\n\n${lensPrompt}\n\n## Character registry\n${registry}\n\n## World bible\n${bible}\n\n${context}## Chapter reader text\n${paragraphs.map((item) => `[${item.scene_id} p${item.paragraph}] ${item.text}`).join("\n\n")}\n\n## Answer contract\nStart with ${lens.toUpperCase()}: ${VERDICTS[lens].join(" or ")}. Then return a fenced \`\`\`json block: {"verdict":"<lens verdict>","findings":[{"severity":"definite|ambiguity|minor|craft","scene_id":"<id>","paragraph":1,"quote":"<verbatim 3-25 words from that paragraph>","issue":"<one sentence>","repair":"<smallest repair, one sentence>"}]}. Quote only this chapter's reader text.`;
  return buildPacket("REVIEW", `${chapter}:${lens}`, prompt, {
    chapter_prose: inputs.proseHash, facts: lens === "continuity" ? inputs.facts.hash || "" : "",
    previous_state: lens === "continuity" ? sha256(inputs.previous) : "",
    registry: sha256(registry), world_bible: sha256(bible), lens_prompt: sha256(lensPrompt)
  }, "review-1");
}

function normalizeQuote(value) {
  return String(value).replace(/[\u201c\u201d]/gu, '"').replace(/[\u2018\u2019]/gu, "'").replace(/\s+/gu, " ").trim();
}

function parsedAnswer(text, lens) {
  const parsed = extractJsonBlock(text);
  if (!parsed.ok) return { errors: parsed.errors, document: null };
  const document = parsed.value;
  const errors = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) errors.push("answer must be a JSON object");
  else {
    if (!VERDICTS[lens].includes(document.verdict)) errors.push("invalid lens verdict");
    if (!Array.isArray(document.findings)) errors.push("findings must be an array");
    const line = String(text).slice(0, parsed.start).trim().split(/\n/u)[0]?.trim();
    if (line !== `${lens.toUpperCase()}: ${document.verdict}`) errors.push("lens verdict line does not match JSON verdict");
  }
  return { errors, document };
}

function validatedFindings(document, paragraphs) {
  const byKey = new Map(paragraphs.map((item) => [`${item.scene_id}:${item.paragraph}`, item.text]));
  const findings = [];
  let dropped = 0;
  const errors = [];
  for (const [index, finding] of document.findings.entries()) {
    const paragraph = byKey.get(`${finding?.scene_id}:${finding?.paragraph}`);
    const valid = finding && SEVERITIES.has(finding.severity) && Number.isInteger(finding.paragraph) && paragraph &&
      typeof finding.quote === "string" && countWords(finding.quote) >= 3 && countWords(finding.quote) <= 25 &&
      normalizeQuote(paragraph).includes(normalizeQuote(finding.quote)) &&
      typeof finding.issue === "string" && finding.issue.trim() && typeof finding.repair === "string" && finding.repair.trim();
    if (valid) findings.push(finding);
    else { dropped += 1; errors.push(`finding ${index + 1} has an invalid location, quote, severity, issue, or repair`); }
  }
  return { findings, dropped, errors };
}

export function validateReviewAnswer(text, lens, paragraphs) {
  const parsed = parsedAnswer(text, lens);
  if (parsed.errors.length) return { ok: false, value: null, errors: parsed.errors };
  const checked = validatedFindings(parsed.document, paragraphs);
  return { ok: checked.errors.length === 0, value: { verdict: parsed.document.verdict, findings: checked.findings, dropped_findings: checked.dropped }, errors: checked.errors };
}

async function recordAnswer(root, project, chapter, lens, packet, inputs, text) {
  const paragraphs = inputs.chapterScenes.flatMap(reviewParagraphs);
  const validator = (answer) => validateReviewAnswer(answer, lens, paragraphs);
  const result = await validateAndRepair(root, project, packet, text, validator);
  let value = result.value;
  if (!result.ok) {
    const parsed = parsedAnswer(result.answerText, lens);
    if (parsed.errors.length) return { ok: false, errors: parsed.errors };
    const checked = validatedFindings(parsed.document, paragraphs);
    value = { verdict: parsed.document.verdict, findings: checked.findings, dropped_findings: checked.dropped };
  }
  const record = {
    $schema: `${SCHEMA_BASE}review-1.json`, chapter, lens, verdict: value.verdict,
    findings: value.findings, dropped_findings: value.dropped_findings,
    chapter_prose_sha256: inputs.proseHash, facts_sha256: lens === "continuity" ? inputs.facts.hash : null,
    packet_id: packet.id, generator: GENERATOR
  };
  mkdirSync(join(root, "review"), { recursive: true });
  writeFileSync(reviewRecordPath(root, chapter, lens), `${JSON.stringify(record, null, 2)}\n`);
  return { ok: true, record };
}

export async function runReview(root, project, { chapter, lenses = LENSES, run = false, onProgress = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const selected = [...new Set(lenses)];
  if (!selected.length || selected.some((lens) => !LENSES.includes(lens))) throw new Error(`lenses must be ${LENSES.join(",")}`);
  const inputs = reviewInputs(root, project, Number(chapter));
  const pending = [];
  for (const lens of selected) {
    const path = reviewRecordPath(root, Number(chapter), lens);
    const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    if (reviewIsCurrent(existing, inputs)) { onProgress(`Chapter ${chapter} ${lens}: skipped, already current`); continue; }
    const packet = buildReviewPacket(root, project, Number(chapter), lens, inputs);
    mkdirSync(join(root, ".weaver", "packets"), { recursive: true });
    writeFileSync(join(root, ".weaver", "packets", `${packet.id}.json`), `${JSON.stringify(packet, null, 2)}\n`);
    pending.push({ lens, packet });
    if (!run) onProgress(`Chapter ${chapter} ${lens}: packet ${packet.id} written; answer it with weaver submit ${packet.id} --file <answer>`);
  }
  if (!run || !pending.length) return;
  const responses = await runHostBatch(root, project, pending.map(({ packet }) => packet.prompt));
  for (const [index, { lens, packet }] of pending.entries()) {
    const response = responses[index];
    if (!response.ok) { onProgress(`Chapter ${chapter} ${lens}: host error: ${response.error}`); continue; }
    const result = await recordAnswer(root, project, Number(chapter), lens, packet, inputs, response.text);
    onProgress(result.ok ? `Chapter ${chapter} ${lens}: recorded (${result.record.findings.length} findings, ${result.record.dropped_findings} dropped)` : `Chapter ${chapter} ${lens}: answer invalid after repair: ${result.errors[0]}`);
  }
}

export async function submitReviewPacket(root, project, packet, answerText) {
  const [chapterText, lens] = String(packet.target).split(":");
  const chapter = Number(chapterText);
  const inputs = reviewInputs(root, project, chapter);
  const current = buildReviewPacket(root, project, chapter, lens, inputs);
  if (current.id !== packet.id) return { ok: false, errors: ["packet is stale because its review inputs changed"] };
  return recordAnswer(root, project, chapter, lens, packet, inputs, answerText);
}
