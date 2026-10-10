import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha } from './common.mjs';

const slash = s => s.replaceAll('\\', '/');
async function walk(root, sub = '') {
  let names;
  try { names = await readdir(path.join(root, sub), { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const d of names) {
    if (['.git', 'node_modules', 'out'].includes(d.name)) continue;
    const rel = slash(path.join(sub, d.name));
    if (d.isDirectory()) found.push(...await walk(root, rel));
    else if (d.isFile()) found.push(rel);
  }
  return found.sort();
}
function sceneFamily(rel) {
  // These are generated work packets. Explain the folder once, while retaining
  // every member in `files` so its size and hash still cover the whole set.
  if (rel.startsWith('.weaver/packets/')) return '.weaver/packets/';
  if (/chapter[-_]\d+\/scene[-_]\d+/i.test(rel)) return rel.replace(/chapter[-_]\d+/i, 'chapter-NN').replace(/scene[-_]\d+/i, 'scene-NN');
  if (/(^|\/)\d+[-_]\d+\.[^/]+$/.test(rel)) return rel.replace(/\d+[-_]\d+(?=\.[^/]+$)/, 'NN-NN');
  return null;
}
async function makeEntry(root, files, display, group) {
  const chunks = [];
  let single;
  let size = 0;
  let excerpt = '';
  for (const rel of files) {
    const buffer = await readFile(path.join(root, rel));
    single = buffer;
    size += buffer.length;
    chunks.push(rel, '\0', buffer, '\0');
    if (!excerpt) {
      excerpt = /(^|\/)\.env(?:\.|$)/.test(rel) ? '[redacted configuration]' : buffer.includes(0) ? '[binary file; no text excerpt]' : buffer.toString('utf8').split(/\r?\n/).slice(0, 8).map(line => /(api[_-]?key|secret|token|password)\s*[:=]/i.test(line) ? '[redacted sensitive line]' : line).join('\n').slice(0, 900);
    }
  }
  return { path: display, group, size, sha256: files.length === 1 ? sha(single) : sha(Buffer.concat(chunks.map(x => Buffer.isBuffer(x) ? x : Buffer.from(x)))), excerpt, files, update_policy: group === 'The tool' ? 'Do not edit; Weaver updates this.' : 'Your book file.' };
}
export async function inventory(book, toolRoot = path.join(book, 'node_modules', '@pickbitsai', 'weaver')) {
  const bookFiles = await walk(book);
  const families = new Map();
  for (const rel of bookFiles) {
    const fam = sceneFamily(rel);
    const key = fam || rel;
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(rel);
  }
  const entries = [];
  for (const [key, files] of families) entries.push(await makeEntry(book, files, key === '.weaver/packets/' ? key : files.length > 1 ? `${key}: one file per scene` : key, 'Your book'));
  const toolFiles = await walk(toolRoot);
  const toolGroups = new Map();
  for (const rel of toolFiles) {
    const top = rel.split('/')[0];
    if (!['scripts', 'engine', 'studio', 'prompts', 'templates', 'contracts'].includes(top) && rel !== 'integrity.json') continue;
    const key = top === 'engine' ? rel : top === 'scripts' && rel === 'scripts/weaver.mjs' ? rel : top === 'scripts' ? 'scripts/' : top === 'integrity.json' ? rel : `${top}/`;
    if (!toolGroups.has(key)) toolGroups.set(key, []);
    toolGroups.get(key).push(rel);
  }
  for (const [key, files] of toolGroups) entries.push(await makeEntry(toolRoot, files, `@pickbitsai/weaver/${key}`, 'The tool'));
  return entries;
}
