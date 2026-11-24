// Compositing one frame of a screen bake: the interface warped onto the tracked corners, shown only where the plate
// is screen-green (a hand or a cup in front stays in front), lit by the plate (shadows and reflections on the screen
// carry over), smeared with the screen when it moves fast, the green spill taken off edges. Pure functions on pixel
// buffers, used by the bake worker; exported for tests.

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// The projective map from the unit square to a quad (tl, tr, br, bl), and its inverse (Heckbert).
function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  return [a, b, c, d, e, f, g, h, 1];
}
function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
// Plate pixel → interface coordinates in 0..1 (u across, v down).
export function inverseMap(quad) {
  const inv = invert3(squareToQuad(quad));
  if (!inv) return null;
  return (x, y) => {
    const w = inv[6] * x + inv[7] * y + inv[8];
    return [(inv[0] * x + inv[1] * y + inv[2]) / w, (inv[3] * x + inv[4] * y + inv[5]) / w];
  };
}

function sample(ui, uw, uh, u, v, out) {
  // Bilinear, clamped to the edge: a track a pixel off shows the interface's edge, never green.
  const x = clamp01(u) * (uw - 1), y = clamp01(v) * (uh - 1);
  const x0 = x | 0, y0 = y | 0, x1 = Math.min(uw - 1, x0 + 1), y1 = Math.min(uh - 1, y0 + 1), fx = x - x0, fy = y - y0;
  const i00 = (y0 * uw + x0) * 4, i10 = (y0 * uw + x1) * 4, i01 = (y1 * uw + x0) * 4, i11 = (y1 * uw + x1) * 4;
  for (let c = 0; c < 4; c++) {
    const top = ui[i00 + c] + (ui[i10 + c] - ui[i00 + c]) * fx, bot = ui[i01 + c] + (ui[i11 + c] - ui[i01 + c]) * fx;
    out[c] = top + (bot - top) * fy;
  }
}

/**
 * Composites in place. plate: RGB w×h (the frame, at output size). ui: RGBA uw×uh (the interface frame).
 * quads: the corners at this frame (and, when it moves, at -⅓ and +⅓ of a frame, for the smear), in plate px.
 * key: the screen's green [r,g,b]. v: visibility 0..1. off: the colour of the screen where the interface is clear.
 * Returns {screenPx, greenLeft}: pixels of screen inside the quad, and how many still look screen-green after.
 */
export function compositeFrame({plate, w, h, ui, uw, uh, quads, key, v = 1, light = 0.65, off = [12, 12, 14]}) {
  const quad = quads[0];
  if (!quad || v <= 0.001) return {screenPx: 0, greenLeft: 0};
  const maps = quads.map(inverseMap).filter(Boolean);
  if (!maps.length) return {screenPx: 0, greenLeft: 0};
  const kg = Math.max(30, key[1] - Math.max(key[0], key[2]));
  const keyMinRB = Math.min(key[0], key[2]);
  const lo = kg * 0.22, hi = kg * 0.62;
  // Work only around the screen: the quad grown a little (edges, spill), clipped to the frame.
  const cx = quad.reduce((s, p) => s + p[0], 0) / 4, cy = quad.reduce((s, p) => s + p[1], 0) / 4;
  const grown = quad.map(([x, y]) => [cx + (x - cx) * 1.04, cy + (y - cy) * 1.04]);
  const xs = grown.map(p => p[0]), ys = grown.map(p => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 2), x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)) + 2);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 2), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)) + 2);
  if (x1 < x0 || y1 < y0) return {screenPx: 0, greenLeft: 0};
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const inside = (x, y) => {   // inside the grown quad
    let r = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const [xi, yi] = grown[i], [xj, yj] = grown[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) r = !r;
    }
    return r;
  };
  // 1. The key: how screen-green each pixel is, softened a little (video compression leaves blocky green edges).
  const raw = new Float32Array(bw * bh);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (!inside(x + 0.5, y + 0.5)) continue;
    const i = (y * w + x) * 3, r = plate[i], g = plate[i + 1], b = plate[i + 2];
    raw[(y - y0) * bw + (x - x0)] = smooth(lo, hi, g - (r > b ? r : b));
  }
  const alpha = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
      s += raw[yy * bw + xx]; n++;
    }
    alpha[y * bw + x] = s / n;
  }
  // 2. Composite.
  const px = [0, 0, 0, 0], acc = [0, 0, 0, 0];
  let screenPx = 0, greenLeft = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const a = alpha[(y - y0) * bw + (x - x0)] * v;
    const i = (y * w + x) * 3;
    let r = plate[i], g = plate[i + 1], b = plate[i + 2];
    const greenish = g - (r > b ? r : b);
    if (a <= 0.002) {
      // spill on what stands in front of the screen: a green rim on a hand
      if (greenish > 0 && inside(x + 0.5, y + 0.5)) plate[i + 1] = Math.max(r, b) + greenish * 0.25;
      continue;
    }
    screenPx++;
    // light: the plate's green against the key green (shadows), and what it holds besides green (reflections)
    const shade = Math.max(0.35, Math.min(1.5, g / Math.max(1, key[1])));
    const lit = 1 + (shade - 1) * light;
    const spec = Math.max(0, Math.min(r, b) - keyMinRB) * light;
    // the interface: averaged over the smear positions when the screen moves
    acc[0] = acc[1] = acc[2] = acc[3] = 0;
    for (const map of maps) {
      const [u, vv] = map(x + 0.5, y + 0.5);
      sample(ui, uw, uh, u, vv, px);
      for (let c = 0; c < 4; c++) acc[c] += px[c];
    }
    const ua = acc[3] / maps.length / 255;
    const ur = (acc[0] / maps.length) * ua + off[0] * (1 - ua), ug = (acc[1] / maps.length) * ua + off[1] * (1 - ua), ub = (acc[2] / maps.length) * ua + off[2] * (1 - ua);
    const sr = Math.min(255, ur * lit + spec), sg = Math.min(255, ug * lit + spec), sb = Math.min(255, ub * lit + spec);
    // the plate at the edges, without its green
    if (greenish > 0) g = Math.max(r, b) + greenish * 0.15;
    plate[i] = r * (1 - a) + sr * a;
    plate[i + 1] = g * (1 - a) + sg * a;
    plate[i + 2] = b * (1 - a) + sb * a;
    const left = plate[i + 1] - Math.max(plate[i], plate[i + 2]);
    if (left > kg * 0.5) greenLeft++;
  }
  return {screenPx, greenLeft};
}

// The corners between two frames, for the smear: k in 0..1 from a to b.
export const between = (a, b, k) => a.map((p, i) => [p[0] + (b[i][0] - p[0]) * k, p[1] + (b[i][1] - p[1]) * k]);
