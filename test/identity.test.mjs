// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GENERATOR, VERSION, checkIdentityHeader } from "../engine/identity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HEADER_DIRS = ["engine", "scripts", "test"];
const CODE_EXTENSIONS = new Set([".mjs", ".js"]);

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".tmp") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (CODE_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files;
}

test("all engine, script, and test modules have identity headers", () => {
  for (const directory of HEADER_DIRS) {
    for (const file of walk(join(ROOT, directory))) {
      const result = checkIdentityHeader(file);
      assert.equal(result.ok, true, `${file}: ${result.reason}`);
    }
  }
});

test("identity header checker rejects a file without the header", () => {
  const directory = mkdtempSync(join(tmpdir(), "weaver-identity-"));
  const file = join(directory, "missing-header.mjs");
  try {
    writeFileSync(file, "export default true;\n");
    const result = checkIdentityHeader(file);
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing SPDX header/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI version, package metadata, and license identity agree", () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const result = spawnSync(process.execPath, [join(ROOT, "scripts", "weaver.mjs"), "--version"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), GENERATOR);
  assert.equal(VERSION, packageJson.version);
  assert.match(readFileSync(join(ROOT, "LICENSE"), "utf8"), /Apache License/);
  assert.match(readFileSync(join(ROOT, "LICENSE"), "utf8"), /Version 2\.0/);
  assert.equal(existsSync(join(ROOT, "NOTICE")), true);
  assert.match(readFileSync(join(ROOT, "NOTICE"), "utf8"), /PickBits Weaver/);
});
