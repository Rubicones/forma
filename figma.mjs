// "Read Figma": a client's Figma file read through the REST API with the studio's token (FIGMA_TOKEN, scope
// file_content:read). Gives the brand its frames as pictures (figma/<file>/<page>/<frame>.png) and its styles with
// exact values (figma/<file>/styles.json). Figma rates the content and image endpoints by the token owner's seat and
// by the plan of the team that holds the file: a Dev or Full seat on a paid plan reads freely, a file in a free team
// gets a few reads a month. So a read costs at most a handful of calls: the file, the style values, the images.

const API = 'https://api.figma.com/v1';
export const FIGMA_LIMITS = {frames: 40, idsPerCall: 40, styles: 150};
export const figmaToken = () => String(process.env.FIGMA_TOKEN || '').trim();
const fail = (message, status = 400) => Object.assign(Error(message), {status});

export function parseFigmaUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (!/(^|\.)figma\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/(?:file|design|board|proto|deck|slides)\/([A-Za-z0-9]+)(?:\/[^/]*)?(?:\/branch\/([A-Za-z0-9]+))?/);
  if (!m) return null;
  const branch = u.pathname.match(/\/branch\/([A-Za-z0-9]+)/)?.[1];
  const node = u.searchParams.get('node-id');
  return {key: branch || m[1], nodeId: node ? node.replace(/-/g, ':') : null, url: u.href};
}

// Two links to the same Figma file (another page, frame or tracking parameter) are the same file.
export const sameFigmaFile = (a, b) => {
  const x = parseFigmaUrl(a), y = parseFigmaUrl(b);
  return Boolean(x && y && x.key === y.key);
};

// Figma links in a questionnaire's answers for one scope (null: a brand account; 'c1'…: an agency client).
export function figmaLinksIn(answers = {}, scope = null) {
  const found = new Set();
  const walk = v => {
    if (typeof v === 'string') for (const m of v.matchAll(/https?:\/\/(?:www\.)?figma\.com\/[^\s"'<>)]+/gi)) { if (parseFigmaUrl(m[0])) found.add(m[0]); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const [key, value] of Object.entries(answers || {})) {
    const own = scope ? key.startsWith(scope + ':') : !/^c[\w-]*:/.test(key);
    if (own) walk(value);
  }
  // One link per file: a read takes the whole file (or the part linked first), and a second read of it replaces the first.
  const keys = new Set();
  return [...found].filter(url => { const k = parseFigmaUrl(url).key; return !keys.has(k) && keys.add(k); });
}

function waitText(seconds) {
  if (!seconds) return 'a while';
  if (seconds >= 86400) return Math.round(seconds / 86400) + ' d';
  if (seconds >= 3600) return Math.round(seconds / 3600) + ' h';
  return Math.max(1, Math.round(seconds / 60)) + ' min';
}

async function api(path, {token, fetchImpl}) {
  const res = await fetchImpl(API + path, {headers: {'X-Figma-Token': token}});
  if (res.ok) return res.json();
  const body = await res.json().catch(() => ({}));
  const said = String(body.err || body.message || '');
  if (res.status === 429) {
    const tier = res.headers.get('x-figma-plan-tier');
    const type = res.headers.get('x-figma-rate-limit-type');
    const wait = waitText(Number(res.headers.get('retry-after')) || 0);
    if (tier === 'starter' || tier === 'student') throw fail(`This file is in a free Figma team, where Figma allows only a few reads a month (next one in ${wait}). Duplicate the file into the studio's paid team and paste the new link.`, 429);
    if (type === 'low') throw fail(`The studio's Figma account has a Viewer or Collab seat, which Figma limits to a few reads a month (next one in ${wait}). Use a token from an account with a Dev or Full seat.`, 429);
    throw fail(`Figma asks to wait ${wait} before the next read.`, 429);
  }
  if (res.status === 403 && /token/i.test(said)) throw fail('Figma refused the token: check FIGMA_TOKEN in .env.', 502);
  if (res.status === 403 || res.status === 404) throw fail("Figma can't open this file for the studio's account. Ask the client to share it with that account (can view), or check the link.", 404);
  throw fail('Figma replied ' + res.status + (said ? ': ' + said : '.'), 502);
}

let meCache = null;
export async function figmaStatus({token = figmaToken(), fetchImpl = fetch} = {}) {
  if (!token) return {configured: false, account: null};
  if (meCache?.token === token && Date.now() - meCache.at < 600000) return meCache.value;
  let value;
  try {
    const me = await api('/me', {token, fetchImpl});
    value = {configured: true, account: me.email || me.handle || null};
  } catch (err) {
    value = {configured: true, account: null, error: err.message};
  }
  meCache = {token, at: Date.now(), value};
  return value;
}

export const safeSegment = (s, fallback = 'untitled') =>
  String(s || '').replace(/[\\/:*?"<>|\0-\x1f]+/g, '-').replace(/\s+/g, ' ').replace(/^[.\s-]+|[.\s]+$/g, '').slice(0, 80) || fallback;

const RENDER = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'SECTION', 'GROUP', 'INSTANCE']);
const hex = c => '#' + [c.r, c.g, c.b].map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');

// What a style node holds, as plain values.
function styleValue(meta, node) {
  const out = {name: meta.name, ...(meta.description ? {description: meta.description} : {})};
  if (meta.styleType === 'FILL') {
    const fills = (node?.fills || []).filter(f => f.visible !== false);
    out.fills = fills.map(f => f.type === 'SOLID'
      ? {color: hex(f.color), ...((f.opacity ?? 1) * (f.color?.a ?? 1) < 1 ? {opacity: Math.round((f.opacity ?? 1) * (f.color?.a ?? 1) * 100) / 100} : {})}
      : {type: f.type.toLowerCase().replace('gradient_', 'gradient '), stops: (f.gradientStops || []).map(s => hex(s.color))});
  } else if (meta.styleType === 'TEXT') {
    const s = node?.style || {};
    Object.assign(out, {fontFamily: s.fontFamily, fontWeight: s.fontWeight, fontSize: s.fontSize,
      ...(s.lineHeightPx ? {lineHeight: Math.round(s.lineHeightPx * 100) / 100} : {}),
      ...(s.letterSpacing ? {letterSpacing: Math.round(s.letterSpacing * 100) / 100} : {}),
      ...(s.textCase && s.textCase !== 'ORIGINAL' ? {textCase: s.textCase.toLowerCase()} : {}), ...(s.italic ? {italic: true} : {})});
  } else if (meta.styleType === 'EFFECT') {
    out.effects = (node?.effects || []).filter(e => e.visible !== false).map(e => ({type: e.type.toLowerCase(), ...(e.color ? {color: hex(e.color)} : {}), ...(e.radius ? {radius: e.radius} : {}), ...(e.offset ? {offset: e.offset} : {})}));
  } else if (meta.styleType === 'GRID') {
    out.grids = node?.layoutGrids || [];
  }
  return out;
}

function scaleFor(node) {
  const b = node.absoluteBoundingBox;
  const side = b ? Math.max(b.width, b.height) : 1000;
  return side > 4000 ? 0.5 : side < 800 ? 2 : 1;
}

export async function readFigma(url, {token = figmaToken(), fetchImpl = fetch, limits = FIGMA_LIMITS, log = () => {}} = {}) {
  if (!token) throw fail('Add FIGMA_TOKEN to .env: a personal access token (scope file_content:read) from the studio\'s Figma account with a Dev or Full seat on a paid plan.', 400);
  const ref = parseFigmaUrl(url);
  if (!ref) throw fail('This is not a link to a Figma file.');
  const call = path => api(path, {token, fetchImpl});

  // 1. The file down to the top-level frames of each page (or of the page or frame the link points at).
  let fileName, styles = {}, pages = [];
  if (ref.nodeId) {
    const data = await call(`/files/${ref.key}/nodes?ids=${encodeURIComponent(ref.nodeId)}&depth=2`);
    const entry = data.nodes?.[ref.nodeId];
    if (!entry?.document) throw fail('The part of the file this link points at was not found. Copy the link again in Figma.', 404);
    fileName = data.name;
    styles = entry.styles || {};
    const doc = entry.document;
    pages = doc.type === 'CANVAS' ? [doc] : [{name: 'Selection', children: [doc]}];
  } else {
    const data = await call(`/files/${ref.key}?depth=2`);
    fileName = data.name;
    styles = data.styles || {};
    pages = data.document?.children || [];
  }
  const folder = 'figma/' + safeSegment(fileName, ref.key);
  const frames = [];
  for (const page of pages) {
    for (const node of page.children || []) if (RENDER.has(node.type) && node.visible !== false) frames.push({node, page: page.name});
  }
  const skipped = frames.slice(limits.frames).map(f => ({name: `${f.page} / ${f.node.name}`, reason: `more than ${limits.frames} frames in one read; link a page or a frame to read the rest`}));
  const chosen = frames.slice(0, limits.frames);
  log(`Figma “${fileName}”: ${chosen.length} frames, ${Object.keys(styles).length} styles`);

  // 2. Style values (colours, type, effects) from their own nodes.
  const files = [];
  const styleIds = Object.keys(styles).slice(0, limits.styles);
  if (styleIds.length) {
    const data = await call(`/files/${ref.key}/nodes?ids=${encodeURIComponent(styleIds.join(','))}`);
    const out = {source: ref.url, file: fileName, colours: [], text: [], effects: [], grids: []};
    const into = {FILL: 'colours', TEXT: 'text', EFFECT: 'effects', GRID: 'grids'};
    for (const id of styleIds) {
      const meta = styles[id];
      if (!into[meta?.styleType]) continue;
      out[into[meta.styleType]].push(styleValue(meta, data.nodes?.[id]?.document));
    }
    for (const k of Object.keys(into).map(t => into[t])) out[k].sort((a, b) => a.name.localeCompare(b.name));
    files.push({name: folder + '/styles.json', bytes: Buffer.from(JSON.stringify(out, null, 2) + '\n', 'utf8')});
  }

  // 3. The frames as PNG: one call per scale (small frames sharper, huge ones smaller), then plain downloads.
  const byScale = new Map();
  for (const f of chosen) { const s = scaleFor(f.node); byScale.set(s, [...(byScale.get(s) || []), f]); }
  const used = new Set();
  for (const [scale, group] of byScale) {
    for (let i = 0; i < group.length; i += limits.idsPerCall) {
      const part = group.slice(i, i + limits.idsPerCall);
      const data = await call(`/images/${ref.key}?ids=${encodeURIComponent(part.map(f => f.node.id).join(','))}&format=png&scale=${scale}`);
      for (const f of part) {
        const label = `${f.page} / ${f.node.name}`;
        const src = data.images?.[f.node.id];
        if (!src) { skipped.push({name: label, reason: 'Figma could not render it (empty or hidden)'}); continue; }
        const res = await fetchImpl(src);
        if (!res.ok) { skipped.push({name: label, reason: 'the picture could not be downloaded'}); continue; }
        let name = `${folder}/${safeSegment(f.page, 'Page')}/${safeSegment(f.node.name, 'Frame')}`;
        for (let n = 2; used.has(name.toLowerCase()); n++) name = `${folder}/${safeSegment(f.page, 'Page')}/${safeSegment(f.node.name, 'Frame')} (${n})`;
        used.add(name.toLowerCase());
        files.push({name: name + '.png', bytes: Buffer.from(await res.arrayBuffer())});
      }
    }
  }
  return {key: ref.key, url: ref.url, fileName, folder, files, frames: files.filter(f => f.name.endsWith('.png')).length, styles: styleIds.length, skipped};
}
