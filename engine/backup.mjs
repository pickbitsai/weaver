// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATOR, SCHEMA_BASE } from "./identity.mjs";

export const BACKUP_REMOTE = "weaver-backup";
export const BACKUP_RECORD = ".weaver/backup.json";
export const BACKUP_TIMEOUT_MS = 120_000;
export const SETUP_TIMEOUT_MS = 300_000;
const LOCK = ".weaver/backup.lock";
const PENDING = ".weaver/backup.pending";
const WORKER = fileURLToPath(new URL("./backup-worker.mjs", import.meta.url));
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const NOT_CONFIGURED = {
  problem: "Your book isn't backed up yet",
  why: "If this computer is lost or damaged, the book and every approval could be lost with it.",
  fix: "Create an empty private repository (for example on GitHub), then run `npx weaver backup setup --remote <its address>` in a terminal, or ask PickBits to set it up."
};

// Git reads these from the environment. A caller (for example an AI that started the studio or ran
// `backup now`) could use them to send the backup somewhere else or to read another repository.
// Weaver backs up with the book's own Git settings only.
const GIT_OVERRIDE_ENV = /^GIT_(?:CONFIG(?:_[A-Z0-9_]*)?|DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|INDEX_VERSION|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|REPLACE_REF_BASE|NO_REPLACE_OBJECTS|SHALLOW_FILE|GRAFT_FILE|QUARANTINE_PATH|EXEC_PATH|SSH|SSH_COMMAND|SSH_VARIANT|PROXY_COMMAND|ALLOW_PROTOCOL|PROTOCOL_FROM_USER|SSL_NO_VERIFY|TRACE[A-Z0-9_]*)$/iu;
export function dropGitOverrides(env = process.env) {
  const removed = Object.keys(env).filter((key) => GIT_OVERRIDE_ENV.test(key));
  for (const key of removed) delete env[key];
  return removed;
}

export function gitSafeEnv(env = process.env) {
  if (!Object.keys(env).some((key) => GIT_OVERRIDE_ENV.test(key))) return env;
  const safe = { ...env };
  dropGitOverrides(safe);
  return safe;
}

function git(root, args, options = {}) {
  return spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 30_000, env: gitSafeEnv(), ...options
  });
}

function localBackupPath(address, cwd = process.cwd()) {
  if (/^(?:https|ssh):\/\//iu.test(address)) return null;
  if (/^file:\/\//iu.test(address)) {
    try { return fileURLToPath(address); } catch { return null; }
  }
  if (/^[^\s/\\@:]+@[^\s/\\:]+:/u.test(address) || /^[a-z0-9._-]{2,}:/iu.test(address)) return null;
  return resolve(cwd, address);
}

function realPath(path) {
  const rest = [];
  let ancestor = resolve(path);
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
    rest.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  let real = ancestor;
  try { real = realpathSync.native(ancestor); } catch { /* An unreadable folder is compared by its plain path. */ }
  const result = join(real, ...rest);
  return process.platform === "win32" ? result.toLowerCase() : result;
}

function insideBook(root, folder) {
  const locations = ["--show-toplevel", "--absolute-git-dir", "--git-common-dir"].map((flag) => {
    const result = git(root, ["rev-parse", flag]);
    return result.status === 0 ? realPath(resolve(root, result.stdout.trim())) : null;
  });
  const target = realPath(folder);
  if (locations.filter(Boolean).some((location) => {
    const path = relative(location, target);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  })) return true;
  if (existsSync(folder)) {
    const common = git(folder, ["rev-parse", "--git-common-dir"]);
    if (common.status === 0 && realPath(resolve(folder, common.stdout.trim())) === locations[2]) return true;
  }
  return false;
}

const gitLines = (result) => result.status === 0 ? result.stdout.replace(/\r?\n$/u, "").split(/\r?\n/u) : [];
function effectivePushUrls(root) {
  const result = git(root, ["remote", "get-url", "--push", "--all", BACKUP_REMOTE]);
  return { ok: result.status === 0, urls: gitLines(result) };
}

const expectedAddress = (record) => typeof record.push_url === "string" ? record.push_url : typeof record.remote_url === "string" ? record.remote_url : null;
function addressMatches(root, expected, effective = effectivePushUrls(root)) {
  if (!effective.ok || effective.urls.length !== 1) return false;
  if (expected !== null) return sanitizeGitText(effective.urls[0]) === expected;
  const raw = gitLines(git(root, ["config", "--get-all", `remote.${BACKUP_REMOTE}.url`]));
  return raw.length === 1 && sanitizeGitText(effective.urls[0]) === sanitizeGitText(raw[0]);
}

export function relativeTime(thenMs, nowMs = Date.now()) {
  const seconds = (nowMs - (typeof thenMs === "number" ? thenMs : typeof thenMs === "string" ? Date.parse(thenMs) : NaN)) / 1000;
  if (!Number.isFinite(seconds) || seconds < 60) return "just now";
  const [count, unit] = seconds < 3600 ? [Math.floor(seconds / 60), "minute"]
    : seconds < 86400 ? [Math.floor(seconds / 3600), "hour"] : [Math.floor(seconds / 86400), "day"];
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

export function sanitizeGitText(text) {
  return String(text ?? "").replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, "$1");
}

export function validateBackupRemote(remote, { cwd = process.cwd() } = {}) {
  const address = String(remote ?? "").trim();
  if (!address) throw new Error("Give the backup address with --remote, for example --remote https://github.com/your-name/your-book-backup.git");
  if (address.startsWith("-")) throw new Error("The backup address can't start with a dash.");
  if (/[\u0000-\u001f]/u.test(address)) throw new Error("The backup address contains characters Git can't use.");
  const only = "Weaver backs up only to an https or ssh address, or to a folder.";
  const token = "Leave the part before @ out of the backup address, for example https://bitbucket.org/your-team/your-book.git. That part can hold a password or access token, which Weaver never stores; Git Credential Manager asks you to sign in.";
  if (/^[^@/\\]*:[^@/\\]*@/u.test(address)) throw new Error(token);
  if (/^[a-z][a-z0-9+.-]*::/iu.test(address)) throw new Error(only);
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(address)?.[1].toLowerCase();
  if (scheme) {
    if (scheme === "http") throw new Error("Use the https address for your backup, not http.");
    if (!["https", "ssh", "file"].includes(scheme)) throw new Error(only);
    if (scheme !== "file") {
      let url;
      try { url = new URL(address); } catch { throw new Error("The backup address isn't a valid https or ssh address. Check it and try again."); }
      if (url.password || (scheme === "https" && url.username)) throw new Error(token);
      if (url.search || url.hash) throw new Error("Leave everything after ? or # out of the backup address. It can hold an access token, which Weaver never stores.");
    }
    return address;
  }
  return localBackupPath(address, cwd) ?? address;
}

export function describeBackupFailure(output, { trigger = "decision", timedOut = false } = {}) {
  const text = String(output ?? "");
  const detail = sanitizeGitText(text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).slice(-3).join(" / ")).slice(0, 300) || null;
  let error, fix;
  if (timedOut) {
    error = "The backup took too long and was stopped.";
    fix = "Check your internet connection, then run `npx weaver backup now`.";
  } else if (/\[rejected\]|non-fast-forward|fetch first|updates were rejected/iu.test(text) && !/remote rejected/iu.test(text)) {
    error = trigger === "setup" ? "Your backup repository already has other files or history in it." : "Your backup has history this computer doesn't have, so Weaver didn't overwrite it.";
    fix = trigger === "setup" ? "Create a new, empty private repository (don't add a README, licence or .gitignore) and run `npx weaver backup setup --remote <its address>` again." : "Weaver never overwrites a backup. Contact PickBits before changing anything.";
  } else if (/remote rejected|hook declined|protected branch/iu.test(text)) {
    error = "Your backup service refused the backup.";
    fix = "Check the repository's settings (for example branch protection on GitHub), or contact PickBits.";
  } else if (/permission denied \(publickey|host key verification failed/iu.test(text)) {
    error = "Your backup service didn't accept this computer's SSH key.";
    fix = "Add this computer's SSH key to your GitHub account, or use the https address and sign in with Git Credential Manager.";
  } else if (/authentication failed|could not read (?:username|password)|terminal prompts disabled|interactivity has been disabled|invalid username or password|logon failed|returned error: 40[13]|permission to \S+ denied|access denied|not authorized|unauthorized/iu.test(text)) {
    error = "Your backup service didn't accept your sign-in.";
    fix = "Sign in again with Git Credential Manager, which comes with Git for Windows: run `npx weaver backup setup --remote <address>` in a terminal and sign in to GitHub when it asks. Weaver never stores your password or token.";
  } else if (/repository not found|does not appear to be a git repository|invalid gitfile format|not a git repository|returned error: 404|not found|no such file or directory|does not exist/iu.test(text)) {
    error = "Weaver couldn't find your backup repository.";
    fix = "Check the backup address. On GitHub, make sure the private repository exists and that you're signed in to the account that owns it. For a backup folder, create it first, outside the book folder (ideally on another drive), with `git init --bare <folder>`.";
  } else if (/could not resolve|unable to access|failed to connect|connection (?:timed out|refused|reset)|network is unreachable|timed out|ssl|proxy|could not read from remote repository|early eof|remote end hung up/iu.test(text)) {
    error = "Weaver couldn't reach your backup service.";
    fix = "Check your internet connection, then run `npx weaver backup now`.";
  } else {
    error = "The backup didn't go through.";
    fix = "Run `npx weaver backup now` to try again. If it keeps failing, contact PickBits.";
  }
  return { error, fix, detail };
}

const freshRecord = () => ({ remote_name: BACKUP_REMOTE, attempts: [], last_success: null });
const plainObject = (value) => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const validSuccess = (value) => plainObject(value) && ["at", "commit", "branch"].every((key) => typeof value[key] === "string");
const attemptError = (attempt) => typeof attempt?.error === "string" && attempt.error ? attempt.error : "the backup didn't go through";
const attemptFix = (attempt) => typeof attempt?.fix === "string" && attempt.fix ? attempt.fix : "Run `npx weaver backup now` to try again.";
export function readBackupRecord(root) {
  const path = join(root, BACKUP_RECORD);
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record)) return freshRecord();
    return { ...freshRecord(), ...record, last_success: validSuccess(record.last_success) ? record.last_success : null,
      attempts: Array.isArray(record.attempts) ? record.attempts.filter(plainObject) : [] };
  } catch { return freshRecord(); }
}

function remove(path) {
  try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function writeRecord(root, record, attempt) {
  record.$schema = `${SCHEMA_BASE}backup-1.json`;
  record.generator = GENERATOR;
  record.remote_name = BACKUP_REMOTE;
  record.remote_url = record.remote_url == null ? null : sanitizeGitText(record.remote_url);
  record.push_url = typeof record.push_url === "string" ? sanitizeGitText(record.push_url) : null;
  record.configured_at ||= new Date().toISOString();
  record.attempts = [...record.attempts, attempt].slice(-50);
  if (attempt.result === "ok") record.last_success = { at: attempt.at, commit: attempt.commit, branch: attempt.branch };
  const path = join(root, BACKUP_RECORD), temporary = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    const ordered = { $schema: record.$schema, generator: record.generator, remote_name: record.remote_name, remote_url: record.remote_url, push_url: record.push_url,
      configured_at: record.configured_at, last_success: record.last_success ?? null, attempts: record.attempts };
    writeFileSync(temporary, `${JSON.stringify(ordered, null, 2)}\n`);
    for (let retry = 0; ; retry++) {
      try { renameSync(temporary, path); break; }
      catch (error) {
        if (!["EPERM", "EBUSY"].includes(error.code) || retry >= 5) throw error;
        pause(50);
      }
    }
  } finally { remove(temporary); }
}

function ensureBackupFilesIgnored(root) {
  const location = git(root, ["rev-parse", "--git-path", "info/exclude"]);
  const prefix = git(root, ["rev-parse", "--show-prefix"]);
  if (location.status !== 0 || prefix.status !== 0) throw new Error("Weaver couldn't keep its backup record separate from your book's history. Contact PickBits.");
  const path = resolve(root, location.stdout.trim());
  const line = `/${prefix.stdout.trim().replace(/[\\[\]*?]/gu, "\\$&")}.weaver/backup*`;
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current.split(/\r?\n/u).includes(line)) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
}

function lockStale(path) {
  let info;
  try { info = statSync(path); } catch (error) { if (error.code === "ENOENT") return true; throw error; }
  let lock;
  try { lock = JSON.parse(readFileSync(path, "utf8")); } catch { /* A new lock may still be being written. */ }
  const at = Date.parse(lock?.at);
  if (Date.now() - (Number.isFinite(at) ? at : info.mtimeMs) > 600_000) return true;
  if (Number.isInteger(lock?.pid) && lock.pid > 0) {
    try { process.kill(lock.pid, 0); } catch (error) { if (error.code === "ESRCH") return true; }
  }
  return false;
}

export function backupRunning(root) {
  const path = join(root, LOCK);
  return existsSync(path) && !lockStale(path);
}

function acquireLock(root) {
  mkdirSync(join(root, ".weaver"), { recursive: true });
  const path = join(root, LOCK);
  for (let retry = 0; retry < 2; retry++) {
    let fd;
    try { fd = openSync(path, "wx"); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (retry || !lockStale(path)) return false;
      remove(path);
      continue;
    }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); }
    finally { closeSync(fd); }
    return true;
  }
  return false;
}

function waitForLock(root, timeoutMs) {
  const deadline = Date.now() + timeoutMs + 30_000;
  do {
    if (acquireLock(root)) return true;
    if (Date.now() >= deadline) return false;
    pause(250);
  } while (true);
}

function releaseLock(root, { resumePending = false } = {}) {
  remove(join(root, LOCK));
  // A decision arriving during a foreground push must also get its follow-up push.
  if (resumePending && existsSync(join(root, PENDING))) startBackgroundBackup(root);
}

function pushOnce(root, { trigger, interactive, timeoutMs, expected }) {
  const started = Date.now();
  let branch = null, commit = null;
  const finish = (fields) => ({ at: new Date().toISOString(), trigger, commit, branch, ...fields, seconds: Math.round((Date.now() - started) / 10) / 100 });
  const failed = (error, fix, detail = null) => finish({ result: "failed", error, fix, detail });
  const unavailable = () => failed("Git isn't available on this computer.", "Install Git, then run `npx weaver backup now`.");
  const remote = git(root, ["remote", "get-url", BACKUP_REMOTE]);
  if (remote.error?.code === "ENOENT") return unavailable();
  if (remote.status !== 0) return failed("The backup address is missing from your book's Git settings.", "Run `npx weaver backup setup --remote <address>` again in a terminal.");
  const addressChanged = () => failed("Git would send your backup to a different address than the one you set up, so Weaver stopped.", "Run `npx weaver backup setup --remote <your backup address>` again in a terminal to confirm where your book is backed up, or contact PickBits.");
  const effective = effectivePushUrls(root);
  if (!addressMatches(root, expected, effective)) return addressChanged();
  const folder = localBackupPath(effective.urls[0], root);
  if (folder && insideBook(root, folder)) return failed("Your backup address points into the book itself, so it isn't a separate copy.", "Run `npx weaver backup setup --remote <address>` in a terminal with a private repository or a folder on another drive.");
  const symbolic = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (symbolic.status !== 0) return failed("Your book isn't on a branch right now, so Weaver can't back it up.", "Contact PickBits.");
  branch = symbolic.stdout.trim();
  const saved = git(root, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (saved.status !== 0) return failed("Your book has no saved history yet, so there is nothing to back up.", "Approve a chapter first, then run `npx weaver backup now`.");
  commit = saved.stdout.trim();
  const env = interactive ? gitSafeEnv() : { ...gitSafeEnv(), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  // The timeout stops git itself; a stalled https transfer must also end on its own, or its
  // helper process would linger after git is stopped.
  const stall = interactive ? [] : ["-c", "http.lowSpeedLimit=1", "-c", "http.lowSpeedTime=60"];
  // A successful push also moves Git's own tracking ref. Remember where it was, so a push whose
  // address changed while it ran is not counted as backed up.
  const tracking = `refs/remotes/${BACKUP_REMOTE}/${branch}`;
  const before = git(root, ["rev-parse", "--verify", "--quiet", tracking]);
  const pushed = git(root, [...stall, "push", BACKUP_REMOTE, `${commit}:refs/heads/${branch}`], { timeout: timeoutMs, env });
  if (pushed.status === 0) {
    if (!addressMatches(root, expected)) {
      git(root, before.status === 0 ? ["update-ref", tracking, before.stdout.trim()] : ["update-ref", "-d", tracking]);
      return addressChanged();
    }
    git(root, ["update-ref", tracking, commit]);
    return finish({ result: "ok", error: null, fix: null, detail: null });
  }
  if (pushed.error?.code === "ENOENT") return unavailable();
  return finish({ result: "failed", ...describeBackupFailure(`${pushed.stderr || ""}\n${pushed.stdout || ""}`, { trigger, timedOut: pushed.error?.code === "ETIMEDOUT" }) });
}

export function setupBackup(root, { remote, interactive = true, timeoutMs = SETUP_TIMEOUT_MS, cwd = process.cwd() } = {}) {
  const address = validateBackupRemote(remote, { cwd });
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") throw new Error("Your book folder isn't under Git yet, so there is nothing to back up. Run `weaver doctor` to see how to fix it.");
  if (git(root, ["rev-parse", "--verify", "HEAD"]).status !== 0) throw new Error("Your book has no saved history yet, so there is nothing to back up.");
  const folder = localBackupPath(address);
  if (folder && insideBook(root, folder)) throw new Error("Your backup has to be a separate copy, outside the book folder. Choose a private repository (for example on GitHub) or a folder on another drive. If you made a backup folder inside the book, move it out of the book folder first.");
  ensureBackupFilesIgnored(root);
  if (!waitForLock(root, timeoutMs)) throw new Error("A backup is already running. Try again in a minute.");
  try {
    // Serialize address changes with pushes, so a running push cannot confirm the old address.
    const urls = gitLines(git(root, ["config", "--get-all", `remote.${BACKUP_REMOTE}.url`]));
    const changed = urls.length !== 1 || urls[0] !== address;
    const saveError = (result) => {
      if (result.status !== 0) throw new Error(`Weaver couldn't save the backup address in the book's Git settings.\n${sanitizeGitText(result.stderr || result.stdout).trim()}`);
    };
    if (changed) {
      const refs = git(root, ["for-each-ref", "--format=%(refname)", `refs/remotes/${BACKUP_REMOTE}/`]);
      saveError(refs);
      for (const ref of refs.stdout.split(/\r?\n/u).filter(Boolean)) saveError(git(root, ["update-ref", "-d", ref]));
    }
    saveError(git(root, urls.length ? ["config", "--replace-all", `remote.${BACKUP_REMOTE}.url`, address] : ["remote", "add", BACKUP_REMOTE, address]));
    const unset = git(root, ["config", "--unset-all", `remote.${BACKUP_REMOTE}.pushurl`]);
    if (unset.status !== 5) saveError(unset);
    const effective = effectivePushUrls(root);
    if (!effective.ok || effective.urls.length !== 1) throw new Error("Weaver couldn't save the backup address in the book's Git settings.");
    const record = readBackupRecord(root) || freshRecord();
    if (changed || record.remote_url !== sanitizeGitText(address)) record.last_success = null;
    record.remote_url = sanitizeGitText(address);
    record.push_url = sanitizeGitText(effective.urls[0]);
    record.configured_at = new Date().toISOString();
    const attempt = pushOnce(root, { trigger: "setup", interactive, timeoutMs, expected: record.push_url });
    writeRecord(root, record, attempt);
    if (attempt.result === "ok") {
      // A new bare folder may name a branch that does not exist yet. Make a plain clone usable.
      try {
        const destination = localBackupPath(effective.urls[0], root);
        if (destination && git(destination, ["rev-parse", "--is-bare-repository"]).stdout?.trim() === "true"
          && git(destination, ["rev-parse", "--verify", "--quiet", "HEAD"]).status !== 0) {
          git(destination, ["symbolic-ref", "HEAD", `refs/heads/${attempt.branch}`]);
        }
      } catch { /* A successful backup must survive a failed convenience update. */ }
    }
    return { ok: attempt.result === "ok", remote_name: BACKUP_REMOTE, remote_url: record.remote_url, attempt };
  } finally { releaseLock(root, { resumePending: true }); }
}

export function backupNow(root, { interactive = false, timeoutMs = BACKUP_TIMEOUT_MS, trigger = "now" } = {}) {
  if (!readBackupRecord(root)) return { ok: false, configured: false, attempt: null, error: "Your book isn't backed up yet.", fix: "Ask the author to run `npx weaver backup setup --remote <address>` in a terminal in the book folder." };
  ensureBackupFilesIgnored(root);
  if (!waitForLock(root, timeoutMs)) return { ok: false, configured: true, attempt: null, error: "A backup is already running.", fix: "Check `npx weaver backup status` in a minute." };
  try {
    const record = readBackupRecord(root) || freshRecord();
    const attempt = pushOnce(root, { trigger, interactive, timeoutMs, expected: expectedAddress(record) });
    writeRecord(root, record, attempt);
    return { ok: attempt.result === "ok", configured: true, attempt };
  } finally { releaseLock(root, { resumePending: true }); }
}

export function startBackgroundBackup(root, { trigger = "decision" } = {}) {
  try {
    if (!existsSync(join(root, BACKUP_RECORD))) return { started: false, reason: "not-configured" };
    const child = spawn(process.execPath, [WORKER, resolve(root), trigger], { detached: true, stdio: "ignore", windowsHide: true, env: gitSafeEnv() });
    child.on("error", () => {});
    child.unref();
    return { started: true };
  } catch { return { started: false, reason: "error" }; }
}

export function backupAfterCommit(root) {
  return startBackgroundBackup(root, { trigger: "decision" });
}

export function runBackupWorker(root, { trigger = "decision", timeoutMs = BACKUP_TIMEOUT_MS } = {}) {
  try {
    if (!readBackupRecord(root)) return;
    ensureBackupFilesIgnored(root);
    const pending = join(root, PENDING);
    do {
      if (!acquireLock(root)) {
        writeFileSync(pending, "");
        if (!acquireLock(root)) return;
      }
      try {
        for (let round = 0; round < 5; round++) {
          remove(pending);
          const record = readBackupRecord(root) || freshRecord();
          const attempt = pushOnce(root, { trigger, interactive: false, timeoutMs, expected: expectedAddress(record) });
          writeRecord(root, record, attempt);
          if (!existsSync(pending)) break;
        }
      } finally { releaseLock(root); }
      // Re-acquire after releasing: a waiter may have marked pending at that boundary.
    } while (existsSync(pending));
  } catch { /* Backups never interrupt an author's work or write to the console. */ }
}

function unconfiguredStatus() {
  return { configured: false, remote_name: BACKUP_REMOTE, remote_url: null, branch: null, head: null,
    last_attempt: null, last_success: null, unpushed: { commits: 0, decisions: 0, overdue_decisions: 0, oldest_decision_at: null },
    running: false, state: "not-configured", summary: "Backup: your book isn't backed up yet", problems: [{ ...NOT_CONFIGURED }] };
}

export function backupStatus(root, { now = Date.now() } = {}) {
  const record = readBackupRecord(root);
  if (!record) return unconfiguredStatus();
  const remote = git(root, ["remote", "get-url", BACKUP_REMOTE]);
  const symbolic = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const saved = git(root, ["rev-parse", "--verify", "HEAD"]);
  const remote_url = remote.status === 0 ? sanitizeGitText(remote.stdout.trim()) : null;
  const branch = symbolic.status === 0 ? symbolic.stdout.trim() : null;
  const head = saved.status === 0 ? saved.stdout.trim() : null;
  const unpushed = { commits: 0, decisions: 0, overdue_decisions: 0, oldest_decision_at: null };
  if (head) {
    const log = git(root, ["log", "--format=%H%x00%ct%x00%(trailers:key=Approved-with,valueonly)%x00%(trailers:key=Imported-with,valueonly)%x1e", "HEAD", "--not", `--remotes=${BACKUP_REMOTE}`]);
    if (log.status !== 0) throw new Error("Weaver couldn't check which decisions are waiting for backup. Contact PickBits.");
    for (const entry of log.stdout.split("\x1e").map((item) => item.trim()).filter(Boolean)) {
      const [, seconds, approved, imported] = entry.split("\0");
      unpushed.commits++;
      if (!approved?.trim() && !imported?.trim()) continue;
      unpushed.decisions++;
      const at = Number(seconds) * 1000;
      if (now - at > 3600_000) unpushed.overdue_decisions++;
      if (!unpushed.oldest_decision_at || at < Date.parse(unpushed.oldest_decision_at)) unpushed.oldest_decision_at = new Date(at).toISOString();
    }
  }
  const last_attempt = record.attempts.at(-1) || null, last_success = record.last_success;
  const problems = [], states = [];
  const problem = (state, problem, why, fix) => { states.push(state); problems.push({ problem, why, fix }); };
  if (!remote_url) problem("remote-missing", "The backup address is missing from your book's Git settings", "Weaver can't back up the book without it.", "Run `npx weaver backup setup --remote <address>` again in a terminal.");
  else {
    if (!addressMatches(root, expectedAddress(record))) problem("address-changed", "Your backup address was changed outside Weaver", "Weaver can't be sure your latest decisions reach the backup you chose, so it stopped backing up.", "Run `npx weaver backup setup --remote <your backup address>` again in a terminal, or contact PickBits.");
    else if (last_attempt?.result === "failed") problem("failed", `Your last backup failed ${relativeTime(last_attempt.at, now)}: ${attemptError(last_attempt).replace(/\.$/u, "")}`, "Your latest decisions may be saved only on this computer.", attemptFix(last_attempt));
    const overdue = unpushed.overdue_decisions;
    if (overdue) problem("behind", `${overdue} author decision${overdue === 1 ? " has" : "s have"} not reached your backup for over an hour`, "Until they do, they are saved only on this computer.", "Run `npx weaver backup now` in a terminal, or restart the studio. If the backup fails, Weaver says what to fix.");
    if (last_success && now - Date.parse(last_success.at) > 86400_000) problem("stale", `Your last successful backup was ${relativeTime(last_success.at, now)}`, "Weaver hasn't confirmed for over a day that your backup still works.", "Run `npx weaver backup now` in a terminal, or restart the studio; it checks the backup when it starts.");
    if (!record.attempts.length) problem("unchecked", "Your backup hasn't been checked yet", "Weaver hasn't confirmed that your backup works.", "Run `npx weaver backup now` in a terminal.");
  }
  const state = states[0] || (unpushed.commits ? "waiting" : "up-to-date");
  let summary;
  if (problems.length) summary = `Backup: ${problems[0].problem[0].toLowerCase()}${problems[0].problem.slice(1)}`;
  else if (state === "waiting") {
    const count = unpushed.decisions || unpushed.commits, noun = unpushed.decisions ? "decision" : "change";
    summary = `Backup: ${count} new ${noun}${count === 1 ? "" : "s"} waiting to be backed up · ${last_success ? `last backup ${relativeTime(last_success.at, now)}` : "no backup yet"}`;
  } else summary = `Backup: up to date · ${relativeTime(last_success?.at, now)}`;
  const running = backupRunning(root);
  if (running) summary += " (backing up now)";
  return { configured: true, remote_name: BACKUP_REMOTE, remote_url, branch, head, last_attempt, last_success, unpushed, running, state, summary, problems };
}

export function backupNeeded(root, { now = Date.now() } = {}) {
  if (!existsSync(join(root, BACKUP_RECORD))) return false;
  try { return backupStatus(root, { now }).state !== "up-to-date"; }
  catch { return true; }
}

export function backupDoctorCheck(root, { now = Date.now(), inGit = true } = {}) {
  const base = { id: "backup", title: "Book is backed up" };
  try {
    const { problems, summary } = inGit ? backupStatus(root, { now }) : unconfiguredStatus();
    return { ...base, status: problems.length ? "warning" : "pass", findings: problems.map((item) => ({ ...base, ...item })), summary };
  } catch {
    return { ...base, status: "warning", findings: [{ ...base, problem: "Your backup couldn't be checked", why: "Weaver couldn't read its backup record or the book's Git settings.", fix: "Run `npx weaver backup status` to see the details, or contact PickBits." }], summary: "Backup: your backup couldn't be checked" };
  }
}

export function formatBackupStatus(status) {
  const lines = [status.summary];
  if (status.configured) {
    lines.push(`Address: ${status.remote_url || "(missing)"} (Git remote ${BACKUP_REMOTE})`);
    const last = status.last_success, attempt = status.last_attempt;
    lines.push(validSuccess(last) ? `Last backup: ${last.at} · commit ${last.commit.slice(0, 7)} on ${last.branch}` : "Last backup: never");
    if (attempt) lines.push(`Last attempt: ${typeof attempt.at === "string" ? attempt.at : "(unknown time)"} · ${attempt.result === "ok" ? "ok" : `failed: ${attemptError(attempt)}`}`);
    const { decisions, commits } = status.unpushed;
    lines.push(`Waiting to be backed up: ${decisions} author decision${decisions === 1 ? "" : "s"}, ${commits} commit${commits === 1 ? "" : "s"}`);
  }
  for (const item of status.problems) lines.push(`! ${item.problem}`, `  Why: ${item.why}`, `  Fix: ${item.fix}`);
  return lines.join("\n");
}
