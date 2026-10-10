import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson, sha, words } from './common.mjs';

export const FIELDS = ['what_it_is', 'what_it_does', 'how_the_pipeline_uses_it', 'when_you_touch_it', 'how_to_maintain'];
export const EXPLAIN_PROMPT_VERSION = 'complete-short-v2';
export function completePhrase(value) {
  const s = String(value).trim();
  return !!s && !/(?:\.{3,}|…|[,;:\-–—])\s*$/.test(s) &&
    !/\b(?:a|an|the|and|or|but|for|from|into|of|to|with|your|its)\s*[.!?]?$/i.test(s);
}
export function validateExplanation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Response must be an object');
  for (const key of FIELDS) {
    if (typeof value[key] !== 'string' || !value[key].trim()) throw Error(`${key} must be a nonempty string`);
    if (words(value[key]) > 12) throw Error(`${key} exceeds 12 words`);
    if (!completePhrase(value[key])) throw Error(`${key} is incomplete`);
  }
  if (!FIELDS.some(key => /\b(you|your)\b/i.test(value[key]))) throw Error('Response must address the author as you');
  return Object.fromEntries(FIELDS.map(key => [key, value[key].trim()]));
}
export function validateCommit(value) {
  if (!value || typeof value !== 'object') throw Error('Response must be an object');
  for (const key of ['what_changed', 'why']) {
    if (typeof value[key] !== 'string' || !value[key].trim() || words(value[key]) > 25) throw Error(`${key} needs 1 to 25 words`);
    if (!/\b(you|your)\b/i.test(value[key])) throw Error(`${key} must address the author as you`);
  }
  return { what_changed: value.what_changed.trim(), why: value.why.trim() };
}
export function parseResponse(raw) {
  const clean = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}
export async function withRepair(prompt, validator, call) {
  let error;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await call(attempt ? `${prompt}\n\nYour previous response failed validation: ${error.message}. Repair it. Return only valid JSON.` : prompt);
      return { value: validator(parseResponse(raw)), needsReview: false };
    } catch (e) { error = e; }
  }
  return { value: null, needsReview: true, error: error?.message || 'Unknown error' };
}
export async function claude(prompt) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  return await new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', 'claude.cmd -p --output-format text'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 180000);
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(Error(`claude exit ${code}: ${stderr.slice(0, 300)}`)); });
    child.stdin.end(prompt);
  });
}
export async function getDocs(book, repo) {
  const roots = [path.join(book, 'node_modules', '@pickbitsai', 'weaver'), repo];
  for (const root of roots) {
    try {
      const { readdir } = await import('node:fs/promises');
      const docs = [path.join(root, 'README.md'), ...(await readdir(path.join(root, 'docs'))).filter(x => x.endsWith('.md')).map(x => path.join(root, 'docs', x))];
      return (await Promise.all(docs.map(p => readFile(p, 'utf8')))).join('\n').slice(0, 70000);
    } catch { /* try repository */ }
  }
  return '';
}
function docContext(entry, docs) {
  const pathParts = entry.path.toLowerCase().replace(/\.[a-z0-9]+$/i, '').split(/[\/._ -]+/).filter(x => x.length >= 4 && !['weaver', 'chapter', 'scene', 'file'].includes(x));
  const terms = [...new Set(pathParts)].slice(-4);
  const pieces = [docs.slice(0, 3500)];
  const lower = docs.toLowerCase();
  for (const term of terms) {
    let at = 0, hits = 0;
    while ((at = lower.indexOf(term, at)) >= 0 && hits++ < 3) {
      pieces.push(docs.slice(Math.max(0, at - 260), Math.min(docs.length, at + 750)));
      at += term.length;
    }
  }
  return pieces.join('\n...\n').slice(0, 8500);
}
export async function explainAll(entries, docs, out, { refresh = false, call = claude } = {}) {
  const cache = path.join(out, 'cache');
  await mkdir(cache, { recursive: true });
  const results = new Array(entries.length);
  let next = 0;
  async function worker() {
    while (next < entries.length) {
      const i = next++;
      const entry = entries[i];
      const file = path.join(cache, `explain-${EXPLAIN_PROMPT_VERSION}-${entry.sha256}-${sha(entry.path).slice(0, 12)}.json`);
      const cached = refresh ? null : await readJson(file);
      if (cached && !cached.needsReview) {
        try { results[i] = { ...validateExplanation(cached), needsReview: false }; continue; } catch { /* regenerate invalid cache */ }
      }
      const prompt = `Explain this Weaver book item to a nontechnical author. Use only the file excerpt and documentation below. Return ONLY JSON with keys ${FIELDS.join(', ')}. Each value must be a complete, natural, short sentence or phrase of 1 to 12 words. Never truncate or end with ellipses. Use plain English and address the author as "you" or "your" in at least one value. For installed tool files, say "You do not edit this; Weaver updates it" in how_to_maintain.\nPath: ${entry.path}\nGroup: ${entry.group}\nFiles: ${entry.files.length}\nExcerpt:\n${entry.excerpt}\nDocumentation:\n${docContext(entry, docs)}`;
      const answer = await withRepair(prompt, validateExplanation, call);
      const value = answer.value || {
        what_it_is: '[needs review] You need an explanation of this item.',
        what_it_does: '[needs review] You need its purpose explained.',
        how_the_pipeline_uses_it: '[needs review] You need its place in the workflow explained.',
        when_you_touch_it: '[needs review] You need guidance on when to open it.',
        how_to_maintain: entry.group === 'The tool' ? '[needs review] You should not edit this installed Weaver file.' : '[needs review] You need guidance on keeping this file current.'
      };
      results[i] = { ...value, needsReview: answer.needsReview };
      await writeFile(file, JSON.stringify(results[i], null, 2));
      process.stdout.write(`Explained ${i + 1}/${entries.length}: ${entry.path}${answer.needsReview ? ` [needs review: ${answer.error}]` : ''}\n`);
    }
  }
  await worker();
  return results;
}
export async function explainCommit(commit, out, { refresh = false, call = claude } = {}) {
  const key = sha(JSON.stringify(commit));
  const file = path.join(out, 'cache', `commit-${key}.json`);
  const cached = refresh ? null : await readJson(file);
  if (cached && !cached.needsReview) return cached;
  const prompt = `Explain this Git commit to a nontechnical book author. Return ONLY JSON with what_changed and why, each 1 to 25 plain-English words that address the author as "you" or "your". Base why only on the commit message; if it gives no reason say so.\n${JSON.stringify(commit)}`;
  const answer = await withRepair(prompt, validateCommit, call);
  const value = answer.value || { what_changed: '[needs review] You need a summary of this change.', why: '[needs review] You need the reason checked against the commit.' };
  const result = { ...value, needsReview: answer.needsReview };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(result, null, 2));
  return result;
}
