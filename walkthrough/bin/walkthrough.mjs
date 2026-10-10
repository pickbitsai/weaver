#!/usr/bin/env node
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inventory } from '../lib/inventory.mjs';
import { getDocs, explainAll } from '../lib/explain.mjs';
import { makeSlides, validateSlides } from '../lib/slides.mjs';
import { renderDeck, renderFrames, renderVideo } from '../lib/render.mjs';
import { renderAudio } from '../lib/audio.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const walkRoot = path.dirname(here);
const repo = path.dirname(walkRoot);
function argsOf(argv) {
  const options = { audioProvider: 'none', video: true, refresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--book', '--out', '--title', '--author'].includes(a)) options[a.slice(2)] = argv[++i];
    else if (a === '--no-audio') options.audioProvider = 'none';
    else if (a === '--no-video') options.video = false;
    else if (a === '--refresh') options.refresh = true;
    else throw Error(`Unknown argument: ${a}`);
  }
  if (!options.book || !options.out) throw Error('Usage: node walkthrough/bin/walkthrough.mjs --book <book-dir> --out <out-dir> [--title "..."] [--author "..."] [--no-audio] [--no-video] [--refresh]');
  options.book = path.resolve(options.book); options.out = path.resolve(options.out);
  if (options.out === options.book || options.out.startsWith(options.book + path.sep)) throw Error('--out must be outside the read-only book folder');
  return options;
}
async function main() {
  const opt = argsOf(process.argv.slice(2));
  await mkdir(opt.out, { recursive: true });
  const entries = await inventory(opt.book);
  await writeFile(path.join(opt.out, 'inventory.json'), JSON.stringify(entries, null, 2) + '\n');
  process.stdout.write(`Inventory: ${entries.length} entries\n`);
  const docs = await getDocs(opt.book, repo);
  const explanations = await explainAll(entries, docs, opt.out, { refresh: opt.refresh });
  await writeFile(path.join(opt.out, 'explanations.json'), JSON.stringify(explanations, null, 2) + '\n');
  let title = opt.title;
  if (!title) { try { title = JSON.parse(await readFile(path.join(opt.book, 'project.json'), 'utf8')).title; } catch { /* fallback */ } }
  title ||= path.basename(opt.book);
  const slides = await makeSlides({ book: opt.book, repo, entries, explanations, docs, title, author: opt.author || 'the author', out: opt.out, refresh: opt.refresh });
  validateSlides(slides);
  await writeFile(path.join(opt.out, 'slides.json'), JSON.stringify(slides, null, 2) + '\n');
  await renderDeck(slides, opt.out);
  await renderFrames(slides, opt.out);
  const audio = await renderAudio(slides, opt.out, opt.audioProvider);
  const duration = opt.video ? await renderVideo(slides, opt.out, audio) : null;
  const sections = Object.groupBy(slides, x => x.section);
  const needsReview = explanations.filter(x => x.needsReview).length + slides.filter(x => x.section === 'Code review' && x.bullets.some(b => b.includes('[needs review]'))).length;
  const lines = [
    `# ${title}: Weaver walkthrough`, '',
    `Generated ${new Date().toISOString()}.`, '',
    `- Inventory: ${entries.length} entries in \`inventory.json\`.`,
    `- Explanations: \`explanations.json\`; ${needsReview} [needs review] placeholders.`,
    `- Slides: ${slides.length} in \`slides.json\` and \`walkthrough.pptx\`.`,
    `- Frames: ${slides.length} PNG files in \`frames/\`, with matching HTML in \`html/\`.`,
    `- Audio: ${audio.length ? `${audio.length} audio files in \`audio/\`.` : 'skipped (provider none).'}`,
    `- Video: ${duration == null ? 'skipped.' : `\`walkthrough.mp4\`, expected duration ${duration.toFixed(1)} seconds.`}`,
    '', '## Slides by section', '',
    ...Object.entries(sections).map(([name, list]) => `- ${name}: ${list.length}`),
    '', '## Review', '',
    ...entries.filter((_, i) => explanations[i].needsReview).map(x => `- [needs review] ${x.path}`),
    ...slides.filter(x => x.section === 'Code review' && x.bullets.some(b => b.includes('[needs review]'))).map(x => `- [needs review] ${x.title}`)
  ];
  await writeFile(path.join(opt.out, 'README.md'), lines.join('\n') + '\n');
  process.stdout.write(`Done: ${slides.length} slides, ${needsReview} [needs review] placeholders${duration == null ? '' : `, ${duration.toFixed(1)}s video`}\n`);
}
main().catch(e => { process.stderr.write(`${e.stack || e.message}\n`); process.exitCode = 1; });
