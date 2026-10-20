// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
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

const MAX_VERDICT_TEXT = 100;
const MAX_LINE_TEXT = 300;
const QUOTE_LIMIT = 120;
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF]/gu;
const TOKEN = /^[A-Za-z][A-Za-z0-9_-]*/u;

export function quoteForAuthor(text) {
  const points = Array.from(String(text).replace(INVISIBLE, " ").replace(/\s+/gu, " ").trim());
  return points.length > QUOTE_LIMIT ? `${points.slice(0, QUOTE_LIMIT - 1).join("")}…` : points.join("");
}

function removeDecoration(text) {
  return text.replace(INVISIBLE, " ").replace(/[*`~'"\u2018\u2019\u201c\u201d]/gu, "")
    .replace(/_+/gu, (run, index, value) => {
      const before = value[index - 1], after = value[index + run.length];
      return !before || !after || /[\s\p{P}]/u.test(before) || /[\s\p{P}]/u.test(after) ? "" : run;
    }).replace(/\s+/gu, " ").trim();
}

function normalizeVerdict(text) {
  const clean = removeDecoration(text);
  let end = clean.length;
  while (end && /[.,;:!?…)\]\s]/u.test(clean[end - 1])) end--;
  return clean.slice(0, end);
}

export function verdictKey(word) {
  return normalizeVerdict(String(word)).toLowerCase();
}

function lookupVerdict(token, verdicts) {
  if (verdicts.includes(token)) return token;
  const key = verdictKey(token);
  const matches = verdicts.filter((word) => verdictKey(word) === key);
  return matches.length === 1 ? matches[0] : null;
}

function labelPattern(label) {
  return label?.split("-").map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("(?:-|\\s+)");
}

function headPattern(label) {
  const filler = "(?:verdict|lens|review|overall|final)";
  return `(?:${label ? `(?:${filler}\\s+)*${labelPattern(label)}(?:\\s+${filler})*|` : ""}(?:${filler}\\s+)*verdict)`;
}

function readSeparator(text) {
  const marked = /^(?:\s*(?:->|=>|[:：=|([→⇒\u2010-\u2015−])\s*|\s+-+\s*|-+\s+)/u.exec(text);
  if (marked) return { length: marked[0].length, marked: true };
  const plain = /^\s+/u.exec(text);
  return plain ? { length: plain[0].length, marked: false } : null;
}

function readHead(text, pattern) {
  const match = new RegExp(`^${pattern}(?=$|\\s|[:：=|([→⇒\\u2010-\\u2015−-])`, "iu").exec(text);
  if (!match) return null;
  const rest = text.slice(match[0].length);
  if (!rest) return { rest: "", marked: false };
  const separator = readSeparator(rest);
  return separator ? { rest: rest.slice(separator.length), marked: separator.marked } : null;
}

function afterHead(text, label) {
  const head = readHead(text, headPattern(label));
  if (!head) return null;
  const repeated = label && readHead(head.rest, labelPattern(label));
  return { ...head, tokenText: repeated?.rest ? repeated.rest : head.rest };
}

function headOnly(head) {
  if (!head) return false;
  let rest = head.rest;
  while (rest) {
    const separator = readSeparator(rest);
    if (!separator) return false;
    rest = rest.slice(separator.length);
  }
  return true;
}

function namedToken(text, verdicts, whole = false) {
  const token = TOKEN.exec(text)?.[0];
  if (!token) return null;
  const rest = text.slice(token.length);
  // Whitespace alone may end the line, but prose needs punctuation after the word.
  if (whole ? rest !== "" : !/^(?:\s*$|\s*[.,;:!?…()[\]|→\u2010-\u2015−]|\s*-+(?:\s|$))/u.test(rest)) return null;
  return lookupVerdict(token, verdicts);
}

export function canonicalVerdict(value, { label, verdicts }) {
  if (typeof value !== "string") return null;
  if (verdicts.includes(value)) return value;
  if (verdicts.includes(value.trim())) return value.trim();
  if (value.length > MAX_VERDICT_TEXT) return null;
  const text = normalizeVerdict(value);
  const exact = namedToken(text, verdicts, true);
  if (exact !== null) return exact;
  const head = afterHead(text, label);
  return head ? namedToken(head.tokenText, verdicts, true) : null;
}

export function verdictLines(text, { label, verdicts = [], start, end }) {
  const lines = [];
  for (const [index, section] of [String(text).slice(0, start), String(text).slice(end)].entries()) {
    let contract = index === 0;
    for (const raw of section.split(/\r\n|\n|\r/u)) {
      const line = removeDecoration(raw.slice(0, MAX_LINE_TEXT))
        .replace(/^(?:(?:[>#]+|\||[-+•◦‣]|\d+[.)]|\(\d+\)|[[(])\s*)+/u, "");
      if (!line) continue;
      const head = afterHead(line, label);
      const atContract = contract;
      contract = headOnly(head);
      if (contract) continue;
      const verdict = head
        ? (atContract || head.marked ? namedToken(head.tokenText, verdicts) : null)
        : (atContract ? namedToken(line, verdicts) : null);
      if (verdict !== null || (head?.marked && head.rest)) lines.push({ line: quoteForAuthor(raw), verdict });
    }
  }
  return lines;
}

export function checkVerdict(text, json, { label, verdicts, start, end }) {
  const verdict = canonicalVerdict(json?.verdict, { label, verdicts });
  const errors = [], warnings = [];
  if (verdict === null) {
    const given = json?.verdict === undefined ? "no verdict" : quoteForAuthor(JSON.stringify(json.verdict));
    errors.push(`The JSON block's "verdict" must be exactly one of these words: ${verdictWords(verdicts)}. This answer gave ${given}.`);
  } else {
    const lines = verdictLines(text, { label, verdicts, start, end });
    const disagreement = lines.find((line) => line.verdict !== null && line.verdict !== verdict);
    if (disagreement) warnings.push(`The verdict line "${disagreement.line}" says ${disagreement.verdict}, but the JSON block says ${verdict}. Weaver recorded ${verdict}, from the JSON block.`);
    else if (lines.length && !lines.some((line) => line.verdict !== null)) warnings.push(`The verdict line "${lines[0].line}" does not name ${verdictWords(verdicts)}. Weaver recorded ${verdict}, from the JSON block.`);
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

export function savedAnswerNote(root, answerFile) {
  return answerFile ? ` (Weaver saved the answer in ${typeof root === "string" ? resolve(root, answerFile) : answerFile})` : "";
}

function sameAnswerFile(answerPath, diagnosticPath) {
  if (!answerPath) return false;
  let paths;
  try {
    paths = existsSync(answerPath) && existsSync(diagnosticPath)
      ? [realpathSync.native(answerPath), realpathSync.native(diagnosticPath)] : [resolve(answerPath), resolve(diagnosticPath)];
  } catch { paths = [resolve(answerPath), resolve(diagnosticPath)]; }
  if (process.platform === "win32") paths = paths.map((path) => path.toLowerCase());
  return paths[0] === paths[1];
}

export async function validateAndRepair(root, project, packet, answerText, validator, { host = runHost, answerPath = null } = {}) {
  const first = await validate(answerText, validator);
  if (first.ok) return { ...first, answerText, attempts: 1 };
  const saved = {};
  const diagnosticPath = join(root, ".weaver", "packets", `${packet.id}.answer.txt`);
  const preserveAnswer = sameAnswerFile(answerPath, diagnosticPath);
  const saveFailedAnswer = (text) => {
    if (preserveAnswer || !/^[a-f0-9]{12}$/u.test(packet.id)) return;
    try {
      writeTextRecord(diagnosticPath, text);
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
