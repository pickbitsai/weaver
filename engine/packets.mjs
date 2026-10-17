// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { runHost } from "./host.mjs";
import { writeTextRecord } from "./records.mjs";

export function packetId(kind, target, inputs) {
  const inputHashes = Object.keys(inputs).sort().map((name) => inputs[name]).join("");
  return createHash("sha256").update(`${kind}${target}${inputHashes}`).digest("hex").slice(0, 12);
}

export function buildPacket(kind, target, prompt, inputs, expects) {
  return { id: packetId(kind, target, inputs), kind, target, prompt, inputs, expects };
}

export function extractJsonBlock(text) {
  const matches = [...String(text || "").matchAll(/```json\s*([\s\S]*?)```/giu)];
  if (!matches.length) return { ok: false, value: null, errors: ["answer must contain a fenced ```json block"] };
  const match = matches.at(-1);
  const raw = match[1], start = match.index, end = start + match[0].length;
  try {
    return { ok: true, value: JSON.parse(raw), errors: [], raw, start, end };
  } catch (error) {
    return { ok: false, value: null, errors: [`invalid JSON in the answer block: ${error.message}`], raw, start, end };
  }
}

export function verdictWords(verdicts) {
  if (verdicts.length < 2) return verdicts.join("");
  return `${verdicts.slice(0, -1).join(", ")} or ${verdicts.at(-1)}`;
}

function removeDecoration(text) {
  return text.replace(/[*`~'"\u2018\u2019\u201c\u201d]/gu, "")
    .replace(/_+/gu, (run, index, value) => {
      const before = value[index - 1], after = value[index + run.length];
      return !before || !after || /[\s\p{P}]/u.test(before) || /[\s\p{P}]/u.test(after) ? "" : run;
    }).replace(/\s+/gu, " ").trim();
}

function normalizeVerdict(text) {
  return removeDecoration(text).replace(/[.,;:!?]+$/u, "").trim();
}

export function canonicalVerdict(value, { label, verdicts }) {
  if (typeof value !== "string") return null;
  const text = normalizeVerdict(value);
  const match = (word) => verdicts.find((verdict) => verdict.toLowerCase() === word.toLowerCase()) ?? null;
  const exact = match(text);
  if (exact !== null) return exact;
  if (!label || !text.toLowerCase().startsWith(label.toLowerCase())) return null;
  const rest = text.slice(label.length);
  const separator = rest.match(/^(?:\s*[:\-–—]\s*|\s+)/u);
  return separator ? match(normalizeVerdict(rest.slice(separator[0].length))) : null;
}

export function readVerdictLine(text, { label, verdicts = [], start, end }) {
  for (const section of [String(text).slice(0, start), String(text).slice(end)]) {
    for (const raw of section.split(/\r?\n/u)) {
      const line = removeDecoration(raw).replace(/^(?:(?:[>#]+|[-+•]|\d+\.)\s*)+/u, "");
      if (!line.toLowerCase().startsWith(label.toLowerCase())) continue;
      const separator = line.slice(label.length).match(/^\s*[:\-–—]\s*/u);
      if (!separator) continue;
      const said = line.slice(label.length + separator[0].length);
      const token = said.match(/^[A-Za-z][A-Za-z0-9_-]*/u)?.[0];
      return { line, said, verdict: canonicalVerdict(token, { label, verdicts }) };
    }
  }
  return null;
}

export function checkVerdict(text, json, { label, verdicts, start, end }) {
  const verdict = canonicalVerdict(json?.verdict, { label, verdicts });
  const errors = [], warnings = [];
  if (verdict === null) {
    const given = json?.verdict === undefined ? "no verdict" : JSON.stringify(json.verdict);
    errors.push(`The JSON block's "verdict" must be exactly one of these words: ${verdictWords(verdicts)}. This answer gave ${given}.`);
  } else {
    const line = readVerdictLine(text, { label, verdicts, start, end });
    if (line && line.verdict !== verdict) warnings.push(line.verdict === null
      ? `The verdict line "${line.line}" does not name ${verdictWords(verdicts)}. Weaver recorded ${verdict}, from the JSON block.`
      : `The verdict line says ${line.verdict} but the JSON block says ${verdict}. Weaver recorded ${verdict}, from the JSON block.`);
  }
  return { verdict, errors, warnings };
}

function validatorResult(result) {
  if (Array.isArray(result)) return { ok: result.length === 0, value: null, errors: result, warnings: [] };
  if (result && typeof result === "object") {
    const errors = Array.isArray(result.errors) ? result.errors.map(String) : [];
    const warnings = Array.isArray(result.warnings) ? result.warnings.map(String) : [];
    return { ok: result.ok === true && errors.length === 0, value: result.value, errors, warnings };
  }
  return { ok: false, value: null, errors: ["validator did not return a result"], warnings: [] };
}

async function validate(answerText, validator) {
  try {
    return validatorResult(await validator(answerText));
  } catch (error) {
    return { ok: false, value: null, errors: [error.message || String(error)], warnings: [] };
  }
}

export async function validateAndRepair(root, project, packet, answerText, validator, { host = runHost } = {}) {
  const first = await validate(answerText, validator);
  if (first.ok) return { ...first, answerText, attempts: 1 };
  const saved = {};
  const saveFailedAnswer = (text) => {
    if (!/^[a-f0-9]{12}$/u.test(packet.id)) return;
    try {
      writeTextRecord(join(root, ".weaver", "packets", `${packet.id}.answer.txt`), text);
      saved.answer_file = `.weaver/packets/${packet.id}.answer.txt`;
    } catch { /* Diagnostic files must never prevent packet handling. */ }
  };
  saveFailedAnswer(answerText);
  const repairPrompt = `${packet.prompt}\n\nYour previous answer failed validation:\n${first.errors.map((error) => `- ${error}`).join("\n")}\nReturn the complete corrected answer only.`;
  const hostResult = await host(root, project, repairPrompt);
  if (!hostResult.ok) return { ok: false, value: null, errors: first.errors, warnings: first.warnings, answerText, attempts: 1 + hostResult.attempts, host_error: hostResult.error, ...saved };
  const repaired = await validate(hostResult.text, validator);
  if (!repaired.ok) saveFailedAnswer(hostResult.text);
  return {
    ...repaired,
    ...saved,
    answerText: hostResult.text,
    attempts: 1 + hostResult.attempts,
    host_error: repaired.ok ? undefined : hostResult.error
  };
}
