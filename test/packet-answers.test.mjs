// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runHost } from "../engine/host.mjs";
import { importBook } from "../engine/import.mjs";
import { initializeProject } from "../engine/init.mjs";
import { buildPacket, canonicalVerdict, checkVerdict, extractJsonBlock, quoteForAuthor, savedAnswerNote, validateAndRepair, verdictKey, verdictLines, verdictWords } from "../engine/packets.mjs";
import { collectFindings } from "../engine/findings.mjs";
import { readProject } from "../engine/project.mjs";
import { proposalSummary, repairChapter } from "../engine/repair.mjs";
import { writeTextRecord } from "../engine/records.mjs";
import { listLenses } from "../engine/reviewers.mjs";
import { buildReviewPacket, reviewRecordPath, submitReviewPacket, validateReviewAnswer } from "../engine/review.mjs";
import { runBook } from "../engine/run.mjs";
import { bootstrapState, buildStatePacket, submitStatePacket } from "../engine/state.mjs";
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
  for (const endings of ["LF", "CRLF"]) test(`real answer records every finding: ${name}, ${endings}`, () => {
    const raw = readFileSync(join(FIXTURES, name), "utf8");
    const lf = raw.replace(/\r\n/gu, "\n");
    const text = endings === "CRLF" ? lf.replace(/\n/gu, "\r\n") : lf;
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

const disagreement = (line, word = "DRIFT", verdict = "CONSISTENT") =>
  `The verdict line "${line}" says ${word}, but the JSON block says ${verdict}. Weaver recorded ${verdict}, from the JSON block.`;
const unreadable = (line) => `The verdict line "${line}" does not name CONSISTENT or DRIFT. Weaver recorded CONSISTENT, from the JSON block.`;

test("every verdict line shape is recognised in agreement and disagreement, with LF and CRLF", () => {
  // Single-line literals are also the expected author quote: decoration must survive.
  const shapes = [
    "STYLE: DRIFT", "**STYLE: DRIFT**", "**STYLE:** DRIFT", "STYLE: **DRIFT**", "__STYLE: DRIFT__",
    "Style: drift.", "style: DRIFT", "sTyLe: drift", "`STYLE: DRIFT`", "## STYLE: DRIFT",
    "> STYLE: DRIFT", "- STYLE: DRIFT", "+ STYLE: DRIFT", "* STYLE: DRIFT", "• STYLE: DRIFT",
    "◦ STYLE: DRIFT", "‣ STYLE: DRIFT", "1. STYLE: DRIFT", "1) STYLE: DRIFT", "(1) STYLE: DRIFT",
    "> ## 2. __STYLE: DRIFT__", "STYLE - DRIFT", "STYLE -DRIFT", "STYLE- DRIFT", "STYLE -- DRIFT",
    "STYLE ‐ DRIFT", "STYLE ‑ DRIFT", "STYLE ‒ DRIFT", "STYLE – DRIFT", "STYLE — DRIFT", "STYLE ― DRIFT", "STYLE − DRIFT",
    "STYLE : DRIFT", "STYLE:DRIFT", "STYLE = DRIFT", "STYLE → DRIFT", "STYLE ⇒ DRIFT", "STYLE -> DRIFT", "STYLE => DRIFT",
    "STYLE： DRIFT", ["STYLE\u3000: DRIFT", "STYLE : DRIFT"], ["\uFEFFSTYLE: DRIFT", "STYLE: DRIFT"],
    "“STYLE: DRIFT”", "[STYLE: DRIFT]", "(STYLE: DRIFT)", "| STYLE: DRIFT |", "| STYLE | DRIFT |", "STYLE (DRIFT)", "STYLE [DRIFT]",
    "Verdict: DRIFT", "**Verdict:** DRIFT", "Style verdict: DRIFT", "**Style verdict:** DRIFT", "STYLE VERDICT: DRIFT",
    "Style lens: DRIFT", "STYLE REVIEW: DRIFT", "Style lens verdict: DRIFT", "Overall verdict: DRIFT", "Final verdict: DRIFT",
    "Final Style review: DRIFT", "Verdict: STYLE: DRIFT",
    "STYLE: DRIFT — two passages slip into modern idiom.", "STYLE: DRIFT - two passages slip.",
    "STYLE: DRIFT (two passages)", "STYLE: DRIFT, in two passages", "STYLE DRIFT", "**DRIFT**", "Drift.", "DRIFT — two passages slip.",
    "STYLE: DRIFT; notes", "STYLE: DRIFT: notes", "STYLE: DRIFT! notes", "STYLE: DRIFT? notes", "STYLE: DRIFT… notes",
    "STYLE: DRIFT [notes]", "STYLE: DRIFT → notes", "STYLE: DRIFT ‐ notes", "STYLE: DRIFT ‑ notes",
    "STYLE: DRIFT ‒ notes", "STYLE: DRIFT – notes", "STYLE: DRIFT ― notes", "STYLE: DRIFT − notes", "STYLE: DRIFT --",
    ["## Verdict\n**DRIFT**", "**DRIFT**"], ["STYLE:\nDRIFT", "DRIFT"], ["**Style verdict:**\n\nDRIFT", "DRIFT"],
    ["Style review\nDRIFT", "DRIFT"], ["A short preamble.\n\nSTYLE: DRIFT", "STYLE: DRIFT"], ["```\nSTYLE: DRIFT\n```", "STYLE: DRIFT"],
    [null, "STYLE: DRIFT"]
  ];
  for (const shape of shapes) {
    const [line, expectedQuote] = Array.isArray(shape) ? shape : [shape, shape];
    for (const verdict of ["DRIFT", "CONSISTENT"]) for (const eol of ["\n", "\r\n"]) {
      const text = (line === null ? `${jsonBlock({ verdict, findings: [] })}\nSTYLE: DRIFT` : answer(verdict, line)).replace(/\n/gu, eol);
      const result = validateReviewAnswer(text, "style", paragraphs);
      assert.equal(result.ok, true, text);
      assert.equal(result.value.verdict, verdict, text);
      assert.deepEqual(result.value.findings, []);
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.warnings, verdict === "DRIFT" ? [] : [disagreement(expectedQuote)], text);
    }
  }
});

test("accepted JSON verdict formatting uses the full token, including the length boundary", () => {
  for (const verdict of ["drift", "Drift", "STYLE: DRIFT", "style: drift", "**DRIFT**", "DRIFT.", " DRIFT ",
    "STYLE = DRIFT", "STYLE → DRIFT", "STYLE -> DRIFT", "STYLE： DRIFT", "STYLE | DRIFT", "STYLE (DRIFT)", "STYLE − DRIFT",
    "Verdict: DRIFT", "Style verdict: DRIFT", "STYLE REVIEW: DRIFT", "Verdict: STYLE: DRIFT", " ".repeat(200) + "DRIFT",
    "STYLE:" + " ".repeat(89) + "DRIFT"]) {
    const result = validateReviewAnswer(answer(verdict), "style", paragraphs);
    assert.equal(result.ok, true, verdict);
    assert.equal(result.value.verdict, "DRIFT");
    assert.deepEqual(result.warnings, []);
  }
});

test("prose and missing verdict lines do not warn", () => {
  for (const line of ["The style holds throughout.", "Style drift is minimal.", "Intro.\nDRIFT", "Intro.\nSTYLE DRIFT",
    "## Style review\nThe voice holds.", "A STYLE: DRIFT", "STYLES: DRIFT", "STYLE/DRIFT", "STYLE-DRIFT", ""]) {
    const result = validateReviewAnswer(answer("CONSISTENT", line), "style", paragraphs);
    assert.equal(result.ok, true, line);
    assert.equal(result.value.verdict, "CONSISTENT");
    assert.deepEqual(result.warnings, [], line);
  }
  const result = validateReviewAnswer(`${jsonBlock({ verdict: "CONSISTENT", findings: [] })}\nStyle drift is minimal.`, "style", paragraphs);
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);
});

test("unreadable lines quote the original line when no line names a verdict", () => {
  for (const line of ["**STYLE: MOSTLY CONSISTENT**", "STYLE: CONSISTENT or DRIFT", "STYLE: DRIFTING", "STYLE: 3DRIFT",
    "STYLE: DRIFT-extra", "STYLE: DRIFT two passages slip", "Verdict: PASS", "Style - the narration holds up well."]) {
    const result = validateReviewAnswer(answer("CONSISTENT", line), "style", paragraphs);
    assert.equal(result.ok, true);
    assert.equal(result.value.verdict, "CONSISTENT");
    assert.deepEqual(result.warnings, [unreadable(line)], line);
  }
});

test("prose before or after a naming line never decides", () => {
  for (const [lens, verdict, lines] of [
    ["style", "CONSISTENT", "# Style — Chapter 3\nSTYLE: CONSISTENT"],
    ["continuity", "FLAGS", "1. **Continuity:** Mott knows the name.\nCONTINUITY: FLAGS"],
    ["style", "CONSISTENT", "Style - the narration holds up well.\nSTYLE: CONSISTENT"],
    ["style", "CONSISTENT", "**STYLE: MOSTLY CONSISTENT**\nVerdict: CONSISTENT"],
    ["style", "CONSISTENT", "STYLE: CONSISTENT\nThe voice holds.\n## Style drift\nNone found."]
  ]) {
    const result = validateReviewAnswer(answer(verdict, lines), lens, paragraphs);
    assert.equal(result.ok, true);
    assert.equal(result.value.verdict, verdict);
    assert.deepEqual(result.warnings, [], lines);
  }
});

test("the first disagreement anywhere outside JSON wins over prose and agreeing lines", () => {
  for (const [lens, text, expected] of [
    ["continuity", answer("FLAGS", "Continuity - flags appear in two places.\nCONTINUITY: CLEAR"), disagreement("CONTINUITY: CLEAR", "CLEAR", "FLAGS")],
    ["style", answer("CONSISTENT", "STYLE: CONSISTENT") + "Overall verdict: DRIFT", disagreement("Overall verdict: DRIFT")],
    ["style", answer("CONSISTENT", "**STYLE: DRIFT**\nVerdict: DRIFT"), disagreement("**STYLE: DRIFT**")]
  ]) {
    const result = validateReviewAnswer(text, lens, paragraphs);
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, [expected]);
  }
});

test("only the full lens vocabulary is accepted, with one useful error and no line fallback", () => {
  for (const verdict of ["MOSTLY CONSISTENT", "MINOR DRIFT", "PASS", "CRITIC: DRIFT", "", undefined, 3, null, "CONSISTENT with notes", "DRIFTING",
    "STYLE-DRIFT", "DRIFT (minor)", "STYLE:" + " ".repeat(90) + "DRIFT"]) {
    const text = answer(verdict, "STYLE: CONSISTENT");
    // Passing undefined to answer uses its default; explicitly omit the field instead.
    const result = validateReviewAnswer(verdict === undefined ? `STYLE: CONSISTENT\n${jsonBlock({ findings: [] })}` : text, "style", paragraphs);
    assert.equal(result.ok, false, String(verdict));
    assert.deepEqual(result.errors, [`The JSON block's "verdict" must be exactly one of these words: CONSISTENT or DRIFT. This answer gave ${verdict === undefined ? "no verdict" : quoteForAuthor(JSON.stringify(verdict))}.`]);
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

test("verdict line scanning lists all naming lines outside the authoritative JSON", () => {
  const text = answer("DRIFT", "Preamble.\r\n> 1. **STYLE: CONSISTENT**\r\nSTYLE: DRIFT") + "STYLE: DRIFT\r\n";
  const parsed = extractJsonBlock(text);
  assert.deepEqual(verdictLines(text, { ...STYLE, ...parsed }), [
    { line: "> 1. **STYLE: CONSISTENT**", verdict: "CONSISTENT" },
    { line: "STYLE: DRIFT", verdict: "DRIFT" }, { line: "STYLE: DRIFT", verdict: "DRIFT" }
  ]);
  assert.equal(checkVerdict(text, parsed.value, { ...STYLE, ...parsed }).warnings.length, 1);
  const inside = '```json\n{\n"verdict":"DRIFT",\n"findings":[],\n"note":"\nSTYLE: CONSISTENT\n"\n}\n```';
  const offsets = extractJsonBlock(inside);
  assert.deepEqual(verdictLines(inside, { ...STYLE, ...offsets }), []);
  const after = `${inside}\r\nSTYLE: DRIFT — a note.\r\nSTYLE: CONSISTENT`;
  assert.deepEqual(verdictLines(after, { ...STYLE, ...offsets }), [
    { line: "STYLE: DRIFT — a note.", verdict: "DRIFT" }, { line: "STYLE: CONSISTENT", verdict: "CONSISTENT" }
  ]);
  for (const line of ["STYLE: MOSTLY CONSISTENT", "STYLE: 3DRIFT", "STYLE: DRIFTING", "STYLE: DRIFT-extra"]) {
    const value = answer("CONSISTENT", line);
    assert.deepEqual(verdictLines(value, { ...STYLE, ...extractJsonBlock(value) }), [{ line, verdict: null }]);
  }
  for (const line of ["STYLES: DRIFT", "Intro.\nSTYLE DRIFT", "A STYLE: DRIFT"])
    assert.deepEqual(verdictLines(answer("DRIFT", line), { ...STYLE, ...extractJsonBlock(answer("DRIFT", line)) }), []);
  const cr = answer("CONSISTENT", "Intro.\rSTYLE: DRIFT");
  assert.deepEqual(verdictLines(cr, { ...STYLE, ...extractJsonBlock(cr) }), [{ line: "STYLE: DRIFT", verdict: "DRIFT" }]);
});

test("exact vocabulary spelling wins, and only a unique normalised spelling can match", () => {
  for (const [verdicts, value, line, expected, warning] of [
    [["DONE_", "OPEN"], "DONE_", "TONE: DONE_", "DONE_"],
    [["DONE_", "OPEN"], "done", "TONE: DONE_", "DONE_"],
    [["DONE_", "OPEN"], "OPEN", "TONE: DONE_", "OPEN", disagreement("TONE: DONE_", "DONE_", "OPEN")],
    [["OK__", "NO"], "OK__", "TONE: OK__", "OK__"],
    [["A-_B", "C"], "A-_B", "TONE: A-_B", "A-_B"],
    [["OK-_GO", "STOP"], "OK-_GO", "TONE: OK-_GO", "OK-_GO"],
    [["ok", "OK"], "OK", "TONE: OK", "OK"], [["ok", "OK"], "ok", "TONE: ok", "ok"],
    [["ok", "OK"], "OK", "TONE: ok", "OK", disagreement("TONE: ok", "ok", "OK")],
    [["Pass", "PASS"], "PASS", "TONE: PASS", "PASS"], [["Pass", "PASS"], "Pass", "TONE: Pass", "Pass"],
    [["TONE-ALERT", "CLEAR"], "TONE-ALERT", "TONE-ALERT", "TONE-ALERT"]
  ]) {
    const result = validateReviewAnswer(answer(value, line), { id: "tone", verdicts }, paragraphs);
    assert.equal(result.ok, true, `${verdicts}: ${value}`);
    assert.equal(result.value.verdict, expected);
    assert.deepEqual(result.warnings, warning ? [warning] : []);
  }
  for (const [verdicts, verdict] of [[["ok", "OK"], "Ok"], [["Pass", "PASS"], "pass"]]) {
    const result = validateReviewAnswer(answer(verdict, ""), { id: "tone", verdicts }, paragraphs);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].includes(verdictWords(verdicts)));
  }
  const ambiguous = validateReviewAnswer(answer("OK", "TONE: Ok"), { id: "tone", verdicts: ["ok", "OK"] }, paragraphs);
  assert.deepEqual(ambiguous.warnings, ['The verdict line "TONE: Ok" does not name ok or OK. Weaver recorded OK, from the JSON block.']);
  const flags = validateReviewAnswer(answer("CLEAR", "FLAGS: CLEAR"), { id: "flags", verdicts: ["CLEAR", "FLAGS"] }, paragraphs);
  assert.equal(flags.ok, true);
  assert.deepEqual(flags.warnings, []);
  const sameLabel = validateReviewAnswer(answer("FLAGS: FLAGS", "FLAGS: FLAGS"), { id: "flags", verdicts: ["CLEAR", "FLAGS"] }, paragraphs);
  assert.equal(sameLabel.ok, true);
  assert.equal(sameLabel.value.verdict, "FLAGS");
  assert.deepEqual(sameLabel.warnings, []);
  for (const value of ["Character audit: ALERT", "Final Character audit lens verdict => ALERT", "Verdict: Character audit: ALERT"]) {
    const result = validateReviewAnswer(answer(value, "Character audit: ALERT"), { id: "character-audit", verdicts: ["QUIET", "ALERT"] }, paragraphs);
    assert.equal(result.ok, true, value);
    assert.equal(result.value.verdict, "ALERT");
    assert.deepEqual(result.warnings, []);
  }
  assert.equal(canonicalVerdict("Verdict: drift", { verdicts: ["DRIFT"] }), "DRIFT");
});

function reviewer(root, id, verdicts) {
  mkdirSync(join(root, "quality", "reviewers"), { recursive: true });
  writeFileSync(join(root, "quality", "reviewers", `${id}.md`), `---\nid: ${id}\ntitle: Tone\nverdicts: [${verdicts.join(", ")}]\nqueue: top-2\n---\nRead for changes in tone.\n`);
}

test("book reviewers reject only colliding normalised vocabularies with a named warning", (t) => {
  const root = temporaryRoot(t);
  const colliding = [["ok", "OK"], ["Pass", "PASS"], ["FINE_", "FINE"], ["A-B", "A-_B"], ["OK__", "ok"]];
  const accepted = [["DONE_", "OPEN"], ["FINE_", "SLOW_"], ["NEEDS_WORK", "FINE"], ["NEEDS_WORK", "NEEDS__WORK"], ["QUIET", "ALERT"], ["CLEAR", "FLAGS"]];
  colliding.forEach((words, index) => { reviewer(root, `collision-${index}`, words); assert.equal(verdictKey(words[0]), verdictKey(words[1])); });
  accepted.forEach((words, index) => { reviewer(root, `accepted-${index}`, words); assert.notEqual(verdictKey(words[0]), verdictKey(words[1])); });
  const warnings = [];
  const lenses = listLenses(root, { onWarning: (warning) => warnings.push(warning) });
  assert.deepEqual(lenses.filter((lens) => !lens.builtin).map((lens) => lens.verdicts), accepted);
  assert.deepEqual(warnings, colliding.map((_, index) => `quality/reviewers/collision-${index}.md: verdicts must contain two words that differ by more than capital letters or underscores at their edges; reviewer skipped`));
});

test("book reviewers record exact edge underscores without repair and queue a canonical second verdict", async (t) => {
  const { root, project } = book(t);
  reviewer(root, "tone", ["DONE_", "OPEN"]);
  let packet = buildReviewPacket(root, project, 1, "tone");
  const exact = await submitReviewPacket(root, project, packet, answer("DONE_", "TONE: DONE_"), { host: async () => assert.fail("unexpected host call") });
  assert.equal(exact.ok, true);
  assert.equal(exact.record.verdict, "DONE_");
  assert.equal(Object.hasOwn(exact.record, "warnings"), false);
  reviewer(root, "tone", ["QUIET", "ALERT"]);
  packet = buildReviewPacket(root, project, 1, "tone");
  const craft = { ...finding, severity: "craft" };
  const queued = await submitReviewPacket(root, project, packet, answer("alert", "TONE: ALERT", [craft]), { host: async () => assert.fail("unexpected host call") });
  assert.equal(queued.ok, true);
  assert.equal(queued.record.verdict, "ALERT");
  const collected = collectFindings(root, project, { chapter: 1, all: true });
  const items = collected.findings.filter((item) => item.source === "tone");
  assert.equal(items.length, 1);
  assert.equal(items[0].queued, true);
  assert.equal(items[0].quote, craft.quote);
  assert.equal(collected.notes.some((item) => item.source === "tone"), false);
});

test("author quotes scrub controls and invisible characters and truncate by code point", () => {
  const codes = [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => 127 + i),
    ...Array.from({ length: 5 }, (_, i) => 0x200b + i), 0x2028, 0x2029, ...Array.from({ length: 5 }, (_, i) => 0x202a + i),
    ...Array.from({ length: 10 }, (_, i) => 0x2060 + i), 0xfeff];
  for (const code of codes) assert.equal(quoteForAuthor(`a${String.fromCodePoint(code)}b`), "a b", code.toString(16));
  assert.equal(quoteForAuthor("  a\t\n b  "), "a b");
  assert.equal(quoteForAuthor(12), "12");
  assert.equal(quoteForAuthor("x".repeat(120)), "x".repeat(120));
  assert.equal(quoteForAuthor("x".repeat(121)), "x".repeat(119) + "…");
  assert.equal(quoteForAuthor("x".repeat(118) + "😀yz"), "x".repeat(118) + "😀…");
  assert.equal(quoteForAuthor("x".repeat(119) + "😀"), "x".repeat(119) + "😀");
});

test("verdicts and warnings are bounded, fast and safe to print", () => {
  for (const value of [".".repeat(40000) + "x", "x" + ".".repeat(40000)]) {
    const start = performance.now();
    assert.equal(canonicalVerdict(value, STYLE), null);
    assert.ok(performance.now() - start < 100);
  }
  const keyStart = performance.now();
  assert.equal(verdictKey(".".repeat(40000) + "x"), ".".repeat(40000) + "x");
  assert.equal(verdictKey("x" + ".".repeat(40000)), "x");
  assert.ok(performance.now() - keyStart < 100);
  const start = performance.now();
  const long = validateReviewAnswer(answer("CONSISTENT", `STYLE: MOSTLY ${"x".repeat(200000)}`), "style", paragraphs);
  assert.ok(performance.now() - start < 1000);
  assert.equal(long.ok, true);
  assert.equal(long.warnings.length, 1);
  assert.ok(long.warnings[0].length <= 300);
  assert.ok(long.warnings[0].includes("…"));
  const unsafe = "STYLE: MOSTLY \u001b[2J \u001b]0;unsafe\u0007 \u009b";
  const safe = validateReviewAnswer(answer("CONSISTENT", unsafe), "style", paragraphs);
  assert.equal(safe.ok, true);
  assert.deepEqual(safe.warnings, [unreadable("STYLE: MOSTLY [2J ]0;unsafe")]);
  assert.doesNotMatch(safe.warnings[0], /[\u0000-\u001F\u007F-\u009F]/u);
  const object = validateReviewAnswer(answer({ blob: "y".repeat(50000) }), "style", paragraphs);
  assert.equal(object.ok, false);
  assert.equal(object.errors.length, 1);
  assert.ok(object.errors[0].length <= 400);
  assert.ok(object.errors[0].includes("…"));
  const beyond = answer("CONSISTENT", `${" ".repeat(300)}STYLE: DRIFT`);
  assert.deepEqual(validateReviewAnswer(beyond, "style", paragraphs).warnings, []);
  assert.equal(canonicalVerdict("STYLE\u200b:\u009bDRIFT…)]", STYLE), "DRIFT");
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
  assert.ok(ran.stdout.includes(savedAnswerNote(root, answerFile(packet))));
  assert.equal(existsSync(join(root, answerFile(packet))), true);
  const path = join(root, "answer.txt");
  writeFileSync(path, answer("PASS"));
  const submitted = cli(root, ["submit", packet.id, "--file", path]);
  assert.equal(submitted.status, 1, submitted.stdout + submitted.stderr);
  assert.ok(submitted.stdout.includes(`Packet ${packet.id}: answer invalid after repair:`));
  assert.ok(submitted.stdout.includes(savedAnswerNote(root, answerFile(packet))));
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

test("saved answer notes resolve against the book root and omit absent paths", () => {
  const relative = ".weaver/packets/abcdef123456.answer.txt";
  assert.equal(savedAnswerNote(ROOT, relative), ` (Weaver saved the answer in ${resolve(ROOT, relative)})`);
  assert.equal(savedAnswerNote(null, relative), ` (Weaver saved the answer in ${relative})`);
  assert.equal(savedAnswerNote(1, relative), ` (Weaver saved the answer in ${relative})`);
  for (const missing of [null, undefined, ""]) assert.equal(savedAnswerNote(ROOT, missing), "");
});

test("submitting the diagnostic itself preserves author bytes, including aliases and Windows case", async (t) => {
  const root = temporaryRoot(t);
  const packet = buildPacket("FUTURE", "item", "Generic prompt", {}, "generic-1");
  const path = join(root, answerFile(packet));
  const authored = "  Author's edit\r\n  \n";
  writeTextRecord(path, authored);
  const alias = join(root, "linked-packets");
  symlinkSync(join(root, ".weaver", "packets"), alias, process.platform === "win32" ? "junction" : "dir");
  const paths = [path, join(alias, `${packet.id}.answer.txt`)];
  if (process.platform === "win32") paths.push(path.toUpperCase());
  for (const answerPath of paths) {
    const result = await validateAndRepair(root, {}, packet, authored, () => ["invalid"], { answerPath, host: async () => response("failed repair") });
    assert.equal(result.ok, false);
    assert.equal(Object.hasOwn(result, "answer_file"), false);
    assert.equal(readFileSync(path, "utf8"), authored);
  }
  const result = await validateAndRepair(root, {}, packet, authored, () => ["invalid"], { answerPath: join(root, "other.txt"), host: async () => response("latest failed repair\r\n") });
  assert.equal(result.ok, false);
  assert.equal(result.answer_file, answerFile(packet));
  assert.equal(readFileSync(path, "utf8"), "latest failed repair\r\n");
});

test("resolved diagnostic paths are protected even before the file exists", async (t) => {
  const root = temporaryRoot(t);
  const packet = buildPacket("FUTURE", "item", "Generic prompt", {}, "generic-1");
  const path = join(root, answerFile(packet));
  // Windows paths differ only in letter case; resolved paths must still compare equal there.
  for (const answerPath of process.platform === "win32" ? [path, path.toUpperCase()] : [path]) {
    const result = await validateAndRepair(root, {}, packet, "author text", () => ["invalid"], { answerPath, host: async () => response("failed repair") });
    assert.equal(result.ok, false);
    assert.equal(Object.hasOwn(result, "answer_file"), false);
    assert.equal(existsSync(path), false);
  }
});

for (const kind of ["REVIEW", "STATE", "REPAIR"]) test(`CLI ${kind} submit preserves an edited diagnostic file`, async (t) => {
  const { root, project } = kind === "REPAIR" ? makeBook(t) : book(t, "invalid");
  project.host = { command: process.execPath, args: [ANSWER_HOST, "invalid"], timeout_seconds: 10 };
  writeFileSync(join(root, "project.json"), JSON.stringify(project));
  let packet;
  if (kind === "REVIEW") {
    packet = buildReviewPacket(root, project, 1, "style");
    writeTextRecord(join(root, ".weaver", "packets", `${packet.id}.json`), JSON.stringify(packet));
  } else if (kind === "STATE") packet = buildStatePacket(root, project, "1-1");
  else packet = (await repairChapter(root, project, { chapter: 1, onProgress() {} })).packet;
  const path = join(root, answerFile(packet));
  const authored = "  Author's invalid edited answer\r\n  ";
  writeFileSync(path, authored);
  const submitted = cli(root, ["submit", packet.id, "--file", path]);
  assert.equal(submitted.status, 1, submitted.stdout + submitted.stderr);
  assert.match(submitted.stdout, /answer invalid after repair/u);
  assert.equal(readFileSync(path, "utf8"), authored);
  assert.doesNotMatch(submitted.stdout, /Weaver saved the answer in/u);
});

test("failed diagnostic replacement cleans temporary files without losing the validation result", async (t) => {
  const root = temporaryRoot(t);
  const packet = buildPacket("FUTURE", "item", "Generic prompt", {}, "generic-1");
  const directory = join(root, ".weaver", "packets");
  mkdirSync(join(root, answerFile(packet)), { recursive: true });
  const result = await validateAndRepair(root, {}, packet, "first", () => ["invalid"], { host: async () => response("last") });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["invalid"]);
  assert.equal(result.answerText, "last");
  assert.equal(Object.hasOwn(result, "answer_file"), false);
  assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith(".tmp")), []);
  const destination = join(root, "directory");
  mkdirSync(destination);
  assert.throws(() => writeTextRecord(destination, "text"));
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
});

test("bounded verdict errors stay bounded in the repair prompt and safe warnings persist", async (t) => {
  const { root, project } = book(t);
  const packet = buildReviewPacket(root, project, 1, "style");
  const repaired = answer("CONSISTENT", "STYLE: DRIFT\u001b[2J\u001b]0;unsafe\u0007\u009b");
  let calls = 0;
  const result = await submitReviewPacket(root, project, packet, answer({ blob: "y".repeat(50000) }), { host: async (_root, _project, prompt) => {
    calls++;
    assert.ok(prompt.length - packet.prompt.length < 500);
    assert.ok(prompt.includes("…"));
    return response(repaired);
  } });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.record.warnings.length, 1);
  const stored = JSON.parse(readFileSync(reviewRecordPath(root, 1, "style"), "utf8"));
  assert.deepEqual(stored.warnings, [disagreement("STYLE: DRIFT [2J ]0;unsafe")]);
  assert.doesNotMatch(stored.warnings[0], /[\u0000-\u001F\u007F-\u009F]/u);
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
  assert.ok(progress.some((line) => line.includes(savedAnswerNote(root, answerFile(packet)))));
  const result = await submitStatePacket(root, project, packet.id, "broken JSON");
  assert.equal(result.ok, false);
  assert.equal(result.answer_file, answerFile(packet));
  const path = join(root, "answer.txt");
  writeFileSync(path, "broken JSON");
  const submitted = cli(root, ["submit", packet.id, "--file", path]);
  assert.equal(submitted.status, 1, submitted.stdout + submitted.stderr);
  assert.ok(submitted.stdout.includes(savedAnswerNote(root, answerFile(packet))));
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
  const progress = [];
  const record = await repairChapter(root, project, { chapter: 1, run: true, host: async () => response("broken JSON"), onProgress: (line) => progress.push(line) });
  assert.equal(record.status, "failed");
  assert.equal(record.answer_file, answerFile({ id: record.packet_id }));
  assert.equal(readFileSync(join(root, record.answer_file), "utf8"), "broken JSON");
  assert.ok(progress[0].split("\n")[0].endsWith(savedAnswerNote(root, record.answer_file)));
  assert.ok(proposalSummary(record).split("\n")[0].endsWith(savedAnswerNote(null, record.answer_file)));
  const proposals = cli(root, ["proposals"]);
  assert.equal(proposals.status, 0, proposals.stdout + proposals.stderr);
  assert.ok(proposals.stdout.split("\n")[0].endsWith(savedAnswerNote(root, record.answer_file)));
  const repair = cli(root, ["repair", "--chapter", "1", "--run"]);
  assert.equal(repair.status, 1, repair.stdout + repair.stderr);
  assert.ok(repair.stdout.split("\n")[0].endsWith(savedAnswerNote(root, record.answer_file)));
  const path = join(root, "answer.txt");
  writeFileSync(path, "broken JSON");
  const submitted = cli(root, ["submit", record.packet_id, "--file", path]);
  assert.equal(submitted.status, 1, submitted.stdout + submitted.stderr);
  assert.ok(submitted.stdout.includes(`Packet ${record.packet_id}: answer invalid after repair:`));
  assert.ok(submitted.stdout.includes(savedAnswerNote(root, record.answer_file)));
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

test("whole-book failed reviews and repair retain absolute progress notes and summary paths", async (t) => {
  const { root, project } = makeBook(t);
  project.host.timeout_seconds = 10;
  const progress = [];
  const host = async (bookRoot, configuration, prompt, options) => /^# (REVIEW|REPAIR)/u.test(prompt)
    ? response("broken JSON") : runHost(bookRoot, configuration, prompt, options);
  const result = await runBook(root, project, { run: true, host, onProgress: (line) => progress.push(line), sleep: async () => {} });
  const reviews = result.units.filter((unit) => unit.unit.includes(" review "));
  assert.equal(reviews.length, 6);
  const repair = result.units.find((unit) => unit.unit === "chapter 1 repair");
  for (const unit of [...reviews, repair]) {
    assert.equal(unit.status, "failed", unit.unit);
    assert.match(unit.answer_file, /^\.weaver\/packets\/[a-f0-9]{12}\.answer\.txt$/u);
    assert.equal(readFileSync(join(root, unit.answer_file), "utf8"), "broken JSON");
    assert.ok(progress.includes(`${unit.unit}: failed: ${unit.error}${savedAnswerNote(root, unit.answer_file)}`));
    assert.deepEqual(result.summary.failures.find((failure) => failure.unit === unit.unit), { unit: unit.unit, error: unit.error, answer_file: unit.answer_file });
  }
  const recorded = JSON.parse(readFileSync(result.path, "utf8"));
  assert.deepEqual(recorded.summary.failures, result.summary.failures);
});

test("CLI whole-book final failure lines name absolute saved paths with a separate book root", (t) => {
  const { root } = book(t, "invalid");
  const result = cli(root, ["run", "--book", "--run"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const finalLines = result.stdout.slice(result.stdout.indexOf("Book run finished:"));
  const packets = readPackets(root).filter((packet) => packet.kind === "REVIEW");
  assert.ok(packets.length >= 3);
  for (const packet of packets) {
    const [chapter, lens] = packet.target.split(":");
    assert.ok(finalLines.split("\n").some((line) => line.startsWith(`chapter ${chapter} review ${lens}: `) && line.endsWith(savedAnswerNote(root, answerFile(packet)))), finalLines);
  }
});

const stateHeadings = ["Newly established", "Character deltas", "Active threads", "Timeline and location", "Closing image"];
const stateRecord = (format, eol = "\n") => `# Scene 1-1${eol}${eol}${stateHeadings.map((heading) =>
  `${format(heading)}${eol}  Pellam waits. Keep *this* and __that__ exactly.\t${eol}`).join(eol)}`;

for (const style of ["## **H**", "### H", "# H:", "## H:", "**H**", "__H:__", "H", "## `H`", "## __H__", "###### H"]) {
  test(`STATE normalises only missing decorated headings: ${style}`, async (t) => {
    const { root, project } = book(t);
    const eol = style === "__H:__" ? "\r\n" : "\n";
    const text = stateRecord((heading) => style.replace("H", heading), eol) + jsonBlock({ facts: [] });
    let calls = 0;
    const units = [];
    await bootstrapState(root, project, { run: true, sceneIds: ["1-1"], host: async () => { calls++; return response(text); }, onProgress() {}, onUnit: (unit) => units.push(unit) });
    assert.equal(calls, 1);
    assert.equal(units[0].status, "recorded");
    const stored = readFileSync(join(root, "narrative-state", "1-1.md"), "utf8");
    assert.equal(stored, stateRecord((heading) => `## ${heading}`, eol).trim() + "\n");
    for (const heading of stateHeadings) assert.ok(stored.split(/\r\n|\n/u).includes(`## ${heading}`));
  });
}

for (const eol of ["\n", "\r\n"]) test(`STATE already-valid records retain their original bytes: ${JSON.stringify(eol)}`, async (t) => {
  const { root, project } = book(t);
  const record = stateRecord((heading) => `## ${heading}`, eol);
  const text = `  ${eol}${record}${eol}${jsonBlock({ facts: [] })}`;
  let calls = 0;
  const units = [];
  await bootstrapState(root, project, { run: true, sceneIds: ["1-1"], host: async () => { calls++; return response(text); }, onProgress() {}, onUnit: (unit) => units.push(unit) });
  assert.equal(calls, 1);
  assert.equal(units[0].status, "recorded");
  assert.equal(readFileSync(join(root, "narrative-state", "1-1.md"), "utf8"), text.slice(0, extractJsonBlock(text).start).trim() + "\n");
});

test("STATE rewrites only headings that failed the original check, with mixed endings intact", async (t) => {
  const { root, project } = book(t);
  const record = "## newly established\r\nKeep this.\n**Newly established**\r\n" +
    stateHeadings.slice(1).map((heading) => ` **${heading.toUpperCase()}:** \rKeep this too.\n`).join("");
  const expected = "## newly established\r\nKeep this.\n**Newly established**\r\n" +
    stateHeadings.slice(1).map((heading) => `## ${heading}\rKeep this too.\n`).join("");
  const packet = buildStatePacket(root, project, "1-1");
  const result = await submitStatePacket(root, project, packet.id, record + jsonBlock({ facts: [] }), { host: async () => assert.fail("unexpected repair") });
  assert.equal(result.ok, true);
  assert.equal(readFileSync(join(root, "narrative-state", "1-1.md"), "utf8"), expected.trim() + "\n");
});

for (const invalid of ["## Newly established facts", "- Newly established", "1. Newly established", "####### Newly established"]) {
  test(`STATE still rejects non-headings after repair: ${invalid}`, async (t) => {
    const { root, project } = book(t);
    const text = stateRecord((heading) => heading === "Newly established" ? invalid : `## ${heading}`) + jsonBlock({ facts: [] });
    let calls = 0;
    const units = [];
    await bootstrapState(root, project, { run: true, sceneIds: ["1-1"], host: async () => { calls++; return response(text); }, onProgress() {}, onUnit: (unit) => units.push(unit) });
    assert.equal(calls, 2);
    assert.equal(units[0].status, "failed");
    assert.equal(units[0].error, "missing required heading: Newly established");
    assert.equal(existsSync(join(root, "narrative-state", "1-1.md")), false);
  });
}
