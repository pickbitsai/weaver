// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const PACKAGE = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));

export const PRODUCT_NAME = "PickBits Weaver";
export const VERSION = PACKAGE.version;
export const GENERATOR = `${PRODUCT_NAME} ${VERSION}`;
export const HOMEPAGE = "https://github.com/pickbitsai/weaver";
export const LICENSE_ID = "Apache-2.0";
export const SCHEMA_BASE = "https://pickbits.ai/schemas/weaver/";

const SPDX_HEADER = `// SPDX-License-Identifier: ${LICENSE_ID}`;
const COPYRIGHT_HEADER = "// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.";

export function checkIdentityHeader(filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    return { ok: false, reason: `cannot read file: ${error.message}` };
  }
  const lines = text.split(/\r?\n/);
  const offset = lines[0]?.startsWith("#!") ? 1 : 0;
  if (lines[offset] !== SPDX_HEADER) {
    return { ok: false, reason: `missing SPDX header on line ${offset + 1}` };
  }
  if (lines[offset + 1] !== COPYRIGHT_HEADER) {
    return { ok: false, reason: `missing copyright header on line ${offset + 2}` };
  }
  return { ok: true, reason: null };
}
