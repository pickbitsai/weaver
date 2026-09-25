#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runDoctor } from "../engine/doctor.mjs";
import { initializeProject } from "../engine/init.mjs";
import { loadScenes, manuscriptHash } from "../engine/manuscript.mjs";
import { readProject } from "../engine/project.mjs";
import { buildRelease, runQualityChecks } from "../engine/release.mjs";
import { acceptNarrativeState, buildGroundingPacket, narrativeStateStatus } from "../engine/state.mjs";
import { GENERATOR } from "../engine/identity.mjs";

const argv = process.argv.slice(2);
const command = argv.shift() || "help";

function option(name, fallback = null) {
  const equals = argv.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function positional(index = 0) {
  const values = argv.filter((arg, current) => {
    if (arg.startsWith("--")) return false;
    if (current > 0 && argv[current - 1].startsWith("--") && !argv[current - 1].includes("=")) return false;
    return true;
  });
  return values[index];
}

function projectContext() {
  const root = resolve(option("--root", process.cwd()));
  return { root, project: readProject(root) };
}

function print(value) {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function doctorReport(root) {
  return runDoctor({ bookRoot: root });
}

function warnAboutDoctor(root) {
  const report = doctorReport(root);
  for (const finding of report.blocking) {
    process.stderr.write(`Warning: ${finding.problem}. ${finding.why} ${finding.fix}\n`);
  }
}

function refuseIfDoctorBlocks(root, command) {
  const report = doctorReport(root);
  if (report.ok) return false;
  const [first, ...rest] = report.blocking;
  print({
    error: first.problem,
    command,
    why: first.why,
    fix: first.fix,
    other_blocking: rest.map((finding) => finding.problem)
  });
  return true;
}

try {
  const root = resolve(option("--root", process.cwd()));
  if (command === "doctor") {
    const report = doctorReport(root);
    if (argv.includes("--json")) print(report);
    else {
      print(report.generator);
      for (const check of report.checks) {
        const symbol = check.status === "blocking" ? "✗" : check.status === "warning" ? "!" : "✓";
        print(`${symbol} ${check.title}`);
        for (const finding of check.findings) {
          if (check.status !== "pass") {
            print(`  Why: ${finding.why}`);
            print(`  Fix: ${finding.fix}`);
            if (finding.paths?.length) print(`  Files: ${finding.paths.join(", ")}`);
          }
        }
      }
    }
    if (!report.ok) process.exitCode = 1;
  } else if (command === "init") {
    const target = positional();
    if (!target) throw new Error("usage: weaver init <directory> [--id book-id] [--title \"Book Title\"]");
    const destination = initializeProject(target, {
      projectId: option("--id", "untitled-book"),
      title: option("--title", "Untitled Book")
    });
    print(destination);
    const gitCheck = doctorReport(destination).checks.find((check) => check.id === "git-available");
    if (gitCheck?.status === "blocking") {
      process.stderr.write("Git is required before Weaver can approve state or create a release.\n");
    }
  } else if (command === "status") {
    warnAboutDoctor(root);
    const { project } = projectContext();
    const scenes = loadScenes(root, project);
    const state = narrativeStateStatus(root, project);
    print({
      project_id: project.project_id,
      title: project.title,
      scenes: scenes.length,
      chapters: new Set(scenes.map((scene) => scene.chapter)).size,
      words: scenes.reduce((sum, scene) => sum + scene.words, 0),
      manuscript_sha256: manuscriptHash(scenes),
      narrative_state: {
        current: state.current,
        stale: state.stale,
        first_stale: state.first_stale
      }
    });
  } else if (command === "check") {
    warnAboutDoctor(root);
    const { project } = projectContext();
    const checks = runQualityChecks(root, project);
    const report = {
      ok: checks.ok,
      issues: checks.issues,
      scenes: checks.scenes.length,
      words: checks.scenes.reduce((sum, scene) => sum + scene.words, 0),
      critical_path: checks.criticalPath,
      unapproved_high_similarity_duplicates: checks.unapprovedDuplicates,
      narrative_state: checks.state
    };
    print(report);
    if (!checks.ok) process.exitCode = 1;
  } else if (command === "state:status") {
    warnAboutDoctor(root);
    const { project } = projectContext();
    print(narrativeStateStatus(root, project));
  } else if (command === "state:accept") {
    if (refuseIfDoctorBlocks(root, command)) process.exitCode = 1;
    else {
      const { project } = projectContext();
      print(acceptNarrativeState(root, project, option("--through")));
    }
  } else if (command === "grounding") {
    const sceneId = positional();
    if (!sceneId) throw new Error("usage: weaver grounding <scene-id> [--root directory] [--output file]");
    const output = option("--output");
    if (output && refuseIfDoctorBlocks(root, "grounding --output")) process.exitCode = 1;
    else {
      if (!output) warnAboutDoctor(root);
      const { project } = projectContext();
      const packet = buildGroundingPacket(root, project, sceneId);
      if (output) {
        const path = resolve(root, output);
        if (existsSync(path)) throw new Error(`refusing to overwrite grounding packet: ${path}`);
        writeFileSync(path, packet);
        print(path);
      } else print(packet);
    }
  } else if (command === "release") {
    const releaseId = option("--id");
    if (refuseIfDoctorBlocks(root, command)) process.exitCode = 1;
    else {
      const { project } = projectContext();
      if (!releaseId) throw new Error("usage: weaver release --id beta-01 [--root directory] [--force]");
      print(buildRelease(root, project, releaseId, { force: argv.includes("--force") }));
    }
  } else if (command === "version" || command === "--version") {
    warnAboutDoctor(root);
    print(GENERATOR);
  } else if (command === "help") {
    warnAboutDoctor(root);
    print(`${GENERATOR}: provenance-aware book pipeline

Usage:
  weaver init <directory> [--id book-id] [--title "Book Title"]
  weaver doctor [--root directory] [--json]
  weaver status [--root directory]
  weaver check [--root directory]
  weaver state:status [--root directory]
  weaver state:accept [--root directory] [--through scene-id]
  weaver grounding <scene-id> [--root directory] [--output file]
  weaver release --id beta-01 [--root directory] [--force]`);
  } else {
    print(`${GENERATOR}: provenance-aware book pipeline

Usage:
  weaver init <directory> [--id book-id] [--title "Book Title"]
  weaver doctor [--root directory] [--json]
  weaver status [--root directory]
  weaver check [--root directory]
  weaver state:status [--root directory]
  weaver state:accept [--root directory] [--through scene-id]
  weaver grounding <scene-id> [--root directory] [--output file]
  weaver release --id beta-01 [--root directory] [--force]`);
  }
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
