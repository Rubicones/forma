// Screen bakes: the interface a creative shows on a green screen inside a clip, composited into the clip once per
// language, so every player (preview, dashboard, export, check) plays one ordinary video with the screen already lit,
// occluded and smeared like the footage. Runs on this computer: Chrome draws the interface flat frame by frame
// (?bake=<clip>), a worker composites (screen-composite.mjs) and ffmpeg encodes. Results are cached by content.
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {existsSync, createReadStream} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {browser, openFrame, findFfmpeg} from './render.mjs';
import {trackScreen, trackSummary, probeVideo, readFrames} from './screen-track.mjs';
import {encodePng} from './png.mjs';
import {uninject} from './motion.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BAKE_VERSION = 1;
const OUT_LONG = 1920;   // bakes are made at this long side at most: the interface stays sharp when the clip is upscaled

export const trackPath = plate => plate.replace(/\.[a-z0-9]+$/i, '') + '.track.json';

// The track of a clip: read when it exists and is newer than the clip, made (and saved) otherwise.
export async function ensureTrack(plate, {hints, force = false, log = () => {}} = {}) {
  const file = trackPath(plate);
  if (!force && !hints?.length) {
    try {
      const [t, p] = await Promise.all([fs.stat(file), fs.stat(plate)]);
      if (t.mtimeMs >= p.mtimeMs) return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch { /* not tracked yet */ }
  }
  log('Tracking the screen in ' + path.basename(plate) + '…');
  const track = await trackScreen(plate, {hints});
  await fs.writeFile(file, JSON.stringify(track));
  return track;
}

async function fileHash(file) {
  const h = createHash('sha1');
  await new Promise((res, rej) => createReadStream(file).on('data', c => h.update(c)).on('end', res).on('error', rej));
  return h.digest('hex');
}

const withQuery = (url, q) => url + (url.includes('?') ? '&' : '?') + new URLSearchParams(q);

// The screens a built creative declares (FORMA.screen calls), from the page itself.
export async function listScreens({url, format, lang}) {
  const page = await (await browser()).newPage();
  try {
    await page.setViewport({width: 540, height: 540, deviceScaleFactor: 1});
    await openFrame(page, withQuery(url, {f: format, l: lang, paused: '1', t: '0', bake: 'list'}));
    return await page.evaluate(() => (window.FORMA?.screens || []).map(s => ({clip: s.clip, size: s.size, offset: s.offset, surface: s.surface || 'screen'})));
  } finally { await page.close().catch(() => {}); }
}

// Draws the interface flat for every frame of the clip; writes each distinct frame once. Returns {index, hash, uw, uh}.
async function captureUi({url, screen, format, lang, frames, fps, scale, dir, log}) {
  const page = await (await browser()).newPage();
  const problems = [];
  page.on('pageerror', e => problems.push(String(e?.message || e)));
  try {
    const [w, h] = screen.size;
    await page.setViewport({width: w, height: h, deviceScaleFactor: scale});
    const ready = await openFrame(page, withQuery(url, {f: format, l: lang, paused: '1', t: '0', bake: screen.clip}));
    if (!ready) throw Error('The creative never got ready for the bake.');
    const index = [], seen = new Map(), all = createHash('sha1');
    let last = '';
    for (let i = 0; i < frames; i++) {
      await page.evaluate(async tau => {
        window.FORMA._bakeFrame(tau);
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      }, i / fps);
      const png = await page.screenshot({type: 'png', omitBackground: true, clip: {x: 0, y: 0, width: w, height: h}});
      const hash = createHash('sha1').update(png).digest('hex');
      all.update(hash);
      if (!seen.has(hash)) { const name = 'ui-' + String(seen.size).padStart(4, '0') + '.png'; await fs.writeFile(path.join(dir, name), png); seen.set(hash, name); }
      index.push(seen.get(hash));
      if (hash !== last && i % 24 === 0) log(`Drawing the interface · ${i}/${frames}`);
      last = hash;
    }
    if (problems.length) log('The interface reported: ' + problems.slice(0, 2).join(' · '), {level: 'warn'});
    return {index, hash: all.digest('hex'), uw: Math.round(w * scale), uh: Math.round(h * scale), distinct: seen.size};
  } finally { await page.close().catch(() => {}); }
}

function runWorker(data, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(here, 'screen-bake-worker.mjs'), {workerData: data});
    worker.on('message', m => {
      if (m.type === 'progress') onProgress(m);
      else if (m.type === 'done') resolve(m.stats);
      else if (m.type === 'error') reject(Error(m.message));
    });
    worker.on('error', reject);
    worker.on('exit', code => { if (code) reject(Error('The bake worker stopped (' + code + ').')); });
  });
}

/**
 * Bakes one screen for one language. projectDir: the project's folder; url: the built creative on the preview origin.
 * Returns {file (relative to the project), cached, stats, problems}.
 */
export async function bakeScreen({projectDir, url, screen, format, lang, log = () => {}}) {
  const plate = path.resolve(projectDir, screen.clip);
  // the clip's name comes from the page: only a file of this project's own is read (and gets a track written next to it)
  if (!plate.startsWith(path.resolve(projectDir) + path.sep) || /^[a-z]+:/i.test(screen.clip)) return {problems: [`${screen.clip}: FORMA.screen takes a clip of this project (assets/…), not a file elsewhere.`]};
  if (!existsSync(plate))return {problems: [`${screen.clip}: the clip is not in the project.`]};
  const track = await ensureTrack(plate, {log});
  if (!track.found) return {problems: [`${screen.clip}: no green screen to put the interface on (${track.warnings.join(' ') || 'not found'}).`]};
  const info = track.source;
  const scale = Math.min(2, Math.max(1, OUT_LONG / Math.max(info.width, info.height)));
  const W = Math.round(info.width * scale / 2) * 2, H = Math.round(info.height * scale / 2) * 2;
  const k = W / info.width;
  // The interface is drawn as sharp as the screen gets in the output, at most twice its own size.
  let widest = 0;
  for (const f of track.frames) if (f.q && f.v > 0.5) widest = Math.max(widest, Math.hypot(f.q[1][0] - f.q[0][0], f.q[1][1] - f.q[0][1]) * k, Math.hypot(f.q[2][0] - f.q[3][0], f.q[2][1] - f.q[3][1]) * k);
  const uiScale = Math.min(2, Math.max(1, widest / screen.size[0]));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-bake-'));
  try {
    const ui = await captureUi({url, screen, format, lang, frames: info.frames, fps: info.fps, scale: uiScale, dir, log});
    const surface = screen.surface === 'print' ? 'print' : 'screen';
    const key = createHash('sha1').update(JSON.stringify([BAKE_VERSION, await fileHash(plate), track.frames, track.key, ui.hash, W, H, surface])).digest('hex').slice(0, 16);
    const rel = 'assets/screens/' + key + '.mp4';
    const out = path.join(projectDir, rel);
    const stats = existsSync(out) ? null : await (async () => {
      await fs.mkdir(path.dirname(out), {recursive: true});
      log(`Baking the interface into ${path.basename(screen.clip)} (${lang}, ${W}×${H})…`);
      return runWorker({
        plate, out, w: W, h: H, fps: info.fps, key: track.key, uiDir: dir, uiIndex: ui.index, ffmpeg: await findFfmpeg(), surface,
        frames: track.frames.map(f => ({q: f.q ? f.q.map(([x, y]) => [x * k, y * k]) : null, v: f.v})),
      }, m => log(`Baking ${path.basename(screen.clip)} · ${m.done}/${m.total}`));
    })();
    const problems = [];
    if (stats && stats.worst.frac > 0.02) problems.push(`${screen.clip}: green is still visible on the screen after the bake (${Math.round(stats.worst.frac * 100)}% of it at ${stats.worst.t} s): the screen is not a clean green there.`);
    return {file: rel, cached: !stats, stats, problems, track: trackSummary(track, {file: screen.clip})};
  } finally {
    await fs.rm(dir, {recursive: true, force: true}).catch(() => {});
  }
}

/**
 * Bakes every screen of a built creative for the given languages and writes assets/screens/<rev>.json, which the
 * runtime reads. formats: the creative's formats (a format may show a clip the others do not; each clip is baked once
 * per language, its interface drawn in the first format that shows it). Returns {screens, problems}. A creative
 * without FORMA.screen costs one cheap look at its HTML.
 */
export async function bakeScreens({projectDir, url, rev, langs, formats, format, log = () => {}}) {
  // the creative's own code (the injected runtime mentions FORMA.screen in its comments)
  const html = await fs.readFile(path.join(projectDir, rev + '.src.html'), 'utf8')
    .catch(() => fs.readFile(path.join(projectDir, rev + '.html'), 'utf8').then(uninject)).catch(() => '');
  if (!/FORMA\.screen\s*\(/.test(html)) return {screens: [], problems: []};
  const list = new Map();
  for (const f of formats?.length ? formats : [format]) {
    for (const screen of await listScreens({url, format: f, lang: langs[0]})) if (!list.has(screen.clip)) list.set(screen.clip, {...screen, format: f});
  }
  const clips = {}, results = [], problems = [];
  for (const screen of list.values()) {
    for (const lang of langs) {
      try {
        const r = await bakeScreen({projectDir, url, screen, format: screen.format, lang, log});
        problems.push(...(r.problems || []));
        if (r.file) { (clips[screen.clip] ||= {})[lang] = r.file; results.push({clip: screen.clip, lang, file: r.file, cached: r.cached, track: r.track}); }
      } catch (err) {
        problems.push(`${screen.clip} (${lang}): the bake failed: ${err.message}`);
      }
    }
  }
  await fs.mkdir(path.join(projectDir, 'assets/screens'), {recursive: true});
  await fs.writeFile(path.join(projectDir, 'assets/screens', rev + '.json'), JSON.stringify({version: BAKE_VERSION, clips}));
  if (!list.size) problems.push('FORMA.screen is in the code but no screen was registered (call it inside FORMA.setup with the <video> and the interface element).');
  return {screens: results, problems};
}

// ---------- a contact sheet of a track, for the model to look at ----------
function drawLine(px, w, h, [x0, y0], [x1, y1], rgb) {
  const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) + 1;
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(x0 + (x1 - x0) * s / steps), y = Math.round(y0 + (y1 - y0) * s / steps);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const i = (yy * w + xx) * 3; px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2];
    }
  }
}

// Six frames of the clip with the tracked corners drawn (magenta: sure; amber: unsure), the unsure moments first.
// Returns the times shown, in reading order.
export async function trackSheet(plate, track, outPng, {count = 6, width = 400} = {}) {
  const fps = track.source.fps, N = track.frames.length;
  const pick = new Set();
  for (const [a, b] of track.low || []) if (pick.size < count) pick.add(Math.min(N - 1, Math.round((a + b) / 2 * fps)));
  for (let i = 0; pick.size < count && i < count * 2; i++) pick.add(Math.min(N - 1, Math.round(i * (N - 1) / (count - 1))));
  const want = [...pick].sort((a, b) => a - b).slice(0, count);
  const h = Math.round(track.source.height * width / track.source.width / 2) * 2;
  const shots = new Map();
  await readFrames(plate, {width, height: h, onFrame: (rgb, i) => { if (want.includes(i)) shots.set(i, rgb); }});
  const cols = 3, rows = Math.ceil(want.length / cols), gap = 6;
  const W = cols * width + (cols + 1) * gap, H = rows * h + (rows + 1) * gap;
  const sheet = new Uint8Array(W * H * 3).fill(28);
  const k = width / track.source.width;
  want.forEach((i, n) => {
    const ox = gap + (n % cols) * (width + gap), oy = gap + Math.floor(n / cols) * (h + gap);
    const rgb = shots.get(i);
    if (!rgb) return;
    const f = track.frames[i];
    if (f.q) for (let s = 0; s < 4; s++) drawLine(rgb, width, h, f.q[s].map(v => v * k), f.q[(s + 1) % 4].map(v => v * k), f.c >= 0.5 ? [255, 0, 212] : [255, 176, 0]);
    for (let y = 0; y < h; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(Buffer.from(sheet.buffer), ((oy + y) * W + ox) * 3);
  });
  await fs.writeFile(outPng, encodePng(sheet, W, H, 3));
  return want.map(i => Math.round(i / fps * 100) / 100);
}

export {probeVideo};
