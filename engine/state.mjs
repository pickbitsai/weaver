// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCharacters } from "./characters.mjs";
import { runHost } from "./host.mjs";
import { buildPacket, extractJsonBlock, validateAndRepair } from "./packets.mjs";
import { countWords, loadScenes, manuscriptHash, sha256 } from "./manuscript.mjs";
import { GENERATOR, SCHEMA_BASE } from "./identity.mjs";

const FACT_KINDS = new Set(["location", "knowledge", "possession", "relationship", "event", "time"]);
const EXTRACTOR_PROMPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "state-extractor.md"), "utf8").trim();

const EMPTY_UPSTREAM = sha256("weaver:narrative-state:root");

export function statePath(root, project, sceneId) {
  return join(root, project.state_root, `${sceneId}.md`);
}

export function stateManifestPath(root, project) {
  return join(root, project.state_root, "manifest.json");
}

export function factsPath(root, project, sceneId) {
  return join(root, project.state_root, `${sceneId}.facts.json`);
}

export function factsLedgerPath(root) {
  return join(root, "continuity", "facts.json");
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
    `<!-- generated by ${GENERATOR} -->`
  ].join("\n");
}

function normalizeQuote(value) {
  return String(value)
    .replace(/[“”„‟]/gu, '"')
    .replace(/[‘’‚‛]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizedValue(value) {
  return String(value).toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function factsSummary(ledger) {
  const lines = [];
  let words = 0;
  for (const subject of Object.keys(ledger.subjects).sort()) {
    const facts = ledger.subjects[subject];
    const location = facts.filter((fact) => fact.kind === "location").at(-1);
    const knowledge = facts.filter((fact) => fact.kind === "knowledge").slice(-3);
    const parts = [];
    if (location) parts.push(`location: ${location.value}`);
    if (knowledge.length) parts.push(`knowledge: ${knowledge.map((fact) => fact.value).join("; ")}`);
    if (!parts.length) continue;
    const line = `- ${subject}: ${parts.join("; ")}`;
    const lineWords = countWords(line);
    if (words + lineWords > 1500) break;
    lines.push(line);
    words += lineWords;
  }
  return lines.length ? lines.join("\n") : "_No scene facts have been recorded yet._";
}

export function readFactsLedger(root) {
  const path = factsLedgerPath(root);
  if (!existsSync(path)) return { $schema: `${SCHEMA_BASE}facts-ledger-1.json`, generator: GENERATOR, manuscript_sha256: "", subjects: {}, first_established: [] };
  return JSON.parse(readFileSync(path, "utf8"));
}

export function buildFactsLedger(root, project) {
  const scenes = loadScenes(root, project);
  const subjects = {};
  const firstEstablished = [];
  const firstKeys = new Set();
  for (const scene of scenes) {
    const path = factsPath(root, project, scene.id);
    if (!existsSync(path)) continue;
    let document;
    try { document = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    if (document.prose_sha256 !== scene.hash || !Array.isArray(document.facts)) continue;
    for (const fact of document.facts) {
      if (!fact || !FACT_KINDS.has(fact.kind) || typeof fact.subject !== "string") continue;
      if (!subjects[fact.subject]) subjects[fact.subject] = [];
      subjects[fact.subject].push({ scene_id: scene.id, kind: fact.kind, value: fact.value, quote: fact.quote });
      const key = `${fact.subject}\0${fact.kind}\0${normalizedValue(fact.value)}`;
      if (!firstKeys.has(key)) {
        firstKeys.add(key);
        firstEstablished.push({ normalized_value: normalizedValue(fact.value), subject: fact.subject, kind: fact.kind, scene_id: scene.id });
      }
    }
  }
  const ledger = {
    $schema: `${SCHEMA_BASE}facts-ledger-1.json`,
    generator: GENERATOR,
    manuscript_sha256: manuscriptHash(scenes),
    subjects,
    first_established: firstEstablished
  };
  mkdirSync(dirname(factsLedgerPath(root)), { recursive: true });
  writeFileSync(factsLedgerPath(root), `${JSON.stringify(ledger, null, 2)}\n`);
  return ledger;
}

function registryContext(root) {
  return loadCharacters(root).characters.map((character) => ({ id: character.id, name: character.name, aliases: character.aliases }));
}

function validateStateAnswer(scene, root, answerText) {
  const extracted = extractJsonBlock(answerText);
  if (!extracted.ok) return { ok: false, value: null, errors: extracted.errors };
  const record = String(answerText).slice(0, extracted.start).trim();
  const requiredHeadings = ["Newly established", "Character deltas", "Active threads", "Timeline and location", "Closing image"];
  const errors = requiredHeadings.filter((heading) => !new RegExp(`^##\\s+${heading}\\s*$`, "imu").test(record)).map((heading) => `missing required heading: ${heading}`);
  const document = extracted.value;
  if (!document || typeof document !== "object" || Array.isArray(document) || !Array.isArray(document.facts)) {
    errors.push("JSON answer must contain a facts array");
    return { ok: false, value: null, errors };
  }
  const registry = new Set(registryContext(root).map((character) => character.id));
  const normalizedScene = normalizeQuote(scene.prose);
  for (const [index, fact] of document.facts.entries()) {
    if (!fact || typeof fact !== "object" || Array.isArray(fact)) { errors.push(`fact ${index + 1} must be an object`); continue; }
    if (!FACT_KINDS.has(fact.kind)) errors.push(`fact ${index + 1} has invalid kind`);
    if (!(fact.subject === "world" || registry.has(fact.subject))) errors.push(`fact ${index + 1} has an unknown subject`);
    if (typeof fact.value !== "string" || !fact.value.trim()) errors.push(`fact ${index + 1} must have a value`);
    if (typeof fact.quote !== "string" || countWords(fact.quote) < 3 || countWords(fact.quote) > 25) errors.push(`fact ${index + 1} quote must contain 3 to 25 words`);
    if (typeof fact.quote === "string" && !normalizedScene.includes(normalizeQuote(fact.quote))) errors.push(`fact ${index + 1} quote is not verbatim from this scene`);
  }
  return errors.length ? { ok: false, value: null, errors } : { ok: true, value: { record, facts: document.facts }, errors: [] };
}

function statePacket(root, project, scene, previous, ledger) {
  const registry = registryContext(root);
  const previousRecord = previous && existsSync(statePath(root, project, previous.id))
    ? readFileSync(statePath(root, project, previous.id), "utf8").trim()
    : "_No previous narrative-state record._";
  const summary = factsSummary(ledger);
  const prompt = [
    `# STATE packet ${scene.id}`,
    "",
    EXTRACTOR_PROMPT,
    "",
    "## Character registry",
    "",
    JSON.stringify(registry, null, 2),
    "",
    "## Upstream context",
    "",
    previousRecord,
    "",
    "## Facts ledger summary",
    "",
    summary,
    "",
    "## Scene reader text",
    "",
    scene.prose,
    "",
    "## Answer contract",
    "",
    "Return the narrative-state record in Markdown with these headings: Newly established, Character deltas, Active threads, Timeline and location, Closing image; add Contradictions when any.",
    "Then return a fenced ```json block exactly shaped as {\"facts\":[{\"kind\":\"location|knowledge|possession|relationship|event|time\",\"subject\":\"<registry id or world>\",\"value\":\"<short statement>\",\"quote\":\"<verbatim excerpt of 3–25 words from THIS scene>\"}]}. Every quote must be copied from the scene reader text."
  ].join("\n");
  const inputs = {
    scene_prose: sha256(scene.prose),
    previous_record: sha256(previousRecord),
    facts_ledger: sha256(summary),
    character_registry: sha256(JSON.stringify(registry)),
    extractor_prompt: sha256(EXTRACTOR_PROMPT)
  };
  return buildPacket("STATE", scene.id, prompt, inputs, "facts-1");
}

function packetPath(root, packetId) {
  return join(root, ".weaver", "packets", `${packetId}.json`);
}

function isResumeCurrent(root, project, scene, statusRecord) {
  if (!existsSync(statePath(root, project, scene.id)) || !existsSync(factsPath(root, project, scene.id))) return false;
  if (statusRecord?.reason === "upstream-stale") return false;
  try {
    return JSON.parse(readFileSync(factsPath(root, project, scene.id), "utf8")).prose_sha256 === scene.hash;
  } catch {
    return false;
  }
}

function writeStateAnswer(root, project, scene, packet, answer) {
  const directory = join(root, project.state_root);
  mkdirSync(directory, { recursive: true });
  writeFileSync(statePath(root, project, scene.id), `${answer.value.record}\n`);
  writeFileSync(factsPath(root, project, scene.id), `${JSON.stringify({
    $schema: `${SCHEMA_BASE}facts-1.json`,
    scene_id: scene.id,
    prose_sha256: scene.hash,
    packet_id: packet.id,
    generator: GENERATOR,
    facts: answer.value.facts
  }, null, 2)}\n`);
}

export async function bootstrapState(root, project, { through = null, run = false, onProgress = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const scenes = loadScenes(root, project);
  const throughIndex = through ? scenes.findIndex((scene) => scene.id === through) : scenes.length - 1;
  if (throughIndex < 0) throw new Error(`unknown scene: ${through}`);
  let ledger = buildFactsLedger(root, project);
  const status = narrativeStateStatus(root, project);
  for (let index = 0; index <= throughIndex; index += 1) {
    const scene = scenes[index];
    const statusRecord = status.records[index];
    if (isResumeCurrent(root, project, scene, statusRecord)) {
      onProgress(`Scene ${scene.id}: skipped, already current`);
      continue;
    }
    const previous = scenes[index - 1];
    const packet = statePacket(root, project, scene, previous, ledger);
    mkdirSync(join(root, ".weaver", "packets"), { recursive: true });
    writeFileSync(packetPath(root, packet.id), `${JSON.stringify(packet, null, 2)}\n`);
    if (!run) {
      onProgress(`Scene ${scene.id}: packet ${packet.id} written; answer it with weaver submit ${packet.id} --file <answer>`);
      continue;
    }
    const hostResult = await runHost(root, project, packet.prompt);
    if (!hostResult.ok) {
      onProgress(`Scene ${scene.id}: host error: ${hostResult.error}`);
      continue;
    }
    const answer = await validateAndRepair(root, project, packet, hostResult.text, (answerText) => validateStateAnswer(scene, root, answerText));
    if (!answer.ok) {
      onProgress(`Scene ${scene.id}: answer invalid after repair: ${answer.errors[0]}`);
      continue;
    }
    writeStateAnswer(root, project, scene, packet, answer);
    ledger = buildFactsLedger(root, project);
    onProgress(`Scene ${scene.id}: recorded (${answer.value.facts.length} facts)`);
  }
  const finalLedger = buildFactsLedger(root, project);
  return { ledger: finalLedger };
}

export function readPacket(root, packetId) {
  const path = packetPath(root, packetId);
  if (!existsSync(path)) throw new Error(`unknown packet: ${packetId}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function submitStatePacket(root, project, packetId, answerText) {
  const packet = readPacket(root, packetId);
  if (packet.kind !== "STATE") throw new Error(`packet ${packetId} is not a state packet`);
  const scenes = loadScenes(root, project);
  const scene = scenes.find((candidate) => candidate.id === packet.target);
  if (!scene) throw new Error(`unknown scene: ${packet.target}`);
  if (packet.inputs?.scene_prose && packet.inputs.scene_prose !== scene.hash) {
    return { ok: false, errors: ["packet is stale because the scene prose changed"], packet };
  }
  const answer = await validateAndRepair(root, project, packet, answerText, (value) => validateStateAnswer(scene, root, value));
  if (!answer.ok) return { ok: false, errors: answer.errors, packet };
  writeStateAnswer(root, project, scene, packet, answer);
  buildFactsLedger(root, project);
  return { ok: true, scene_id: scene.id, facts: answer.value.facts.length, packet };
}

export function buildStatePacket(root, project, sceneId) {
  const scenes = loadScenes(root, project);
  const index = scenes.findIndex((scene) => scene.id === sceneId);
  if (index < 0) throw new Error(`unknown scene: ${sceneId}`);
  const ledger = buildFactsLedger(root, project);
  const packet = statePacket(root, project, scenes[index], scenes[index - 1], ledger);
  mkdirSync(join(root, ".weaver", "packets"), { recursive: true });
  writeFileSync(packetPath(root, packet.id), `${JSON.stringify(packet, null, 2)}\n`);
  return packet;
}
