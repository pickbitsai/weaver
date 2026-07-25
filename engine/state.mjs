import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadScenes, sha256 } from "./manuscript.mjs";

const EMPTY_UPSTREAM = sha256("weaver:narrative-state:root");

export function statePath(root, project, sceneId) {
  return join(root, project.state_root, `${sceneId}.md`);
}

export function stateManifestPath(root, project) {
  return join(root, project.state_root, "manifest.json");
}

export function readStateManifest(root, project) {
  const path = stateManifestPath(root, project);
  if (!existsSync(path)) return { version: 1, project_id: project.project_id, scenes: {} };
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.version !== 1 || manifest.project_id !== project.project_id || !manifest.scenes) {
    throw new Error(`invalid narrative-state manifest: ${path}`);
  }
  return manifest;
}

function currentInputs(root, project, scene, upstreamSha256) {
  const path = statePath(root, project, scene.id);
  if (!existsSync(path)) return null;
  const stateSha256 = sha256(readFileSync(path));
  return {
    source_sha256: scene.hash,
    state_sha256: stateSha256,
    upstream_sha256: upstreamSha256,
    dependency_sha256: sha256(`${upstreamSha256}:${scene.hash}:${stateSha256}`)
  };
}

export function narrativeStateStatus(root, project) {
  const scenes = loadScenes(root, project);
  const manifest = readStateManifest(root, project);
  const records = [];
  let upstreamSha256 = EMPTY_UPSTREAM;
  let upstreamStale = false;
  for (const scene of scenes) {
    const inputs = currentInputs(root, project, scene, upstreamSha256);
    const accepted = manifest.scenes[scene.id];
    let reason = null;
    if (upstreamStale) reason = "upstream-stale";
    else if (!inputs) reason = "missing-state";
    else if (!accepted) reason = "unaccepted-state";
    else if (accepted.source_sha256 !== inputs.source_sha256) reason = "source-changed";
    else if (accepted.state_sha256 !== inputs.state_sha256) reason = "state-changed";
    else if (accepted.upstream_sha256 !== inputs.upstream_sha256) reason = "dependency-changed";
    else if (accepted.dependency_sha256 !== inputs.dependency_sha256) reason = "invalid-stamp";
    const current = reason === null;
    records.push({ scene: scene.id, current, reason, source_sha256: scene.hash });
    if (!current) upstreamStale = true;
    upstreamSha256 = inputs?.dependency_sha256 || sha256(`${upstreamSha256}:${scene.hash}:missing-state`);
  }
  return {
    current: records.filter((record) => record.current).length,
    stale: records.filter((record) => !record.current).length,
    first_stale: records.find((record) => !record.current)?.scene || null,
    records
  };
}

export function acceptNarrativeState(root, project, throughSceneId = null) {
  const scenes = loadScenes(root, project);
  const manifest = readStateManifest(root, project);
  const targetIndex = throughSceneId
    ? scenes.findIndex((scene) => scene.id === throughSceneId)
    : scenes.length - 1;
  if (targetIndex < 0) throw new Error(`unknown scene: ${throughSceneId}`);
  const acceptedScenes = {};
  let upstreamSha256 = EMPTY_UPSTREAM;
  for (let index = 0; index <= targetIndex; index += 1) {
    const scene = scenes[index];
    const inputs = currentInputs(root, project, scene, upstreamSha256);
    if (!inputs) throw new Error(`cannot accept ${scene.id}: missing ${project.state_root}/${scene.id}.md`);
    acceptedScenes[scene.id] = inputs;
    upstreamSha256 = inputs.dependency_sha256;
  }
  for (let index = targetIndex + 1; index < scenes.length; index += 1) {
    const scene = scenes[index];
    const existing = manifest.scenes[scene.id];
    if (!existing || existing.upstream_sha256 !== upstreamSha256) break;
    acceptedScenes[scene.id] = existing;
    upstreamSha256 = existing.dependency_sha256;
  }
  const next = {
    version: 1,
    project_id: project.project_id,
    accepted_at: new Date().toISOString(),
    scenes: acceptedScenes
  };
  const directory = join(root, project.state_root);
  mkdirSync(directory, { recursive: true });
  writeFileSync(stateManifestPath(root, project), `${JSON.stringify(next, null, 2)}\n`);
  return narrativeStateStatus(root, project);
}

export function buildGroundingPacket(root, project, sceneId) {
  const scenes = loadScenes(root, project);
  const index = scenes.findIndex((scene) => scene.id === sceneId);
  if (index < 0) throw new Error(`unknown scene: ${sceneId}`);
  const scene = scenes[index];
  const previous = scenes[index - 1];
  if (previous) {
    const previousStatus = narrativeStateStatus(root, project).records[index - 1];
    if (!previousStatus?.current) {
      throw new Error(`cannot ground ${sceneId}: upstream narrative state is stale at ${previousStatus?.scene || previous.id}`);
    }
  }
  const outlinePath = join(root, project.outline_scene_root || "outline/scenes", `${sceneId}.md`);
  const readerStatePath = join(root, project.reader_state_path || "manuscript/reader-state.md");
  const previousStatePath = previous ? statePath(root, project, previous.id) : null;
  const outline = existsSync(outlinePath) ? readFileSync(outlinePath, "utf8").trim() : "_No locked scene outline found._";
  const readerState = existsSync(readerStatePath) ? readFileSync(readerStatePath, "utf8").trim() : "_No reader-state ledger found._";
  const previousState = previousStatePath && existsSync(previousStatePath)
    ? readFileSync(previousStatePath, "utf8").trim()
    : "_This is the opening scene; there is no prior scene state._";
  const closingImage = previous
    ? previous.prose.split(/\n\s*\n/).filter(Boolean).at(-1)
    : "_Opening scene._";
  return [
    `# Grounding packet: scene ${sceneId}`,
    "",
    "## Writing constraints",
    "",
    "- Continue the reader's experience; do not restart the book.",
    "- Treat established facts as negative knowledge: do not re-explain them.",
    "- Re-anchor only when deliberate, brief, and justified by distance or change.",
    "- Follow the locked beat while preserving character causation.",
    "- Record only new reader knowledge after the scene is reviewed.",
    "",
    "## Locked scene outline",
    "",
    outline,
    "",
    "## Entering narrative state",
    "",
    previousState,
    "",
    "## Cumulative reader-state ledger",
    "",
    readerState,
    "",
    "## Previous closing image",
    "",
    closingImage,
    ""
  ].join("\n");
}
