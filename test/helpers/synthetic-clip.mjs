// Synthetic clips with a chroma-green screen whose corners are known, for the tracker and bake tests.
import {spawn} from 'node:child_process';
import {findFfmpeg} from '../../render.mjs';
import {pointInQuad} from '../../screen-track.mjs';

// scene(t) → {quad: [[x,y]×4] | null, discs: [{x,y,r,rgb}], green: [r,g,b], shade: 0..1, extra: [{quad, rgb}]}
export async function makeClip(file, {width = 640, height = 360, fps = 24, frames = 48, scene, crf = 20}) {
  const bin = await findFfmpeg();
  const p = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', file], {stdio: ['pipe', 'ignore', 'pipe']});
  let err = '';
  p.stderr.on('data', c => { err += c; });
  const done = new Promise((res, rej) => { p.on('error', rej); p.on('close', c => (c === 0 ? res() : rej(Error(err)))); });
  const truth = [];
  for (let i = 0; i < frames; i++) {
    const t = i / fps, s = scene(t, i);
    truth.push(s.quad);
    const buf = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      // a warm room: gradient plus a little texture
      let r = 70 + x * 60 / width + ((x * 7 + y * 13) % 11), g = 60 + y * 40 / height + ((x * 5 + y * 3) % 9), b = 55 + ((x + y) % 7);
      for (const e of s.extra || []) if (pointInQuad(e.quad, x + 0.5, y + 0.5)) [r, g, b] = e.rgb;
      if (s.quad && pointInQuad(s.quad, x + 0.5, y + 0.5)) {
        const k = 1 - (s.shade || 0) * (x / width);   // light falls off across the screen
        const [gr, gg, gb] = s.green || [20, 235, 30];
        r = gr * k; g = gg * k; b = gb * k;
      }
      for (const d of s.discs || []) if ((x - d.x) ** 2 + (y - d.y) ** 2 < d.r * d.r) [r, g, b] = d.rgb;
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b;
    }
    if (!p.stdin.write(buf)) await new Promise(r => p.stdin.once('drain', r));
  }
  p.stdin.end();
  await done;
  return truth;
}

export const lerpQuad = (a, b, t) => a.map((p, i) => [p[0] + (b[i][0] - p[0]) * t, p[1] + (b[i][1] - p[1]) * t]);
