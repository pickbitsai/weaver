#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.argv[2] || "happy";
if (mode === "early-exit") process.exit(0);

const counterPath = ".weaver/fake-host-count";
const prompt = readFileSync(0, "utf8");
const review = prompt.match(/^# REVIEW packet chapter (\d+) lens (continuity|style|critic)/mu);
if (review) {
  const lens = review[2];
  const paragraphs = [...prompt.matchAll(/^\[([0-9]+-[0-9]+) p(\d+)\] (.+)$/gmu)];
  const first = paragraphs[0];
  const quote = first?.[3].split(/\s+/u).slice(0, 5).join(" ") || "No valid reader passage exists";
  const finding = (severity, index = 0) => ({
    severity, scene_id: first?.[1] || "1-1", paragraph: Number(first?.[2] || 1), quote,
    issue: `A ${severity} issue appears in this passage.`, repair: "Revise the smallest relevant phrase."
  });
  if (mode === "review-capture") writeFileSync(`.weaver/review-${lens}-prompt.txt`, prompt);
  if (mode === "review-malformed-once" && !existsSync(`.weaver/review-${lens}-retry`)) {
    writeFileSync(`.weaver/review-${lens}-retry`, "1");
    process.stdout.write("```json\nnot json\n```\n");
    process.exit(0);
  }
  const verdict = { continuity: "FLAGS", style: "DRIFT", critic: "FAIL" }[lens];
  const findings = mode === "review-triage"
    ? lens === "continuity" ? [finding("definite"), ...Array.from({ length: 8 }, () => finding("minor"))]
      : lens === "critic" ? Array.from({ length: 5 }, () => finding("craft")) : []
    : mode === "review-cap" ? Array.from({ length: 10 }, () => finding("definite"))
      : [finding("definite")];
  if (mode === "review-invalid") findings.push({ ...finding("definite"), quote: "These invented words are absent" });
  process.stdout.write(`${lens.toUpperCase()}: ${verdict}\n\n\`\`\`json\n${JSON.stringify({ verdict, findings })}\n\`\`\`\n`);
  process.exit(0);
}
const sceneId = prompt.match(/# STATE packet ([0-9]+-[0-9]+)/u)?.[1] || "1-1";
let firstModeCall = false;
if (mode === "retry" || mode === "malformed-once") {
  if (!existsSync(counterPath)) {
    writeFileSync(counterPath, "1\n");
    firstModeCall = true;
    if (mode === "retry") process.exit(1);
  }
}
if (mode === "key") writeFileSync(".weaver/fake-host-key.txt", process.env.ANTHROPIC_API_KEY ? "present\n" : "absent\n");
if (mode === "invalid-quote") {
  process.stdout.write([
    `## Narrative state after scene ${sceneId}`,
    "",
    "## Newly established", "", "-", "",
    "## Character deltas", "", "-", "",
    "## Active threads", "", "-", "",
    "## Timeline and location", "", "-", "",
    "## Closing image", "", "-", "",
    "```json", JSON.stringify({ facts: [{ kind: "event", subject: "world", value: "an invented event", quote: "This quote is absent" }] }), "```", ""
  ].join("\n"));
  process.exit(0);
}
const sceneText = prompt.split("## Scene reader text\n")[1]?.split("\n\n## Answer contract")[0]?.trim() || "The scene establishes a careful fact for the reader.";
const quote = sceneText.split(/\s+/u).slice(0, 5).join(" ");
if (mode === "malformed-once" && firstModeCall) {
  process.stdout.write("```json\nnot json\n```\n");
  process.exit(0);
}
process.stdout.write([
  `## Narrative state after scene ${sceneId}`,
  "",
  "## Newly established", "", "- The scene establishes one reader fact.", "",
  "## Character deltas", "", "- No character delta.", "",
  "## Active threads", "", "- The event remains active.", "",
  "## Timeline and location", "", "- The scene continues in sequence.", "",
  "## Closing image", "", "- The reader is left with a changed pressure.", "",
  "```json", JSON.stringify({ facts: [{ kind: "event", subject: "world", value: "the scene establishes one reader fact", quote }] }), "```", ""
].join("\n"));
