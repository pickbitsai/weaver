#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runDoctor } from "../engine/doctor.mjs";
import { initializeProject } from "../engine/init.mjs";
import { loadScenes, manuscriptHash } from "../engine/manuscript.mjs";
import { readProject } from "../engine/project.mjs";
import { buildRelease, runQualityChecks } from "../engine/release.mjs";
import { DEFAULT_CHAPTER_PATTERN, importBook } from "../engine/import.mjs";
import { exportBook } from "../engine/export.mjs";
import { acceptNarrativeState, buildGroundingPacket, narrativeStateStatus } from "../engine/state.mjs";
import { GENERATOR } from "../engine/identity.mjs";
import { installHooks, runHook } from "../engine/hooks.mjs";
import { runRules } from "../engine/rules.mjs";
import { approveChapter, approvalHistory, describePendingChanges, pendingChanges, recordImportBaseline, rejectChapter, undoApproval } from "../engine/changes.mjs";
import { seedCharacters } from "../engine/characters.mjs";
import { buildVoiceProfiles, runVoiceCheck } from "../engine/voice.mjs";

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

function pendingSummary(report) {
  if (!report.pending) return "No scene changes are waiting for approval.";
  return report.chapters.map((chapter) => {
    const findingLabel = `${chapter.blocking} blocking style finding${chapter.blocking === 1 ? "" : "s"}`;
    return `Chapter ${chapter.chapter}: ${chapter.scenes_changed} scene${chapter.scenes_changed === 1 ? "" : "s"} changed, +${chapter.words_added} / −${chapter.words_removed} words, ${findingLabel}`;
  }).join("\n");
}

function importedPovNames(root, project) {
  const names = [];
  const sourcePov = project.source_book?.pov;
  if (typeof sourcePov === "string") names.push(sourcePov);
  if (Array.isArray(sourcePov)) names.push(...sourcePov);
  const scenesRoot = resolve(root, project.source_root);
  function walk(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name === "scene.md") {
        const pov = readFileSync(path, "utf8").match(/^\*\*POV:\*\*\s*(.+?)\s*$/mu)?.[1];
        if (pov) names.push(pov);
      }
    }
  }
  walk(scenesRoot);
  return names;
}

function voiceFindingText(finding) {
  const evidence = finding.evidence.map((line) => `  - ${line.text} [${line.scene_id}, paragraph ${line.paragraph}]`).join("\n");
  const sounds = finding.maybe_sounds_like
    ? `\n  Maybe sounds like ${finding.maybe_sounds_like.character}:\n${finding.maybe_sounds_like.evidence.map((line) => `  - ${line.text} [${line.scene_id}, paragraph ${line.paragraph}]`).join("\n")}`
    : "";
  const reasons = finding.reasons?.length ? `\n  Reasons:\n${finding.reasons.map((reason) => `  - ${reason}`).join("\n")}` : "";
  return `voice warn: ${finding.scene_id}, paragraph ${finding.paragraph}, ${finding.speaker}: ${finding.reason}${reasons}\n  Line: ${finding.line}\n  Typical lines:\n${evidence}${sounds}`;
}

function importOmissionsSummary(notImported = {}) {
  const comments = Number(notImported.comments || 0);
  const footnotes = Number(notImported.footnotes || 0) + Number(notImported.endnotes || 0);
  const plural = (count, singular) => `${count} ${singular}${count === 1 ? "" : "s"}`;
  return `Not imported: ${plural(comments, "comment")}, ${plural(footnotes, "footnote")}.`;
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

function refuseIfDoctorBlocks(root, command, { allowHookInstall = false } = {}) {
  const report = doctorReport(root);
  const blocking = allowHookInstall
    ? report.blocking.filter((finding) => finding.id !== "hooks-installed")
    : report.blocking;
  if (!blocking.length) return false;
  const [first, ...rest] = blocking;
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
      title: option("--title", "Untitled Book"),
      empty: argv.includes("--empty")
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
        narrative_state: checks.state,
        rules: { blocking: checks.rules.blocking, warnings: checks.rules.warnings },
        voices: { warnings: checks.voices.warnings, stale_profiles: checks.voices.stale_profiles }
      };
    print(report);
    if (!checks.ok) process.exitCode = 1;
  } else if (command === "rules") {
    warnAboutDoctor(root);
    const { project } = projectContext();
    const selectedScene = option("--scene");
    const result = runRules(root, project, { sceneIds: selectedScene ? [selectedScene] : null });
    if (argv.includes("--json")) print(result);
    else if (!result.findings.length) print("No style rule findings.");
    else {
      let currentScene = null;
      let currentRule = null;
      for (const finding of result.findings) {
        if (finding.scene_id !== currentScene) {
          currentScene = finding.scene_id;
          currentRule = null;
          print(`Scene ${finding.scene_id}`);
        }
        if (finding.rule_id !== currentRule) {
          currentRule = finding.rule_id;
          print(`  ${finding.rule_id}`);
        }
        print(`    ${finding.severity}: paragraph ${finding.paragraph}: ${finding.excerpt} — ${finding.message}`);
      }
      print(`\n${result.blocking} blocking, ${result.warnings} warning(s); ${result.rules_checked} rule(s) checked.`);
    }
    if (result.blocking) process.exitCode = 1;
  } else if (command === "changes") {
    const { project } = projectContext();
    const report = describePendingChanges(root, project);
    if (argv.includes("--json")) print(report);
    else print(pendingSummary(report));
  } else if (command === "approve") {
    if (refuseIfDoctorBlocks(root, command)) process.exitCode = 1;
    else {
      const { project } = projectContext();
      const chapterOption = option("--chapter");
      const result = approveChapter(root, project, chapterOption == null ? null : Number(chapterOption), option("--note", ""));
      print(`Approval ${result.id}: Chapter ${result.chapter} approved.`);
    }
  } else if (command === "reject") {
    if (refuseIfDoctorBlocks(root, command)) process.exitCode = 1;
    else {
      const { project } = projectContext();
      const chapterOption = option("--chapter");
      const result = rejectChapter(root, project, chapterOption == null ? null : Number(chapterOption));
      print(`Rejected Chapter ${result.chapter}. The rejected text was saved in ${result.path}.`);
    }
  } else if (command === "undo") {
    if (refuseIfDoctorBlocks(root, command)) process.exitCode = 1;
    else {
      const result = undoApproval(root);
      print(`Undo ${result.id}: the most recent approval was reversed.`);
    }
  } else if (command === "history") {
    const history = approvalHistory(root);
    if (argv.includes("--json")) print(history);
    else if (!history.length) print("No approvals or undos yet.");
    else print(history.map((entry) => `${entry.date} Chapter ${entry.chapter}: ${entry.note || "(no note)"} (${entry.type === "approval" ? "Approval" : entry.type === "undo" ? "Undo" : "Rejection"} ${entry.id})`).join("\n"));
  } else if (command === "hooks" && positional() === "install") {
    if (refuseIfDoctorBlocks(root, command, { allowHookInstall: true })) process.exitCode = 1;
    else {
      const result = installHooks(root);
      print(`${result.changed ? (result.created ? "Created" : "Updated") : "Already installed"} ${result.path}`);
    }
  } else if (command === "hook" && ["pre", "post"].includes(positional())) {
    // Hook processes are intentionally fail-open: malformed input and broken books never stop an edit.
    try {
      const payload = JSON.parse(readFileSync(0, "utf8"));
      const output = runHook(positional(), payload);
      if (output) print(output);
    } catch {
      // A broken guard must never stop an author's edit.
    }
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
  } else if (command === "import") {
    const source = positional();
    if (!source) throw new Error("usage: weaver import <source> [--root directory] [--pov title|none] [--chapter-pattern regex]");
    if (refuseIfDoctorBlocks(root, command)) process.exitCode = 1;
    else {
      const { project } = projectContext();
      const result = importBook(root, project, source, {
        povRule: option("--pov", "title"),
        chapterPattern: option("--chapter-pattern", DEFAULT_CHAPTER_PATTERN)
      });
      const baseline = recordImportBaseline(root, result.project, result.record, result.importPath);
      if (argv.includes("--json")) print({ ...result.record, baseline });
      else {
        print(`Imported ${result.record.totals.chapters} chapter(s), ${result.record.totals.scenes} scene(s), ${result.record.totals.words} word(s).`);
        print(importOmissionsSummary(result.record.not_imported));
        for (const chapter of result.record.chapters) print(`Chapter ${chapter.number}: ${chapter.title || "(untitled)"} — POV ${chapter.pov || "(none)"}`);
        print(`Saved your original as the starting point (Approval ${baseline.id}). Repairs are reviewed against it, one chapter at a time.`);
      }
    }
  } else if (command === "export") {
    if (refuseIfDoctorBlocks(root, command)) process.exitCode = 1;
    else {
      const { project } = projectContext();
      print(exportBook(root, project, option("--format"), option("--out")));
    }
  } else if (command === "characters" && positional() === "seed") {
    if (refuseIfDoctorBlocks(root, command)) process.exitCode = 1;
    else {
      const { project } = projectContext();
      const result = seedCharacters(root, importedPovNames(root, project));
      if (argv.includes("--json")) print(result);
      else print(result.added.length
        ? `Added ${result.added.length} character entr${result.added.length === 1 ? "y" : "ies"} to ${result.path}.`
        : `No new POV characters found; registry unchanged at ${result.path}.`);
    }
  } else if (command === "voices" && positional() === "build") {
    if (refuseIfDoctorBlocks(root, command)) process.exitCode = 1;
    else {
      const { project } = projectContext();
      const result = buildVoiceProfiles(root, project);
      if (argv.includes("--json")) print(result);
      else print(`Built ${result.profiles.length} voice profile(s) from manuscript ${result.manuscript_sha256}.`);
    }
  } else if (command === "voices" && positional() === "check") {
    const { project } = projectContext();
    const selectedScene = option("--scene");
    const pending = argv.includes("--pending") ? pendingChanges(root, project) : null;
    const result = runVoiceCheck(root, project, {
      sceneIds: selectedScene ? [selectedScene] : null,
      pendingScenes: pending?.scenes || null
    });
    if (argv.includes("--json")) print(result);
    else {
      for (const name of result.stale_profiles) print(`Warning: voice profiles are out of date, run weaver voices build (${name}).`);
      for (const note of result.notes) print(`Note: ${note.scene_id}, paragraph ${note.paragraph}, ${note.speaker}: ${note.message}`);
      if (!result.findings.length && !result.notes.length) print("No voice warnings.");
      for (const finding of result.findings) print(voiceFindingText(finding));
      print(`\n${result.warnings} voice warning(s).`);
    }
  } else if (command === "version" || command === "--version") {
    print(GENERATOR);
  } else if (command === "help") {
    warnAboutDoctor(root);
    print(`${GENERATOR}: provenance-aware book pipeline

Usage:
  weaver init <directory> [--id book-id] [--title "Book Title"] [--empty]
  weaver doctor [--root directory] [--json]
  weaver status [--root directory]
  weaver check [--root directory]
  weaver rules [--root directory] [--scene scene-id] [--json]
  weaver characters seed [--root directory] [--json]
  weaver voices build [--root directory] [--json]
  weaver voices check [--scene scene-id | --pending] [--root directory] [--json]
  weaver changes [--root directory] [--json]
  weaver approve [--chapter number] [--note "text"] [--root directory]
  weaver reject [--chapter number] [--root directory]
  weaver undo [--root directory]
  weaver history [--root directory] [--json]
  weaver hooks install [--root directory]
  weaver state:status [--root directory]
  weaver state:accept [--root directory] [--through scene-id]
  weaver grounding <scene-id> [--root directory] [--output file]
  weaver release --id beta-01 [--root directory] [--force]
  weaver import <source> [--root directory] [--pov title|none] [--chapter-pattern regex] [--json]
  weaver export --format md|docx --out <file> [--root directory]`);
  } else {
    print(`${GENERATOR}: provenance-aware book pipeline

Usage:
  weaver init <directory> [--id book-id] [--title "Book Title"] [--empty]
  weaver doctor [--root directory] [--json]
  weaver status [--root directory]
  weaver check [--root directory]
  weaver rules [--root directory] [--scene scene-id] [--json]
  weaver characters seed [--root directory] [--json]
  weaver voices build [--root directory] [--json]
  weaver voices check [--scene scene-id | --pending] [--root directory] [--json]
  weaver changes [--root directory] [--json]
  weaver approve [--chapter number] [--note "text"] [--root directory]
  weaver reject [--chapter number] [--root directory]
  weaver undo [--root directory]
  weaver history [--root directory] [--json]
  weaver hooks install [--root directory]
  weaver state:status [--root directory]
  weaver state:accept [--root directory] [--through scene-id]
  weaver grounding <scene-id> [--root directory] [--output file]
  weaver release --id beta-01 [--root directory] [--force]
  weaver import <source> [--root directory] [--pov title|none] [--chapter-pattern regex] [--json]
  weaver export --format md|docx --out <file> [--root directory]`);
  }
} catch (error) {
  // Authors read this output: say what went wrong in plain words, never a stack trace.
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
}
