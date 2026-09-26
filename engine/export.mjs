// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { loadScenes } from "./manuscript.mjs";
import { GENERATOR } from "./identity.mjs";
import { parseEscapedProse } from "./prose.mjs";

const DOS_TIME = 0;
const DOS_DATE = 33;
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const result = Buffer.alloc(2);
  result.writeUInt16LE(value, 0);
  return result;
}

function u32(value) {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value >>> 0, 0);
  return result;
}

export function zipEntries(entries, { method = "deflate", compression = null } = {}) {
  const pairs = entries instanceof Map ? [...entries.entries()] : Array.isArray(entries) ? entries : Object.entries(entries);
  method = compression || method;
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, input] of pairs) {
    const filename = Buffer.from(name, "utf8");
    const content = Buffer.from(input);
    if (method !== "deflate" && method !== "stored") throw new Error(`unsupported ZIP method: ${method}`);
    const compressed = method === "stored" ? content : deflateRawSync(content, { level: 9 });
    const checksum = crc32(content);
    const localHeader = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(method === "stored" ? 0 : 8), u16(DOS_TIME), u16(DOS_DATE), u32(checksum),
      u32(compressed.length), u32(content.length), u16(filename.length), u16(0), filename, compressed
    ]);
    local.push(localHeader);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(method === "stored" ? 0 : 8), u16(DOS_TIME), u16(DOS_DATE), u32(checksum),
      u32(compressed.length), u32(content.length), u16(filename.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), filename
    ]));
    offset += localHeader.length;
  }
  const localBytes = Buffer.concat(local);
  const centralBytes = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(pairs.length), u16(pairs.length), u32(centralBytes.length), u32(localBytes.length), u16(0)
  ]);
  return Buffer.concat([localBytes, centralBytes, end]);
}

export const writeZip = zipEntries;

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function textRun(text, italic = false) {
  if (!text) return "";
  const properties = italic ? "<w:rPr><w:i/></w:rPr>" : "";
  const chunks = text.split(/([\t\n])/);
  const body = chunks.map((chunk) => {
    if (chunk === "\t") return "<w:tab/>";
    if (chunk === "\n") return "<w:br/>";
    return chunk ? `<w:t xml:space="preserve">${xmlEscape(chunk)}</w:t>` : "";
  }).join("");
  return `<w:r>${properties}${body}</w:r>`;
}

function markdownRuns(prose) {
  return parseEscapedProse(prose).map((token) => textRun(token.text, token.italic)).join("");
}

function paragraph(text, style = "Normal", alignment = null, runs = null) {
  const properties = [style ? `<w:pStyle w:val="${style}"/>` : "", alignment ? `<w:jc w:val="${alignment}"/>` : ""].join("");
  return `<w:p><w:pPr>${properties}</w:pPr>${runs || markdownRuns(text)}</w:p>`;
}

function chapterHeading(project, chapter) {
  const title = project.chapters?.[String(chapter)];
  return `Chapter ${chapter}${title && title !== `Chapter ${chapter}` ? `: ${title}` : ""}`;
}

function documentXml(project, scenes) {
  const body = [paragraph(project.title, "Title", "center", textRun(project.title))];
  if (project.author) body.push(paragraph(`By ${project.author}`, "Normal", "center", textRun(`By ${project.author}`)));
  let activeChapter = null;
  for (const scene of scenes) {
    if (scene.chapter !== activeChapter) {
      activeChapter = scene.chapter;
      const heading = chapterHeading(project, activeChapter);
      body.push(paragraph(heading, "Heading1", "center", textRun(heading)));
    } else {
      body.push(paragraph("* * *", "Normal", "center", textRun("* * *")));
    }
    for (const proseParagraph of scene.prose.split(/\n\s*\n/).filter(Boolean)) {
      body.push(paragraph(proseParagraph.replace(/\n/g, "\n")));
    }
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>`;
}

function contentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
}

function relationshipsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
}

function documentRelationshipsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function coreXml(project) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEscape(project.title)}</dc:title><dc:creator>${xmlEscape(project.author || "")}</dc:creator></cp:coreProperties>`;
}

function appXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${xmlEscape(GENERATOR)}</Application></Properties>`;
}

export function buildDocx(project, scenes) {
  const entries = [
    ["[Content_Types].xml", contentTypesXml()],
    ["_rels/.rels", relationshipsXml()],
    ["word/document.xml", documentXml(project, scenes)],
    ["word/styles.xml", stylesXml()],
    ["word/_rels/document.xml.rels", documentRelationshipsXml()],
    ["docProps/core.xml", coreXml(project)],
    ["docProps/app.xml", appXml()]
  ];
  return zipEntries(entries);
}

export function assembleExportMarkdown(project, scenes) {
  const lines = [`# ${project.title}`, ""];
  let activeChapter = null;
  for (const scene of scenes) {
    if (scene.chapter !== activeChapter) {
      activeChapter = scene.chapter;
      lines.push(`## ${chapterHeading(project, activeChapter)}`, "");
    } else {
      lines.push("* * *", "");
    }
    lines.push(scene.prose, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function recordedSourceTarget(root, project, outPath) {
  if (!project.source_book?.file) return false;
  return resolve(outPath).endsWith(`\\${project.source_book.file}`) || resolve(outPath).endsWith(`/${project.source_book.file}`);
}

export function exportBook(root, project, format, outPath) {
  if (!/^(md|docx)$/.test(format || "")) throw new Error("export format must be md or docx");
  if (!outPath) throw new Error("export requires --out <file>");
  const destination = resolve(outPath);
  if (existsSync(destination)) throw new Error(`refusing to overwrite export file: ${destination}`);
  if (recordedSourceTarget(root, project, destination)) throw new Error("refusing to export onto the recorded source file name");
  const scenes = loadScenes(root, project);
  const bytes = format === "docx"
    ? buildDocx(project, scenes)
    : Buffer.from(assembleExportMarkdown(project, scenes), "utf8");
  writeFileSync(destination, bytes);
  return { format, out: destination, bytes: bytes.length };
}
