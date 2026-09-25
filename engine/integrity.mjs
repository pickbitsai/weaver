// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { GENERATOR, SCHEMA_BASE, VERSION } from "./identity.mjs";

export const INTEGRITY_FILENAME = "integrity.json";

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function normalizeForHash(bytes) {
  const normalized = [];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) continue;
    normalized.push(bytes[index]);
  }
  return Buffer.from(normalized);
}

export function normalizedSha256(path) {
  return createHash("sha256").update(normalizeForHash(readFileSync(path))).digest("hex");
}

function packageFilesList(packageRoot) {
  const root = resolve(packageRoot);
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const patterns = [...(packageJson.files || []), "package.json", "README.md", "LICENSE", "NOTICE"];
  const files = new Set();
  for (const pattern of patterns) {
    const target = join(root, pattern.replace(/\/$/, ""));
    if (!existsSync(target)) continue;
    if (statSync(target).isDirectory()) {
      for (const file of walk(target)) files.add(relative(root, file).replaceAll("\\", "/"));
    } else if (statSync(target).isFile()) {
      files.add(relative(root, target).replaceAll("\\", "/"));
    }
  }
  files.delete(INTEGRITY_FILENAME);
  return [...files].sort();
}

export function integrityFiles(packageRoot) {
  const root = resolve(packageRoot);
  return packageFilesList(root).map((path) => ({ path, sha256: normalizedSha256(join(root, path)) }));
}

export function buildIntegrityManifest(packageRoot) {
  return {
    $schema: `${SCHEMA_BASE}integrity-1.json`,
    generator: GENERATOR,
    version: VERSION,
    files: Object.fromEntries(integrityFiles(packageRoot).map(({ path, sha256 }) => [path, sha256]))
  };
}

export function readIntegrityManifest(packageRoot) {
  const path = join(resolve(packageRoot), INTEGRITY_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (!manifest || typeof manifest.files !== "object" || Array.isArray(manifest.files)) return null;
    return manifest;
  } catch {
    return null;
  }
}

export function compareIntegrity(packageRoot) {
  const root = resolve(packageRoot);
  const manifest = readIntegrityManifest(root);
  if (!manifest) return { status: "unverifiable", changed: [], missing: [], unexpected: [], paths: [] };

  const actual = Object.fromEntries(integrityFiles(root).map(({ path, sha256 }) => [path, sha256]));
  const changed = [];
  const missing = [];
  const unexpected = [];
  for (const [path, expectedSha256] of Object.entries(manifest.files).sort()) {
    if (!(path in actual)) missing.push(path);
    else if (actual[path] !== expectedSha256) changed.push(path);
  }
  for (const path of Object.keys(actual).sort()) {
    if (!(path in manifest.files)) unexpected.push(path);
  }
  const paths = [...new Set([...changed, ...missing, ...unexpected])].sort();
  return {
    status: paths.length ? "modified" : "intact",
    changed,
    missing,
    unexpected,
    paths
  };
}
