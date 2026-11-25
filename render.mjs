// Renders built creatives in headless Chrome so a model can look at them: frames at chosen moments,
// laid out as contact sheets (one PNG per format). Nothing here judges the frames; it only shows them.
import fs from 'node:fs/promises';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {formats as allFormats} from './motion.mjs';

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/headless-shell/headless-shell'],
  // Chrome installed for one user lives in %LOCALAPPDATA%; Edge ships with every Windows 10/11 and works as a fallback.
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ...(process.env.LOCALAPPDATA ? [process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'] : []),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

const fail = (message, status = 503) => Object.assign(Error(message), {status});

export function findChrome() {
  const fromEnv = process.env.FORMA_CHROME;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  return (CANDIDATES[process.platform] || []).find(p => existsSync(p)) || null;
}

let browserPromise = null;
export async function browser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b?.connected) return b;
    browserPromise = null;
  }
  let puppeteer;
  try {
    puppeteer = (await import('puppeteer-core')).default;
  } catch {
    throw fail('The art director cannot see the frames yet: run npm install in the project folder, then restart the server.');
  }
  const executablePath = findChrome();
  if (!executablePath) throw fail('The art director needs Chrome to look at the frames. Install Google Chrome or set FORMA_CHROME in .env to a Chrome or Chromium executable.');
  browserPromise = puppeteer.launch({
    executablePath,
    headless: true,
    // WebGL must work for 3D creatives: no --disable-gpu, and the software renderer allowed where there is no GPU.
    args: ['--no-sandbox', '--hide-scrollbars', '--mute-audio', '--font-render-hinting=none', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });
  return browserPromise;
}

// Whether this Chrome plays H.264, the codec of every generated clip. Chromium builds without proprietary codecs
// (Playwright's, most Linux packages) draw every clip black: the check would judge black frames and exports would
// ship them (round 9). Asked once per browser.
let supportPromise = null;
export async function videoSupport() {
  const b = await browser();
  if (supportPromise?.browser === b) return supportPromise.value;
  const value = (async () => {
    const page = await b.newPage();
    try {
      // what the browser claims, then a real decode of one H.264 frame (render-h264-probe.mp4, 16×16, 1.5 KB)
      // FORMA_H264_PROBE: another file to decode instead (tests use a broken one to stand in for a Chrome without H.264)
      const probeFile = process.env.FORMA_H264_PROBE || new URL('./render-h264-probe.mp4', import.meta.url);
      const probe = 'data:video/mp4;base64,' + (await fs.readFile(probeFile)).toString('base64');
      const h264 = await page.evaluate(src => new Promise(resolve => {
        const v = document.createElement('video');
        if (!['video/mp4; codecs="avc1.640028"', 'video/mp4; codecs="avc1.42E01E"'].some(type => v.canPlayType(type) !== '')) return resolve(false);
        const done = ok => { clearTimeout(timer); resolve(ok); };
        const timer = setTimeout(() => done(v.readyState >= 2), 5000);
        v.muted = true;
        v.onloadeddata = () => done(v.videoWidth > 0);
        v.onerror = () => done(false);
        v.src = src;
      }), probe);
      return {h264, browser: findChrome()};
    } catch { return {h264: true, browser: findChrome()}; }   // cannot tell: do not block on it
    finally { await page.close().catch(() => {}); }
  })();
  supportPromise = {browser: b, value};
  return value;
}
export const noH264Message = chrome => `This Chrome cannot play H.264 video (${path.basename(chrome || 'chrome')}), so every clip shows black in its frames. Install Google Chrome or point FORMA_CHROME in .env at it (not a Chromium build without proprietary codecs).`;

export async function closeRenderer() {
  const b = await browserPromise?.catch(() => null);
  browserPromise = null;
  await b?.close().catch(() => {});
}

// Moments worth looking at, computed inside the page from the runtime's own timing.
function momentsInPage() {
  const F = window.FORMA || {};
  const round = t => Math.max(0, Math.round(t * 100) / 100);
  if (F.stage === 'preview' || F.kind === 'poster' || !(F.length > 0)) return [{t: 0, label: 'frame'}];
  if (F.loop && F.loop.period) {
    const p = F.loop.period;
    return [{t: 0, label: 'start'}, {t: round(p / 3), label: '⅓ loop'}, {t: round((2 * p) / 3), label: '⅔ loop'}, {t: round(p - 0.04), label: 'seam'}];
  }
  // The first frame is the thumbnail and what a feed shows before playback: it is always looked at.
  const out = [{t: 0, label: 'first frame'}];
  const wins = F.cut?.scenes || [];
  wins.forEach((w, i) => {
    const dur = w.end - w.start;
    out.push({t: round(w.start + Math.min(0.8, dur * 0.45)), label: w.id + ' in'});
    if (i < wins.length - 1) out.push({t: round(w.end - 0.12), label: w.id + ' → ' + wins[i + 1].id});
  });
  out.push({t: round(F.length - 0.2), label: 'end hold'});
  return out.length > 1 ? out : [{t: 0, label: 'first frame'}, {t: round(F.length / 2), label: 'middle'}, {t: round(F.length - 0.2), label: 'end'}];
}

// readyMs: how long the creative's own setup may take (a clip analysed in FORMA.setup can take a minute or more).
export const READY_MS = {review: 120000, export: 240000};
export async function openFrame(page, url, readyMs = READY_MS.review) {
  await page.evaluateOnNewDocument(() => {
    window.__formaReady = false;
    addEventListener('message', e => { if (e.data && e.data.type === 'forma:time') window.__formaReady = true; });
  });
  await page.goto(url, {waitUntil: 'load', timeout: 60000});
  // A creative that never reports ready is still shot: its frames and its errors are what the art director needs to see.
  return page.waitForFunction(() => window.__formaReady === true, {timeout: readyMs, polling: 250}).then(() => true, () => false);
}

// Draws moment t. A clip the frame asked to seek shows its new frame only after 'seeked', so the frame is drawn again
// then: creatives that paint video into a canvas or WebGL (keying, 3D screens) would otherwise show the previous frame.
async function drawAt(page, t) {
  await page.evaluate(async time => {
    const draw = () => { try { window.renderFrame?.(time); } catch (e) { console.error(e); } };
    draw();
    const settle = v => new Promise(r => {
      if (!v.seeking && v.readyState >= 2) return r();
      const done = () => r();
      v.addEventListener('seeked', done, {once: true});
      v.addEventListener('loadeddata', done, {once: true});
      setTimeout(done, 3000);
    });
    const videos = [...document.querySelectorAll('video')];
    const waited = videos.filter(v => v.seeking || v.readyState < 2);
    await Promise.all(waited.map(settle));
    if (waited.length) draw();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, t);
}

const fmtOf = id => allFormats[id] || allFormats['1x1'];

// Text blocks on screen at this moment: elements with their own visible text, largest type first.
function textBoxesInPage() {
  const W = innerWidth, H = innerHeight, out = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 6 || r.right < 0 || r.bottom < 0 || r.left > W || r.top > H) continue;
    let op = 1, hidden = false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden') { hidden = true; break; }
      op *= Number(cs.opacity);
    }
    if (hidden || op < 0.05) continue;
    out.push({x: r.left, y: r.top, w: r.width, h: r.height, size: parseFloat(getComputedStyle(el).fontSize) || 0});
  }
  out.sort((a, b) => b.size - a.size);
  const picked = [];
  for (const b of out) {
    if (picked.some(p => b.x >= p.x - 2 && b.y >= p.y - 2 && b.x + b.w <= p.x + p.w + 2 && b.y + b.h <= p.y + p.h + 2)) continue;
    picked.push(b);
    if (picked.length === 4) break;
  }
  return picked.map(b => {
    const pad = 16, x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
    return {x, y, width: Math.max(1, Math.min(W - x, b.w + 2 * pad)), height: Math.max(1, Math.min(H - y, b.h + 2 * pad))};
  });
}

// Problems the browser itself reports: script errors, failed loads, a creative that never got ready.
function watch(page, where, problems) {
  const add = msg => {
    const text = String(msg || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!text) return;
    const known = problems.errors.find(e => e.message === text);
    if (known) { if (!known.where.includes(where)) known.where.push(where); return; }
    if (problems.errors.length < 20) problems.errors.push({message: text, where: [where]});
  };
  const short = u => u.split('?')[0].split('/').slice(-2).join('/');
  page.on('pageerror', e => add('Script error: ' + (e?.message || e)));
  page.on('console', m => { if (m.type() === 'error') add('Console error: ' + m.text()); });
  // Chrome aborts a clip's range requests itself while it seeks (net::ERR_ABORTED): not a failed load. A clip that
  // really fails shows as an HTTP error, a media error in the console, or a frame that does not move.
  // Chrome asks for /favicon.ico on its own; the creative never does (round 9: an auto-fix spent on it).
  const favicon = u => /\/favicon\.ico(?:[?#]|$)/i.test(u);
  page.on('requestfailed', r => {
    if (favicon(r.url())) return;
    const why = r.failure()?.errorText || 'failed';
    if (why === 'net::ERR_ABORTED' && ['media', 'other'].includes(r.resourceType())) return;
    add('Failed to load ' + short(r.url()) + ': ' + why);
  });
  page.on('response', r => { if (r.status() >= 400 && !favicon(r.url())) add('HTTP ' + r.status() + ' for ' + short(r.url())); });
  return add;
}

/**
 * Renders one entry. Returns the frames grouped by sheet, close-ups of the text, and what the browser reported.
 * shots: [{format, lang, length?, scene?, times?: [{t,label}] | 'auto', details?: boolean}]
 */
async function shoot({url, shots, scale = 0.5, onProgress = () => {}}) {
  const b = await browser();
  const frames = [];
  const problems = {errors: [], blank: []};
  for (const shot of shots) {
    const f = fmtOf(shot.format);
    const q = new URLSearchParams({f: f.id, l: shot.lang, paused: '1', t: '0'});
    if (shot.length) q.set('d', String(shot.length));
    if (shot.scene) q.set('scene', shot.scene);
    const u = url + (url.includes('?') ? '&' : '?') + q;
    const where = f.label + ' · ' + shot.lang + (shot.scene ? ' · ' + shot.scene : '');
    // A fresh document per shot: the creative sets itself up for one format, language and length.
    const fresh = await b.newPage();
    const add = watch(fresh, where, problems);
    try {
      await fresh.setViewport({width: f.w, height: f.h, deviceScaleFactor: scale});
      let ready = false;
      try { ready = await openFrame(fresh, u); } catch (e) { add('The creative did not load: ' + e.message); continue; }
      if (!ready) add('The creative never reported it was ready (its setup did not finish within 2 minutes).');
      if (!problems.hasVideo && await fresh.evaluate(() => document.querySelector('video') !== null).catch(() => false)) problems.hasVideo = true;
      const times = shot.times === 'auto' || !shot.times ? await fresh.evaluate(momentsInPage).catch(() => [{t: 0, label: 'frame'}]) : shot.times;
      for (const m of times) {
        await drawAt(fresh, m.t);
        const png = await fresh.screenshot({type: 'jpeg', quality: 82});
        frames.push({sheet: shot.sheet, label: shot.label ? shot.label + ' · ' + m.label : m.label, t: m.t, format: f.id, lang: shot.lang, png, w: f.w, h: f.h});
      }
      // Close-ups of the text at full resolution, on the first and the last moment: small type, clipped words and broken numbers show here.
      if (shot.details) {
        await fresh.setViewport({width: f.w, height: f.h, deviceScaleFactor: 1});
        const moments = times.length > 1 ? [times[0], times[times.length - 1]] : times;
        for (const m of moments) {
          await drawAt(fresh, m.t);
          const boxes = await fresh.evaluate(textBoxesInPage).catch(() => []);
          for (const clip of boxes) {
            const png = await fresh.screenshot({type: 'jpeg', quality: 88, clip}).catch(() => null);
            if (png) frames.push({sheet: 'details-' + f.id, label: f.label + ' · ' + (shot.scene || m.label) + ' · text', t: m.t, format: f.id, lang: shot.lang, png, w: Math.round(clip.width), h: Math.round(clip.height), detail: true});
          }
        }
      }
      onProgress(shot);
    } finally {
      await fresh.close().catch(() => {});
    }
  }
  return {frames, problems};
}

// Frames are shown big enough to read: the long side of a frame tile is 640 px; a close-up keeps its own pixels up to 1500 px wide.
const tileSize = fr => {
  const k = fr.detail ? Math.min(1, 1500 / fr.w) : 640 / Math.max(fr.w, fr.h);
  return {w: Math.round(fr.w * k), h: Math.round(fr.h * k)};
};

// Writes one sheet. Returns the labels of frames that came out a single flat colour (nothing drawn, or the scene failed)
// and of frames that still show pure chroma green (a screen surface the interface layer did not cover).
async function composeSheet(frames, title, file) {
  const b = await browser();
  const page = await b.newPage();
  try {
    const tiles = frames.map(fr => {
      const {w, h} = tileSize(fr);
      return `<figure style="width:${w}px"><img data-label="${escapeHtml(fr.label)}" data-frame="${fr.detail ? 0 : 1}" data-i="${frames.indexOf(fr)}" src="data:image/jpeg;base64,${Buffer.from(fr.png).toString('base64')}" style="width:${w}px;height:${h}px"><figcaption>${escapeHtml(fr.label)}${fr.t ? ' · ' + fr.t.toFixed(2) + ' s' : ''}</figcaption></figure>`;
    }).join('');
    const html = `<!doctype html><html><head><style>
      body{margin:0;padding:16px;background:#e9e9e4;font:600 15px/1.3 -apple-system,Helvetica,Arial,sans-serif;color:#1e231d;width:max-content;max-width:1560px}
      h1{font-size:18px;margin:0 0 12px}
      .grid{display:flex;flex-wrap:wrap;gap:14px;max-width:1528px;align-items:flex-start}
      figure{margin:0}
      img{display:block;object-fit:contain;background:#fff;box-shadow:0 0 0 1px #c9cbc2}
      figcaption{padding-top:6px;font-weight:500;font-size:14px;color:#3c4439}
    </style></head><body><h1>${escapeHtml(title)}</h1><div class="grid">${tiles}</div></body></html>`;
    await page.setViewport({width: 1560, height: 800, deviceScaleFactor: 1});
    await page.setContent(html, {waitUntil: 'load'});
    const {blank, green, sigs, blurred} = await page.evaluate(() => {
      const blank = [], green = [], sigs = {}, blurred = [];
      for (const img of document.querySelectorAll('img[data-frame="1"]')) {
        const c = document.createElement('canvas');
        c.width = 96; c.height = 96;
        const x = c.getContext('2d');
        x.drawImage(img, 0, 0, 96, 96);
        const d = x.getImageData(0, 0, 96, 96).data;
        let sum = 0, sq = 0, chroma = 0;
        for (let i = 0; i < d.length; i += 4) {
          const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; sum += l; sq += l * l;
          if (d[i + 1] > 200 && d[i] < 90 && d[i + 2] < 90) chroma++;
        }
        const n = d.length / 4, mean = sum / n;
        // a 24×24 luminance print of the frame, to tell whether the spot moves at all
        const sig = [];
        for (let y = 0; y < 24; y++) for (let x2 = 0; x2 < 24; x2++) { let v = 0; for (let k = 0; k < 16; k++) { const i = ((y * 4 + (k >> 2)) * 96 + x2 * 4 + (k & 3)) * 4; v += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; } sig.push(v / 16); }
        sigs[img.dataset.i] = sig;
        if (Math.sqrt(Math.max(0, sq / n - mean * mean)) < 4) blank.push(img.dataset.label);
        else if (chroma / n > 0.004) green.push(img.dataset.label);
        // Blurred fill bars: a picture or clip of another shape padded with a blurred copy of itself. Both opposite
        // edges soft but not flat while the middle is sharp (a solid background band, or one soft side, is design).
        const W = 240, H = Math.max(8, Math.round(240 * img.naturalHeight / Math.max(1, img.naturalWidth)));
        const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
        const x2c = c2.getContext('2d'); x2c.drawImage(img, 0, 0, W, H);
        const e = x2c.getImageData(0, 0, W, H).data;
        const lum = (xx, yy) => { const i = (yy * W + xx) * 4; return 0.2126 * e[i] + 0.7152 * e[i + 1] + 0.0722 * e[i + 2]; };
        const region = (ax, ay, bx, by) => {
          let g = 0, s1 = 0, s2 = 0, k = 0;
          for (let yy = Math.max(1, ay); yy < Math.min(H - 1, by); yy++) for (let xx = Math.max(1, ax); xx < Math.min(W - 1, bx); xx++) {
            const l = lum(xx, yy); g += Math.abs(l - lum(xx - 1, yy)) + Math.abs(l - lum(xx, yy - 1)); s1 += l; s2 += l * l; k++;
          }
          const m = s1 / Math.max(1, k);
          return {g: g / Math.max(1, k), sd: Math.sqrt(Math.max(0, s2 / Math.max(1, k) - m * m))};
        };
        const mid = region(W * .25 | 0, H * .25 | 0, W * .75 | 0, H * .75 | 0);
        const soft = r => mid.g > 6 && r.g < mid.g * 0.18 && r.sd > 6;
        const bw = Math.max(3, W * .1 | 0), bh = Math.max(3, H * .1 | 0);
        const sides = [];
        if (soft(region(0, 0, bw, H)) && soft(region(W - bw, 0, W, H))) sides.push('left and right');
        if (soft(region(0, 0, W, bh)) && soft(region(0, H - bh, W, H))) sides.push('top and bottom');
        if (sides.length) blurred.push(img.dataset.label + ' (' + sides.join(', ') + ')');
      }
      return {blank, green, sigs, blurred};
    }).catch(() => ({blank: [], green: [], sigs: {}, blurred: []}));
    for (const [i, sig] of Object.entries(sigs)) frames[i].sig = sig;
    const width = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().width));
    await page.setViewport({width: Math.min(1560, Math.max(400, width)), height: 800, deviceScaleFactor: 1});
    await fs.mkdir(path.dirname(file), {recursive: true});
    await page.screenshot({path: file, type: 'png', fullPage: true});
    return {blank, green, blurred};
  } finally {
    await page.close().catch(() => {});
  }
}

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

/**
 * What the art director looks at.
 * preview: the primary format and language; for a storyboard, every scene.
 * final: every format at the moments that matter (longest length), plus the end frame of every other language.
 */
export function planShots({stage, setup, scenario}) {
  const langs = setup.languages || ['en'];
  const primaryLang = langs[0];
  const formats = setup.formats || ['1x1'];
  if (stage === 'preview') {
    const scenes = setup.kind === 'multi' ? (scenario?.scenes || []).map(s => s.id) : [null];
    return scenes.map(scene => ({sheet: 'preview', format: formats[0], lang: primaryLang, scene, label: scene || 'preview', times: [{t: 0, label: 'frame'}], details: true}));
  }
  const length = setup.kind === 'poster' ? null : Math.max(...(setup.lengths || [0]));
  const shots = formats.map(format => ({sheet: format, format, lang: primaryLang, length, times: 'auto', details: true}));
  if (langs.length > 1) {
    const end = setup.kind === 'poster' ? 0 : Math.max(0, (length || 0) - 0.2);
    for (const lang of langs.slice(1)) {
      for (const format of formats) shots.push({sheet: 'languages', format, lang, length, label: format + ' · ' + lang, times: [{t: end, label: 'end'}]});
    }
  }
  // Every shorter cut too, in the first format: its own story moments, and its end hold in every language. A short cut
  // is planned separately and was never looked at before (round 9: the 6 s cuts lost their answer and nobody saw it).
  if (setup.kind !== 'poster') {
    for (const short of [...new Set(setup.lengths || [])].filter(l => l > 0 && l < length).sort((a, b) => a - b)) {
      shots.push({sheet: 'length-' + short, format: formats[0], lang: primaryLang, length: short, times: 'auto', label: short + ' s'});
      for (const lang of langs.slice(1)) shots.push({sheet: 'languages', format: formats[0], lang, length: short, label: formats[0] + ' · ' + lang + ' · ' + short + ' s', times: [{t: Math.max(0, short - 0.2), label: 'end'}]});
    }
  }
  return shots;
}

// Returns the sheets (an array) with .problems = {errors: [{message, where: []}], blank: [labels]} attached.
export async function renderSheets({url, stage, setup, scenario, outDir, publicBase, log = () => {}}) {
  const shots = planShots({stage, setup, scenario});
  let done = 0;
  const support = await videoSupport();
  const {frames, problems} = await shoot({url, shots, onProgress: () => { done++; if (done % 3 === 0 || done === shots.length) log('Rendered ' + done + ' of ' + shots.length + ' views'); }});
  problems.green = [];
  problems.blurred = [];
  // A Chrome without H.264 shows clips black: what it says about clips is not about the creative.
  if (!support.h264 && problems.hasVideo) {
    problems.videoBlind = noH264Message(support.browser);
    const media = /\.(?:mp4|m4v|mov|webm)\b|\bvideo\b|\bclip\b|\bmedia\b|\bfootage\b|MEDIA_ERR|DEMUXER|decode/i;
    problems.unverified = problems.errors.filter(e => media.test(e.message));
    problems.errors = problems.errors.filter(e => !media.test(e.message));
    log(problems.videoBlind + ' Clips are not judged in this check.', {level: 'warn'});
  }
  const groups = new Map();
  for (const fr of frames) {
    if (!groups.has(fr.sheet)) groups.set(fr.sheet, []);
    groups.get(fr.sheet).push(fr);
  }
  const sheets = [];
  const length = setup.kind === 'poster' ? '' : ' · ' + Math.max(...(setup.lengths || [0])) + ' s';
  for (const [key, list] of groups) {
    const isDetail = key.startsWith('details-');
    const isLength = key.startsWith('length-');
    const base = key === 'preview' ? 'preview' : key === 'languages' ? 'languages' : isDetail || isLength ? key : 'format-' + key;
    const title = key === 'preview' ? 'Preview · ' + (setup.formats?.[0] || '') + ' · ' + (setup.languages?.[0] || '')
      : key === 'languages' ? 'End frame in every other language'
      : isLength ? 'Short cut · ' + key.slice('length-'.length) + ' s · ' + fmtOf(setup.formats?.[0] || '1x1').label + ' · ' + (setup.languages?.[0] || '')
      : isDetail ? 'Text close-ups at full size · ' + fmtOf(key.slice('details-'.length)).label
      : fmtOf(key).label + ' · ' + (setup.languages?.[0] || '') + length;
    // At most four tiles per sheet, so a sheet stays readable without being scaled down.
    const pages = [];
    for (let i = 0; i < list.length; i += 4) pages.push(list.slice(i, i + 4));
    for (let i = 0; i < pages.length; i++) {
      const name = base + (pages.length > 1 ? '-' + (i + 1) : '');
      const pageTitle = title + (pages.length > 1 ? ' · ' + (i + 1) + '/' + pages.length : '');
      const file = path.join(outDir, name + '.png');
      const {blank, green, blurred = []} = await composeSheet(pages[i], pageTitle, file);
      const fmt = key === 'preview' || isLength ? setup.formats?.[0] : key === 'languages' || isDetail ? null : key;
      const where = label => (fmt ? fmtOf(fmt).label + ' · ' : '') + label;
      for (const label of blank) problems.blank.push(where(label));
      for (const label of green) problems.green.push(where(label));
      for (const label of blurred) problems.blurred.push(where(label));
      sheets.push({name, title: pageTitle, file, url: publicBase + '/' + name + '.png', frames: pages[i].length});
    }
  }
  // A video that shows the same picture at every moment does not play (round 8: stuck on its first frame in every format).
  problems.still = [];
  if (stage !== 'preview' && setup.kind !== 'poster' && (support.h264 || !problems.hasVideo)) {
    for (const [key, list] of groups) {
      if (key === 'preview' || key === 'languages' || key.startsWith('details-')) continue;
      const seen = list.filter(fr => fr.sig).sort((a, b) => a.t - b.t);
      if (seen.length < 2 || seen.at(-1).t - seen[0].t < 1.5) continue;
      const diff = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
      if (seen.every(fr => diff(fr.sig, seen[0].sig) < 1.2)) problems.still.push(key.startsWith('length-') ? fmtOf(list[0].format).label + ' · ' + key.slice(7) + ' s' : fmtOf(key).label);
    }
  }
  if (problems.blurred.length) log('Blurred fill at the edges (a picture or clip of another shape padded with a blurred copy): ' + problems.blurred.join(', '), {level: 'warn'});
  if (problems.still.length) log('The video does not move in: ' + problems.still.join(', ') + ' (the same picture at every moment)', {level: 'warn'});
  if (problems.errors.length) log('The browser reported ' + problems.errors.length + ' problem' + (problems.errors.length === 1 ? '' : 's') + ': ' + problems.errors[0].message, {level: 'warn'});
  if (problems.blank.length) log('Frames that came out a flat colour: ' + problems.blank.join(', '), {level: 'warn'});
  if (problems.green.length) log('Frames with chroma green left: ' + problems.green.join(', '), {level: 'warn'});
  return Object.assign(sheets, {problems});
}

// ---------- export: the final as the client downloads it (export.mjs) ----------
// A video is the creative drawn frame by frame with renderFrame(t) and encoded by ffmpeg; a still is one frame.
// Both at the format's native size, deviceScaleFactor 1, one format, language and length per document.


export async function findFfmpeg() {
  if (process.env.FORMA_FFMPEG) return existsSync(process.env.FORMA_FFMPEG) ? process.env.FORMA_FFMPEG : null;
  try {
    const bundled = (await import('ffmpeg-static')).default;
    if (bundled && existsSync(bundled)) return bundled;
  } catch { /* not installed: try the one on PATH */ }
  return 'ffmpeg';
}

async function openForExport({url, format, lang, length, problems}) {
  const f = fmtOf(format);
  const q = new URLSearchParams({f: f.id, l: lang, paused: '1', t: '0'});
  if (length) q.set('d', String(length));
  const page = await (await browser()).newPage();
  watch(page, f.label + ' · ' + lang + (length ? ' · ' + length + ' s' : ''), problems);
  await page.setViewport({width: f.w, height: f.h, deviceScaleFactor: 1});
  if (!await openFrame(page, url + (url.includes('?') ? '&' : '?') + q, READY_MS.export)) problems.errors.push({message: 'The creative never reported it was ready.', where: [f.label]});
  const support = await videoSupport();
  if (!support.h264 && await page.evaluate(() => document.querySelector('video') !== null).catch(() => false)) {
    await page.close().catch(() => {});
    throw fail(noH264Message(support.browser));
  }
  return {page, f};
}

// The moment a still shows: the poster itself, a third into a loop, or the end hold of a story (offer and CTA).
function stillMoment() {
  const F = window.FORMA || {};
  if (F.kind === 'poster' || !(F.length > 0)) return 0;
  if (F.loop?.period) return Math.round(F.loop.period / 3 * 100) / 100;
  return Math.max(0, Math.round((F.length - 0.2) * 100) / 100);
}

export async function renderStill({url, format, lang, length = 0}) {
  const problems = {errors: []};
  const {page, f} = await openForExport({url, format, lang, length, problems});
  try {
    const t = await page.evaluate(stillMoment).catch(() => 0);
    await drawAt(page, t);
    const bytes = await page.screenshot({type: 'png'});
    return {bytes: Buffer.from(bytes), width: f.w, height: f.h, problems};
  } finally {
    await page.close().catch(() => {});
  }
}

export async function renderVideo({url, format, lang, length, fps = 30, ffmpeg, onProgress = () => {}, signal}) {
  const problems = {errors: []};
  const bin = ffmpeg || await findFfmpeg();
  let page = null, f = fmtOf(format);
  const frames = Math.max(1, Math.round(length * fps));
  // MP4 with its index at the front needs a seekable output: a temporary file, read back at the end.
  const file = path.join(tmpdir(), 'forma-export-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.mp4');
  let stderr = '';
  // H.264 for every platform the client posts to: yuv420p, even sizes, the index at the front for streaming.
  const proc = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-r', String(fps), '-movflags', '+faststart', '-y', file], {stdio: ['pipe', 'ignore', 'pipe']});
  const done = new Promise((resolve, reject) => {
    proc.on('error', err => reject(Object.assign(Error(err.code === 'ENOENT'
      ? 'ffmpeg was not found: run npm install in the project folder, or set FORMA_FFMPEG in .env.' : 'ffmpeg failed: ' + err.message), {status: 503})));
    proc.on('close', code => (code === 0 ? resolve() : reject(Error('ffmpeg stopped (' + code + '): ' + stderr.trim().slice(-300)))));
  });
  // ffmpeg that quits early (not found, bad input) stops the export at once instead of after every frame is drawn.
  let quit = null;
  done.catch(err => { quit = err; });
  proc.stderr.on('data', c => { stderr += c; });
  proc.stdin.on('error', () => {});   // ffmpeg quit early: its own error says why
  try {
    // ffmpeg starts first, so a missing one is known before the page spends minutes getting ready.
    await new Promise(r => setImmediate(r));
    if (quit) throw quit;
    ({page, f} = await openForExport({url, format, lang, length, problems}));
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw Error('Export stopped.');
      if (quit) throw quit;
      await drawAt(page, i / fps);
      const jpg = await page.screenshot({type: 'jpeg', quality: 92});
      if (quit) throw quit;
      if (!proc.stdin.write(jpg)) await Promise.race([new Promise(r => proc.stdin.once('drain', r)), done.catch(() => {})]);
      if (i % fps === 0) onProgress(i / frames);
    }
    if (quit) throw quit;
    proc.stdin.end();
    await done;
    return {bytes: await fs.readFile(file), width: f.w - (f.w % 2), height: f.h - (f.h % 2), problems};
  } catch (err) {
    proc.kill('SIGKILL');
    throw err;
  } finally {
    await page?.close().catch(() => {});
    await fs.rm(file, {force: true}).catch(() => {});
  }
}
