// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  assembleMarkdown,
  countWords,
  extractProse,
  findHighSeverityDuplicates,
  loadScenes,
  validateCriticalPath
} from "../engine/manuscript.mjs";
import { readProject } from "../engine/project.mjs";

const ROOT = resolve("templates/book");
const project = readProject(ROOT);

test("starter project has one canonical scene and valid critical path", () => {
  const scenes = loadScenes(ROOT, project);
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].id, "1-1");
  assert.equal(scenes[0].words, 20);
  assert.equal(validateCriticalPath(ROOT, scenes).ok, true);
});

test("reader assembly excludes scene metadata", () => {
  const markdown = assembleMarkdown(project, loadScenes(ROOT, project), "test-release");
  assert.match(markdown, /pressure the protagonist cannot ignore/);
  assert.doesNotMatch(markdown, /\*\*POV:\*\*/);
  assert.doesNotMatch(markdown, /\*\*Status:\*\*/);
});

test("prose extraction requires two separators", () => {
  assert.equal(extractProse("Header\n---\nBody\n---\nFooter"), "Body");
  assert.throws(() => extractProse("No separators"), /expected metadata and footer separators/);
  assert.equal(countWords("One careful sentence, isn't it?"), 5);
});

test("duplicate detector catches a cross-scene near-copy", () => {
  const sentence = "The old bridge trembled under every deliberate step they took toward home.";
  const duplicates = findHighSeverityDuplicates([
    { id: "1-1", prose: sentence },
    { id: "1-2", prose: sentence }
  ]);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].similarity, 1);
});
