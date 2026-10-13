// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeProject } from "../engine/init.mjs";
import { importBook } from "../engine/import.mjs";
import { recordImportBaseline } from "../engine/changes.mjs";
import { readProject } from "../engine/project.mjs";
import { seedCharacters } from "../engine/characters.mjs";
import { startStudio } from "../engine/studio.mjs";

const ROOT = resolve(".");
const HOST = join(ROOT, "test", "fixtures", "fake-host.mjs");
const git = (root, ...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
const scenePath = (root) => join(root, "manuscript", "chapter-01", "scene-01", "scene.md");

function book(mode = "review-triage") {
  const root = mkdtempSync(join(tmpdir(), "weaver-studio-"));
  initializeProject(root, { projectId: "studio-book", title: "Studio Book", empty: true });
  const source = join(root, "original.md");
  writeFileSync(source, "# Chapter 1\n\nBrask and the sergeant wait at the eastern gate before dawn arrives.\n\n* * *\n\nBrask said, \"Wren carries the lantern toward the courtyard.\"\n");
  const imported = importBook(root, readProject(root), source);
  recordImportBaseline(root, imported.project, imported.record, imported.importPath);
  seedCharacters(root, ["Brask", "Wren"]);
  const registryPath = join(root, "world-bible", "characters.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  registry.characters.find((item) => item.id === "brask").aliases = ["the sergeant"];
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  const project = readProject(root);
  project.host = { command: process.execPath, args: [HOST, mode], concurrency: 3, timeout_seconds: 10 };
  writeFileSync(join(root, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
  const rules = { version: 1, rules: [{ id: "gate-phrase", type: "phrase-list", severity: "warn", message: "Check gate phrasing.", phrases: ["eastern gate"] }] };
  writeFileSync(join(root, "quality", "rules.json"), `${JSON.stringify(rules, null, 2)}\n`);
  assert.equal(git(root, "add", "-A").status, 0);
  assert.equal(git(root, "commit", "-qm", "Set up studio fixture").status, 0);
  return root;
}

async function studio(root) {
  const server = await startStudio({ root, port: 0 });
  assert.equal(server.address().address, "127.0.0.1");
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path) => fetch(`${base}${path}`);
  const post = (path, data, headers = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Weaver-Studio": "1", Origin: base, ...headers }, body: JSON.stringify(data) });
  return { server, base, get, post };
}

function close(server) { return new Promise((ready) => server.close(ready)); }

test("Jobs host selector defaults to the project and passes Codex to the job", async () => {
  const root = book();
  const project = readProject(root);
  project.host = { kind: "codex", args: ["--fixture", "basic", "--fake-mode", "review-triage"], timeout_seconds: 10 };
  writeFileSync(join(root, "project.json"), JSON.stringify(project));
  const app = await studio(root);
  try {
    const html = await (await app.get("/jobs")).text();
    assert.match(html, /id="job-host"/u);
    assert.match(html, /value="codex" selected/u);
    assert.equal((await app.post("/api/jobs", { kind: "review", chapter: 1, host: "invalid" })).status, 400);
    assert.equal((await app.post("/api/jobs", { kind: "review", chapter: 1, host: "codex" })).status, 202);
    let job;
    for (let attempt = 0; attempt < 100; attempt++) {
      job = await (await app.get("/api/jobs/current")).json();
      if (job.state !== "running") break;
      await new Promise((ready) => setTimeout(ready, 100));
    }
    assert.equal(job.host, "codex");
    assert.equal(job.state, "done", JSON.stringify(job));
    assert.ok(existsSync(join(root, ".weaver/codex-call.json")));
  } finally { await close(app.server); rmSync(root, { recursive: true, force: true }); }
});

test("health, local binding, page routes, traversal, and POST protection", async () => {
  const root = book();
  const app = await studio(root);
  try {
    const health = await app.get("/api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { service: "pickbits-weaver-studio", generator: "PickBits Weaver 0.3.0", book: "studio-book" });
    for (const route of ["/", "/book", "/book/chapter-01", "/book/chapter-01/scene-01", "/characters", "/characters/brask", "/places", "/threads", "/findings", "/changes", "/history", "/jobs"]) {
      const response = await app.get(route);
      assert.equal(response.status, 200, route);
      const html = await response.text();
      assert.match(html, /Supported setup: yes/u);
      assert.match(html, /Guardrails: on/u);
      assert.match(html, /Claude Code guardrails: on/u);
      assert.match(html, /Codex guardrails: on/u);
      assert.match(html, /Settings not sealed yet/u);
      assert.match(html, /Weaver install unchanged: yes/u);
      assert.doesNotMatch(html, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    }
    const scene = await (await app.get("/book/chapter-01/scene-01")).text();
    assert.match(scene, /href="\/characters\/brask">Brask<\/a>/u);
    assert.match(scene, /href="\/characters\/brask">the sergeant<\/a>/u);
    assert.equal((await app.get("/missing")).status, 404);
    assert.equal((await app.get("/%2e%2e/project.json")).status, 404);
    const noHeader = await fetch(`${app.base}/api/approve`, { method: "POST", headers: { Origin: app.base }, body: "{}" });
    assert.equal(noHeader.status, 403);
    assert.equal((await app.post("/api/approve", {}, { Origin: "http://foreign.example" })).status, 403);
    const settingsPath = join(root, ".claude", "settings.json");
    const original = readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(original);
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((entry) => entry.matcher !== "Bash|PowerShell");
    writeFileSync(settingsPath, JSON.stringify(settings));
    const broken = await (await app.get("/")).text();
    assert.match(broken, /Guardrails: off/u);
    assert.match(broken, /a required edit or shell hook is missing/u);
    assert.equal((await app.post("/api/approve", { chapter: 1 })).status, 409);
    writeFileSync(settingsPath, original);
    assert.match(await (await app.get("/")).text(), /Guardrails: on/u);
  } finally { await close(app.server); rmSync(root, { recursive: true, force: true }); }
});

test("approve, reject, undo, progress, and ruling lapse use engine decisions", async (t) => {
  const originalHost = process.env.CLAUDECODE;
  process.env.CLAUDECODE = "1";
  t.after(() => { if (originalHost === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = originalHost; });
  const root = book();
  const app = await studio(root);
  try {
    const initial = await (await app.get("/findings")).text();
    const finding = initial.match(/id="finding-([a-f0-9]{10})"/u)?.[1];
    assert.ok(finding);
    assert.equal((await app.post("/api/rulings", { id: finding, decision: "allow" })).status, 200);
    assert.doesNotMatch(await (await app.get("/findings")).text(), new RegExp(`id="finding-${finding}"`, "u"));
    const path = scenePath(root);
    const baseline = readFileSync(path, "utf8");
    writeFileSync(path, baseline.replace("the eastern gate", "the quiet eastern gate"));
    assert.match(await (await app.get("/findings")).text(), /an earlier ruling no longer applies because the passage changed/u);
    const before = git(root, "rev-list", "--count", "HEAD").stdout.trim();
    assert.equal((await app.post("/api/approve", { chapter: 1, note: "Reviewed" })).status, 200);
    assert.equal(Number(git(root, "rev-list", "--count", "HEAD").stdout.trim()), Number(before) + 1);
    assert.deepEqual(git(root, "show", "--format=", "--name-only", "HEAD").stdout.trim().split(/\r?\n/u), ["manuscript/chapter-01/scene-01/scene.md"]);
    assert.match(await (await app.get("/")).text(), /1 of 1 chapters approved since import/u);
    assert.equal((await app.post("/api/undo", {})).status, 200);
    assert.match(git(root, "log", "-1", "--format=%s").stdout, /Revert "Approve chapter 1/u);
    writeFileSync(path, readFileSync(path, "utf8").replace("before dawn", "after dusk"));
    assert.equal((await app.post("/api/reject", { chapter: 1 })).status, 200);
    assert.equal(readFileSync(path, "utf8").replace(/\r\n/gu, "\n"), baseline.replace(/\r\n/gu, "\n"));
    assert.equal(existsSync(join(root, ".weaver", "rejected")), true);
  } finally { await close(app.server); rmSync(root, { recursive: true, force: true }); }
});

test("bootstrap facts and threads appear, and review job refuses overlap", async () => {
  const root = book("studio");
  const app = await studio(root);
  try {
    const started = await app.post("/api/jobs", { kind: "review", chapter: 1 });
    assert.equal(started.status, 202);
    assert.equal((await app.post("/api/jobs", { kind: "review", chapter: 1 })).status, 409);
    let job;
    for (let attempt = 0; attempt < 80; attempt++) {
      job = await (await app.get("/api/jobs/current")).json();
      if (job.state !== "running") break;
      await new Promise((ready) => setTimeout(ready, 100));
    }
    assert.equal(job.state, "done", JSON.stringify(job));
    assert.equal(existsSync(join(root, "review", "chapter-01-continuity.json")), true);
    assert.equal((await app.post("/api/jobs", { kind: "bootstrap" })).status, 202);
    for (let attempt = 0; attempt < 80; attempt++) {
      job = await (await app.get("/api/jobs/current")).json();
      if (job.state !== "running") break;
      await new Promise((ready) => setTimeout(ready, 100));
    }
    assert.equal(job.state, "done", JSON.stringify(job));
    const factsPath = join(root, "continuity", "facts.json");
    assert.equal(existsSync(factsPath), true);
    const facts = JSON.parse(readFileSync(factsPath, "utf8"));
    assert.equal(facts.subjects.brask[0].kind, "location");
    assert.match(await (await app.get("/places/eastern-gate")).text(), /Brask/u);
    assert.match(await (await app.get("/threads")).text(), /The lantern journey/u);
    assert.match(await (await app.get("/jobs")).text(), /Accept story state/u);
    assert.equal((await app.post("/api/state/accept", {})).status, 200);
    assert.match(await (await app.get("/jobs")).text(), /2 current, 0 waiting/u);
    const path = scenePath(root);
    writeFileSync(path, readFileSync(path, "utf8").replace("before dawn", "after dusk"));
    for (const route of ["/", "/book", "/book/chapter-01", "/book/chapter-01/scene-01", "/characters/brask", "/places", "/places/eastern-gate", "/threads", "/findings", "/changes", "/history", "/jobs"]) assert.equal((await app.get(route)).status, 200, route);
  } finally { await close(app.server); rmSync(root, { recursive: true, force: true }); }
});

test("studio runs book reviewers, labels their findings by title, and lists all rule scopes", async () => {
  const root = book("studio");
  mkdirSync(join(root, "quality", "reviewers"), { recursive: true });
  writeFileSync(join(root, "quality", "reviewers", "character-audit.md"), "---\nid: character-audit\ntitle: Speaking character audit\nverdicts: [CLEAR, FLAGS]\ncontext: []\nqueue: definite\n---\nAudit every speaker.");
  writeFileSync(join(root, "quality", "reviewers", "broken.md"), "Broken front matter.");
  writeFileSync(join(root, "quality", "rules.json"), JSON.stringify({ version: 1, rules: [{
    id: "house-style", type: "phrase-list", severity: "warn", message: "Check this wording.", phrases: ["lantern"],
    speakers: ["brask"], except_speakers: ["wren"], pov: ["brask"], except_pov: ["wren"]
  }] }));
  const app = await studio(root);
  try {
    assert.equal((await app.post("/api/jobs", { kind: "review", chapter: 1 })).status, 202);
    let job;
    for (let attempt = 0; attempt < 100; attempt++) {
      job = await (await app.get("/api/jobs/current")).json();
      if (job.state !== "running") break;
      await new Promise((ready) => setTimeout(ready, 100));
    }
    assert.equal(job.state, "done", JSON.stringify(job));
    assert.ok(existsSync(join(root, "review", "chapter-01-character-audit.json")));
    const page = await app.get("/findings");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /class="chip">Speaking character audit<\/span>/u);
    assert.match(html, /A definite issue appears in this passage/u);
    const response = await app.get("/rules");
    assert.equal(response.status, 200);
    const rules = await response.text();
    assert.match(rules, /Applies to dialogue by Brask/u);
    assert.match(rules, /Skips dialogue attributed to Wren/u);
    assert.match(rules, /Applies in Brask&#39;s POV chapters/u);
    assert.match(rules, /Skips Wren&#39;s POV chapters/u);
    assert.match(rules, /unattributed dialogue is included/u);
  } finally { await close(app.server); rmSync(root, { recursive: true, force: true }); }
});
