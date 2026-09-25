// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import test from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportBook, zipEntries } from "../engine/export.mjs";
import { importBook, readSource } from "../engine/import.mjs";
import { initializeProject } from "../engine/init.mjs";
import { countWords, loadScenes } from "../engine/manuscript.mjs";
import { readProject } from "../engine/project.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Chapter 1: Liese</w:t></w:r></w:p>
<w:p><w:r><w:t>Curly “quotes” &amp; em — dash.</w:t><w:tab/><w:t>Tab</w:t></w:r></w:p>
<w:p><w:r><w:i/><w:t>Italic words</w:t></w:r><w:r><w:t> stay.</w:t></w:r></w:p>
<w:p><w:r><w:t>Keep accepted text.</w:t></w:r></w:p>
<w:p><w:r><w:t>* * *</w:t></w:r></w:p>
<w:p><w:r><w:t>Second scene.</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter 4</w:t></w:r></w:p>
<w:p><w:r><w:t>Untitled chapter prose.</w:t></w:r></w:p>
</w:body></w:document>`;

const TRACKED_DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Chapter 1</w:t></w:r></w:p>
<w:p><w:ins w:id="1"><w:r><w:t>inserted</w:t></w:r></w:ins><w:del w:id="2"><w:r><w:delText>deleted</w:delText></w:r></w:del></w:p>
</w:body></w:document>`;

const COMMENTS_XML = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0"/><w:comment w:id="1"/><w:comment w:id="2"/></w:comments>`;
const FOOTNOTES_XML = `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:type="separator" w:id="-1"/><w:footnote w:type="continuationSeparator" w:id="0"/><w:footnote w:id="1"/></w:footnotes>`;
const ENDNOTES_XML = `<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:endnote w:type="separator" w:id="-1"/></w:endnotes>`;

function gitInit(root) {
  const result = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function book(empty = true) {
  const root = mkdtempSync(join(tmpdir(), "weaver-repair-"));
  initializeProject(root, { projectId: "repair-book", title: "Repair Book", empty });
  gitInit(root);
  return root;
}

function fixture(root, method = "deflate", xml = DOCUMENT_XML, name = "finished") {
  const path = join(root, `${name}-${method}.docx`);
  writeFileSync(path, zipEntries([["word/document.xml", xml]], { method }));
  return path;
}

function zipText(bytes, wanted) {
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    const content = bytes.subarray(start, start + compressedSize);
    if (name === wanted) return (method === 0 ? content : inflateRawSync(content)).toString("utf8");
    offset = start + compressedSize;
  }
  throw new Error(`missing ZIP entry: ${wanted}`);
}

test("DOCX import reads deflate and stored ZIPs, preserves prose, and records POV carry-forward", () => {
  const root = book();
  try {
    for (const method of ["deflate", "stored"]) {
      const source = fixture(root, method);
      const parsed = readSource(source);
      assert.equal(parsed.kind, "docx");
      assert.deepEqual(parsed.chapters.map((chapter) => ({ title: chapter.title, pov: chapter.pov, scenes: chapter.scene_count })), [
        { title: "Liese", pov: "Liese", scenes: 2 },
        { title: "", pov: "Liese", scenes: 1 }
      ]);
      assert.match(parsed.chapters[0].scenes[0].prose, /em — dash/);
      assert.match(parsed.chapters[0].scenes[0].prose, /\*Italic words\*/);
      assert.match(parsed.chapters[0].scenes[0].prose, /Keep accepted text/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("literal asterisks survive Markdown to DOCX and back without false italics", () => {
  const root = book();
  const second = book();
  const source = join(root, "source.md");
  try {
    writeFileSync(source, "# Chapter 1\n\nHe said, \"Get the f*** out,\" and 5 * 3 made fifteen.\n");
    importBook(root, readProject(root), source, { importedAt: "2026-09-25T00:00:00.000Z" });
    const expected = 'He said, "Get the f\\*\\*\\* out," and 5 \\* 3 made fifteen.';
    assert.equal(loadScenes(root, readProject(root))[0].prose, expected);
    const exported = join(root, "round-trip.docx");
    exportBook(root, readProject(root), "docx", exported);
    const xml = zipText(readFileSync(exported), "word/document.xml");
    assert.match(xml, /f\*\*\* out/);
    assert.match(xml, /5 \* 3/);
    assert.doesNotMatch(xml, /f\*\*<w:r><w:rPr><w:i\/>/);
    importBook(second, readProject(second), exported, { importedAt: "2026-09-25T00:00:00.000Z" });
    assert.equal(loadScenes(second, readProject(second))[0].prose, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("scene breaks are literal centered paragraphs and titles use Title style", () => {
  const root = book();
  const source = join(root, "source.md");
  try {
    writeFileSync(source, "# Chapter 1\n\nOne scene.\n\n* * *\n\nTwo scene.\n");
    importBook(root, readProject(root), source);
    const exported = join(root, "scene-break.docx");
    exportBook(root, readProject(root), "docx", exported);
    const xml = zipText(readFileSync(exported), "word/document.xml");
    assert.match(xml, /<w:p><w:pPr><w:pStyle w:val="Title"\/><w:jc w:val="center"\/><\/w:pPr><w:r><w:t xml:space="preserve">Repair Book<\/w:t><\/w:r><\/w:p>/);
    assert.match(xml, /<w:p><w:pPr><w:pStyle w:val="Normal"\/><w:jc w:val="center"\/><\/w:pPr><w:r><w:t xml:space="preserve">\* \* \*<\/w:t><\/w:r><\/w:p>/);
    assert.doesNotMatch(xml, /<w:t xml:space="preserve">\* \* \*<\/w:t><\/w:r><w:rPr><w:i/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("text imports escape stars and mixed DOCX italics merge across runs", () => {
  const textRoot = book();
  const docxRoot = book();
  try {
    const text = join(textRoot, "stars.txt");
    writeFileSync(text, "Chapter 1\n\n**stars** and \\slash.\n");
    importBook(textRoot, readProject(textRoot), text);
    assert.equal(loadScenes(textRoot, readProject(textRoot))[0].prose, "\\*\\*stars\\*\\* and \\\\slash.");
    const mixedXml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Chapter 1</w:t></w:r></w:p><w:p><w:r><w:rPr><w:i/></w:rPr><w:t>Not </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>yet,</w:t></w:r><w:r><w:t> she saw f*** and 5 * 3.</w:t></w:r></w:p></w:body></w:document>`;
    const source = fixture(docxRoot, "deflate", mixedXml, "mixed");
    const parsed = readSource(source);
    assert.equal(parsed.chapters[0].scenes[0].prose, "*Not yet,* she saw f\\*\\*\\* and 5 \\* 3.");
    const expected = parsed.chapters[0].scenes[0].prose;
    importBook(docxRoot, readProject(docxRoot), source);
    const exported = join(docxRoot, "mixed-export.docx");
    exportBook(docxRoot, readProject(docxRoot), "docx", exported);
    assert.equal(readSource(exported).chapters[0].scenes[0].prose, expected);
  } finally {
    rmSync(textRoot, { recursive: true, force: true });
    rmSync(docxRoot, { recursive: true, force: true });
  }
});

test("tracked changes refuse import and leave the book untouched", () => {
  const root = book();
  try {
    const source = fixture(root, "deflate", TRACKED_DOCUMENT_XML, "tracked");
    assert.throws(() => importBook(root, readProject(root), source), /Your Word file still has tracked changes\. Open it in Word, accept or reject all changes \(Review → Accept \/ Reject\), save, and import again\./);
    assert.equal(existsSync(join(root, "imports")), false);
    assert.equal(existsSync(join(root, "manuscript", "chapter-01")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import records and reports comments, footnotes, and endnotes left out", () => {
  const root = book();
  try {
    const source = join(root, "annotated.docx");
    writeFileSync(source, zipEntries([
      ["word/document.xml", DOCUMENT_XML],
      ["word/comments.xml", COMMENTS_XML],
      ["word/footnotes.xml", FOOTNOTES_XML],
      ["word/endnotes.xml", ENDNOTES_XML]
    ]));
    const result = spawnSync(process.execPath, [join(ROOT, "scripts", "weaver.mjs"), "import", source, "--root", root], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /Not imported: 3 comments, 1 footnote\./);
    const record = JSON.parse(readFileSync(join(root, "imports", readdirSync(join(root, "imports"))[0]), "utf8"));
    assert.deepEqual(record.not_imported, { comments: 3, footnotes: 1, endnotes: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("escaped stars do not change word counts", () => {
  assert.equal(countWords("f\\*\\*\\*"), 1);
});

test("import/export round trip is byte-safe for scene prose and leaves source untouched", () => {
  const root = book();
  const second = book();
  try {
    const source = fixture(root);
    const before = readFileSync(source);
    const mtime = statSync(source).mtimeMs;
    const imported = importBook(root, readProject(root), source, { importedAt: "2026-09-25T00:00:00.000Z" });
    assert.equal(Buffer.compare(before, readFileSync(source)), 0);
    assert.equal(statSync(source).mtimeMs, mtime);
    assert.equal(imported.record.totals.scenes, 3);
    const exported = join(root, "repaired.docx");
    exportBook(root, readProject(root), "docx", exported);
    assert.equal(readFileSync(exported).subarray(0, 4).toString("hex"), "504b0304");
    importBook(second, readProject(second), exported, { importedAt: "2026-09-25T00:00:00.000Z" });
    assert.deepEqual(loadScenes(root, readProject(root)).map((scene) => scene.prose), loadScenes(second, readProject(second)).map((scene) => scene.prose));
    assert.throws(() => exportBook(root, readProject(root), "docx", exported), /overwrite/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("import refuses existing scenes and the CLI doctor gate refuses a non-Git book", () => {
  const existing = book(false);
  const noGit = book();
  try {
    const source = fixture(existing);
    assert.throws(() => importBook(existing, readProject(existing), source), /already contains scene files/);
    assert.equal(existsSync(join(existing, "imports")), false);
    rmSync(join(noGit, ".git"), { recursive: true, force: true });
    const result = spawnSync(process.execPath, [join(ROOT, "scripts", "weaver.mjs"), "import", source, "--root", noGit], {
      cwd: ROOT,
      encoding: "utf8"
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Your book folder is not under Git/);
    assert.equal(existsSync(join(noGit, "imports")), false);
  } finally {
    rmSync(existing, { recursive: true, force: true });
    rmSync(noGit, { recursive: true, force: true });
  }
});

test("Markdown and folder sources are deterministic in chapter order", () => {
  const root = book();
  const source = mkdtempSync(join(tmpdir(), "weaver-source-"));
  try {
    writeFileSync(join(source, "chapter-10.txt"), "Chapter 10\n\nTen.");
    writeFileSync(join(source, "chapter-2.md"), "# Liese\n\nTwo.");
    const parsed = readSource(source);
    assert.deepEqual(parsed.chapters.map((chapter) => chapter.title), ["Liese", ""]);
    assert.deepEqual(parsed.chapters.map((chapter) => chapter.pov), ["Liese", "Liese"]);
    importBook(root, readProject(root), source, { importedAt: "2026-09-25T00:00:00.000Z" });
    assert.deepEqual(loadScenes(root, readProject(root)).map((scene) => scene.chapter), [1, 2]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});
