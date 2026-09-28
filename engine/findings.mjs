// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, readFileSync } from "node:fs";
import { loadScenes } from "./manuscript.mjs";
import { runRules } from "./rules.mjs";
import { runVoiceCheck } from "./voice.mjs";
import { LENSES, reviewInputs, reviewIsCurrent, reviewRecordPath } from "./review.mjs";
import { applyRulings } from "./rulings.mjs";

export const MAX_QUEUED_JUDGMENTS = 6;
export const MAX_CRITIC_FAIL_CRAFT = 2;
const PRIORITY = { continuity: 0, style: 1, critic: 2 };
const SEVERITY_PRIORITY = { definite: 0, craft: 1, ambiguity: 2, minor: 3 };

function reviewJudgments(root, project, chapter, scenes) {
  const inputs = reviewInputs(root, project, chapter, scenes);
  const candidates = [];
  const stale = [];
  for (const lens of LENSES) {
    const path = reviewRecordPath(root, chapter, lens);
    if (!existsSync(path)) continue;
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (!reviewIsCurrent(record, inputs)) { stale.push(lens); continue; }
    let criticSelected = 0;
    for (const finding of record.findings || []) {
      const eligible = finding.severity === "definite" ||
        (lens === "critic" && record.verdict === "FAIL" && ["craft", "definite"].includes(finding.severity) && criticSelected < MAX_CRITIC_FAIL_CRAFT);
      if (lens === "critic" && eligible && ["craft", "definite"].includes(finding.severity)) criticSelected += 1;
      candidates.push({ ...finding, chapter, lens, verdict: record.verdict, queued: eligible, source: lens });
    }
  }
  const ordered = candidates.sort((a, b) => PRIORITY[a.lens] - PRIORITY[b.lens] ||
    SEVERITY_PRIORITY[a.severity] - SEVERITY_PRIORITY[b.severity] || a.paragraph - b.paragraph);
  let queued = 0;
  for (const finding of ordered) {
    if (finding.queued) finding.queued = ++queued <= MAX_QUEUED_JUDGMENTS;
  }
  const filtered = applyRulings(root, project, ordered, { kind: "judgment", sourceOf: (finding) => finding.lens, quoteOf: (finding) => finding.quote, scenes });
  for (const finding of filtered.findings) if (finding.ruling === "author wants this fixed") finding.queued = true;
  let visibleQueued = 0;
  for (const finding of filtered.findings) if (finding.queued) finding.queued = ++visibleQueued <= MAX_QUEUED_JUDGMENTS;
  return { judgments: filtered.findings, stale };
}

export function collectFindings(root, project, { chapter = null, all = false, toFix = false } = {}) {
  const scenes = loadScenes(root, project);
  const selectedChapters = [...new Set(scenes.map((scene) => scene.chapter))].filter((value) => chapter === null || value === Number(chapter));
  if (chapter !== null && !selectedChapters.length) throw new Error(`unknown chapter: ${chapter}`);
  const ruleFindings = runRules(root, project).findings;
  const voiceFindings = runVoiceCheck(root, project).findings;
  const chapters = selectedChapters.map((number) => {
    const rules = ruleFindings.filter((item) => Number(item.scene_id.split("-")[0]) === number)
      .map((item) => ({ ...item, chapter: number, queued: true, issue: item.message, repair: "Revise the passage to satisfy the rule." }));
    const voices = voiceFindings.filter((item) => Number(item.scene_id.split("-")[0]) === number)
      .map((item) => ({ ...item, chapter: number, queued: true, issue: item.reason, repair: "Revise the line to match the character's established voice." }));
    const { judgments, stale } = reviewJudgments(root, project, number, scenes);
    const notes = judgments.filter((item) => !item.queued);
    let findings = [...rules, ...voices, ...judgments.filter((item) => item.queued)];
    if (toFix) findings = findings.filter((item) => item.ruling === "author wants this fixed");
    return {
      chapter: number, findings,
      notes: all && !toFix ? notes : [], note_count: notes.length,
      stale_reviews: stale,
      counts: {
        definite_contradictions: findings.filter((item) => item.kind === "judgment" && item.lens === "continuity").length,
        style_breaks: findings.filter((item) => item.kind === "judgment" && item.lens === "style").length,
        critic_issues: findings.filter((item) => item.kind === "judgment" && item.lens === "critic").length,
        queued_judgments: findings.filter((item) => item.kind === "judgment").length
      }
    };
  });
  return { chapters, findings: chapters.flatMap((item) => item.findings), notes: chapters.flatMap((item) => item.notes) };
}
