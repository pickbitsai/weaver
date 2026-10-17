// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli synthetic"); process.exit(0); }
if (args[0] === "login") { console.error("Logged in using ChatGPT"); process.exit(0); }
if (args[0] === "app-server") {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    let result = {};
    if (request.method === "hooks/list") {
      const root = request.params.cwds[0], path = join(root, ".codex", "hooks.json");
      const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
      result = { data: [{ cwd: root, errors: [], warnings: [], hooks: Object.entries(settings.hooks || {}).flatMap(([event, entries]) => entries.flatMap((entry) => entry.hooks.map((hook) => ({ command: hook.command, eventName: event[0].toLowerCase() + event.slice(1), matcher: entry.matcher, sourcePath: path, enabled: true, trustStatus: process.env.WEAVER_FAKE_CODEX_TRUST || "trusted" })))) }] };
    }
    if (request.method === "config/read") result = { config: { features: { hooks: true } } };
    console.log(JSON.stringify({ id: request.id, result }));
  }
  process.exit(0);
}
if (args[0] !== "exec") throw new Error("Expected codex exec");
const value = (flag) => args[args.indexOf(flag) + 1];
if (!args.includes("-o") || value("--sandbox") !== "read-only" || !args.includes("--ephemeral") || !args.includes("--skip-git-repo-check") || args.at(-1) !== "-") throw new Error("Missing packet flags");
const prompt = readFileSync(0, "utf8");
mkdirSync(".weaver", { recursive: true });
writeFileSync(".weaver/codex-call.json", JSON.stringify({ args, prompt, keys: Object.keys(process.env).filter((key) => /^(?:OPENAI|CODEX|ANTHROPIC)_API_KEY$/iu.test(key)) }));
console.log("stdout noise: this is NOT the packet answer");
const mode = args.includes("--fake-mode") ? value("--fake-mode") : "happy";
if (mode === "missing-output") process.exit(0);
if (args.includes("--fixture")) {
  const fixture = value("--fixture") === "proposal" ? "proposal-host.mjs" : "fake-host.mjs";
  const answer = spawnSync(process.execPath, [fileURLToPath(new URL(fixture, import.meta.url)), mode], { input: prompt, encoding: "utf8" });
  if (answer.status !== 0) process.exit(answer.status || 1);
  writeFileSync(value("-o"), answer.stdout);
} else writeFileSync(value("-o"), `Answer from -o: ${prompt}`);
