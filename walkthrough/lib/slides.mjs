import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { words } from './common.mjs';
import { completePhrase, explainCommit } from './explain.mjs';

const run = promisify(execFile);
const ORDER = ['Title', 'What this is', 'Install', 'Run it', 'Edit your manuscript', 'Every file', 'Features', 'Code review', 'Keep it healthy'];
export const POINT_LABELS = ['What it is:', 'What it does:', 'How Weaver uses it:', 'When you touch it:', 'How to keep it healthy:'];
// First matching rule wins. Every inventory entry is assigned once; unknown paths
// are still visible in the final Other files group.
export const FILE_GROUPS = [
  { title: 'Your scene files', group: 'Your book', match: /^manuscript\//, points: ['Your draft scenes and reading progress.', 'They hold the words readers will see.', 'Weaver checks scene text and tracks your progress.', 'You revise scenes as you write.', 'Keep edits in Git and review changed scenes.'] },
  { title: 'Your style rules', group: 'Your book', match: /^(quality\/|style-guide\/)/, points: ['Your editorial and voice guidelines.', 'They define checks and deliberate exceptions.', 'Weaver applies them during reviews.', 'You adjust them when your style decisions change.', 'Review warnings and document intentional choices.'] },
  { title: 'Your world bible', group: 'Your book', match: /^world-bible\//, points: ['Your characters, places, terms, and voices.', 'It keeps story details consistent.', 'Weaver compares scenes with these references.', 'You update it when the story establishes facts.', 'Keep entries consistent with approved scenes.'] },
  { title: 'Your story records', group: 'Your book', match: /^(narrative-state\/|\.weaver\/packets\/)/, points: ['Your accepted story-so-far records and work packets.', 'They track what readers know after each scene.', 'Weaver marks changed scenes and later records stale.', 'You review and explicitly accept updated state.', 'Rebuild stale records before release.'] },
  { title: 'Your continuity facts', group: 'Your book', match: /^continuity\//, points: ['Your recorded facts across the book.', 'They help catch contradictions between scenes.', 'Weaver checks new writing against known facts.', 'You revise facts when the story changes.', 'Confirm each fact against the manuscript.'] },
  { title: 'Your imports and releases', group: 'Your book', match: /^(imports\/|releases\/)/, points: ['Your source imports and reader copies.', 'They preserve provenance and released text.', 'Weaver tracks imports and builds immutable releases.', 'You inspect them when importing or publishing.', 'Use a new release ID for changed text.'] },
  { title: 'Your Claude Code settings', group: 'Your book', match: /^(\.claude\/|AGENTS\.md$)/, points: ['Your assistant settings and guidance.', 'They shape editing and local hooks.', 'Weaver uses hooks to surface checks.', 'You update them when your workflow changes.', 'Keep instructions clear and project specific.'] },
  { title: 'Your project setup', group: 'Your book', match: /^(outline\/|project\.json$|package(?:-lock)?\.json$|README\.md$|\.gitignore$)/, points: ['Your project identity, outline, and dependencies.', 'They organize the book and pin its tools.', 'Weaver reads setup before running commands.', 'You change them as the project develops.', 'Keep dependencies pinned and setup documented.'] },
  { title: 'Weaver commands', group: 'The tool', match: /^@pickbitsai\/weaver\/scripts\//, points: ['Weaver command entry points.', 'They start checks, reviews, and releases.', 'Weaver routes your commands through them.', 'You use commands but do not edit these files.', 'Do not edit; Weaver updates it.'] },
  { title: "Weaver's checking engine", group: 'The tool', match: /^@pickbitsai\/weaver\/engine\/(?:doctor|findings|hooks|integrity|prose|rules|rulings|voice|characters|identity)\.mjs$/, points: ['Weaver checking and validation code.', 'It finds rule and consistency issues.', 'Weaver runs it during checks and reviews.', 'You read its findings instead of editing it.', 'Do not edit; Weaver updates it.'] },
  { title: "Weaver's story state engine", group: 'The tool', match: /^@pickbitsai\/weaver\/engine\/(?:changes|export|import|init|manuscript|packets|project|release|review|state)\.mjs$/, points: ['Weaver manuscript and story state code.', 'It tracks revisions, exports, and releases.', 'Weaver calls it as scenes change.', 'You review its results instead of editing it.', 'Do not edit; Weaver updates it.'] },
  { title: 'Weaver author page', group: 'The tool', match: /^@pickbitsai\/weaver\/(?:studio\/|engine\/(?:studio|host)\.mjs$)/, points: ['Weaver local author page code.', 'It displays findings, decisions, and history.', 'Weaver serves it for your review.', 'You use the page instead of editing its files.', 'Do not edit; Weaver updates it.'] },
  { title: 'Weaver templates and contracts', group: 'The tool', match: /^@pickbitsai\/weaver\/(?:templates\/|prompts\/|contracts\/|integrity\.json$)/, points: ['Weaver starter files, prompts, and data contracts.', 'They define generated structure and valid data.', 'Weaver reads them when creating and checking books.', 'You use their outputs instead of editing them.', 'Do not edit; Weaver updates it.'] }
];
export function groupEntries(entries) {
  const buckets = new Map(FILE_GROUPS.map(rule => [rule.title, { ...rule, entries: [] }]));
  const other = { title: 'Other files', group: 'Your book', points: ['Additional project or tool files.', 'They support this book or Weaver.', 'Weaver may read them during normal work.', 'You inspect them when their purpose matters.', 'Keep book edits in Git; leave tool files to Weaver.'], entries: [] };
  for (const entry of entries) {
    const rule = FILE_GROUPS.find(rule => rule.group === entry.group && rule.match.test(entry.path));
    (rule ? buckets.get(rule.title) : other).entries.push(entry);
  }
  return [...buckets.values(), other].filter(bucket => bucket.entries.length);
}
export function validateSlides(slides) {
  if (!Array.isArray(slides) || !slides.length) throw Error('slides must be a nonempty array');
  let last = -1;
  for (const [i, slide] of slides.entries()) {
    if (typeof slide.title !== 'string' || !slide.title.trim()) throw Error(`slide ${i}: title required`);
    if (/[\\/]|\.\w{1,5}(?::|$)/.test(slide.title)) throw Error(`slide ${i}: title must be plain English, not a path`);
    if (slide.section === 'Every file' && (words(slide.title) < 2 || words(slide.title) > 6)) throw Error(`slide ${i}: group title needs 2 to 6 words`);
    if (!Array.isArray(slide.bullets) || slide.bullets.length < 1 || slide.bullets.length > 5) throw Error(`slide ${i}: 1 to 5 bullets required`);
    if (slide.section === 'Every file' && (slide.bullets.length !== 5 || !slide.caption || !slide.memberPaths?.length)) throw Error(`slide ${i}: group needs five points and member paths`);
    for (const [j, bullet] of slide.bullets.entries()) {
      if (typeof bullet !== 'string' || !completePhrase(bullet)) throw Error(`slide ${i}: bullet is incomplete`);
      const label = slide.section === 'Every file' ? POINT_LABELS[j] : '';
      if (label && !bullet.startsWith(label)) throw Error(`slide ${i}: missing point label ${label}`);
      if (words(label ? bullet.slice(label.length) : bullet) > 12) throw Error(`slide ${i}: bullet exceeds 12 words`);
    }
    if (typeof slide.narration !== 'string' || words(slide.narration) < 40 || words(slide.narration) > 90) throw Error(`slide ${i}: narration must have 40 to 90 words`);
    const index = ORDER.indexOf(slide.section);
    if (index < last || index < 0) throw Error(`slide ${i}: section order invalid`);
    last = index;
  }
  return slides;
}
function narration(text, extra = 'You can pause here and inspect the named files in your book. Keep your changes in Git so you can review them later. Weaver reports what it finds. You make the final decision about your manuscript.') {
  let s = text.trim();
  const sentences = s.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  s = '';
  for (const sentence of sentences) if (words(`${s} ${sentence}`) <= 90) s += sentence;
  while (words(s) < 40) {
    for (const sentence of extra.match(/[^.!?]+[.!?]+/g) || []) {
      if (words(s) >= 40) break;
      if (words(`${s} ${sentence}`) <= 90) s += ` ${sentence.trim()}`;
    }
  }
  return s.trim();
}
function add(slides, section, title, bullets, speech, extra = {}) {
  slides.push({ section, title, bullets, narration: narration(speech), ...extra });
}
const featureInfo = [
  ['Style rules', 'quality/rules.json sets the checks and their severity.', 'Weaver checks reader text. Blocking findings stop approval or release. Warnings ask for your judgment.', 'Blocking findings stop approval or release.'],
  ['Voice checks', 'Character registry and approved dialogue build voice profiles.', 'Weaver warns when a speaker sounds unlike their established lines. You decide whether the change suits the scene.', 'You decide whether a voice warning suits the scene.'],
  ['Approvals and undo', 'Review each chapter before accepting its edits.', 'Approve saves a Git commit. Reject keeps a copy of the rejected text. Undo makes a new revert commit.', 'Approve saves a Git commit. Undo reverses it.'],
  ['Story-so-far', 'Narrative state records what readers know after each scene.', 'When you revise a scene, that record and later records become stale. Review and explicitly accept updated state.', 'A revised scene makes later story records stale.'],
  ['Studio', 'The local author page shows findings, changes, and history.', 'Use the Studio to inspect scenes and make author decisions. It follows the same checks as Weaver commands.', 'You inspect changes and make decisions in Studio.'],
  ['Doctor', 'Doctor checks your book setup and Weaver installation.', 'Run it when setup changes or a command refuses to write. Follow the reported repair steps.', 'Run Doctor after setup changes.'],
  ['Import and export', 'Import reads source files; export writes a separate copy.', 'Use import for an existing manuscript. Export Markdown or Word after checks. Keep the original source safe.', 'You keep the original source and export a separate copy.'],
  ['Rulings', 'Record your decision on each finding once.', 'Choose fix, allow, or intended. A changed paragraph lapses its ruling and brings the finding back.', 'A changed paragraph brings its finding back.']
];
function commandAvailable(help, command) { return new RegExp(`(?:^|\\n)\\s*weaver ${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`, 'm').test(help); }
export async function makeSlides({ book, repo, entries, explanations, docs, title, author, out, refresh, call }) {
  const slides = [];
  const pkgRoot = path.join(book, 'node_modules', '@pickbitsai', 'weaver');
  const packageJson = JSON.parse(await readFile(path.join(pkgRoot, 'package.json'), 'utf8'));
  const { stdout: help } = await run(process.execPath, [path.join(pkgRoot, 'scripts', 'weaver.mjs'), 'help'], { cwd: book, maxBuffer: 1e6 });
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  add(slides, 'Title', title, [`Prepared for ${author}`, today], `This walkthrough is for ${author} and the book ${title}. It shows where your writing lives, what Weaver checks, and how you stay in control of changes. Follow it in order the first time. Later, return to the file, feature, or maintenance slide you need. The notes on every slide explain each step in more detail.`);
  add(slides, 'What this is', 'Your book and the Weaver tool', ['Your book holds your writing and decisions.', 'Weaver checks and packages the book.', 'You approve each meaningful change.'], `Your project has two parts. The book folder contains your manuscript, settings, story records, and decisions. The installed Weaver package supplies commands and checks. Edit your book files as needed, then use Weaver to review the result. The tool files are managed by package updates. The following slides show each part in the order you will use it.`);
  const installMatch = docs.match(/npm install --save-dev github:pickbitsai\/weaver/);
  const installCommand = installMatch?.[0] || 'npm install --save-dev <pinned Weaver package>';
  add(slides, 'Install', 'Install Node.js 22', ['Install Node.js 22 or newer.', 'Open a terminal in your tool folder.', 'Keep that folder separate from your book.'], `Weaver requires Node.js version 22 or newer. Install Node first, then open a terminal in the separate folder where you manage the Weaver package. Your book should have its own Git history. Keeping the package outside your book lets the authoring assistant work on your prose without editing the tool itself. After installation, Doctor checks the arrangement.`);
  add(slides, 'Install', 'Install Claude Code', ['Install Claude Code desktop and sign in.', 'Open your book through Claude Code.', 'Use an assistant that can run commands.'], `Weaver expects a command line capable assistant such as Claude Code for model assisted steps. Install Claude Code desktop and sign in with your subscription. Open the book project there when you want help editing or reviewing scenes. Weaver removes an API key from its child process so the configured host uses your signed in Claude session.`);
  add(slides, 'Install', 'Install pinned Weaver', [`Use: ${installCommand}`, `Installed version: ${packageJson.version}.`, 'Keep package-lock.json to pin the source.', 'Install in the separate tool folder.'], `The package README gives this installation command: ${installCommand}. The installed package here reports version ${packageJson.version}. Run the command in a separate tool folder, outside the manuscript. Keep the lockfile so the resolved package source stays pinned. When you update Weaver, review the lockfile change and run Doctor again before you work on the book.`);
  if (commandAvailable(help, 'doctor')) add(slides, 'Install', 'Check setup with Doctor', ['Run: weaver doctor --root <book-folder>', 'Read each warning or refusal.', 'Fix setup before editing or release.'], `Run Weaver Doctor with your book folder as the root. It checks the project, Git, the installed package, and the configured assistant. Read its exact message if a check fails. A failed Doctor can stop commands that write to the book. Repeat Doctor after fixing the issue and whenever your installation or book location changes.`);
  const commands = [
    ['check', 'Check the book', 'Run: weaver check --root <book-folder>', 'Resolve blocking findings before release.', 'Check reads the manuscript and verifies project rules, repetition, and current story state.'],
    ['studio', 'Open the Studio', 'Run: weaver studio --root <book-folder>', 'Review findings, changes, and history.', 'Studio is the local author page where you inspect the book and make decisions.'],
    ['approve', 'Approve or reject edits', 'Use Studio, or weaver approve/reject --chapter N.', 'Review one chapter at a time.', 'Approve commits accepted text; reject keeps a copy and restores the approved scene.'],
    ['undo', 'Undo an approval', 'Use Studio, or run weaver undo.', 'Git keeps the decision history.', 'Undo makes a new Git revert commit so the history stays readable.'],
    ['release', 'Create a reader release', 'Run: weaver release --id <new-id>.', 'Each release ID belongs to one manuscript.', 'Release builds an immutable reader copy after the checks pass.'],
    ['export', 'Export a separate copy', 'Run: weaver export --format docx --out <file>.', 'Keep the source manuscript in your book.', 'Export writes a Word or Markdown copy without overwriting your source.']
  ];
  for (const [cmd, heading, bullet, other, detail] of commands) if (commandAvailable(help, cmd)) add(slides, 'Run it', heading, [bullet, other], `${detail} Check the command output for the exact next step. Use the book root when you are working outside its folder. The installed Weaver help lists this command, so the instructions match the package on your machine. You can return to the Studio to inspect the result before moving on.`);
  add(slides, 'Edit your manuscript', 'A scene edit moves through review', ['You or Claude Code edits a scene.', 'Hooks check the scene against your rules.', 'Findings appear for your review.', 'Approve, reject, or undo in Studio.'], `You may edit a scene yourself or ask Claude Code to do it. Installed hooks show editorial guidance before a tool edit and check the edited scene afterward. Weaver's full check remains the final gate. Open the Studio to see findings and the difference from approved text. Decide whether to approve or reject the chapter. Undo an approval if you later change your mind.`);
  for (const bucket of groupEntries(entries)) {
    const memberPaths = bucket.entries.map(x => x.path);
    const caption = bucket.group === 'The tool'
      ? `@pickbitsai/weaver/: ${memberPaths.map(p => p.replace(/^@pickbitsai\/weaver\//, '')).join('  ·  ')}`
      : memberPaths.join('  ·  ');
    const bullets = bucket.points.map((point, j) => `${POINT_LABELS[j]} ${point}`);
    const speech = `${bucket.title} groups ${memberPaths.length} inventory entries. ${bucket.points.join(' ')} The paths beneath the title identify every member of this group. You can find a separate explanation for each entry in the companion explanations file. ${bucket.group === 'The tool' ? 'These files belong to the installed Weaver package. Do not edit them; Weaver updates them.' : 'These files belong to your book. Keep author changes in Git so you can review them.'}`;
    add(slides, 'Every file', bucket.title, bullets, speech, { caption, memberPaths });
  }
  for (const [name, bullet, detail, detailBullet] of featureInfo.filter(([name]) => ['Style rules', 'Approvals and undo', 'Story-so-far', 'Import and export', 'Rulings'].includes(name))) add(slides, 'Features', name, [bullet, detailBullet], `${detail} This feature is described in the installed Weaver documentation. Open the related book file or Studio page when you want to inspect its evidence. Run the corresponding Weaver command when you need a fresh result. You remain responsible for deciding what belongs in your manuscript and when it is ready to release.`);
  let log = '';
  try { log = (await run('git', ['log', '--format=%H%x09%s', '--stat', '--', '.'], { cwd: book, maxBuffer: 5e6 })).stdout; } catch { /* book may not have history */ }
  const chunks = log.split(/(?=^[0-9a-f]{40}\t)/m).filter(x => /^[0-9a-f]{40}\t/.test(x));
  const commits = chunks.map(x => { const [head, ...stat] = x.trim().split(/\r?\n/); const [hash, subject] = head.split('\t'); return { hash, subject, stat: stat.join('\n').slice(0, 3500) }; }).filter(x => /\|/.test(x.stat));
  if (commits.length) {
    const groups = [commits.slice(0, 4), commits.slice(4)];
    for (const [index, group] of groups.entries()) {
      if (!group.length) continue;
      const explanations = [];
      for (const commit of group) explanations.push(await explainCommit(commit, out, { refresh, call }));
      const title = index ? 'Earlier book changes' : 'Recent book changes';
      const ids = group.map(commit => commit.hash.slice(0, 8));
      const review = explanations.some(e => e.needsReview);
      const bullets = [
        `${group.length} commits in your book history.`,
        `Commit IDs: ${ids.join(', ')}.`,
        review ? '[needs review] Review these changes in Git.' : 'Open Git history for details and reasons.'
      ];
      add(slides, 'Code review', title, bullets, `This section groups ${group.length} recorded changes in your book's Git history. The commit IDs are ${ids.join(', ')}. ${explanations.map(e => `${e.what_changed} ${e.why}`).join(' ')} Open the History page or compare the original commits in Git before making a decision. These summaries reflect the commit messages and file lists.`, { caption: group.map(c => `${c.hash.slice(0, 8)} ${c.subject}`).join('  ·  ') });
    }
  }
  add(slides, 'Keep it healthy', 'Routine care', ['Run Doctor after setup changes.', 'Keep book changes in Git.', 'Update Weaver deliberately.', 'Leave installed tool files to Weaver.'], `Run Doctor when your setup changes and before a major release. Keep your book under Git so you can back up, inspect, and undo work. Update the pinned Weaver package deliberately, then run Doctor and Check again. Edit manuscript and book settings as needed. Leave the installed package files to Weaver updates. Keep each release ID tied to its original manuscript.`);
  return validateSlides(slides);
}
