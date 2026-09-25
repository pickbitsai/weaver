// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "weaver-consumer-"));
const consumer = join(sandbox, "consumer");
const book = join(consumer, "book");
const npmCli = process.env.npm_execpath;
const env = { ...process.env, NPM_CONFIG_CACHE: join(sandbox, "npm-cache") };
assert.ok(npmCli, "npm_execpath is required; run this check through npm");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`
  );
  return result.stdout;
}

function runNpm(args, cwd) {
  return run(process.execPath, [npmCli, ...args], cwd);
}

function weaver(args) {
  return runNpm(["exec", "--", "weaver", ...args], consumer);
}

try {
  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "weaver-consumer-smoke", private: true }, null, 2)
  );

  const packed = JSON.parse(
    runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", sandbox], root)
  );
  assert.equal(packed.length, 1);
  const tarball = join(sandbox, basename(packed[0].filename));
  assert.ok(existsSync(tarball), `missing packed tarball: ${tarball}`);

  runNpm(
    ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    consumer
  );
  const installedNotice = join(consumer, "node_modules", "@pickbitsai", "weaver", "NOTICE");
  assert.ok(existsSync(installedNotice), "NOTICE is missing from the packed package");
  assert.match(readFileSync(installedNotice, "utf8"), /PickBits Weaver/);
  weaver(["init", book, "--id", "consumer-book", "--title", "Consumer Book"]);

  const status = JSON.parse(weaver(["status", "--root", book]));
  assert.equal(status.project_id, "consumer-book");
  assert.equal(status.scenes, 1);

  weaver(["state:accept", "--root", book]);
  const check = JSON.parse(weaver(["check", "--root", book]));
  assert.equal(check.ok, true);
  weaver(["release", "--root", book, "--id", "consumer-smoke"]);

  const release = JSON.parse(
    readFileSync(join(book, "releases", "consumer-smoke", "release-manifest.json"), "utf8")
  );
  assert.equal(release.release_id, "consumer-smoke");
  assert.equal(release.source.scene_count, 1);

  console.log("consumer smoke passed: packed, installed, initialized, checked, and released");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
