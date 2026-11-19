// Renders built creatives in headless Chrome so a model can look at them: frames at chosen moments,
// laid out as contact sheets (one PNG per format). Nothing here judges the frames; it only shows them.
import fs from 'node:fs/promises';
import path from 'node:path';
import {existsSync} from 'node:fs';
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
async function browser() {
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
  const out = [];
  const wins = F.cut?.scenes || [];
  wins.forEach((w, i) => {
    const dur = w.end - w.start;
    out.push({t: round(w.start + Math.min(0.8, dur * 0.45)), label: w.id + ' in'});
    if (i < wins.length - 1) out.push({t: round(w.end - 0.12), label: w.id + ' → ' + wins[i + 1].id});
  });
  out.push({t: round(F.length - 0.2), label: 'end hold'});
  return out.length ? out : [{t: 0, label: 'start'}, {t: round(F.length / 2), label: 'middle'}, {t: round(F.length - 0.2), label: 'end'}];
}

async function openFrame(page, url) {
  await page.evaluateOnNewDocument(() => {
    window.__formaReady = false;
    addEventListener('message', e => { if (e.data && e.data.type === 'forma:time') window.__formaReady = true; });
  });
  await page.goto(url, {waitUntil: 'load', timeout: 45000});
  // A creative that never reports ready is still shot: its frames and its errors are what the art director needs to see.
  return page.waitForFunction(() => window.__formaReady === true, {timeout: 30000}).then(() => true, () => false);
}

async function drawAt(page, t) {
  await page.evaluate(async time => {
    try { window.renderFrame?.(time); } catch (e) { console.error(e); }
    const videos = [...document.querySelectorAll('video')].filter(v => v.seeking);
    await Promise.all(videos.map(v => new Promise(r => { v.addEventListener('seeked', r, {once: true}); setTimeout(r, 1500); })));
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
  page.on('requestfailed', r => add('Failed to load ' + short(r.url()) + ': ' + (r.failure()?.errorText || 'failed')));
  page.on('response', r => { if (r.status() >= 400) add('HTTP ' + r.status() + ' for ' + short(r.url())); });
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
      if (!ready) add('The creative never reported it was ready (its setup did not finish within 30 s).');
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

// Writes one sheet. Returns the labels of frames that came out a single flat colour (nothing drawn, or the scene failed).
async function composeSheet(frames, title, file) {
  const b = await browser();
  const page = await b.newPage();
  try {
    const tiles = frames.map(fr => {
      const {w, h} = tileSize(fr);
      return `<figure style="width:${w}px"><img data-label="${escapeHtml(fr.label)}" data-frame="${fr.detail ? 0 : 1}" src="data:image/jpeg;base64,${Buffer.from(fr.png).toString('base64')}" style="width:${w}px;height:${h}px"><figcaption>${escapeHtml(fr.label)}${fr.t ? ' · ' + fr.t.toFixed(2) + ' s' : ''}</figcaption></figure>`;
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
    const blank = await page.evaluate(() => [...document.querySelectorAll('img[data-frame="1"]')].filter(img => {
      const c = document.createElement('canvas');
      c.width = 48; c.height = 48;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0, 48, 48);
      const d = x.getImageData(0, 0, 48, 48).data;
      let sum = 0, sq = 0;
      for (let i = 0; i < d.length; i += 4) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; sum += l; sq += l * l; }
      const n = d.length / 4, mean = sum / n;
      return Math.sqrt(Math.max(0, sq / n - mean * mean)) < 4;
    }).map(img => img.dataset.label)).catch(() => []);
    const width = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().width));
    await page.setViewport({width: Math.min(1560, Math.max(400, width)), height: 800, deviceScaleFactor: 1});
    await fs.mkdir(path.dirname(file), {recursive: true});
    await page.screenshot({path: file, type: 'png', fullPage: true});
    return blank;
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
  return shots;
}

// Returns the sheets (an array) with .problems = {errors: [{message, where: []}], blank: [labels]} attached.
export async function renderSheets({url, stage, setup, scenario, outDir, publicBase, log = () => {}}) {
  const shots = planShots({stage, setup, scenario});
  let done = 0;
  const {frames, problems} = await shoot({url, shots, onProgress: () => { done++; if (done % 3 === 0 || done === shots.length) log('Rendered ' + done + ' of ' + shots.length + ' views'); }});
  const groups = new Map();
  for (const fr of frames) {
    if (!groups.has(fr.sheet)) groups.set(fr.sheet, []);
    groups.get(fr.sheet).push(fr);
  }
  const sheets = [];
  const length = setup.kind === 'poster' ? '' : ' · ' + Math.max(...(setup.lengths || [0])) + ' s';
  for (const [key, list] of groups) {
    const isDetail = key.startsWith('details-');
    const base = key === 'preview' ? 'preview' : key === 'languages' ? 'languages' : isDetail ? key : 'format-' + key;
    const title = key === 'preview' ? 'Preview · ' + (setup.formats?.[0] || '') + ' · ' + (setup.languages?.[0] || '')
      : key === 'languages' ? 'End frame in every other language'
      : isDetail ? 'Text close-ups at full size · ' + fmtOf(key.slice('details-'.length)).label
      : fmtOf(key).label + ' · ' + (setup.languages?.[0] || '') + length;
    // At most four tiles per sheet, so a sheet stays readable without being scaled down.
    const pages = [];
    for (let i = 0; i < list.length; i += 4) pages.push(list.slice(i, i + 4));
    for (let i = 0; i < pages.length; i++) {
      const name = base + (pages.length > 1 ? '-' + (i + 1) : '');
      const pageTitle = title + (pages.length > 1 ? ' · ' + (i + 1) + '/' + pages.length : '');
      const file = path.join(outDir, name + '.png');
      const blank = await composeSheet(pages[i], pageTitle, file);
      const fmt = key === 'preview' ? setup.formats?.[0] : key === 'languages' ? null : key;
      for (const label of blank) problems.blank.push((fmt ? fmtOf(fmt).label + ' · ' : '') + label);
      sheets.push({name, title: pageTitle, file, url: publicBase + '/' + name + '.png', frames: pages[i].length});
    }
  }
  if (problems.errors.length) log('The browser reported ' + problems.errors.length + ' problem' + (problems.errors.length === 1 ? '' : 's') + ': ' + problems.errors[0].message, {level: 'warn'});
  if (problems.blank.length) log('Frames that came out a flat colour: ' + problems.blank.join(', '), {level: 'warn'});
  return Object.assign(sheets, {problems});
}
