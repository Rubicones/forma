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
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
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
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--font-render-hinting=none'],
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
  await page.waitForFunction(() => window.__formaReady === true, {timeout: 30000}).catch(() => {
    throw fail('The creative did not finish loading in the renderer: ' + url, 502);
  });
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

/**
 * Renders one entry. Returns frames grouped by sheet.
 * shots: [{format, lang, length?, scene?, times?: [{t,label}] | 'auto'}]
 */
async function shoot({url, shots, scale = 0.42, onProgress = () => {}}) {
  const b = await browser();
  const frames = [];
  {
    for (const shot of shots) {
      const f = fmtOf(shot.format);
      const q = new URLSearchParams({f: f.id, l: shot.lang, paused: '1', t: '0'});
      if (shot.length) q.set('d', String(shot.length));
      if (shot.scene) q.set('scene', shot.scene);
      const u = url + (url.includes('?') ? '&' : '?') + q;
      // A fresh document per shot: the creative sets itself up for one format, language and length.
      const fresh = await b.newPage();
      try {
        await fresh.setViewport({width: f.w, height: f.h, deviceScaleFactor: scale});
        await openFrame(fresh, u);
        const times = shot.times === 'auto' || !shot.times ? await fresh.evaluate(momentsInPage) : shot.times;
        for (const m of times) {
          await drawAt(fresh, m.t);
          const png = await fresh.screenshot({type: 'jpeg', quality: 82});
          frames.push({sheet: shot.sheet, label: shot.label ? shot.label + ' · ' + m.label : m.label, t: m.t, format: f.id, lang: shot.lang, png, w: f.w, h: f.h});
        }
        onProgress(shot);
      } finally {
        await fresh.close().catch(() => {});
      }
    }
  }
  return frames;
}

async function composeSheet(frames, title, file) {
  const b = await browser();
  const page = await b.newPage();
  try {
    const tileH = 360;
    const tiles = frames.map(fr => {
      const w = Math.round((fr.w / fr.h) * tileH);
      return `<figure style="width:${w}px"><img src="data:image/jpeg;base64,${Buffer.from(fr.png).toString('base64')}" style="width:${w}px;height:${tileH}px"><figcaption>${escapeHtml(fr.label)}${fr.t ? ' · ' + fr.t.toFixed(2) + ' s' : ''}</figcaption></figure>`;
    }).join('');
    const html = `<!doctype html><html><head><style>
      body{margin:0;padding:16px;background:#e9e9e4;font:600 15px/1.3 -apple-system,Helvetica,Arial,sans-serif;color:#1e231d;width:max-content;max-width:2200px}
      h1{font-size:18px;margin:0 0 12px}
      .grid{display:flex;flex-wrap:wrap;gap:14px;max-width:2168px}
      figure{margin:0}
      img{display:block;object-fit:contain;background:#fff;box-shadow:0 0 0 1px #c9cbc2}
      figcaption{padding-top:6px;font-weight:500;font-size:14px;color:#3c4439}
    </style></head><body><h1>${escapeHtml(title)}</h1><div class="grid">${tiles}</div></body></html>`;
    await page.setViewport({width: 2200, height: 800, deviceScaleFactor: 1});
    await page.setContent(html, {waitUntil: 'load'});
    const width = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().width));
    await page.setViewport({width: Math.min(2200, Math.max(400, width)), height: 800, deviceScaleFactor: 1});
    await fs.mkdir(path.dirname(file), {recursive: true});
    await page.screenshot({path: file, type: 'png', fullPage: true});
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
    return scenes.map(scene => ({sheet: 'preview', format: formats[0], lang: primaryLang, scene, label: scene || 'preview', times: [{t: 0, label: 'frame'}]}));
  }
  const length = setup.kind === 'poster' ? null : Math.max(...(setup.lengths || [0]));
  const shots = formats.map(format => ({sheet: format, format, lang: primaryLang, length, times: 'auto'}));
  if (langs.length > 1) {
    const end = setup.kind === 'poster' ? 0 : Math.max(0, (length || 0) - 0.2);
    for (const lang of langs.slice(1)) {
      for (const format of formats) shots.push({sheet: 'languages', format, lang, length, label: format + ' · ' + lang, times: [{t: end, label: 'end'}]});
    }
  }
  return shots;
}

export async function renderSheets({url, stage, setup, scenario, outDir, publicBase, log = () => {}}) {
  const shots = planShots({stage, setup, scenario});
  let done = 0;
  const frames = await shoot({url, shots, onProgress: () => { done++; if (done % 3 === 0 || done === shots.length) log('Rendered ' + done + ' of ' + shots.length + ' views'); }});
  const groups = new Map();
  for (const fr of frames) {
    if (!groups.has(fr.sheet)) groups.set(fr.sheet, []);
    groups.get(fr.sheet).push(fr);
  }
  const sheets = [];
  for (const [key, list] of groups) {
    const name = key === 'preview' ? 'preview' : key === 'languages' ? 'languages' : 'format-' + key;
    const title = key === 'preview' ? 'Preview · ' + (setup.formats?.[0] || '') + ' · ' + (setup.languages?.[0] || '')
      : key === 'languages' ? 'End frame in every other language'
      : fmtOf(key).label + ' · ' + (setup.languages?.[0] || '') + (setup.kind === 'poster' ? '' : ' · ' + Math.max(...(setup.lengths || [0])) + ' s');
    const file = path.join(outDir, name + '.png');
    await composeSheet(list, title, file);
    sheets.push({name, title, file, url: publicBase + '/' + name + '.png', frames: list.length});
  }
  return sheets;
}
