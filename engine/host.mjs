// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { spawn, spawnSync } from "node:child_process";

export const DEFAULT_HOST = Object.freeze({
  command: "claude",
  args: ["-p", "--output-format", "text"],
  concurrency: 2,
  timeout_seconds: 600
});

export function hostConfig(project = {}) {
  const configured = project.host || {};
  return {
    command: configured.command || DEFAULT_HOST.command,
    args: Array.isArray(configured.args) ? [...configured.args] : [...DEFAULT_HOST.args],
    concurrency: configured.concurrency || DEFAULT_HOST.concurrency,
    timeout_seconds: configured.timeout_seconds || DEFAULT_HOST.timeout_seconds
  };
}

function safeEnvironment() {
  const environment = { ...process.env };
  delete environment.ANTHROPIC_API_KEY;
  return environment;
}

function executableForShell(command) {
  if (process.platform !== "win32" || !/\s/u.test(command) || /^".*"$/u.test(command)) return command;
  return `"${command.replaceAll('"', '\\"')}"`;
}

function runAttempt(config, promptText) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(executableForShell(config.command), config.args, {
        cwd: config.cwd,
        env: safeEnvironment(),
        shell: process.platform === "win32",
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
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
      if (code !== 0) {
        const detail = stderr.trim() ? `: ${stderr.trim().replace(/\s+/gu, " ").slice(0, 240)}` : "";
        finish({ ok: false, text: stdout, error: `host exited with ${signal ? `signal ${signal}` : `code ${code}`}${detail}` });
      } else if (!stdout.trim()) {
        finish({ ok: false, text: stdout, error: "host returned empty output" });
      } else {
        finish({ ok: true, text: stdout });
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish({ ok: false, text: stdout, error: `host timed out after ${config.timeout_seconds} seconds` });
    }, config.timeout_seconds * 1000);
    try {
      child.stdin.end(promptText, () => {});
    } catch (error) {
      finish({ ok: false, text: stdout, error: `could not send prompt to host: ${error.message}` });
    }
  });
}

export async function runHost(root, project, promptText) {
  const config = { ...hostConfig(project), cwd: root };
  const failures = [];
  const started = Date.now();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
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
    attempts: 2,
    error: `host failed after 2 attempts: ${failures.join("; ")}`
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
