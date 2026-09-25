// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assembleMarkdown,
  filterIntentionalEchoes,
  findHighSeverityDuplicates,
  loadScenes,
  manuscriptHash,
  validateCriticalPath
} from "./manuscript.mjs";
import { narrativeStateStatus, readStateManifest, statePath } from "./state.mjs";
import { GENERATOR, HOMEPAGE, LICENSE_ID, PRODUCT_NAME, SCHEMA_BASE, VERSION } from "./identity.mjs";
import { runRules } from "./rules.mjs";

const RELEASE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const escapeHtml = (value) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

export function runQualityChecks(root, project) {
  const scenes = loadScenes(root, project);
  const criticalPath = project.source_book && !existsSync(join(root, "quality", "critical-path.json"))
    ? { ok: true, skipped: true, total: 0, intact: 0, missing: [] }
    : validateCriticalPath(root, scenes);
  const duplicates = findHighSeverityDuplicates(scenes);
  const unapprovedDuplicates = filterIntentionalEchoes(root, duplicates);
  const state = narrativeStateStatus(root, project);
  const rules = runRules(root, project);
  const issues = [];
  if (!criticalPath.ok) issues.push(`critical-path gate failed (${criticalPath.missing.length} missing)`);
  if (unapprovedDuplicates.length) issues.push(`repetition gate failed (${unapprovedDuplicates.length} unapproved duplicate(s))`);
  if (project.require_current_state_for_release && state.stale) {
    issues.push(`narrative state is stale from scene ${state.first_stale}`);
  }
  if (rules.blocking) issues.push(`style rules: ${rules.blocking} blocking finding(s)`);
  return { ok: issues.length === 0, issues, scenes, criticalPath, duplicates, unapprovedDuplicates, state, rules };
}

function assembleHtml(project, scenes, releaseId) {
  const sections = scenes.map((scene, index) => {
    const previous = scenes[index - 1];
    const next = scenes[index + 1];
    const opening = !previous || previous.chapter !== scene.chapter
      ? `<section class="chapter"><h1>Chapter ${scene.chapter}${project.chapters?.[String(scene.chapter)] ? `: ${escapeHtml(project.chapters[String(scene.chapter)])}` : ""}</h1>`
      : '<div class="scene-break">* * *</div>';
    const prose = scene.prose.split(/\n\s*\n/).filter(Boolean).map((paragraph) => {
      const text = escapeHtml(paragraph.replace(/\s*\n\s*/g, " "));
      return `<p>${text.replace(/\*([^*]+)\*/g, "<em>$1</em>")}</p>`;
    }).join("\n");
    return `${opening}\n${prose}${!next || next.chapter !== scene.chapter ? "</section>" : ""}`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="${escapeHtml(GENERATOR)}">
<title>${escapeHtml(project.title)} — ${escapeHtml(releaseId)}</title>
<style>
@page{size:letter;margin:1in}
body{max-width:6.5in;margin:0 auto;color:#111;font:12pt/2 Georgia,"Times New Roman",serif}
.cover{height:8.5in;display:flex;flex-direction:column;justify-content:center;text-align:center;break-after:page}
.cover h1{font-size:28pt}.chapter{break-before:page}.chapter h1{text-align:center;margin:1in 0 .65in;font-size:18pt}
p{margin:0;text-indent:.5in}.scene-break{text-align:center;margin:.35in 0}
@media screen{body{padding:1in}.cover{height:8in}}
</style>
</head>
<body>
<section class="cover"><h1>${escapeHtml(project.title)}</h1>${project.author ? `<p>By ${escapeHtml(project.author)}</p>` : ""}<p>Reader Edition</p><p>Release ${escapeHtml(releaseId)}</p></section>
${sections}
</body>
</html>
`;
}

export function buildRelease(root, project, releaseId, { force = false } = {}) {
  if (!RELEASE_ID_PATTERN.test(releaseId || "")) {
    throw new Error("release id must use lowercase letters, numbers, and hyphens");
  }
  const checks = runQualityChecks(root, project);
  if (!checks.ok) throw new Error(`release gates failed:\n- ${checks.issues.join("\n- ")}`);
  const sourceSha256 = manuscriptHash(checks.scenes);
  const releaseDir = join(root, project.release_root, releaseId);
  const manifestPath = join(releaseDir, "release-manifest.json");
  if (existsSync(manifestPath) && !force) {
    const existing = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (existing.source.sha256 !== sourceSha256) {
      throw new Error(`release ${releaseId} already exists for a different manuscript hash; choose a new release id`);
    }
    return existing;
  }
  mkdirSync(releaseDir, { recursive: true });
  const stem = `${project.project_id}-${releaseId}`;
  const markdownPath = join(releaseDir, `${stem}.md`);
  const htmlPath = join(releaseDir, `${stem}.html`);
  writeFileSync(markdownPath, assembleMarkdown(project, checks.scenes, releaseId));
  writeFileSync(htmlPath, assembleHtml(project, checks.scenes, releaseId));
  const artifactPaths = [markdownPath, htmlPath];
  const scenesDir = join(releaseDir, "scenes");
  mkdirSync(scenesDir, { recursive: true });
  for (const scene of checks.scenes) {
    const path = join(scenesDir, `${scene.id}.md`);
    writeFileSync(path, `${scene.prose}\n`);
    artifactPaths.push(path);
  }
  for (const scene of checks.scenes) {
    const source = statePath(root, project, scene.id);
    if (!existsSync(source)) continue;
    const directory = join(releaseDir, "narrative-state");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${scene.id}.md`);
    copyFileSync(source, path);
    artifactPaths.push(path);
  }
  const createdAt = new Date().toISOString();
  const provenancePath = join(releaseDir, "provenance.json");
  writeFileSync(provenancePath, `${JSON.stringify({
    $schema: `${SCHEMA_BASE}provenance-1.json`,
    generator: GENERATOR,
    product: PRODUCT_NAME,
    version: VERSION,
    license: LICENSE_ID,
    homepage: HOMEPAGE,
    project_id: project.project_id,
    release_id: releaseId,
    created_at: createdAt
  }, null, 2)}\n`);
  artifactPaths.push(provenancePath);
  const artifacts = artifactPaths.map((path) => {
    const bytes = readFileSync(path);
    return {
      file: path.slice(releaseDir.length + 1).replaceAll("\\", "/"),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  });
  const stateManifest = join(root, project.state_root, "manifest.json");
  const manifest = {
    schema_version: 2,
    project_id: project.project_id,
    release_id: releaseId,
    lifecycle: "review-candidate",
    created_at: createdAt,
    source: {
      scene_count: checks.scenes.length,
      chapter_count: new Set(checks.scenes.map((scene) => scene.chapter)).size,
      words: checks.scenes.reduce((sum, scene) => sum + scene.words, 0),
      sha256: sourceSha256,
      scenes: checks.scenes.map((scene) => ({
        id: scene.id,
        chapter: scene.chapter,
        scene: scene.scene,
        path: scene.relativePath,
        words: scene.words,
        sha256: scene.hash
      }))
    },
    gates: {
      critical_path: checks.criticalPath,
      unapproved_high_similarity_duplicates: checks.unapprovedDuplicates.length,
      narrative_state_stale: checks.state.stale
    },
    narrative_state: existsSync(stateManifest) ? readStateManifest(root, project) : null,
    artifacts
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
