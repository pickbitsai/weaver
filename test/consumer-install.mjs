// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "weaver-consumer-"));
const consumer = join(sandbox, "consumer");
const book = join(consumer, "book");
const repairBook = join(consumer, "repair-book");
const finishedSource = join(consumer, "finished.md");
const npmCli = process.env.npm_execpath;
const env = { ...process.env, NPM_CONFIG_CACHE: join(sandbox, "npm-cache") };
let studioChild;
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

function weaverResult(args) {
  return spawnSync(process.execPath, [npmCli, "exec", "--", "weaver", ...args], {
    cwd: consumer,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
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
  const bookGitignore = readFileSync(join(book, ".gitignore"), "utf8");
  assert.match(bookGitignore, /node_modules\//);
  assert.match(bookGitignore, /\.weaver\/tmp\//);
  assert.match(bookGitignore, /\.weaver\/rejected\//);
  assert.ok(existsSync(join(book, ".claude", "settings.json")));

  weaver(["init", repairBook, "--id", "consumer-repair", "--title", "Consumer Repair", "--empty"]);
  writeFileSync(finishedSource, "# Wren\n\nA finished scene with an em — dash.\n\n* * *\n\nA second scene.");
  weaver(["import", finishedSource, "--root", repairBook]);
  const fakeHost = join(consumer, "fake-host.mjs");
  writeFileSync(fakeHost, readFileSync(join(root, "test", "fixtures", "fake-host.mjs"), "utf8"));
  const repairProjectPath = join(repairBook, "project.json");
  const repairProject = JSON.parse(readFileSync(repairProjectPath, "utf8"));
  repairProject.host = { command: process.execPath, args: [fakeHost, "review-triage"], concurrency: 3, timeout_seconds: 10 };
  writeFileSync(repairProjectPath, `${JSON.stringify(repairProject, null, 2)}\n`);
  weaver(["review", "--chapter", "1", "--run", "--root", repairBook]);
  assert.ok(existsSync(join(repairBook, "review", "chapter-01-continuity.json")));
  // An imported book has no accepted narrative state yet: check must say so, and release must
  // refuse until state is current. Export (the repair path) does not depend on state.
  const repairCheckResult = weaverResult(["check", "--root", repairBook]);
  assert.equal(repairCheckResult.status, 1, repairCheckResult.stderr);
  const repairCheck = JSON.parse(repairCheckResult.stdout);
  assert.deepEqual(repairCheck.issues, [`narrative state is stale from scene ${repairCheck.narrative_state.first_stale}`]);
  const repairRelease = weaverResult(["release", "--root", repairBook, "--id", "too-early"]);
  assert.notEqual(repairRelease.status, 0);
  assert.equal(existsSync(join(repairBook, "releases", "too-early")), false);
  const repairDocx = join(consumer, "consumer-repair.docx");
  weaver(["export", "--format", "docx", "--out", repairDocx, "--root", repairBook]);
  assert.equal(readFileSync(repairDocx).subarray(0, 2).toString(), "PK");

  const doctor = JSON.parse(weaver(["doctor", "--json", "--root", book]));
  assert.equal(doctor.checks.find((check) => check.id === "install-integrity").status, "pass");
  assert.equal(doctor.ok, true);

  studioChild = spawn(process.execPath, [join(consumer, "node_modules", "@pickbitsai", "weaver", "scripts", "weaver.mjs"), "studio", "--root", book, "--port", "0"], { cwd: consumer, env, stdio: ["ignore", "pipe", "pipe"] });
  const studioUrl = await new Promise((ready, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("installed studio did not start")), 15_000);
    studioChild.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//u);
      if (match) { clearTimeout(timer); ready(match[0]); }
    });
    studioChild.on("error", (error) => { clearTimeout(timer); reject(error); });
    studioChild.on("exit", (code) => { if (!output.includes("http://127.0.0.1:")) { clearTimeout(timer); reject(new Error(`installed studio exited ${code}`)); } });
  });
  const studioHealth = await fetch(new URL("api/health", studioUrl));
  assert.equal(studioHealth.status, 200);
  assert.deepEqual(await studioHealth.json(), { service: "pickbits-weaver-studio", generator: "PickBits Weaver 0.3.0", book: "consumer-book" });
  studioChild.kill();
  studioChild = null;

  const status = JSON.parse(weaver(["status", "--root", book]));
  assert.equal(status.project_id, "consumer-book");
  assert.equal(status.scenes, 1);

  const scenePath = join(book, "manuscript", "chapter-01", "scene-01", "scene.md");
  const approvedBefore = readFileSync(scenePath, "utf8");
  writeFileSync(scenePath, approvedBefore.replace("different state.", "approved then undone state."));
  const pending = JSON.parse(weaver(["changes", "--root", book, "--json"]));
  assert.equal(pending.chapters[0].chapter, 1);
  weaver(["approve", "--chapter", "1", "--root", book]);
  const history = JSON.parse(weaver(["history", "--root", book, "--json"]));
  assert.equal(history[0].type, "approval");
  weaver(["undo", "--root", book]);
  assert.equal(readFileSync(scenePath, "utf8").includes("approved then undone state."), false);
  assert.equal(readFileSync(scenePath, "utf8").includes("different state."), true);

  weaver(["state:accept", "--root", book]);
  const check = JSON.parse(weaver(["check", "--root", book]));
  assert.equal(check.ok, true);
  weaver(["release", "--root", book, "--id", "consumer-smoke"]);

  const release = JSON.parse(
    readFileSync(join(book, "releases", "consumer-smoke", "release-manifest.json"), "utf8")
  );
  assert.equal(release.release_id, "consumer-smoke");
  assert.equal(release.source.scene_count, 1);

  appendFileSync(
    join(consumer, "node_modules", "@pickbitsai", "weaver", "engine", "state.mjs"),
    " "
  );
  const brokenDoctor = weaverResult(["doctor", "--json", "--root", book]);
  assert.notEqual(brokenDoctor.status, 0);
  assert.ok(brokenDoctor.stdout, brokenDoctor.stderr);
  const brokenReport = JSON.parse(brokenDoctor.stdout);
  const integrity = brokenReport.blocking.find((finding) => finding.id === "install-integrity");
  assert.ok(integrity);
  assert.ok(integrity.paths.includes("engine/state.mjs"));
  const refused = weaverResult(["release", "--root", book, "--id", "consumer-after-break"]);
  assert.notEqual(refused.status, 0);
  assert.equal(JSON.parse(refused.stdout).error, "Weaver's own files have been changed");
  assert.equal(existsSync(join(book, "releases", "consumer-after-break")), false);

  console.log("consumer smoke passed: packed, installed, initialized, checked, and released");
} finally {
  studioChild?.kill();
  rmSync(sandbox, { recursive: true, force: true });
}
