// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runHook } from "../engine/hooks.mjs";
import { readProject } from "../engine/project.mjs";
import { runRules, runRulesForScene } from "../engine/rules.mjs";
import { sha256 } from "../engine/manuscript.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DASH = { id: "em-dashes", type: "count-per-words", severity: "block", message: "Use em dashes sparingly.", text: "—", max: 2, per_words: 1000, unit: "scene" };
const PHRASE = { id: "ai-phrases", type: "phrase-list", severity: "block", message: "Use specific prose.", phrases: ["delve"] };
const sceneText = (prose) => `# Chapter 1, Scene 1\n\n**POV:** Protagonist\n\n---\n\n${prose}\n\n---\n\n**Words:** 0\n`;
const dashLine = (count) => `Start${" —".repeat(count)} end.`;
const dashProse = (count, words = 1000) => `${dashLine(count)} ${"word ".repeat(words - 2)}`.trim();

function fixture(t, prose, rules = [DASH, PHRASE]) {
  const root = mkdtempSync(join(tmpdir(), "weaver-pre-edit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(ROOT, "templates", "book"), root, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  const path = join(root, "manuscript", "chapter-01", "scene-01", "scene.md");
  writeFileSync(path, sceneText(prose));
  writeFileSync(join(root, "quality", "rules.json"), JSON.stringify({ version: 1, rules }));
  const payload = (tool_name, input) => ({ cwd: root, tool_name, tool_input: { file_path: path, ...input } });
  return { root, path, payload, edit: (old_string, new_string, rest = {}) => payload("Edit", { old_string, new_string, ...rest }) };
}

function denied(result, rule, before, after) {
  assert.equal(result?.hookSpecificOutput?.hookEventName, "PreToolUse");
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  const reason = result.hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.includes(rule.id), reason);
  assert.ok(reason.includes(rule.message), reason);
  assert.match(reason, new RegExp(`from ${before} to ${after}\\b`, "u"));
  assert.match(reason, /Blocking rules can't be waived by the AI.*ask the author/u);
  return reason;
}

function allowed(result) {
  // Requiring the existing context also catches accidental fail-open exceptions.
  assert.equal(result?.hookSpecificOutput?.hookEventName, "PreToolUse");
  assert.equal(result.hookSpecificOutput.permissionDecision, undefined);
  assert.match(result.hookSpecificOutput.additionalContext, /# Editorial rules/u);
  assert.match(result.hookSpecificOutput.additionalContext, /Rule messages:/u);
  assert.equal(result.suppressOutput, true);
}

test("pre-edit denies added em dashes with the rule, message and actual before/after counts", (t) => {
  const f = fixture(t, dashProse(1));
  const before = readFileSync(f.path, "utf8");
  const payload = f.edit(dashLine(1), dashLine(9));
  const reason = denied(runHook("pre", payload), DASH, 1, 9);
  assert.match(reason, /limit 2 per 1,000 words/u);
  const cli = spawnSync(process.execPath, [join(ROOT, "scripts", "weaver.mjs"), "hook", "pre"], {
    cwd: f.root, input: JSON.stringify(payload), encoding: "utf8"
  });
  assert.equal(cli.status, 0, cli.stderr);
  denied(JSON.parse(cli.stdout), DASH, 1, 9);
  assert.equal(readFileSync(f.path, "utf8"), before, "simulation must not write the scene");
});

test("pre-edit denies Write content that adds a blocking AI phrase", (t) => {
  const f = fixture(t, "They wait.");
  denied(runHook("pre", f.payload("Write", { content: sceneText("They delve.") })), PHRASE, 0, 1);
  assert.equal(readFileSync(f.path, "utf8"), sceneText("They wait."));
});

test("pre-edit applies MultiEdit in order and catches the second edit", (t) => {
  const f = fixture(t, "They wait.");
  const edits = [{ old_string: "wait", new_string: "pause" }, { old_string: "pause", new_string: "delve" }];
  allowed(runHook("pre", f.payload("MultiEdit", { edits: edits.slice(0, 1) })));
  denied(runHook("pre", f.payload("MultiEdit", { edits })), PHRASE, 0, 1);
  // Judge the final result, so a temporary violation repaired by the next edit is allowed.
  allowed(runHook("pre", f.payload("MultiEdit", { edits: [...edits, { old_string: "delve", new_string: "pause" }] })));
});

test("replace_all multiplies a violation while ordinary Edit replaces only once", (t) => {
  const rule = { ...DASH, type: "max-per-paragraph", max: 1 };
  const f = fixture(t, "turn turn turn.", [rule]);
  allowed(runHook("pre", f.edit("turn", "—")));
  denied(runHook("pre", f.edit("turn", "—", { replace_all: true })), rule, 0, 3);
  denied(runHook("pre", f.payload("MultiEdit", { edits: [{ old_string: "turn", new_string: "—", replace_all: true }] })), rule, 0, 3);
});

test("replacement strings are literal, including dollar replacement markers", (t) => {
  const rule = { ...PHRASE, type: "regex", pattern: "\\$&" };
  const f = fixture(t, "They wait.", [rule]);
  for (const replace_all of [false, true]) denied(runHook("pre", f.edit("wait", "$&", { replace_all })), rule, 0, 1);
});

test("partial repairs of an over-limit scene are allowed and post still reports the remainder", (t) => {
  const f = fixture(t, dashProse(9));
  const original = readFileSync(f.path, "utf8");
  allowed(runHook("pre", f.edit(dashLine(9), dashLine(5))));
  assert.equal(readFileSync(f.path, "utf8"), original);
  writeFileSync(f.path, original.replace(dashLine(9), dashLine(5)));
  const post = runHook("post", f.payload("Edit", {}));
  assert.equal(post?.decision, "block");
  assert.match(post.reason, /em-dashes/u);
});

test("unrelated edits may leave existing blocking findings untouched", (t) => {
  const f = fixture(t, `${dashProse(9)}\n\nThey delve then wait.`);
  allowed(runHook("pre", f.edit("wait", "pause")));
});

test("an increase under the limit is allowed", (t) => {
  const f = fixture(t, dashProse(0));
  allowed(runHook("pre", f.edit(dashLine(0), dashLine(2))));
});

test("counting rules deny worsening an existing finding even when the number of findings stays one", (t) => {
  const f = fixture(t, dashProse(5));
  denied(runHook("pre", f.edit(dashLine(5), dashLine(9))), DASH, 5, 9);
});

test("paragraph counts, sentence shares and repeated starts also compare measured values", (t) => {
  const cases = [
    { rule: { ...DASH, type: "max-per-paragraph", max: 1 }, before: dashLine(3), worse: dashLine(5), better: dashLine(2), counts: [3, 5] },
    { rule: { id: "starts", type: "repeated-sentence-starts", max_run: 2, severity: "block", message: "Vary starts." },
      before: "I ran. I waited. I listened.", worse: "I ran. I waited. I listened. I left.", better: "I ran. We waited. I listened.", counts: [3, 4] },
    { rule: { id: "share", type: "sentence-start-share", word: "I", max_share: 0.4, min_sentences: 2, unit: "paragraph", severity: "block", message: "Vary starts." },
      before: "I ran. I waited. We listened. We left.", worse: "I ran. I waited.", better: "I ran. We waited. We listened. We left.", counts: [2, 2] }
  ];
  for (const { rule, before, worse, better, counts } of cases) {
    const f = fixture(t, before, [rule]);
    denied(runHook("pre", f.edit(before, worse)), rule, ...counts);
    allowed(runHook("pre", f.edit(before, better)));
  }
});

test("moving paragraphs preserves findings while an additional over-limit paragraph is denied", (t) => {
  const rule = { ...DASH, type: "max-per-paragraph", max: 1 };
  const f = fixture(t, `${dashLine(5)}\n\nA quiet ending.`, [rule]);
  allowed(runHook("pre", f.payload("Write", { content: sceneText(`A quiet opening.\n\n${dashLine(5)}\n\nA quiet ending.`) })));
  denied(runHook("pre", f.edit("A quiet ending.", dashLine(3))), rule, 0, 3);
});

test("a short paragraph below min_sentences cannot mask a worsening sentence share", (t) => {
  const rule = { id: "share", type: "sentence-start-share", word: "I", max_share: 0.4, min_sentences: 3, unit: "paragraph", severity: "block", message: "Vary starts." };
  const f = fixture(t, "I ran.\n\nI waited. I listened. We left.", [rule]);
  denied(runHook("pre", f.edit("We left.", "I left.")), rule, 2, 3);
});

test("shortening prose can worsen the measured rate with the same dash count", (t) => {
  const f = fixture(t, dashProse(5));
  const reason = denied(runHook("pre", f.payload("Write", { content: sceneText(dashProse(5, 500)) })), DASH, 5, 5);
  assert.match(reason, /rate from 5 to 10 per 1,000 words/u);
  allowed(runHook("pre", f.payload("Write", { content: sceneText(dashProse(5, 2000)) })));
});

test("each blocking rule is compared independently", (t) => {
  const f = fixture(t, `${dashProse(9)}\n\nThey wait.`);
  denied(runHook("pre", f.payload("Write", { content: sceneText(`${dashProse(0)}\n\nThey delve.`) })), PHRASE, 0, 1);
});

test("warning-only edits are allowed and the post hook still reports them", (t) => {
  const f = fixture(t, "They wait.", [{ ...PHRASE, severity: "warn" }]);
  allowed(runHook("pre", f.edit("wait", "delve")));
  writeFileSync(f.path, sceneText("They delve."));
  const post = runHook("post", f.payload("Edit", {}));
  assert.equal(post?.decision, undefined);
  assert.equal(post?.hookSpecificOutput?.hookEventName, "PostToolUse");
  assert.match(post.hookSpecificOutput.additionalContext, /ai-phrases.*Use specific prose/u);
});

test("the pre-edit gate uses narration scope and reader text", (t) => {
  const f = fixture(t, "They wait.", [{ ...PHRASE, scope: "narration" }]);
  allowed(runHook("pre", f.edit("They wait.", '"They delve."')));
  denied(runHook("pre", f.edit("wait", "*delve*")), PHRASE, 0, 1);
  allowed(runHook("pre", f.edit("**POV:** Protagonist", "**POV:** delve")));
});

test("active allow rulings apply to the proposed passage and lapse when that passage changes", (t) => {
  const f = fixture(t, "They delve.\n\nThey wait.", [PHRASE]);
  const project = readProject(f.root);
  const finding = runRules(f.root, project).findings[0];
  // Restoring the passage is denied until an author ruling covers that passage.
  writeFileSync(f.path, sceneText("They wait.\n\nThey wait."));
  denied(runHook("pre", f.edit("They wait.", "They delve.")), PHRASE, 0, 1);
  mkdirSync(join(f.root, "continuity"), { recursive: true });
  writeFileSync(join(f.root, "continuity", "rulings.json"), JSON.stringify({ entries: [{
    finding_id: finding.id, kind: "rule", source: PHRASE.id, scene_id: "1-1", paragraph: 1,
    passage_sha256: sha256("They delve."), decision: "allow"
  }] }));
  assert.equal(runRules(f.root, project).blocking, 0);
  allowed(runHook("pre", f.edit("They wait.", "They delve.")));
  writeFileSync(f.path, sceneText("They delve.\n\nThey wait."));
  allowed(runHook("pre", f.edit("They wait.", "They pause.")));
  denied(runHook("pre", f.edit("They delve.", "They delve again.")), PHRASE, 0, 1);
});

test("allow rulings also suppress counting measurements", (t) => {
  const f = fixture(t, dashProse(9), [DASH]);
  const finding = runRules(f.root, readProject(f.root)).findings[0];
  mkdirSync(join(f.root, "continuity"), { recursive: true });
  writeFileSync(join(f.root, "continuity", "rulings.json"), JSON.stringify({ entries: [{
    finding_id: finding.id, kind: "rule", source: DASH.id, scene_id: "1-1", paragraph: 1,
    passage_sha256: sha256(dashProse(9)), decision: "allow"
  }] }));
  writeFileSync(f.path, sceneText(dashProse(1)));
  allowed(runHook("pre", f.edit(dashLine(1), dashLine(9))));
  writeFileSync(f.path, sceneText(dashProse(9)));
  const result = runRulesForScene(f.root, readProject(f.root), "1-1", readFileSync(f.path, "utf8"));
  assert.equal(result.blocking, 0);
  assert.deepEqual(result.measurements, []);
  assert.deepEqual(result.allowed_blocking, [finding.id]);
});

test("malformed edits, missing old strings, bad rules and missing projects fail open", (t) => {
  const f = fixture(t, "They wait.");
  const bad = [null, {}, { cwd: 42 }, f.payload("Write", {}), f.payload("Write", { content: 42 }),
    f.payload("Edit", { new_string: "delve" }), f.edit("absent", "delve"), f.edit("", "delve"),
    f.edit("wait", 42), f.edit("wait", "delve", { replace_all: "true" }),
    f.payload("MultiEdit", { edits: {} }), f.payload("MultiEdit", { edits: [null] }),
    f.payload("MultiEdit", { edits: [{ old_string: "wait", new_string: "delve" }, { old_string: "absent", new_string: "delve" }] }),
    f.payload("Write", { content: "no scene separators" })];
  for (const payload of bad) assert.equal(runHook("pre", payload), null, JSON.stringify(payload));
  const cli = spawnSync(process.execPath, [join(ROOT, "scripts", "weaver.mjs"), "hook", "pre"], { cwd: f.root, input: "not json", encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, "");
  writeFileSync(join(f.root, "quality", "rules.json"), JSON.stringify({ version: 1, rules: [{ ...PHRASE, type: "regex", pattern: "[" }] }));
  assert.equal(runHook("pre", f.edit("wait", "delve")), null);
  writeFileSync(join(f.root, "project.json"), "null");
  assert.equal(runHook("pre", f.edit("wait", "delve")), null);
  rmSync(join(f.root, "project.json"));
  assert.equal(runHook("pre", f.edit("wait", "delve")), null);
});

test("discrimination: an always-allow comparison lets the denied dash edit through", (t) => {
  const f = fixture(t, dashProse(1));
  const payload = f.edit(dashLine(1), dashLine(9));
  denied(runHook("pre", payload), DASH, 1, 9);
  let compared = false;
  allowed(runHook("pre", payload, { compareRules: (rules, before, after) => {
    compared = true;
    assert.equal(before.blocking, 0);
    assert.equal(after.blocking, 1);
    assert.equal(after.findings[0].count, 9);
    return null;
  } }));
  assert.equal(compared, true);
  assert.equal(runHook("pre", payload, { compareRules: () => { throw new Error("comparison failed"); } }), null);
});

test("in-memory scene rules match the disk runner, including chapter rules on the selected scene", (t) => {
  const rules = [DASH, { ...DASH, id: "chapter-dashes", unit: "chapter" }, PHRASE,
    { ...PHRASE, id: "dialogue-phrases", scope: "dialogue" },
    { id: "starts", type: "repeated-sentence-starts", max_run: 2, severity: "block", message: "Vary starts." },
    { id: "share", type: "sentence-start-share", word: "I", max_share: 0.5, min_sentences: 3, unit: "scene", severity: "block", message: "Vary starts." },
    { id: "digits", type: "regex", pattern: "\\d+", severity: "warn", message: "Spell out numbers." }];
  const f = fixture(t, 'I *delve* — again. I wait. I listen.\n\n"delve into 42 doors."', rules);
  const other = join(f.root, "manuscript", "chapter-01", "scene-02", "scene.md");
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(other, sceneText(dashProse(0, 10000)));
  const project = readProject(f.root);
  const disk = runRules(f.root, project, { sceneIds: ["1-1"] });
  const { measurements, ...memory } = runRulesForScene(f.root, project, "1-1", readFileSync(f.path, "utf8"));
  assert.deepEqual(memory, disk);
  assert.ok(measurements.length > 0);
  assert.ok(memory.findings.some((finding) => finding.rule_id === "chapter-dashes"));
  // A damaged unrelated scene must not disable the pre-edit check.
  writeFileSync(other, "broken scene");
  denied(runHook("pre", f.edit("I wait.", "I delve.")), PHRASE, 2, 3);
});
