// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { makeBook, first } from "./helpers/book.mjs";
import { authorEnv } from "./helpers/env.mjs";
import { runHook, installHooks, CODEX_HOOK_COMMANDS } from "../engine/hooks.mjs";
import { runHost, hostConfig, withHost } from "../engine/host.mjs";
import { runBook } from "../engine/run.mjs";
import { runDoctor } from "../engine/doctor.mjs";
import { applyCodexHunks, parseCodexPatch } from "../engine/codex-patch.mjs";
import { compareBookSettings, sealBookSettings } from "../engine/guard.mjs";
import { validateProject } from "../engine/project.mjs";
import { repairChapter } from "../engine/repair.mjs";

const scene = "manuscript/chapter-01/scene-01/scene.md";
const quiet = () => {};
const denied = (value) => value?.hookSpecificOutput?.permissionDecision === "deny";
const payload = (root, command, tool_name = "apply_patch") => ({ session_id: "synthetic", turn_id: "turn", tool_use_id: "call", hook_event_name: "PreToolUse", cwd: root, tool_name, tool_input: { command } });
const patch = (before, after) => `*** Begin Patch\n*** Update File: ${scene}\n@@\n-${before}\n+${after}\n*** End Patch\n`;
function status(root, trustStatus = "trusted") {
  return { available: true, loggedIn: true, chatgpt: true, config: { hooksEnabled: true }, hooks: { hooks: [CODEX_HOOK_COMMANDS.pre, CODEX_HOOK_COMMANDS.post, CODEX_HOOK_COMMANDS.shell].map((command) => ({ command, sourcePath: join(root, ".codex", "hooks.json"), enabled: true, trustStatus })) } };
}

test("Codex patches protect every operation and move destination before parsing hunks", (t) => {
  const { root } = makeBook(t);
  for (const path of [".codex/config.toml", ".codex/rules/other.rules", "quality/rules.json", "../outside.md", "notes/run.mjs", "notes/run.ps1"]) {
    for (const operation of ["Update", "Add", "Delete"]) assert.ok(denied(runHook("pre", payload(root, `*** Begin Patch\n*** ${operation} File: ${path}\n@@\ninvalid\n*** End Patch`))), `${operation} ${path}`);
    for (const header of ["Move to", "Move File"]) assert.ok(denied(runHook("pre", payload(root, `*** Begin Patch\n*** Update File: notes.md\n*** ${header}: ${path}\n@@\n-old\n+new\n*** End Patch`))), path);
  }
  assert.equal(denied(runHook("pre", payload(root, "*** Begin Patch\n*** Add File: notes.md\n+A note.\n*** End Patch"))), false);
  assert.equal(denied(runHook("pre", payload(root, "*** Begin Patch\n*** Delete File: notes.md\n*** End Patch"))), false);
  const badThenGood = "*** Begin Patch\n*** Update File: notes.md\n*** Move to: project.json\n*** Move to: safe.md\n@@\n-x\n+y\n*** End Patch";
  assert.ok(denied(runHook("pre", payload(root, badThenGood))));
});

test("Codex pre-edit gate reduces a violation, rejects additions, handles multiple hunks and fails open on unmatched hunks", (t) => {
  const { root, paths } = makeBook(t);
  const current = readFileSync(paths[0], "utf8");
  const allowed = patch(first, first.replace("murky", "clear"));
  assert.equal(denied(runHook("pre", payload(root, allowed))), false);
  const worse = patch(first, first.replace("murky", "murky murky"));
  assert.ok(denied(runHook("pre", payload(root, worse))));
  assert.ok(denied(runHook("pre", payload(root, patch(first, first.replace("murky", "forbidden"))))));
  assert.equal(denied(runHook("pre", payload(root, patch("unmatched line", "murky murky")))), false);
  const multi = allowed.replace("*** End Patch", "*** Update File: manuscript/chapter-01/scene-02/scene.md\n@@\n-Rill crosses the narrow bridge before sunrise.\n+Rill crosses the forbidden bridge before sunrise.\n*** End Patch");
  assert.ok(denied(runHook("pre", payload(root, multi))), "all scenes must be checked");
  assert.equal(readFileSync(paths[0], "utf8"), current, "pre-hook must not write");
  assert.equal(applyCodexHunks("one\r\ntwo\r\nthree\r\n", parseCodexPatch("*** Update File: notes.md\n@@\n-one\n+first\n@@ two\n-three\n+last\n*** End of File\n*** End Patch")[0]), "first\r\ntwo\r\nlast\r\n");
  const sub = join(root, "manuscript");
  assert.ok(denied(runHook("pre", payload(sub, worse.replace(scene, "chapter-01/scene-01/scene.md")))));
});

test("Codex post hook reports remaining blocking findings and warning context", (t) => {
  const { root } = makeBook(t);
  const input = { ...payload(root, patch(first, first)), hook_event_name: "PostToolUse", tool_response: "Success" };
  assert.match(runHook("post", input).reason, /murky[\s\S]*fix these before continuing/u);
  writeFileSync(join(root, "quality", "rules.json"), JSON.stringify({ version: 1, rules: [{ id: "murky", type: "phrase-list", severity: "warn", phrases: ["murky"], message: "Check this word." }] }));
  assert.match(runHook("post", input).hookSpecificOutput.additionalContext, /Check this word/u);
});

test("discrimination: both hosts use the shared edit, shell and blocking-rule decisions", (t) => {
  const { root } = makeBook(t);
  for (const input of [payload(root, "git commit -am change", "Bash"), { cwd: root, tool_name: "PowerShell", tool_input: { command: "git commit -am change" } }]) {
    assert.ok(denied(runHook("shell", input)));
    assert.equal(runHook("shell", input, { decideShell: () => null }), null);
  }
  for (const input of [payload(root, "*** Begin Patch\n*** Delete File: project.json\n*** End Patch"), { cwd: root, tool_name: "Write", tool_input: { file_path: "project.json", content: "{}" } }]) {
    assert.ok(denied(runHook("pre", input)));
    assert.equal(denied(runHook("pre", input, { decideEdit: () => null })), false);
  }
  for (const input of [payload(root, patch(first, first + " forbidden")), { cwd: root, tool_name: "Edit", tool_input: { file_path: scene, old_string: first, new_string: first + " forbidden" } }]) {
    assert.ok(denied(runHook("pre", input)));
    assert.equal(denied(runHook("pre", input, { compareRules: () => null })), false);
  }
});

test("Codex adapter reads only -o, strips billing keys, sets effort and cleans temporary output", async (t) => {
  const { root } = makeBook(t);
  for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY"]) {
    const saved = process.env[name]; process.env[name] = "synthetic-not-a-key";
    t.after(() => { if (saved === undefined) delete process.env[name]; else process.env[name] = saved; });
  }
  const project = { host: { kind: "codex", reasoning_effort: "high", timeout_seconds: 10 } };
  const result = await runHost(root, project, "synthetic prompt");
  assert.equal(result.ok, true, result.error);
  assert.equal(result.text, "Answer from -o: synthetic prompt");
  const call = JSON.parse(readFileSync(join(root, ".weaver/codex-call.json"), "utf8"));
  assert.deepEqual(call.keys, []);
  assert.ok(call.args.includes("model_reasoning_effort=high"));
  assert.ok(call.args.includes("forced_login_method=chatgpt"));
  assert.equal(existsSync(call.args[call.args.indexOf("-o") + 1]), false);
  project.host.args = ["--fake-mode", "missing-output"];
  const missing = await runHost(root, project, "ignored logs", { attempts: 1 });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /empty output/u);
  assert.equal(hostConfig({}).kind, "claude");
  assert.equal(hostConfig({ host: { kind: "codex" } }).reasoning_effort, "medium");
  assert.equal(withHost({ host: { command: "custom-claude", args: ["-p"] } }, "codex").host.command, undefined);
  assert.throws(() => withHost({}, "other"), /Choose/u);
  assert.ok(validateProject({ host: { kind: "other" }, hosts: ["other"] }).some((error) => error.includes("host.kind")));
});

test("Codex whole-book execution retries timeouts and carries packets through reviews and repairs", async (t) => {
  const { root, project } = makeBook(t);
  // Two process starts per call (fake codex, then the fixture): give an ordinary call room under load.
  // The fixture's timed-out calls sleep 6 s, so a 5 s budget still times them out every time.
  project.host = { kind: "codex", args: ["--fixture", "proposal", "--fake-mode", "timeouts"], timeout_seconds: 5 };
  const waits = [];
  project.run.retry.delays_seconds = [30, 120];
  const result = await runBook(root, project, { run: true, onProgress: quiet, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(waits, [30000, 120000]);
  assert.equal(result.units.find((unit) => unit.unit === "scene 1-1").attempts, 3);
  assert.deepEqual(result.summary.failures, []);
  assert.equal(result.summary.proposals_ready, 1);
  assert.equal(result.summary.reviews_run, 6);
});

test("Codex malformed packet answers receive the same validation repair round", async (t) => {
  const { root, project } = makeBook(t);
  project.host = { kind: "codex", args: ["--fixture", "proposal", "--fake-mode", "malformed"], timeout_seconds: 10 };
  const result = await repairChapter(root, project, { chapter: 1, run: true, onProgress: quiet });
  assert.equal(result.status, "ready");
  const calls = JSON.parse(readFileSync(join(root, ".weaver/proposal-host-calls.json"), "utf8"));
  assert.equal(calls.length, 2, "malformed answer must require a corrective host call");
  assert.match(readFileSync(join(root, ".weaver/last-repair-prompt.txt"), "utf8"), /previous answer failed validation/u);
});

test("doctor distinguishes hosts, missing rules, hook trust, login and Windows read-only edits", (t) => {
  const { root, project } = makeBook(t);
  const doctor = (codexStatus = status(root)) => runDoctor({ bookRoot: root, codexStatus, platform: "win32" });
  assert.equal(doctor().guardrails.codex.on, true);
  const untrusted = doctor(status(root, "untrusted"));
  assert.equal(untrusted.guardrails.codex.on, false);
  assert.ok(untrusted.blocking.some((finding) => finding.id === "guardrails-installed"));
  assert.match(untrusted.warnings.find((finding) => finding.id === "codex-hook-trust").fix, /\/hooks/u);
  const background = status(root); background.hooks.hooks[0].async = true;
  assert.equal(doctor(background).guardrails.codex.on, false, "background hooks cannot deny edits");
  rmSync(join(root, ".codex/rules/weaver.rules"));
  assert.match(doctor().guardrails.codex.problems[0], /weaver.rules/u);
  project.hosts = ["claude"];
  writeFileSync(join(root, "project.json"), JSON.stringify(project));
  assert.equal(doctor().blocking.some((finding) => finding.id === "guardrails-installed"), false);
  installHooks(root);
  project.hosts = ["codex"];
  writeFileSync(join(root, "project.json"), JSON.stringify(project));
  rmSync(join(root, ".claude/settings.json"));
  assert.equal(doctor().ok, true);
  const mode = status(root); mode.config.sandboxMode = "read-only"; mode.loggedIn = false;
  assert.match(doctor(mode).warnings.find((finding) => finding.id === "codex-windows-sandbox").fix, /workspace-write/u);
  assert.match(doctor(mode).warnings.find((finding) => finding.id === "codex-available").problem, /not logged in/u);
});

test("both-host install merges, is byte-identical, keeps global config untouched and seals Codex", (t) => {
  const { root, project } = makeBook(t);
  const path = join(root, ".codex/hooks.json");
  const settings = JSON.parse(readFileSync(path, "utf8"));
  settings.hooks.Stop = [{ hooks: [{ type: "command", command: "unrelated" }] }];
  writeFileSync(path, JSON.stringify(settings));
  const rulesPath = join(root, ".codex/rules/weaver.rules");
  writeFileSync(rulesPath, readFileSync(rulesPath, "utf8") + 'prefix_rule(pattern=["custom"], decision="prompt")\n');
  const codexHome = join(root, "synthetic-home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), "# unrelated\n");
  installHooks(root, { host: "both", codexHome });
  assert.equal(existsSync(join(codexHome, "rules")), false);
  const files = [".claude/settings.json", ".codex/hooks.json", ".codex/rules/weaver.rules"];
  const before = files.map((file) => readFileSync(join(root, file), "utf8"));
  assert.equal(installHooks(root, { host: "both", codexHome }).changed, false);
  assert.deepEqual(files.map((file) => readFileSync(join(root, file), "utf8")), before);
  assert.equal(JSON.parse(before[1]).hooks.Stop[0].hooks[0].command, "unrelated");
  assert.match(before[2], /pattern=\["custom"\]/u);
  installHooks(root, { host: "codex", userRules: true, codexHome });
  assert.ok(existsSync(join(codexHome, "rules/weaver.rules")));
  assert.equal(readFileSync(join(codexHome, "config.toml"), "utf8"), "# unrelated\n");
  sealBookSettings(root, project);
  writeFileSync(join(root, ".codex/config.toml"), "[features]\nhooks = false\n");
  assert.equal(compareBookSettings(root).status, "blocking");
});

test("CLI hook and per-run Codex override work without changing project settings", (t) => {
  const { root, project } = makeBook(t);
  const cli = resolve("scripts/weaver.mjs");
  const input = payload(root, patch(first, first + " forbidden"));
  const hook = spawnSync(process.execPath, [cli, "hook", "pre", "--host", "codex"], { cwd: root, input: JSON.stringify(input), encoding: "utf8" });
  assert.ok(denied(JSON.parse(hook.stdout)), hook.stderr);
  const before = readFileSync(join(root, "project.json"), "utf8");
  // Packet-only calls exercise the override parser without invoking a live model.
  for (const args of [["run", "--book"], ["review", "--chapter", "1"], ["repair", "--chapter", "1"], ["state", "bootstrap"]]) {
    const result = spawnSync(process.execPath, [cli, ...args, "--host", "codex", "--root", root], { env: authorEnv(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.equal(readFileSync(join(root, "project.json"), "utf8"), before);
  assert.equal(project.host.kind, undefined);
});
