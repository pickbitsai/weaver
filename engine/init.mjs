import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_ID_PATTERN } from "./project.mjs";

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_ROOT = join(ENGINE_ROOT, "templates", "book");

export function initializeProject(target, { projectId = "untitled-book", title = "Untitled Book" } = {}) {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error("project id must use lowercase letters, numbers, and hyphens");
  }
  if (!title.trim()) throw new Error("title is required");
  const destination = resolve(target);
  if (existsSync(destination) && readdirSync(destination).length) {
    throw new Error(`refusing to initialize non-empty directory: ${destination}`);
  }
  mkdirSync(destination, { recursive: true });
  cpSync(TEMPLATE_ROOT, destination, { recursive: true });
  const projectPath = join(destination, "project.json");
  const project = JSON.parse(readFileSync(projectPath, "utf8"));
  project.project_id = projectId;
  project.title = title.trim();
  writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
  return destination;
}
