#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { initializeProject } from "../engine/init.mjs";
import { loadScenes, manuscriptHash } from "../engine/manuscript.mjs";
import { readProject } from "../engine/project.mjs";
import { buildRelease, runQualityChecks } from "../engine/release.mjs";
import { acceptNarrativeState, buildGroundingPacket, narrativeStateStatus } from "../engine/state.mjs";

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

try {
  if (command === "init") {
    const target = positional();
    if (!target) throw new Error("usage: weaver init <directory> [--id book-id] [--title \"Book Title\"]");
    print(initializeProject(target, {
      projectId: option("--id", "untitled-book"),
      title: option("--title", "Untitled Book")
    }));
  } else if (command === "status") {
    const { root, project } = projectContext();
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
    const { root, project } = projectContext();
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
    const { root, project } = projectContext();
    print(narrativeStateStatus(root, project));
  } else if (command === "state:accept") {
    const { root, project } = projectContext();
    print(acceptNarrativeState(root, project, option("--through")));
  } else if (command === "grounding") {
    const sceneId = positional();
    if (!sceneId) throw new Error("usage: weaver grounding <scene-id> [--root directory] [--output file]");
    const { root, project } = projectContext();
    const packet = buildGroundingPacket(root, project, sceneId);
    const output = option("--output");
    if (output) {
      const path = resolve(root, output);
      if (existsSync(path)) throw new Error(`refusing to overwrite grounding packet: ${path}`);
      writeFileSync(path, packet);
      print(path);
    } else {
      print(packet);
    }
  } else if (command === "release") {
    const { root, project } = projectContext();
    const releaseId = option("--id");
    if (!releaseId) throw new Error("usage: weaver release --id beta-01 [--root directory] [--force]");
    print(buildRelease(root, project, releaseId, { force: argv.includes("--force") }));
  } else {
    print(`Weaver

Usage:
  weaver init <directory> [--id book-id] [--title "Book Title"]
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
