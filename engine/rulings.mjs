// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureIdentity } from "./changes.mjs";
import { GENERATOR, SCHEMA_BASE } from "./identity.mjs";
import { loadScenes, sha256 } from "./manuscript.mjs";
import { readerText } from "./prose.mjs";

export const LAPSE_NOTE = "an earlier ruling no longer applies because the passage changed";
const RULINGS_FILE = join("continuity", "rulings.json");

export function findingId(kind, source, sceneId, paragraph, quote) {
  const normalized = String(quote || "").replace(/[\u201c\u201d]/gu, '"').replace(/[\u2018\u2019]/gu, "'").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
  return sha256([kind, source, sceneId, paragraph, normalized].join(" | ")).slice(0, 10);
}

export function passageText(scenes, sceneId, paragraph) {
  const scene = scenes.find((item) => item.id === sceneId);
  const prose = scene?.prose.split(/\n\s*\n/u).filter((item) => item.trim())[Number(paragraph) - 1];
  return prose === undefined ? null : readerText(prose);
}

export function readRulings(root) {
  const path = join(root, RULINGS_FILE);
  if (!existsSync(path)) return { $schema: `${SCHEMA_BASE}rulings-1.json`, generator: GENERATOR, entries: [] };
  const document = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(document.entries)) throw new Error("invalid continuity/rulings.json: entries must be an array");
  return document;
}

export function applyRulings(root, project, findings, { kind, sourceOf, quoteOf, scenes = loadScenes(root, project) } = {}) {
  const rulings = readRulings(root).entries;
  const visible = [];
  const allowed_blocking = [];
  for (const finding of findings) {
    const source = sourceOf(finding);
    const quote = quoteOf(finding);
    const id = findingId(kind, source, finding.scene_id, finding.paragraph, quote);
    const passage = passageText(scenes, finding.scene_id, finding.paragraph);
    const passageHash = passage === null ? null : sha256(passage);
    const ruling = [...rulings].reverse().find((item) => item.finding_id === id);
    const earlier = ruling || [...rulings].reverse().find((item) => item.kind === kind && item.source === source && item.scene_id === finding.scene_id && item.paragraph === finding.paragraph);
    const active = ruling && ruling.passage_sha256 === passageHash;
    if (active && ["allow", "intended"].includes(ruling.decision)) {
      if (finding.severity === "block") allowed_blocking.push(id);
      continue;
    }
    const item = { ...finding, id, kind, source, quote };
    if (active && ruling.decision === "fix") item.ruling = "author wants this fixed";
    if (earlier && earlier.passage_sha256 !== passageHash) item.ruling = LAPSE_NOTE;
    visible.push(item);
  }
  return { findings: visible, allowed_blocking };
}

export function rulingStatuses(root, project, activeFindings) {
  const scenes = loadScenes(root, project);
  const active = new Set(activeFindings.map((item) => item.id));
  return readRulings(root).entries.map((entry) => {
    const passage = passageText(scenes, entry.scene_id, entry.paragraph);
    const changed = passage === null || sha256(passage) !== entry.passage_sha256;
    const status = entry.decision === "fix" && !active.has(entry.finding_id) ? "resolved"
      : changed ? "lapsed" : ["allow", "intended"].includes(entry.decision) || active.has(entry.finding_id) ? "active" : "resolved";
    return { ...entry, status };
  });
}

export function saveRuling(root, project, finding, decision, note = "") {
  if (!["fix", "allow", "intended"].includes(decision)) throw new Error("decision must be fix, allow, or intended");
  const scenes = loadScenes(root, project);
  const passage = passageText(scenes, finding.scene_id, finding.paragraph);
  if (passage === null) throw new Error(`finding ${finding.id} has no current passage`);
  const document = readRulings(root);
  const entry = {
    finding_id: finding.id, kind: finding.kind, source: finding.source,
    scene_id: finding.scene_id, paragraph: finding.paragraph, passage_sha256: sha256(passage),
    decision, note: String(note), ruled_at: new Date().toISOString(), generator: GENERATOR
  };
  document.entries.push(entry);
  const path = join(root, RULINGS_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  ensureIdentity(root, project);
  const stage = spawnSync("git", ["-C", root, "add", "--", RULINGS_FILE.replaceAll("\\", "/")], { encoding: "utf8" });
  if (stage.status !== 0) throw new Error(`could not stage ruling: ${(stage.stderr || "").trim()}`);
  const args = ["-C", root, "commit", "--only", "-m", `Ruling: ${decision} ${finding.id}`, "-m", `Approved-with: ${GENERATOR}`, "--", RULINGS_FILE.replaceAll("\\", "/")];
  const commit = spawnSync("git", args, { encoding: "utf8" });
  if (commit.status !== 0) throw new Error(`could not save ruling commit: ${(commit.stderr || commit.stdout || "").trim()}`);
  return entry;
}
