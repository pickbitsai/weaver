// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_BASE } from "./identity.mjs";

const CHARACTERS_PATH = join("world-bible", "characters.json");
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function kebabCase(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/([a-z\d])([A-Z])/gu, "$1-$2")
    .replace(/^-+|-+$/gu, "")
    .toLocaleLowerCase();
}

function validateCharacter(character, index) {
  const errors = [];
  if (!character || typeof character !== "object" || Array.isArray(character)) return [`characters[${index}] must be an object`];
  if (typeof character.id !== "string" || !ID_PATTERN.test(character.id)) errors.push(`characters[${index}].id must be kebab-case`);
  if (typeof character.name !== "string" || !character.name.trim()) errors.push(`characters[${index}].name must be a non-empty string`);
  if (!Array.isArray(character.aliases) || character.aliases.some((alias) => typeof alias !== "string" || !alias.trim())) {
    errors.push(`characters[${index}].aliases must be a string array`);
  }
  if (typeof character.pov !== "boolean") errors.push(`characters[${index}].pov must be boolean`);
  return errors;
}

export function validateCharacters(document) {
  const errors = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) return ["characters file must contain an object"];
  if (document.version !== 1) errors.push("version must be 1");
  if (!Array.isArray(document.characters)) errors.push("characters must be an array");
  if (Array.isArray(document.characters)) {
    const ids = new Set();
    for (const [index, character] of document.characters.entries()) {
      errors.push(...validateCharacter(character, index));
      if (typeof character?.id === "string") {
        if (ids.has(character.id)) errors.push(`characters[${index}].id must be unique`);
        ids.add(character.id);
      }
    }
  }
  return errors;
}

export function charactersPath(root) {
  return join(root, CHARACTERS_PATH);
}

export function loadCharacters(root) {
  const path = charactersPath(root);
  if (!existsSync(path)) return { $schema: `${SCHEMA_BASE}characters-1.json`, version: 1, characters: [] };
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid ${CHARACTERS_PATH}: ${error.message}`);
  }
  const errors = validateCharacters(document);
  if (errors.length) throw new Error(`invalid ${CHARACTERS_PATH}:\n- ${errors.join("\n- ")}`);
  return document;
}

export function seedCharacters(root, povNames) {
  const path = charactersPath(root);
  const current = loadCharacters(root);
  const characters = [...current.characters];
  const existingIds = new Set(characters.map((character) => character.id));
  const names = [...new Set(povNames.map((name) => String(name).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const added = [];
  for (const name of names) {
    const id = kebabCase(name);
    if (!id || existingIds.has(id)) continue;
    const character = { id, name, aliases: [], pov: true };
    characters.push(character);
    existingIds.add(id);
    added.push(character);
  }
  characters.sort((left, right) => left.id.localeCompare(right.id));
  const next = { ...current, characters };
  if (added.length || !existsSync(path)) {
    mkdirSync(join(root, "world-bible"), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  }
  return { path, added, characters: next.characters };
}

export function characterKebabCase(value) {
  return kebabCase(value);
}
