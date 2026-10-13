// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_HOST = Object.freeze({
  kind: "claude",
  command: "claude",
  args: ["-p", "--output-format", "text"],
  concurrency: 2,
  timeout_seconds: 600
});

export function withHost(project, kind) {
  if (!kind) return project;
  if (!["claude", "codex"].includes(kind)) throw new Error("Choose claude or codex for the AI host.");
  const host = { ...project.host, kind };
  if (kind !== (project.host?.kind || "claude")) {
    delete host.command;
    delete host.args;
  }
  return { ...project, host };
}

export function hostConfig(project = {}) {
  const configured = project.host || {};
  const kind = configured.kind || "claude";
  if (!["claude", "codex"].includes(kind)) throw new Error("Choose claude or codex for the AI host.");
  return {
    kind,
    command: configured.command || kind,
    args: Array.isArray(configured.args) ? [...configured.args] : kind === "codex" ? [] : [...DEFAULT_HOST.args],
    reasoning_effort: configured.reasoning_effort || "medium",
    concurrency: configured.concurrency || DEFAULT_HOST.concurrency,
    timeout_seconds: configured.timeout_seconds || DEFAULT_HOST.timeout_seconds
  };
}

export function safeEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"].includes(name.toUpperCase())) delete environment[name];
  }
  return environment;
}

function executableForShell(command) {
  if (process.platform !== "win32" || !/\s/u.test(command) || /^".*"$/u.test(command)) return command;
  return `"${command.replaceAll('"', '\\"')}"`;
}

function runAttempt(config, promptText) {
  return new Promise((resolve) => {
    const started = Date.now();
    const temporary = config.kind === "codex" ? mkdtempSync(join(tmpdir(), "weaver-codex-")) : null;
    const output = temporary && join(temporary, "answer.txt");
    const args = config.kind === "codex"
      ? ["exec", ...config.args, "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check",
        "-c", `model_reasoning_effort=${config.reasoning_effort}`, "-c", "model_provider=openai",
        "-c", "forced_login_method=chatgpt", "-o", output, "-"]
      : config.args;
    const cleanup = () => { if (temporary) rmSync(temporary, { recursive: true, force: true }); };
    let child;
    try {
      child = spawn(executableForShell(config.command), process.platform === "win32" ? args.map((arg) => /[\s"&|<>^()]/u.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg) : args, {
        cwd: config.cwd,
        env: safeEnvironment(),
        shell: process.platform === "win32",
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      cleanup();
      resolve({ ok: false, text: "", seconds: (Date.now() - started) / 1000, error: `could not start host: ${error.message}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({ ...result, seconds: (Date.now() - started) / 1000 });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => {
      // A host that exits before consuming its prompt may close stdin with EPIPE.
    });
    child.on("error", (error) => {
      finish({ ok: false, text: stdout, error: `could not start host: ${error.message}` });
    });
    child.on("close", (code, signal) => {
      if (timedOut) return;
      let answer = stdout;
      if (output) {
        try { answer = readFileSync(output, "utf8"); } catch { answer = ""; }
      }
      if (code !== 0) {
        const detail = stderr.trim() ? `: ${stderr.trim().replace(/\s+/gu, " ").slice(0, 240)}` : "";
        finish({ ok: false, text: stdout, error: `host exited with ${signal ? `signal ${signal}` : `code ${code}`}${detail}` });
      } else if (!answer.trim()) {
        finish({ ok: false, text: "", error: "host returned empty output" });
      } else {
        finish({ ok: true, text: answer });
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      else if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill(); } }
      finish({ ok: false, text: stdout, error: `host timed out after ${config.timeout_seconds} seconds` });
    }, config.timeout_seconds * 1000);
    try {
      child.stdin.end(promptText, () => {});
    } catch (error) {
      finish({ ok: false, text: stdout, error: `could not send prompt to host: ${error.message}` });
    }
  });
}

export async function runHost(root, project, promptText, { attempts = 2 } = {}) {
  const config = { ...hostConfig(project), cwd: root };
  const failures = [];
  const started = Date.now();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runAttempt(config, promptText);
    if (result.ok) {
      return { ok: true, text: result.text, seconds: (Date.now() - started) / 1000, attempts: attempt };
    }
    failures.push(`attempt ${attempt}: ${result.error}`);
  }
  return {
    ok: false,
    text: "",
    seconds: (Date.now() - started) / 1000,
    attempts,
    error: `host failed after ${attempts} attempts: ${failures.join("; ")}`
  };
}

export async function runHostBatch(root, project, prompts, { concurrency } = {}) {
  const limit = Math.min(4, Math.max(1, Number(concurrency || hostConfig(project).concurrency) || 1));
  const results = new Array(prompts.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= prompts.length) return;
      results[index] = await runHost(root, project, prompts[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, prompts.length) }, () => worker()));
  return results;
}

export function hostAvailable(project, timeoutMs = 15_000) {
  const config = hostConfig(project);
  if (!/[\\/]/u.test(config.command)) {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const found = spawnSync(locator, [config.command], { encoding: "utf8", timeout: Math.min(timeoutMs, 2_000), stdio: ["ignore", "pipe", "ignore"] });
    if (found.status !== 0) return false;
  }
  const result = spawnSync(executableForShell(config.command), ["--version"], {
    env: safeEnvironment(),
    shell: process.platform === "win32",
    timeout: timeoutMs,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return result.status === 0 && !result.error;
}
