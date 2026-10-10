import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const sha = value => createHash('sha256').update(value).digest('hex');
export const words = value => String(value).trim().split(/\s+/).filter(Boolean).length;
export async function json(path, value) {
  await mkdir((await import('node:path')).default.dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}
export async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}
export function short(value, max) {
  const s = String(value).replace(/\s+/g, ' ').trim();
  const a = s.split(' ');
  return a.length <= max ? s : a.slice(0, max).join(' ').replace(/[,:;.]?$/, '…');
}
