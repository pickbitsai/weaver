// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { countWords } from "./manuscript.mjs";
import { GENERATOR, SCHEMA_BASE, VERSION } from "./identity.mjs";
import { canonicalItalic, escapeLiteral, normaliseMarkdownProse } from "./prose.mjs";

export const DEFAULT_CHAPTER_PATTERN = "^(chapter|ch\\.)\\s+([0-9]+|[a-z-]+)\\b(.*)$";

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const BREAKS = new Set(["***", "* * *", "\\*\\*\\*", "\\* \\* \\*", "#", "~~~", "---", "§", "⁂"]);

export function sourceSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(bytes, source) {
  try {
    return textDecoder.decode(bytes).replace(/\r\n?/g, "\n");
  } catch {
    throw new Error(`${source}: invalid UTF-8 text source`);
  }
}

function naturalCompare(left, right) {
  const a = left.toLocaleLowerCase().split(/(\d+)/).filter(Boolean);
  const b = right.toLocaleLowerCase().split(/(\d+)/).filter(Boolean);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    const aNumber = /^\d+$/.test(a[index]);
    const bNumber = /^\d+$/.test(b[index]);
    if (aNumber && bNumber && Number(a[index]) !== Number(b[index])) return Number(a[index]) - Number(b[index]);
    if (a[index] !== b[index]) return a[index].localeCompare(b[index]);
  }
  return left.localeCompare(right);
}

function xmlUnescape(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#x[0-9a-f]+|#\d+);/gi, (entity) => {
    if (entity === "&amp;") return "&";
    if (entity === "&lt;") return "<";
    if (entity === "&gt;") return ">";
    if (entity === "&quot;") return '"';
    if (entity === "&apos;") return "'";
    const code = entity[2].toLocaleLowerCase() === "x"
      ? Number.parseInt(entity.slice(3, -1), 16)
      : Number.parseInt(entity.slice(2, -1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
  });
}

function zipEntries(bytes) {
  const endSignature = 0x06054b50;
  let end = -1;
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (bytes.readUInt32LE(index) === endSignature) {
      end = index;
      break;
    }
  }
  if (end < 0) throw new Error("source is not a valid ZIP archive");
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (directoryOffset + directorySize > bytes.length) throw new Error("source ZIP central directory is truncated");
  const entries = new Map();
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("source ZIP has an invalid central directory");
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`source ZIP entry has an invalid local header: ${name}`);
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) throw new Error(`source ZIP entry is truncated: ${name}`);
    const compressed = bytes.subarray(dataStart, dataEnd);
    let content;
    if (method === 0) content = Buffer.from(compressed);
    else if (method === 8) content = inflateRawSync(compressed);
    else throw new Error(`source DOCX uses unsupported ZIP compression: ${method}`);
    if (content.length !== uncompressedSize) throw new Error(`source ZIP entry has an invalid size: ${name}`);
    entries.set(name, content);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function xmlAttribute(tag, name) {
  const match = new RegExp(`(?:^|\\s)(?:w:)?${name}=["']([^"']*)["']`).exec(tag);
  return match ? xmlUnescape(match[1]) : null;
}

function xmlTextFromRun(run) {
  const italicTag = run.match(/<w:i(?:\s[^>]*)?\/>/i)?.[0];
  const italic = Boolean(italicTag) && !/\b(?:w:)?val=["'](?:0|false)["']/i.test(italicTag);
  const tokens = [];
  const tokenPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\/>|<w:br(?:\s[^>]*)?\/>/gi;
  let match;
  while ((match = tokenPattern.exec(run))) {
    if (match[1] !== undefined) tokens.push(xmlUnescape(match[1]));
    else if (match[0].toLocaleLowerCase().startsWith("<w:tab")) tokens.push("\t");
    else tokens.push("\n");
  }
  const value = tokens.join("");
  return { italic, value };
}

function docxRunText(runs) {
  const segments = [];
  for (const run of runs) {
    if (!run.value) continue;
    const previous = segments.at(-1);
    if (previous?.italic && run.italic) previous.value += run.value;
    else segments.push({ ...run });
  }
  return segments.map((segment) => segment.italic ? canonicalItalic(segment.value) : escapeLiteral(segment.value)).join("");
}

function countElements(xml, name, excludeTypes = []) {
  if (!xml) return 0;
  const pattern = new RegExp(`<w:${name}\\b([^>]*)>`, "gi");
  let count = 0;
  let match;
  while ((match = pattern.exec(xml))) {
    const type = /(?:^|\s)w:type=["']([^"']+)["']/i.exec(match[1])?.[1];
    if (!excludeTypes.includes(type)) count += 1;
  }
  return count;
}

function docxNotImported(entries) {
  const comments = entries.get("word/comments.xml");
  const footnotes = entries.get("word/footnotes.xml");
  const endnotes = entries.get("word/endnotes.xml");
  return {
    comments: countElements(comments ? decodeUtf8(comments, "word/comments.xml") : "", "comment"),
    footnotes: countElements(footnotes ? decodeUtf8(footnotes, "word/footnotes.xml") : "", "footnote", ["separator", "continuationSeparator"]),
    endnotes: countElements(endnotes ? decodeUtf8(endnotes, "word/endnotes.xml") : "", "endnote", ["separator", "continuationSeparator"])
  };
}

function docxParagraphs(xml) {
  const paragraphs = [];
  const paragraphPattern = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/gi;
  let paragraphMatch;
  while ((paragraphMatch = paragraphPattern.exec(xml))) {
    const paragraph = paragraphMatch[0];
    const style = paragraph.match(/<w:pStyle(?:\s[^>]*)?\/>/i)?.[0];
    const styleValue = style ? xmlAttribute(style, "val") : null;
    const withoutDeletions = paragraph.replace(/<w:del(?:\s[^>]*)?>[\s\S]*?<\/w:del>/gi, "");
    const runs = [];
    const runPattern = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/gi;
    let runMatch;
    while ((runMatch = runPattern.exec(withoutDeletions))) runs.push(xmlTextFromRun(runMatch[0]));
    paragraphs.push({ text: docxRunText(runs), style: styleValue });
  }
  return paragraphs;
}

function readDocx(bytes, source) {
  const entries = zipEntries(bytes);
  const document = entries.get("word/document.xml");
  if (!document) throw new Error(`${source}: DOCX is missing word/document.xml`);
  const xml = decodeUtf8(document, `${source} word/document.xml`);
  if (/<(?:[A-Za-z_][\w.-]*:)?(?:ins|del|moveFrom|moveTo)\b/i.test(xml)) {
    throw new Error("Your Word file still has tracked changes. Open it in Word, accept or reject all changes (Review → Accept / Reject), save, and import again.");
  }
  return { paragraphs: docxParagraphs(xml), notImported: docxNotImported(entries) };
}

function paragraphsFromText(text, kind) {
  const paragraphs = [];
  let lines = [];
  const flush = () => {
    if (lines.length) paragraphs.push({ text: lines.join("\n"), style: null });
    lines = [];
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || (kind === "markdown" && /^#{1,2}\s+/.test(line)) || BREAKS.has(trimmed)) {
      flush();
      if (trimmed) paragraphs.push({ text: line, style: null });
    } else {
      lines.push(line);
    }
  }
  flush();
  return paragraphs;
}

function normaliseParagraph(value) {
  return value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n");
}

function makeChapterPattern(pattern) {
  try {
    return new RegExp(pattern, "i");
  } catch (error) {
    throw new Error(`invalid chapter pattern: ${error.message}`);
  }
}

function chapterMatch(text, pattern) {
  const match = pattern.exec(text);
  if (match) pattern.lastIndex = 0;
  return match;
}

function chapterTitle(text, match, markdown, pattern = new RegExp(DEFAULT_CHAPTER_PATTERN, "i")) {
  if (markdown) {
    const heading = text.replace(/^#{1,2}\s+/, "").trim();
    const headingMatch = chapterMatch(heading, pattern);
    return headingMatch ? chapterTitle(heading, headingMatch, false, pattern) : heading;
  }
  if (!match) return text.trim();
  const suffix = match.length > 3 ? match[3] : match.length > 2 ? match[2] : "";
  return String(suffix || "").replace(/^\s*[:.\-–—]\s*/, "").trim();
}

function isBoundary(paragraph, pattern, kind) {
  const text = paragraph.text.trim();
  return paragraph.style === "Heading1" || paragraph.style === "Title" || (kind === "markdown" && /^#{1,2}\s+/.test(text)) || Boolean(chapterMatch(text, pattern));
}

function isSceneBreak(text, kind, afterBoundary) {
  const value = text.trim();
  if (!BREAKS.has(value)) return false;
  return value !== "---" || kind !== "markdown" || afterBoundary;
}

function finishChapter(chapter, povRule, previousPov) {
  const title = chapter.title;
  const pov = povRule === "none" ? null : title || previousPov || null;
  const scenes = [];
  let current = [];
  const flush = () => {
    const prose = current
      .map(normaliseParagraph)
      .map((paragraph) => chapter.kind === "markdown" ? normaliseMarkdownProse(paragraph) : chapter.kind === "text" ? escapeLiteral(paragraph) : paragraph)
      .filter((paragraph) => paragraph.trim())
      .join("\n\n");
    if (prose) scenes.push({ prose, words: countWords(prose), sha256: sourceSha256(Buffer.from(prose, "utf8")) });
    current = [];
  };
  for (const paragraph of chapter.paragraphs) {
    if (isSceneBreak(paragraph.text, chapter.kind, true)) flush();
    else if (normaliseParagraph(paragraph.text).trim()) current.push(paragraph.text);
  }
  flush();
  return {
    number: chapter.number,
    title,
    pov,
    scenes,
    scene_count: scenes.length,
    words: scenes.reduce((sum, scene) => sum + scene.words, 0)
  };
}

function parseDocument(paragraphs, { kind, sourceFile, pattern, povRule, forceChapter = false }) {
  const boundaries = paragraphs.map((paragraph) => isBoundary(paragraph, pattern, kind));
  const hasBoundary = boundaries.some(Boolean);
  const frontMatter = hasBoundary
    ? paragraphs.slice(0, boundaries.indexOf(true)).map((paragraph) => normaliseParagraph(paragraph.text)).filter(Boolean).join("\n\n")
    : "";
  const chapters = [];
  let current = null;
  let previousPov = null;
  const begin = (paragraph, number) => {
    const text = paragraph.text.trim();
    const markdown = kind === "markdown" && /^#{1,2}\s+/.test(text);
    const match = chapterMatch(text, pattern);
    current = { number, title: chapterTitle(text, match, markdown, pattern), paragraphs: [], kind };
  };
  paragraphs.forEach((paragraph, index) => {
    if (boundaries[index]) {
      if (current) {
        const finished = finishChapter(current, povRule, previousPov);
        if (finished.scenes.length) {
          chapters.push(finished);
          previousPov = finished.pov;
        }
      }
      begin(paragraph, chapters.length + 1);
    } else if (current) {
      current.paragraphs.push(paragraph);
    }
  });
  if (current) {
    const finished = finishChapter(current, povRule, previousPov);
    if (finished.scenes.length) chapters.push(finished);
  }
  if (!hasBoundary && forceChapter) {
    const fallback = finishChapter({ number: 1, title: "", paragraphs, kind }, povRule, previousPov);
    return { front_matter: "", chapters: fallback.scenes.length ? [fallback] : [] };
  }
  return { front_matter: frontMatter, chapters };
}

function readTextFile(path) {
  const bytes = readFileSync(path);
  const text = decodeUtf8(bytes, path);
  const kind = extname(path).toLocaleLowerCase() === ".md" ? "markdown" : "text";
  return { bytes, text, kind };
}

export function readSource(sourcePath, { chapterPattern = DEFAULT_CHAPTER_PATTERN, povRule = "title" } = {}) {
  if (!/^(title|none)$/.test(povRule)) throw new Error(`invalid POV rule: ${povRule}`);
  const source = resolve(sourcePath);
  if (!existsSync(source)) throw new Error(`source does not exist: ${source}`);
  const pattern = makeChapterPattern(chapterPattern);
  const sourceStat = statSync(source);
  if (sourceStat.isDirectory()) {
    const files = readdirSync(source, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:md|txt)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort(naturalCompare);
    const chapters = [];
    const frontMatter = [];
    const hash = createHash("sha256");
    for (const file of files) {
      const path = join(source, file);
      const { bytes, text, kind } = readTextFile(path);
      hash.update(file).update("\0").update(bytes).update("\0");
      const parsed = parseDocument(paragraphsFromText(text, kind), { kind, sourceFile: file, pattern, povRule, forceChapter: true });
      if (parsed.front_matter) frontMatter.push(parsed.front_matter);
      const chapter = parsed.chapters[0];
      if (chapter) {
        chapter.source_file = file;
        chapters.push(chapter);
      }
    }
    let previousPov = null;
    for (const chapter of chapters) {
      chapter.pov = povRule === "none" ? null : chapter.title || previousPov || null;
      previousPov = chapter.pov;
    }
    return {
      kind: "folder",
      sha256: hash.digest("hex"),
      front_matter: frontMatter.join("\n\n"),
      chapters,
      not_imported: { comments: 0, footnotes: 0, endnotes: 0 }
    };
  }
  const bytes = readFileSync(source);
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    const docx = readDocx(bytes, source);
    const parsed = parseDocument(docx.paragraphs, { kind: "docx", sourceFile: basename(source), pattern, povRule, forceChapter: true });
    return { kind: "docx", sha256: sourceSha256(bytes), front_matter: parsed.front_matter, chapters: parsed.chapters, not_imported: docx.notImported };
  }
  const text = decodeUtf8(bytes, source);
  const kind = extname(source).toLocaleLowerCase() === ".md" ? "markdown" : "text";
  const parsed = parseDocument(paragraphsFromText(text, kind), { kind, sourceFile: basename(source), pattern, povRule, forceChapter: true });
  return { kind, sha256: sourceSha256(bytes), front_matter: parsed.front_matter, chapters: parsed.chapters, not_imported: { comments: 0, footnotes: 0, endnotes: 0 } };
}

function sourceState(sourcePath) {
  const source = resolve(sourcePath);
  const stat = statSync(source);
  if (stat.isFile()) {
    const bytes = readFileSync(source);
    return { sha256: sourceSha256(bytes), mtimeMs: stat.mtimeMs, size: stat.size };
  }
  const files = readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:md|txt)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort(naturalCompare);
  const hash = createHash("sha256");
  const children = files.map((file) => {
    const path = join(source, file);
    const childStat = statSync(path);
    const bytes = readFileSync(path);
    hash.update(file).update("\0").update(bytes).update("\0");
    return { file, sha256: sourceSha256(bytes), mtimeMs: childStat.mtimeMs, size: childStat.size };
  });
  return { sha256: hash.digest("hex"), mtimeMs: stat.mtimeMs, children };
}

function assertSourceUnchanged(sourcePath, before) {
  const after = sourceState(sourcePath);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`source changed during import; refusing to write the imported book: ${resolve(sourcePath)}`);
  }
}

function hasSceneFiles(root, project) {
  const manuscript = join(root, project.source_root);
  if (!existsSync(manuscript)) return false;
  return readdirSync(manuscript, { withFileTypes: true }).some((chapter) => {
    if (!chapter.isDirectory() || !/^chapter-\d+$/.test(chapter.name)) return false;
    return readdirSync(join(manuscript, chapter.name), { withFileTypes: true }).some((scene) => (
      scene.isDirectory() && /^scene-\d+$/.test(scene.name) && existsSync(join(manuscript, chapter.name, scene.name, "scene.md"))
    ));
  });
}

function sourceFileName(sourcePath) {
  return basename(resolve(sourcePath));
}

function sceneFile(chapter, scene, sourceFile, importedAt) {
  const pov = chapter.pov || "";
  return `**POV:** ${pov}\n**Source:** ${sourceFile}\n**Imported:** ${importedAt}\n**Status:** Imported\n\n---\n\n${scene.prose}\n\n---\n\n**Words:** ${scene.words}\n`;
}

export function importBook(root, project, sourcePath, { chapterPattern = DEFAULT_CHAPTER_PATTERN, povRule = "title", importedAt = new Date().toISOString() } = {}) {
  if (hasSceneFiles(root, project)) {
    throw new Error("refusing import: this book already contains scene files; import only into an empty book");
  }
  const before = sourceState(sourcePath);
  const source = readSource(sourcePath, { chapterPattern, povRule });
  assertSourceUnchanged(sourcePath, before);
  if (!source.chapters.length) throw new Error("source contains no chapters with prose");
  const file = sourceFileName(sourcePath);
  const chapters = source.chapters.map((chapter, index) => ({ ...chapter, number: index + 1, source_file: chapter.source_file || file }));
  const totals = {
    chapters: chapters.length,
    scenes: chapters.reduce((sum, chapter) => sum + chapter.scenes.length, 0),
    words: chapters.reduce((sum, chapter) => sum + chapter.words, 0)
  };
  const record = {
    $schema: `${SCHEMA_BASE}import-1.json`,
    generator: GENERATOR,
    version: VERSION,
    imported_at: importedAt,
    source: { file, sha256: source.sha256, kind: source.kind },
    front_matter: source.front_matter,
    not_imported: source.not_imported || { comments: 0, footnotes: 0, endnotes: 0 },
    pov_rule: povRule,
    chapter_pattern: chapterPattern,
    chapters: chapters.map((chapter) => ({
      number: chapter.number,
      title: chapter.title,
      pov: chapter.pov,
      scenes: chapter.scenes.map((scene, sceneIndex) => ({ number: sceneIndex + 1, prose: scene.prose, words: scene.words, sha256: scene.sha256 })),
      scene_count: chapter.scenes.length,
      words: chapter.words
    })),
    totals
  };
  if (!totals.scenes) throw new Error("source contains no prose scenes");
  const manuscript = join(root, project.source_root);
  const chapterWidth = Math.max(2, String(chapters.length).length);
  for (const chapter of chapters) {
    const sceneWidth = Math.max(2, String(chapter.scenes.length).length);
    for (const [sceneIndex, scene] of chapter.scenes.entries()) {
      const path = join(manuscript, `chapter-${String(chapter.number).padStart(chapterWidth, "0")}`, `scene-${String(sceneIndex + 1).padStart(sceneWidth, "0")}`, "scene.md");
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, sceneFile(chapter, scene, chapter.source_file, importedAt));
    }
  }
  const nextProject = {
    ...project,
    chapters: Object.fromEntries(chapters.map((chapter) => [String(chapter.number), chapter.title || `Chapter ${chapter.number}`])),
    source_book: {
      file,
      sha256: source.sha256,
      kind: source.kind,
      imported_at: importedAt,
      chapters: totals.chapters,
      scenes: totals.scenes,
      words: totals.words,
      pov_rule: povRule
    }
  };
  writeFileSync(join(root, "project.json"), `${JSON.stringify(nextProject, null, 2)}\n`);
  const imports = join(root, "imports");
  mkdirSync(imports, { recursive: true });
  const importPath = join(imports, `${importedAt.slice(0, 10)}-${source.sha256.slice(0, 12)}.json`);
  writeFileSync(importPath, `${JSON.stringify(record, null, 2)}\n`);
  assertSourceUnchanged(sourcePath, before);
  return { record, importPath, project: nextProject };
}
