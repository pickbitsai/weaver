// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

export const PROJECT_FILE = "project.json";
export const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readProject(root) {
  const path = join(root, PROJECT_FILE);
  if (!existsSync(path)) throw new Error(`missing ${PROJECT_FILE} in ${root}`);
  const project = readJson(path);
  const errors = validateProject(project);
  if (errors.length) throw new Error(`invalid ${PROJECT_FILE}:\n- ${errors.join("\n- ")}`);
  return project;
}

export function validateProject(project) {
  const errors = [];
  for (const key of ["project_id", "kind", "title", "source_root", "state_root", "release_root"]) {
    if (!project?.[key]) errors.push(`${key} is required`);
  }
  if (project?.version !== 1) errors.push("version must be 1");
  if (project?.kind !== "book") errors.push("kind must be book");
  if (project?.project_id && !PROJECT_ID_PATTERN.test(project.project_id)) {
    errors.push("project_id must use lowercase letters, numbers, and hyphens");
  }
  for (const key of ["source_root", "state_root", "release_root", "reader_state_path", "outline_scene_root"]) {
    const value = project?.[key];
    if (!value) continue;
    if (isAbsolute(value) || normalize(value).split(/[\\/]/).includes("..")) {
      errors.push(`${key} must stay inside the project root`);
    }
  }
  if (project?.host !== undefined) {
    if (!project.host || typeof project.host !== "object" || Array.isArray(project.host)) errors.push("host must be an object");
    else {
      if (project.host.command !== undefined && (typeof project.host.command !== "string" || !project.host.command.trim())) errors.push("host.command must be a non-empty string");
      if (project.host.args !== undefined && (!Array.isArray(project.host.args) || project.host.args.some((arg) => typeof arg !== "string"))) errors.push("host.args must be a string array");
      if (project.host.concurrency !== undefined && (!Number.isInteger(project.host.concurrency) || project.host.concurrency < 1 || project.host.concurrency > 4)) errors.push("host.concurrency must be an integer from 1 to 4");
      if (project.host.timeout_seconds !== undefined && (!Number.isInteger(project.host.timeout_seconds) || project.host.timeout_seconds < 1)) errors.push("host.timeout_seconds must be a positive integer");
    }
  }
  if (project?.studio !== undefined) {
    if (!project.studio || typeof project.studio !== "object" || Array.isArray(project.studio)) errors.push("studio must be an object");
    else if (project.studio.port !== undefined && (!Number.isInteger(project.studio.port) || project.studio.port < 1 || project.studio.port > 65535)) errors.push("studio.port must be an integer from 1 to 65535");
  }
  return errors;
}
