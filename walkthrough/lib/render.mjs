import { spawn } from 'node:child_process';
import { mkdir, writeFile, stat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { words } from './common.mjs';

const COLORS = { paper: 'FBF8F0', ink: '1C1813', muted: '6B6353', accent: 'D8431A' };
const escapeHtml = x => String(x).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const labelled = bullet => /^(What it is:|What it does:|How Weaver uses it:|When you touch it:|How to keep it healthy:)\s*(.*)$/s.exec(bullet);
async function run(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(Error(`${program} exited ${code}: ${stderr.slice(-800)}`)));
  });
}
export async function renderDeck(slides, out) {
  const { default: pptxgen } = await import('pptxgenjs');
  const pptx = new pptxgen();
  const fontNames = await readdir('C:/Windows/Fonts').catch(() => []);
  const headingFont = fontNames.some(name => /fraunces/i.test(name)) ? 'Fraunces' : 'Georgia';
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'PickBits AI';
  pptx.subject = 'Weaver author walkthrough';
  pptx.title = slides[0].title;
  pptx.lang = 'en-US';
  for (let i = 0; i < slides.length; i++) {
    const item = slides[i], slide = pptx.addSlide();
    slide.background = { color: COLORS.paper };
    slide.addText('PickBits', { x: .75, y: .37, w: 1.53, h: .34, fontFace: headingFont, fontSize: 19, bold: true, color: COLORS.ink, margin: 0 });
    slide.addText('.', { x: 2.23, y: .35, w: .21, h: .38, fontFace: 'Georgia', fontSize: 23, bold: true, color: COLORS.accent, margin: 0 });
    slide.addShape(pptx.ShapeType.rect, { x: 2.53, y: .38, w: .38, h: .28, line: { color: COLORS.ink, width: .7 }, fill: { color: COLORS.paper } });
    slide.addText('AI', { x: 2.58, y: .43, w: .27, h: .13, fontFace: 'Consolas', fontSize: 8, bold: true, color: COLORS.ink, margin: 0 });
    slide.addText(item.section.toUpperCase(), { x: .77, y: 1.04, w: 11.8, h: .25, fontFace: 'Consolas', fontSize: 12, charSpacing: 2.3, color: COLORS.accent, margin: 0 });
    slide.addText(item.title, { x: .74, y: 1.4, w: 11.8, h: 1.72, fontFace: headingFont, fontSize: 36, bold: true, color: COLORS.ink, margin: 0, breakLine: false, valign: 'top' });
    if (item.caption) slide.addText(item.caption, { x: .77, y: 2.27, w: 11.8, h: .72, fontFace: 'Consolas', fontSize: 10, color: COLORS.muted, margin: 0, breakLine: false, valign: 'top' });
    const y0 = item.bullets.length === 5 ? 3.0 : item.bullets.length === 4 ? 3.12 : 3.34;
    const gap = item.bullets.length === 5 ? .79 : item.bullets.length === 4 ? .91 : 1.03;
    item.bullets.forEach((b, j) => {
      slide.addShape(pptx.ShapeType.rect, { x: .79, y: y0 + j * gap + .12, w: .09, h: .09, line: { color: COLORS.accent }, fill: { color: COLORS.accent } });
      const match = labelled(b);
      const rich = match ? [{ text: match[1] + ' ', options: { bold: true, color: COLORS.accent } }, { text: match[2], options: { color: COLORS.ink } }] : b;
      slide.addText(rich, { x: 1.1, y: y0 + j * gap, w: 11.2, h: item.bullets.length === 5 ? .75 : .86, fontFace: 'Segoe UI', fontSize: item.bullets.length === 5 ? 20 : 24, color: COLORS.ink, margin: 0, valign: 'mid', breakLine: false });
    });
    slide.addText(`${String(i + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}`, { x: 11.8, y: 7.04, w: .8, h: .2, align: 'right', fontFace: 'Consolas', fontSize: 9, color: COLORS.muted, margin: 0 });
    slide.addNotes(item.narration);
  }
  await pptx.writeFile({ fileName: path.join(out, 'walkthrough.pptx') });
}
function html(item, index, count) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Fraunces;src:local('Fraunces')}*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden}body{background:#FBF8F0;color:#1C1813;font-family:'Segoe UI',Arial,sans-serif}.head{position:absolute;left:108px;top:54px;display:flex;align-items:center;gap:10px}.brand{font:700 34px Fraunces,Georgia,serif}.dot{color:#D8431A}.tag{font:700 15px Consolas,monospace;border:1px solid #1C1813;padding:2px 6px}.section{position:absolute;left:110px;top:150px;font:18px Consolas,monospace;letter-spacing:3px;color:#D8431A;text-transform:uppercase}.title{position:absolute;left:106px;top:205px;width:1690px;max-height:125px;overflow:hidden;font:700 74px/1.1 Fraunces,Georgia,serif}.caption{position:absolute;left:110px;top:338px;width:1690px;height:100px;overflow:hidden;font:22px/1.35 Consolas,monospace;color:#6B6353;overflow-wrap:anywhere}.bullets{position:absolute;left:112px;top:${item.bullets.length === 5 ? 440 : item.bullets.length === 4 ? 452 : 478}px;width:1700px}.bullet{display:flex;gap:30px;align-items:flex-start;min-height:${item.bullets.length === 5 ? 116 : item.bullets.length === 4 ? 131 : 146}px;font:${item.bullets.length === 5 ? 35 : 42}px/1.18 'Segoe UI',Arial,sans-serif}.bullet span{min-width:0;overflow-wrap:anywhere}.bullet strong{color:#D8431A}.bullet:before{content:'';display:block;flex:none;width:12px;height:12px;background:#D8431A;margin-top:20px}.count{position:absolute;right:105px;bottom:45px;color:#6B6353;font:17px Consolas,monospace}
  </style></head><body><div class="head"><span class="brand">PickBits<span class="dot">.</span></span><span class="tag">AI</span></div><div class="section">${escapeHtml(item.section)}</div><div class="title">${escapeHtml(item.title)}</div>${item.caption ? `<div class="caption">${escapeHtml(item.caption)}</div>` : ''}<div class="bullets">${item.bullets.map(b => { const m = labelled(b); return `<div class="bullet"><span>${m ? `<strong>${escapeHtml(m[1])}</strong> ${escapeHtml(m[2])}` : escapeHtml(b)}</span></div>`; }).join('')}</div><div class="count">${String(index + 1).padStart(2, '0')} / ${String(count).padStart(2, '0')}</div></body></html>`;
}
async function edgeScreenshot(edge, args, frame) {
  const child = spawn(edge, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '', exited = false;
  child.stderr.on('data', d => stderr += d);
  child.on('close', () => { exited = true; });
  try {
    for (let tick = 0; tick < 120; tick++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      try {
        const info = await stat(frame);
        if (info.size > 1000) {
          await new Promise(resolve => setTimeout(resolve, 200));
          if ((await stat(frame)).size === info.size) return;
        }
      } catch { /* screenshot still pending */ }
      if (exited) throw Error(`Edge exited before screenshot: ${stderr.slice(-500)}`);
    }
    throw Error(`Edge screenshot timed out: ${stderr.slice(-500)}`);
  } finally {
    if (!exited && child.pid) await run('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(() => {});
  }
}
export async function renderFrames(slides, out) {
  const framesDir = path.resolve(out, 'frames');
  const htmlDir = path.resolve(out, 'html');
  await Promise.all([mkdir(framesDir, { recursive: true }), mkdir(htmlDir, { recursive: true })]);
  for (const [dir, extension] of [[framesDir, '.png'], [htmlDir, '.html']]) {
    for (const name of await readdir(dir)) if (/^\d{3,}\./.test(name) && name.endsWith(extension)) await unlink(path.join(dir, name));
  }
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const profile = path.resolve(out, 'edge-profile');
  for (let i = 0; i < slides.length; i++) {
    const id = String(i + 1).padStart(3, '0');
    const page = path.join(htmlDir, `${id}.html`), frame = path.join(framesDir, `${id}.png`);
    const content = html(slides[i], i, slides.length);
    await writeFile(page, content);
    await edgeScreenshot(edge, [`--user-data-dir=${path.join(profile, `run-${process.pid}`)}`, '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', `--screenshot=${frame}`, '--window-size=1920,1080', `file:///${page.replaceAll('\\', '/')}`], frame);
    process.stdout.write(`Frame ${i + 1}/${slides.length}\n`);
  }
  return framesDir;
}
export function slideDuration(slide) {
  // A silent slide stays up long enough to read its notes at about 150 wpm.
  return Math.max(6, Math.ceil(words(slide.narration) * 60 / 150));
}
export async function renderVideo(slides, out, audioPaths = []) {
  const parts = path.join(out, 'video-parts');
  await mkdir(parts, { recursive: true });
  const concat = [];
  let expectedDuration = 0;
  for (let i = 0; i < slides.length; i++) {
    const id = String(i + 1).padStart(3, '0');
    const frame = path.join(out, 'frames', `${id}.png`), part = path.join(parts, `${id}.mp4`);
    let duration = slideDuration(slides[i]);
    if (audioPaths[i]) {
      const info = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPaths[i]]);
      duration = Number(info.stdout.trim()) + .6;
    }
    expectedDuration += duration;
    const args = ['-y', '-loglevel', 'error', '-loop', '1', '-framerate', '1', '-i', frame];
    if (audioPaths[i]) args.push('-i', audioPaths[i], '-af', 'apad');
    else args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
    args.push('-t', duration.toFixed(3), '-vf', 'fps=1,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', part);
    await run('ffmpeg', args);
    concat.push(`file '${path.resolve(part).replaceAll('\\', '/').replaceAll("'", "'\\''")}'`);
    process.stdout.write(`Video segment ${i + 1}/${slides.length}\n`);
  }
  const list = path.join(parts, 'concat.txt');
  await writeFile(list, concat.join('\n') + '\n');
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', path.join(out, 'walkthrough.mp4')]);
  return expectedDuration;
}
