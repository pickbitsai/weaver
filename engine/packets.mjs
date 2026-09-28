// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { createHash } from "node:crypto";
import { runHost } from "./host.mjs";

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
  const raw = matches.at(-1)[1];
  try {
    return { ok: true, value: JSON.parse(raw), errors: [], raw, start: matches.at(-1).index };
  } catch (error) {
    return { ok: false, value: null, errors: [`invalid JSON in the answer block: ${error.message}`], raw, start: matches.at(-1).index };
  }
}

function validatorResult(result) {
  if (Array.isArray(result)) return { ok: result.length === 0, value: null, errors: result };
  if (result && typeof result === "object") {
    const errors = Array.isArray(result.errors) ? result.errors.map(String) : [];
    return { ok: result.ok === true && errors.length === 0, value: result.value, errors };
  }
  return { ok: false, value: null, errors: ["validator did not return a result"] };
}

async function validate(answerText, validator) {
  try {
    return validatorResult(await validator(answerText));
  } catch (error) {
    return { ok: false, value: null, errors: [error.message || String(error)] };
  }
}

export async function validateAndRepair(root, project, packet, answerText, validator) {
  const first = await validate(answerText, validator);
  if (first.ok) return { ...first, answerText, attempts: 1 };
  const repairPrompt = `${packet.prompt}\n\nYour previous answer failed validation:\n${first.errors.map((error) => `- ${error}`).join("\n")}\nReturn the complete corrected answer only.`;
  const hostResult = await runHost(root, project, repairPrompt);
  if (!hostResult.ok) return { ok: false, value: null, errors: first.errors, answerText, attempts: 1 + hostResult.attempts, host_error: hostResult.error };
  const repaired = await validate(hostResult.text, validator);
  return {
    ...repaired,
    answerText: hostResult.text,
    attempts: 1 + hostResult.attempts,
    host_error: repaired.ok ? undefined : hostResult.error
  };
}
