// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
// All CLI/doctor tests use a synthetic Codex and temporary config, never the
// developer's installed host, credentials, hook trust, or global settings.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = mkdtempSync(join(tmpdir(), "weaver-test-hosts-"));
mkdirSync(join(directory, "codex-home"));
process.env.CODEX_HOME = join(directory, "codex-home");
const fixture = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
if (process.platform === "win32") writeFileSync(join(directory, "codex.cmd"), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
else writeFileSync(join(directory, "codex"), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
process.env.PATH = `${directory}${delimiter}${process.env.PATH}`;
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
