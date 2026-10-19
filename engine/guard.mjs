// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
// These guards match normal commands and obvious disguises; they are not a sandbox.
// The AI runs as the same user and can work around them. Doctor, sealed settings,
// and approval history provide the support trail for changes that get through.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { normalizedSha256 } from "./integrity.mjs";
import { ensureIdentity } from "./changes.mjs";
import { GENERATOR } from "./identity.mjs";

export const AI_HOST_ENV = ["CLAUDECODE", "CODEX_CI", "CODEX_SESSION_ID", "CODEX_THREAD_ID"];
export const AUTHOR_ONLY_COMMANDS = ["approve", "reject", "undo", "rule", "proposal", "state:accept", "release", "import", "guard seal"];
export const PROTECTED_PATHS = [
  ".claude/**", ".codex/**", "CLAUDE.md", "AGENTS.md", "project.json", "package.json", "package-lock.json",
  ".gitignore", ".git/**", "node_modules/**", "quality/**", "narrative-state/**", "continuity/**",
  ".weaver/**", "releases/**", "review/**", "imports/**", "world-bible/characters.json"
];
// A book holds prose and notes. A script written into it could run author commands with the
// host markers stripped, so the AI may not create or edit code files anywhere in the book.
const CODE_FILE = /\.(?:m?js|cjs|ts|mts|cts|ps1|psm1|bat|cmd|sh|py|vbs|exe)$/iu;
export const SEALED_CONFIG_PATHS = [".claude/settings.json", ".claude/settings.local.json", ".codex/**", "CLAUDE.md", "AGENTS.md", "project.json", "quality/**"];
export const GUARD_CHECK_IDS = ["guardrails-installed", "book-settings-sealed", "approved-history", "protected-files-clean"];
export const WEAVER_DENY_RULES = [
  ...AUTHOR_ONLY_COMMANDS.flatMap((command) => ["weaver", "npx weaver", "npx --no-install weaver", "npx.cmd weaver"]
    .map((prefix) => `Bash(${prefix} ${command}:*)`)),
  "Edit(/.claude/**)", "Edit(/quality/**)"
];

const SETTINGS_REASON = "Weaver's settings can't be changed by the AI; if a rule seems wrong, tell the author so they can rule on the finding.";
const TOOL_REASON = "Weaver itself is installed and maintained by PickBits; tell the author if it seems broken.";
const AUTHOR_REASON = "That's the author's decision; ask them to use the author page (npx weaver studio).";

export function authorCommandRefusal(command, env = process.env) {
  if (!AUTHOR_ONLY_COMMANDS.includes(command) || !AI_HOST_ENV.some((name) => Object.keys(env).some((key) => key.toUpperCase() === name && env[key] !== undefined))) return null;
  return {
    error: command === "approve" ? "Approving is the author's decision" : "That's the author's decision",
    command,
    why: "Weaver only lets the author approve, reject, undo, rule on findings, accept story state, import, release or seal settings.",
    fix: "Ask the author to do this on the author page: run `npx weaver studio` and open http://127.0.0.1:4187. For sealing settings, contact PickBits."
  };
}

export function deny(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function matchesPath(path, pattern) {
  return pattern.endsWith("/**") ? path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2)) : path === pattern;
}

export function protectedPath(root, filePath) {
  if (typeof filePath !== "string" || !filePath) return null;
  const windows = /^[a-z]:[\\/]|^\\\\/iu.test(root) || /^[a-z]:/iu.test(filePath);
  const paths = windows ? win32 : posix;
  const base = root.replaceAll("\\", "/");
  const absolute = paths.resolve(base, filePath.replaceAll("\\", "/"));
  const relative = paths.relative(base, absolute).replaceAll("\\", "/");
  if (relative === ".." || relative.startsWith("../") || paths.isAbsolute(relative)) return "outside the book folder";
  const key = windows ? relative.toLowerCase() : relative;
  return PROTECTED_PATHS.some((pattern) => matchesPath(key, windows ? pattern.toLowerCase() : pattern)) ? relative : null;
}

export function hookBookRoot(payload) {
  const cwd = resolve(payload?.cwd || process.cwd());
  let root = cwd;
  while (!existsSync(join(root, "project.json"))) {
    const parent = dirname(root);
    if (root === parent) return cwd;
    root = parent;
  }
  return root;
}

export function editGuard(payload) {
  const root = hookBookRoot(payload);
  const input = payload?.tool_input;
  const paths = [input?.file_path, input?.notebook_path, ...(Array.isArray(input?.edits) ? input.edits.map((edit) => edit?.file_path) : [])];
  for (const path of paths) {
    if (typeof path !== "string" || !path) continue;
    if (CODE_FILE.test(path)) return deny(`${path.replaceAll("\\", "/").split("/").at(-1)}: Weaver lets the AI edit the book's prose and notes, not scripts. ${TOOL_REASON}`);
    const blocked = protectedPath(root, resolve(payload?.cwd || root, path.replaceAll("\\", "/")));
    if (blocked) return deny(`${blocked}: ${blocked.toLowerCase().startsWith("node_modules/") ? TOOL_REASON : SETTINGS_REASON}`);
  }
  return null;
}

export const GIT_WRITES = new Set("commit reset revert rebase restore checkout switch merge cherry-pick stash push pull am apply filter-branch filter-repo update-ref config tag clean gc reflog notes replace".split(" "));
export const INSTALL_WRITES = new Set("install i add uninstall remove update upgrade ci link rebuild".split(" "));
const READS = new Set("cat type get-content gc head tail less more grep rg select-string sls findstr wc ls dir get-childitem gci test-path stat".split(" "));
const executable = (token) => token.replaceAll("\\", "/").split("/").at(-1).replace(/\.(?:exe|cmd)$/iu, "").toLowerCase();
const shellWords = (text) => [...text.matchAll(/"([^"]*)"|'([^']*)'|([^\s<>(),{};&|]+)/gu)].map((match) => match[1] ?? match[2] ?? match[3]);

function gitCommandIndex(tokens, index) {
  let next = index + 1;
  while (tokens[next]?.startsWith("-")) {
    const flag = tokens[next++];
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(flag)) next += 1;
  }
  return next;
}

// `weaver report --out <file>` may save outside the book (the report refuses destinations inside one).
// An allowlist, not a blocklist: the whole raw command must be one Weaver launcher, `report`, and known
// options with literal values. Any shell syntax that could run, expand or redirect something else (Bash,
// PowerShell, zsh, cmd) means no exemption. Returns the --out value's pieces, or null.
const REPORT_WORD = /\s*(?:"([^"$`\r\n]*)"|'([^'$`\r\n]*)'|([\p{L}\p{N}_./\\:,+~-][\p{L}\p{N}_./\\:,+~@-]*))(?=\s|$)/uy;
const reportPieces = (value) => [value, ...(value.match(/[^\s<>(),{}]+/gu) || [])];
function reportOutExemption(command) {
  const text = command.trim(), words = [];
  if (/[\r\n]/u.test(text)) return null;
  for (REPORT_WORD.lastIndex = 0; REPORT_WORD.lastIndex < text.length;) {
    const match = REPORT_WORD.exec(text);
    // A trailing backslash joins words in Bash or continues a double-quoted string.
    if (!match || /\\$/u.test(match[1] ?? match[2] ?? match[3])) return null;
    words.push(match[3] === undefined ? { value: match[1] ?? match[2] } : { value: match[3], plain: true });
  }
  const plain = (index) => (words[index]?.plain ? words[index].value : "");
  let at = 0;
  // Only Weaver's own launchers: npx [--no-install] weaver, node_modules/.bin/weaver, or node with the package script.
  if (/^node(?:\.exe)?$/iu.test(plain(0)) && /(?:^|[\\/])node_modules[\\/]@pickbitsai[\\/]weaver[\\/]scripts[\\/]weaver\.mjs$/iu.test(plain(1))) at = 2;
  else {
    if (/^npx(?:\.cmd)?$/iu.test(plain(0))) at = plain(1) === "--no-install" ? 2 : 1;
    if (!/^(?:(?:\.[\\/])?node_modules[\\/]\.bin[\\/])?weaver(?:\.cmd)?$/iu.test(plain(at))) return null;
    at += 1;
  }
  // `@` is literal inside a launcher path (node_modules/@pickbitsai/...) or quotes; refused elsewhere.
  if (plain(at) !== "report" || words.slice(at).some((word) => word.plain && word.value.includes("@"))) return null;
  let out = null;
  const others = [];
  for (let index = at + 1; index < words.length; index += 1) {
    const option = plain(index), value = words[index + 1]?.value;
    if (option === "--json") continue;
    if (!["--out", "--root", "--chapters", "--sections"].includes(option) || !value || value.startsWith("-")) return null;
    index += 1;
    if (option !== "--out") others.push(...reportPieces(value));
    else if (out === null) out = value;
    else return null;
  }
  const pieces = out === null ? [] : reportPieces(out);
  return pieces.length && !others.some((piece) => pieces.includes(piece)) ? new Set(pieces) : null;
}

export function shellGuard(payload, depth = 0) {
  const command = payload?.tool_input?.command;
  if (typeof command !== "string" || !command.trim()) return null;
  const words = shellWords(command);
  if (depth < 4 && ["cmd", "powershell", "pwsh", "bash", "sh"].includes(executable(words[0] || ""))) {
    const flag = words.findIndex((word) => ["/c", "-command", "-c"].includes(word.toLowerCase()));
    const body = words[flag + 1];
    if (flag > 0 && typeof body === "string" && /\s/u.test(body)) {
      const result = shellGuard({ ...payload, tool_input: { command: body } }, depth + 1);
      if (result || flag + 2 === words.length) return result;
    }
  }
  const root = hookBookRoot(payload);
  const cwd = resolve(payload?.cwd || root);
  // Flatten quotes to see commands inside cmd /c, powershell -Command, bash -c,
  // and code strings. This is deliberately conservative, not a shell parser.
  const flat = command.replace(/["'`]/gu, " ");
  const author = /(?:^|[\s/\\;&|()])(?:weaver(?:\.cmd)?|[^\s]*weaver\.mjs)\s+(approve|reject|undo|rule|proposal|state:accept|release|import|guard\s+seal)(?=\s|$|[;&|])/iu.exec(flat);
  if (author) {
    const chapter = /--chapter(?:=|\s+)(\d+)/iu.exec(flat)?.[1];
    return deny(chapter && author[1].toLowerCase() === "approve" ? `That's the author's decision; ask them to approve chapter ${chapter} on the author page.` : AUTHOR_REASON);
  }
  let project = {};
  if (existsSync(join(root, "project.json"))) project = JSON.parse(readFileSync(join(root, "project.json"), "utf8"));
  const port = Number(project.studio_port ?? project.studio?.port ?? 4187);
  const localUrl = new RegExp(`(?:localhost|127\\.0\\.0\\.1|\\[::1\\])\\s*:\\s*${port}(?![0-9])`, "iu");
  if (localUrl.test(flat) && /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b|\bnode(?:\.exe)?\s+(?:-e|--eval)\b|\bfetch\s*\(/iu.test(flat)) return deny(AUTHOR_REASON);

  // Preserve quoted directory arguments for git -C, and inspect a flattened
  // view as well so quoted wrapper commands cannot conceal an invocation.
  for (const tokens of [words, shellWords(flat)]) {
    for (let index = 0; index < tokens.length; index += 1) {
      const name = executable(tokens[index]);
      let next = index + 1;
      if (name === "git") {
        next = gitCommandIndex(tokens, index);
        const subcommand = tokens[next]?.toLowerCase();
        if (GIT_WRITES.has(subcommand) || (subcommand === "branch" && tokens.slice(next + 1).some((token) => /^-(?:[dDmM]|.*[dDmM])$|^--(?:delete|move)(?:=|$)/u.test(token)))) return deny(`Book history belongs to the author. ${AUTHOR_REASON}`);
      }
      if (["npm", "pnpm", "yarn"].includes(name)) {
        while (tokens[next]?.startsWith("-")) next += 1;
        if (INSTALL_WRITES.has(tokens[next]?.toLowerCase())) return deny(TOOL_REASON);
      }
      if (name === "npx" && tokens.slice(next).some((token) => /^(?:@pickbitsai\/)?weaver@|^--package(?:=|$)|^-p$/iu.test(token))) return deny(TOOL_REASON);
    }
  }
  for (const segment of flat.split(/[;&|\r\n]+/u)) {
    const tokens = segment.match(/[^\s<>(),{}]+|>>?/gu) || [];
    // Read-only Git queries and tool invocations can name protected files as
    // inputs. Strip only the executable, never a path passed to rm/cp/etc.
    const first = executable(tokens[0] || "");
    // Changing directory is not a write (npm test in another folder is fine).
    const readOnly = READS.has(first) || ["cd", "set-location"].includes(first) || (first === "git" && ["status", "log", "diff", "show", "blame"].includes(tokens[gitCommandIndex(tokens, 0)]));
    const withoutLauncher = segment.replace(/^\s*(?:node(?:\.exe)?\s+[^\s]*weaver\.mjs|(?:npx(?:\.cmd)?\s+(?:--no-install\s+)?)?[^\s]*weaver(?:\.cmd)?)\s+/iu, "");
    // Also inspect quoted paths with spaces (the flattened tokens handle code
    // strings such as fs.writeFileSync('quality/rules.json', ...)).
    const candidates = [...(withoutLauncher.match(/[^\s<>(),{}]+|>>?/gu) || [])];
    // `weaver report --out <file>` may save outside the book; reportOutExemption (an allowlist over
    // the raw command) decides when that one destination skips the outside-the-book check.
    const reportOut = reportOutExemption(command);
    // After a Weaver launcher the next word is its subcommand (e.g. `review`), not a path.
    if (withoutLauncher !== segment) candidates.shift();
    for (const match of command.matchAll(/["']([^"'\r\n]+)["']/gu)) if (/^[a-z]:[\\/]|^\.{1,2}[\\/]|^\//iu.test(match[1])) candidates.push(match[1]);
    for (const token of candidates) {
      if (token.startsWith("-") || token.includes("://") || token === ">" || token === ">>") continue;
      const blocked = protectedPath(root, resolve(cwd, token.replaceAll("\\", "/")));
      // A bare word is not necessarily a path; named protected files and
      // explicit absolute/parent paths are the useful signals here.
      const redirectTarget = new RegExp(`>+\\s*${token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:\\s|$)`, "u").test(segment);
      if (reportOut?.has(token) && blocked === "outside the book folder" && !redirectTarget) continue;
      if (blocked && (!readOnly || redirectTarget)) return deny(`${blocked}: ${blocked.toLowerCase().startsWith("node_modules/") ? TOOL_REASON : SETTINGS_REASON}`);
    }
  }
  return null;
}

export function guardedConfigFiles(root) {
  const files = [];
  function walk(directory, prefix) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), path);
      else files.push(path);
    }
  }
  for (const pattern of SEALED_CONFIG_PATHS) {
    if (!PROTECTED_PATHS.some((protectedPattern) => matchesPath(pattern.replace(/\/\*\*$/u, ""), protectedPattern))) throw new Error("The seal must cover only protected settings.");
    if (pattern.endsWith("/**")) walk(join(root, pattern.slice(0, -3)), pattern.slice(0, -3));
    else files.push(pattern);
  }
  return files.sort();
}

function fingerprints(root) {
  return Object.fromEntries(guardedConfigFiles(root).map((path) => [path, existsSync(join(root, path)) ? normalizedSha256(join(root, path)) : null]));
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`Could not check the book's history: ${(result.stderr || "").trim()}`);
  return result.stdout;
}

export function sealBookSettings(root, project) {
  const seal = { version: 1, generator: GENERATOR, files: fingerprints(root) };
  mkdirSync(join(root, ".weaver"), { recursive: true });
  const path = join(root, ".weaver", "guard.json");
  const content = `${JSON.stringify(seal, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") === content && !git(root, ["status", "--porcelain", "--", ".weaver/guard.json"]).trim()) return { path, changed: false };
  writeFileSync(path, content);
  ensureIdentity(root, project);
  git(root, ["add", "--", ".weaver/guard.json"]);
  git(root, ["commit", "--only", "-m", "Seal book settings", "-m", `Approved-with: ${GENERATOR}`, "--", ".weaver/guard.json"]);
  return { path, changed: true };
}

export function compareBookSettings(root) {
  const path = join(root, ".weaver", "guard.json");
  if (!existsSync(path)) return { status: "warning", paths: [] };
  const seal = JSON.parse(readFileSync(path, "utf8"));
  if (seal.version !== 1 || !seal.files || typeof seal.files !== "object" || Array.isArray(seal.files)) throw new Error("The settings seal cannot be read.");
  const current = fingerprints(root);
  const paths = [...new Set([...Object.keys(current), ...Object.keys(seal.files)])].filter((key) => current[key] !== seal.files[key]).sort();
  return { status: paths.length ? "blocking" : "pass", paths };
}

export function unapprovedHistory(root, sourceRoot) {
  if (spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { stdio: "ignore" }).status !== 0) return [];
  const format = "%H%x00%s%x00%(trailers:key=Approved-with,valueonly)%x00%(trailers:key=Imported-with,valueonly)%x1e";
  const entries = git(root, ["log", "--topo-order", `--format=${format}`]).split("\x1e").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [sha, subject, approved, imported] = entry.split("\0");
    return { sha, subject, approved: approved?.trim(), imported: imported?.trim() };
  });
  const baseline = entries.find((entry) => entry.imported) || entries.at(-1);
  const since = new Set(git(root, ["rev-list", `${baseline.sha}..HEAD`]).trim().split(/\s+/u));
  return entries.filter((entry) => since.has(entry.sha) && !entry.approved && git(root, ["diff-tree", "--root", "-m", "--no-commit-id", "--name-only", "--no-renames", "-r", entry.sha, "--", sourceRoot]).trim())
    .map(({ sha, subject }) => ({ sha: sha.slice(0, 7), subject }));
}

export function dirtyGuardedConfig(root) {
  const output = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--", ...SEALED_CONFIG_PATHS.map((path) => path.replace(/\/\*\*$/u, ""))]);
  const records = output.split("\0");
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    if (!records[index]) continue;
    paths.push(records[index].slice(3));
    if (/[RC]/u.test(records[index].slice(0, 2)) && records[index + 1]) paths.push(records[++index]);
  }
  return [...new Set(paths)].sort();
}
