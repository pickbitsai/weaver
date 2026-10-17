// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { readFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");
const mode = process.argv[2] || "disagree";
if (mode === "invalid") {
  process.stdout.write("  ```json\n{\"verdict\":\"MOSTLY CONSISTENT\",\"findings\":[]}\n```\n\n");
} else {
  const [, label, first, second] = prompt.match(/^Start with ([A-Z0-9-]+): ([A-Za-z0-9_-]+) or ([A-Za-z0-9_-]+)\./mu);
  const [, scene, paragraph, prose] = prompt.match(/^\[([0-9]+-[0-9]+) p(\d+)\] (.+)$/mu);
  const findings = [{ severity: "minor", scene_id: scene, paragraph: Number(paragraph),
    quote: prose.split(/\s+/u).slice(0, 5).join(" "), issue: "The wording feels abrupt.", repair: "Smooth the smallest phrase." }];
  process.stdout.write(`${label}: ${second}\n\n\`\`\`json\n${JSON.stringify({ verdict: first.toLowerCase(), findings })}\n\`\`\`\n`);
}
