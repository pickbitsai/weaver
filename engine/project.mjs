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
  return errors;
}
