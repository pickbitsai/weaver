// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { countWords, extractProse } from "../engine/manuscript.mjs";
import { buildRepairPacket, readProposal, repairChapter, repairInputs, validateRepairAnswer, validateRepairEdits } from "../engine/repair.mjs";
import { runBook } from "../engine/run.mjs";
import { startStudio } from "../engine/studio.mjs";
import { makeBook } from "./helpers/book.mjs";
import { authorEnv } from "./helpers/env.mjs";

const quiet = () => {};
const paragraphs = [
  "Rill waits — beside the gate — holding a small silver key.",
  "Tovan listens — near the wall — keeping both tired eyes open.",
  "Rain falls — across the road — washing the old stones clean."
];
const dashRule = { id: "em-dashes", type: "count-per-words", severity: "block", text: "—", max: 1,
  per_words: 30, unit: "scene", scope: "narration", message: "Use fewer em dashes." };
function replaceProse(path, prose) {
  const bytes = readFileSync(path, "utf8");
  writeFileSync(path, bytes.replace(extractProse(bytes), prose));
}
function fixture(t, { rule = dashRule, prose = paragraphs.join("\n\n"), second = null } = {}) {
  const context = makeBook(t);
  mkdirSync(join(context.root, ".weaver"), { recursive: true });
  replaceProse(context.paths[0], prose);
  if (second !== null) replaceProse(context.paths[1], second);
  writeFileSync(join(context.root, "quality", "rules.json"), JSON.stringify({ version: 1, rules: [rule] }));
  return { ...context, inputs: repairInputs(context.root, context.project, 1) };
}
function edit(inputs, sceneId, paragraph, change = (text) => text.replaceAll("—", ",")) {
  const before = inputs.scenes.find((scene) => scene.id === sceneId).prose.split(/\n\s*\n/u)[paragraph - 1];
  return { scene_id: sceneId, paragraph, finding_ids: [inputs.findings[0].id], before, after: change(before), reason: "Reduce the counted occurrences." };
}
const answerText = (answer) => `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``;
async function fakeRepair(context, edits) {
  writeFileSync(join(context.root, ".weaver", "repair-answer.json"), JSON.stringify({ edits, declined: [] }));
  return repairChapter(context.root, context.project, { chapter: 1, run: true, onProgress: quiet });
}
function packetFindings(packet) {
  return JSON.parse(packet.prompt.split("## Targeted findings\n")[1].split("\n\n## Author note")[0]);
}

test("scene counting packet lists all three occurrence paragraphs and its numeric goal", (t) => {
  const { root, project, inputs } = fixture(t);
  assert.equal(countWords(paragraphs.join("\n\n")), 30);
  assert.equal(inputs.findings.length, 1);
  const packet = buildRepairPacket(root, project, 1, { inputs });
  const [finding] = packetFindings(packet);
  assert.deepEqual(finding.locations, [1, 2, 3].map((paragraph) => ({ scene_id: "1-1", paragraph, count: 2 })));
  assert.equal(finding.goal, "scene has 6 em dashes in narration, limit 1 for its length (30 words); remove at least 5.");
  assert.match(packet.prompt, /measurement may appear in several edits/u);
});

test("fake-host partial scene repair keeps the edit when the finding moves from paragraph 1 to 2", async (t) => {
  const context = fixture(t);
  const original = readFileSync(context.paths[0], "utf8");
  const result = await fakeRepair(context, [edit(context.inputs, "1-1", 1)]);
  assert.equal(result.status, "ready");
  assert.equal(result.edits.length, 1);
  assert.deepEqual(result.dropped_edits, []);
  assert.equal(result.edits[0].word_delta, 0);
  assert.equal(result.remaining_findings[0].paragraph, 2);
  assert.equal(result.remaining_findings[0].count, 4);
  assert.equal(result.edits[0].validation, "partly fixed: 6 → 4 (limit 1)");
  assert.deepEqual(result.edits[0].findings_fixed, []);
  assert.deepEqual(result.edits[0].findings_partly_fixed, [context.inputs.findings[0].id]);
  assert.deepEqual(result.target_results[0], { finding_id: context.inputs.findings[0].id, status: "partly-fixed", before: 6, after: 4, limit: 1, message: "partly fixed: 6 → 4 (limit 1)" });
  assert.equal(readFileSync(context.paths[0], "utf8"), original);
  const server = await startStudio({ root: context.root, port: 0 });
  try {
    const page = await (await fetch(`http://127.0.0.1:${server.address().port}/proposals`)).text();
    assert.match(page, /partly fixed: 6 → 4 \(limit 1\)/u);
  } finally { await new Promise((done) => server.close(done)); }
});

test("fake-host edits across all three paragraphs keep every edit and fix the scene target", async (t) => {
  const context = fixture(t);
  const edits = [1, 2, 3].map((paragraph) => edit(context.inputs, "1-1", paragraph));
  assert.equal(validateRepairAnswer(answerText({ edits, declined: [] }), context.inputs.findings).ok, true);
  const result = await fakeRepair(context, edits);
  assert.equal(result.status, "ready");
  assert.equal(result.edits.length, 3);
  assert.deepEqual(result.dropped_edits, []);
  assert.deepEqual(result.remaining_findings, []);
  assert.equal(result.target_results[0].status, "fixed");
  assert.equal(result.target_results[0].after, 0);
  for (const kept of result.edits) assert.deepEqual(kept.findings_fixed, [context.inputs.findings[0].id]);
});

test("fake-host added dash in another flagged paragraph is dropped and all-dropped status reaches CLI and studio", async (t) => {
  const context = fixture(t);
  const worse = edit(context.inputs, "1-1", 2, (text) => text.replace("both tired", "both — tired"));
  const result = await fakeRepair(context, [worse]);
  assert.equal(result.status, "no-usable-edits");
  assert.equal(result.edits.length, 0);
  assert.equal(result.declined.length, 0);
  assert.equal(result.dropped_edits.length, 1);
  assert.match(result.dropped_edits[0].why, /em-dashes:.*count from 6 to 7/u);
  assert.equal(readProposal(context.root, 1).status, "no-usable-edits");
  const cli = (args) => spawnSync(process.execPath, [resolve("scripts/weaver.mjs"), ...args, "--root", context.root], { encoding: "utf8", env: authorEnv() });
  const json = cli(["proposals", "--json"]);
  assert.equal(json.status, 0, json.stdout + json.stderr);
  assert.equal(JSON.parse(json.stdout)[0].status, "no-usable-edits");
  assert.match(JSON.parse(json.stdout)[0].dropped_edits[0].why, /count from 6 to 7/u);
  const plain = cli(["proposals"]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /no usable edits/u);
  assert.match(plain.stdout, /count from 6 to 7/u);
  assert.match(plain.stdout, /Ask again: weaver repair --chapter 1 --run/u);
  const server = await startStudio({ root: context.root, port: 0 });
  try {
    const page = await (await fetch(`http://127.0.0.1:${server.address().port}/proposals`)).text();
    assert.match(page, /no-usable-edits/u);
    assert.match(page, /count from 6 to 7/u);
    assert.match(page, /data-action="proposal-again" data-chapter="1">Ask again/u);
    assert.match(page, /data-action="proposal-accept"[^>]*disabled/u);
  } finally { await new Promise((done) => server.close(done)); }
});

test("a kept reduction does not hide an increase in a later edit", async (t) => {
  const context = fixture(t);
  const result = await fakeRepair(context, [edit(context.inputs, "1-1", 1), edit(context.inputs, "1-1", 2, (text) => text.replace("both tired", "both — tired"))]);
  assert.equal(result.edits.length, 1);
  assert.equal(result.dropped_edits.length, 1);
  assert.equal(result.dropped_edits[0].paragraph, 2);
  assert.match(result.dropped_edits[0].why, /count from 4 to 5/u);
  assert.equal(result.edits[0].validation, "partly fixed: 6 → 4 (limit 1)");
});

test("counted locations respect narration scope and do not permit unrelated paragraphs", (t) => {
  const context = fixture(t, { prose: `${paragraphs.join("\n\n")}\n\n"Wait — here — now."` });
  const [finding] = packetFindings(buildRepairPacket(context.root, context.project, 1));
  assert.equal(finding.count, 6);
  assert.equal(finding.measurement.words, 30);
  assert.deepEqual(finding.locations.map((location) => location.paragraph), [1, 2, 3]);
  const result = validateRepairEdits(context.root, context.project, context.inputs, { edits: [edit(context.inputs, "1-1", 4)], declined: [] });
  assert.equal(result.edits.length, 0);
  assert.match(result.dropped_edits[0].why, /unflagged paragraph/u);
});

test("chapter counting locations cross scenes and partial repair survives re-anchoring to another scene", async (t) => {
  const context = fixture(t, { rule: { ...dashRule, unit: "chapter" }, prose: paragraphs[0], second: paragraphs.slice(1).join("\n\n") });
  assert.equal(context.inputs.findings.length, 1);
  const [finding] = packetFindings(buildRepairPacket(context.root, context.project, 1));
  assert.deepEqual(finding.locations, [{ scene_id: "1-1", paragraph: 1, count: 2 }, { scene_id: "1-2", paragraph: 1, count: 2 }, { scene_id: "1-2", paragraph: 2, count: 2 }]);
  assert.match(finding.goal, /chapter has 6 em dashes.*limit 1.*remove at least 5/u);
  const first = edit(context.inputs, "1-1", 1);
  const partial = await fakeRepair(context, [first]);
  assert.equal(partial.edits.length, 1);
  assert.equal(partial.remaining_findings[0].scene_id, "1-2");
  assert.equal(partial.edits[0].validation, "partly fixed: 6 → 4 (limit 1)");
  const full = await fakeRepair(context, [first, edit(context.inputs, "1-2", 1), edit(context.inputs, "1-2", 2)]);
  assert.equal(full.edits.length, 3);
  assert.equal(full.target_results[0].status, "fixed");
  assert.deepEqual(full.remaining_findings, []);
});

test("scene sentence-start share targets counted openings, with numeric partial and full repairs", async (t) => {
  const rule = { id: "i-starts", type: "sentence-start-share", severity: "block", scope: "narration", unit: "scene", word: "I", max_share: 1 / 6, min_sentences: 3, message: "Vary sentence openings." };
  const context = fixture(t, { rule, prose: 'We wait. We listen.\n\nI wait. I listen.\n\nI turn. I leave.\n\n"I run."' });
  const [finding] = packetFindings(buildRepairPacket(context.root, context.project, 1));
  assert.deepEqual(finding.locations.map((location) => location.paragraph), [2, 3]);
  assert.equal(finding.measurement.sentences, 6);
  assert.match(finding.goal, /4 sentences starting with "I" in narration out of 6 sentences, limit 1 .*change at least 3 openings/u);
  const edits = [2, 3].map((paragraph) => edit(context.inputs, "1-1", paragraph, (text) => text.replaceAll("I ", "We ")));
  const partial = await fakeRepair(context, edits.slice(0, 1));
  assert.equal(partial.edits.length, 1);
  assert.equal(partial.edits[0].validation, "partly fixed: 4 → 2 (limit 1)");
  const full = await fakeRepair(context, edits);
  assert.equal(full.edits.length, 2);
  assert.equal(full.target_results[0].status, "fixed");
  const unflagged = validateRepairEdits(context.root, context.project, context.inputs, { edits: [edit(context.inputs, "1-1", 1, (text) => text.replace("wait", "pause"))], declined: [] });
  assert.match(unflagged.dropped_edits[0].why, /unflagged paragraph/u);
});

test("measurement coverage permits multiple locations but rejects missing coverage, repeats, and edit plus decline", (t) => {
  const { inputs } = fixture(t);
  const first = edit(inputs, "1-1", 1);
  for (const value of [
    { edits: [], declined: [] },
    { edits: [{ ...first, finding_ids: [inputs.findings[0].id, inputs.findings[0].id] }], declined: [] },
    { edits: [first], declined: [{ finding_id: inputs.findings[0].id, reason: "Needs author input." }] }
  ]) assert.equal(validateRepairAnswer(answerText(value), inputs.findings).ok, false);
});

test("a shorter denominator that increases the rate is dropped even with an unchanged count", (t) => {
  const context = fixture(t);
  const result = validateRepairEdits(context.root, context.project, context.inputs, { edits: [edit(context.inputs, "1-1", 2, () => "Tovan — waits — here.")], declined: [] });
  assert.equal(result.edits.length, 0);
  assert.match(result.dropped_edits[0].why, /count from 6 to 6 \(rate from 6 to/u);
});

test("whole-book run summary records no usable edits with drop reasons and Ask again", async (t) => {
  const context = fixture(t);
  writeFileSync(join(context.root, ".weaver", "repair-answer.json"), JSON.stringify({ edits: [edit(context.inputs, "1-1", 2, (text) => text.replace("both tired", "both — tired"))], declined: [] }));
  const result = await runBook(context.root, context.project, { run: true, throughChapter: 1, onProgress: quiet });
  assert.equal(result.summary.proposals_ready, 0);
  assert.deepEqual(result.summary.failures, []);
  assert.equal(result.summary.no_usable_edits.length, 1);
  const [proposal] = result.summary.no_usable_edits;
  assert.equal(proposal.chapter, 1);
  assert.equal(proposal.status, "no-usable-edits");
  assert.match(proposal.dropped_edits[0].why, /count from 6 to 7/u);
  assert.equal(proposal.ask_again, "weaver repair --chapter 1 --run");
  assert.equal(result.units.at(-1).status, "no-usable-edits");
  assert.deepEqual(JSON.parse(readFileSync(result.path, "utf8")).summary, result.summary);
});
