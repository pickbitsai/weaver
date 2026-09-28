// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
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
import { buildReviewPacket } from "../engine/review.mjs";

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
  return spawnSync(process.execPath, [CLI, ...args, "--root", root], { cwd: ROOT, encoding: "utf8" });
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
