// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runHost } from "../engine/host.mjs";
import { latestBookRun, runBook } from "../engine/run.mjs";
import { acceptNarrativeState, bootstrapState, narrativeStateStatus, recordedStateStatus } from "../engine/state.mjs";
import { git, makeBook } from "./helpers/book.mjs";

const quiet = () => {};
const calls = (root) => JSON.parse(readFileSync(join(root, ".weaver", "proposal-host-calls.json"), "utf8"));

test("whole-book run retries two real fake-host timeouts, then resumes with zero host calls", async (t) => {
  const { root, project } = makeBook(t, { mode: "timeouts" });
  mkdirSync(join(root, "quality", "reviewers"), { recursive: true });
  writeFileSync(join(root, "quality", "reviewers", "map-clarity.md"), "---\nid: map-clarity\ntitle: Map clarity\nverdicts: [CLEAR, FLAGS]\ncontext: [world-bible]\nqueue: definite\n---\nCheck whether references to the map are clear.\n");
  const waits = [];
  project.run.retry.delays_seconds = [30, 120];
  const result = await runBook(root, project, { run: true, onProgress: quiet, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [30_000, 120_000]);
  const scene = result.units.find((entry) => entry.unit === "scene 1-1");
  assert.equal(scene.status, "recorded");
  assert.equal(scene.attempts, 3);
  assert.match(scene.calls[0].error, /timed out/u);
  assert.equal(scene.calls[1].retry_wait_seconds, 120);
  assert.deepEqual(result.summary.failures, []);
  assert.equal(result.summary.chapters_checked, 2);
  assert.equal(result.summary.scenes_recorded, 3);
  assert.equal(result.summary.reviews_run, 8);
  assert.ok(calls(root).includes("# REVIEW packet chapter 2 lens map-clarity"));
  assert.equal(result.summary.proposals_ready, 1);
  assert.equal(result.summary.nothing_to_repair, 1);
  const count = calls(root).length;
  const second = await runBook(root, project, { run: true, onProgress: quiet, host: () => { throw new Error("No current unit should call the host"); } });
  assert.equal(calls(root).length, count);
  assert.ok(second.units.slice(2).every((entry) => entry.status === "skipped"));
  assert.deepEqual(JSON.parse(readFileSync(result.path, "utf8")).summary, result.summary);
});

test("a permanently failed unit exhausts retries, records its error, and continues", async (t) => {
  const { root, project } = makeBook(t, { mode: "failure" });
  const result = await runBook(root, project, { run: true, onProgress: quiet });
  const failed = result.units.find((unit) => unit.unit === "scene 1-2");
  assert.equal(failed.attempts, 3);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /code 7/u);
  assert.ok(result.units.some((unit) => unit.unit === "scene 2-1" && unit.status === "recorded"));
  assert.ok(result.units.some((unit) => unit.unit === "chapter 2 repair" && unit.status === "nothing-to-repair"));
  assert.deepEqual(result.summary.failures.map((unit) => unit.unit), ["scene 1-2"]);
});

test("interruption after scene k preserves recorded and accepted scenes on resume", async (t) => {
  const { root, project } = makeBook(t);
  await bootstrapState(root, project, { run: true, through: "1-1", onProgress: quiet });
  acceptNarrativeState(root, project, "1-1");
  const acceptedBytes = readFileSync(join(root, "narrative-state", "1-1.md"));
  const host = async (root, project, prompt, options) => {
    if (prompt.startsWith("# STATE packet 2-1")) throw new Error("Simulated interruption after scene 1-2");
    return runHost(root, project, prompt, options);
  };
  await assert.rejects(runBook(root, project, { run: true, host, onProgress: quiet }), /Simulated interruption/u);
  assert.equal(latestBookRun(root).status, "interrupted");
  assert.deepEqual(recordedStateStatus(root, project).map((record) => record.current), [true, true, false]);
  const before = calls(root);
  const second = await runBook(root, project, { run: true, onProgress: quiet });
  assert.deepEqual(second.summary.failures, []);
  const newCalls = calls(root).slice(before.length);
  assert.ok(!newCalls.includes("# STATE packet 1-1"));
  assert.ok(!newCalls.includes("# STATE packet 1-2"));
  assert.deepEqual(readFileSync(join(root, "narrative-state", "1-1.md")), acceptedBytes);
  assert.equal(narrativeStateStatus(root, project).current, 1, "recording downstream state must not accept it");
});

test("changed upstream prose invalidates downstream extraction and acceptance stays explicit", async (t) => {
  const { root, project, paths, bytes } = makeBook(t);
  await runBook(root, project, { run: true, onProgress: quiet });
  acceptNarrativeState(root, project);
  writeFileSync(paths[0], bytes[0].replace("silver", "folded"));
  assert.ok(recordedStateStatus(root, project).every((record) => !record.current));
  assert.equal(narrativeStateStatus(root, project).stale, 3);
  const result = await runBook(root, project, { run: true, onProgress: quiet });
  assert.equal(result.summary.scenes_recorded, 3);
  assert.equal(narrativeStateStatus(root, project).stale, 3);
});

test("packet-only and through-chapter book runs never call a host", async (t) => {
  const { root, project } = makeBook(t);
  const result = await runBook(root, project, { throughChapter: 1, host: () => { throw new Error("Host must not run"); }, onProgress: quiet });
  assert.equal(result.summary.chapters_checked, 1);
  assert.ok(result.units.slice(2).every((unit) => unit.status === "packet"));
  assert.ok(!result.units.some((unit) => unit.unit.includes("chapter 2") || unit.unit === "scene 2-1"));
});

test("accepting story state creates exactly one approval commit containing only accepted state and continuity paths", async (t) => {
  const { root, project } = makeBook(t);
  await bootstrapState(root, project, { run: true, onProgress: quiet });
  writeFileSync(join(root, "unrelated.txt"), "Leave staged.");
  git(root, "add", "unrelated.txt");
  const before = Number(git(root, "rev-list", "--count", "HEAD"));
  acceptNarrativeState(root, project, "1-2");
  assert.equal(Number(git(root, "rev-list", "--count", "HEAD")), before + 1);
  assert.match(git(root, "log", "-1", "--format=%B"), /Accept story state through 1-2[\s\S]*Approved-with:/u);
  assert.deepEqual(git(root, "show", "--format=", "--name-only", "HEAD").split("\n"), [
    "continuity/facts.json", "narrative-state/1-1.facts.json", "narrative-state/1-1.md", "narrative-state/1-2.facts.json", "narrative-state/1-2.md", "narrative-state/manifest.json"
  ]);
  assert.equal(git(root, "diff", "--cached", "--name-only"), "unrelated.txt");
});
