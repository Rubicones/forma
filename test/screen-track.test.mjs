import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {trackScreen, quadAt, probeVideo, orderQuad, trackSummary} from '../screen-track.mjs';
import {encodePng, decodePng} from '../png.mjs';
import {makeClip, lerpQuad} from './helpers/synthetic-clip.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-track-'));
const err = (a, b) => a.reduce((s, p, i) => s + Math.hypot(p[0] - b[i][0], p[1] - b[i][1]), 0) / 4;
const A = [[200, 80], [470, 95], [455, 260], [190, 250]];
const B = [[230, 70], [520, 120], [500, 290], [215, 265]];

function stats(track, truth) {
  const errors = truth.map((q, i) => (q && track.frames[i].q ? err(track.frames[i].q, q) : null)).filter(e => e !== null);
  return {mean: errors.reduce((s, e) => s + e, 0) / errors.length, max: Math.max(...errors)};
}

test('png: what is written reads back the same', () => {
  const px = new Uint8Array(5 * 3 * 4).map((_, i) => (i * 37) & 255);
  const back = decodePng(encodePng(px, 5, 3, 4));
  assert.deepEqual([back.width, back.height], [5, 3]);
  assert.deepEqual([...back.data], [...px]);
});

test('track: a moving screen with shading and an H.264 encode, corners within a couple of pixels', async () => {
  const file = path.join(tmp, 'move.mp4');
  const truth = await makeClip(file, {scene: t => ({quad: lerpQuad(A, B, t / 2), shade: 0.35})});
  const info = await probeVideo(file);
  assert.deepEqual([info.width, info.height, Math.round(info.fps)], [640, 360, 24]);
  const track = await trackScreen(file);
  const s = stats(track, truth);
  assert.ok(track.found);
  assert.ok(s.mean < 2 && s.max < 4.5, JSON.stringify(s));
  assert.ok(track.frames.every(f => f.v > 0.9));
  // between frames the corners are interpolated
  const mid = quadAt(track, 0.5 / 24);
  assert.ok(err(mid.q, lerpQuad(track.frames[0].q, track.frames[1].q, 0.5)) < 0.01);
});

test('track: a hand over a corner does not move that corner', async () => {
  const file = path.join(tmp, 'hand.mp4');
  const truth = await makeClip(file, {scene: t => ({quad: lerpQuad(A, B, t / 2), discs: [{x: 200 + t * 60, y: 90 + t * 20, r: 42, rgb: [196, 140, 118]}]})});
  const track = await trackScreen(file);
  const s = stats(track, truth);
  assert.ok(s.mean < 2.5 && s.max < 6, JSON.stringify(s));
});

test('track: a hand across the middle splits the screen in two; still one screen', async () => {
  const file = path.join(tmp, 'split.mp4');
  const truth = await makeClip(file, {scene: t => ({quad: A, discs: [{x: 330, y: 170, r: 30 + t * 30, rgb: [190, 135, 110]}, {x: 330, y: 120, r: 30, rgb: [190, 135, 110]}, {x: 330, y: 220, r: 30, rgb: [190, 135, 110]}]})});
  const s = stats(await trackScreen(file), truth);
  assert.ok(s.mean < 2.5, JSON.stringify(s));
});

test('track: another green thing in the room is ignored once the first frame says where the screen is', async () => {
  const file = path.join(tmp, 'plant.mp4');
  const plant = [[20, 20], [170, 20], [170, 340], [20, 340]];   // bigger than the screen
  const truth = await makeClip(file, {scene: t => ({quad: lerpQuad(A, B, t / 2), extra: [{quad: plant, rgb: [30, 200, 40]}]})});
  const unhinted = await trackScreen(file);
  assert.ok(stats(unhinted, truth).mean > 20, 'without a hint the bigger green wins');
  const hinted = await trackScreen(file, {hints: [{t: 0, quad: A}]});
  const s = stats(hinted, truth);
  assert.ok(s.mean < 2.5, JSON.stringify(s));
});

test('track: a cut to another shot is found and the second shot tracked on its own', async () => {
  const file = path.join(tmp, 'cut.mp4');
  const other = [[60, 40], [300, 60], [290, 200], [50, 190]];
  const truth = await makeClip(file, {scene: (t, i) => (i < 24 ? {quad: A} : {quad: other, discs: [{x: 600, y: 300, r: 200, rgb: [40, 40, 120]}]})});
  const track = await trackScreen(file);
  assert.deepEqual(track.cuts, [1]);
  assert.ok(stats(track, truth).mean < 2.5);
  assert.match(track.warnings.join(' '), /cuts to another shot at 1 s/);
});

test('track: a lid closing fades the screen out; no screen at all is said plainly', async () => {
  const file = path.join(tmp, 'lid.mp4');
  await makeClip(file, {scene: t => {
    const k = Math.max(0, 1 - t / 1.6);   // the top edge comes down to the hinge
    if (k < 0.04) return {quad: null};
    return {quad: [[200, 250 - 170 * k], [470, 250 - 155 * k], [455, 260], [190, 250]]};
  }});
  const track = await trackScreen(file);
  assert.ok(track.frames[0].v > 0.9 && track.frames.at(-1).v < 0.1, `${track.frames[0].v} … ${track.frames.at(-1).v}`);
  const none = path.join(tmp, 'none.mp4');
  await makeClip(none, {frames: 12, scene: () => ({quad: null})});
  const empty = await trackScreen(none);
  assert.equal(empty.found, false);
  assert.match(trackSummary(empty).warnings.join(' '), /No green screen/);
});

test('track: a rough hint from a model for a hard frame is refined to the real edges', async () => {
  const file = path.join(tmp, 'rough.mp4');
  const truth = await makeClip(file, {frames: 12, scene: () => ({quad: A, discs: [{x: 205, y: 85, r: 60, rgb: [200, 150, 120]}, {x: 450, y: 255, r: 55, rgb: [200, 150, 120]}]})});
  const rough = A.map(([x, y], i) => [x + (i % 2 ? 9 : -8), y + (i < 2 ? -7 : 8)]);   // ~10 px off on every corner
  const track = await trackScreen(file, {hints: [{t: 0, quad: rough}]});
  assert.ok(err(track.frames[0].q, truth[0]) < 3, String(err(track.frames[0].q, truth[0])));
});

test('track: corner order is top-left first, clockwise', () => {
  assert.deepEqual(orderQuad([[10, 10], [0, 10], [0, 0], [10, 0]]), [[0, 0], [10, 0], [10, 10], [0, 10]]);
});
