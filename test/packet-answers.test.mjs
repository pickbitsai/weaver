// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runHost } from "../engine/host.mjs";
import { importBook } from "../engine/import.mjs";
import { initializeProject } from "../engine/init.mjs";
import { buildPacket, canonicalVerdict, checkVerdict, extractJsonBlock, readVerdictLine, validateAndRepair, verdictWords } from "../engine/packets.mjs";
import { readProject } from "../engine/project.mjs";
import { repairChapter } from "../engine/repair.mjs";
import { buildReviewPacket, reviewRecordPath, submitReviewPacket, validateReviewAnswer } from "../engine/review.mjs";
import { runBook } from "../engine/run.mjs";
import { bootstrapState, submitStatePacket } from "../engine/state.mjs";
import { makeBook } from "./helpers/book.mjs";
import { authorEnv } from "./helpers/env.mjs";

const ROOT = resolve(".");
const FIXTURES = join(ROOT, "test", "fixtures", "packet-answers");
const ANSWER_HOST = join(ROOT, "test", "fixtures", "answer-host.mjs");
const STYLE = { label: "STYLE", verdicts: ["CONSISTENT", "DRIFT"] };
const paragraphs = [{ scene_id: "1-1", paragraph: 1, text: "Pellam waits beside the eastern gate before the careful dawn arrives." }];
const finding = { severity: "minor", scene_id: "1-1", paragraph: 1, quote: "Pellam waits beside the eastern gate",
  issue: "The wording feels abrupt.", repair: "Smooth the smallest phrase." };
const jsonBlock = (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const answer = (verdict = "DRIFT", line = "STYLE: DRIFT", findings = []) => `${line}\n\n${jsonBlock({ verdict, findings })}\n`;
const response = (text) => ({ ok: true, text, attempts: 1 });
const answerFile = (packet) => `.weaver/packets/${packet.id}.answer.txt`;

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "weaver-packet-answers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function book(t, mode = "disagree", hostPath = ANSWER_HOST) {
  const root = temporaryRoot(t);
  initializeProject(root, { projectId: "packet-answers", title: "Packet Answers", empty: true });
  const source = join(root, "original.md");
  writeFileSync(source, `# Pellam\n\n${paragraphs[0].text}\n\n* * *\n\n# Ivra\n\nIvra carries a quiet message into the courtyard as morning advances.\n`);
  importBook(root, readProject(root), source);
  const project = readProject(root);
  project.host = { command: process.execPath, args: [hostPath, mode], concurrency: 1, timeout_seconds: 10 };
  writeFileSync(join(root, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
  return { root, project };
}

function cli(root, args) {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts", "weaver.mjs"), ...args, "--root", root],
    { cwd: ROOT, env: authorEnv(), encoding: "utf8" });
  assert.equal(result.error, undefined);
  return result;
}

function readPackets(root) {
  return readdirSync(join(root, ".weaver", "packets")).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(root, ".weaver", "packets", name), "utf8")));
}

const realParagraphs = JSON.parse(readFileSync(join(FIXTURES, "paragraphs.json"), "utf8"));
const fixtureNames = readdirSync(FIXTURES).filter((name) => name.endsWith(".answer.txt"));
assert.equal(fixtureNames.length, 4);
for (const name of fixtureNames) {
  for (const endings of ["original", "CRLF"]) test(`real answer records every finding: ${name}, ${endings}`, () => {
    const raw = readFileSync(join(FIXTURES, name), "utf8");
    const text = endings === "CRLF" ? raw.replace(/\r?\n/gu, "\r\n") : raw;
    const document = JSON.parse([...text.matchAll(/```json\s*([\s\S]*?)```/giu)].at(-1)[1]);
    const result = validateReviewAnswer(text, "style", realParagraphs);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.value.verdict, "CONSISTENT");
    assert.equal(result.value.findings.length, document.findings.length);
    assert.equal(result.value.dropped_findings, 0);
    assert.deepEqual(result.warnings, []);
  });
}

test("verdict line formatting and placement do not change the JSON verdict", () => {
  const lines = ["STYLE: DRIFT", "**STYLE: DRIFT**", "**STYLE:** DRIFT", "STYLE: **DRIFT**", "__STYLE: DRIFT__",
    "Style: drift.", "`STYLE: DRIFT`", "## STYLE: DRIFT", "> STYLE: DRIFT", "- STYLE: DRIFT", "STYLE - DRIFT",
    "STYLE: DRIFT — two passages slip into modern idiom.", "A short preamble.\n\nSTYLE: DRIFT", "```\nSTYLE: DRIFT\n```", "",
    "+ STYLE: DRIFT", "* STYLE: DRIFT", "• STYLE: DRIFT", "1. STYLE: DRIFT", "> ## 2. __STYLE: DRIFT__",
    "STYLE – DRIFT", "STYLE — DRIFT", "STYLE : DRIFT", '“STYLE: DRIFT”'];
  const texts = [...lines.map((line) => answer("DRIFT", line)), `${jsonBlock({ verdict: "DRIFT", findings: [] })}\nSTYLE: DRIFT\n`];
  for (const original of texts) for (const text of [original, original.replace(/\n/gu, "\r\n")]) {
    const result = validateReviewAnswer(text, "style", paragraphs);
    assert.equal(result.ok, true, text);
    assert.equal(result.value.verdict, "DRIFT", text);
    assert.deepEqual(result.warnings, [], text);
  }
  for (const verdict of ["drift", "Drift", "STYLE: DRIFT", "style: drift", "**DRIFT**", "DRIFT.", " DRIFT "]) {
    const result = validateReviewAnswer(answer(verdict), "style", paragraphs);
    assert.equal(result.ok, true, verdict);
    assert.equal(result.value.verdict, "DRIFT");
    assert.deepEqual(result.warnings, []);
  }
});

test("disagreeing and unknown verdict lines warn while the JSON verdict records", () => {
  const result = validateReviewAnswer(answer("CONSISTENT"), "style", paragraphs);
  assert.equal(result.ok, true);
  assert.equal(result.value.verdict, "CONSISTENT");
  assert.deepEqual(result.warnings, ["The verdict line says DRIFT but the JSON block says CONSISTENT. Weaver recorded CONSISTENT, from the JSON block."]);
  const unknown = validateReviewAnswer(answer("CONSISTENT", "**STYLE: MOSTLY CONSISTENT**"), "style", paragraphs);
  assert.equal(unknown.ok, true);
  assert.equal(unknown.value.verdict, "CONSISTENT");
  assert.deepEqual(unknown.warnings, ['The verdict line "STYLE: MOSTLY CONSISTENT" does not name CONSISTENT or DRIFT. Weaver recorded CONSISTENT, from the JSON block.']);
});

test("only the full lens vocabulary is accepted, with one useful error and no line fallback", () => {
  for (const verdict of ["MOSTLY CONSISTENT", "MINOR DRIFT", "PASS", "CRITIC: DRIFT", "", undefined, 3, null, "CONSISTENT with notes", "DRIFTING"]) {
    const text = answer(verdict, "STYLE: CONSISTENT");
    // Passing undefined to answer uses its default; explicitly omit the field instead.
    const result = validateReviewAnswer(verdict === undefined ? `STYLE: CONSISTENT\n${jsonBlock({ findings: [] })}` : text, "style", paragraphs);
    assert.equal(result.ok, false, String(verdict));
    assert.deepEqual(result.errors, [`The JSON block's "verdict" must be exactly one of these words: CONSISTENT or DRIFT. This answer gave ${verdict === undefined ? "no verdict" : JSON.stringify(verdict)}.`]);
    assert.deepEqual(result.warnings, []);
  }
  const lens = { id: "character-audit", verdicts: ["QUIET", "ALERT"] };
  const custom = validateReviewAnswer(answer("character-audit: ALERT", "**Character-Audit: alert**"), lens, paragraphs);
  assert.equal(custom.ok, true);
  assert.equal(custom.value.verdict, "ALERT");
  assert.deepEqual(custom.warnings, []);
  for (const verdict of ["STYLE: ALERT", "CONSISTENT"]) {
    const result = validateReviewAnswer(answer(verdict, "Character-Audit: ALERT"), lens, paragraphs);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /QUIET or ALERT/u);
  }
  const tone = validateReviewAnswer(answer("needs_work", "**TONE: NEEDS_WORK**"), { id: "tone", verdicts: ["NEEDS_WORK", "FINE"] }, paragraphs);
  assert.equal(tone.ok, true);
  assert.equal(tone.value.verdict, "NEEDS_WORK");
  assert.deepEqual(tone.warnings, []);
});

test("canonical verdicts remove decoration but preserve whole words and vocabulary spelling", () => {
  for (const value of ["__DRIFT__", "~~DRIFT~~", '"DRIFT"', "‘DRIFT’", "“drift”", "DRIFT.,;:!?", "STYLE DRIFT",
    "style - drift", "STYLE–DRIFT", "STYLE — DRIFT", " STYLE\t:\t__DRIFT__ ", "D*R`I~FT", "STYLE:_DRIFT_"]) {
    assert.equal(canonicalVerdict(value, STYLE), "DRIFT", value);
  }
  for (const value of [undefined, null, false, 3, {}, [], "STYLES: DRIFT", "STYLEDRIFT", "STYLE/DRIFT", "STYLE: DRIFT with notes"])
    assert.equal(canonicalVerdict(value, STYLE), null);
  const custom = { label: "TONE", verdicts: ["TONE-ALERT", "ALERT", "Needs_Work", "NEEDS__WORK"] };
  assert.equal(canonicalVerdict("tone-alert", custom), "TONE-ALERT");
  assert.equal(canonicalVerdict("__needs_work__", custom), "Needs_Work");
  assert.equal(canonicalVerdict("needs__work", custom), "NEEDS__WORK");
  assert.equal(canonicalVerdict("NEEDSWORK", custom), null);
  assert.equal(canonicalVerdict("drift", { verdicts: ["DRIFT"] }), "DRIFT");
  assert.equal(canonicalVerdict("STYLE: DRIFT", { verdicts: ["DRIFT"] }), null);
  assert.equal(verdictWords(["CONSISTENT", "DRIFT"]), "CONSISTENT or DRIFT");
  assert.equal(verdictWords(["A", "B", "C"]), "A, B or C");
  assert.equal(verdictWords(["A"]), "A");
  assert.equal(verdictWords([]), "");
});

test("the last JSON block supplies exact start and end offsets even when malformed", () => {
  const first = jsonBlock({ verdict: "DRIFT" });
  for (const last of [jsonBlock({ verdict: "CONSISTENT" }), "```json\r\nnot json\r\n```"]) {
    const text = `${first}\r\nBefore.\r\n${last}\r\nAfter.`;
    const parsed = extractJsonBlock(text);
    assert.equal(parsed.start, text.indexOf(last));
    assert.equal(parsed.end, parsed.start + last.length);
    assert.equal(text.slice(parsed.start, parsed.end), last);
    assert.equal(text.slice(parsed.end), "\r\nAfter.");
    assert.equal(parsed.ok, !last.includes("not json"));
    if (parsed.ok) assert.equal(parsed.value.verdict, "CONSISTENT");
    else assert.match(parsed.errors[0], /invalid JSON/u);
  }
  assert.equal(extractJsonBlock("no block").ok, false);
});

test("verdict line scanning uses the first labelled line outside the authoritative JSON", () => {
  const text = answer("DRIFT", "Preamble.\r\n> 1. **STYLE: CONSISTENT**\r\nSTYLE: DRIFT") + "STYLE: DRIFT\r\n";
  const parsed = extractJsonBlock(text);
  assert.deepEqual(readVerdictLine(text, { ...STYLE, ...parsed }), { line: "STYLE: CONSISTENT", said: "CONSISTENT", verdict: "CONSISTENT" });
  assert.equal(checkVerdict(text, parsed.value, { ...STYLE, ...parsed }).warnings.length, 1);
  const inside = '```json\n{\n"verdict":"DRIFT",\n"findings":[],\n"note":"\nSTYLE: CONSISTENT\n"\n}\n```';
  const offsets = extractJsonBlock(inside);
  assert.equal(readVerdictLine(inside, { ...STYLE, ...offsets }), null);
  const after = `${inside}\r\nSTYLE: DRIFT — a note.\r\nSTYLE: CONSISTENT`;
  assert.deepEqual(readVerdictLine(after, { ...STYLE, ...offsets }), { line: "STYLE: DRIFT — a note.", said: "DRIFT — a note.", verdict: "DRIFT" });
  for (const line of ["STYLE: MOSTLY CONSISTENT", "STYLE: 3DRIFT", "STYLE: DRIFTING", "STYLE: DRIFT-extra"]) {
    const value = answer("CONSISTENT", line);
    assert.equal(readVerdictLine(value, { ...STYLE, ...extractJsonBlock(value) }).verdict, null);
  }
  for (const line of ["STYLES: DRIFT", "STYLE DRIFT", "A STYLE: DRIFT"])
    assert.equal(readVerdictLine(answer("DRIFT", line), { ...STYLE, ...extractJsonBlock(answer("DRIFT", line)) }), null);
});

test("JSON object and findings-array checks remain required and carry empty warnings", () => {
  for (const value of [null, [], "DRIFT", 3]) {
    const result = validateReviewAnswer(jsonBlock(value), "style", paragraphs);
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, ["answer must be a JSON object"]);
    assert.deepEqual(result.warnings, []);
  }
  const missing = validateReviewAnswer(jsonBlock({ verdict: "DRIFT" }), "style", paragraphs);
  assert.deepEqual(missing.errors, ["findings must be an array"]);
  for (const text of ["no block", "```json\nnot json\n```"])
    assert.deepEqual(validateReviewAnswer(text, "style", paragraphs).warnings, []);
});

test("one repair round names the allowed words, records canonical verdict, and saves the failed first answer", async (t) => {
  const { root, project } = book(t);
  const packet = buildReviewPacket(root, project, 1, "style");
  const first = ` \r\n${answer("MOSTLY CONSISTENT")}\r\n `;
  let calls = 0;
  const result = await submitReviewPacket(root, project, packet, first, { host: async (bookRoot, configuration, prompt) => {
    calls++;
    assert.equal(bookRoot, root);
    assert.equal(configuration, project);
    const error = validateReviewAnswer(first, "style", paragraphs).errors[0];
    assert.equal(prompt, `${packet.prompt}\n\nYour previous answer failed validation:\n- ${error}\nReturn the complete corrected answer only.`);
    assert.match(prompt, /CONSISTENT or DRIFT/u);
    return response(answer("style: consistent", "STYLE: CONSISTENT"));
  } });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.record.verdict, "CONSISTENT");
  assert.equal(Object.hasOwn(result.record, "warnings"), false);
  assert.equal(JSON.parse(readFileSync(reviewRecordPath(root, 1, "style"), "utf8")).verdict, "CONSISTENT");
  assert.equal(readFileSync(join(root, answerFile(packet)), "utf8"), first);
});

test("a second invalid verdict fails with no review record and preserves the latest failed bytes", async (t) => {
  const { root, project } = book(t);
  const packet = buildReviewPacket(root, project, 1, "style");
  const second = `  ${answer("MINOR DRIFT")}\r\n `;
  let calls = 0;
  const result = await submitReviewPacket(root, project, packet, answer("MOSTLY CONSISTENT"), { host: async () => { calls++; return response(second); } });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /CONSISTENT or DRIFT/u);
  assert.equal(existsSync(reviewRecordPath(root, 1, "style")), false);
  assert.equal(result.answer_file, answerFile(packet));
  assert.equal(readFileSync(join(root, result.answer_file), "utf8"), second);
});

test("a valid first review creates no failed-answer file and never calls the host", async (t) => {
  const { root, project } = book(t);
  const packet = buildReviewPacket(root, project, 1, "style");
  const result = await submitReviewPacket(root, project, packet, answer(), { host: async () => assert.fail("unexpected host call") });
  assert.equal(result.ok, true);
  assert.equal(existsSync(join(root, answerFile(packet))), false);
});

for (const [name, bad] of [["invented quote", { quote: "Corso invents this absent sentence" }], ["two-word quote", { quote: "Pellam waits" }], ["wrong paragraph", { paragraph: 2 }]]) {
  test(`findings remain strict and only the invalid finding is dropped: ${name}`, async (t) => {
    const { root, project } = book(t);
    const packet = buildReviewPacket(root, project, 1, "style");
    const text = answer("STYLE: DRIFT", "STYLE: DRIFT", [{ ...finding, ...bad }, finding]);
    const checked = validateReviewAnswer(text, "style", paragraphs);
    assert.equal(checked.ok, false);
    assert.deepEqual(checked.errors, ["finding 1 has an invalid location, quote, severity, issue, or repair"]);
    const result = await submitReviewPacket(root, project, packet, text, { host: async () => response(text) });
    assert.equal(result.ok, true);
    assert.equal(result.record.verdict, "DRIFT");
    assert.deepEqual(result.record.findings, [finding]);
    assert.equal(result.record.dropped_findings, 1);
    assert.equal(Object.hasOwn(result.record, "warnings"), false);
    assert.equal(readFileSync(join(root, answerFile(packet)), "utf8"), text);
  });
}

test("the findings fallback uses the final answer's canonical verdict and warnings", async (t) => {
  const { root, project } = book(t);
  const packet = buildReviewPacket(root, project, 1, "style");
  const bad = { ...finding, quote: "Corso invents this absent sentence" };
  const repaired = answer("style: consistent", "STYLE: DRIFT", [bad, finding]);
  const result = await submitReviewPacket(root, project, packet, answer("STYLE: DRIFT", "STYLE: DRIFT", [bad]), { host: async () => response(repaired) });
  assert.equal(result.ok, true);
  assert.equal(result.record.verdict, "CONSISTENT");
  assert.deepEqual(result.record.findings, [finding]);
  assert.equal(result.record.dropped_findings, 1);
  assert.deepEqual(result.record.warnings, validateReviewAnswer(repaired, "style", paragraphs).warnings);
  assert.equal(result.record.warnings.length, 1);
  const keys = Object.keys(result.record);
  assert.equal(keys[keys.indexOf("dropped_findings") + 1], "warnings");
});

test("review command and submit print recorded warnings, and a current review still skips", (t) => {
  const { root, project } = book(t);
  const ran = cli(root, ["review", "--chapter", "1", "--lenses", "style", "--run"]);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const record = JSON.parse(readFileSync(reviewRecordPath(root, 1, "style"), "utf8"));
  assert.equal(record.verdict, "CONSISTENT");
  assert.equal(record.findings.length, 1);
  assert.equal(record.warnings.length, 1);
  assert.ok(ran.stdout.includes(`Chapter 1 style: recorded (1 findings, 0 dropped)\nChapter 1 style: warning: ${record.warnings[0]}`));
  const again = cli(root, ["review", "--chapter", "1", "--lenses", "style", "--run"]);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /Chapter 1 style: skipped, already current/u);
  const packet = buildReviewPacket(root, project, 1, "style");
  const path = join(root, "answer.txt");
  writeFileSync(path, answer("consistent", "STYLE: DRIFT", [finding]));
  const submitted = cli(root, ["submit", packet.id, "--file", path]);
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
  assert.ok(submitted.stdout.includes(`Chapter 1 style: recorded (1 findings, 0 dropped)\nChapter 1 style: warning: ${record.warnings[0]}`));
});

test("invalid review command and submit name the saved answer", (t) => {
  const { root, project } = book(t, "invalid");
  const packet = buildReviewPacket(root, project, 1, "style");
  const ran = cli(root, ["review", "--chapter", "1", "--lenses", "style", "--run"]);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /Chapter 1 style: answer invalid after repair:/u);
  assert.ok(ran.stdout.includes(` (Weaver saved the answer in ${answerFile(packet)})`));
  assert.equal(existsSync(join(root, answerFile(packet))), true);
  const path = join(root, "answer.txt");
  writeFileSync(path, answer("PASS"));
  const submitted = cli(root, ["submit", packet.id, "--file", path]);
  assert.equal(submitted.status, 1, submitted.stdout + submitted.stderr);
  assert.ok(submitted.stdout.includes(`Packet ${packet.id}: answer invalid after repair:`));
  assert.ok(submitted.stdout.includes(` (Weaver saved the answer in ${answerFile(packet)})`));
});

test("shared repair passes warnings from the returned answer and keeps existing diagnostics", async (t) => {
  const root = temporaryRoot(t);
  const packet = buildPacket("FUTURE", "item", "Generic prompt", {}, "generic-1");
  const validator = (text) => ({ ok: text === "valid", errors: text === "valid" ? [] : ["invalid"], warnings: [text, 3] });
  const repaired = await validateAndRepair(root, {}, packet, "first\r\n ", validator, { host: async () => response("valid") });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.answer_file, answerFile(packet));
  assert.deepEqual(repaired.warnings, ["valid", "3"]);
  assert.equal(readFileSync(join(root, answerFile(packet)), "utf8"), "first\r\n ");
  const valid = await validateAndRepair(root, {}, packet, "valid", validator, { host: async () => assert.fail("unexpected host call") });
  assert.equal(Object.hasOwn(valid, "answer_file"), false);
  assert.deepEqual(valid.warnings, ["valid", "3"]);
  assert.equal(readFileSync(join(root, answerFile(packet)), "utf8"), "first\r\n ");
  const failed = await validateAndRepair(root, {}, packet, "second", validator, { host: async () => response("third") });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.warnings, ["third", "3"]);
  assert.equal(failed.answer_file, answerFile(packet));
  assert.equal(readFileSync(join(root, answerFile(packet)), "utf8"), "third");
});

test("shared validators always return warning arrays, including array and exception results", async (t) => {
  const root = temporaryRoot(t);
  const packet = buildPacket("FUTURE", "item", "Generic prompt", {}, "generic-1");
  for (const validator of [() => [], () => ({ ok: true }), () => ({ ok: true, warnings: "ignored" })]) {
    const result = await validateAndRepair(root, {}, packet, "valid", validator, { host: async () => assert.fail("unexpected host call") });
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
  }
  for (const validator of [() => ["invalid"], () => null, () => { throw new Error("invalid"); }]) {
    const result = await validateAndRepair(root, {}, packet, "bad", validator, { host: async () => response("still bad") });
    assert.equal(result.ok, false);
    assert.deepEqual(result.warnings, []);
  }
});

test("host failure returns first-answer warnings and the saved diagnostic path", async (t) => {
  const root = temporaryRoot(t);
  const packet = buildPacket("FUTURE", "item", "Generic prompt", {}, "generic-1");
  const result = await validateAndRepair(root, {}, packet, " first\r\n", () => ({ ok: false, errors: ["invalid"], warnings: ["first warning"] }),
    { host: async () => ({ ok: false, error: "fixture host failed", attempts: 1 }) });
  assert.equal(result.ok, false);
  assert.equal(result.host_error, "fixture host failed");
  assert.deepEqual(result.warnings, ["first warning"]);
  assert.equal(result.answer_file, answerFile(packet));
  assert.equal(readFileSync(join(root, result.answer_file), "utf8"), " first\r\n");
  const review = book(t);
  const reviewPacket = buildReviewPacket(review.root, review.project, 1, "style");
  const failed = await submitReviewPacket(review.root, review.project, reviewPacket, answer("PASS"),
    { host: async () => ({ ok: false, error: "fixture host failed", attempts: 1 }) });
  assert.equal(failed.ok, false);
  assert.equal(failed.answer_file, answerFile(reviewPacket));
  assert.deepEqual(failed.errors, ["fixture host failed"]);
});

test("diagnostic writes require a lowercase twelve-digit hex packet id", async (t) => {
  const root = temporaryRoot(t);
  for (const id of ["../escape", "ABCDEF123456", "abc123", "abcdef1234567", "ghijkl123456", "abcdef123456\n", undefined]) {
    const result = await validateAndRepair(root, {}, { id, prompt: "Generic prompt" }, "bad", () => ["invalid"], { host: async () => response("still bad") });
    assert.equal(result.ok, false);
    assert.equal(Object.hasOwn(result, "answer_file"), false);
    assert.equal(existsSync(join(root, ".weaver")), false);
  }
});

test("diagnostic write errors cannot break validation or repair", async (t) => {
  const root = temporaryRoot(t);
  writeFileSync(join(root, ".weaver"), "a file blocks the diagnostic directory");
  const packet = buildPacket("FUTURE", "item", "Generic prompt", {}, "generic-1");
  for (const repaired of ["valid", "invalid"]) {
    const result = await validateAndRepair(root, {}, packet, "bad", (text) => text === "valid" ? [] : ["invalid"], { host: async () => response(repaired) });
    assert.equal(result.ok, repaired === "valid");
    assert.equal(Object.hasOwn(result, "answer_file"), false);
  }
});

test("STATE saves the exact malformed first answer and still records the scene", async (t) => {
  const { root, project } = book(t, "malformed-once", join(ROOT, "test", "fixtures", "fake-host.mjs"));
  const units = [];
  await bootstrapState(root, project, { run: true, sceneIds: ["1-1"], onProgress() {}, onUnit: (unit) => units.push(unit) });
  assert.equal(units[0].status, "recorded");
  const packet = readPackets(root).find((item) => item.kind === "STATE" && item.target === "1-1");
  assert.ok(packet);
  assert.equal(readFileSync(join(root, answerFile(packet)), "utf8"), "```json\nnot json\n```\n");
  assert.equal(existsSync(join(root, "narrative-state", "1-1.md")), true);
});

test("STATE failures surface the saved path in progress, units, and submit", async (t) => {
  const { root, project } = book(t, "invalid-quote", join(ROOT, "test", "fixtures", "fake-host.mjs"));
  const units = [], progress = [];
  await bootstrapState(root, project, { run: true, sceneIds: ["1-1"], onProgress: (line) => progress.push(line), onUnit: (unit) => units.push(unit) });
  const packet = readPackets(root).find((item) => item.kind === "STATE");
  assert.equal(units[0].status, "failed");
  assert.equal(units[0].answer_file, answerFile(packet));
  assert.ok(progress.some((line) => line.includes(` (Weaver saved the answer in ${answerFile(packet)})`)));
  const result = await submitStatePacket(root, project, packet.id, "broken JSON");
  assert.equal(result.ok, false);
  assert.equal(result.answer_file, answerFile(packet));
  const path = join(root, "answer.txt");
  writeFileSync(path, "broken JSON");
  const submitted = cli(root, ["submit", packet.id, "--file", path]);
  assert.equal(submitted.status, 1, submitted.stdout + submitted.stderr);
  assert.ok(submitted.stdout.includes(` (Weaver saved the answer in ${answerFile(packet)})`));
});

test("REPAIR saves a malformed attempt even when its proposal is ready", async (t) => {
  const { root, project } = makeBook(t, { mode: "malformed" });
  const record = await repairChapter(root, project, { chapter: 1, run: true, onProgress() {} });
  assert.equal(record.status, "ready");
  assert.equal(readFileSync(join(root, answerFile({ id: record.packet_id })), "utf8"), "broken JSON");
});

test("failed REPAIR proposals and submit carry the saved answer path", async (t) => {
  const { root, project } = makeBook(t);
  project.host = { command: process.execPath, args: [ANSWER_HOST, "invalid"], timeout_seconds: 10 };
  writeFileSync(join(root, "project.json"), JSON.stringify(project));
  const record = await repairChapter(root, project, { chapter: 1, run: true, host: async () => response("broken JSON"), onProgress() {} });
  assert.equal(record.status, "failed");
  assert.equal(record.answer_file, answerFile({ id: record.packet_id }));
  assert.equal(readFileSync(join(root, record.answer_file), "utf8"), "broken JSON");
  const path = join(root, "answer.txt");
  writeFileSync(path, "broken JSON");
  const submitted = cli(root, ["submit", record.packet_id, "--file", path]);
  assert.equal(submitted.status, 1, submitted.stdout + submitted.stderr);
  assert.ok(submitted.stdout.includes(`Packet ${record.packet_id}: answer invalid after repair:`));
  assert.ok(submitted.stdout.includes(` (Weaver saved the answer in ${record.answer_file})`));
});

test("whole-book review units and progress carry JSON verdict warnings", async (t) => {
  const { root, project } = makeBook(t);
  const progress = [];
  const host = async (bookRoot, configuration, prompt, options) => {
    if (!prompt.startsWith("# REVIEW")) return runHost(bookRoot, configuration, prompt, options);
    const [, label, first, second] = prompt.match(/^Start with ([A-Z0-9-]+): ([A-Za-z0-9_-]+) or ([A-Za-z0-9_-]+)\./mu);
    return response(answer(first, `${label}: ${second}`));
  };
  const result = await runBook(root, project, { run: true, host, onProgress: (line) => progress.push(line), sleep: async () => {} });
  const reviews = result.units.filter((unit) => unit.unit.includes(" review "));
  assert.equal(reviews.length, 6);
  for (const unit of reviews) {
    assert.equal(unit.status, "recorded");
    assert.equal(unit.warnings.length, 1);
    assert.ok(progress.includes(`${unit.unit}: warning: ${unit.warnings[0]}`));
    assert.equal(Object.hasOwn(unit, "answer_file"), false);
  }
});

test("whole-book invalid review units carry saved paths and omit empty warnings", async (t) => {
  const { root, project } = makeBook(t);
  const host = async (bookRoot, configuration, prompt, options) => prompt.startsWith("# REVIEW")
    ? response(answer("OUTSIDE_VOCABULARY")) : runHost(bookRoot, configuration, prompt, options);
  const result = await runBook(root, project, { run: true, host, onProgress() {}, sleep: async () => {} });
  const reviews = result.units.filter((unit) => unit.unit.includes(" review "));
  assert.equal(reviews.length, 6);
  for (const unit of reviews) {
    assert.equal(unit.status, "failed");
    assert.equal(unit.answer_file, answerFile({ id: unit.packet_id }));
    assert.equal(existsSync(join(root, unit.answer_file)), true);
    assert.equal(Object.hasOwn(unit, "warnings"), false);
  }
});
