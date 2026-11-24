// Screen tracking: where a flat chroma-green screen (#00FF00, as the video tools ask for) sits in every frame of a
// clip. One pass on this computer with ffmpeg; the result is saved next to the clip as <clip>.track.json and used to
// bake an interface into the clip (screen-bake.mjs) and to pin it live when no bake exists (FORMA.screen).
//
// Per frame: a green mask with a key colour adapted to the clip (models paint a shaded green, not #00FF00); the
// screen's region (the one the last frame had, or the hint); its convex hull cut to four sides; each side refitted
// as a straight line through the region's edge pixels, corners where the lines meet. A hand over a corner removes
// that corner's pixels but not the two sides, so the corner stays. Every frame gets a confidence.
// Over time: scene cuts split the clip; frames without a good fit take their corners from good neighbours; corners
// are smoothed both ways (no lag); visibility fades when the screen leaves or turns edge-on.
import {spawn} from 'node:child_process';
import {findFfmpeg} from './render.mjs';

const round1 = v => Math.round(v * 10) / 10;

// Size, frame rate and length from ffmpeg's own description of the file (no ffprobe in ffmpeg-static).
export async function probeVideo(file, {ffmpeg} = {}) {
  const bin = ffmpeg || await findFfmpeg();
  const text = await new Promise((resolve, reject) => {
    const p = spawn(bin, ['-hide_banner', '-i', file], {stdio: ['ignore', 'ignore', 'pipe']});
    let err = '';
    p.stderr.on('data', c => { err += c; });
    p.on('error', reject);
    p.on('close', () => resolve(err));
  });
  const v = /Stream #\S+.*Video:.*?(\d{2,5})x(\d{2,5})/.exec(text);
  if (!v) throw Object.assign(Error('Not a video ffmpeg can read: ' + (text.split('\n').find(l => /error|invalid/i.test(l)) || file).trim()), {status: 400});
  const fps = Number(/([\d.]+) fps/.exec(text)?.[1] || /([\d.]+) tbr/.exec(text)?.[1] || 24);
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(text);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
  return {width: Number(v[1]), height: Number(v[2]), fps, duration};
}

// Calls onFrame(rgb, index) for every frame, scaled to width (height keeps the aspect, even).
export async function readFrames(file, {width, height, ffmpeg, onFrame, scaleFilter = 'area'}) {
  const bin = ffmpeg || await findFfmpeg();
  const size = width * height * 3;
  await new Promise((resolve, reject) => {
    const p = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `scale=${width}:${height}:flags=${scaleFilter}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {stdio: ['ignore', 'pipe', 'pipe']});
    let err = '', buf = Buffer.alloc(0), index = 0, failed = null;
    p.stderr.on('data', c => { err += c; });
    p.stdout.on('data', chunk => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= size && !failed) {
        try { onFrame(new Uint8Array(buf.buffer, buf.byteOffset, size).slice(), index++); } catch (e) { failed = e; p.kill('SIGKILL'); }
        buf = buf.subarray(size);
      }
    });
    p.on('error', reject);
    p.on('close', code => failed ? reject(failed) : code === 0 ? resolve() : reject(Error('ffmpeg could not read the clip: ' + err.trim().slice(-300))));
  });
}

// ---------- geometry ----------
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
export function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
const triArea = (a, b, c) => Math.abs(cross(a, b, c)) / 2;
// The four sides of a hull: its four longest straight runs (a cut-off corner is many short edges, a side one long
// run), extended until they meet. Falls back to dropping vertices when the hull has no four clear runs.
function sidesOfHull(hull) {
  if (hull.length < 4) return null;
  const runs = [];
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const last = runs.at(-1);
    const turn = last ? Math.abs(((ang - last.ang + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) : Infinity;
    if (last && turn < 0.14) { last.b = b; last.len += len; last.ang = Math.atan2(b[1] - last.a[1], b[0] - last.a[0]); }
    else runs.push({a, b, len, ang, at: i});
  }
  if (runs.length > 1) {   // the last run may continue the first
    const first = runs[0], last = runs.at(-1);
    const turn = Math.abs(((first.ang - last.ang + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    if (turn < 0.14) { first.a = last.a; first.len += last.len; runs.pop(); }
  }
  if (runs.length < 4) return null;
  const four = runs.slice().sort((x, y) => y.len - x.len).slice(0, 4).sort((x, y) => x.at - y.at);
  const total = runs.reduce((s, r) => s + r.len, 0);
  if (four.reduce((s, r) => s + r.len, 0) < total * 0.55) return null;
  const line = r => ({cx: (r.a[0] + r.b[0]) / 2, cy: (r.a[1] + r.b[1]) / 2, dx: Math.cos(r.ang), dy: Math.sin(r.ang)});
  const q = [];
  for (let i = 0; i < 4; i++) q.push(intersect(line(four[(i + 3) % 4]), line(four[i])));
  return q.every(Boolean) && convex(q) ? q : null;
}
// Drops the vertex that adds the least area until four remain (Visvalingam).
function toFour(hull) {
  const h = hull.slice();
  while (h.length > 4) {
    let best = 0, min = Infinity;
    for (let i = 0; i < h.length; i++) { const a = triArea(h[(i - 1 + h.length) % h.length], h[i], h[(i + 1) % h.length]); if (a < min) { min = a; best = i; } }
    h.splice(best, 1);
  }
  return h;
}
export const polyArea = q => Math.abs(q.reduce((s, p, i) => s + p[0] * q[(i + 1) % q.length][1] - q[(i + 1) % q.length][0] * p[1], 0)) / 2;
// Top-left first, then clockwise on screen (tl, tr, br, bl).
export function orderQuad(q) {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const byAngle = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let start = 0;
  byAngle.forEach((p, i) => { if (p[0] + p[1] < byAngle[start][0] + byAngle[start][1]) start = i; });
  return [0, 1, 2, 3].map(i => byAngle[(start + i) % 4]);
}
function convex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
    if (Math.abs(c) < 1e-6) return false;
    if (sign && Math.sign(c) !== sign) return false;
    sign = Math.sign(c);
  }
  return true;
}
// Total least squares line through points: {cx, cy, dx, dy} (direction unit vector).
function fitLine(pts) {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= pts.length; cy /= pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { const x = p[0] - cx, y = p[1] - cy; sxx += x * x; sxy += x * y; syy += y * y; }
  const angle = Math.atan2(2 * sxy, sxx - syy) / 2;
  return {cx, cy, dx: Math.cos(angle), dy: Math.sin(angle)};
}
const lineDist = (l, p) => Math.abs((p[0] - l.cx) * l.dy - (p[1] - l.cy) * l.dx);
function intersect(a, b) {
  const det = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(det) < 1e-9) return null;
  const t = ((b.cx - a.cx) * b.dy - (b.cy - a.cy) * b.dx) / det;
  return [a.cx + a.dx * t, a.cy + a.dy * t];
}
export function pointInQuad(q, x, y) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = q[i], [xj, yj] = q[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function grow(q, by) {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  return q.map(([x, y]) => [cx + (x - cx) * by, cy + (y - cy) * by]);
}

// ---------- one frame ----------
const greenness = (r, g, b) => g - (r > b ? r : b);

// The key colour of a frame: the median of clearly green pixels (inside the hint when there is one).
export function keyColour(rgb, w, h, hint = null) {
  const rs = [], gs = [], bs = [];
  const step = Math.max(1, Math.floor(Math.sqrt(w * h / 6000)));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = (y * w + x) * 3, r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    if (g < 60 || greenness(r, g, b) < 50) continue;
    if (hint && !pointInQuad(hint, x, y)) continue;
    rs.push(r); gs.push(g); bs.push(b);
  }
  if (rs.length < 12) return null;
  const med = a => a.sort((x, y) => x - y)[a.length >> 1];
  return [med(rs), med(gs), med(bs)];
}

/**
 * Finds the screen in one frame. rgb: w×h×3. key: [r,g,b]. hint: a quad the screen is near (the last frame's, a
 * model's hint or the first frame's known corners) or null for "the biggest green region".
 * Returns {quad, conf, area, maskArea} in frame pixels, or null.
 */
export function findScreen(rgb, w, h, {key, hint = null, hintIsExact = false} = {}) {
  const kg = key ? Math.max(40, greenness(key[0], key[1], key[2])) : 120;
  const minG = key ? key[1] * 0.3 : 60;
  const thr = Math.max(24, kg * 0.42);
  const n = w * h;
  const mask = new Uint8Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 3) {
    const g = rgb[i + 1];
    if (g >= minG && greenness(rgb[i], g, rgb[i + 2]) >= thr) mask[p] = 1;
  }
  // Regions (4-connected), with their size and how much of each lies near the hint.
  const label = new Int32Array(n).fill(-1);
  const regions = [];
  const near = hint ? grow(hint, 1.18) : null;
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    const id = regions.length;
    let top = 0, size = 0, inHint = 0;
    stack[top++] = s; label[s] = id;
    while (top) {
      const p = stack[--top], x = p % w, y = (p - x) / w;
      size++;
      if (near && (size & 3) === 0 && pointInQuad(near, x, y)) inHint += 4;
      if (x > 0 && mask[p - 1] && label[p - 1] < 0) { label[p - 1] = id; stack[top++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && label[p + 1] < 0) { label[p + 1] = id; stack[top++] = p + 1; }
      if (y > 0 && mask[p - w] && label[p - w] < 0) { label[p - w] = id; stack[top++] = p - w; }
      if (y < h - 1 && mask[p + w] && label[p + w] < 0) { label[p + w] = id; stack[top++] = p + w; }
    }
    regions.push({size, inHint});
  }
  const minSize = Math.max(20, n * 0.0015);
  let chosen;
  if (near) {
    // Everything that mostly lies where the screen was: a hand across the middle splits it in two.
    chosen = new Set(regions.map((r, i) => (r.size >= 6 && r.inHint >= r.size * 0.5 ? i : -1)).filter(i => i >= 0));
  } else {
    let best = -1;
    regions.forEach((r, i) => { if (r.size >= minSize && (best < 0 || r.size > regions[best].size)) best = i; });
    chosen = new Set(best >= 0 ? [best] : []);
  }
  let maskArea = 0;
  for (const i of chosen) maskArea += regions[i].size;
  if (maskArea < minSize) return null;
  // Edge pixels of the chosen regions.
  const edge = [];
  const inSet = p => label[p] >= 0 && chosen.has(label[p]);
  for (let p = 0; p < n; p++) {
    if (!inSet(p)) continue;
    const x = p % w, y = (p - x) / w;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !inSet(p - 1) || !inSet(p + 1) || !inSet(p - w) || !inSet(p + w)) edge.push([x + 0.5, y + 0.5]);
  }
  if (edge.length < 12) return null;
  // Start from the hint (the last frame's corners, a model's or the first frame's), else from the hull's sides.
  const hull = convexHull(edge);
  let corners = hint ? orderQuad(hint) : orderQuad(sidesOfHull(hull) || toFour(hull));
  if (corners.length < 4) return null;
  // Refit each side through the edge pixels along it.
  const lines = [], support = [];
  for (let s = 0; s < 4; s++) {
    const a = corners[s], b = corners[(s + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    const along = p => ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy) / len;
    const tol = Math.max(1.6, len * (hint ? 0.07 : 0.03));
    let pts = edge.filter(p => { const t = along(p); return t > 0.06 && t < 0.94 && Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux) < tol; });
    let line = pts.length >= 6 ? fitLine(pts) : {cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, dx: ux, dy: uy};
    // Narrow in: take the edge pixels near the fitted line, not near the starting guess.
    for (let k = 0; k < 3 && pts.length >= 6; k++) {
      const band = Math.max(1.2, len * [0.03, 0.015, 0.01][k]);
      const next = edge.filter(p => { const t = along(p); return t > 0.04 && t < 0.96 && lineDist(line, p) < band; });
      if (next.length < 6) break;
      pts = next;
      line = fitLine(pts);
    }
    for (let k = 0; k < 2 && pts.length >= 10; k++) {   // trim what a hand or a reflection added
      const d = pts.map(p => lineDist(line, p));
      const sigma = Math.sqrt(d.reduce((s, v) => s + v * v, 0) / d.length) || 1;
      const kept = pts.filter((p, i) => d[i] <= Math.max(1, 2 * sigma));
      if (kept.length < 6) break;
      pts = kept;
      line = fitLine(pts);
    }
    lines.push(line);
    support.push(Math.min(1, pts.length / (len * 0.84 * 0.9)));
  }
  let quad = [];
  for (let s = 0; s < 4; s++) quad.push(intersect(lines[(s + 3) % 4], lines[s]));
  const margin = Math.max(w, h) * 0.6;
  const sane = quad.every(p => p && p[0] > -margin && p[0] < w + margin && p[1] > -margin && p[1] < h + margin) && convex(quad);
  if (!sane) { quad = corners; support.fill(0.3); }
  quad = orderQuad(quad);
  const area = polyArea(quad);
  const fill = Math.min(1, maskArea / Math.max(1, area));
  const conf = (support.reduce((s, v) => s + v, 0) / 4) * Math.min(1, fill / 0.35) * (sane ? 1 : 0.5);
  return {quad, conf: Math.max(0, Math.min(1, conf)), area, maskArea};
}

// ---------- the whole clip ----------
function cutScore(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}
function thumb(rgb, w, h, tw = 48, th = 27) {
  const out = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const i = (Math.floor((y + 0.5) * h / th) * w + Math.floor((x + 0.5) * w / tw)) * 3;
    out[y * tw + x] = (rgb[i] * 3 + rgb[i + 1] * 6 + rgb[i + 2]) / 10;
  }
  return out;
}
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Tracks the screen through a clip. hints: [{t, quad:[[x,y]×4] in source px}] — the first frame's known corners (from
 * the still the clip started from) or a model's rough corners for frames the tracker got wrong; each is the starting
 * point for that frame, refined to the real edges. Returns the track (see the file comment) without writing it.
 */
export async function trackScreen(file, {ffmpeg, hints = [], analysisWidth = 480, onFrame} = {}) {
  const info = await probeVideo(file, {ffmpeg});
  const aw = Math.min(analysisWidth, info.width) & ~1;
  const ah = Math.max(2, Math.round(info.height * aw / info.width / 2) * 2);
  const sx = info.width / aw, sy = info.height / ah;
  const toA = q => q.map(([x, y]) => [x / sx, y / sy]);
  const frames = [];
  const thumbs = [], diffs = [];
  let prev = null, key = null;
  const fps = info.fps || 24;
  const hintAt = new Map();
  for (const hnt of hints) if (Array.isArray(hnt?.quad) && hnt.quad.length === 4) hintAt.set(Math.max(0, Math.round((Number(hnt.t) || 0) * fps)), orderQuad(toA(hnt.quad)));
  await readFrames(file, {width: aw, height: ah, ffmpeg, onFrame: (rgb, i) => {
    thumbs.push(thumb(rgb, aw, ah));
    const given = hintAt.get(i) || null;
    // A cut: this frame differs from the last far more than frames have been differing.
    const diff = i > 0 ? cutScore(thumbs[i - 1], thumbs[i]) : 0;
    const usual = diffs.length ? diffs.slice(-12).sort((a, b) => a - b)[Math.min(diffs.length, 12) >> 1] : 0;
    const cut = i > 0 && diff > 10 && diff > usual * 5 + 3;
    if (i > 0) diffs.push(diff);
    if (cut) prev = null;
    const hint = given || prev;
    key = keyColour(rgb, aw, ah, hint) || key || keyColour(rgb, aw, ah);
    let found = key ? findScreen(rgb, aw, ah, {key, hint, hintIsExact: Boolean(given)}) : null;
    // Lost where it was: look again in the whole frame (it moved fast, or the last frame was wrong).
    if ((!found || found.conf < 0.35) && hint && !given) {
      const k2 = keyColour(rgb, aw, ah) || key;
      const again = k2 ? findScreen(rgb, aw, ah, {key: k2}) : null;
      if (again && again.conf > (found?.conf || 0)) { found = again; key = k2; }
    }
    // A tracked quad that jumped far from the last one is a wrong region: try again without the hint, keep the better.
    if (found && prev && !given) {
      const moved = found.quad.reduce((s, p, k) => s + Math.hypot(p[0] - prev[k][0], p[1] - prev[k][1]), 0) / 4;
      if (moved > Math.max(aw, ah) * 0.12) found = {...found, conf: found.conf * 0.4};
    }
    frames.push({quad: found?.quad || null, conf: found?.conf || 0, area: found?.area || 0, key, cut});
    if (found && found.conf >= 0.35) prev = found.quad;
    onFrame?.(i);
  }});
  if (!frames.length) throw Object.assign(Error('The clip has no frames.'), {status: 400});
  return finishTrack(frames, {info, sx, sy, aw, ah, fps});
}

// Gaps, smoothing, visibility; exported for tests with synthetic detections.
export function finishTrack(frames, {info, sx, sy, aw, ah, fps}) {
  const N = frames.length;
  const good = f => f.quad && f.conf >= 0.35;
  const minArea = aw * ah * 0.002;
  const cuts = [0];
  frames.forEach((f, i) => { if (i && f.cut) cuts.push(i); });
  const out = new Array(N);
  const low = [];
  const warnings = [];
  const maxGap = Math.round(fps * 0.6);
  for (let c = 0; c < cuts.length; c++) {
    const from = cuts[c], to = (cuts[c + 1] ?? N) - 1;
    const idx = [];
    for (let i = from; i <= to; i++) if (good(frames[i])) idx.push(i);
    if (!idx.length) { for (let i = from; i <= to; i++) out[i] = {q: null, v: 0, c: 0}; continue; }
    // Corners for every frame: the frame's own, or between the good neighbours.
    const q = new Array(to - from + 1), v = new Array(to - from + 1), w = new Array(to - from + 1);
    for (let i = from; i <= to; i++) {
      const k = i - from;
      if (good(frames[i])) { q[k] = frames[i].quad; v[k] = 1; w[k] = frames[i].conf; continue; }
      let a = -1, b = -1;
      for (let j = i - 1; j >= from; j--) if (good(frames[j])) { a = j; break; }
      for (let j = i + 1; j <= to; j++) if (good(frames[j])) { b = j; break; }
      const qa = a >= 0 ? frames[a].quad : null, qb = b >= 0 ? frames[b].quad : null;
      if (qa && qb) { const t = (i - a) / (b - a); q[k] = qa.map((p, n) => [p[0] + (qb[n][0] - p[0]) * t, p[1] + (qb[n][1] - p[1]) * t]); }
      else q[k] = (qa || qb).map(p => p.slice());
      const gap = (b >= 0 ? b : to + maxGap + 1) - (a >= 0 ? a : from - maxGap - 1);
      v[k] = gap <= maxGap ? 1 : 0;   // a short gap is a hand or a blur; a long one, or the clip's end, is the screen gone
      w[k] = 0.05;
    }
    // Smoothing both ways, weighted by confidence: no lag behind a moving screen.
    const sigma = Math.max(0.7, fps / 24);
    const R = Math.ceil(sigma * 2.5);
    for (let k = 0; k < q.length; k++) {
      const s = [[0, 0], [0, 0], [0, 0], [0, 0]];
      let ws = 0, vs = 0, vw = 0;
      for (let d = -R; d <= R; d++) {
        const j = k + d;
        if (j < 0 || j >= q.length) continue;
        const g = Math.exp(-(d * d) / (2 * sigma * sigma));
        const wt = g * w[j];
        for (let n = 0; n < 4; n++) { s[n][0] += q[j][n][0] * wt; s[n][1] += q[j][n][1] * wt; }
        ws += wt; vs += v[j] * g; vw += g;
      }
      const quad = s.map(([x, y]) => [x / ws, y / ws]);
      const area = polyArea(quad);
      const vis = (vs / vw) * smoothstep(minArea * 0.5, minArea * 3, area);
      const i = from + k;
      out[i] = {q: quad.map(([x, y]) => [round1(x * sx), round1(y * sy)]), v: Math.round(vis * 1000) / 1000, c: Math.round((frames[i].conf || 0) * 100) / 100};
    }
  }
  // Stretches of low confidence, for the model to look at.
  let start = -1;
  for (let i = 0; i <= N; i++) {
    const weak = i < N && out[i].v > 0.5 && frames[i].conf < 0.5;
    if (weak && start < 0) start = i;
    if (!weak && start >= 0) { if (i - start >= Math.max(2, Math.round(fps * 0.15))) low.push([round1(start / fps), round1((i - 1) / fps)]); start = -1; }
  }
  const seen = out.filter(f => f.v > 0.5).length;
  const found = seen >= Math.max(3, N * 0.2);
  const keys = frames.map(f => f.key).filter(Boolean);
  const key = keys.length ? [0, 1, 2].map(c => keys.map(k => k[c]).sort((a, b) => a - b)[keys.length >> 1]) : null;
  if (!found) warnings.push(N && keys.length ? 'No flat green screen was found in most of the clip.' : 'No green screen in the clip.');
  if (cuts.length > 1) warnings.push('The clip cuts to another shot at ' + cuts.slice(1).map(i => round1(i / fps) + ' s').join(', ') + '.');
  if (low.length) warnings.push('Unsure where the screen is at ' + low.map(([a, b]) => a === b ? a + ' s' : a + '–' + b + ' s').join(', ') + '.');
  if (key && greenness(key[0], key[1], key[2]) < 60) warnings.push(`The screen is not a clean green (key ${key.join(', ')}): the key will be soft.`);
  return {
    version: 1,
    source: {width: info.width, height: info.height, fps, frames: N, duration: info.duration || N / fps},
    key, found, cuts: cuts.slice(1).map(i => round1(i / fps)), low, warnings,
    frames: out,
  };
}

// The corners at clip time t (seconds), between frames; null where the screen is not seen.
export function quadAt(track, t) {
  const f = track.frames, fps = track.source.fps;
  const x = Math.max(0, Math.min(f.length - 1, t * fps));
  const i = Math.floor(x), j = Math.min(f.length - 1, i + 1), k = x - i;
  const a = f[i], b = f[j];
  if (!a.q && !b.q) return null;
  if (!a.q || !b.q || track.cuts?.some(c => Math.round(c * fps) === j)) { const s = k < 0.5 && a.q ? a : b.q ? b : a; return {q: s.q, v: s.v}; }
  return {q: a.q.map((p, n) => [p[0] + (b.q[n][0] - p[0]) * k, p[1] + (b.q[n][1] - p[1]) * k]), v: a.v + (b.v - a.v) * k};
}

// What the model reads after a track: found or not, how sure, where it is unsure, what to do.
export function trackSummary(track, {file} = {}) {
  const seen = track.frames.filter(f => f.v > 0.5);
  const mean = seen.length ? seen.reduce((s, f) => s + f.c, 0) / seen.length : 0;
  return {
    file, found: track.found,
    seen: Math.round(seen.length / track.frames.length * 100) + '% of frames',
    confidence: Math.round(mean * 100) / 100,
    unsure: track.low, cuts: track.cuts, warnings: track.warnings,
  };
}
