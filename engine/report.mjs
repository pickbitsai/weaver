// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { approvalProgress, diffWords, doctorStatus, esc, localMessage, placeGroups, threadGroups } from "./studio.mjs";
import { collectFindings } from "./findings.mjs";
import { listProposals } from "./repair.mjs";
import { describePendingChanges } from "./changes.mjs";
import { loadScenes } from "./manuscript.mjs";
import { readProject } from "./project.mjs";
import { loadCharacters } from "./characters.mjs";
import { loadRules, ruleScopeDescription } from "./rules.mjs";
import { listLenses } from "./reviewers.mjs";
import { worldBible } from "./review.mjs";
import { narrativeStateStatus, readFactsLedger } from "./state.mjs";
import { runDoctor } from "./doctor.mjs";
import { GENERATOR } from "./identity.mjs";

export const REPORT_SECTIONS = ["summary", "findings", "proposals", "canon", "state", "rules"];
export const REPORT_MARKER = '<meta name="weaver-report" content="shareable-report">';
export const PRIVACY_LINE = "Contains manuscript excerpts. Share only with people you trust.";
const USAGE = "usage: weaver report --out <file.html> [--chapters 1-5] [--sections summary,findings,proposals,canon,state,rules] [--root directory] [--json]";

export function parseChapterSelection(text) {
  if (text == null) return null;
  const syntax = "Write chapters as numbers or ranges, for example --chapters 1-5 or --chapters 2,4,7-9.";
  if (typeof text !== "string" || !/^\s*\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*\s*$/u.test(text)) throw new Error(syntax);
  const ranges = text.split(",").map((part) => {
    const [low, high = low] = part.trim().split(/\s*-\s*/u).map(Number);
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)) throw new Error(syntax);
    return [low, high];
  });
  if (ranges.some(([low, high]) => !low || !high)) throw new Error("Chapter numbers start at 1.");
  if (ranges.some(([low, high]) => low > high)) throw new Error("Write each range from low to high, for example --chapters 1-5.");
  return ranges;
}

export function parseSections(value) {
  if (value == null) return [...REPORT_SECTIONS];
  const chosen = (Array.isArray(value) ? value : String(value).split(",")).map((part) => String(part).trim().toLowerCase()).filter(Boolean);
  for (const name of chosen) if (!REPORT_SECTIONS.includes(name)) throw new Error(`Unknown report section: ${name}. Choose from ${REPORT_SECTIONS.join(", ")}.`);
  if (!chosen.length) throw new Error(`Choose at least one report section: ${REPORT_SECTIONS.join(", ")}.`);
  return REPORT_SECTIONS.filter((name) => chosen.includes(name));
}

export function markdownToHtml(text) {
  // Escape first. Code spans are kept separate so emphasis never changes their contents.
  const lines = esc(text).replace(/\r\n?/gu, "\n").split("\n");
  const inline = (value) => value.split(/(`[^`]*`)/gu).map((part) => part.startsWith("`") && part.endsWith("`")
    ? `<code>${part.slice(1, -1)}</code>`
    : part.replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>").replace(/(?<!\*)\*([^*]+)\*(?!\*)/gu, "<em>$1</em>").replace(/(?<![\p{L}\p{N}_])_([^_]+)_(?![\p{L}\p{N}_])/gu, "<em>$1</em>")).join("");
  const result = [];
  let block = [], kind = null, fenced = false;
  const flush = () => {
    if (!block.length) return;
    // Markdown soft wraps: source line breaks become spaces; two trailing spaces force a line break.
    result.push(kind === "ul" || kind === "ol" ? `<${kind}>${block.map((line) => `<li>${inline(line)}</li>`).join("")}</${kind}>` : `<${kind}>${block.map((line, index) => inline(line.replace(/ +$/u, "")) + (index < block.length - 1 ? (/ {2,}$/u.test(line) ? "<br>" : " ") : "")).join("")}</${kind}>`);
    block = [];
  };
  for (const line of lines) {
    if (/^\s*```/u.test(line)) {
      if (fenced) { result.push(`<pre>${block.join("\n")}</pre>`); block = []; fenced = false; kind = null; }
      else { flush(); fenced = true; }
      continue;
    }
    if (fenced) { block.push(line); continue; }
    if (!line.trim()) { flush(); kind = null; continue; }
    const heading = /^(#{1,})\s+(.+)$/u.exec(line);
    if (heading) { flush(); const level = Math.min(6, heading[1].length + 3); result.push(`<h${level}>${inline(heading[2])}</h${level}>`); kind = null; continue; }
    const bullet = /^\s*(?:[-*+] |\d+\. )(.+)$/u.exec(line);
    const quote = /^&gt;\s?(.*)$/u.exec(line);
    const nextKind = bullet ? (/^\s*\d/u.test(line) ? "ol" : "ul") : quote ? "blockquote" : "p";
    if (nextKind !== kind) flush();
    kind = nextKind;
    block.push(bullet?.[1] ?? quote?.[1] ?? line);
  }
  if (fenced) result.push(`<pre>${block.join("\n")}</pre>`); else flush();
  return result.join("\n");
}

export function wordDiff(before, after) {
  const a = before.match(/\s+|[^\s]+/gu) || [], b = after.match(/\s+|[^\s]+/gu) || [];
  if (a.length * b.length > 4_000_000) return { before: `<del>${esc(before)}</del>`, after: `<ins>${esc(after)}</ins>`, compared: false };
  return { ...diffWords(before, after), compared: true };
}

const REPORT_SCRIPT = `(function () {
  var tools = document.getElementById('report-tools');
  var closed = [];
  function eachDetails(fn) { var items = document.querySelectorAll('details'); for (var i = 0; i < items.length; i++) fn(items[i]); }
  tools.hidden = false;
  tools.addEventListener('click', function (event) {
    var action = event.target.getAttribute('data-do');
    if (action === 'print') window.print();
    if (action === 'expand' || action === 'collapse') eachDetails(function (item) { item.open = action === 'expand'; });
  });
  window.addEventListener('beforeprint', function () { eachDetails(function (item) { if (!item.open) { closed.push(item); item.open = true; } }); });
  window.addEventListener('afterprint', function () { for (var i = 0; i < closed.length; i++) closed[i].open = false; closed = []; });
}());`;

export function reportCsp({ header = false } = {}) {
  const hash = createHash("sha256").update(REPORT_SCRIPT).digest("base64");
  return `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'${header ? "; frame-ancestors 'none'" : ""}`;
}

export function reportFileName(project, now = new Date()) {
  return `${project.project_id}-report-${now.toISOString().slice(0, 10)}.html`;
}

function canonData(root) {
  const path = join(root, "world-bible", "canon.json");
  if (!existsSync(path)) return null;
  let doc;
  try { doc = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, "")); }
  catch { return { error: "world-bible/canon.json could not be read, so its entries are not shown." }; }
  const entries = Array.isArray(doc) ? doc : doc?.entries;
  if (!Array.isArray(entries)) return { json: JSON.stringify(doc, null, 2) };
  const scalar = (value) => value != null && ["string", "number", "boolean"].includes(typeof value);
  const flat = (value) => scalar(value) || (Array.isArray(value) && value.every(scalar));
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((item) => item == null || flat(item));
  const pairs = (value) => Object.entries(value).filter(([, item]) => item != null && item !== "" && (!Array.isArray(item) || item.length)).map(([key, item]) => `${key}: ${display(item)}`).join("; ");
  // Flat records (for example facts with their quotes) read as "key: value" lines; deeper nesting stays short JSON.
  const display = (value) => scalar(value) ? String(value) : Array.isArray(value) && value.every(scalar) ? value.join(", ") : record(value) ? pairs(value) : Array.isArray(value) && value.every(record) ? value.map(pairs).join("\n") : JSON.stringify(value).slice(0, 300);
  return { entries: entries.map((entry, index) => {
    const item = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : { value: entry };
    const titleKey = ["name", "title", "term", "label", "id"].find((key) => item[key] != null && item[key] !== "");
    const kindKey = ["kind", "type", "category"].find((key) => item[key] != null && item[key] !== "");
    return { title: titleKey ? display(item[titleKey]) : `Entry ${index + 1}`, kind: kindKey ? display(item[kindKey]) : null,
      fields: Object.entries(item).filter(([key, value]) => key !== titleKey && key !== kindKey && value != null && value !== "" && (!Array.isArray(value) || value.length)).map(([key, value]) => [key, display(value)]) };
  }) };
}

const textValue = (value) => value == null ? "" : String(value);
const listValue = (value) => Array.isArray(value) ? value : [];

function normalizeFinding(item) {
  // Same fallbacks as the studio's finding cards: an empty quote falls back to the excerpt or line.
  return { id: textValue(item?.id), kind: textValue(item?.kind), label: textValue(item?.reviewer_title || item?.source || item?.rule_id), severity: textValue(item?.severity),
    scene_id: textValue(item?.scene_id), paragraph: item?.paragraph, quote: textValue(item?.quote || item?.excerpt || item?.line), issue: textValue(item?.issue), repair: textValue(item?.repair),
    ruling: item?.ruling == null ? null : String(item.ruling), reasons: listValue(item?.reasons).map(textValue), sounds_like: textValue(item?.maybe_sounds_like?.character), count: item?.count, limit: item?.limit };
}

function normalizeProposal(record, scrub) {
  const findings = new Map(listValue(record.findings).map((item) => [textValue(item?.id), normalizeFinding(item)]));
  return { status: textValue(record.status), created_at: textValue(record.created_at), accepted_at: textValue(record.accepted_at), accepted_edits: listValue(record.accepted_edits).map(textValue), error: record.error ? scrub(textValue(record.error)) : null,
    edits: listValue(record.edits).map((edit) => {
      if (!edit || typeof edit !== "object" || typeof edit.before !== "string" || typeof edit.after !== "string") throw new Error("an edit is missing its before or after text");
      return { number: edit.number, scene_id: textValue(edit.scene_id), paragraph: edit.paragraph, before: edit.before, after: edit.after, reason: textValue(edit.reason), word_delta: Number.isFinite(edit.word_delta) ? edit.word_delta : 0, validation: textValue(edit.validation),
        findings: listValue(edit.finding_ids).map((id) => ({ id: textValue(id), label: textValue(findings.get(textValue(id))?.label), issue: textValue(findings.get(textValue(id))?.issue) })), fixed: listValue(edit.findings_fixed).map(textValue), proposed: listValue(edit.findings_proposed).map(textValue), partly_fixed: listValue(edit.findings_partly_fixed).map(textValue) };
    }),
    declined: listValue(record.declined).map((item) => { const finding = findings.get(textValue(item?.finding_id)); return { finding_id: textValue(item?.finding_id), reason: textValue(item?.reason), label: textValue(finding?.label), scene_id: textValue(finding?.scene_id), paragraph: finding?.paragraph, quote: textValue(finding?.quote), issue: textValue(finding?.issue) }; }),
    dropped: listValue(record.dropped_edits).map((edit) => ({ number: edit?.number, scene_id: textValue(edit?.scene_id), paragraph: edit?.paragraph, why: textValue(edit?.why) })) };
}

export function collectReportData(root, { chapters = null, sections = null, now = new Date() } = {}) {
  root = resolve(root);
  const project = readProject(root), selection = parseChapterSelection(chapters);
  sections = parseSections(sections);
  const scrub = (text) => localMessage(text, root).replaceAll(root.replaceAll("\\", "/"), "the book folder").replace(/\/(?:home|Users|tmp|var|private)\/[^\s<>"']*/gu, "a local file");
  const warnings = [];
  const part = (name, read) => { try { return read(); } catch (error) { const message = scrub(error.message); warnings.push(`${name} could not be read: ${message}`); return { error: message }; } };
  let scenes = [], manuscript_error = null;
  try { scenes = loadScenes(root, project); }
  catch (error) {
    if (!/^(?:no canonical scenes found|missing source root)/u.test(error.message)) {
      const separators = /^(.*): expected metadata and footer separators$/u.exec(error.message);
      manuscript_error = separators ? `${scrub(separators[1]).replaceAll("\\", "/")}: this scene file needs its two --- separator lines (one after the scene heading, one before the footer).` : scrub(error.message);
      warnings.push(`The manuscript could not be read: ${manuscript_error}`);
    }
  }
  const all_chapters = [...new Set(scenes.map((scene) => scene.chapter))].sort((a, b) => a - b);
  if (selection && manuscript_error) throw new Error(`The manuscript could not be read, so --chapters can't be used: ${manuscript_error}`);
  if (selection && !all_chapters.length) throw new Error("This book has no chapters yet, so --chapters can't be used.");
  const chosen = all_chapters.filter((n) => !selection || selection.some(([low, high]) => n >= low && n <= high));
  if (selection && !chosen.length) throw new Error(`No chapters match --chapters ${chapters}. This book has ${all_chapters.length === 1 ? "chapter" : "chapters"} ${chapterRanges(all_chapters)}.`);
  const approved = approvalProgress(root, scenes);
  const progress = { approved: [...approved.approved].sort((a, b) => a - b), total: approved.total };
  const needs = (...names) => names.some((name) => sections.includes(name));
  const collected = scenes.length && needs("summary", "findings", "proposals") ? part("Findings", () => collectFindings(root, project, { all: true })) : null;
  const proposals = scenes.length && needs("summary", "proposals") ? part("Proposals", () => listProposals(root, project, { scenes, collected: collected?.error ? undefined : collected }).map((record) => {
    try { return { chapter: record.chapter, ...normalizeProposal(record, scrub) }; }
    catch (error) {
      const message = `This proposal record is damaged (${scrub(error.message)}). Ask again for a fresh proposal.`;
      warnings.push(`Chapter ${record.chapter} proposal could not be read: ${message}`);
      return { chapter: record.chapter, error: message };
    }
  })) : null;
  const pending = scenes.length ? part("Changes waiting", () => describePendingChanges(root, project)) : { chapters: [] };
  const characters = needs("canon", "state", "rules") ? part("Characters", () => loadCharacters(root).characters) : [];
  let world_bible = null;
  if (needs("canon")) {
    world_bible = part("World bible", () => { const markdown = worldBible(root); return { markdown: markdown === "_No project world-bible notes._" ? null : markdown }; });
    world_bible.canon = canonData(root);
    if (world_bible.canon?.error) warnings.push(world_bible.canon.error);
    world_bible.characters = characters.error ? characters : characters.map(({ name, aliases }) => ({ name, aliases }));
  }
  const selectedScene = (id) => chosen.includes(Number(String(id).split("-")[0]));
  const state = needs("state") ? part("Story so far", () => {
    const status = scenes.length ? narrativeStateStatus(root, project) : { current: 0, stale: 0, records: [] };
    return { current: status.current, stale: status.stale, total: status.records.length,
      places: [...placeGroups(readFactsLedger(root)).values()].map(({ value, entries }) => ({ value, entries: entries.filter((entry) => selectedScene(entry.scene_id)).map((entry) => ({ who: entry.subject === "world" ? null : (characters.error ? [] : characters).find((item) => item.id === entry.subject)?.name || entry.subject, scene_id: entry.scene_id, quote: entry.quote })) })).filter((group) => group.entries.length),
      threads: [...threadGroups(root, project, scenes).values()].map(({ value, entries }) => ({ value, entries: entries.filter(({ scene }) => chosen.includes(scene.chapter)).map(({ scene, status }) => ({ scene_id: scene.id, status })) })).filter((group) => group.entries.length) };
  }) : null;
  const rules = needs("rules") ? part("Rules", () => loadRules(root).rules.map((rule) => ({ id: rule.id, type: rule.type, severity: rule.severity, message: rule.message, scope: ruleScopeDescription(rule, characters.error ? [] : characters) }))) : null;
  const reviewers = needs("rules") ? part("Reviewers", () => listLenses(root).map(({ title, builtin }) => ({ title, builtin }))) : null;
  const doctor = part("Setup check", () => {
    const report = runDoctor({ bookRoot: root });
    const status = doctorStatus(report);
    return { ok: report.ok, blocking: report.blocking.map(({ problem, why, fix }) => ({ problem: scrub(problem), why: scrub(why), fix: scrub(fix) })), guardrails_on: status.guardOn, guard_problem: status.guardProblem ? scrub(status.guardProblem.problem) : null,
      integrity_ok: status.integrity, guardrail_labels: status.labels.map(scrub) };
  });
  const chapterData = chosen.map((number) => {
    const queue = collected?.chapters?.find((item) => item.chapter === number);
    const findings = queue ? { rule: [], voice: [], judgment: [], notes: queue.notes.map(normalizeFinding) } : null;
    if (queue) for (const finding of queue.findings) findings[finding.kind].push(normalizeFinding(finding));
    return { number, title: project.chapters?.[number] || null, approved: progress.approved.includes(number), changes_waiting: pending.chapters?.some((item) => item.chapter === number) || false,
      open_findings: queue?.findings.length || 0, stale_reviews: queue?.stale_reviews || [], findings: collected?.error ? collected : findings,
      proposal: proposals?.error ? proposals : proposals?.find((item) => item.chapter === number) || null };
  });
  const counts = { findings: { rule_blocking: 0, rule_warnings: 0, voice: 0, judgment: 0, notes: 0, total: 0 }, proposals: { total: 0, ready: 0, stale: 0, accepted: 0, declined: 0, failed: 0, no_usable_edits: 0, nothing_to_repair: 0 }, edits_waiting: 0, declines: 0, dropped: 0, changes_waiting: 0 };
  for (const chapter of chapterData) {
    const f = chapter.findings, p = chapter.proposal;
    if (f && !f.error) { counts.findings.rule_blocking += f.rule.filter((item) => item.severity === "block").length; counts.findings.rule_warnings += f.rule.filter((item) => item.severity === "warn").length; for (const kind of ["voice", "judgment", "notes"]) counts.findings[kind] += f[kind].length; counts.findings.total += chapter.open_findings; }
    if (p?.status) { counts.proposals.total++; counts.proposals[p.status.replaceAll("-", "_")]++; if (p.status === "ready") counts.edits_waiting += p.edits.length; counts.declines += p.declined.length; counts.dropped += p.dropped.length; }
    if (chapter.changes_waiting) counts.changes_waiting++;
  }
  return { generator: GENERATOR, generated_at: now.toISOString(), project: { title: project.title, author: project.author, project_id: project.project_id }, selection: { all: selection === null, chapters: chosen, total: all_chapters.length, text: chapters }, sections, warnings, manuscript_error, progress, chapters: chapterData, counts, world_bible, state, rules, reviewers, doctor,
    errors: { findings: collected?.error || null, proposals: proposals?.error || null, pending: pending.error || null, characters: characters.error || null } };
}

const REPORT_CSS = `:root{color-scheme:light dark;--page:#faf9f5;--ink:#242522;--muted:#5e615d;--line:#cccfc9;--card:#fff;--accent:#315b72;--good:#2f6b3f;--warn:#8a5a00;--bad:#9b2c2c;--banner:#fff4d6;--banner-ink:#4a3700;--del-bg:#eec9c9;--del-ink:#2b1616;--ins-bg:#caecd4;--ins-ink:#15351c}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:var(--page);color:var(--ink);overflow-wrap:anywhere}
.wrap{max-width:60rem;margin:0 auto;padding:1rem}.privacy{margin:0;padding:.85rem 1rem;background:var(--banner);color:var(--banner-ink);font-weight:bold;text-align:center;border-bottom:1px solid var(--line)}
h1{font-size:clamp(1.7rem,5vw,2.4rem);line-height:1.2}h2{font-size:1.4rem}h3{font-size:1.15rem}h4,h5,h6{font-size:1rem}h1,h2,h3,h4{margin:1.25rem 0 .6rem}h5,h6{margin:1rem 0 .4rem}.card>:first-child{margin-top:0}.file{margin:0 0 .5rem;font:600 .8rem/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted)}summary h2{display:inline}summary{cursor:pointer}summary .chip{margin-left:.4rem}p{margin:.6rem 0}a{color:var(--accent)}section,footer{margin:1.5rem 0}footer{border-top:2px solid var(--line);padding-top:1rem}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr));gap:.75rem}.tile{padding:1rem;border:1px solid var(--line);border-radius:.6rem;background:var(--card)}.tile strong{display:block;font-size:1.9rem}.tile small{display:block;color:var(--muted)}
.chip{display:inline-block;font-size:.8rem;border:1px solid var(--line);border-radius:2rem;padding:.08rem .5rem}.chip.good{color:var(--good);border-color:var(--good)}.chip.warn{color:var(--warn);border-color:var(--warn)}.chip.bad{color:var(--bad);border-color:var(--bad)}
.card,.finding,.edit{border:1px solid var(--line);border-radius:.6rem;background:var(--card);padding:1rem;margin:.8rem 0}.chapter{border-top:1px solid var(--line);padding:1rem 0}.notes{margin:1rem 0}blockquote,.prose{font-family:Georgia,"Times New Roman",serif;white-space:pre-wrap}blockquote{border-left:3px solid var(--accent);margin:1rem 0;padding-left:1rem}.label{font-weight:bold;color:var(--muted)}
.columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:1rem}.columns>div{min-width:0}del{background:var(--del-bg);color:var(--del-ink);text-decoration:line-through}ins{background:var(--ins-bg);color:var(--ins-ink);text-decoration:underline}
pre{white-space:pre-wrap}code{background:var(--page);padding:.1rem .25rem}.notice,.stamp,.coverage,.meta{color:var(--muted)}.toc{font-size:.9rem;border-block:1px solid var(--line);padding:.6rem 0}.toc ul{margin:.3rem 0;padding-left:1.4rem}.toc small{display:block;color:var(--muted)}.tools{margin:1rem 0}.tools button{font:inherit;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:.4rem;padding:.4rem .7rem;margin:.2rem}progress{width:100%;accent-color:var(--good)}dt{font-weight:bold}dd{margin-left:1rem;white-space:pre-line}li{margin:.25rem 0}
@media (prefers-color-scheme:dark){:root{--page:#161b1e;--ink:#edf0eb;--muted:#b8c2c3;--line:#475258;--card:#222a2d;--accent:#9bd4ed;--good:#8fd19e;--warn:#f2c46d;--bad:#f19a9a;--banner:#3a3016;--banner-ink:#ffe6a6;--del-bg:#5c2b2b;--del-ink:#ffe1e1;--ins-bg:#1e4d2d;--ins-ink:#dcffe6}}
@media (min-width:700px){.toc ul ul{columns:2;column-gap:2rem}.toc ul ul li{break-inside:avoid}}
@media (max-width:600px){.card,.finding,.edit,.tile{padding:.75rem}.columns{grid-template-columns:minmax(0,1fr)}blockquote{padding-left:.75rem}ul,ol{padding-left:1.3rem}}
@media print{:root{color-scheme:light;--page:#fff;--ink:#000;--muted:#333;--line:#999;--card:#fff;--accent:#000;--banner:#fff;--banner-ink:#000;--good:#2f6b3f;--warn:#8a5a00;--bad:#9b2c2c;--del-bg:#eec9c9;--del-ink:#2b1616;--ins-bg:#caecd4;--ins-ink:#15351c}.tools,.toc,progress{display:none!important}.wrap{max-width:none;padding:0}.card,.tile,.finding,.edit{break-inside:avoid}h1,h2,h3,h4,h5,h6{break-after:avoid}summary{list-style:none}summary::marker{content:""}summary::-webkit-details-marker{display:none}del,ins{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;

const notice = (part, error) => error ? `<p class="notice">${esc(part)} could not be read: ${esc(error)}</p>` : "";
const chip = (text, tone = "") => `<span class="chip${tone ? ` ${tone}` : ""}">${esc(text)}</span>`;
const plural = (count, singular) => `${count} ${Number(count) === 1 ? singular : `${singular}s`}`;
const listHtml = (items, empty = "None.") => items.length ? `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>` : `<p>${esc(empty)}</p>`;
const chapterId = (number) => `chapter-${String(Number(number)).padStart(2, "0")}`;
const chapterTitle = (chapter) => `Chapter ${chapter.number}${chapter.title ? `: ${chapter.title}` : ""}`;

function chapterRanges(chapters) {
  const ranges = [];
  for (const number of chapters) {
    if (ranges.length && ranges.at(-1)[1] + 1 === number) ranges.at(-1)[1] = number;
    else ranges.push([number, number]);
  }
  return ranges.map(([low, high]) => low === high ? low : `${low}–${high}`).join(", ");
}

function coverage(selection, manuscript_error) {
  if (selection.total === 0) return manuscript_error ? "No chapters could be read." : "This book has no chapters yet.";
  if (selection.total === 1 && selection.all) return `Covers chapter ${selection.chapters[0]}.`;
  if (selection.all) return `Covers all ${selection.total} chapters.`;
  return `Covers ${selection.chapters.length === 1 ? "chapter" : "chapters"} ${chapterRanges(selection.chapters)} of ${selection.total}.`;
}

const SEVERITY_WORDS = { block: "blocking", warn: "warning" };

// One card per world-bible file: worldBible() joins files under "### <name>.md" headings.
function worldBibleHtml(markdown) {
  const parts = markdown.split(/^### (.+\.md)[ \t]*\r?\n/mu), cards = [];
  if (parts[0].trim()) cards.push(`<div class="card">${markdownToHtml(parts[0])}</div>`);
  for (let index = 1; index < parts.length; index += 2) cards.push(`<div class="card"><p class="file">${esc(parts[index])}</p>${markdownToHtml(parts[index + 1] || "")}</div>`);
  return cards.join("");
}

function findingHtml(item) {
  return `<article class="finding"><p class="meta">${chip(item.label)} ${esc(SEVERITY_WORDS[item.severity] || item.severity)} · Scene ${esc(item.scene_id)} · ¶${esc(item.paragraph)}${Number.isInteger(item.count) && Number.isInteger(item.limit) ? ` · ${esc(item.count)} found, limit ${esc(item.limit)}` : ""} · <code>${esc(item.id)}</code></p>
${item.quote ? `<blockquote>${esc(item.quote)}</blockquote>` : ""}<p>${esc(item.issue)}</p>${item.reasons?.length ? listHtml(item.reasons.map(esc)) : ""}${item.sounds_like ? `<p>Maybe sounds like ${esc(item.sounds_like)}.</p>` : ""}<p><strong>Suggested repair:</strong> ${esc(item.repair)}</p>${item.ruling ? `<p class="notice">${esc(item.ruling)}</p>` : ""}</article>`;
}

function findingsHtml(chapter) {
  const f = chapter.findings;
  return `<section class="findings"><h3>Findings</h3>${f?.error ? notice("Findings", f.error) : `${chapter.stale_reviews.length ? `<p class="notice">Review out of date: ${chapter.stale_reviews.map(esc).join(", ")}. Run a fresh review for this chapter.</p>` : ""}${[["Style rules", "rule"], ["Voice", "voice"], ["Judgment (triaged)", "judgment"]].map(([title, key]) => `<h4>${title}</h4>${f?.[key]?.map(findingHtml).join("") || "<p>None.</p>"}`).join("")}<details class="notes"><summary>Notes (${f?.notes.length || 0})</summary>${f?.notes.map(findingHtml).join("") || "<p>None.</p>"}</details>`}</section>`;
}

function proposalStatus(proposal) {
  if (!proposal) return "No repair proposal for this chapter yet.";
  switch (proposal.status) {
    case "ready": return "Ready for the author to accept or reject.";
    case "stale": return "Out of date: the chapter or its findings changed after this proposal was made. Ask again for a fresh proposal.";
    case "accepted": return `Accepted (edits ${proposal.accepted_edits.join(", ")})${proposal.accepted_at ? ` on ${proposal.accepted_at}` : ""}.`;
    case "declined": return "The AI declined every finding.";
    case "failed": return `This proposal failed: ${proposal.error || "No explanation was recorded. Ask again for a fresh proposal."}`;
    case "no-usable-edits": return "No usable edits. Read the drop reasons below, then ask again.";
    case "nothing-to-repair": return "Nothing to repair in this chapter. The AI repairs blocking rules, voice, triaged judgment and findings the author asked to fix; other findings stay for the author.";
    default: return "No repair proposal for this chapter yet.";
  }
}

function proposalHtml(proposal) {
  if (proposal?.error && !proposal.status) return `<section class="proposal"><h3>Proposed repairs</h3>${notice("Proposals", proposal.error)}</section>`;
  return `<section class="proposal"><h3>Proposed repairs</h3><p>${esc(proposalStatus(proposal))}</p>${proposal ? `${proposal.edits.map((edit) => {
    const diff = wordDiff(edit.before, edit.after);
    const delta = edit.word_delta > 0 ? `+${edit.word_delta}` : edit.word_delta < 0 ? `−${Math.abs(edit.word_delta)}` : "0";
    return `<article class="edit"><h4>Edit ${esc(edit.number)} · Scene ${esc(edit.scene_id)}, paragraph ${esc(edit.paragraph)}</h4><div class="columns"><div><p class="label">Before</p><p class="prose">${diff.before}</p></div><div><p class="label">After</p><p class="prose">${diff.after}</p></div></div>${diff.compared ? "" : '<p class="notice">Too long to compare word by word.</p>'}<p>Why: ${esc(edit.reason)}</p><p>Word change: ${esc(delta)} · Check: ${esc(edit.validation)}</p><p>Findings: ${edit.findings.map((finding) => `${esc(finding.id)} (${esc(finding.label)}): ${esc(finding.issue)}`).join("; ")}</p>${[["Confirmed fixed", edit.fixed], ["Judgment repairs proposed", edit.proposed], ["Partly fixed", edit.partly_fixed]].filter(([, items]) => items.length).map(([label, items]) => `<p>${label}: ${items.map(esc).join(", ")}</p>`).join("")}</article>`;
  }).join("")}<h4>Declined findings</h4>${listHtml(proposal.declined.map((item) => `${esc(item.finding_id)} (${esc(item.label)}, scene ${esc(item.scene_id)} ¶${esc(item.paragraph)}): the AI made no edit. Why: ${esc(item.reason)}${item.quote ? `<blockquote>${esc(item.quote)}</blockquote>` : ""}`))}<h4>Dropped edits</h4>${listHtml(proposal.dropped.map((item) => `Edit ${esc(item.number)} · Scene ${esc(item.scene_id)}, paragraph ${esc(item.paragraph)}: ${esc(item.why)}`))}` : ""}</section>`;
}

export function renderReport(data) {
  const has = (name) => data.sections.includes(name);
  const date = data.generated_at;
  const stamp = `Generated with ${data.generator} on ${date.slice(0, 10)} at ${date.slice(11, 16)} UTC.`;
  const chaptersPresent = has("findings") || has("proposals");
  const toc = [];
  if (has("summary")) toc.push('<a href="#summary">Summary</a>');
  if (chaptersPresent) toc.push(`<a href="#chapters">Chapters</a>${listHtml(data.chapters.map((chapter) => `<a href="#${chapterId(chapter.number)}">${esc(chapterTitle(chapter))}</a><small>${esc(plural(chapter.open_findings, "open finding"))} · ${esc(plural(chapter.proposal?.edits?.length || 0, "proposed edit"))}</small>`), data.manuscript_error ? "Chapters could not be read." : "No chapters yet.")}`);
  for (const [key, id, title] of [["canon", "world-bible", "World bible"], ["state", "story-so-far", "Story so far"], ["rules", "rules", "Rules in effect"]]) if (has(key)) toc.push(`<a href="#${id}">${title}</a>`);
  toc.push('<a href="#setup-check">Setup check</a>');
  const body = [];
  if (has("summary")) {
    const f = data.counts.findings, c = data.counts;
    const approved = data.chapters.filter((chapter) => chapter.approved).length;
    const tiles = [[approved, "chapters approved", `${plural(data.selection.chapters.length, "chapter")} covered`], [f.total, "open findings", `${plural(f.rule_blocking + f.rule_warnings, "style rule")} (${f.rule_blocking} blocking) · ${f.voice} voice · ${f.judgment} judgment`], [c.proposals.ready, "proposals waiting", `${plural(c.edits_waiting, "edit")} waiting`], [c.declines, "declined by the AI", "findings with no edit"], [c.dropped, "dropped edits", "see reasons under each chapter"], [c.changes_waiting, "chapters with changes waiting", "awaiting author approval"]];
    const progress = data.selection.total === 0
      ? (data.manuscript_error ? "<p>Progress can't be shown because the manuscript could not be read.</p>" : "<p>No chapters to approve yet.</p>")
      : `<p>${esc(data.progress.approved.length)} of ${esc(plural(data.progress.total, "chapter"))} approved since import</p><progress max="${Math.max(1, Number(data.progress.total))}" value="${Number(data.progress.approved.length)}" aria-label="Chapters approved since import"></progress>`;
    body.push(`<section id="summary"><h2>Summary</h2>${progress}<div class="tiles">${tiles.map(([number, label, detail]) => `<div class="tile"><strong>${esc(number)}</strong>${label}<small>${esc(detail)}</small></div>`).join("")}</div><p>${f.notes ? `${esc(plural(f.notes, "lower-priority note"))} ${f.notes === 1 ? "is" : "are"} listed under each chapter.` : "No lower-priority notes."}</p>${notice("Findings", data.errors?.findings)}${notice("Proposals", data.errors?.proposals)}</section>`);
  }
  if (chaptersPresent) body.push(`<section id="chapters"><h2>Chapters</h2>${data.chapters.length ? data.chapters.map((chapter) => {
    try { return `<details class="chapter" id="${chapterId(chapter.number)}" open><summary><h2>${esc(chapterTitle(chapter))}</h2> ${chapter.approved ? chip("approved", "good") : ""} ${chapter.changes_waiting ? chip("changes waiting", "warn") : ""} ${chapter.open_findings ? chip(plural(chapter.open_findings, "open finding"), "warn") : ""} ${chapter.stale_reviews.length ? chip("review out of date", "warn") : ""} ${chapter.proposal?.status ? chip(`proposal ${chapter.proposal.status.replaceAll("-", " ")}`) : ""}</summary>${has("findings") ? findingsHtml(chapter) : ""}${has("proposals") ? proposalHtml(chapter.proposal) : ""}</details>`; }
    catch (error) { return `<details class="chapter" id="${chapterId(chapter.number)}" open><summary><h2>${esc(chapterTitle(chapter))}</h2></summary><p class="notice">This chapter could not be shown: ${esc(error.message)}</p></details>`; }
  }).join("") : data.manuscript_error ? "<p>Chapters can't be shown because the manuscript could not be read. Fix the scene file named at the top of this report, then make the report again.</p>" : "<p>This book has no chapters yet. Import a manuscript to see findings and proposals.</p>"}</section>`);
  if (has("canon")) {
    const bible = data.world_bible, canon = bible.canon;
    body.push(`<section id="world-bible"><h2>World bible</h2>${bible.error ? notice("World bible", bible.error) : bible.markdown ? worldBibleHtml(bible.markdown) : "<p>No world bible notes yet.</p>"}${canon ? `<h3>Canon entries</h3>${canon.error ? `<p class="notice">${esc(canon.error)}</p>` : canon.entries ? canon.entries.map((entry) => `<article class="card"><h4>${esc(entry.title)} ${entry.kind ? chip(entry.kind) : ""}</h4><dl>${entry.fields.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join("")}</dl></article>`).join("") : `<pre>${esc(canon.json)}</pre>`}` : ""}<h3>Character registry</h3>${bible.characters.error ? notice("Characters", bible.characters.error) : listHtml(bible.characters.map((item) => `${esc(item.name)}${item.aliases.length ? ` (also: ${item.aliases.map(esc).join(", ")})` : ""}`), "No characters registered yet.")}</section>`);
  }
  if (has("state")) {
    const state = data.state;
    const stateProgress = data.selection.total === 0
      ? (data.manuscript_error ? "Story-so-far state can't be shown because the manuscript could not be read." : "No scenes to track yet.")
      : `Story-so-far state: ${state.stale ? `${esc(state.current)} current, ${esc(state.stale)} waiting for acceptance or refresh.` : `${esc(state.current)} of ${esc(state.total)} scenes current.`}`;
    body.push(`<section id="story-so-far"><h2>Story so far</h2>${state.error ? notice("Story so far", state.error) : `<p>${stateProgress}</p><h3>Places</h3>${listHtml(state.places.map((group) => `<strong>${esc(group.value)}</strong>${listHtml(group.entries.map((entry) => `${entry.who ? `${esc(entry.who)} in` : "In"} scene ${esc(entry.scene_id)}: “${esc(entry.quote)}”`))}`), "No places recorded yet.")}<h3>Threads</h3>${listHtml(state.threads.map((group) => `${markdownToHtml(group.value)}<p>${group.entries.map((entry) => `${esc(entry.status)} in scene ${esc(entry.scene_id)}`).join(", ")}</p>`), "No threads recorded yet.")}`}</section>`);
  }
  if (has("rules")) body.push(`<section id="rules"><h2>Rules in effect</h2>${data.rules.error ? notice("Rules", data.rules.error) : data.rules.map((rule) => `<article class="card"><h3>${esc(rule.id)} ${chip(rule.severity === "block" ? "blocking" : "warning", rule.severity === "block" ? "bad" : "warn")} ${chip(rule.type)}</h3><p>${esc(rule.message)}</p><p class="meta">${esc(rule.scope)}</p></article>`).join("") || "<p>No style rules configured.</p>"}${data.reviewers.error ? notice("Reviewers", data.reviewers.error) : `<p>Reviewers: ${data.reviewers.map((reviewer) => `${esc(reviewer.title)} (${reviewer.builtin ? "built in" : "this book"})`).join("; ")}.</p>`}</section>`);
  const doctor = data.doctor, first = doctor.blocking?.[0];
  const footer = `<footer id="setup-check"><h2>Setup check</h2>${doctor.error ? notice("Setup check", doctor.error) : `<p>Supported setup: ${doctor.ok ? "yes" : "no"}${first ? ` · ${esc(first.problem)}. ${esc(first.why)} ${esc(first.fix)}` : ""}</p><p>Guardrails: ${doctor.guardrails_on ? "on" : "off"}${doctor.guard_problem ? ` · ${esc(doctor.guard_problem)}` : ""}</p>${doctor.guardrail_labels.map((label) => `<p>${esc(label)}</p>`).join("")}<p>Weaver install unchanged: ${doctor.integrity_ok ? "yes" : "no"}</p>`}<p class="stamp">${esc(stamp)}</p></footer>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${esc(GENERATOR)}">
${REPORT_MARKER}
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${reportCsp()}">
<title>${esc(data.project.title)} · Weaver report</title>
<style>${REPORT_CSS}</style>
</head><body>
<p class="privacy" role="note"><strong>${PRIVACY_LINE}</strong></p>
<div class="wrap"><header id="top"><h1>${esc(data.project.title)}</h1>${data.project.author ? `<p>by ${esc(data.project.author)}</p>` : ""}<p class="stamp">${esc(stamp)}</p><p class="coverage">${esc(coverage(data.selection, data.manuscript_error))}</p>${data.manuscript_error ? `<p class="notice">The manuscript could not be read: ${esc(data.manuscript_error)}</p>` : ""}${notice("Changes waiting", data.errors?.pending)}${!has("canon") ? notice("Characters", data.errors?.characters) : ""}</header>
<div id="report-tools" class="tools" hidden><button type="button" data-do="expand">Expand all</button><button type="button" data-do="collapse">Collapse all</button><button type="button" data-do="print">Print or save as PDF</button></div>
<nav class="toc" aria-label="Contents">${listHtml(toc)}</nav><main>${body.join("\n")}</main>${footer}</div>
<script>${REPORT_SCRIPT}</script>
</body></html>`;
}

export function buildReport(root, options = {}) {
  const data = collectReportData(root, options);
  return { html: renderReport(data), data };
}

function pathStat(path) {
  try { return lstatSync(path); } catch { return null; }
}

function existingAncestor(path) {
  let ancestor = path;
  while (!pathStat(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  return ancestor;
}

function isBookFolder(folder) {
  const project = join(folder, "project.json");
  if (!existsSync(project)) return false;
  try { return JSON.parse(readFileSync(project, "utf8").replace(/^\uFEFF/u, ""))?.kind === "book"; }
  catch { return true; }
}

function enclosingBook(path) {
  for (let folder = dirname(path); ; folder = dirname(folder)) {
    if (isBookFolder(folder)) return folder;
    if (dirname(folder) === folder) return null;
  }
}

function reportFileAccess(operation) {
  try { return operation(); }
  catch { throw new Error("The report file could not be opened or saved. Check the folder and its permissions, or choose another file name."); }
}

export function writeReport(root, outPath, options = {}) {
  if (!outPath) throw new Error(USAGE);
  if (process.platform === "win32" && (/^[\\/]{2}[?.][\\/]/u.test(outPath) || resolve(outPath).replace(/^[a-z]:/iu, "").includes(":"))) throw new Error("Use an ordinary file path for the report, for example --out ../report.html.");
  const destination = resolve(outPath);
  if (!/^\.html?$/iu.test(extname(destination))) throw new Error("Save the report as an .html file, for example --out report.html.");
  root = resolve(root);
  readProject(root);
  const shortcut = "That report path is a shortcut (a link to somewhere else). Give an ordinary file name, for example --out ../report.html.";
  if (pathStat(destination)?.isSymbolicLink()) throw new Error(shortcut);
  const ancestor = existingAncestor(destination);
  if (pathStat(ancestor)?.isSymbolicLink() && !existsSync(ancestor)) throw new Error(shortcut);
  let physical;
  try { physical = resolve(realpathSync.native(ancestor), relative(ancestor, destination)); }
  catch { throw new Error("Weaver couldn't check where that path leads, so it won't save the report there. Choose another folder."); }
  const book = enclosingBook(destination) || enclosingBook(physical);
  if (book) throw new Error(`Weaver saves reports outside book folders, so the AI working in a book can't change them and they stay out of the book's history. Save this one outside "${basename(book)}", for example --out "${join(dirname(book), basename(destination))}".`);
  if (existsSync(destination)) {
    if (reportFileAccess(() => statSync(destination).isDirectory())) throw new Error("That path is a folder. Give a file name, for example --out report.html.");
    const prefix = reportFileAccess(() => {
      const file = openSync(destination, "r"), bytes = Buffer.alloc(4096);
      try { return bytes.subarray(0, readSync(file, bytes, 0, bytes.length, 0)).toString("utf8"); }
      finally { closeSync(file); }
    });
    if (!prefix.includes(REPORT_MARKER)) throw new Error(`Refusing to replace ${basename(destination)}: it is not a Weaver report. Choose a new file name.`);
  }
  const { html, data } = buildReport(root, options);
  reportFileAccess(() => { mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, html, "utf8"); });
  return { out: destination, bytes: Buffer.byteLength(html, "utf8"), chapters: data.selection.chapters, sections: data.sections, warnings: data.warnings, doctor: data.doctor };
}
