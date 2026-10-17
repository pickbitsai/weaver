// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { buildReport, collectReportData, markdownToHtml, parseChapterSelection, parseSections, PRIVACY_LINE, renderReport, REPORT_SECTIONS, reportCsp, reportFileName, wordDiff, writeReport } from "../engine/report.mjs";
import { initializeProject } from "../engine/init.mjs";
import { readProject } from "../engine/project.mjs";
import { seedCharacters } from "../engine/characters.mjs";
import { runReview } from "../engine/review.mjs";
import { repairInputs, proposalPath } from "../engine/repair.mjs";
import { writeRecord } from "../engine/records.mjs";
import { AUTHOR_ONLY_COMMANDS } from "../engine/guard.mjs";
import { runHook } from "../engine/hooks.mjs";
import { startStudio, esc } from "../engine/studio.mjs";
import { GENERATOR } from "../engine/identity.mjs";
import { authorEnv } from "./helpers/env.mjs";
import { git, makeBook } from "./helpers/book.mjs";

const NOW = new Date("2026-10-17T14:05:00.000Z");
const CLI = resolve("scripts/weaver.mjs");
const HOST = resolve("test/fixtures/fake-host.mjs");
const HOSTILE = ['<script>alert("x")</script>', '" onmouseover="alert(1)', "' onfocus='alert(2)", "&amp; &lt;b&gt; &#x3C;", "https://evil.example/pixel.png", "javascript:alert(3)", "<img src=x onerror=alert(4)>", "[click](https://evil.example/)", "</title></style><style>body{display:none}</style>", "Q".repeat(4000)].join(" ");
const save = (path, doc) => writeFileSync(path, JSON.stringify(doc, null, 2));
function temporary(t) { const path = mkdtempSync(join(tmpdir(), "weaver-report-")); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
function snapshot(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).filter((entry) => entry.name !== ".git").sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) return snapshot(root, path);
    const stat = statSync(join(root, path));
    return [{ path, size: stat.size, mtime: stat.mtimeMs, hash: createHash("sha256").update(readFileSync(join(root, path))).digest("hex") }];
  });
}
function cli(root, args, env = authorEnv()) { return spawnSync(process.execPath, [CLI, "report", ...args, "--root", root], { encoding: "utf8", env }); }
function deterministicProposal(root, project, chapter = 1, text = "") {
  const inputs = repairInputs(root, project, chapter);
  const before = inputs.scenes[0].prose.split(/\n\s*\n/u)[0];
  const finding = inputs.findings[0];
  const declined = inputs.findings.at(-1);
  const record = { chapter, chapter_prose_sha256: inputs.hashes.chapter_prose, inputs: inputs.hashes, packet_id: "synthetic", created_at: "2026-10-16T12:00:00.000Z", status: "ready", findings: inputs.findings,
    edits: [{ number: 1, scene_id: inputs.scenes[0].id, paragraph: 1, finding_ids: finding ? [finding.id] : [], before, after: before.replace("murky", "clear"), reason: `Clarify the map. ${text}`, word_delta: -1, validation: "checked", findings_fixed: finding ? [finding.id] : [], findings_proposed: ["judgment-example"], findings_partly_fixed: ["partial-example"] }],
    declined: [{ finding_id: declined?.id || "declined-example", reason: `The author must choose the meaning. ${text}` }], dropped_edits: [{ number: 3, scene_id: inputs.scenes[0].id, paragraph: 3, before, after: before, reason: text, why: `The paragraph no longer matches. ${text}` }] };
  writeRecord(proposalPath(root, chapter), record);
  return record;
}
async function richBook(t, { hostile = false } = {}) {
  const book = makeBook(t), { root, project, paths } = book;
  const text = hostile ? HOSTILE : "The silver map belongs to Rill.";
  project.title = hostile ? HOSTILE : "The Lantern Map";
  project.author = "Synthetic Author";
  project.chapters = { 1: hostile ? HOSTILE : "Rill", 2: "Tovan" };
  project.host = { command: process.execPath, args: [HOST, "review-triage"], concurrency: 3, timeout_seconds: 10 };
  save(join(root, "project.json"), project);
  if (hostile) writeFileSync(paths[0], readFileSync(paths[0], "utf8").replace("Rill keeps the *murky* silver map.", `Rill keeps the *murky* silver map. ${HOSTILE}`));
  writeFileSync(paths[2], readFileSync(paths[2], "utf8").replace("quiet hill", "murky hill"));
  seedCharacters(root, ["Rill", "Tovan"]);
  const registry = JSON.parse(readFileSync(join(root, "world-bible", "characters.json"), "utf8"));
  registry.characters[0].aliases = ["the cartographer"];
  save(join(root, "world-bible", "characters.json"), registry);
  const rules = JSON.parse(readFileSync(join(root, "quality", "rules.json"), "utf8"));
  rules.rules[0].message = hostile ? HOSTILE : "Choose a precise description.";
  save(join(root, "quality", "rules.json"), rules);
  mkdirSync(join(root, "quality", "reviewers"), { recursive: true });
  const reviewer = hostile ? '<script>alert("x")</script> & " onmouseover="alert(1)' : "Speaking character audit";
  writeFileSync(join(root, "quality", "reviewers", "character-audit.md"), `---\nid: character-audit\ntitle: ${reviewer}\nverdicts: [CLEAR, FLAGS]\ncontext: []\nqueue: definite\n---\nCheck the speaking characters.`);
  writeFileSync(join(root, "world-bible", "report-notes.md"), `# The map\n\n${text}`);
  save(join(root, "world-bible", "canon.json"), { entries: [{ name: "Silver map", kind: "artifact", [hostile ? HOSTILE : "owner"]: text, tags: ["silver", "folded"], details: { history: "invented" } }] });
  writeFileSync(join(root, "narrative-state", "1-1.md"), `## Active threads\n\n- Added: ${hostile ? HOSTILE : "The **lantern** journey"}\n`);
  writeFileSync(join(root, "narrative-state", "2-1.md"), "## Active threads\n\n- Advanced: Tovan's watch\n");
  mkdirSync(join(root, "continuity"), { recursive: true });
  save(join(root, "continuity", "facts.json"), { subjects: { rill: [{ kind: "location", value: hostile ? HOSTILE : "Eastern Gate", scene_id: "1-1", quote: text }], tovan: [{ kind: "location", value: "North Hill", scene_id: "2-1", quote: "Tovan watches the hill." }], world: [{ kind: "location", value: "Eastern Gate", scene_id: "1-1", quote: "The gate stands open." }] } });
  await runReview(root, project, { chapter: 1, run: true, onProgress: () => {} });
  const proposal = deterministicProposal(root, project, 1, hostile ? HOSTILE : "");
  return { ...book, proposal };
}

test("report has the complete offline outline, data, counts, and an exact script hash", async (t) => {
  const { root } = await richBook(t);
  const { html, data } = buildReport(root, { now: NOW });
  for (const text of ['<!doctype html>', '<html lang="en">', '<meta charset="utf-8">', `<meta name="generator" content="${GENERATOR}">`, 'http-equiv="Content-Security-Policy"', "prefers-color-scheme:dark", "@media print", "overflow-wrap:anywhere", `Generated with ${GENERATOR} on 2026-10-17 at 14:05 UTC.`, "0 of 2 chapters approved since import", 'class="tiles"', 'class="tile"', 'id="chapter-01"', "Covers all 2 chapters.", "Choose a precise description.", "murky", "Judgment (triaged)", 'class="notes"><summary>Notes (', "<del>", "<ins>", "Word change: −1", "The author must choose the meaning.", "The paragraph no longer matches.", "The silver map belongs to Rill.", "Canon entries", "Silver map", "Eastern Gate", "Rill in scene 1-1", "The <strong>lantern</strong> journey", "Applies to all text", 'id="setup-check"', "Speaking character audit (this book)", "Confirmed fixed:", "Judgment repairs proposed:", "Partly fixed:", '<p class="file">report-notes.md</p>', "blocking · Scene 1-1", "style rules (3 blocking)"]) assert.ok(html.includes(text), text);
  assert.match(html, /<body>\s*<p class="privacy" role="note"><strong>Contains manuscript excerpts\. Share only with people you trust\.<\/strong><\/p>/u);
  assert.equal((html.match(/<style>/gu) || []).length, 1);
  // Offline: no tag names a URL, and nothing loads from outside the file.
  for (const tag of html.match(/<[a-z!][^>]*>/giu) || []) assert.doesNotMatch(tag, /:\/\/|\b(?:src|srcset|poster|data)\s*=/iu, tag);
  assert.doesNotMatch(html, /<(?:link|img|iframe|object|embed|base|form)\b|@import|url\s*\(/iu);
  const script = html.match(/<script>([\s\S]*?)<\/script>/u)[1];
  const hash = createHash("sha256").update(script).digest("base64");
  assert.ok(html.includes(`script-src 'sha256-${hash}'`));
  assert.equal(reportCsp(), `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'`);
  assert.equal(reportCsp({ header: true }), `${reportCsp()}; frame-ancestors 'none'`);
  assert.equal(reportFileName(data.project, NOW), "synthetic-book-report-2026-10-17.html");
  assert.equal(reportFileName(data.project, new Date("2026-10-17T23:59:00-07:00")), "synthetic-book-report-2026-10-18.html");
  assert.equal(data.counts.findings.rule_blocking, 3);
  assert.ok(data.counts.findings.judgment > 0);
  assert.ok(data.counts.findings.notes > 0);
  assert.equal(data.counts.findings.total, data.counts.findings.rule_blocking + data.counts.findings.judgment);
  assert.equal(data.counts.proposals.ready, 1);
  assert.equal(data.counts.edits_waiting, 1);
  assert.equal(data.counts.declines, 1);
  assert.equal(data.counts.dropped, 1);
  assert.equal(data.counts.changes_waiting, 1);
  assert.ok(html.includes(`${data.counts.findings.notes} lower-priority notes`));
  assert.ok(html.includes(`${data.counts.findings.total}</strong>open findings`));
  assert.equal(data.chapters[0].proposal.status, "ready");
  assert.equal(data.chapters[0].proposal.edits[0].findings[0].label, "murky");
  // A world fact (no character subject) reads as "In scene ...", never "world in scene ...".
  assert.ok(html.includes("In scene 1-1: “The gate stands open.”"));
  assert.equal(html.includes("world in scene"), false);
  assert.ok(html.includes("the AI made no edit. Why: The author must choose the meaning."));
  assert.equal(data.state.threads[0].entries[0].scene_id, "1-1");
  assert.equal(Object.hasOwn(data.state.threads[0].entries[0], "scene"), false);
  assert.equal(JSON.stringify(data).includes(root), false);
});

test("hostile book text stays escaped text in every report surface", async (t) => {
  const { root } = await richBook(t, { hostile: true });
  const { html, data } = buildReport(root, { now: NOW });
  assert.equal((html.match(/<script/giu) || []).length, 1);
  assert.equal((html.match(/<style/giu) || []).length, 1);
  assert.doesNotMatch(html, /<[a-z][^>]*\son[a-z]+\s*=/iu);
  assert.doesNotMatch(html, /<(?:img|link|iframe|base|form|object|embed)\b/iu);
  // The required contents links are allowed; every destination must be an in-page fragment.
  for (const tag of html.match(/<[a-z][^>]*>/giu) || []) for (const match of tag.matchAll(/\s(?:href|src|action|srcset|poster|formaction|background|cite|data)\s*=\s*["']([^"']*)["']/giu)) assert.ok(match[1].startsWith("#"), tag);
  // Book text that holds URLs stays visible text: never inside a tag, never a link.
  for (const tag of html.match(/<[a-z!][^>]*>/giu) || []) assert.doesNotMatch(tag, /:\/\/|javascript:/iu, tag);
  for (const url of ["https://evil.example/pixel.png", "javascript:alert(3)", "[click](https://evil.example/)"]) assert.ok(html.includes(url), url);
  const css = html.match(/<style>([\s\S]*?)<\/style>/u)[1];
  assert.doesNotMatch(css, /url\s*\(|@import/iu);
  for (const text of ['&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;', '&quot; onmouseover=&quot;alert(1)', "&#39; onfocus=&#39;alert(2)", "&amp;amp; &amp;lt;b&amp;gt; &amp;#x3C;", "Q".repeat(4000)]) assert.ok(html.includes(text), text.slice(0, 100));
  for (const section of [/<title>(.*?)<\/title>/su, /<section class="findings">(.*?)<\/section>/su, /<section class="proposal">(.*?)<\/section>/su, /<section id="world-bible">(.*?)<\/section>/su, /<section id="story-so-far">(.*?)<\/section>/su, /<section id="rules">(.*?)<\/section>/su]) assert.ok(section.exec(html)?.[1].includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'), String(section));
  assert.equal(data.chapters[0].proposal.edits[0].before.includes(HOSTILE), true);
  assert.equal(data.chapters[0].proposal.edits[0].after.includes(HOSTILE), true);
  assert.ok(data.chapters[0].findings.judgment.some((item) => item.label.startsWith("<script>")));
  assert.equal(html.includes(root), false);
});

test("minimal Markdown escapes first, preserves code and word underscores, and never makes links", () => {
  const html = markdownToHtml('# One\r\n## Two\n#### Three\n\n**bold** *italic* _also_ snake_case `**literal**`\nsecond line\n\n- red\n* blue\n+ green\n\n1. first\n2. next\n\n> quote\n\n```\n<script> & **literal**\n```\n\n[click](https://evil.example/) https://evil.example/ <img src=x>');
  for (const value of ["<h4>One</h4>", "<h5>Two</h5>", "<h6>Three</h6>", "<strong>bold</strong>", "<em>italic</em>", "<em>also</em>", "snake_case", "<code>**literal**</code> second line", "<ul><li>red</li><li>blue</li><li>green</li></ul>", "<ol><li>first</li><li>next</li></ol>", "<blockquote>quote</blockquote>", "<pre>&lt;script&gt; &amp; **literal**</pre>", "[click](https://evil.example/)", "&lt;img src=x&gt;"]) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /<(?:a|img|script)\b/iu);
  assert.equal(markdownToHtml("```\n**unfinished fence**"), "<pre>**unfinished fence**</pre>");
  assert.equal(markdownToHtml("a_b_c _yes_ x_no_ _no_x"), "<p>a_b_c <em>yes</em> x_no_ _no_x</p>");
  // Soft wraps join with a space; two trailing spaces keep a line break.
  assert.equal(markdownToHtml("one wrapped\nline  \nkept apart"), "<p>one wrapped line<br>kept apart</p>");
  assert.doesNotMatch(markdownToHtml("# T\nsoft\nwrap"), /<br>/u);
});

test("word diff compares small paragraphs and bounds the large-table work", (t) => {
  const diff = wordDiff("Rill carries silver.", "Rill carries gold.");
  assert.equal(diff.compared, true);
  assert.match(diff.before, /<del>silver\.<\/del>/u);
  assert.match(diff.after, /<ins>gold\.<\/ins>/u);
  const before = `${"Rill ".repeat(3000)}<script>`, after = `${"Tovan ".repeat(3000)}<img>`;
  assert.deepEqual(wordDiff(before, after), { before: `<del>${esc(before)}</del>`, after: `<ins>${esc(after)}</ins>`, compared: false });
  const { root, project } = makeBook(t);
  const record = deterministicProposal(root, project);
  record.edits[0].before = before;
  record.edits[0].after = after;
  writeRecord(proposalPath(root, 1), record);
  assert.match(buildReport(root).html, /Too long to compare word by word\./u);
});

test("chapter selection uses ranges and filters counts, places, and threads", async (t) => {
  assert.equal(parseChapterSelection(null), null);
  assert.equal(parseChapterSelection(undefined), null);
  assert.deepEqual(parseChapterSelection("3"), [[3, 3]]);
  assert.deepEqual(parseChapterSelection("1-5"), [[1, 5]]);
  assert.deepEqual(parseChapterSelection("2, 4,7-9"), [[2, 2], [4, 4], [7, 9]]);
  assert.deepEqual(parseChapterSelection("1-1000000000"), [[1, 1000000000]]);
  for (const text of ["", "1-", "x", "1,,2", "1.5", "9007199254740992"]) assert.throws(() => parseChapterSelection(text), { message: "Write chapters as numbers or ranges, for example --chapters 1-5 or --chapters 2,4,7-9." });
  for (const text of ["0", "1,0", "0-3", "3-0"]) assert.throws(() => parseChapterSelection(text), { message: "Chapter numbers start at 1." });
  assert.throws(() => parseChapterSelection("5-1"), { message: "Write each range from low to high, for example --chapters 1-5." });
  const { root } = await richBook(t);
  const { html, data } = buildReport(root, { chapters: "2", now: NOW });
  assert.match(html, /id="chapter-02"/u);
  assert.doesNotMatch(html, /id="chapter-01"/u);
  assert.match(html, /Covers chapters 2 of 2\./u);
  assert.equal(data.counts.findings.total, 1);
  assert.equal(data.counts.findings.rule_blocking, 1);
  assert.equal(data.counts.findings.notes, 0);
  assert.equal(data.counts.proposals.total, 0);
  assert.equal(data.counts.changes_waiting, 1);
  assert.deepEqual(data.state.places.map((item) => item.value), ["North Hill"]);
  assert.deepEqual(data.state.threads.map((item) => item.value), ["Tovan's watch"]);
  assert.throws(() => buildReport(root, { chapters: "9" }), { message: "No chapters match --chapters 9. This book's chapters are 1 to 2." });
  assert.match(buildReport(root, { chapters: "1-9" }).html, /Covers chapters 1–2 of 2\./u);
  const copy = structuredClone(data);
  copy.selection = { all: false, chapters: [2, 4, 7, 8, 9], total: 12 };
  assert.match(renderReport(copy), /Covers chapters 2, 4, 7–9 of 12\./u);
  copy.selection = { all: true, chapters: [1], total: 1 };
  assert.match(renderReport(copy), /Covers chapter 1\./u);
  copy.progress = { approved: [1], total: 1 };
  assert.match(renderReport(copy), /1 of 1 chapter approved since import/u);
});

test("section selection is ordered and only gathers and renders requested parts", (t) => {
  assert.deepEqual(parseSections(null), REPORT_SECTIONS);
  assert.deepEqual(parseSections(undefined), REPORT_SECTIONS);
  assert.deepEqual(parseSections(" Rules, FINDINGS, rules "), ["findings", "rules"]);
  assert.deepEqual(parseSections(["canon", " SUMMARY", "canon"]), ["summary", "canon"]);
  for (const input of ["", " , ", []]) assert.throws(() => parseSections(input), { message: "Choose at least one report section: summary, findings, proposals, canon, state, rules." });
  assert.throws(() => parseSections("wrong"), { message: "Unknown report section: wrong. Choose from summary, findings, proposals, canon, state, rules." });
  const { root } = makeBook(t);
  const { html, data } = buildReport(root, { sections: "findings" });
  assert.match(html, /class="findings"/u);
  for (const id of ["summary", "world-bible", "story-so-far", "rules"]) assert.ok(!html.includes(`id="${id}"`));
  assert.doesNotMatch(html, /class="proposal"/u);
  assert.equal(data.world_bible, null);
  assert.equal(data.state, null);
  assert.equal(data.rules, null);
  assert.equal(data.chapters[0].proposal, null);
});

test("empty and missing manuscript folders produce a useful report without a warning", (t) => {
  const root = temporary(t);
  initializeProject(root, { projectId: "empty-book", title: "Empty Book", empty: true });
  for (const removeFolder of [false, true]) {
    if (removeFolder) rmSync(join(root, "manuscript"), { recursive: true, force: true });
    const { html, data } = buildReport(root);
    for (const text of [PRIVACY_LINE, "This book has no chapters yet", 'id="world-bible"', 'id="rules"', 'id="setup-check"', "No world bible notes yet.", "No places recorded yet.", "No threads recorded yet."]) assert.ok(html.includes(text), text);
    assert.equal(data.manuscript_error, null);
    assert.deepEqual(data.warnings, []);
    assert.throws(() => buildReport(root, { chapters: "1" }), { message: "This book has no chapters yet, so --chapters can't be used." });
  }
});

test("books without proposals keep their findings and show zero waiting", (t) => {
  const { root } = makeBook(t);
  const { html, data } = buildReport(root);
  assert.equal((html.match(/No repair proposal for this chapter yet\./gu) || []).length, 2);
  assert.match(html, /0<\/strong>proposals waiting/u);
  assert.ok(data.counts.findings.total > 0);
  assert.equal(data.counts.proposals.total, 0);
  assert.equal(data.counts.edits_waiting, 0);
});

test("building a report leaves every book file and git status unchanged", async (t) => {
  const { root } = await richBook(t);
  const status = git(root, "status", "--porcelain"), files = snapshot(root);
  buildReport(root, { now: NOW });
  assert.deepEqual(snapshot(root), files);
  assert.equal(git(root, "status", "--porcelain"), status);
});

test("CLI writes and replaces reports, supports JSON and AI hosts, and refuses unsafe destinations", (t) => {
  const { root } = makeBook(t), outside = temporary(t), out = join(outside, "r.html");
  let result = cli(root, ["--out", out]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Report saved:/u);
  assert.match(result.stdout, /It contains manuscript excerpts\. Share it only with people you trust\./u);
  assert.ok(readFileSync(out, "utf8").startsWith("<!doctype html>"));
  result = cli(root, ["--out", out, "--sections", "summary"]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(readFileSync(out, "utf8"), /id="chapters"/u);
  const original = Buffer.from("An author's unrelated notes.\n");
  writeFileSync(out, original);
  result = cli(root, ["--out", out]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to replace r\.html: it is not a Weaver report\. Choose a new file name\./u);
  assert.deepEqual(readFileSync(out), original);
  for (const path of [join(outside, "notes.txt"), join(root, "quality", "r.html"), join(root, ".weaver", "r.html"), join(root, "manuscript", "r.html"), join(root, "narrative-state", "r.html")]) {
    const args = path.includes("quality") ? [`--out=${path}`] : ["--out", path];
    result = cli(root, args);
    assert.equal(result.status, 1, path);
    assert.match(result.stderr, path.endsWith(".txt") ? /Save the report as an \.html file/u : /Weaver won't save the report inside the book's protected or manuscript folders/u);
    assert.equal(existsSync(path), false);
  }
  result = cli(root, []);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: weaver report --out <file\.html>/u);
  result = cli(root, ["--out", join(outside, "no-match.html"), "--chapters", "9"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No chapters match --chapters 9\. This book's chapters are 1 to 2\./u);
  assert.equal(existsSync(join(outside, "no-match.html")), false);
  const jsonOut = join(outside, "json.html");
  result = cli(root, ["--out", jsonOut, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.out, jsonOut);
  assert.equal(json.bytes, statSync(jsonOut).size);
  assert.deepEqual(json.chapters, [1, 2]);
  assert.deepEqual(json.sections, REPORT_SECTIONS);
  assert.deepEqual(json.warnings, []);
  result = cli(root, ["--out", jsonOut], { ...authorEnv(), CLAUDECODE: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(AUTHOR_ONLY_COMMANDS.includes("report"), false);
  writeFileSync(join(root, ".claude", "settings.json"), "{}");
  writeFileSync(join(root, "quality", "rules.json"), "broken rules");
  result = cli(root, ["--out", jsonOut, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).warnings.some((warning) => warning.startsWith("Findings could not be read:")));
  assert.match(result.stderr, /Warning: Findings could not be read:/u);
  assert.match(result.stderr, /Warning: .*hooks|Warning: .*guardrails/u);
  const damaged = readFileSync(jsonOut, "utf8");
  assert.match(damaged, /Supported setup: no/u);
  assert.match(damaged, /Guardrails: off/u);
});

test("write guards cover folders, custom content roots, case, the first 4 KB and creation order", (t) => {
  const { root, project } = makeBook(t), outside = temporary(t);
  assert.throws(() => writeReport(root, null), /usage: weaver report/u);
  const folder = join(outside, "folder.html");
  mkdirSync(folder);
  assert.throws(() => writeReport(root, folder), { message: "That path is a folder. Give a file name, for example --out report.html." });
  const tooLate = join(outside, "late.html");
  const bytes = "x".repeat(4096) + '<meta name="generator" content="PickBits Weaver';
  writeFileSync(tooLate, bytes);
  assert.throws(() => writeReport(root, tooLate), /it is not a Weaver report/u);
  assert.equal(readFileSync(tooLate, "utf8"), bytes);
  const newParent = join(outside, "not-created", "r.html");
  assert.throws(() => writeReport(root, newParent, { chapters: "9" }), /No chapters match/u);
  assert.equal(existsSync(join(outside, "not-created")), false);
  const blockedParent = join(outside, "a-file");
  writeFileSync(blockedParent, "Keep these notes.");
  assert.throws(() => writeReport(root, join(blockedParent, "r.html")), { message: "The report file could not be opened or saved. Check the folder and its permissions, or choose another file name." });
  assert.equal(readFileSync(blockedParent, "utf8"), "Keep these notes.");
  const out = join(outside, "new", "r.HTM");
  const result = writeReport(root, out, { now: NOW });
  assert.equal(result.bytes, statSync(out).size);
  assert.deepEqual(result.chapters, [1, 2]);
  project.source_root = "drafts";
  project.state_root = "story-memory";
  save(join(root, "project.json"), project);
  for (const name of ["drafts", "story-memory", ...(process.platform === "win32" ? ["DRAFTS", "STORY-MEMORY", "QUALITY"] : [])]) {
    const destination = join(root, name, "r.html");
    assert.throws(() => writeReport(root, destination), /protected or manuscript folders/u);
    assert.equal(existsSync(destination), false);
  }
  assert.doesNotThrow(() => writeReport(root, join(root, "drafts-other", "r.html")));
});

test("shell hook allows report sharing and denies a protected destination", (t) => {
  const { root } = makeBook(t);
  const hook = (command) => runHook("shell", { cwd: root, tool_name: "Bash", tool_input: { command } });
  assert.equal(hook("npx weaver report --out quality/report.html").hookSpecificOutput.permissionDecision, "deny");
  assert.notEqual(hook("npx weaver report --out report.html")?.hookSpecificOutput?.permissionDecision, "deny");
});

test("studio report download has offline headers, navigation, and no book writes", async (t) => {
  const { root, project } = makeBook(t);
  const server = await startStudio({ root, port: 0 });
  t.after(() => new Promise((done) => server.close(done)));
  assert.equal(server.address().address, "127.0.0.1");
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = git(root, "status", "--porcelain"), files = snapshot(root);
  const response = await fetch(`${base}/report.html`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(response.headers.get("content-disposition"), new RegExp(`^attachment; filename="${project.project_id}-report-\\d{4}-\\d{2}-\\d{2}\\.html"$`, "u"));
  assert.equal(response.headers.get("content-security-policy"), reportCsp({ header: true }));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.ok((await response.text()).includes(PRIVACY_LINE));
  assert.deepEqual(snapshot(root), files);
  assert.equal(git(root, "status", "--porcelain"), status);
  assert.match(await (await fetch(base)).text(), /href="\/report\.html">Download report<\/a>/u);
  // A page served under another host name (DNS rebinding) cannot pull the report.
  const port = server.address().port;
  const get = (host) => new Promise((done, fail) => request({ host: "127.0.0.1", port, path: "/report.html", headers: { host } }, (reply) => { let text = ""; reply.on("data", (chunk) => { text += chunk; }); reply.on("end", () => done({ status: reply.statusCode, text })); }).on("error", fail).end());
  const rebound = await get(`evil.example:${port}`);
  assert.equal(rebound.status, 403);
  assert.equal(rebound.text.includes(PRIVACY_LINE), false);
  assert.match(rebound.text, /only available from the local studio page/u);
  const local = await get(`localhost:${port}`);
  assert.equal(local.status, 200);
  assert.ok(local.text.includes(PRIVACY_LINE));
  writeFileSync(join(root, "project.json"), "broken project");
  const broken = await fetch(`${base}/report.html`);
  assert.equal(broken.status, 500);
  assert.equal(broken.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal((await broken.text()).includes(root), false);
});

test("report tools enhance the page and restore closed details after printing", (t) => {
  const { root } = makeBook(t);
  const html = buildReport(root).html;
  assert.match(html, /id="report-tools" class="tools" hidden/u);
  for (const action of ["expand", "collapse", "print"]) assert.ok(html.includes(`data-do="${action}"`));
  assert.match(html, /<details class="chapter" id="chapter-01" open>/u);
  assert.match(html, /<details class="notes"><summary>/u);
  const script = html.match(/<script>([\s\S]*?)<\/script>/u)[1];
  const listeners = {}, details = [{ open: true }, { open: false }];
  const tools = { hidden: true, addEventListener: (name, fn) => { listeners[name] = fn; } };
  let printed = 0;
  runInNewContext(script, { document: { getElementById: (id) => { assert.equal(id, "report-tools"); return tools; }, querySelectorAll: (selector) => { assert.equal(selector, "details"); return details; } }, window: { print: () => { printed++; }, addEventListener: (name, fn) => { listeners[name] = fn; } } });
  assert.equal(tools.hidden, false);
  const click = (action) => listeners.click({ target: { getAttribute: () => action } });
  click("expand"); assert.ok(details.every((item) => item.open));
  click("collapse"); assert.ok(details.every((item) => !item.open));
  click("print"); assert.equal(printed, 1);
  details[0].open = true;
  listeners.beforeprint(); assert.ok(details.every((item) => item.open));
  listeners.afterprint(); assert.deepEqual(details.map((item) => item.open), [true, false]);
  details[1].open = true;
  listeners.beforeprint(); listeners.afterprint(); assert.ok(details.every((item) => item.open));
});

test("damaged sections show notices independently and scrub all system paths", async (t) => {
  const { root, paths } = await richBook(t);
  const systemMessage = `Cannot read ${root} or ${root.replaceAll("\\", "/")} or C:\\private\\book.txt or /home/writer/book.txt or /Users/writer/book.txt or /tmp/book.txt or /var/book.txt or /private/book.txt`;
  const originalRead = fs.readFileSync;
  for (const [path, sections, parts] of [
    [join(root, "quality", "rules.json"), null, ["Findings", "Proposals", "Changes waiting", "Rules"]],
    [proposalPath(root, 1), null, ["Proposals"]],
    [join(root, "world-bible", "report-notes.md"), "canon", ["World bible"]],
    [join(root, "world-bible", "characters.json"), "canon", ["Characters"]],
    [join(root, "continuity", "facts.json"), "state", ["Story so far"]]
  ]) {
    const mocked = t.mock.method(fs, "readFileSync", (file, ...args) => { if (String(file) === path) throw new Error(systemMessage); return originalRead(file, ...args); });
    syncBuiltinESMExports();
    try {
      const { html, data } = buildReport(root, { sections });
      for (const part of parts) { assert.ok(data.warnings.some((warning) => warning.startsWith(`${part} could not be read:`)), part); assert.ok(html.includes(`${part} could not be read:`), part); }
      assert.match(html, /class="notice"/u);
      assert.ok(html.includes("a local file"));
      for (const value of [root, root.replaceAll("\\", "/"), "C:\\private", "/home/writer", "/Users/writer", "/tmp/book", "/var/book", "/private/book"]) assert.equal(html.includes(value), false, value);
      assert.ok(html.includes('id="setup-check"'));
      if (sections === null) assert.ok(data.world_bible.markdown);
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  }
  const originalStat = fs.statSync;
  const mocked = t.mock.method(fs, "statSync", (path, ...args) => { if (String(path) === resolve("engine")) throw new Error(systemMessage); return originalStat(path, ...args); });
  syncBuiltinESMExports();
  try {
    const { html, data } = buildReport(root);
    assert.ok(data.doctor.error);
    assert.match(html, /Setup check could not be read:/u);
    assert.equal(html.includes(root), false);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  const record = JSON.parse(readFileSync(proposalPath(root, 1), "utf8"));
  record.status = "failed";
  record.error = systemMessage;
  writeRecord(proposalPath(root, 1), record);
  const failed = buildReport(root);
  assert.equal(failed.data.chapters[0].proposal.status, "failed");
  assert.match(failed.html, /This proposal failed: Cannot read the book folder/u);
  assert.equal(failed.html.includes(root), false);
  writeFileSync(paths[0], "Not a scene file.");
  const unreadable = buildReport(root);
  assert.ok(unreadable.data.manuscript_error);
  assert.match(unreadable.html, /The manuscript could not be read:/u);
});

test("canon accepts varied schemas, falls back to escaped JSON, and isolates invalid JSON", (t) => {
  const { root } = makeBook(t), path = join(root, "world-bible", "canon.json");
  assert.equal(collectReportData(root, { sections: "canon" }).world_bible.canon, null);
  save(path, [{ term: "Lantern", category: "object", lit: false, weight: 0, tags: ["tin", "blue"], empty: "", missing: null, nested: { inner: { text: "x".repeat(400) } }, origin: { maker: "Brask", year: 12, gone: null } }, { other: "Wren" }]);
  let result = buildReport(root, { sections: "canon" });
  assert.equal(result.data.world_bible.canon.entries[0].title, "Lantern");
  assert.equal(result.data.world_bible.canon.entries[0].kind, "object");
  assert.equal(result.data.world_bible.canon.entries[1].title, "Entry 2");
  const fields = Object.fromEntries(result.data.world_bible.canon.entries[0].fields);
  assert.equal(fields.lit, "false");
  assert.equal(fields.weight, "0");
  assert.equal(fields.tags, "tin, blue");
  assert.equal(fields.nested.length, 300);
  assert.equal(fields.origin, "maker: Brask; year: 12");
  assert.equal(fields.empty, undefined);
  assert.equal(fields.missing, undefined);
  // A canon model with fact records (quotes and scenes) reads as one line per record, escaped.
  save(path, { $schema: "https://example.invalid/canon-1.json", version: 1, entries: [{ id: "lantern", kind: "object", name: "Lantern", aliases: ["the tin light"], status: "confirmed", facts: [{ text: "Brask made it.", scene_id: "1-1", quote: "<b>Brask</b> made it" }, { text: "It burns blue.", scene_id: "2-1", quote: "blue flame" }], sources: [{ type: "scene", ref: "https://evil.example/ref" }] }] });
  result = buildReport(root, { sections: "canon" });
  const records = Object.fromEntries(result.data.world_bible.canon.entries[0].fields);
  assert.equal(records.facts, "text: Brask made it.; scene_id: 1-1; quote: <b>Brask</b> made it\ntext: It burns blue.; scene_id: 2-1; quote: blue flame");
  assert.equal(records.aliases, "the tin light");
  assert.ok(result.html.includes("<dd>text: Brask made it.; scene_id: 1-1; quote: &lt;b&gt;Brask&lt;/b&gt; made it\ntext: It burns blue."));
  assert.ok(result.html.includes("<dd>type: scene; ref: https://evil.example/ref</dd>"));
  assert.match(result.html, /dd\{[^}]*white-space:pre-line/u);
  assert.equal(result.html.includes("example.invalid"), false);
  save(path, { unknown: "<script>invented</script>" });
  result = buildReport(root, { sections: "canon" });
  assert.equal(result.data.world_bible.canon.json, JSON.stringify({ unknown: "<script>invented</script>" }, null, 2));
  assert.match(result.html, /<pre>\{[\s\S]*&lt;script&gt;invented&lt;\/script&gt;/u);
  writeFileSync(path, "invalid");
  result = buildReport(root, { sections: "canon" });
  assert.equal(result.data.world_bible.canon.error, "world-bible/canon.json could not be read, so its entries are not shown.");
  assert.ok(result.html.includes(result.data.world_bible.canon.error));
  assert.ok(result.data.warnings.includes(result.data.world_bible.canon.error));
});

test("proposal statuses, stale reviews, voice details and measured findings have plain labels", async (t) => {
  const { root, paths } = await richBook(t);
  const { data } = buildReport(root);
  const proposal = data.chapters[0].proposal;
  for (const [status, message] of [["ready", "Ready for the author to accept or reject."], ["stale", "Out of date: the chapter or its findings changed after this proposal was made. Ask again for a fresh proposal."], ["accepted", "Accepted (edits 1, 3) on 2026-10-17."], ["declined", "The AI declined every finding."], ["failed", "This proposal failed: Try again."], ["no-usable-edits", "No usable edits. Read the drop reasons below, then ask again."], ["nothing-to-repair", "Nothing to repair in this chapter."]]) {
    Object.assign(proposal, { status, accepted_edits: [1, 3], accepted_at: "2026-10-17", error: "Try again." });
    assert.ok(renderReport(data).includes(message), status);
  }
  for (const delta of [0, 2]) { proposal.edits[0].word_delta = delta; assert.ok(renderReport(data).includes(`Word change: ${delta ? "+2" : "0"}`)); }
  data.chapters[0].findings.voice.push({ id: "voice-example", label: "Rill", severity: "warn", scene_id: "1-1", paragraph: 3, quote: "I carry the lantern.", issue: "Check this voice.", repair: "Keep the usual rhythm.", reasons: ["The rhythm changed."], sounds_like: "Tovan", ruling: "author wants this fixed", count: 4, limit: 3 });
  const html = renderReport(data);
  for (const text of ["Maybe sounds like Tovan.", "The rhythm changed.", "author wants this fixed", "4 found, limit 3", "Scene 1-1 · ¶3"]) assert.ok(html.includes(text), text);
  writeFileSync(paths[0], readFileSync(paths[0], "utf8").replace("silver map", "bronze map"));
  const stale = buildReport(root);
  assert.ok(stale.data.chapters[0].stale_reviews.includes("continuity"));
  assert.equal(stale.data.counts.proposals.stale, 1);
  assert.equal(stale.data.counts.edits_waiting, 0);
  assert.match(stale.html, /review out of date/u);
});

test("reports follow protection through folder shortcuts", (t) => {
  const { root } = makeBook(t), outside = temporary(t), alias = join(outside, "book-alias");
  symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  for (const folder of ["quality", "manuscript", "narrative-state"]) {
    assert.throws(() => writeReport(root, join(alias, folder, "r.html")), /protected or manuscript folders/u);
    assert.equal(existsSync(join(root, folder, "r.html")), false);
  }
  // A protected folder that is itself a shortcut to somewhere else is still refused by its name.
  const elsewhere = join(outside, "weaver-elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(root, ".weaver"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => writeReport(root, join(root, ".weaver", "r.html")), /protected or manuscript folders/u);
  assert.equal(existsSync(join(elsewhere, "r.html")), false);
});
