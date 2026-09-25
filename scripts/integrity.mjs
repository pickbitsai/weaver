#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIntegrityManifest, compareIntegrity, INTEGRITY_FILENAME } from "../engine/integrity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] || "--check";
const manifestPath = join(root, INTEGRITY_FILENAME);

if (mode === "--write") {
  writeFileSync(manifestPath, `${JSON.stringify(buildIntegrityManifest(root), null, 2)}\n`);
  process.stdout.write(`integrity: wrote ${INTEGRITY_FILENAME}\n`);
} else if (mode === "--check") {
  const result = compareIntegrity(root);
  if (result.status === "intact") {
    process.stdout.write(`integrity: intact\n`);
  } else if (result.status === "unverifiable") {
    process.stderr.write(`integrity: unverifiable (missing or invalid ${INTEGRITY_FILENAME})\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`integrity: modified\n${result.paths.map((path) => `- ${path}`).join("\n")}\n`);
    process.exitCode = 1;
  }
} else {
  process.stderr.write("usage: node scripts/integrity.mjs --write|--check\n");
  process.exitCode = 1;
}

