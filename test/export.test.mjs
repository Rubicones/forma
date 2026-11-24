import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {existsSync} from 'node:fs';
import {expectedExports, todo, exportKey, exportDelivery, fileKey} from '../export.mjs';
import {findChrome, renderVideo, renderStill, renderSheets, closeRenderer} from '../render.mjs';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';

const PROJECT = 'abcdefab-1111-4222-8333-444455556666';

test('expected files: a video per format × language × length and a still per format × language', () => {
  const multi = expectedExports({kind: 'multi', formats: ['9x16', '1x1'], langs: ['en', 'de'], lengths: [10, 15]});
  assert.equal(multi.length, 2 * 2 * 3);
  assert.deepEqual(multi.slice(0, 3), [
    {format: '9x16', lang: 'en', length: 10, fileType: 'mp4'}, {format: '9x16', lang: 'en', length: 15, fileType: 'mp4'}, {format: '9x16', lang: 'en', length: 0, fileType: 'png'}]);
  assert.deepEqual(expectedExports({kind: 'poster', formats: ['4x5'], langs: [], lengths: [6]}), [{format: '4x5', lang: 'en', length: 0, fileType: 'png'}]);
  assert.equal(exportKey('d1', {format: '9x16', lang: 'en', length: 10, fileType: 'mp4'}), 'deliveries/d1/exports/9x16_en_10s.mp4');
  assert.equal(exportKey('d1', {format: '9x16', lang: 'en', length: 0, fileType: 'png'}), 'deliveries/d1/exports/9x16_en_still.png');
});

test('todo: missing and left-pending files, failed ones a couple of times, ready ones never', () => {
  const exp = expectedExports({kind: 'single', formats: ['1x1'], langs: ['en'], lengths: [6, 10]});
  const rows = [
    {format: '1x1', lang: 'en', length: 6, file_type: 'mp4', status: 'ready'},
    {format: '1x1', lang: 'en', length: 10, file_type: 'mp4', status: 'failed'},
  ];
  assert.deepEqual(todo(exp, rows).map(fileKey), ['1x1|en|10|mp4', '1x1|en|0|png']);
  assert.deepEqual(todo(exp, rows, {attempts: new Map([['1x1|en|10|mp4', 2]])}).map(fileKey), ['1x1|en|0|png']);
  assert.equal(todo(exp, rows, {all: true}).length, 3);
});

function fakeDb() {
  const rows = new Map();
  return {
    rows,
    from() {
      return {
        select: () => ({eq: async () => ({data: [...rows.values()], error: null})}),
        upsert: async list => { for (const r of [].concat(list)) rows.set(fileKey(r), {...rows.get(fileKey(r)), ...r}); return {error: null}; },
      };
    },
  };
}

test('export: pending rows first, then each file to R2 and ready; a failure marks it failed and the rest goes on', async () => {
  const db = fakeDb();
  const put = new Map();
  const blobs = {put: async (key, bytes) => { put.set(key, bytes); }};
  const seen = [];
  const render = {
    renderVideo: async a => { seen.push(['video', a.format, a.lang, a.length, a.url]); if (a.length === 15) throw Error('boom'); return {bytes: Buffer.from('mp4'), width: 1080, height: 1920}; },
    renderStill: async a => { seen.push(['still', a.format, a.lang, a.length]); return {bytes: Buffer.from('png'), width: 1080, height: 1920}; },
  };
  const delivery = {id: 'd1', items: {final: {title: 'Night Run', path: `/p/${PROJECT}/f.html`, kind: 'multi', formats: ['9x16'], langs: ['en'], lengths: [10, 15]}}};
  const run = await exportDelivery({db, blobs, delivery, previewURL: 'http://127.0.0.1:4318/', render});
  assert.deepEqual([run.status, run.done, run.failed, run.total], ['failed', 3, 1, 3]);
  assert.equal(seen[0][4], `http://127.0.0.1:4318/p/${PROJECT}/f.html`);
  assert.deepEqual(seen[2], ['still', '9x16', 'en', 15], 'the still of a story is drawn from its longest cut');
  assert.deepEqual([...db.rows.values()].map(r => [fileKey(r), r.status]), [['9x16|en|10|mp4', 'ready'], ['9x16|en|15|mp4', 'failed'], ['9x16|en|0|png', 'ready']]);
  assert.deepEqual([...put.keys()], ['deliveries/d1/exports/9x16_en_10s.mp4', 'deliveries/d1/exports/9x16_en_still.png']);
  await assert.rejects(exportDelivery({db, blobs, delivery: {id: 'd2', items: {final: {path: 'https://evil.example/x.html'}}}, previewURL: '', render}), /no valid final/);
});

const chrome = findChrome();
test('render: a real video and still from a page, through Chrome and ffmpeg', {skip: !chrome && 'no Chrome here'}, async () => {
  const url = pathToFileURL(path.resolve('test/fixtures-export/moving.html')).href;
  try {
    const video = await renderVideo({url, format: '1x1', lang: 'en', length: 1, fps: 10});
    assert.equal(video.bytes.subarray(4, 8).toString(), 'ftyp', 'an MP4 file');
    assert.ok(video.bytes.length > 1000);
    assert.deepEqual([video.width, video.height], [1080, 1080]);
    const still = await renderStill({url, format: '191x1', lang: 'en', length: 1});
    assert.deepEqual([...still.bytes.subarray(1, 4)].map(c => String.fromCharCode(c)).join(''), 'PNG');
    assert.deepEqual([still.width, still.height], [1200, 628]);
  } finally {
    await closeRenderer();
  }
});

test('check: chroma green left in a frame is reported, and the first frame is always looked at', {skip: !chrome && 'no Chrome here'}, async () => {
  const url = pathToFileURL(path.resolve('test/fixtures-export/green.html')).href;
  const outDir = await fs.mkdtemp(path.join(tmpdir(), 'forma-check-'));
  try {
    const sheets = await renderSheets({url, stage: 'final', setup: {kind: 'multi', formats: ['1x1'], languages: ['en'], lengths: [2]}, scenario: null, outDir, publicBase: '/x'});
    assert.ok(sheets.length >= 1);
    assert.ok(sheets.problems.green.some(l => /first frame/.test(l)), 'green in the first frame: ' + sheets.problems.green.join(', '));
    assert.deepEqual(sheets.problems.blank, []);
    assert.equal(sheets.problems.still.length, 1, 'renderFrame draws nothing new: the video does not move');
  } finally {
    await closeRenderer();
    await fs.rm(outDir, {recursive: true, force: true});
  }
});

test('check: a video whose frames change is not reported as still', {skip: !chrome && 'no Chrome here'}, async () => {
  const outDir = await fs.mkdtemp(path.join(tmpdir(), 'forma-check-'));
  const page = path.join(outDir, 'moving.html');
  await fs.writeFile(page, `<!doctype html><html><body style="margin:0;background:#123">
<div id="box" style="position:absolute;width:30%;height:30%;background:#ff4f17;left:0;top:35%"></div>
<script>
window.FORMA = {kind: 'multi', length: 4, cut: {scenes: [{id: 's1', start: 0, end: 2}, {id: 's2', start: 2, end: 4}]}};
window.renderFrame = t => { document.getElementById('box').style.left = Math.round(t * 18) + '%'; };
renderFrame(0);
setTimeout(() => postMessage({type: 'forma:time', t: 0}, '*'), 50);
</script></body></html>`);
  try {
    const sheets = await renderSheets({url: pathToFileURL(page).href, stage: 'final', setup: {kind: 'multi', formats: ['1x1'], languages: ['en'], lengths: [4]}, scenario: null, outDir, publicBase: '/x'});
    assert.deepEqual(sheets.problems.still, []);
  } finally {
    await closeRenderer();
    await fs.rm(outDir, {recursive: true, force: true});
  }
});
