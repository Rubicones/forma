// The bake's heavy part, off the server's main thread: decodes the plate at output size, composites every frame with
// the interface frames the capture wrote, encodes the result with ffmpeg. Messages: {type:'progress', done, total},
// then {type:'done', stats} or {type:'error', message}.
import {parentPort, workerData} from 'node:worker_threads';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {decodePng} from './png.mjs';
import {compositeFrame, between} from './screen-composite.mjs';

const {plate, out, w, h, fps, frames, key, uiDir, uiIndex, ffmpeg, crf = 17} = workerData;

async function run() {
  const size = w * h * 3;
  const tmp = out + '.part.mp4';
  const enc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-r', String(fps), '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp], {stdio: ['pipe', 'ignore', 'pipe']});
  const dec = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', plate, '-vf', `scale=${w}:${h}:flags=lanczos`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {stdio: ['ignore', 'pipe', 'pipe']});
  let encErr = '', decErr = '';
  enc.stderr.on('data', c => { encErr += c; });
  dec.stderr.on('data', c => { decErr += c; });
  enc.stdin.on('error', () => {});
  const encDone = new Promise((res, rej) => { enc.on('error', rej); enc.on('close', c => (c === 0 ? res() : rej(Error('ffmpeg could not encode the bake: ' + encErr.trim().slice(-300))))); });
  const decDone = new Promise((res, rej) => { dec.on('error', rej); dec.on('close', c => (c === 0 ? res() : rej(Error('ffmpeg could not read the clip: ' + decErr.trim().slice(-300))))); });
  let buf = Buffer.alloc(0), index = 0, cachedFile = null, cachedUi = null;
  const stats = {frames: 0, screenPx: 0, greenLeft: 0, worst: {t: 0, frac: 0}};
  const uiFor = i => {
    const file = uiIndex[Math.min(i, uiIndex.length - 1)];
    if (file !== cachedFile) { cachedUi = decodePng(fs.readFileSync(path.join(uiDir, file))); cachedFile = file; }
    return cachedUi;
  };
  const composeOne = frame => {
    const f = frames[Math.min(index, frames.length - 1)];
    if (f?.q) {
      const prev = frames[index - 1]?.q, next = frames[index + 1]?.q;
      const moved = Math.max(prev ? f.q.reduce((s, p, k) => s + Math.hypot(p[0] - prev[k][0], p[1] - prev[k][1]), 0) / 4 : 0,
        next ? f.q.reduce((s, p, k) => s + Math.hypot(p[0] - next[k][0], p[1] - next[k][1]), 0) / 4 : 0);
      const quads = [f.q];
      if (moved > 2.5) {   // a fast screen smears: the interface at ±⅓ of a frame too
        if (prev) quads.push(between(f.q, prev, 1 / 3));
        if (next) quads.push(between(f.q, next, 1 / 3));
      }
      const ui = uiFor(index);
      const r = compositeFrame({plate: frame, w, h, ui: ui.data, uw: ui.width, uh: ui.height, quads, key, v: f.v});
      stats.screenPx += r.screenPx; stats.greenLeft += r.greenLeft;
      const frac = r.screenPx ? r.greenLeft / r.screenPx : 0;
      if (f.v > 0.5 && frac > stats.worst.frac) stats.worst = {t: Math.round(index / fps * 100) / 100, frac: Math.round(frac * 1000) / 1000};
    }
    stats.frames++;
    index++;
    if (index % 12 === 0) parentPort.postMessage({type: 'progress', done: index, total: frames.length});
  };
  await new Promise((resolve, reject) => {
    dec.stdout.on('data', chunk => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= size) {
        const frame = new Uint8Array(buf.subarray(0, size));
        buf = buf.subarray(size);
        try { composeOne(frame); } catch (e) { dec.kill('SIGKILL'); return reject(e); }
        if (!enc.stdin.write(frame)) {
          dec.stdout.pause();
          enc.stdin.once('drain', () => dec.stdout.resume());
        }
      }
    });
    dec.stdout.on('end', resolve);
    dec.on('error', reject);
    enc.on('close', c => { if (c !== 0) reject(Error('ffmpeg could not encode the bake: ' + encErr.trim().slice(-300))); });
  });
  await decDone;
  enc.stdin.end();
  await encDone;
  fs.renameSync(tmp, out);
  return stats;
}

run().then(stats => parentPort.postMessage({type: 'done', stats}), err => parentPort.postMessage({type: 'error', message: err.message}));
