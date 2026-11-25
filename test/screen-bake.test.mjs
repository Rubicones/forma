import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import http from 'node:http';
import {findChrome, closeRenderer, browser, openFrame} from '../render.mjs';
import {inject} from '../motion.mjs';
import {readFrames, pointInQuad} from '../screen-track.mjs';
import {bakeScreens, trackSheet, ensureTrack} from '../screen-bake.mjs';
import {decodePng} from '../png.mjs';
import {makeClip, lerpQuad} from './helpers/synthetic-clip.mjs';

const chrome = findChrome();

// A creative with one clip of a phone-like green screen that drifts, and an interface whose bar grows with time.
const page = `<!doctype html><html><head><style>
  body{margin:0;background:#000}
  .scene{position:absolute;inset:0;opacity:0}   /* a parent that is invisible at the bake's moments must not hide it */
  #v{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
  #ui{position:absolute;left:0;top:0;width:320px;height:200px;background:rgb(230,40,40)}
  #bar{position:absolute;left:0;bottom:0;height:60px;background:#fff}
</style></head><body>
  <div class="scene"><video id="v" src="plate.mp4" muted playsinline></video>
  <div id="ui" data-forma-screen data-size="320x200"><div id="bar"></div></div></div>
  <script>
    const v = document.getElementById('v'), ui = document.getElementById('ui'), bar = document.getElementById('bar');
    FORMA.setup(async () => { await FORMA.screen(v, ui); });
    window.renderFrame = t => { FORMA.syncVideo(v, t); bar.style.width = Math.round(t / 2 * 320) + 'px'; };
  </script>
</body></html>`;

const A = [[200, 90], [440, 100], [430, 260], [210, 250]];
const B = [[230, 80], [470, 95], [455, 255], [240, 245]];

test('bake: the interface lands inside the moving green screen, no green is left, the bake is cached', {skip: !chrome && 'no Chrome here', timeout: 240000}, async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'forma-bake-test-'));
  try {
    const truth = await makeClip(path.join(dir, 'plate.mp4'), {frames: 48, scene: t => ({quad: lerpQuad(A, B, t / 2)})});
    await fs.writeFile(path.join(dir, 'r1.html'), inject(page, {stage: 'final', kind: 'single', formats: ['16x9'], langs: ['en'], duration: 2}));
    const url = pathToFileURL(path.join(dir, 'r1.html')).href;
    const logs = [];
    const first = await bakeScreens({projectDir: dir, url, rev: 'r1', langs: ['en'], format: '16x9', log: m => logs.push(m)});
    assert.deepEqual(first.problems, []);
    assert.equal(first.screens.length, 1);
    const {file} = first.screens[0];
    assert.match(file, /^assets\/screens\/[0-9a-f]{16}\.mp4$/);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'assets/screens/r1.json'), 'utf8'));
    assert.deepEqual(manifest.clips, {'plate.mp4': {en: file}});

    // Look at the baked clip at the source size: red interface inside the screen, the white bar growing, room outside.
    const W = 640, H = 360, frames = [];
    await readFrames(path.join(dir, file), {width: W, height: H, onFrame: (rgb, i) => { if (i === 6 || i === 42) frames[i] = rgb; }});
    for (const i of [6, 42]) {
      const q = truth[i], rgb = frames[i];
      let inside = 0, red = 0, green = 0, white = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 3, [r, g, b] = [rgb[o], rgb[o + 1], rgb[o + 2]];
        if (g > 150 && g > r * 1.6 && g > b * 1.6) green++;
        // inset by 4 px: the edge itself is blended
        const c = [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2];
        const shrunk = q.map(([px, py]) => [px + (c[0] - px) * 0.04, py + (c[1] - py) * 0.04]);
        if (!pointInQuad(shrunk, x + 0.5, y + 0.5)) continue;
        inside++;
        if (r > 170 && g < 90 && b < 90) red++;
        if (r > 200 && g > 200 && b > 200) white++;
      }
      assert.ok(green < 30, `frame ${i}: ${green} green pixels left`);
      assert.ok((red + white) / inside > 0.9, `frame ${i}: the interface covers the screen (${red + white}/${inside})`);
      if (i === 6) assert.ok(white / inside < 0.06, 'early on the bar is short');
      else assert.ok(white / inside > 0.18, 'later the bar is long: the interface was drawn per frame');
    }

    const again = await bakeScreens({projectDir: dir, url, rev: 'r1', langs: ['en'], format: '16x9'});
    assert.equal(again.screens[0].cached, true);
    assert.equal(again.screens[0].file, file);

    // The runtime plays the bake; without the manifest it pins the interface live over the track.
    const server = http.createServer(async (req, res) => {
      try { const body = await fs.readFile(path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname))); res.writeHead(200, {'access-control-allow-origin': '*'}); res.end(body); }
      catch { res.writeHead(404); res.end(); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const modeOf = async () => {
      const tab = await (await browser()).newPage();
      try {
        await openFrame(tab, `http://127.0.0.1:${server.address().port}/r1.html?f=16x9&l=en&paused=1`);
        return await tab.evaluate(() => ({mode: FORMA.screens[0]?.mode, src: document.getElementById('v').getAttribute('src'), ui: getComputedStyle(document.getElementById('ui')).display}));
      } finally { await tab.close(); }
    };
    try {
      assert.deepEqual(await modeOf(), {mode: 'baked', src: file, ui: 'none'});
      await fs.rm(path.join(dir, 'assets/screens/r1.json'));
      assert.equal((await modeOf()).mode, 'live');
    } finally { server.close(); }

    // the contact sheet for the model: a PNG of six frames with the corners drawn
    const track = await ensureTrack(path.join(dir, 'plate.mp4'));
    const times = await trackSheet(path.join(dir, 'plate.mp4'), track, path.join(dir, 'sheet.png'));
    assert.equal(times.length, 6);
    const sheet = decodePng(await fs.readFile(path.join(dir, 'sheet.png')));
    assert.ok(sheet.width > 1000 && sheet.height > 300);
  } finally {
    await closeRenderer();
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('bake: a creative without FORMA.screen costs nothing; a clip without a screen is a problem, not a crash', {skip: !chrome && 'no Chrome here', timeout: 120000}, async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'forma-bake-test-'));
  try {
    await fs.writeFile(path.join(dir, 'r1.html'), '<html><body>plain</body></html>');
    assert.deepEqual(await bakeScreens({projectDir: dir, url: 'about:blank', rev: 'r1', langs: ['en'], format: '1x1'}), {screens: [], problems: []});

    await makeClip(path.join(dir, 'plate.mp4'), {frames: 12, scene: () => ({quad: null})});
    await fs.writeFile(path.join(dir, 'r2.html'), inject(page, {stage: 'final', kind: 'single', formats: ['16x9'], langs: ['en'], duration: 2}));
    const r = await bakeScreens({projectDir: dir, url: pathToFileURL(path.join(dir, 'r2.html')).href, rev: 'r2', langs: ['en'], format: '16x9'});
    assert.equal(r.screens.length, 0);
    assert.match(r.problems.join(' '), /no green screen/);
  } finally {
    await closeRenderer();
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('track_screen: tracks a clip in the materials folder, writes the track and the contact sheet, refuses files outside', {timeout: 120000}, async () => {
  const {mediaSession} = await import('../media.mjs');
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'forma-track-tool-'));
  try {
    await fs.mkdir(path.join(dir, 'generated'));
    await makeClip(path.join(dir, 'generated/phone.mp4'), {frames: 24, scene: t => ({quad: lerpQuad(A, B, t)})});
    const logs = [];
    const session = mediaSession({dir, log: (m, x) => logs.push([m, x?.level])});
    const r = await session.track({clip: 'generated/phone.mp4'});
    assert.equal(r.found, true);
    assert.deepEqual(r.size, [640, 360]);
    assert.equal(r.sheet, 'generated/phone.track.png');
    assert.match(r.next, /magenta/);
    assert.ok((await fs.stat(path.join(dir, 'generated/phone.track.json'))).size > 1000);
    assert.ok((await fs.stat(path.join(dir, 'generated/phone.track.png'))).size > 1000);
    const hinted = await session.track({clip: 'generated/phone.mp4', hints: [{t: 0.5, corners: [[210, 80], [450, 95], [440, 255], [220, 250]]}]});
    assert.equal(hinted.found, true);
    // a clip made from a still: the still's screen is the first frame's hint
    const {encodePng} = await import('../png.mjs');
    const still = new Uint8Array(640 * 360 * 3).fill(80);
    for (let y = 0; y < 360; y++) for (let x = 0; x < 640; x++) if (pointInQuad(A, x + 0.5, y + 0.5)) still.set([20, 235, 30], (y * 640 + x) * 3);
    await fs.writeFile(path.join(dir, 'generated/still.png'), encodePng(still, 640, 360, 3));
    logs.length = 0;
    assert.equal((await session.track({clip: 'generated/phone.mp4'}, {firstFrame: 'generated/still.png'})).found, true);
    assert.ok(logs.some(([m]) => /1 hint/.test(m)), 'the still gave the first frame\'s corners');
    // and the last frame's still gives the corners at the end
    const last = new Uint8Array(640 * 360 * 3).fill(80);
    for (let y = 0; y < 360; y++) for (let x = 0; x < 640; x++) if (pointInQuad(B, x + 0.5, y + 0.5)) last.set([20, 235, 30], (y * 640 + x) * 3);
    await fs.writeFile(path.join(dir, 'generated/last.png'), encodePng(last, 640, 360, 3));
    logs.length = 0;
    assert.equal((await session.track({clip: 'generated/phone.mp4'}, {firstFrame: 'generated/still.png', lastFrame: 'generated/last.png'})).found, true);
    assert.ok(logs.some(([m]) => /2 hints/.test(m)), 'first and last frame corners');
    await assert.rejects(session.track({clip: '../outside.mp4'}), /inside the materials folder/);
    await assert.rejects(session.track({clip: 'generated/phone.mp4', hints: [{t: 0, corners: [[1, 2], [3, 4]]}]}));
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('bake: the surface a creative asks for reaches the bake (print or screen)', {skip: !chrome && 'no Chrome here', timeout: 120000}, async () => {
  const {listScreens} = await import('../screen-bake.mjs');
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'forma-bake-test-'));
  try {
    const printPage = page.replace('await FORMA.screen(v, ui);', "await FORMA.screen(v, ui, {surface: 'print'});");
    assert.notEqual(printPage, page);
    await fs.writeFile(path.join(dir, 'r1.html'), inject(printPage, {stage: 'final', kind: 'single', formats: ['16x9'], langs: ['en'], duration: 2}));
    const list = await listScreens({url: pathToFileURL(path.join(dir, 'r1.html')).href, format: '16x9', lang: 'en'});
    assert.deepEqual(list.map(s => [s.clip, s.surface]), [['plate.mp4', 'print']]);
  } finally {
    await closeRenderer();
    await fs.rm(dir, {recursive: true, force: true});
  }
});
