// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { approveChapter, pendingChanges } from "./changes.mjs";
import { loadCharacters } from "./characters.mjs";
import { collectFindings } from "./findings.mjs";
import { runHost } from "./host.mjs";
import { countWords, extractProse, loadScenes, sha256 } from "./manuscript.mjs";
import { buildPacket, extractJsonBlock, savedAnswerNote, validateAndRepair } from "./packets.mjs";
import { readerText } from "./prose.mjs";
import { writeRecord } from "./records.mjs";
import { chapterProseHash, worldBible } from "./review.mjs";
import { runRulesOnScenes } from "./rules.mjs";
import { blockingRuleRegression } from "./rule-regression.mjs";
import { runVoiceCheck } from "./voice.mjs";

export const REPAIR_CONTRACT = '{"edits":[{"scene_id":"<id>","paragraph":1,"finding_ids":["<id>"],"before":"<exact source paragraph>","after":"<replacement paragraph>","reason":"<one sentence>"}],"declined":[{"finding_id":"<id>","reason":"<one sentence>"}]}';
const paras = (prose) => prose.split(/\n\s*\n/u).filter((part) => part.trim());
const fileHash = (root, path) => existsSync(join(root, path)) ? sha256(readFileSync(join(root, path))) : sha256("");
const key = (finding) => `${finding.kind}:${finding.source}:${finding.scene_id}:${finding.paragraph}`;
const measuredUnit = (finding) => ["scene", "chapter"].includes(finding.measurement?.unit);
const locationsOf = (finding) => measuredUnit(finding) ? finding.locations : [finding];
const sameTarget = (finding, item) => measuredUnit(finding)
  ? item.rule_id === finding.rule_id && item.measurement?.unit === finding.measurement.unit &&
    (finding.measurement.unit === "chapter" ? item.chapter === finding.chapter : item.scene_id === finding.scene_id)
  : key(item) === key(finding);

export function selectRepairFindings(findings) {
  return [...new Map(findings.filter((finding) => {
    const decision = finding.ruling?.decision || finding.ruling;
    if (["allow", "intended"].includes(decision)) return false;
    return ["fix", "author wants this fixed"].includes(decision) ||
      (finding.kind === "rule" && finding.severity === "block") ||
      (finding.kind === "voice" && finding.severity === "warn") ||
      (finding.kind === "judgment" && finding.queued === true);
  }).map((finding) => [finding.id, finding])).values()];
}

export function repairInputs(root, project, chapter, snapshot = {}) {
  chapter = Number(chapter);
  const scenes = (snapshot.scenes || loadScenes(root, project)).filter((scene) => scene.chapter === chapter);
  if (!scenes.length) throw new Error(`unknown chapter: ${chapter}`);
  const collected = snapshot.collected || collectFindings(root, project, { chapter, all: true });
  const allFindings = [...collected.findings, ...collected.notes].filter((finding) => finding.chapter === chapter);
  const findings = selectRepairFindings(allFindings);
  const bible = worldBible(root);
  const registry = JSON.stringify(loadCharacters(root).characters, null, 2);
  const editorialPath = join(root, "quality", "editorial-rules.md");
  const editorial = existsSync(editorialPath) ? readFileSync(editorialPath, "utf8") : "_No editorial rules._";
  const hashes = { chapter_prose: chapterProseHash(scenes, chapter), findings: sha256(JSON.stringify(allFindings)),
    rules: fileHash(root, "quality/rules.json"), rulings: fileHash(root, "continuity/rulings.json"),
    editorial_rules: fileHash(root, "quality/editorial-rules.md"), world_bible: sha256(bible), registry: fileHash(root, "world-bible/characters.json"),
    repair_settings: sha256(JSON.stringify(project.repair || {})) };
  return { chapter, scenes, findings, hashes, bible, registry, editorial };
}

export function buildRepairPacket(root, project, chapter, { note = "", inputs = repairInputs(root, project, chapter) } = {}) {
  const findings = inputs.findings.map((finding) => {
    const paragraph = paras(inputs.scenes.find((scene) => scene.id === finding.scene_id)?.prose || "")[finding.paragraph - 1] || "";
    const sentences = readerText(paragraph).match(/[^.!?]+[.!?]*(?:[”"])?/gu) || [];
    const sentence = finding.sentence || finding.line || sentences.find((text) => text.includes(finding.quote))?.trim() || readerText(paragraph);
    return { ...finding, sentence };
  });
  const prompt = `# REPAIR packet chapter ${chapter}\n\nPropose the smallest repairs. Do not write files or run author commands. Preserve source Markdown and the paragraph count. Net word growth per edit must be at most ${project.repair?.max_growth_words ?? 0}. Cover every targeted finding with edits or one decline, never both. A scene or chapter measurement may appear in several edits, one for each of its listed locations. Other findings must appear exactly once. Only edit listed locations. Meet each numeric goal across the whole measured unit; a partial reduction is useful if the full repair is not possible. Combine findings in the same paragraph into one edit. Explain any decline.\n\n## Editorial rules\n${inputs.editorial}\n\n## Character registry\n${inputs.registry}\n\n## World bible\n${inputs.bible}\n\n## Targeted findings\n${JSON.stringify(findings, null, 2)}\n\n## Author note\n${note || "None."}\n\n## Chapter source Markdown\n${inputs.scenes.flatMap((scene) => paras(scene.prose).map((text, index) => `[${scene.id} p${index + 1}] ${text}`)).join("\n\n")}\n\n## Answer contract\nReturn a fenced \`\`\`json block: ${REPAIR_CONTRACT}`;
  return buildPacket("REPAIR", String(chapter), prompt, { ...inputs.hashes, author_note: sha256(note) }, "repair-2");
}

export function validateRepairAnswer(text, findings) {
  const parsed = extractJsonBlock(text);
  if (!parsed.ok) return parsed;
  const value = parsed.value, errors = [];
  if (!value || !Array.isArray(value.edits) || !Array.isArray(value.declined)) return { ok: false, errors: ["answer must contain edits and declined arrays"] };
  const counts = new Map(findings.map((finding) => [finding.id, { edits: 0, declines: 0 }]));
  const cover = (id, kind) => { if (!counts.has(id)) errors.push(`unknown finding: ${id}`); else counts.get(id)[kind]++; };
  for (const edit of value.edits) {
    if (!edit || typeof edit.scene_id !== "string" || !Number.isInteger(edit.paragraph) || edit.paragraph < 1 ||
      typeof edit.before !== "string" || typeof edit.after !== "string" || typeof edit.reason !== "string" || !edit.reason.trim() ||
      !Array.isArray(edit.finding_ids) || !edit.finding_ids.length) { errors.push("each edit needs scene_id, paragraph, finding_ids, before, after, and reason"); continue; }
    if (new Set(edit.finding_ids).size !== edit.finding_ids.length) errors.push("an edit must not repeat a finding id");
    edit.finding_ids.forEach((id) => cover(id, "edits"));
  }
  for (const decline of value.declined) {
    if (!decline || typeof decline.finding_id !== "string" || typeof decline.reason !== "string" || !decline.reason.trim()) errors.push("each decline needs finding_id and reason");
    else cover(decline.finding_id, "declines");
  }
  for (const finding of findings) {
    const { edits, declines } = counts.get(finding.id);
    if (declines === 1 && edits === 0) continue;
    if (declines === 0 && edits > 0 && (measuredUnit(finding) || edits === 1)) continue;
    errors.push(`finding ${finding.id} must be covered ${measuredUnit(finding) ? "by one or more edits or exactly one decline, never both" : "exactly once"} (got ${edits} edits and ${declines} declines)`);
  }
  return { ok: errors.length === 0, value, errors };
}

export function applyEditsInMemory(scenes, edits) {
  return scenes.map((scene) => {
    let index = 0;
    const prose = scene.prose.split(/(\n\s*\n)/u).map((part) => {
      if (!part.trim()) return part;
      index++;
      return edits.find((edit) => edit.scene_id === scene.id && edit.paragraph === index)?.after ?? part;
    }).join("");
    return { ...scene, prose, hash: sha256(prose), words: countWords(prose) };
  });
}

function checkChapter(root, project, scenes) {
  const rules = runRulesOnScenes(root, project, scenes, { includeMeasurements: true });
  return { ...rules, findings: [...rules.findings, ...runVoiceCheck(root, project, { scenes }).findings] };
}

export function validateRepairEdits(root, project, inputs, answer) {
  const edits = [];
  let proposed = checkChapter(root, project, inputs.scenes);
  const dropped_edits = [], occupied = new Set();
  const drop = (edit, why) => dropped_edits.push({ ...edit, why });
  for (const [index, candidate] of answer.edits.entries()) {
    const edit = { ...candidate, number: index + 1, word_delta: countWords(candidate.after) - countWords(candidate.before) };
    const scene = inputs.scenes.find((item) => item.id === edit.scene_id);
    const paragraph = scene && paras(scene.prose)[edit.paragraph - 1];
    const location = `${edit.scene_id}:${edit.paragraph}`;
    if (paragraph === undefined || edit.before !== paragraph) { drop(edit, "before does not exactly match the source paragraph"); continue; }
    if (!edit.finding_ids.every((id) => inputs.findings.some((finding) => finding.id === id && locationsOf(finding).some((location) => location.scene_id === edit.scene_id && location.paragraph === edit.paragraph)))) { drop(edit, "unflagged paragraph: a cited finding is not located here"); continue; }
    if (occupied.has(location)) { drop(edit, "another edit already changes this paragraph"); continue; }
    if (!edit.after.trim() || edit.after !== edit.after.trim() || /\r|\n\s*\n|^\s*---\s*$/mu.test(edit.after)) { drop(edit, "replacement must keep one non-empty paragraph without blank lines or scene separators"); continue; }
    if (edit.after === edit.before) { drop(edit, "the edit changes nothing"); continue; }
    if (edit.word_delta > (project.repair?.max_growth_words ?? 0)) { drop(edit, "word growth exceeds project.repair.max_growth_words"); continue; }
    const next = checkChapter(root, project, applyEditsInMemory(inputs.scenes, [...edits, edit]));
    // Compare each edit with the kept edits so a reduction cannot hide a later increase.
    const regression = blockingRuleRegression(proposed.rules, proposed, next);
    if (regression) { drop(edit, `worsens a blocking rule: ${regression}`); continue; }
    occupied.add(location);
    edits.push(edit);
    proposed = next;
  }
  const target_results = inputs.findings.map((finding) => {
    const remaining = proposed.findings.find((item) => sameTarget(finding, item));
    const edited = edits.some((edit) => edit.finding_ids.includes(finding.id));
    let status = finding.kind === "judgment" ? "proposed" : remaining ? "unfixed" : "fixed";
    const measurement = measuredUnit(finding) && proposed.measurements.find((item) => sameTarget(finding, item));
    if (remaining && measurement && measurement.value < finding.measurement.value) status = "partly-fixed";
    if (!edited) status = answer.declined.some((item) => item.finding_id === finding.id) ? "declined" : "unfixed";
    const progress = measurement ? { before: finding.count, after: measurement.count, limit: measurement.measurement.count_limit } : {};
    const message = status === "partly-fixed" ? `partly fixed: ${progress.before} → ${progress.after} (limit ${progress.limit})`
      : status === "unfixed" ? "didn't fix it" : status;
    return { finding_id: finding.id, status, ...progress, message };
  });
  for (const edit of edits) {
    const targeted = target_results.filter((target) => edit.finding_ids.includes(target.finding_id));
    const ids = (status) => targeted.filter((target) => target.status === status).map((target) => target.finding_id);
    edit.findings_fixed = ids("fixed");
    edit.findings_proposed = ids("proposed");
    edit.findings_partly_fixed = ids("partly-fixed");
    edit.unfixed_findings = [...ids("unfixed"), ...ids("partly-fixed")];
    edit.validation = targeted.filter((target) => ["unfixed", "partly-fixed"].includes(target.status)).map((target) => target.message).join("; ") || "ready";
  }
  return { edits, dropped_edits, declined: answer.declined, target_results, remaining_findings: proposed.findings };
}

export const proposalPath = (root, chapter) => join(root, ".weaver", "proposals", `chapter-${String(chapter).padStart(2, "0")}.json`);
export function readProposal(root, chapter) {
  const path = proposalPath(root, chapter);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
export function proposalIsStale(record, inputs) {
  return !record || Object.entries(inputs.hashes).some(([name, hash]) => record.inputs?.[name] !== hash);
}
function saveProposal(root, record) {
  const path = proposalPath(root, record.chapter);
  if (existsSync(path)) {
    const archive = join(root, ".weaver", "proposals", "history", `chapter-${record.chapter}-${randomUUID()}.json`);
    writeRecord(archive, readProposal(root, record.chapter));
  }
  writeRecord(path, record);
  return record;
}
export function listProposals(root, project, snapshot = {}) {
  const folder = join(root, ".weaver", "proposals");
  if (!existsSync(folder)) return [];
  const shared = { scenes: snapshot.scenes || loadScenes(root, project), collected: snapshot.collected || collectFindings(root, project, { all: true }) };
  return readdirSync(folder).filter((name) => /^chapter-\d+\.json$/u.test(name)).map((name) => {
    const record = JSON.parse(readFileSync(join(folder, name), "utf8"));
    let stale = true;
    try { stale = proposalIsStale(record, repairInputs(root, project, record.chapter, shared)); } catch { /* A removed chapter is stale. */ }
    return { ...record, status: record.status === "accepted" ? "accepted" : stale ? "stale" : record.status };
  }).sort((a, b) => a.chapter - b.chapter);
}

async function recordRepair(root, project, inputs, packet, text, { host = runHost, note = "", answerPath = null } = {}) {
  const record = { chapter: inputs.chapter, chapter_prose_sha256: inputs.hashes.chapter_prose, inputs: inputs.hashes,
    packet_id: packet.id, created_at: new Date().toISOString(), note, findings: inputs.findings, edits: [], dropped_edits: [], declined: [] };
  const answer = await validateAndRepair(root, project, packet, text, (value) => validateRepairAnswer(value, inputs.findings), { host, answerPath });
  if (!answer.ok) return saveProposal(root, { ...record, status: "failed", error: answer.host_error || answer.errors.join("; "), ...(answer.answer_file ? { answer_file: answer.answer_file } : {}) });
  const checked = validateRepairEdits(root, project, inputs, answer.value);
  const status = checked.edits.length ? "ready" : checked.declined.length ? "declined" : "no-usable-edits";
  return saveProposal(root, { ...record, ...checked, status });
}

export async function repairChapter(root, project, { chapter, run = false, note = "", host = runHost, onProgress = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const inputs = repairInputs(root, project, chapter);
  const packet = buildRepairPacket(root, project, chapter, { note, inputs });
  if (!inputs.findings.length) {
    const record = saveProposal(root, { chapter: inputs.chapter, chapter_prose_sha256: inputs.hashes.chapter_prose, packet_id: packet.id,
      inputs: inputs.hashes, created_at: new Date().toISOString(), status: "nothing-to-repair", edits: [], dropped_edits: [], declined: [], findings: [] });
    onProgress(`Chapter ${chapter}: nothing to repair`);
    return record;
  }
  const path = join(root, ".weaver", "packets", `${packet.id}.json`);
  writeRecord(path, packet);
  if (!run) { onProgress(`Chapter ${chapter}: repair packet written to ${path}; answer it with weaver submit ${packet.id} --file <answer>`); return { status: "packet", packet, path }; }
  const response = await host(root, project, packet.prompt);
  const result = response.ok ? await recordRepair(root, project, inputs, packet, response.text, { host, note }) :
    saveProposal(root, { chapter: inputs.chapter, chapter_prose_sha256: inputs.hashes.chapter_prose, inputs: inputs.hashes, packet_id: packet.id,
      status: "failed", created_at: new Date().toISOString(), findings: inputs.findings, edits: [], dropped_edits: [], declined: [], error: response.error });
  onProgress(proposalSummary(result, root));
  return result;
}

export async function submitRepairPacket(root, project, packet, text, options = {}) {
  const inputs = repairInputs(root, project, Number(packet.target));
  if (Object.entries(inputs.hashes).some(([name, hash]) => hash !== packet.inputs[name])) return { ok: false, errors: ["repair packet is stale; Ask again"] };
  const record = await recordRepair(root, project, inputs, packet, text, options);
  return { ok: record.status !== "failed", record, errors: record.error ? [record.error] : [] };
}

export function proposalSummary(record, root = null) {
  return [`Chapter ${record.chapter}: ${record.status.replaceAll("-", " ")} (${record.edits.length} edits, ${record.declined.length} declined)${record.error ? `: ${record.error}` : ""}${savedAnswerNote(root, record.answer_file)}`,
    ...(record.target_results || []).filter((target) => target.status === "partly-fixed").map((target) => `  Target ${target.finding_id}: ${target.message}`),
    ...record.dropped_edits.map((edit) => `  Dropped edit ${edit.number}, ${edit.scene_id} p${edit.paragraph}: ${edit.why}`),
    ...record.declined.map((item) => `  Declined ${item.finding_id}: ${item.reason}`),
    ...(record.status !== "accepted" ? [`  Ask again: weaver repair --chapter ${record.chapter} --run`] : [])].join("\n");
}

export function acceptProposal(root, project, chapter, { edits: selected = null, note = "" } = {}) {
  const record = readProposal(root, chapter);
  const inputs = repairInputs(root, project, chapter);
  if (!record || proposalIsStale(record, inputs)) throw new Error("This proposal is stale or missing. Ask again for a fresh proposal.");
  if (record.status !== "ready") throw new Error("This proposal has no ready edits.");
  const pending = pendingChanges(root, project);
  if (pending.chapters.some((item) => item.chapter !== Number(chapter))) throw new Error("Another chapter has pending changes. Approve or reject those first.");
  if (pending.scenes.length) throw new Error("This chapter has pending changes. Approve or reject those before accepting a proposal.");
  const numbers = selected === null ? record.edits.map((edit) => edit.number) : selected;
  if (!Array.isArray(numbers) || !numbers.length || new Set(numbers).size !== numbers.length || numbers.some((number) => !record.edits.some((edit) => edit.number === number))) throw new Error("Choose one or more ready edit numbers.");
  const chosen = record.edits.filter((edit) => numbers.includes(edit.number));
  const checked = validateRepairEdits(root, project, inputs, { edits: chosen, declined: [] });
  if (checked.dropped_edits.length) throw new Error(`Edits cannot be accepted: ${checked.dropped_edits.map((edit) => edit.why).join("; ")}`);
  const blocking = checked.remaining_findings.filter((finding) => finding.severity === "block");
  if (blocking.length) throw new Error(`Blocking findings would remain: ${blocking.map((finding) => `${finding.id} ${finding.source}, ${finding.scene_id} paragraph ${finding.paragraph}`).join("; ")}. Make a ruling on the Findings page or Ask again.`);
  const proposed = applyEditsInMemory(inputs.scenes, chosen);
  const originals = new Map();
  for (const scene of proposed.filter((item) => chosen.some((edit) => edit.scene_id === item.id))) {
    const raw = readFileSync(scene.path, "utf8");
    originals.set(scene.path, raw);
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const normalized = raw.replaceAll("\r\n", "\n");
    const source = inputs.scenes.find((item) => item.id === scene.id).prose;
    const start = normalized.indexOf("\n", normalized.search(/^[\t ]*---[\t ]*$/mu)) + 1;
    const offset = normalized.indexOf(source, start);
    const replaced = normalized.slice(0, offset) + scene.prose + normalized.slice(offset + source.length);
    if (extractProse(replaced) !== scene.prose) throw new Error("Replacement changed the scene structure.");
    writeFileSync(scene.path, replaced.replaceAll("\n", eol));
  }
  let approval;
  try { approval = approveChapter(root, project, Number(chapter), note, { subject: `Repairs accepted, chapter ${chapter} (${chosen.length} of ${record.edits.length} edits)${note.trim() ? `: ${note.trim()}` : ""}` }); }
  catch (error) { for (const [path, raw] of originals) writeFileSync(path, raw); throw error; }
  writeRecord(proposalPath(root, chapter), { ...record, status: "accepted", accepted_edits: numbers, accepted_at: new Date().toISOString(), approval: approval.id, acceptance_note: note });
  return approval;
}

export function rejectProposal(root, chapter, note = "") {
  const record = readProposal(root, chapter);
  if (!record) throw new Error(`Chapter ${chapter} has no proposal.`);
  if (record.status === "accepted") throw new Error("This proposal was already accepted. Use history to undo an approval.");
  const path = join(root, ".weaver", "rejected", "proposals", `chapter-${chapter}-${randomUUID()}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeRecord(proposalPath(root, chapter), { ...record, rejected_at: new Date().toISOString(), rejection_note: note });
  renameSync(proposalPath(root, chapter), path);
  return { chapter, path };
}
