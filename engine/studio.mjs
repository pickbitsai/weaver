// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { approveChapter, approvalHistory, describePendingChanges, pendingChanges, rejectChapter, undoApproval } from "./changes.mjs";
import { loadCharacters, characterKebabCase } from "./characters.mjs";
import { runDoctor } from "./doctor.mjs";
import { collectFindings } from "./findings.mjs";
import { GENERATOR } from "./identity.mjs";
import { loadScenes } from "./manuscript.mjs";
import { readProject } from "./project.mjs";
import { parseEscapedProse, readerText } from "./prose.mjs";
import { readRulings, saveRuling } from "./rulings.mjs";
import { acceptNarrativeState, narrativeStateStatus, readFactsLedger, statePath } from "./state.mjs";
import { attributeDialogue } from "./voice.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PACKAGE_ROOT, "scripts", "weaver.mjs");
const ASSETS = new Map([
  ["/studio.css", ["text/css; charset=utf-8", readFileSync(join(PACKAGE_ROOT, "studio", "studio.css"))]],
  ["/studio.js", ["text/javascript; charset=utf-8", readFileSync(join(PACKAGE_ROOT, "studio", "studio.js"))]]
]);
const NAV = [["/", "Home"], ["/book", "Book"], ["/characters", "Characters"], ["/places", "Places"], ["/threads", "Threads"], ["/findings", "Findings"], ["/changes", "Changes"], ["/history", "History"], ["/jobs", "Jobs"]];
const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const chapterSlug = (number) => `chapter-${String(number).padStart(2, "0")}`;
const sceneSlug = (number) => `scene-${String(number).padStart(2, "0")}`;
const chapterHref = (number) => `/book/${chapterSlug(number)}`;
const sceneHref = (scene) => `${chapterHref(scene.chapter)}/${sceneSlug(scene.scene)}`;
const paragraphs = (prose) => prose.split(/\n\s*\n/u).filter((part) => part.trim());
const list = (items) => items.length ? `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>` : "<p>None yet.</p>";
const localMessage = (message, root) => String(message || "Something went wrong.").replaceAll(root, "the book folder").replace(/[A-Za-z]:\\[^\s:]+/gu, "a local file");

function gitSubjects(root) {
  const result = spawnSync("git", ["-C", root, "log", "--reverse", "--format=%s"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.split(/\r?\n/u).filter(Boolean) : [];
}

export function approvalProgress(root, scenes) {
  const subjects = gitSubjects(root);
  let baseline = -1;
  subjects.forEach((subject, index) => { if (/^(?:Import original manuscript|Initialize book)/u.test(subject)) baseline = index; });
  const approved = new Set();
  for (const subject of subjects.slice(baseline + 1)) {
    const match = /^Approve chapter (\d+)(?::|$)/u.exec(subject);
    if (match) approved.add(Number(match[1]));
  }
  return { approved, total: new Set(scenes.map((scene) => scene.chapter)).size };
}

function proseHtml(value, characters) {
  const aliases = characters.flatMap((character) => [character.name, ...character.aliases].map((name) => ({ name, id: character.id })))
    .sort((a, b) => b.name.length - a.name.length);
  const output = [];
  for (const token of parseEscapedProse(value)) {
    const text = token.text;
    const pieces = [];
    let cursor = 0;
    const matches = [];
    for (const alias of aliases) {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${alias.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\p{L}\\p{N}])`, "giu");
      for (const match of text.matchAll(pattern)) matches.push({ index: match.index, length: match[0].length, id: alias.id });
    }
    matches.sort((a, b) => a.index - b.index || b.length - a.length);
    for (const match of matches) {
      if (match.index < cursor) continue;
      pieces.push(esc(text.slice(cursor, match.index)));
      pieces.push(`<a href="/characters/${esc(match.id)}">${esc(text.slice(match.index, match.index + match.length))}</a>`);
      cursor = match.index + match.length;
    }
    pieces.push(esc(text.slice(cursor)));
    const html = pieces.join("").replaceAll("\n", "<br>");
    output.push(token.italic ? `<em>${html}</em>` : html);
  }
  return output.join("");
}

function sceneReader(scene, characters, findings) {
  return `<section aria-label="Scene ${esc(scene.id)}">${paragraphs(scene.prose).map((part, index) => {
    const relevant = findings.filter((item) => item.scene_id === scene.id && item.paragraph === index + 1);
    return `<p id="p${index + 1}" class="reader-paragraph"><span class="paragraph-number">¶${index + 1}</span> ${proseHtml(part, characters)}${relevant.length ? ` <a class="finding-marker" href="/findings#finding-${esc(relevant[0].id)}" aria-label="${relevant.length} open finding${relevant.length === 1 ? "" : "s"} on paragraph ${index + 1}">● ${relevant.length}</a>` : ""}</p>`;
  }).join("")}</section>`;
}

function statusChips(chapter, pending, findings, approved) {
  const chips = [];
  if (approved.has(chapter)) chips.push("approved");
  if (pending.chapters.some((item) => item.chapter === chapter)) chips.push("changes waiting");
  const queue = findings.chapters.find((item) => item.chapter === chapter);
  if (queue?.findings.length) chips.push("open findings");
  if (queue?.stale_reviews.length) chips.push("review out of date");
  return chips.map((chip) => `<span class="chip">${chip}</span>`).join(" ");
}

function placeGroups(ledger) {
  const places = new Map();
  for (const [subject, facts] of Object.entries(ledger.subjects || {})) for (const fact of facts) {
    if (fact.kind !== "location") continue;
    const slug = characterKebabCase(String(fact.value).toLocaleLowerCase().replace(/\s+/gu, " ").trim());
    if (!places.has(slug)) places.set(slug, { value: fact.value, entries: [] });
    places.get(slug).entries.push({ ...fact, subject });
  }
  return places;
}

function threadGroups(root, project, scenes) {
  const threads = new Map();
  for (const scene of scenes) {
    const path = statePath(root, project, scene.id);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const section = text.match(/^## Active threads\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/mu)?.[1] || "";
    for (const line of section.split(/\r?\n/u)) {
      const bullet = /^\s*[-*]\s+(.+)$/u.exec(line);
      if (!bullet || /^\s*(?:none|no active threads|—|-)\s*\.?$/iu.test(bullet[1])) continue;
      const statusMatch = /^(added|advanced|resolved)\s*:\s*(.+)$/iu.exec(bullet[1]);
      const status = statusMatch ? statusMatch[1].toLocaleLowerCase() : "advanced";
      const value = (statusMatch ? statusMatch[2] : bullet[1]).trim();
      const slug = characterKebabCase(value.toLocaleLowerCase().replace(/\s+/gu, " "));
      if (!threads.has(slug)) threads.set(slug, { value, entries: [] });
      threads.get(slug).entries.push({ scene, status });
    }
  }
  return threads;
}

function findingCard(item, { note = false } = {}) {
  const quote = item.quote || item.excerpt || item.line || "";
  return `<article class="card" id="finding-${esc(item.id)}"><h4>${note ? "Note " : ""}${esc(item.id)} <span class="chip">${esc(item.source)}</span></h4><p><a href="/book/${chapterSlug(Number(item.scene_id.split("-")[0]))}/${sceneSlug(Number(item.scene_id.split("-")[1]))}#p${esc(item.paragraph)}">Scene ${esc(item.scene_id)}, ¶${esc(item.paragraph)}</a></p><blockquote>${esc(quote)}</blockquote><p>${esc(item.issue)}</p><p><strong>Suggested repair:</strong> ${esc(item.repair)}</p>${item.ruling ? `<p class="notice">${esc(item.ruling)}</p>` : ""}${note ? "" : `<div class="actions"><button data-action="ruling" data-id="${esc(item.id)}" data-decision="fix">Fix this</button><button data-action="ruling" data-id="${esc(item.id)}" data-decision="intended">It's intended</button><button data-action="ruling" data-id="${esc(item.id)}" data-decision="allow">Allow</button></div>`}</article>`;
}

function diffWords(before, after) {
  const a = readerText(before).split(/(\s+)/u), b = readerText(after).split(/(\s+)/u);
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const prefix = esc(a.slice(0, start).join("")), suffix = esc(end ? a.slice(-end).join("") : "");
  return { before: `${prefix}<del>${esc(a.slice(start, a.length - end).join(""))}</del>${suffix}`, after: `${prefix}<ins>${esc(b.slice(start, b.length - end).join(""))}</ins>${suffix}` };
}

function changedParagraphs(scene, styleFindings) {
  const before = paragraphs(scene.beforeProse), after = paragraphs(scene.afterProse);
  const rows = [];
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    if (before[index] === after[index]) continue;
    const diff = diffWords(before[index] || "", after[index] || "");
    const style = styleFindings.filter((item) => item.paragraph === index + 1);
    rows.push(`<div class="change-row"><h3>Scene ${esc(scene.id)}, ¶${index + 1}</h3><div class="columns"><div><strong>Approved text</strong><p>${diff.before}</p></div><div><strong>New text</strong><p>${diff.after}</p></div></div>${style.length ? list(style.map((item) => `${esc(item.source || item.rule_id)}: ${esc(item.issue || item.message)}`)) : ""}</div>`);
  }
  return rows.join("");
}

function pageBody(path, root, project, job) {
  const scenes = loadScenes(root, project), characters = loadCharacters(root).characters;
  const findings = collectFindings(root, project, { all: true });
  const pending = describePendingChanges(root, project);
  const progress = approvalProgress(root, scenes);
  const chapterNumbers = [...new Set(scenes.map((scene) => scene.chapter))];
  if (path === "/") {
    const toFix = findings.findings.filter((item) => item.ruling === "author wants this fixed").length;
    return `<h1>${esc(project.title)}</h1><p class="byline">${esc(project.author || "Author not listed")}</p><h2>Progress</h2><p>${progress.approved.size} of ${progress.total} chapters approved since import</p><p>Open findings: ${findings.findings.length - toFix} to decide, ${toFix} to fix</p><p><a href="/book">Read the book</a> · <a href="/changes">Review changes</a></p>`;
  }
  if (path === "/book") return `<h1>Book</h1>${chapterNumbers.map((number) => `<section><h2><a href="${chapterHref(number)}">Chapter ${number}${project.chapters?.[number] ? `: ${esc(project.chapters[number])}` : ""}</a></h2><p>${statusChips(number, pending, findings, progress.approved)}</p>${list(scenes.filter((scene) => scene.chapter === number).map((scene) => `<a href="${sceneHref(scene)}">Scene ${scene.scene}</a>`))}</section>`).join("")}`;
  const sceneRoute = /^\/book\/chapter-(\d+)\/scene-(\d+)$/u.exec(path);
  if (sceneRoute) {
    const scene = scenes.find((item) => item.chapter === Number(sceneRoute[1]) && item.scene === Number(sceneRoute[2]));
    if (!scene) return null;
    return `<p><a href="${chapterHref(scene.chapter)}">Chapter ${scene.chapter}</a></p><h1>Scene ${scene.scene}</h1>${sceneReader(scene, characters, findings.findings)}`;
  }
  const chapterRoute = /^\/book\/chapter-(\d+)$/u.exec(path);
  if (chapterRoute) {
    const number = Number(chapterRoute[1]), selected = scenes.filter((scene) => scene.chapter === number);
    if (!selected.length) return null;
    return `<h1>Chapter ${number}${project.chapters?.[number] ? `: ${esc(project.chapters[number])}` : ""}</h1><p>${statusChips(number, pending, findings, progress.approved)}</p>${selected.map((scene) => `<section><h2><a href="${sceneHref(scene)}">Scene ${scene.scene}</a></h2>${sceneReader(scene, characters, findings.findings)}</section>`).join("")}`;
  }
  if (path === "/characters") return `<h1>Characters</h1>${list(characters.map((item) => `<a href="/characters/${esc(item.id)}">${esc(item.name)}</a>`))}`;
  const characterRoute = /^\/characters\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(path);
  if (characterRoute) {
    const character = characters.find((item) => item.id === characterRoute[1]);
    if (!character) return null;
    const profilePath = join(root, "world-bible", "voices", `${character.id}.json`);
    const profile = existsSync(profilePath) ? JSON.parse(readFileSync(profilePath, "utf8")) : null;
    const facts = readFactsLedger(root).subjects?.[character.id] || [];
    const speaking = scenes.filter((scene) => attributeDialogue(scene, characters).some((line) => line.speaker === character.id));
    return `<h1>${esc(character.name)}</h1><p>Aliases: ${character.aliases.length ? character.aliases.map(esc).join(", ") : "none"}</p><h2>Voice profile</h2><p>${profile?.enough_evidence ? "Enough evidence" : "Not enough evidence yet"}${profile ? ` (${profile.lines} lines, ${profile.words} words)` : ""}</p>${list((profile?.evidence || []).map((line) => `“${esc(line.text)}” <a href="/book/${chapterSlug(Number(line.scene_id.split("-")[0]))}/${sceneSlug(Number(line.scene_id.split("-")[1]))}#p${line.paragraph}">Scene ${esc(line.scene_id)}, ¶${line.paragraph}</a>`))}<h2>Facts timeline</h2>${list(facts.map((fact) => `<a href="/book/${chapterSlug(Number(fact.scene_id.split("-")[0]))}/${sceneSlug(Number(fact.scene_id.split("-")[1]))}">Scene ${esc(fact.scene_id)}</a> → ${esc(fact.kind)} → ${esc(fact.value)} → “${esc(fact.quote)}”`))}<h2>Scenes they speak in</h2>${list(speaking.map((scene) => `<a href="${sceneHref(scene)}">Scene ${scene.id}</a>`))}`;
  }
  const places = placeGroups(readFactsLedger(root));
  if (path === "/places") return `<h1>Places</h1>${list([...places].map(([slug, place]) => `<a href="/places/${esc(slug)}">${esc(place.value)}</a>`))}`;
  const placeRoute = /^\/places\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(path);
  if (placeRoute) {
    const place = places.get(placeRoute[1]);
    if (!place) return null;
    return `<h1>${esc(place.value)}</h1><h2>Who is there</h2>${list(place.entries.map((entry) => {
      const character = characters.find((item) => item.id === entry.subject);
      return `${character ? `<a href="/characters/${esc(character.id)}">${esc(character.name)}</a>` : esc(entry.subject)} in <a href="/book/${chapterSlug(Number(entry.scene_id.split("-")[0]))}/${sceneSlug(Number(entry.scene_id.split("-")[1]))}">scene ${esc(entry.scene_id)}</a> · “${esc(entry.quote)}”`;
    }))}`;
  }
  if (path === "/threads") return `<h1>Threads</h1>${[...threadGroups(root, project, scenes)].map(([slug, thread]) => `<section id="${esc(slug)}"><h2>${esc(thread.value)}</h2>${list(thread.entries.map(({ scene, status }) => `${esc(status)} in <a href="${sceneHref(scene)}">scene ${esc(scene.id)}</a>`))}</section>`).join("") || "<p>No active threads recorded yet.</p>"}`;
  if (path === "/findings") return `<h1>Findings</h1>${findings.chapters.map((chapter) => `<section><h2>Chapter ${chapter.chapter}</h2>${chapter.stale_reviews.length ? `<p class="notice">${chapter.stale_reviews.map(esc).join(", ")} review out of date</p>` : ""}${[["Mechanical: style rules", chapter.findings.filter((item) => item.kind === "rule")], ["Voice", chapter.findings.filter((item) => item.kind === "voice")], ["Judgment: triaged", chapter.findings.filter((item) => item.kind === "judgment")]].map(([heading, items]) => `<h3>${heading}</h3>${items.length ? items.map((item) => findingCard(item)).join("") : "<p>None.</p>"}`).join("")}<details><summary>Show notes (${chapter.note_count})</summary>${chapter.notes.map((item) => findingCard(item, { note: true })).join("") || "<p>No notes.</p>"}</details></section>`).join("")}`;
  if (path === "/changes") {
    const raw = pendingChanges(root, project);
    return `<h1>Changes waiting</h1>${pending.chapters.length ? pending.chapters.map((chapter) => `<section><h2>Chapter ${chapter.chapter}</h2><p>${chapter.scenes_changed} scenes changed · ${chapter.blocking} blocking style findings · ${chapter.warnings} warnings</p>${raw.chapters.find((item) => item.chapter === chapter.chapter).scenes.map((scene) => changedParagraphs(scene, chapter.scenes.find((item) => item.id === scene.id)?.findings || [])).join("")}<label for="note-${chapter.chapter}">Approval note (optional)</label><input id="note-${chapter.chapter}" maxlength="200"><div class="actions"><button data-action="approve" data-chapter="${chapter.chapter}" data-note="note-${chapter.chapter}">Approve chapter ${chapter.chapter}</button><button data-action="reject" data-chapter="${chapter.chapter}">Reject chapter ${chapter.chapter}</button></div></section>`).join("") : "<p>No changes are waiting.</p>"}`;
  }
  if (path === "/history") {
    const approvals = approvalHistory(root);
    const rulings = readRulings(root).entries.map((item) => ({ type: "ruling", date: item.ruled_at, note: `${item.decision} ${item.finding_id}${item.note ? `: ${item.note}` : ""}` }));
    const events = [...approvals, ...rulings].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return `<h1>History</h1><div class="card"><button id="undo-start" data-action="confirm-undo">Undo last approval</button><div id="undo-confirm" hidden><p>Undo the last approval with a new history entry?</p><button data-action="undo">Yes, undo last approval</button><button data-action="cancel-undo">Cancel</button></div></div>${list(events.map((event) => `<time>${esc(event.date)}</time> · ${esc(event.type)}${event.chapter ? ` · Chapter ${event.chapter}` : ""}${event.note ? ` · ${esc(event.note)}` : ""}`))}`;
  }
  if (path === "/jobs") {
    const state = narrativeStateStatus(root, project);
    return `<h1>Jobs</h1><p>Run a chapter review or build story-so-far state through the configured AI host.</p><label for="review-chapter">Chapter</label><select id="review-chapter">${chapterNumbers.map((number) => `<option value="${number}">${number}</option>`).join("")}</select><div class="actions"><button data-action="review-job">Run review</button><button data-action="bootstrap-job">Bootstrap state</button></div><section id="job-status" data-poll="${job?.state === "running" ? "1" : "0"}"><h2>Current job</h2>${job ? `<p>${esc(job.kind)} · ${esc(job.state)} · started ${esc(job.started_at)}</p><pre>${esc(job.log_tail.join("\n"))}</pre>` : "<p>No job has started.</p>"}</section><section><h2>Story state to review</h2><p>${state.current} current, ${state.stale} waiting for acceptance or refresh.</p>${scenes.map((scene) => { const record = state.records.find((item) => item.scene === scene.id); const file = statePath(root, project, scene.id); return `<details><summary>Scene ${esc(scene.id)} · ${record?.current ? "current" : esc(record?.reason || "missing")}</summary>${existsSync(file) ? `<pre>${esc(readFileSync(file, "utf8"))}</pre>` : "<p>No story-state record yet.</p>"}</details>`; }).join("")}<p>After reading the records, accept the story state explicitly. An edited scene makes it and all later scenes stale again.</p><button data-action="accept-state">Accept story state</button></section>`;
  }
  return null;
}

function layout(body, root, project) {
  const doctor = runDoctor({ bookRoot: root });
  const first = doctor.blocking[0];
  const integrity = doctor.checks.find((item) => item.id === "install-integrity")?.status === "pass";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(project.title)} · Weaver Studio</title><link rel="stylesheet" href="/studio.css"><script src="/studio.js" defer></script></head><body><a class="skip" href="#main">Skip to content</a><header><strong>Weaver Studio</strong><nav aria-label="Main navigation">${NAV.map(([href, label]) => `<a href="${href}">${label}</a>`).join("")}</nav></header><main id="main">${body}</main><p id="action-message" role="status" aria-live="polite"></p><footer><h2>Doctor</h2><p>Supported setup: ${doctor.ok ? "yes" : "no"}${first ? ` · ${esc(first.problem)}. ${esc(first.why)} ${esc(first.fix)}` : ""}</p><p>Weaver install unchanged: ${integrity ? "yes" : "no"}</p></footer></body></html>`;
}

function send(response, status, type, body) {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'", "referrer-policy": "no-referrer" });
  response.end(body);
}

function json(response, status, value) { send(response, status, "application/json; charset=utf-8", JSON.stringify(value)); }

function validPost(request, port) {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (request.headers["x-weaver-studio"] !== "1" || !allowed.has(request.headers.host)) return false;
  if (!request.headers.origin) return true;
  try { const origin = new URL(request.headers.origin); return origin.protocol === "http:" && allowed.has(origin.host) && origin.pathname === "/"; }
  catch { return false; }
}

async function requestJson(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 8192) throw new Error("Request is too large.");
  }
  try { return JSON.parse(text || "{}"); } catch { throw new Error("The request must contain valid JSON."); }
}

export async function startStudio({ root = process.cwd(), port = null } = {}) {
  root = resolve(root);
  const project = readProject(root);
  const selectedPort = port === null ? project.studio?.port ?? 4187 : Number(port);
  if (!Number.isInteger(selectedPort) || selectedPort < 0 || selectedPort > 65535) throw new Error("Studio port must be an integer from 0 to 65535.");
  let currentJob = null;
  let boundPort = selectedPort;
  const server = createServer(async (request, response) => {
    const raw = request.url || "";
    if (/(?:^|[\/\\])\.\.(?:[\/\\]|$)/u.test(raw) || /%2e|%2f|%5c|\\/iu.test(raw)) { send(response, 404, "text/plain; charset=utf-8", "Page not found."); return; }
    let path;
    try { path = new URL(raw, `http://127.0.0.1:${boundPort}`).pathname; } catch { send(response, 404, "text/plain; charset=utf-8", "Page not found."); return; }
    if (request.method === "GET") {
      if (path === "/api/health") { json(response, 200, { service: "pickbits-weaver-studio", generator: GENERATOR, book: project.project_id }); return; }
      if (path === "/api/jobs/current") { json(response, 200, currentJob ? { kind: currentJob.kind, started_at: currentJob.started_at, state: currentJob.state, log_tail: currentJob.log_tail.slice(-40) } : { kind: null, started_at: null, state: null, log_tail: [] }); return; }
      if (ASSETS.has(path)) { const [type, data] = ASSETS.get(path); send(response, 200, type, data); return; }
      try { const liveProject = readProject(root); const body = pageBody(path, root, liveProject, currentJob); if (body !== null) send(response, 200, "text/html; charset=utf-8", layout(body, root, liveProject)); else send(response, 404, "text/plain; charset=utf-8", "Page not found."); }
      catch (error) { send(response, 500, "text/plain; charset=utf-8", localMessage(error.message, root)); }
      return;
    }
    if (request.method !== "POST" || !new Set(["/api/rulings", "/api/approve", "/api/reject", "/api/undo", "/api/jobs", "/api/state/accept"]).has(path)) { send(response, 404, "text/plain; charset=utf-8", "Page not found."); return; }
    if (!validPost(request, boundPort)) { json(response, 403, { error: "This action is only available from the local studio page." }); return; }
    try {
      const doctor = runDoctor({ bookRoot: root });
      if (!doctor.ok) { const first = doctor.blocking[0]; json(response, 409, { error: `${first.problem}. ${first.why} ${first.fix}` }); return; }
      const data = await requestJson(request);
      const liveProject = readProject(root);
      if (path === "/api/rulings") {
        const finding = collectFindings(root, liveProject, { all: true });
        const selected = [...finding.findings, ...finding.notes].find((item) => item.id === data.id);
        if (!selected) throw new Error(`unknown finding id: ${data.id}`);
        const result = saveRuling(root, liveProject, selected, data.decision, data.note || "");
        json(response, 200, { message: `Ruling ${result.decision} saved.` });
      } else if (path === "/api/approve") {
        const result = approveChapter(root, liveProject, data.chapter, data.note || "");
        json(response, 200, { message: `Chapter ${result.chapter} approved.` });
      } else if (path === "/api/reject") {
        const result = rejectChapter(root, liveProject, data.chapter);
        json(response, 200, { message: `Chapter ${result.chapter} rejected. The rejected text was saved for recovery.` });
      } else if (path === "/api/undo") {
        undoApproval(root);
        json(response, 200, { message: "The most recent approval was reversed." });
      } else if (path === "/api/state/accept") {
        const result = acceptNarrativeState(root, liveProject);
        json(response, 200, { message: `Story state accepted: ${result.current} current scenes.` });
      } else {
        if (currentJob?.state === "running") { json(response, 409, { error: "A job is already running. Wait for it to finish." }); return; }
        const kind = data.kind, chapter = Number(data.chapter);
        if (kind !== "bootstrap" && kind !== "review") throw new Error("Choose review or bootstrap.");
        if (kind === "review" && (!Number.isInteger(chapter) || !loadScenes(root, liveProject).some((scene) => scene.chapter === chapter))) throw new Error("Choose an existing chapter.");
        const args = kind === "review" ? [CLI, "review", "--chapter", String(chapter), "--run", "--root", root] : [CLI, "state", "bootstrap", "--run", "--root", root];
        const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
        currentJob = { kind, started_at: new Date().toISOString(), state: "running", log_tail: [], child };
        const job = currentJob;
        const log = (chunk) => { for (const line of chunk.toString("utf8").split(/\r?\n/u)) if (line) job.log_tail.push(localMessage(line, root)); job.log_tail = job.log_tail.slice(-40); };
        child.stdout.on("data", log); child.stderr.on("data", log);
        child.on("error", (error) => { log(`Could not start job: ${error.message}`); job.state = "failed"; });
        child.on("close", (code) => { job.state = code === 0 ? "done" : "failed"; });
        json(response, 202, { message: `${kind === "review" ? `Chapter ${chapter} review` : "State bootstrap"} started.` });
      }
    } catch (error) { json(response, 400, { error: localMessage(error.message, root) }); }
  });
  function stopJob() {
    if (currentJob?.state !== "running") return;
    if (process.platform === "win32" && currentJob.child.pid) {
      spawnSync("taskkill", ["/PID", String(currentJob.child.pid), "/T", "/F"], { stdio: "ignore" });
    } else currentJob.child.kill();
  }
  const shutdown = () => { stopJob(); server.close(); };
  try {
    await new Promise((ready, reject) => { server.once("error", reject); server.listen(selectedPort, "127.0.0.1", ready); });
  } catch (error) {
    if (error.code === "EADDRINUSE") throw new Error(`Port ${selectedPort} is already in use. Try weaver studio --port another-number.`);
    throw error;
  }
  boundPort = server.address().port;
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.on("close", () => { stopJob(); process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown); });
  return server;
}
