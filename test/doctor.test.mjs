// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareIntegrity, normalizedSha256 } from "../engine/integrity.mjs";
import { gitAvailable, runDoctor } from "../engine/doctor.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "scripts", "weaver.mjs");

function gitInit(root) {
  const result = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function makeBook({ git = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "weaver-doctor-"));
  cpSync(join(ROOT, "templates", "book"), root, { recursive: true });
  if (git) gitInit(root);
  return root;
}

function runWeaver(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

test("healthy Git book passes doctor and can release", () => {
  const book = makeBook();
  try {
    const report = runDoctor({ bookRoot: book });
    assert.equal(report.ok, true);
    assert.equal(report.blocking.length, 0);
    assert.equal(report.warnings.some((finding) => finding.id === "host"), true);
    assert.equal(report.checks.find((check) => check.id === "node-version").status, "pass");
    assert.equal(report.checks.find((check) => check.id === "git-available").status, "pass");

    let result = runWeaver(["state:accept", "--root", book]);
    assert.equal(result.status, 0, result.stderr);
    result = runWeaver(["release", "--root", book, "--id", "doctor-good"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(book, "releases", "doctor-good")), true);
  } finally {
    rmSync(book, { recursive: true, force: true });
  }
});

test("doctor blocks a book that is not under Git, while status still runs", () => {
  const book = makeBook({ git: false });
  try {
    const report = runDoctor({ bookRoot: book });
    assert.equal(report.ok, false);
    assert.ok(report.blocking.some((finding) => finding.id === "book-in-git"));

    const release = runWeaver(["release", "--root", book, "--id", "doctor-no-git"]);
    assert.equal(release.status, 1);
    const refusal = JSON.parse(release.stdout);
    assert.equal(refusal.error, "Your book folder is not under Git");
    assert.equal(refusal.command, "release");
    assert.equal(existsSync(join(book, "releases")), false);

    const status = runWeaver(["status", "--root", book]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stderr, /Warning: Your book folder is not under Git\./);
    assert.equal(JSON.parse(status.stdout).scenes, 1);
  } finally {
    rmSync(book, { recursive: true, force: true });
  }
});

test("doctor blocks books inside Weaver and copied engine identities", () => {
  const inside = join(ROOT, "test", ".tmp", `doctor-inside-${Date.now()}`);
  mkdirSync(dirname(inside), { recursive: true });
  cpSync(join(ROOT, "templates", "book"), inside, { recursive: true });
  const copied = makeBook();
  try {
    assert.ok(runDoctor({ bookRoot: inside }).blocking.some((finding) => finding.id === "tool-book-separation"));
    const copiedIdentity = join(copied, "copied-engine", "identity.mjs");
    mkdirSync(dirname(copiedIdentity), { recursive: true });
    cpSync(join(ROOT, "engine", "identity.mjs"), copiedIdentity);
    assert.ok(runDoctor({ bookRoot: copied }).blocking.some((finding) => finding.id === "tool-book-separation"));
  } finally {
    rmSync(inside, { recursive: true, force: true });
    rmSync(copied, { recursive: true, force: true });
  }
});

test("doctor checks node, Git, and install integrity known-bad paths", () => {
  const book = makeBook();
  const unverifiable = mkdtempSync(join(tmpdir(), "weaver-no-integrity-"));
  try {
    assert.equal(gitAvailable(), true);
    assert.equal(gitAvailable("weaver-command-that-does-not-exist"), false);
    assert.ok(runDoctor({ bookRoot: book, nodeVersion: "21.0.0" }).blocking.some((finding) => finding.id === "node-version"));
    assert.ok(runDoctor({ bookRoot: book, packageRoot: unverifiable }).blocking.some((finding) => finding.id === "install-integrity"));
  } finally {
    rmSync(book, { recursive: true, force: true });
    rmSync(unverifiable, { recursive: true, force: true });
  }
});

test("integrity is clean, detects a changed package file, and normalizes CRLF", () => {
  assert.equal(compareIntegrity(ROOT).status, "intact");
  const packageCopy = mkdtempSync(join(tmpdir(), "weaver-integrity-"));
  const lineEndings = mkdtempSync(join(tmpdir(), "weaver-line-endings-"));
  try {
    cpSync(ROOT, packageCopy, {
      recursive: true,
      filter: (path) => !path.includes(`${join("node_modules")}${requireSeparator()}`) && !path.includes(`${join(".git")}${requireSeparator()}`) && !path.includes(`${join("test", ".tmp")}${requireSeparator()}`)
    });
    appendFileSync(join(packageCopy, "engine", "state.mjs"), "\nchanged in a copy\n");
    const changed = compareIntegrity(packageCopy);
    assert.equal(changed.status, "modified");
    assert.ok(changed.changed.includes("engine/state.mjs"));

    const lf = join(lineEndings, "lf.txt");
    const crlf = join(lineEndings, "crlf.txt");
    writeFileSync(lf, "one\ntwo\n");
    writeFileSync(crlf, "one\r\ntwo\r\n");
    assert.equal(normalizedSha256(lf), normalizedSha256(crlf));
  } finally {
    rmSync(packageCopy, { recursive: true, force: true });
    rmSync(lineEndings, { recursive: true, force: true });
  }
});

test("doctor JSON output is machine-readable and identifies Weaver", () => {
  const book = makeBook();
  try {
    const result = runWeaver(["doctor", "--json", "--root", book]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.generator, "PickBits Weaver 0.3.0");
    assert.equal(report.ok, true);
  } finally {
    rmSync(book, { recursive: true, force: true });
  }
});

function requireSeparator() {
  return process.platform === "win32" ? "\\" : "/";
}
