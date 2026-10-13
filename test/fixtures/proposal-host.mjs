// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const mode = process.argv[2] || "happy";
const unit = prompt.split("\n")[0];
const countPath = ".weaver/proposal-host-calls.json";
const calls = existsSync(countPath) ? JSON.parse(readFileSync(countPath, "utf8")) : [];
calls.push(unit);
writeFileSync(countPath, JSON.stringify(calls));
const attempt = calls.filter((item) => item === unit).length;
if (mode === "timeouts" && /STATE packet 1-1/u.test(unit) && attempt <= 2) await new Promise((ready) => setTimeout(ready, 2500));
if (mode === "failure" && /STATE packet 1-2/u.test(unit)) process.exit(7);
const active = ".weaver/proposal-host-active";
if (existsSync(active)) throw new Error("overlapping host calls");
writeFileSync(active, "active");
process.on("exit", () => { if (existsSync(active)) unlinkSync(active); });
if (mode === "delay") await new Promise((ready) => setTimeout(ready, 500));
const json = (value) => process.stdout.write(`\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`);
if (unit.startsWith("# REPAIR")) {
  writeFileSync(".weaver/last-repair-prompt.txt", prompt);
  if (mode === "malformed" && !prompt.includes("previous answer failed validation")) { process.stdout.write("broken JSON"); process.exit(0); }
  const findings = JSON.parse(prompt.split("## Targeted findings\n")[1].split("\n\n## Author note")[0]);
  if (mode === "coverage" && !prompt.includes("previous answer failed validation")) { json({ edits: [], declined: [] }); process.exit(0); }
  if (existsSync(".weaver/repair-answer.json")) json(JSON.parse(readFileSync(".weaver/repair-answer.json", "utf8")));
  else if (mode === "decline") json({ edits: [], declined: findings.map((finding) => ({ finding_id: finding.id, reason: "The meaning needs an author decision." })) });
  else {
    const paragraphs = new Map([...prompt.split("## Chapter source Markdown\n")[1].split("\n\n## Answer contract")[0].matchAll(/\[([\d-]+) p(\d+)\] ([\s\S]*?)(?=\n\n\[|$)/gu)].map((match) => [`${match[1]}:${match[2]}`, match[3]]));
    const groups = new Map();
    for (const finding of findings) { const key = `${finding.scene_id}:${finding.paragraph}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(finding); }
    const edits = [], declined = [];
    for (const [key, group] of groups) {
      const before = paragraphs.get(key);
      if (!before.includes("murky")) declined.push(...group.map((finding) => ({ finding_id: finding.id, reason: "The author should decide this judgment." })));
      else edits.push({ scene_id: group[0].scene_id, paragraph: group[0].paragraph, finding_ids: group.map((finding) => finding.id), before, after: before.replaceAll("murky", "clear"), reason: "Use a precise description." });
    }
    json({ edits, declined });
  }
} else if (unit.startsWith("# REVIEW")) {
  const lens = unit.split(" ").at(-1);
  const verdict = prompt.match(/^Start with [A-Z0-9-]+: ([A-Za-z0-9_-]+) or/mu)[1];
  process.stdout.write(`${lens.toUpperCase()}: ${verdict}\n`);
  json({ verdict, findings: [] });
} else {
  process.stdout.write(["Newly established", "Character deltas", "Active threads", "Timeline and location", "Closing image"].map((heading) => `## ${heading}\n\n- The scene continues.\n`).join("\n"));
  json({ facts: [] });
}
