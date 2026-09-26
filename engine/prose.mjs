// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.

export function escapeLiteral(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("*", "\\*");
}

function decodeMarkdownEscape(value, index) {
  const next = value[index + 1];
  if (next === "*" || next === "_" || next === "\\") return { value: next, nextIndex: index + 2 };
  return { value: "\\", nextIndex: index + 1 };
}

function pushToken(tokens, italic, text) {
  if (!text) return;
  const last = tokens.at(-1);
  if (last?.italic === italic) last.text += text;
  else tokens.push({ italic, text });
}

function pushItalic(tokens, text) {
  const leading = text.match(/^[\t \r\n]*/u)[0];
  const trailing = text.match(/[\t \r\n]*$/u)[0];
  const coreEnd = text.length - trailing.length;
  const core = text.slice(leading.length, coreEnd);
  if (!core) {
    pushToken(tokens, false, text);
    return;
  }
  pushToken(tokens, false, leading);
  pushToken(tokens, true, core);
  pushToken(tokens, false, trailing);
}

function closingMarker(value, start, marker) {
  if (/[\t \r\n]/u.test(value[start] || "")) return -1;
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += value[index + 1] === "*" || value[index + 1] === "_" || value[index + 1] === "\\" ? 1 : 0;
      continue;
    }
    if (value[index] !== marker || value[index - 1] === marker || value[index + 1] === marker) continue;
    const inner = value.slice(start, index);
    if (inner && !/[\r\n\t ]/u.test(inner.at(-1)) && !/[\r\n]/u.test(inner)) return index;
  }
  return -1;
}

function normaliseMarkdownTokens(value) {
  const tokens = [];
  for (let index = 0; index < value.length;) {
    const character = value[index];
    if (character === "\\") {
      const decoded = decodeMarkdownEscape(value, index);
      pushToken(tokens, false, decoded.value);
      index = decoded.nextIndex;
      continue;
    }
    if (character === "*" || character === "_") {
      if (value[index + 1] === character) {
        pushToken(tokens, false, value.slice(index, index + 2));
        index += 2;
        continue;
      }
      const end = value[index - 1] === character || /[\t \r\n]/u.test(value[index + 1] || "")
        ? -1
        : closingMarker(value, index + 1, character);
      if (end >= 0) {
        let inner = "";
        for (let innerIndex = index + 1; innerIndex < end;) {
          if (value[innerIndex] === "\\") {
            const decoded = decodeMarkdownEscape(value, innerIndex);
            inner += decoded.value;
            innerIndex = decoded.nextIndex;
          } else {
            inner += value[innerIndex];
            innerIndex += 1;
          }
        }
        pushItalic(tokens, inner);
        index = end + 1;
        continue;
      }
    }
    pushToken(tokens, false, character);
    index += 1;
  }
  return tokens;
}

export function normaliseMarkdownProse(value) {
  return normaliseMarkdownTokens(String(value))
    .map((token) => token.italic ? `*${escapeLiteral(token.text)}*` : escapeLiteral(token.text))
    .join("");
}

function escapedProseTokens(value) {
  const tokens = [];
  for (let index = 0; index < value.length;) {
    const character = value[index];
    if (character === "\\") {
      const next = value[index + 1];
      if (next === "*" || next === "\\") {
        pushToken(tokens, false, next);
        index += 2;
      } else {
        pushToken(tokens, false, "\\");
        index += 1;
      }
      continue;
    }
    if (character === "*" && value[index + 1] !== "*") {
      const end = value[index - 1] === "*" || /[\t \r\n]/u.test(value[index + 1] || "")
        ? -1
        : closingMarker(value, index + 1, "*");
      if (end >= 0) {
        let inner = "";
        for (let innerIndex = index + 1; innerIndex < end;) {
          if (value[innerIndex] === "\\" && (value[innerIndex + 1] === "*" || value[innerIndex + 1] === "\\")) {
            inner += value[innerIndex + 1];
            innerIndex += 2;
          } else {
            inner += value[innerIndex];
            innerIndex += 1;
          }
        }
        pushItalic(tokens, inner);
        index = end + 1;
        continue;
      }
    }
    pushToken(tokens, false, character);
    index += 1;
  }
  return tokens;
}

export function parseEscapedProse(value) {
  return escapedProseTokens(String(value));
}

export function readerText(value) {
  return parseEscapedProse(value).map((token) => token.text).join("");
}

export function canonicalItalic(value) {
  const tokens = [];
  pushItalic(tokens, String(value));
  return tokens.map((token) => token.italic ? `*${escapeLiteral(token.text)}*` : escapeLiteral(token.text)).join("");
}
