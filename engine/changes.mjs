// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { countWords, extractProse } from "./manuscript.mjs";
import { runRules } from "./rules.mjs";
import { GENERATOR } from "./identity.mjs";
import { buildVoiceProfiles, runVoiceCheck } from "./voice.mjs";

const SCENE_PATH = /^chapter-(\d+)\/scene-(\d+)\/scene\.md$/u;

function git(root, args, options = {}) {
  return spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    ...options
  });
}

function hasHead(root) {
  return git(root, ["rev-parse", "--verify", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).status === 0;
}

function parseStatus(output) {
  const records = [];
  const parts = output ? output.split("\0") : [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const firstPath = entry.slice(3);
    if (!firstPath) continue;
    const paths = [firstPath];
    if (status.includes("R") || status.includes("C")) {
      if (parts[index + 1]) paths.push(parts[++index]);
    }
    for (const path of paths) records.push({ status, path: path.replaceAll("\\", "/") });
  }
  return records;
}

function statusRecords(root, project, { allFiles = false } = {}) {
  const args = ["status", "--porcelain=v1", "-z", "-uall"];
  if (!allFiles) args.push("--", project.source_root);
  const result = git(root, args, { stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`could not read the book's Git changes: ${(result.stderr || "").trim()}`);
  return parseStatus(result.stdout);
}

function sceneRecord(path, status, root, project, headExists) {
  const sourceRelative = relative(resolve(root, project.source_root), resolve(root, path)).replaceAll("\\", "/");
  const match = SCENE_PATH.exec(sourceRelative);
  if (!match) return null;
  const relativePath = join(project.source_root, sourceRelative).replaceAll("\\", "/");
  const absolute = resolve(root, relativePath);
  const beforeText = headExists ? gitShow(root, relativePath) : null;
  const afterText = existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  const beforeProse = beforeText === null ? "" : extractProse(beforeText, relativePath);
  const afterProse = afterText === null ? "" : extractProse(afterText, relativePath);
  const before = countWords(beforeProse);
  const after = countWords(afterProse);
  return {
    id: `${Number(match[1])}-${Number(match[2])}`,
    chapter: Number(match[1]),
    scene: Number(match[2]),
    path: relativePath,
    absolute,
    status,
    before,
    after,
    delta: after - before,
    beforeProse,
    afterProse,
    deleted: afterText === null,
    untracked: status.trim() === "??"
  };
}

function gitShow(root, path) {
  const result = git(root, ["show", `HEAD:${path}`], { stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout : null;
}

export function pendingChanges(root, project) {
  const headExists = hasHead(root);
  const records = statusRecords(root, project);
  const scenes = records
    .map((record) => sceneRecord(record.path, record.status, root, project, headExists))
    .filter(Boolean)
    .sort((a, b) => a.chapter - b.chapter || a.scene - b.scene || a.path.localeCompare(b.path));
  const unique = new Map();
  for (const scene of scenes) unique.set(scene.path, scene);
  const changedScenes = [...unique.values()];
  const chapters = new Map();
  for (const scene of changedScenes) {
    if (!chapters.has(scene.chapter)) chapters.set(scene.chapter, []);
    chapters.get(scene.chapter).push(scene);
  }
  return {
    headExists,
    files: records.map((record) => record.path),
    scenes: changedScenes,
    chapters: [...chapters.entries()].sort((a, b) => a[0] - b[0]).map(([chapter, chapterScenes]) => ({ chapter, scenes: chapterScenes }))
  };
}

function chapterFindings(root, project, pending) {
  if (!pending.scenes.length) return new Map();
  const available = pending.scenes.filter((scene) => !scene.deleted).map((scene) => scene.id);
  if (!available.length) return new Map();
  const result = runRules(root, project, { sceneIds: available });
  const voice = runVoiceCheck(root, project, { sceneIds: available });
  const byScene = new Map();
  byScene.allowed_blocking = result.allowed_blocking;
  for (const finding of result.findings) {
    if (!byScene.has(finding.scene_id)) byScene.set(finding.scene_id, []);
    byScene.get(finding.scene_id).push(finding);
  }
  for (const finding of voice.findings) {
    if (!byScene.has(finding.scene_id)) byScene.set(finding.scene_id, []);
    byScene.get(finding.scene_id).push(finding);
  }
  return byScene;
}

export function describePendingChanges(root, project) {
  const pending = pendingChanges(root, project);
  const findings = chapterFindings(root, project, pending);
  const chapters = pending.chapters.map(({ chapter, scenes }) => {
    const changed = scenes.map((scene) => ({
      id: scene.id,
      chapter: scene.chapter,
      scene: scene.scene,
      path: scene.path,
      status: scene.status,
      words_before: scene.before,
      words_after: scene.after,
      words_delta: scene.delta,
      findings: findings.get(scene.id) || []
    }));
    const allFindings = changed.flatMap((scene) => scene.findings);
    const added = changed.reduce((sum, scene) => sum + Math.max(scene.words_delta, 0), 0);
    const removed = changed.reduce((sum, scene) => sum + Math.max(-scene.words_delta, 0), 0);
    return {
      chapter,
      scenes_changed: changed.length,
      words_before: changed.reduce((sum, scene) => sum + scene.words_before, 0),
      words_after: changed.reduce((sum, scene) => sum + scene.words_after, 0),
      words_added: added,
      words_removed: removed,
      blocking: allFindings.filter((finding) => finding.severity === "block").length,
      warnings: allFindings.filter((finding) => finding.severity === "warn").length,
      voice_warnings: allFindings.filter((finding) => finding.type === "voice").length,
      scenes: changed
    };
  });
  return { pending: chapters.length > 0, chapters, files: pending.files };
}

export function otherPendingChapters(root, project, chapter) {
  return pendingChanges(root, project).chapters
    .map((entry) => entry.chapter)
    .filter((value) => value !== Number(chapter));
}

function writeFooter(path, words) {
  const raw = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const separators = lines.flatMap((line, index) => line.trim() === "---" ? [index] : []);
  if (separators.length < 2) throw new Error(`${path}: expected metadata and footer separators`);
  const footerStart = separators.at(-1) + 1;
  const footer = lines.slice(footerStart).join("\n");
  const updatedFooter = /\*\*Words:\*\*\s*\d+/u.test(footer)
    ? footer.replace(/\*\*Words:\*\*\s*\d+/u, `**Words:** ${words}`)
    : `\n**Words:** ${words}${footer}`;
  if (updatedFooter !== footer) {
    lines.splice(footerStart, lines.length - footerStart, ...updatedFooter.split("\n"));
    writeFileSync(path, lines.join("\n"));
  }
}

function gitStatusAll(root) {
  const result = git(root, ["status", "--porcelain=v1", "-z", "-uall"], { stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`could not read the book's Git changes: ${(result.stderr || "").trim()}`);
  return parseStatus(result.stdout);
}

export function ensureIdentity(root, project) {
  const name = git(root, ["config", "--get", "user.name"], { stdio: ["ignore", "pipe", "ignore"] });
  const email = git(root, ["config", "--get", "user.email"], { stdio: ["ignore", "pipe", "ignore"] });
  if (name.status !== 0 || !name.stdout.trim()) {
    const result = git(root, ["config", "--local", "user.name", project.author?.trim() || "Author"], { stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) throw new Error("could not set the book's local Git author name");
  }
  if (email.status !== 0 || !email.stdout.trim()) {
    const result = git(root, ["config", "--local", "user.email", "author@weaver.local"], { stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) throw new Error("could not set the book's local Git author email");
  }
}

function formatChapter(chapter) {
  return `Chapter ${chapter}`;
}

export function approveChapter(root, project, chapter = null, note = "") {
  const pending = pendingChanges(root, project);
  if (!pending.scenes.length) throw new Error("There are no scene changes waiting for approval.");
  const chapters = pending.chapters.map((entry) => entry.chapter);
  if (chapters.length > 1 && chapter === null) throw new Error("Changes are waiting in more than one chapter. Choose one chapter at a time with --chapter.");
  const selectedChapter = chapter === null ? chapters[0] : Number(chapter);
  if (!Number.isInteger(selectedChapter) || !chapters.includes(selectedChapter)) throw new Error(`${formatChapter(chapter)} has no scene changes waiting for approval.`);
  const selected = pending.chapters.find((entry) => entry.chapter === selectedChapter).scenes;
  const selectedFindings = chapterFindings(root, project, { ...pending, scenes: selected });
  const blocking = selected.flatMap((scene) => selectedFindings.get(scene.id) || []).filter((finding) => finding.severity === "block");
  if (blocking.length) {
    const lines = blocking.map((finding) => `${finding.scene_id}: ${finding.rule_id} (paragraph ${finding.paragraph}): ${finding.message}`);
    throw new Error(`Approval stopped because Chapter ${selectedChapter} has blocking style findings:\n- ${lines.join("\n- ")}`);
  }
  for (const scene of selected) {
    if (!scene.deleted) writeFooter(scene.absolute, countWords(extractProse(readFileSync(scene.absolute, "utf8"), scene.path)));
  }
  ensureIdentity(root, project);
  const paths = selected.map((scene) => scene.path);
  const add = git(root, ["add", "--all", "--", ...paths], { stdio: ["ignore", "pipe", "pipe"] });
  if (add.status !== 0) throw new Error(`could not stage the chapter changes: ${(add.stderr || "").trim()}`);
  const subject = `Approve chapter ${selectedChapter}${note?.trim() ? `: ${note.trim()}` : ""}`;
  const commit = git(root, ["commit", "--only", "-m", subject, "-m", `Approved-with: ${GENERATOR}`, "--", ...paths], { stdio: ["ignore", "pipe", "pipe"] });
  if (commit.status !== 0) throw new Error(`could not save the approval: ${(commit.stderr || commit.stdout || "").trim()}`);
  const sha = git(root, ["rev-parse", "--short", "HEAD"], { stdio: ["ignore", "pipe", "pipe"] });
  if (sha.status !== 0) throw new Error("approval was saved, but its id could not be read from Git");
  const voices = buildVoiceProfiles(root, project);
  return { chapter: selectedChapter, id: sha.stdout.trim(), paths, message: subject, voice_profiles: voices.profiles.length, allowed_blocking: selectedFindings.allowed_blocking || [] };
}

// An imported book is the author's existing work: it is the starting point, not a pending change.
// Commit it as the baseline so repairs are reviewed against the original, chapter by chapter.
export function recordImportBaseline(root, project, record, importPath) {
  ensureIdentity(root, project);
  const paths = [project.source_root, "project.json", relative(root, importPath).replaceAll("\\", "/")];
  const add = git(root, ["add", "--all", "--", ...paths], { stdio: ["ignore", "pipe", "pipe"] });
  if (add.status !== 0) throw new Error(`could not stage the imported book: ${(add.stderr || "").trim()}`);
  const subject = `Import original manuscript: ${record.source?.file || "source"}`;
  const commit = git(root, ["commit", "-m", subject, "-m", `Imported-with: ${GENERATOR}`, "--", ...paths], { stdio: ["ignore", "pipe", "pipe"] });
  if (commit.status !== 0) throw new Error(`could not save the imported book as the starting point: ${(commit.stderr || commit.stdout || "").trim()}`);
  const sha = git(root, ["rev-parse", "--short", "HEAD"], { stdio: ["ignore", "pipe", "pipe"] });
  const voices = buildVoiceProfiles(root, project);
  return { id: sha.stdout.trim(), voice_profiles: voices.profiles.length };
}

export function rejectChapter(root, project, chapter = null) {
  const pending = pendingChanges(root, project);
  if (!pending.scenes.length) throw new Error("There are no scene changes waiting for rejection.");
  const chapters = pending.chapters.map((entry) => entry.chapter);
  if (chapters.length > 1 && chapter === null) throw new Error("Changes are waiting in more than one chapter. Choose one chapter at a time with --chapter.");
  const selectedChapter = chapter === null ? chapters[0] : Number(chapter);
  if (!Number.isInteger(selectedChapter) || !chapters.includes(selectedChapter)) throw new Error(`${formatChapter(chapter)} has no scene changes waiting for rejection.`);
  const selected = pending.chapters.find((entry) => entry.chapter === selectedChapter).scenes;
  const createdAt = new Date().toISOString();
  const rejectedBase = join(root, ".weaver", "rejected");
  const timestampBase = createdAt.replaceAll(":", "-");
  let timestamp = timestampBase;
  let suffix = 2;
  while (existsSync(join(rejectedBase, timestamp))) timestamp = `${timestampBase}-${suffix++}`;
  const rejectedRoot = join(rejectedBase, timestamp);
  const deleted = [];
  mkdirSync(rejectedRoot, { recursive: true });
  const restore = [];
  for (const scene of selected) {
    const destination = join(rejectedRoot, scene.path);
    if (scene.deleted) {
      deleted.push(scene.path);
      restore.push(scene.path);
    } else if (scene.untracked) {
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(scene.absolute, destination);
    } else {
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(scene.absolute, destination);
      restore.push(scene.path);
    }
  }
  writeFileSync(join(rejectedRoot, "manifest.json"), `${JSON.stringify({ chapter: selectedChapter, created_at: createdAt, files: selected.map((scene) => scene.path), deleted }, null, 2)}\n`);
  if (restore.length) {
    const result = git(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...restore], { stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) throw new Error(`could not restore the rejected chapter: ${(result.stderr || "").trim()}`);
  }
  return { chapter: selectedChapter, path: relative(root, rejectedRoot).replaceAll("\\", "/"), files: selected.map((scene) => scene.path) };
}

export function undoApproval(root) {
  if (gitStatusAll(root).length) throw new Error("There are pending changes. Approve or reject them first.");
  const log = git(root, ["log", "--format=%H%x00%s", "--all"], { stdio: ["ignore", "pipe", "pipe"] });
  if (log.status !== 0) throw new Error("could not read the book's approval history");
  const entries = log.stdout.split("\n").filter(Boolean).map((line) => {
    const [sha, subject] = line.split("\0");
    return { sha, subject };
  });
  const approval = entries.find((entry) => /^Approve chapter \d+/u.test(entry.subject));
  if (!approval) throw new Error("There is no approval to undo.");
  const result = git(root, ["revert", "--no-edit", approval.sha], { stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    git(root, ["revert", "--abort"], { stdio: ["ignore", "pipe", "ignore"] });
    throw new Error("Undo could not be completed because Git found a conflict. Nothing was changed.");
  }
  const sha = git(root, ["rev-parse", "--short", "HEAD"], { stdio: ["ignore", "pipe", "pipe"] });
  return { id: sha.stdout.trim(), approval: approval.sha.slice(0, 7) };
}

function approvalDetails(subject) {
  const match = /^Approve chapter (\d+)(?:: (.*))?$/u.exec(subject);
  return match ? { chapter: Number(match[1]), note: match[2] || "" } : null;
}

export function approvalHistory(root) {
  const log = git(root, ["log", "--format=%H%x00%aI%x00%s", "--all"], { stdio: ["ignore", "pipe", "pipe"] });
  if (log.status !== 0) throw new Error("could not read the book's approval history");
  const history = [];
  for (const line of log.stdout.split("\n").filter(Boolean)) {
    const [sha, date, subject] = line.split("\0");
    const approval = approvalDetails(subject);
    const undone = /^Revert "(Approve chapter \d+(?:: .*)?)"/u.exec(subject);
    if (approval) history.push({ type: "approval", date, chapter: approval.chapter, note: approval.note, id: sha.slice(0, 7) });
    else if (undone) {
      const details = approvalDetails(undone[1]);
      history.push({ type: "undo", date, chapter: details.chapter, note: details.note, id: sha.slice(0, 7) });
    }
  }
  const rejectedRoot = join(root, ".weaver", "rejected");
  if (existsSync(rejectedRoot)) {
    for (const entry of readdirSync(rejectedRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(rejectedRoot, entry.name, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        history.push({
          type: "rejection",
          date: manifest.created_at || entry.name,
          chapter: manifest.chapter,
          note: `Rejected text saved in .weaver/rejected/${entry.name}`,
          id: entry.name.slice(-7)
        });
      } catch {
        // A damaged rejection record should not hide the Git approval history.
      }
    }
  }
  return history.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
