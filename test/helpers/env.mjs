// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { AI_HOST_ENV } from "../../engine/guard.mjs";

// CLI tests impersonate an author, regardless of which AI host runs npm test.
export function authorEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) if (AI_HOST_ENV.includes(key.toUpperCase())) delete env[key];
  return env;
}
