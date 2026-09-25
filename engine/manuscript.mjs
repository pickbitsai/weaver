// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function extractProse(text, source = "scene") {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const separators = lines.flatMap((line, index) => line.trim() === "---" ? [index] : []);
  if (separators.length < 2) {
    throw new Error(`${source}: expected metadata and footer separators`);
  }
  return lines.slice(separators[0] + 1, separators.at(-1)).join("\n").trim();
}

export function countWords(text) {
  return text.match(/[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*/gu)?.length || 0;
}

export function loadScenes(root, project) {
  const manuscriptRoot = join(root, project.source_root);
  if (!existsSync(manuscriptRoot)) throw new Error(`missing source root: ${project.source_root}`);
  const scenes = [];
  for (const chapterName of readdirSync(manuscriptRoot)) {
    const chapterMatch = /^chapter-(\d+)$/.exec(chapterName);
    if (!chapterMatch) continue;
    const chapterPath = join(manuscriptRoot, chapterName);
    if (!statSync(chapterPath).isDirectory()) continue;
    for (const sceneName of readdirSync(chapterPath)) {
      const sceneMatch = /^scene-(\d+)$/.exec(sceneName);
      if (!sceneMatch) continue;
      const path = join(chapterPath, sceneName, "scene.md");
      if (!existsSync(path)) continue;
      const raw = readFileSync(path, "utf8");
      const prose = extractProse(raw, relative(root, path));
      const chapter = Number(chapterMatch[1]);
      const scene = Number(sceneMatch[1]);
      scenes.push({
        chapter,
        scene,
        id: `${chapter}-${scene}`,
        path,
        relativePath: relative(root, path).replaceAll("\\", "/"),
        prose,
        words: countWords(prose),
        hash: sha256(prose)
      });
    }
  }
  scenes.sort((a, b) => a.chapter - b.chapter || a.scene - b.scene);
  if (!scenes.length) throw new Error("no canonical scenes found");
  const seen = new Set();
  for (const scene of scenes) {
    if (seen.has(scene.id)) throw new Error(`duplicate scene ${scene.id}`);
    seen.add(scene.id);
  }
  return scenes;
}

export function manuscriptHash(scenes) {
  return sha256(scenes.map((scene) => `${scene.relativePath}:${scene.hash}`).join("\n"));
}

export function assembleMarkdown(project, scenes, releaseId) {
  const lines = [
    `# ${project.title}`,
    "",
    ...(project.author ? [`By ${project.author}`, ""] : []),
    "Reader Edition",
    "",
    `Release: ${releaseId}`,
    "",
    "---",
    ""
  ];
  let activeChapter = null;
  for (const scene of scenes) {
    if (scene.chapter !== activeChapter) {
      activeChapter = scene.chapter;
      const title = project.chapters?.[String(activeChapter)];
      lines.push(`# Chapter ${activeChapter}${title ? `: ${title}` : ""}`, "");
    } else {
      lines.push("* * *", "");
    }
    lines.push(scene.prose, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function findHighSeverityDuplicates(scenes, threshold = 0.7, minWords = 10) {
  const records = [];
  for (const scene of scenes) {
    for (const paragraph of scene.prose.split(/\n\s*\n/)) {
      for (const sentence of paragraph.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/)) {
        const words = sentence.toLocaleLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
        if (words.length < minWords) continue;
        const shingles = new Set();
        for (let index = 0; index <= words.length - 5; index += 1) {
          shingles.add(words.slice(index, index + 5).join(" "));
        }
        records.push({ scene: scene.id, sentence: sentence.trim(), shingles });
      }
    }
  }
  const inverted = new Map();
  records.forEach((record, index) => {
    for (const shingle of record.shingles) {
      if (!inverted.has(shingle)) inverted.set(shingle, []);
      inverted.get(shingle).push(index);
    }
  });
  const compared = new Set();
  const duplicates = [];
  for (const indexes of inverted.values()) {
    for (let left = 0; left < indexes.length; left += 1) {
      for (let right = left + 1; right < indexes.length; right += 1) {
        const aIndex = indexes[left];
        const bIndex = indexes[right];
        const key = `${aIndex}:${bIndex}`;
        if (compared.has(key)) continue;
        compared.add(key);
        const earlier = records[aIndex];
        const later = records[bIndex];
        if (earlier.scene === later.scene) continue;
        const intersection = [...earlier.shingles].filter((value) => later.shingles.has(value)).length;
        const union = new Set([...earlier.shingles, ...later.shingles]).size;
        const similarity = union ? intersection / union : 0;
        if (similarity >= threshold) {
          duplicates.push({
            similarity: Number(similarity.toFixed(3)),
            earlier: { scene: earlier.scene, sentence: earlier.sentence },
            later: { scene: later.scene, sentence: later.sentence }
          });
        }
      }
    }
  }
  return duplicates.sort((a, b) => b.similarity - a.similarity);
}

export function validateCriticalPath(root, scenes) {
  const path = join(root, "quality", "critical-path.json");
  if (!existsSync(path)) return { ok: true, skipped: true, total: 0, intact: 0, missing: [] };
  const beats = JSON.parse(readFileSync(path, "utf8")).beats || [];
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  const missing = beats.filter((beat) => {
    const scene = byId.get(String(beat.scene));
    return !scene || !scene.prose.toLocaleLowerCase().includes(String(beat.anchor).toLocaleLowerCase());
  }).map((beat) => ({ id: beat.id, scene: beat.scene, anchor: beat.anchor }));
  return { ok: missing.length === 0, skipped: false, total: beats.length, intact: beats.length - missing.length, missing };
}

export function filterIntentionalEchoes(root, duplicates) {
  const path = join(root, "quality", "intentional-echoes.json");
  const intentional = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8")).intentional_echoes || []
    : [];
  return duplicates.filter((duplicate) => !intentional.some((entry) => {
    const actualScenes = [duplicate.earlier.scene, duplicate.later.scene].sort().join(":");
    const allowedScenes = [...entry.scenes].map(String).sort().join(":");
    const combined = `${duplicate.earlier.sentence}\n${duplicate.later.sentence}`.toLocaleLowerCase();
    return actualScenes === allowedScenes && combined.includes(String(entry.contains).toLocaleLowerCase());
  }));
}
