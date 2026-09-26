// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildFactsLedger } from "../engine/state.mjs";
import { importBook } from "../engine/import.mjs";
import { initializeProject } from "../engine/init.mjs";
import { readProject } from "../engine/project.mjs";
import { seedCharacters } from "../engine/characters.mjs";
import { runDoctor } from "../engine/doctor.mjs";

const ROOT = resolve(".");
const CLI = join(ROOT, "scripts", "weaver.mjs");
const FAKE_HOST = join(ROOT, "test", "fixtures", "fake-host.mjs");

function runWeaver(args, root, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args, "--root", root], {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8"
  });
}

function makeBook(mode = "happy") {
  const root = mkdtempSync(join(tmpdir(), "weaver-state-"));
  initializeProject(root, { projectId: "state-book", title: "State Book", empty: true });
  const source = join(root, "finished.md");
  writeFileSync(source, "# Brask\n\nBrask crosses the bridge before dawn.\n\n* * *\n\n# Lady Veyra\n\nLady Veyra keeps the sealed letter close.\n\n* * *\n\n# Wren\n\nWren waits beside the northern gate.\n");
  importBook(root, readProject(root), source);
  seedCharacters(root, ["Brask", "Lady Veyra", "Wren"]);
  const project = readProject(root);
  project.host = { command: process.execPath, args: [FAKE_HOST, mode], concurrency: 2, timeout_seconds: 10 };
  writeFileSync(join(root, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

test("bootstrap run records imported story-so-far state and release succeeds", () => {
  const root = makeBook();
  try {
    const result = runWeaver(["state", "bootstrap", "--run"], root);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Scene 1-1: recorded/);
    assert.equal(existsSync(join(root, "narrative-state", "1-1.facts.json")), true);
    assert.equal(existsSync(join(root, "continuity", "facts.json")), true);
    assert.equal(runWeaver(["state:accept", "--through", "3-1"], root).status, 0);
    const release = runWeaver(["release", "--id", "state-release"], root);
    assert.equal(release.status, 0, `${release.stdout}\n${release.stderr}`);
    const manifest = JSON.parse(readFileSync(join(root, "releases", "state-release", "release-manifest.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest).sort(), ["artifacts", "created_at", "gates", "lifecycle", "narrative_state", "project_id", "release_id", "schema_version", "source"]);
  } finally { cleanup(root); }
});

test("state answers get one repair round, retry, early-exit, and API-key isolation", () => {
  for (const mode of ["malformed-once", "retry", "key"]) {
    const root = makeBook(mode);
    try {
      const result = runWeaver(["state", "bootstrap", "--run", "--through", "1-1"], root, { ANTHROPIC_API_KEY: "sentinel" });
      assert.equal(result.status, 0, `${mode}: ${result.stdout}\n${result.stderr}`);
      assert.equal(existsSync(join(root, "narrative-state", "1-1.md")), true, mode);
      if (mode === "key") assert.equal(readFileSync(join(root, ".weaver", "fake-host-key.txt"), "utf8").trim(), "absent");
    } finally { cleanup(root); }
  }
  const root = makeBook("early-exit");
  try {
    const result = runWeaver(["state", "bootstrap", "--run", "--through", "1-1"], root);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /host failed after 2 attempts/);
    assert.equal(existsSync(join(root, "narrative-state", "1-1.md")), false);
  } finally { cleanup(root); }
});

test("invalid quotes are rejected after repair, resume is deterministic, and the ledger picks the first scene", () => {
  const invalid = makeBook("invalid-quote");
  try {
    const result = runWeaver(["state", "bootstrap", "--run", "--through", "1-1"], invalid);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /answer invalid after repair: .*quote/);
    assert.equal(existsSync(join(invalid, "narrative-state", "1-1.md")), false);
  } finally { cleanup(invalid); }

  const root = makeBook();
  try {
    assert.equal(runWeaver(["state", "bootstrap", "--run"], root).status, 0);
    const second = runWeaver(["state", "bootstrap", "--run"], root);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /Scene 1-1: skipped, already current/);
    const before = readFileSync(join(root, "continuity", "facts.json"), "utf8");
    buildFactsLedger(root, readProject(root));
    assert.equal(readFileSync(join(root, "continuity", "facts.json"), "utf8"), before);
    const ledger = JSON.parse(before);
    assert.equal(ledger.first_established[0].scene_id, "1-1");
    const scene = join(root, "manuscript", "chapter-01", "scene-01", "scene.md");
    writeFileSync(scene, readFileSync(scene, "utf8").replace("before dawn", "after midnight"));
    const status = runWeaver(["state:status"], root);
    assert.match(status.stdout, /"first_stale": "1-1"/);
    assert.match(status.stdout, /"stale": 3/);
  } finally { cleanup(root); }
});

test("interactive packet submit round-trips and a missing host is only a warning", () => {
  const root = makeBook();
  try {
    const packet = runWeaver(["packet", "state", "--scene", "1-1"], root);
    assert.equal(packet.status, 0, `${packet.stdout}\n${packet.stderr}`);
    const id = packet.stdout.match(/Packet ([a-f0-9]{12})/u)?.[1];
    assert.ok(id);
    const answer = join(root, "answer.md");
    writeFileSync(answer, [
      "## Narrative state after scene 1-1", "", "## Newly established", "", "- A fact.", "",
      "## Character deltas", "", "-", "", "## Active threads", "", "-", "",
      "## Timeline and location", "", "-", "", "## Closing image", "", "-", "",
      "```json", JSON.stringify({ facts: [{ kind: "event", subject: "world", value: "a fact", quote: "Brask crosses the bridge" }] }), "```", ""
    ].join("\n"));
    const submitted = runWeaver(["submit", id, "--file", answer], root);
    assert.equal(submitted.status, 0, `${submitted.stdout}\n${submitted.stderr}`);
    assert.equal(existsSync(join(root, "narrative-state", "1-1.facts.json")), true);
    const project = readProject(root);
    project.host = { command: "weaver-command-that-does-not-exist" };
    writeFileSync(join(root, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
    assert.equal(runDoctor({ bookRoot: root }).checks.find((check) => check.id === "host-available").status, "warning");
  } finally { cleanup(root); }
});
