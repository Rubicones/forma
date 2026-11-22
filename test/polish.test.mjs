// Regressions from the review of the studio side and the lab-round fixes (edge cases found after they shipped).
import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {Readable} from 'node:stream';
import {unzip} from '../zip.mjs';
import {figmaLinksIn, sameFigmaFile} from '../figma.mjs';
import {buildBoard} from '../brand-board.mjs';
import {blobCache, byteRange, sendBytes} from '../serve-bytes.mjs';
import {exportDelivery, finalsToExport, fileKey} from '../export.mjs';
import {mediaSession} from '../media.mjs';

// One deflated entry whose directory claims `claimed` bytes while it inflates to `real`.
function lyingZip(real, claimed) {
  const data = Buffer.alloc(real, 120);
  const packed = deflateRawSync(data);
  const n = Buffer.from('big.txt');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(claimed, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(claimed, 24);
  central.writeUInt16LE(n.length, 28); central.writeUInt32LE(0, 42);
  const cd = Buffer.concat([central, n]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(30 + n.length + packed.length, 16);
  return Buffer.concat([local, n, packed, cd, end]);
}

test('unzip: an entry that lies about its size cannot unpack past the total limit', () => {
  const {entries, skipped} = unzip(lyingZip(200000, 10), {maxEntry: 1e6, maxTotal: 5000});
  assert.equal(entries.length, 0);
  assert.deepEqual(skipped, [{name: 'big.txt', reason: 'too large'}]);
  // An honest small one still unpacks.
  assert.equal(unzip(lyingZip(100, 100)).entries[0].bytes.length, 100);
});

test('figma: one link per file, and a read of the file counts for its page and frame links', () => {
  const answers = {f_links: [{a: 'https://www.figma.com/design/AAA/Kit?node-id=1-2'}, {a: 'https://www.figma.com/design/AAA/Kit'}], f_more: 'https://www.figma.com/file/BBB/x'};
  assert.deepEqual(figmaLinksIn(answers), ['https://www.figma.com/design/AAA/Kit?node-id=1-2', 'https://www.figma.com/file/BBB/x']);
  assert.equal(sameFigmaFile('https://www.figma.com/design/AAA/Kit?t=1', 'https://figma.com/file/AAA/Other-name'), true);
  assert.equal(sameFigmaFile('https://www.figma.com/design/AAA/Kit', 'https://www.figma.com/design/BBB/Kit'), false);
  const brand = {id: 'b', version: 2, name: 'B', files: [{name: 'figma/Kit/Page/Frame.png'}],
    figma: [{url: 'https://www.figma.com/design/AAA/Kit', folder: 'figma/Kit', fileName: 'Kit', frames: 1}],
    origin: {figma: ['https://www.figma.com/design/AAA/Kit?node-id=1-2&t=abc', 'https://www.figma.com/file/BBB/x']}};
  assert.deepEqual(buildBoard(brand).figma.links, ['https://www.figma.com/file/BBB/x']);
});

function fakeRes() {
  const res = {statusCode: 200, headers: {}, body: null,
    status(c) { res.statusCode = c; return res; }, set(k, v) { if (typeof k === 'object') Object.assign(res.headers, k); else res.headers[k] = v; return res; },
    end(b) { res.body = b ?? null; return res; }};
  return res;
}

test('serving bytes: ranges for video seeking, HEAD, a range past the end; parallel reads share one load', async () => {
  const buf = Buffer.from('0123456789');
  assert.deepEqual(byteRange('bytes=2-4', 10), {start: 2, end: 4});
  assert.deepEqual(byteRange('bytes=-3', 10), {start: 7, end: 9});
  assert.equal(byteRange('bytes=12-', 10), 'unsatisfiable');
  let res = sendBytes({headers: {range: 'bytes=2-4'}, method: 'GET'}, fakeRes(), buf);
  assert.deepEqual([res.statusCode, res.headers['Content-Range'], String(res.body)], [206, 'bytes 2-4/10', '234']);
  res = sendBytes({headers: {}, method: 'HEAD'}, fakeRes(), buf);
  assert.deepEqual([res.statusCode, res.headers['Content-Length'], res.body], [200, '10', null]);
  res = sendBytes({headers: {range: 'bytes=20-'}, method: 'GET'}, fakeRes(), buf);
  assert.equal(res.statusCode, 416);

  const cache = blobCache({maxBytes: 15, maxItem: 12});
  let loads = 0;
  const load = () => { loads++; return Readable.from([Buffer.from('abcdefghij')]); };
  const [a, b] = await Promise.all([cache.get('k', load), cache.get('k', load)]);
  assert.equal(loads, 1);
  assert.equal(String(a), String(b));
  await cache.get('k2', load);   // 20 bytes > 15: the oldest goes
  await cache.get('k', load);
  assert.equal(loads, 3);
  assert.equal(await cache.get('none', () => null), null);
});

function exportDb(rows = []) {
  const map = new Map(rows.map(r => [fileKey(r), r]));
  const calls = [];
  return {
    map, calls,
    from(table) {
      const q = {
        select: () => q,
        eq: (k, v) => { calls.push([table, 'eq', k]); return q.result(); },
        neq: () => q, order: () => q,
        limit: async () => ({data: [{id: 'd1', campaign_request_id: 'c1', items: {final: {path: '/p/abcdefab-1111-4222-8333-444455556666/f.html', kind: 'single', formats: ['1x1'], langs: ['en'], lengths: [6]}}}, {id: 'd2', campaign_request_id: 'c2', items: {final: {path: '/p/abcdefab-1111-4222-8333-444455556666/g.html', kind: 'poster', formats: ['1x1'], langs: ['en'], lengths: []}}}], error: null}),
        in: async (k, ids) => { calls.push([table, 'in', ids.length]); return {data: [...map.values()].filter(r => ids.includes(r.delivery_id)), error: null}; },
        result: () => Object.assign(Promise.resolve({data: [...map.values()], error: null}), q),
        upsert: async list => { for (const r of [].concat(list)) map.set(fileKey(r), {...map.get(fileKey(r)), ...r}); return {error: null}; },
      };
      return q;
    },
  };
}

test('export: without Chrome or ffmpeg the rest is marked failed at once, not left "being prepared"', async () => {
  const db = exportDb();
  const blobs = {put: async () => {}};
  const render = {renderVideo: async () => { throw Object.assign(Error('ffmpeg was not found'), {status: 503}); }, renderStill: async () => ({bytes: Buffer.from('png')})};
  const delivery = {id: 'd1', items: {final: {title: 'T', path: '/p/abcdefab-1111-4222-8333-444455556666/f.html', kind: 'single', formats: ['1x1', '9x16'], langs: ['en'], lengths: [6]}}};
  const run = await exportDelivery({db, blobs, delivery, previewURL: 'http://x', render});
  assert.deepEqual([run.status, run.done, run.failed, run.total], ['failed', 4, 4, 4]);
  assert.deepEqual([...db.map.values()].map(r => r.status), ['failed', 'failed', 'failed', 'failed']);
});

test('export worker: one query for the files of every final; finished ones are left alone', async () => {
  const db = exportDb([{delivery_id: 'd2', format: '1x1', lang: 'en', length: 0, file_type: 'png', status: 'ready'}]);
  const list = await finalsToExport(db);
  assert.deepEqual(list.map(d => d.id), ['d1']);
  assert.deepEqual(db.calls.filter(c => c[0] === 'delivery_exports'), [['delivery_exports', 'in', 2]]);
});

test('video: a stopped build is not counted as a failed clip, and the error keeps its own kind', async () => {
  const controller = new AbortController();
  controller.abort();
  const session = mediaSession({dir: '/tmp', signal: controller.signal, allow: {images: true, video: true}});
  process.env.OPENROUTER_API_KEY ||= 'test-key';
  await assert.rejects(session.video({prompt: 'a cup of coffee steaming on a wooden table', name: 'clip', aspect_ratio: '1:1', duration: 5}), err => err.name === 'AbortError' || /abort/i.test(err.message));
  assert.equal(session.used.videoFailures, 0);
});
