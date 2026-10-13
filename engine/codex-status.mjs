// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { safeEnvironment } from "./host.mjs";

// Ask Codex for its effective config and hash-based trust decisions. Never read
// auth.json or attempt to manufacture a trust record in the user's config.
export function probeCodex(root, codexHome) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), root], {
    env: { ...safeEnvironment(), CODEX_HOME: codexHome }, encoding: "utf8",
    timeout: 12_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"]
  });
  try { return JSON.parse(result.stdout); } catch { return { available: false, error: "Codex status could not be checked" }; }
}

async function inspect(root) {
  const options = { env: safeEnvironment(), shell: process.platform === "win32", windowsHide: true };
  const version = spawnSync("codex", ["--version"], { ...options, encoding: "utf8", timeout: 2000 });
  if (version.status !== 0) return { available: false };
  const login = spawnSync("codex", ["login", "status"], { ...options, encoding: "utf8", timeout: 2000 });
  const loggedIn = login.status === 0;
  const chatgpt = loggedIn && /ChatGPT/iu.test(`${login.stdout} ${login.stderr}`);
  return new Promise((done) => {
    const child = spawn("codex", ["app-server", "--stdio"], { ...options, cwd: root, stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "", hooks, config, finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.end();
      if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else child.kill();
      done({ available: true, loggedIn, chatgpt, hooks, config, ...(error ? { error } : {}) });
    };
    const send = (id, method, params) => child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    child.stdin.on("error", () => {});
    child.on("error", () => finish("Codex hook trust could not be checked"));
    child.on("close", () => { if (!finished) finish("Codex hook trust could not be checked"); });
    const timer = setTimeout(() => finish("Codex hook trust check timed out"), 7000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.error) { finish("Codex could not report its hook trust or settings"); return; }
        if (message.id === 1) {
          send(2, "hooks/list", { cwds: [root] });
          send(3, "config/read", { cwd: root, includeLayers: true });
        }
        if (message.id === 2) hooks = message.result?.data?.[0];
        if (message.id === 3) {
          const value = message.result?.config || {};
          config = { hooksEnabled: value.features?.hooks !== false && value.features?.codex_hooks !== false, sandboxMode: value.sandbox_mode, windowsSandbox: value.windows?.sandbox };
        }
        if (hooks && config) finish();
      }
    });
    send(1, "initialize", { clientInfo: { name: "weaver-doctor", version: "1" } });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await inspect(resolve(process.argv[2]))));
}
