// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.

// Codex's apply_patch format, not a Git unified diff. Paths are collected even
// when a hunk is malformed: failed reconstruction must not bypass path guards.
export function parseCodexPatch(patch) {
  if (typeof patch !== "string") return [];
  const files = [];
  let file;
  for (const line of patch.replaceAll("\r\n", "\n").split("\n")) {
    const header = /^\*\*\* (Update|Add|Delete) File: (.+)$/u.exec(line);
    if (header) {
      file = { kind: header[1], path: header[2], lines: [] };
      files.push(file);
    } else if (/^\*\*\* Move (?:to|File): /u.test(line)) {
      const path = line.replace(/^\*\*\* Move (?:to|File): /u, "");
      if (file) file.move = path;
      // Keep every destination, including malformed repeated move headers.
      files.push({ kind: "Move", path, lines: [] });
    } else if (line === "*** End Patch") file = null;
    else if (file) file.lines.push(line);
  }
  return files;
}

export function applyCodexHunks(current, file) {
  if (file.kind === "Add") return file.lines.every((line) => line.startsWith("+") || !line)
    ? `${file.lines.filter((line) => line.startsWith("+")).map((line) => line.slice(1)).join("\n")}\n` : null;
  if (file.kind === "Delete") return "";
  if (file.kind !== "Update") return null;
  const crlf = current.includes("\r\n");
  const lines = current.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  let cursor = 0;
  let index = 0;
  while (index < file.lines.length) {
    const marker = file.lines[index];
    if (!marker && index === file.lines.length - 1) break;
    if (!marker.startsWith("@@")) return null;
    if (marker !== "@@" && !marker.startsWith("@@ ")) return null;
    const anchor = marker.slice(3);
    if (anchor) {
      const found = lines.indexOf(anchor, cursor);
      if (found < 0) return null;
      cursor = found + 1;
    }
    index++;
    const before = [], after = [];
    let eof = false;
    while (index < file.lines.length && !file.lines[index].startsWith("@@")) {
      const line = file.lines[index++];
      if (line === "*** End of File") { eof = true; break; }
      if (!line && index === file.lines.length) break;
      if (![" ", "+", "-"].includes(line[0])) return null;
      if (line[0] !== "+") before.push(line.slice(1));
      if (line[0] !== "-") after.push(line.slice(1));
    }
    let found = -1;
    for (let at = cursor; at <= lines.length - before.length; at++) {
      if ((!eof || at + before.length === lines.length) && before.every((line, n) => lines[at + n] === line)) { found = at; break; }
    }
    if (found < 0) return null;
    lines.splice(found, before.length, ...after);
    cursor = found + after.length;
  }
  return `${lines.join(crlf ? "\r\n" : "\n")}${crlf ? "\r\n" : "\n"}`;
}
