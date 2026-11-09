// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { authorEnv } from "./helpers/env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { initializeProject } from "../engine/init.mjs";
import { importBook } from "../engine/import.mjs";
import { readProject } from "../engine/project.mjs";
import { collectFindings } from "../engine/findings.mjs";
import { buildReviewPacket, listLenses, reviewInputs, reviewRecordPath, runReview, submitReviewPacket } from "../engine/review.mjs";
import { sha256 } from "../engine/manuscript.mjs";
import { reviewerWarnings } from "../engine/reviewers.mjs";
import { seedCharacters } from "../engine/characters.mjs";
import { sealBookSettings } from "../engine/guard.mjs";
import { runDoctor } from "../engine/doctor.mjs";

const ROOT = resolve(".");
const CLI = join(ROOT, "scripts", "weaver.mjs");
const HOST = join(ROOT, "test", "fixtures", "fake-host.mjs");

function book(mode = "review-triage") {
  const root = mkdtempSync(join(tmpdir(), "weaver-review-"));
  initializeProject(root, { projectId: "review-book", title: "Review Book", empty: true });
  const source = join(root, "original.md");
  writeFileSync(source, "# Brask\n\nBrask waits beside the eastern gate before the careful dawn arrives.\n\n* * *\n\n# Wren\n\nWren carries a quiet message into the courtyard as morning advances.\n");
  importBook(root, readProject(root), source);
  const project = readProject(root);
  project.host = { command: process.execPath, args: [HOST, mode], concurrency: 3, timeout_seconds: 10 };
  writeFileSync(join(root, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
  return { root, project };
}

function cli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args, "--root", root], { env: authorEnv(), cwd: ROOT, encoding: "utf8" });
}

test("review runs three lenses, drops invented quotes, repairs malformed JSON, and resumes", async () => {
  for (const mode of ["review-invalid", "review-malformed-once"]) {
    const { root } = book(mode);
    try {
      const result = cli(root, ["review", "--chapter", "1", "--run"]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const records = ["continuity", "style", "critic"].map((lens) => JSON.parse(readFileSync(join(root, "review", `chapter-01-${lens}.json`), "utf8")));
      assert.equal(records.length, 3);
      for (const record of records) {
        assert.equal(record.findings.length, 1);
        assert.equal(record.dropped_findings, mode === "review-invalid" ? 1 : 0);
      }
      const again = cli(root, ["review", "--chapter", "1", "--run"]);
      assert.match(again.stdout, /skipped, already current/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("continuity packet uses compact prior facts and state without earlier prose", () => {
  const { root, project } = book();
  try {
    const source = join(root, "manuscript", "chapter-01", "scene-01", "scene.md");
    writeFileSync(source, readFileSync(source, "utf8").replace("careful dawn arrives", "SENTINEL EARLIER PROSE remains"));
    mkdirSync(join(root, "continuity"), { recursive: true });
    writeFileSync(join(root, "continuity", "facts.json"), JSON.stringify({ subjects: { brask: [
      { scene_id: "1-1", kind: "location", value: "the eastern gate" },
      { scene_id: "1-1", kind: "knowledge", value: "the courier is late" }
    ] } }));
    writeFileSync(join(root, "narrative-state", "1-1.md"), "Brask knows the courier is late.");
    const packet = buildReviewPacket(root, project, 2, "continuity");
    assert.match(packet.prompt, /brask location: the eastern gate/);
    assert.match(packet.prompt, /Brask knows the courier is late/);
    assert.doesNotMatch(packet.prompt, /SENTINEL EARLIER PROSE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("triage queues one definite and two critic issues, keeps notes, stays stable, and invalidates edited prose", () => {
  const { root, project } = book();
  try {
    assert.equal(cli(root, ["review", "--chapter", "1", "--run"]).status, 0);
    const first = collectFindings(root, project, { chapter: 1, all: true });
    const judgments = first.findings.filter((item) => item.kind === "judgment");
    assert.equal(judgments.length, 3);
    assert.equal(first.notes.length, 11);
    const second = collectFindings(root, project, { chapter: 1, all: true });
    assert.deepEqual(second.findings.map((item) => item.id), first.findings.map((item) => item.id));
    const path = join(root, "manuscript", "chapter-01", "scene-01", "scene.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("eastern gate", "western gate"));
    const stale = collectFindings(root, project, { chapter: 1 });
    assert.equal(stale.findings.filter((item) => item.kind === "judgment").length, 0);
    assert.equal(stale.chapters[0].stale_reviews.length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("judgment queue never exceeds six items per chapter", () => {
  const { root, project } = book("review-cap");
  try {
    assert.equal(cli(root, ["review", "--chapter", "1", "--run"]).status, 0);
    const result = collectFindings(root, project, { chapter: 1, all: true });
    assert.equal(result.findings.filter((item) => item.kind === "judgment").length, 6);
    assert.equal(result.notes.length, 24);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function reviewer(root, id = "character-audit", { context = "[world-bible]", queue = "definite", body = "Audit every speaking character.", verdicts = "[QUIET, ALERT]" } = {}) {
  mkdirSync(join(root, "quality", "reviewers"), { recursive: true });
  const path = join(root, "quality", "reviewers", `${id}.md`);
  writeFileSync(path, `---\nid: ${id} # filename id\ntitle: Character audit\nverdicts: ${verdicts}\n${context === null ? "" : `context: ${context}\n`}queue: ${queue}\n---\n${body}\n`);
  return path;
}

test("built-in packets without book notes are byte-identical to the V1-A snapshots", () => {
  // Captured before changing the packet builder, including prompts, hashes and ids.
  const before = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "builtin-review-packets.json"), "utf8"));
  const root = join(ROOT, "templates", "book");
  assert.equal(existsSync(join(root, "quality", "reviewers")), false);
  for (const lens of ["continuity", "style", "critic"]) {
    assert.equal(JSON.stringify(buildReviewPacket(root, readProject(root), 1, lens)), JSON.stringify(before[lens]));
  }
});

function outlineNotes(root, sceneRoot = "outline/scenes") {
  mkdirSync(join(root, sceneRoot), { recursive: true });
  writeFileSync(join(root, sceneRoot, "1-1.md"), "SCENE ONE SENTINEL");
  writeFileSync(join(root, sceneRoot, "2-1.md"), "SCENE TWO SENTINEL");
  writeFileSync(join(root, "outline", "arc.md"), "BOOK NOTE SENTINEL");
}

test("outline context scopes built-in packets and hashes to the chapter", () => {
  const { root, project } = book();
  try {
    outlineNotes(root);
    delete project.outline_scene_root;
    for (const chapter of [1, 2]) {
      const own = chapter === 1 ? "SCENE ONE SENTINEL" : "SCENE TWO SENTINEL";
      const other = chapter === 1 ? "SCENE TWO SENTINEL" : "SCENE ONE SENTINEL";
      for (const lens of ["continuity", "critic"]) {
        const packet = buildReviewPacket(root, project, chapter, lens);
        assert.ok(packet.prompt.includes(own), `${chapter}:${lens} includes its scene outline`);
        assert.match(packet.prompt, /BOOK NOTE SENTINEL/u);
        assert.ok(!packet.prompt.includes(other), `${chapter}:${lens} excludes the other chapter's scene outline`);
        assert.equal(packet.inputs.outline, sha256(`### arc.md\nBOOK NOTE SENTINEL\n\n### scenes/${chapter}-1.md\n${own}`));
      }
      const style = buildReviewPacket(root, project, chapter, "style");
      assert.doesNotMatch(style.prompt, /SCENE ONE SENTINEL|SCENE TWO SENTINEL|BOOK NOTE SENTINEL/u);
      assert.equal(Object.hasOwn(style.inputs, "outline"), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("outline edits stale only the owning chapter while book notes stale every chapter", async () => {
  const { root, project } = book();
  try {
    outlineNotes(root);
    for (const chapter of [1, 2]) {
      await runReview(root, project, { chapter, run: true, onProgress() {} });
      for (const lens of ["continuity", "style", "critic"]) assert.ok(existsSync(reviewRecordPath(root, chapter, lens)));
      assert.deepEqual(collectFindings(root, project, { chapter }).chapters[0].stale_reviews, []);
    }
    writeFileSync(join(root, "outline", "scenes", "2-1.md"), "CHANGED SCENE TWO SENTINEL");
    assert.deepEqual(collectFindings(root, project, { chapter: 1 }).chapters[0].stale_reviews, []);
    assert.deepEqual(collectFindings(root, project, { chapter: 2 }).chapters[0].stale_reviews, ["continuity", "critic"]);
    writeFileSync(join(root, "outline", "arc.md"), "CHANGED BOOK NOTE SENTINEL");
    assert.deepEqual(collectFindings(root, project, { chapter: 1 }).chapters[0].stale_reviews, ["continuity", "critic"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("book-outline front matter validates without warnings in check or listLenses", () => {
  const { root } = book();
  try {
    reviewer(root, "book-audit", { context: "[book-outline]" });
    const warnings = [];
    const lenses = listLenses(root, { onWarning: (warning) => warnings.push(warning) });
    assert.deepEqual(warnings, []);
    assert.deepEqual(lenses.find((lens) => lens.id === "book-audit")?.context, ["book-outline"]);
    const check = cli(root, ["check"]);
    assert.deepEqual(JSON.parse(check.stdout).warnings, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("custom outline context is scoped and book-outline retains the whole folder", () => {
  const { root, project } = book();
  try {
    outlineNotes(root);
    reviewer(root, "book-audit", { context: "[book-outline]" });
    reviewer(root, "chapter-audit", { context: "[outline]" });
    const whole = buildReviewPacket(root, project, 1, "book-audit");
    assert.match(whole.prompt, /## Book outline\n### arc.md\nBOOK NOTE SENTINEL\n\n### scenes\/1-1.md\nSCENE ONE SENTINEL\n\n### scenes\/2-1.md\nSCENE TWO SENTINEL/u);
    assert.equal(whole.inputs.book_outline, sha256("### arc.md\nBOOK NOTE SENTINEL\n\n### scenes/1-1.md\nSCENE ONE SENTINEL\n\n### scenes/2-1.md\nSCENE TWO SENTINEL"));
    assert.equal(Object.hasOwn(whole.inputs, "outline"), false);
    const scoped = buildReviewPacket(root, project, 1, "chapter-audit");
    assert.match(scoped.prompt, /## Outline\n### arc.md\nBOOK NOTE SENTINEL\n\n### scenes\/1-1.md\nSCENE ONE SENTINEL/u);
    assert.doesNotMatch(scoped.prompt, /SCENE TWO SENTINEL/u);
    writeFileSync(join(root, "outline", "scenes", "2-1.md"), "CHANGED SCENE TWO SENTINEL");
    assert.equal(buildReviewPacket(root, project, 1, "chapter-audit").id, scoped.id);
    assert.notEqual(buildReviewPacket(root, project, 1, "book-audit").id, whole.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("outline context respects custom scene roots and heading paths", () => {
  for (const sceneRoot of ["scene-outlines", "outline/locked-scenes"]) {
    const { root, project } = book();
    try {
      project.outline_scene_root = sceneRoot;
      writeFileSync(join(root, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
      outlineNotes(root, sceneRoot);
      const packet = buildReviewPacket(root, readProject(root), 1, "continuity");
      const headingRoot = sceneRoot.replace(/^outline\//u, "");
      assert.ok(packet.prompt.includes(`### ${headingRoot}/1-1.md\nSCENE ONE SENTINEL`));
      assert.match(packet.prompt, /BOOK NOTE SENTINEL/u);
      assert.doesNotMatch(packet.prompt, /SCENE TWO SENTINEL/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("book-outline includes external scene outlines recursively without matching sibling folders", () => {
  const { root, project } = book();
  try {
    project.outline_scene_root = "outline-scenes";
    writeFileSync(join(root, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
    outlineNotes(root, project.outline_scene_root);
    mkdirSync(join(root, "outline-scenes", "nested"));
    writeFileSync(join(root, "outline-scenes", "nested", "extra.md"), "EXTRA SCENE SENTINEL");
    mkdirSync(join(root, "outline-scenes-extra"));
    writeFileSync(join(root, "outline-scenes-extra", "other.md"), "SIBLING SENTINEL");
    reviewer(root, "book-audit", { context: "[book-outline]" });
    const packet = buildReviewPacket(root, readProject(root), 1, "book-audit");
    assert.match(packet.prompt, /BOOK NOTE SENTINEL[\s\S]*### outline-scenes\/1-1.md\nSCENE ONE SENTINEL[\s\S]*### outline-scenes\/2-1.md\nSCENE TWO SENTINEL[\s\S]*### outline-scenes\/nested\/extra.md\nEXTRA SCENE SENTINEL/u);
    assert.doesNotMatch(packet.prompt, /SIBLING SENTINEL/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("outline context sorts book notes before scene outlines in chapter input order", () => {
  const { root, project } = book();
  try {
    outlineNotes(root);
    mkdirSync(join(root, "outline", "nested"));
    writeFileSync(join(root, "outline", "nested", "arc.md"), "NESTED BOOK SENTINEL");
    mkdirSync(join(root, "outline", "scenes-extra"));
    writeFileSync(join(root, "outline", "scenes-extra", "arc.md"), "SIBLING BOOK SENTINEL");
    writeFileSync(join(root, "outline", "scenes", "1-2.md"), "SECOND BEAT SENTINEL");
    writeFileSync(join(root, "outline", "scenes", "1-10.md"), "TENTH BEAT SENTINEL");
    const inputs = reviewInputs(root, project, 1);
    const scene = inputs.chapterScenes[0];
    inputs.chapterScenes.push({ ...scene, id: "1-2" }, { ...scene, id: "1-10" }, { ...scene, id: "1-11" });
    const packet = buildReviewPacket(root, project, 1, "critic", inputs);
    const expected = "### arc.md\nBOOK NOTE SENTINEL\n\n### nested/arc.md\nNESTED BOOK SENTINEL\n\n### scenes-extra/arc.md\nSIBLING BOOK SENTINEL\n\n### scenes/1-1.md\nSCENE ONE SENTINEL\n\n### scenes/1-2.md\nSECOND BEAT SENTINEL\n\n### scenes/1-10.md\nTENTH BEAT SENTINEL";
    assert.ok(packet.prompt.includes(`## Outline\n${expected}\n\n## Chapter reader text`));
    assert.equal(packet.inputs.outline, sha256(expected));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unchanged scene outline starters stay excluded and custom outline keeps its placeholder", () => {
  const { root, project } = book();
  try {
    const scenePath = join(root, "outline", "scenes", "1-1.md");
    assert.equal(existsSync(scenePath), false, "empty initialization removes the scene starter");
    const before = Object.fromEntries(["continuity", "critic"].map((lens) => [lens, buildReviewPacket(root, project, 1, lens)]));
    writeFileSync(scenePath, readFileSync(join(ROOT, "templates", "book", "outline", "scenes", "1-1.md"), "utf8"));
    for (const lens of ["continuity", "critic"]) {
      const packet = buildReviewPacket(root, project, 1, lens);
      assert.deepEqual(packet, before[lens]);
      assert.doesNotMatch(packet.prompt, /## Outline|### scenes\/1-1.md/u);
      assert.equal(Object.hasOwn(packet.inputs, "outline"), false);
    }
    for (const key of ["outline", "book-outline"]) {
      reviewer(root, "chapter-audit", { context: `[${key}]` });
      const custom = buildReviewPacket(root, project, 1, "chapter-audit");
      assert.match(custom.prompt, /## (?:Outline|Book outline)\n_No project outline notes\._/u);
      assert.doesNotMatch(custom.prompt, /### scenes\/1-1.md/u);
      assert.equal(custom.inputs[key.replaceAll("-", "_")], sha256("_No project outline notes._"));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("book packets include exactly the requested contexts and always the registry and chapter", () => {
  const { root, project } = book();
  try {
    assert.equal(existsSync(join(root, "quality", "reviewers")), false, "init must not install the example");
    seedCharacters(root, ["Brask", "Wren"]);
    writeFileSync(join(root, "world-bible", "custom-lore.md"), "BIBLE SENTINEL");
    mkdirSync(join(root, "world-bible", "voices"), { recursive: true });
    writeFileSync(join(root, "world-bible", "voices", "private.md"), "VOICE SENTINEL");
    mkdirSync(join(root, "outline", "nested"), { recursive: true });
    writeFileSync(join(root, "outline", "nested", "arc.md"), "OUTLINE SENTINEL");
    writeFileSync(join(root, "style-guide", "custom.md"), "STYLE SENTINEL");
    mkdirSync(join(root, "continuity"), { recursive: true });
    writeFileSync(join(root, "continuity", "facts.json"), JSON.stringify({ subjects: { brask: [{ scene_id: "1-1", kind: "knowledge", value: "FACT SENTINEL" }] } }));
    writeFileSync(join(root, "narrative-state", "1-1.md"), "STATE SENTINEL");
    const keys = ["world-bible", "outline", "book-outline", "style-guide", "facts", "previous-state"];
    const sentinels = {
      "BIBLE SENTINEL": ["world-bible"], "OUTLINE SENTINEL": ["outline", "book-outline"],
      "STYLE SENTINEL": ["style-guide"], "FACT SENTINEL": ["facts"], "STATE SENTINEL": ["previous-state"]
    };
    for (const requested of [[], ...keys.map((key) => [key]), keys]) {
      const file = reviewer(root, "character-audit", { context: `[${requested.join(", ")}]` });
      const packet = buildReviewPacket(root, project, 2, "character-audit");
      assert.match(packet.prompt, /Audit every speaking character\.[\s\S]*## Character registry[\s\S]*"id": "brask"/u);
      assert.match(packet.prompt, /## Chapter reader text[\s\S]*Wren carries a quiet message/u);
      assert.match(packet.prompt, /Start with CHARACTER-AUDIT: QUIET or ALERT/u);
      assert.match(packet.inputs.reviewer_file, /^[a-f0-9]{64}$/u);
      for (const [sentinel, contexts] of Object.entries(sentinels)) assert.equal(packet.prompt.includes(sentinel), contexts.some((key) => requested.includes(key)), sentinel);
      assert.doesNotMatch(packet.prompt, /VOICE SENTINEL|^# World bible|^# Book outline/mu);
      assert.ok(existsSync(file));
    }
    reviewer(root, "character-audit", { context: null });
    assert.deepEqual(listLenses(root).at(-1).context, ["world-bible"]);
    assert.deepEqual(listLenses(root).map((lens) => lens.id), ["continuity", "style", "critic", "character-audit"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("built-ins get additional world-bible notes and continuity/critic outlines, with currentness tracking", async () => {
  const { root, project } = book();
  try {
    const before = Object.fromEntries(listLenses(root).map(({ id }) => [id, buildReviewPacket(root, project, 1, id)]));
    mkdirSync(join(root, "outline", "nested"), { recursive: true });
    writeFileSync(join(root, "world-bible", "custom.md"), "ADDED BIBLE");
    writeFileSync(join(root, "outline", "nested", "arc.md"), "ADDED OUTLINE");
    for (const { id } of listLenses(root)) {
      const packet = buildReviewPacket(root, project, 1, id);
      assert.match(packet.prompt, /ADDED BIBLE/u);
      assert.equal(packet.prompt.includes("ADDED OUTLINE"), id !== "style");
      const stripped = packet.prompt.replace("### custom.md\nADDED BIBLE", "_No project world-bible notes._").replace("## Outline\n### nested/arc.md\nADDED OUTLINE\n\n", "");
      assert.equal(stripped, before[id].prompt);
    }
    await runReview(root, project, { chapter: 1, run: true, onProgress() {} });
    writeFileSync(join(root, "outline", "nested", "arc.md"), "CHANGED OUTLINE");
    assert.deepEqual(collectFindings(root, project, { chapter: 1 }).chapters[0].stale_reviews, ["continuity", "critic"]);
    writeFileSync(join(root, "world-bible", "custom.md"), "CHANGED BIBLE");
    assert.deepEqual(collectFindings(root, project, { chapter: 1 }).chapters[0].stale_reviews, ["continuity", "style", "critic"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("custom verdicts record, repair, drop bad quotes, resume, and stale on reviewer or prose changes", async () => {
  for (const mode of ["review-invalid", "review-malformed-once"]) {
    const { root, project } = book(mode);
    try {
      const file = reviewer(root);
      const result = cli(root, ["review", "--chapter", "1", "--lenses", "character-audit", "--run"]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const path = reviewRecordPath(root, 1, "character-audit");
      assert.equal(path, join(root, "review", "chapter-01-character-audit.json"));
      const record = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(record.verdict, "ALERT");
      assert.equal(record.findings.length, 1);
      assert.equal(record.dropped_findings, mode === "review-invalid" ? 1 : 0);
      assert.match(cli(root, ["review", "--chapter", "1", "--lenses", "character-audit", "--run"]).stdout, /skipped, already current/u);
      const packet = buildReviewPacket(root, project, 1, "character-audit");
      writeFileSync(file, readFileSync(file, "utf8").replace("# filename id", "# changed configuration comment"));
      assert.equal(buildReviewPacket(root, project, 1, "character-audit").prompt, packet.prompt, "a front-matter-only edit must invalidate the record too");
      assert.deepEqual(collectFindings(root, project, { chapter: 1 }).chapters[0].stale_reviews, ["character-audit"]);
      assert.equal((await submitReviewPacket(root, project, packet, "unused stale answer")).ok, false);
      await runReview(root, project, { chapter: 1, lenses: ["character-audit"], run: true, onProgress() {} });
      assert.equal(collectFindings(root, project, { chapter: 1 }).chapters[0].stale_reviews.length, 0);
      const scene = join(root, "manuscript", "chapter-01", "scene-01", "scene.md");
      writeFileSync(scene, readFileSync(scene, "utf8").replace("eastern", "western"));
      assert.deepEqual(collectFindings(root, project, { chapter: 1 }).chapters[0].stale_reviews, ["character-audit"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("reviewer queue settings, filename priority, clear verdict and the shared cap", async () => {
  const { root, project } = book();
  try {
    reviewer(root, "c-three", { queue: "top-3" });
    reviewer(root, "b-two", { queue: "top-2" });
    reviewer(root, "a-definite");
    // Running only book lenses leaves room to discriminate all three queue settings.
    await runReview(root, project, { chapter: 1, lenses: ["a-definite", "b-two", "c-three"], run: true, onProgress() {} });
    let result = collectFindings(root, project, { chapter: 1, all: true });
    assert.deepEqual(result.chapters[0].counts.book_reviewers, { "a-definite": 1, "b-two": 2, "c-three": 3 });
    assert.equal(result.chapters[0].counts.queued_judgments, 6);
    assert.deepEqual(result.findings.filter((finding) => finding.kind === "judgment").map((finding) => finding.lens), ["a-definite", "b-two", "b-two", "c-three", "c-three", "c-three"]);
    const path = reviewRecordPath(root, 1, "b-two");
    const record = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...record, verdict: "QUIET" }));
    assert.equal(collectFindings(root, project, { chapter: 1 }).chapters[0].counts.book_reviewers["b-two"], 0);
    writeFileSync(path, JSON.stringify(record));
    const all = cli(root, ["review", "--chapter", "1", "--run"]);
    assert.equal(all.status, 0, all.stdout + all.stderr);
    result = collectFindings(root, project, { chapter: 1, all: true });
    assert.equal(result.chapters[0].counts.queued_judgments, 6);
    assert.deepEqual(result.chapters[0].counts.book_reviewers, { "a-definite": 1, "b-two": 2, "c-three": 0 });
    assert.equal(result.notes.filter((finding) => finding.lens === "c-three").length, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid reviewers are named warnings in check and doctor and never block the other lenses", () => {
  const { root } = book();
  try {
    const file = reviewer(root);
    const valid = readFileSync(file, "utf8");
    const cases = [
      ["missing-front", "No front matter", /front-matter block/u],
      ["unknown-context", valid.replace("character-audit", "unknown-context").replace("[world-bible]", "[planet]"), /unknown context key planet/u],
      ["critic", valid.replace("character-audit", "critic"), /built-in reviewer/u],
      ["wrong-name", valid, /must match the filename/u],
      ["missing-body", valid.replace("character-audit", "missing-body").replace("Audit every speaking character.", ""), /instructions are missing/u],
      ["bad-list", valid.replace("character-audit", "bad-list").replace("[QUIET, ALERT]", "[QUIET]"), /exactly two/u],
      ["bad-queue", valid.replace("character-audit", "bad-queue").replace("queue: definite", "queue: all"), /queue must be/u],
      ["duplicate", valid.replace("character-audit", "duplicate").replace("queue: definite", "queue: definite\nqueue: top-2"), /key queue is repeated/u]
    ];
    for (const [id, text] of cases) writeFileSync(join(root, "quality", "reviewers", `${id}.md`), text);
    const warnings = reviewerWarnings(root);
    assert.equal(warnings.length, cases.length);
    for (const [id, , problem] of cases) assert.match(warnings.find((warning) => warning.startsWith(`quality/reviewers/${id}.md:`)), problem);
    assert.deepEqual(listLenses(root).map((lens) => lens.id), ["continuity", "style", "critic", "character-audit"]);
    const check = JSON.parse(cli(root, ["check"]).stdout);
    assert.deepEqual(check.warnings, warnings);
    const doctor = JSON.parse(cli(root, ["doctor", "--json"]).stdout);
    assert.deepEqual(doctor.warnings.filter((warning) => warning.id === "book-reviewers").map((warning) => warning.problem), warnings);
    const run = cli(root, ["review", "--chapter", "1", "--run"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    for (const lens of listLenses(root)) assert.ok(existsSync(reviewRecordPath(root, 1, lens.id)));
    assert.match(run.stdout, /quality\/reviewers\/critic.md.*built-in/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("submitted book reviews track every requested context but ignore unrequested notes", async () => {
  const { root, project } = book();
  try {
    reviewer(root, "context-audit", { context: "[outline, style-guide, facts, previous-state]" });
    const paths = [
      join(root, "outline", "arc.md"), join(root, "style-guide", "custom.md"),
      join(root, "continuity", "facts.json"), join(root, "narrative-state", "1-1.md")
    ];
    mkdirSync(join(root, "continuity"), { recursive: true });
    for (const path of paths.filter((path) => !path.endsWith(".json"))) writeFileSync(path, "Initial context");
    const facts = (value) => JSON.stringify({ subjects: { brask: [{ scene_id: "1-1", kind: "knowledge", value }] } });
    writeFileSync(paths[2], facts("initial fact"));
    const answer = 'CONTEXT-AUDIT: ALERT\n```json\n{"verdict":"ALERT","findings":[{"severity":"definite","scene_id":"2-1","paragraph":1,"quote":"Wren carries a quiet message","issue":"Check the message.","repair":"Clarify the message."}]}\n```';
    const recordCurrent = async () => {
      const result = await submitReviewPacket(root, project, buildReviewPacket(root, project, 2, "context-audit"), answer);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(collectFindings(root, project, { chapter: 2 }).chapters[0].stale_reviews, []);
    };
    await recordCurrent();
    writeFileSync(join(root, "world-bible", "unrequested.md"), "These notes are not requested.");
    assert.deepEqual(collectFindings(root, project, { chapter: 2 }).chapters[0].stale_reviews, []);
    for (const [index, path] of paths.entries()) {
      writeFileSync(path, index === 2 ? facts("changed fact") : "Changed context");
      assert.deepEqual(collectFindings(root, project, { chapter: 2 }).chapters[0].stale_reviews, ["context-audit"], path);
      await recordCurrent();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reviewer and rule-scope edits remain covered by the existing settings seal", () => {
  const { root } = book();
  try {
    const file = reviewer(root);
    seedCharacters(root, ["Brask"]);
    sealBookSettings(root);
    writeFileSync(file, readFileSync(file, "utf8").replace("every speaking", "every named"));
    const rulesFile = join(root, "quality", "rules.json");
    const rules = JSON.parse(readFileSync(rulesFile, "utf8"));
    rules.rules[0].pov = ["brask"];
    writeFileSync(rulesFile, JSON.stringify(rules));
    const seal = runDoctor({ bookRoot: root }).checks.find((check) => check.id === "book-settings-sealed");
    assert.equal(seal.status, "blocking");
    assert.ok(seal.findings[0].paths.includes("quality/reviewers/character-audit.md"));
    assert.ok(seal.findings[0].paths.includes("quality/rules.json"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
