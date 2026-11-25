import test from 'node:test';
import assert from 'node:assert/strict';
import {compositeFrame, surroundColour} from '../screen-composite.mjs';
import {pointInQuad} from '../screen-track.mjs';

// A sheet of paper with a green imprint on it, and an interface that is clear except a dark bar of "ink".
function scene() {
  const w = 160, h = 100, plate = new Uint8Array(w * h * 3);
  const quad = [[40, 30], [120, 32], [118, 70], [42, 68]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = pointInQuad(quad, x + 0.5, y + 0.5);
    plate.set(inside ? [40, 215, 50] : [232, 226, 214], (y * w + x) * 3);
  }
  const uw = 80, uh = 40, ui = new Uint8Array(uw * uh * 4);
  for (let y = 15; y < 25; y++) for (let x = 10; x < 70; x++) ui.set([20, 24, 60, 255], (y * uw + x) * 4);
  return {w, h, plate, quad, uw, uh, ui};
}
const at = (s, x, y) => Array.from(s.plate.subarray((y * s.w + x) * 3, (y * s.w + x) * 3 + 3));

test('print surface: clear parts take the paper around the imprint, the interface lands as ink, no green left', () => {
  const s = scene();
  assert.deepEqual(surroundColour(s.plate, s.w, s.h, s.quad), [232, 226, 214]);
  const r = compositeFrame({plate: s.plate, w: s.w, h: s.h, ui: s.ui, uw: s.uw, uh: s.uh, quads: [s.quad], key: [40, 215, 50], surface: 'print'});
  assert.equal(r.greenLeft, 0);
  const clear = at(s, 60, 36), ink = at(s, 80, 50);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(clear[c] - [232, 226, 214][c]) < 18, 'paper where the interface is clear: ' + clear);
  assert.ok(ink[0] < 60 && ink[2] < 90 && ink[2] > ink[0], 'ink where it is drawn: ' + ink);
});

test('screen surface keeps the dark glass where the interface is clear', () => {
  const s = scene();
  compositeFrame({plate: s.plate, w: s.w, h: s.h, ui: s.ui, uw: s.uw, uh: s.uh, quads: [s.quad], key: [40, 215, 50]});
  const clear = at(s, 60, 36);
  assert.ok(Math.max(...clear) < 40, 'a dark screen: ' + clear);
});
