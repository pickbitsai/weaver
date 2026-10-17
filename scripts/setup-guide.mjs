#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATOR } from "../engine/identity.mjs";
import { classifySetup, renderSetupGuidance, gitRemotes, findHostsOnPath } from "../engine/setup-guide.mjs";

try {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") options.json = true;
    else if (["--root", "--tool"].includes(arg) && args[i + 1] && !args[i + 1].startsWith("--")) options[arg.slice(2)] = args[++i];
    else throw new Error(`Setup does not understand "${arg}". Use --root <book folder> [--tool <tool folder>] [--json].`);
  }
  if (!options.root) throw new Error("Setup needs --root <book folder>.");
  const root = resolve(options.root);
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const scope = dirname(packageRoot), modules = dirname(scope);
  const toolRoot = options.tool ? resolve(options.tool)
    : basename(packageRoot) === "weaver" && basename(scope) === "@pickbitsai" && basename(modules) === "node_modules" ? dirname(modules) : null;
  let project = {};
  try { project = JSON.parse(readFileSync(join(root, "project.json"), "utf8")) || {}; } catch { /* Doctor explains missing or unreadable books. */ }
  const result = spawnSync(process.execPath, [join(packageRoot, "scripts", "weaver.mjs"), "doctor", "--json", "--root", root],
    { encoding: "utf8", windowsHide: true, timeout: 120000 });
  let report;
  try { report = JSON.parse(result.stdout); } catch { /* A missing report becomes a plain problem below. */ }
  const guidance = report ? classifySetup({ report, project, remotes: gitRemotes(root), hostsOnPath: findHostsOnPath(), bookRoot: root, toolRoot })
    : { ok: false, steps: [], reminders: [], notes: [], problems: [{ id: "doctor", problem: "Weaver's health check could not run",
      why: (result.stderr || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "It gave no report.",
      fix: "Run setup again. If it keeps happening, contact PickBits." }] };
  const id = project.project_id || "(unknown)", title = project.title || "(unknown)";
  if (options.json) process.stdout.write(`${JSON.stringify({ ok: guidance.ok, generator: GENERATOR,
    book: { id, title, folder: root }, tool: { folder: toolRoot }, steps: guidance.steps, reminders: guidance.reminders,
    problems: guidance.problems, notes: guidance.notes }, null, 2)}\n`);
  else process.stdout.write(renderSetupGuidance(guidance, { generator: GENERATOR, title, id, bookRoot: root, toolRoot, guidePath: join(packageRoot, "docs", "START-HERE.md") }));
  process.exitCode = guidance.ok ? 0 : 1;
} catch (error) {
  process.stderr.write(`Setup stopped: ${String(error.message).replace(/[\r\n]+/g, " ")}\n`);
  process.exitCode = 1;
}
