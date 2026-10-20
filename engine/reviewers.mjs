// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./manuscript.mjs";
import { verdictKey } from "./packets.mjs";

const BUILT_INS = [
  { id: "continuity", title: "Continuity", verdicts: ["CLEAR", "FLAGS"], context: ["world-bible", "outline", "facts", "previous-state"], queue: "definite" },
  { id: "style", title: "Style", verdicts: ["CONSISTENT", "DRIFT"], context: ["world-bible"], queue: "definite" },
  { id: "critic", title: "Critic", verdicts: ["PASS", "FAIL"], context: ["world-bible", "outline"], queue: "critic" }
];
const CONTEXT = new Set(["world-bible", "outline", "style-guide", "facts", "previous-state"]);
const KEYS = new Set(["id", "title", "verdicts", "context", "queue"]);

function parseReviewer(text, filename) {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) throw new Error("start with a front-matter block between two --- lines");
  const fields = {};
  for (const raw of lines.slice(1, end)) {
    const line = raw.replace(/#.*$/u, "").trim();
    if (!line) continue;
    const match = /^([a-z]+):\s*(.+)$/u.exec(line);
    if (!match) throw new Error("front matter must use key: value or key: [a, b]");
    const [, key, value] = match;
    if (!KEYS.has(key)) throw new Error(`unknown front-matter key ${key}`);
    if (Object.hasOwn(fields, key)) throw new Error(`front-matter key ${key} is repeated`);
    if (value.startsWith("[")) {
      if (!/^\[[^\[\]]*\]$/u.test(value)) throw new Error(`${key} needs a single-line list in square brackets`);
      fields[key] = value.slice(1, -1).trim() ? value.slice(1, -1).split(",").map((item) => item.trim()) : [];
      if (fields[key].some((item) => !item || /["'{}]/u.test(item))) throw new Error(`${key} needs plain, unquoted list items`);
    } else {
      if (/^["']|[\[\]{}]/u.test(value)) throw new Error(`${key} needs a plain, unquoted value`);
      fields[key] = value;
    }
  }
  if (typeof fields.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(fields.id)) throw new Error("id must be kebab-case");
  if (BUILT_INS.some((lens) => lens.id === fields.id)) throw new Error(`id ${fields.id} belongs to a built-in reviewer`);
  if (`${fields.id}.md` !== filename) throw new Error(`id ${fields.id} must match the filename`);
  if (typeof fields.title !== "string" || !fields.title.trim()) throw new Error("title must be plain text");
  if (!Array.isArray(fields.verdicts) || fields.verdicts.length !== 2 || new Set(fields.verdicts).size !== 2 ||
      fields.verdicts.some((word) => !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(word))) throw new Error("verdicts must contain exactly two different verdict words");
  if (verdictKey(fields.verdicts[0]) === verdictKey(fields.verdicts[1])) throw new Error("verdicts must contain two words that differ by more than capital letters or underscores at their edges");
  fields.context ??= ["world-bible"];
  if (!Array.isArray(fields.context)) throw new Error("context must be a list in square brackets");
  for (const key of fields.context) if (!CONTEXT.has(key)) throw new Error(`unknown context key ${key}`);
  if (new Set(fields.context).size !== fields.context.length) throw new Error("context keys must not repeat");
  if (!["definite", "top-2", "top-3"].includes(fields.queue)) throw new Error("queue must be definite, top-2, or top-3");
  const body = lines.slice(end + 1).join("\n").trim();
  if (!body.replace(/<!--[\s\S]*?-->/gu, "").trim()) throw new Error("reviewer instructions are missing after the front matter");
  return { ...fields, body, file: `quality/reviewers/${filename}`, hash: sha256(text), builtin: false };
}

// Invalid book files are advisory: consumers share the same list and diagnostics.
export function listLenses(root, { onWarning = () => {} } = {}) {
  const lenses = BUILT_INS.map((lens) => ({ ...lens, verdicts: [...lens.verdicts], context: [...lens.context], builtin: true }));
  const directory = join(root, "quality", "reviewers");
  if (!existsSync(directory)) return lenses;
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch { onWarning("quality/reviewers: cannot read the reviewer folder; book reviewers were skipped"); return lenses; }
  for (const entry of entries.filter((item) => item.isFile() && /\.md$/iu.test(item.name)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    try { lenses.push(parseReviewer(readFileSync(join(directory, entry.name), "utf8"), entry.name)); }
    catch (error) { onWarning(`quality/reviewers/${entry.name}: ${error.message}; reviewer skipped`); }
  }
  return lenses;
}

export function reviewerWarnings(root) {
  const warnings = [];
  listLenses(root, { onWarning: (message) => warnings.push(message) });
  return warnings;
}
