// The preview origin answers byte ranges, so creatives can seek their MP4 clips (FORMA.syncVideo).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {createPreviewReadThrough} from '../store/supabase.mjs';

test('local and read-through files support Range', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-range-'));
  const project = randomUUID();
  const bytes = Buffer.from(Array.from({length: 1000}, (_, i) => i % 256));
  await fs.mkdir(path.join(dir, project, 'assets'), {recursive: true});
  await fs.writeFile(path.join(dir, project, 'assets', 'clip.mp4'), bytes);
  const remote = Buffer.from('0123456789');
  const blobs = {async get(key) { return key === `projects/${project}/assets/far.mp4` ? [remote] : null; }};
  const app = express();
  app.use('/p', createPreviewReadThrough({dataDir: dir, blobs}));
  const server = await new Promise(ok => { const s = app.listen(0, () => ok(s)); });
  const base = `http://127.0.0.1:${server.address().port}/p/${project}/assets/`;
  try {
    const full = await fetch(base + 'clip.mp4');
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal((await full.arrayBuffer()).byteLength, 1000);

    const part = await fetch(base + 'clip.mp4', {headers: {Range: 'bytes=100-199'}});
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 100-199/1000');
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(100, 200));

    const tail = await fetch(base + 'clip.mp4', {headers: {Range: 'bytes=-10'}});
    assert.equal(tail.status, 206);
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(990));

    const open = await fetch(base + 'clip.mp4', {headers: {Range: 'bytes=990-'}});
    assert.equal(open.headers.get('content-range'), 'bytes 990-999/1000');

    const bad = await fetch(base + 'clip.mp4', {headers: {Range: 'bytes=5000-'}});
    assert.equal(bad.status, 416);

    const miss = await fetch(base + 'far.mp4', {headers: {Range: 'bytes=2-4'}});
    assert.equal(miss.status, 206);
    assert.equal(await miss.text(), '234');
  } finally {
    server.close();
    await fs.rm(dir, {recursive: true, force: true});
  }
});
