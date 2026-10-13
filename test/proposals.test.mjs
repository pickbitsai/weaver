// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { acceptProposal, buildRepairPacket, listProposals, proposalIsStale, readProposal, rejectProposal, repairChapter, repairInputs, selectRepairFindings, validateRepairEdits, validateRepairAnswer, submitRepairPacket } from "../engine/repair.mjs";
import { collectFindings } from "../engine/findings.mjs";
import { saveRuling } from "../engine/rulings.mjs";
import { startStudio, diffWords } from "../engine/studio.mjs";
import { authorEnv } from "./helpers/env.mjs";
import { first, middle, last, git, makeBook } from "./helpers/book.mjs";

const quiet = () => {};
function answer(inputs, override = {}) {
  const finding = inputs.findings[0];
  return { edits: [{ scene_id: finding.scene_id, paragraph: finding.paragraph, finding_ids: [finding.id], before: first, after: first.replace("murky", "clear"), reason: "Clarify the map.", ...override }], declined: [] };
}

test("repair selection includes blocks, voice warnings, queued judgments and every fix ruling", () => {
  const items = [
    { id: "block", kind: "rule", severity: "block" }, { id: "voice", kind: "voice", severity: "warn" },
    { id: "queued", kind: "judgment", queued: true }, { id: "fix-note", kind: "judgment", queued: false, ruling: "author wants this fixed" },
    { id: "fix-warn", kind: "rule", severity: "warn", ruling: "fix" }, { id: "note", kind: "judgment", queued: false },
    { id: "warn", kind: "rule", severity: "warn" }, { id: "allow", kind: "rule", severity: "block", ruling: "allow" },
    { id: "intended", kind: "voice", severity: "warn", ruling: "intended" }
  ];
  assert.deepEqual(selectRepairFindings(items).map((item) => item.id), ["block", "voice", "queued", "fix-note", "fix-warn"]);
});

test("repair packet has source Markdown, exact sentences, context, evidence and all hashes", (t) => {
  const { root, project } = makeBook(t);
  const inputs = repairInputs(root, project, 1);
  inputs.findings.push({ id: "voice", kind: "voice", source: "Rill", scene_id: "1-1", paragraph: 1, line: "The exact spoken line.", evidence: [{ text: "A typical line.", scene_id: "1-2", paragraph: 1 }] });
  const packet = buildRepairPacket(root, project, 1, { inputs, note: "Keep the map." });
  assert.equal(packet.kind, "REPAIR");
  assert.match(packet.prompt, /\[1-1 p1\] Rill keeps the \*murky\* silver map\./u);
  for (const text of ["Editorial rules", "Character registry", "World bible", "A typical line.", "The exact spoken line.", "Keep the map."]) assert.ok(packet.prompt.includes(text));
  for (const name of ["chapter_prose", "findings", "rules", "rulings", "editorial_rules", "world_bible", "registry"]) assert.match(packet.inputs[name], /^[a-f0-9]{64}$/u);
});

test("unflagged paragraph edit is dropped even with a real targeted finding id", (t) => {
  const { root, project } = makeBook(t);
  const inputs = repairInputs(root, project, 1);
  const result = validateRepairEdits(root, project, inputs, answer(inputs, { paragraph: 2, before: middle, after: "The lantern stays by the door." }));
  assert.equal(result.edits.length, 0);
  assert.match(result.dropped_edits[0].why, /unflagged paragraph/u);
});

test("before mismatch, growth, blank lines, and worse blocking rules each drop the edit", (t) => {
  const { root, project, paths, bytes } = makeBook(t);
  const inputs = repairInputs(root, project, 1);
  for (const [override, reason] of [
    [{ before: "Wrong paragraph." }, /before/u],
    [{ after: "Rill keeps the very clear and beautiful silver map." }, /growth/u],
    [{ after: "One.\n\nTwo." }, /paragraph/u],
    [{ after: first.replace("murky", "forbidden") }, /worsens a blocking rule/u]
  ]) {
    const result = validateRepairEdits(root, project, inputs, answer(inputs, override));
    assert.equal(result.edits.length, 0);
    assert.match(result.dropped_edits[0].why, reason);
  }
  assert.equal(readFileSync(paths[0], "utf8"), bytes[0]);
});

test("an edit that keeps its targeted block is marked didn't fix it", (t) => {
  const { root, project } = makeBook(t);
  const inputs = repairInputs(root, project, 1);
  const result = validateRepairEdits(root, project, inputs, answer(inputs, { after: first.replace("silver", "folded") }));
  assert.equal(result.edits.length, 1);
  assert.equal(result.edits[0].validation, "didn't fix it");
  assert.deepEqual(result.edits[0].unfixed_findings, [inputs.findings[0].id]);
});

test("malformed JSON and broken coverage get exactly one repair round; all declines keep reasons", async (t) => {
  for (const mode of ["malformed", "coverage", "decline"]) {
    const { root, project } = makeBook(t, { mode });
    const result = await repairChapter(root, project, { chapter: 1, run: true, onProgress: quiet });
    assert.equal(result.status, mode === "decline" ? "declined" : "ready");
    const calls = JSON.parse(readFileSync(join(root, ".weaver", "proposal-host-calls.json"), "utf8"));
    assert.equal(calls.length, mode === "decline" ? 1 : 2);
    if (mode === "decline") {
      assert.equal(result.edits.length, 0);
      assert.equal(result.declined.length, 2);
      assert.equal(result.declined[0].reason, "The meaning needs an author decision.");
    } else assert.equal(result.edits.length, 2);
  }
});

test("nothing to repair makes no host call; packet-only mode preserves manuscript", async (t) => {
  const { root, project, paths, bytes } = makeBook(t);
  const result = await repairChapter(root, project, { chapter: 2, run: true, host: () => { throw new Error("unexpected call"); }, onProgress: quiet });
  assert.equal(result.status, "nothing-to-repair");
  const packet = await repairChapter(root, project, { chapter: 1, onProgress: quiet });
  assert.equal(packet.status, "packet");
  assert.ok(existsSync(packet.path));
  assert.equal(readFileSync(paths[0], "utf8"), bytes[0]);
});

test("duplicate and unknown finding coverage is rejected and two malformed answers record failure", async (t) => {
  const { root, project } = makeBook(t);
  const inputs = repairInputs(root, project, 1);
  const invalid = { edits: [], declined: [...inputs.findings.map((finding) => ({ finding_id: finding.id, reason: "Needs author input." })), { finding_id: inputs.findings[0].id, reason: "Duplicate." }, { finding_id: "unknown", reason: "Unknown." }] };
  const checked = validateRepairAnswer(`\`\`\`json\n${JSON.stringify(invalid)}\n\`\`\``, inputs.findings);
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join("; "), /exactly once/u);
  assert.match(checked.errors.join("; "), /unknown finding/u);
  let calls = 0;
  const result = await repairChapter(root, project, { chapter: 1, run: true, onProgress: quiet, host: async () => { calls++; return { ok: true, text: "not JSON", attempts: 1 }; } });
  assert.equal(calls, 2);
  assert.equal(result.status, "failed");
  assert.match(readProposal(root, 1).error, /fenced/u);
  assert.equal(listProposals(root, project)[0].status, "failed");
});

test("interactive repair submit stores declines and rejects changed inputs without a host call", async (t) => {
  const { root, project, paths, bytes } = makeBook(t);
  const { packet } = await repairChapter(root, project, { chapter: 1, onProgress: quiet });
  const inputs = repairInputs(root, project, 1);
  const text = `\`\`\`json\n${JSON.stringify({ edits: [], declined: inputs.findings.map((finding) => ({ finding_id: finding.id, reason: "The map description is intentional." })) })}\n\`\`\``;
  const result = await submitRepairPacket(root, project, packet, text, { host: () => { throw new Error("No correction needed"); } });
  assert.equal(result.ok, true);
  assert.equal(readProposal(root, 1).declined.length, 2);
  writeFileSync(paths[0], bytes[0].replace("silver", "folded"));
  const stale = await submitRepairPacket(root, project, packet, text, { host: () => { throw new Error("Stale answers must not call a host"); } });
  assert.equal(stale.ok, false);
  assert.match(stale.errors[0], /stale/u);
});

test("a different banned phrase at the same count is kept but remains unfixed", (t) => {
  const { root, project } = makeBook(t);
  const path = join(root, "quality", "rules.json");
  const rules = JSON.parse(readFileSync(path, "utf8"));
  rules.rules[0].phrases.push("foggy");
  writeFileSync(path, JSON.stringify(rules));
  const inputs = repairInputs(root, project, 1);
  const result = validateRepairEdits(root, project, inputs, answer(inputs, { after: first.replace("murky", "foggy") }));
  assert.equal(result.edits.length, 1);
  assert.equal(result.edits[0].validation, "didn't fix it");
  assert.deepEqual(result.edits[0].findings_fixed, []);
});

test("active allow and intended rulings remove repair targets without calling a host", async (t) => {
  const { root, project } = makeBook(t);
  const findings = collectFindings(root, project).findings;
  saveRuling(root, project, findings[0], "allow");
  saveRuling(root, project, findings[1], "intended");
  const result = await repairChapter(root, project, { chapter: 1, run: true, onProgress: quiet, host: () => { throw new Error("No repair targets remain"); } });
  assert.equal(result.status, "nothing-to-repair");
});

export async function readyWarnings(t) {
  const context = makeBook(t, { severity: "warn" });
  const { root, project } = context;
  for (const finding of collectFindings(root, project).findings) saveRuling(root, project, finding, "fix");
  await repairChapter(root, project, { chapter: 1, run: true, onProgress: quiet });
  return context;
}

test("accept applies exactly the chosen edit bytes in one chapter-only approval commit", async (t) => {
  const { root, project, paths, bytes } = await readyWarnings(t);
  writeFileSync(join(root, "unrelated.txt"), "Keep this staged.");
  git(root, "add", "unrelated.txt");
  const count = Number(git(root, "rev-list", "--count", "HEAD"));
  acceptProposal(root, project, 1, { edits: [1], note: "Keep the second phrase." });
  assert.equal(readFileSync(paths[0], "utf8"), bytes[0].replace(first, first.replace("murky", "clear")));
  assert.equal(readFileSync(paths[1], "utf8"), bytes[1]);
  assert.equal(readFileSync(paths[2], "utf8"), bytes[2]);
  assert.equal(Number(git(root, "rev-list", "--count", "HEAD")), count + 1);
  assert.equal(git(root, "show", "--format=", "--name-only", "HEAD"), "manuscript/chapter-01/scene-01/scene.md");
  assert.match(git(root, "log", "-1", "--format=%B"), /Repairs accepted, chapter 1 \(1 of 2 edits\)[\s\S]*Approved-with:/u);
  assert.equal(git(root, "diff", "--cached", "--name-only"), "unrelated.txt");
  assert.equal(listProposals(root, project)[0].status, "accepted");
});

test("accept refuses a subset leaving a block and refuses another pending chapter", async (t) => {
  const { root, project, paths, bytes } = makeBook(t);
  await repairChapter(root, project, { chapter: 1, run: true, onProgress: quiet });
  assert.throws(() => acceptProposal(root, project, 1, { edits: [1] }), /Blocking findings.*ruling.*Ask again/u);
  assert.equal(readFileSync(paths[0], "utf8"), bytes[0]);
  writeFileSync(paths[2], bytes[2].replace("quiet", "green"));
  assert.throws(() => acceptProposal(root, project, 1), /Another chapter has pending/u);
  assert.equal(readFileSync(paths[0], "utf8"), bytes[0]);
});

test("prose, rules, rulings and findings changes stale proposals; reject preserves record and note", async (t) => {
  const { root, project, paths, bytes } = makeBook(t);
  await repairChapter(root, project, { chapter: 1, run: true, onProgress: quiet });
  const record = readProposal(root, 1);
  for (const name of ["chapter_prose", "rules", "rulings", "findings"]) {
    const inputs = repairInputs(root, project, 1);
    inputs.hashes[name] = "changed";
    assert.ok(proposalIsStale(record, inputs), name);
  }
  writeFileSync(paths[0], bytes[0].replace("silver", "folded"));
  assert.equal(listProposals(root, project)[0].status, "stale");
  assert.throws(() => acceptProposal(root, project, 1), /stale/u);
  const rejected = rejectProposal(root, 1, "Keep this version for reference.");
  assert.ok(existsSync(rejected.path));
  assert.equal(readProposal(root, 1), null);
  assert.equal(JSON.parse(readFileSync(rejected.path, "utf8")).rejection_note, "Keep this version for reference.");
});

test("proposal CLI refuses CLAUDECODE before changing files", async (t) => {
  const { root, project, paths, bytes } = makeBook(t);
  await repairChapter(root, project, { chapter: 1, run: true, onProgress: quiet });
  const result = spawnSync(process.execPath, [resolve("scripts/weaver.mjs"), "proposal", "accept", "--chapter", "1", "--root", root], { encoding: "utf8", env: { ...authorEnv(), CLAUDECODE: "1" } });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /author's decision/u);
  assert.equal(readFileSync(paths[0], "utf8"), bytes[0]);
});

test("Studio proposals render a word diff and accepting one of two edits applies only that edit", async (t) => {
  const { root, paths, bytes } = await readyWarnings(t);
  const server = await startStudio({ root, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (await fetch(`${base}/proposals`)).text();
    assert.match(page, /Accept selected/u);
    assert.match(page, /<del>\*murky\*<\/del>/u);
    assert.match(page, /<ins>\*clear\*<\/ins>/u);
    assert.equal((page.match(/data-proposal="1"/gu) || []).length, 2);
    assert.match(await (await fetch(`${base}/`)).text(), /1 proposals waiting/u);
    assert.equal((await fetch(`${base}/api/proposals/accept`, { method: "POST", body: "{}" })).status, 403);
    const response = await fetch(`${base}/api/proposals/accept`, { method: "POST", headers: { "Content-Type": "application/json", "X-Weaver-Studio": "1", Origin: base }, body: JSON.stringify({ chapter: 1, edits: [1], note: "Only the map." }) });
    assert.equal(response.status, 200, await response.text());
    assert.equal(readFileSync(paths[0], "utf8"), bytes[0].replace(first, first.replace("murky", "clear")));
  } finally { await new Promise((ready) => server.close(ready)); }
  const diff = diffWords("One old word and another old word.", "One new word and another fresh word.");
  assert.equal(diff.before, "One <del>old</del> word and another <del>old</del> word.");
  assert.equal(diff.after, "One <ins>new</ins> word and another <ins>fresh</ins> word.");
  assert.equal(diffWords("<script>", "<img>").after, "<ins>&lt;img&gt;</ins>");
});

test("Studio whole-book job refuses overlap, exposes live run progress, and Ask again adds the note", async (t) => {
  const { root } = makeBook(t, { mode: "delay" });
  const server = await startStudio({ root, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (value) => fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", "X-Weaver-Studio": "1", Origin: base }, body: JSON.stringify(value) });
  async function done() {
    const deadline = Date.now() + 30_000;
    let sawRun = false;
    while (Date.now() < deadline) {
      const job = await (await fetch(`${base}/api/jobs/current`)).json();
      if (job.run?.units?.length) sawRun = true;
      if (job.state !== "running") { assert.equal(job.state, "done", JSON.stringify(job)); return sawRun; }
      await new Promise((ready) => setTimeout(ready, 100));
    }
    assert.fail("Studio job did not finish");
  }
  try {
    assert.equal((await post({ kind: "book" })).status, 202);
    assert.equal((await post({ kind: "review", chapter: 1 })).status, 409);
    assert.ok(await done(), "run record should be exposed during the job");
    assert.equal((await post({ kind: "repair", chapter: 1, note: "Keep the silver map." })).status, 202);
    assert.equal((await post({ kind: "book" })).status, 409);
    await done();
    assert.match(readFileSync(join(root, ".weaver", "last-repair-prompt.txt"), "utf8"), /Keep the silver map\./u);
  } finally { await new Promise((ready) => server.close(ready)); }
});
