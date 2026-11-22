// The video tool fits each request to what the configured OpenRouter model accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mediaSession, videoCaps} from '../media.mjs';

async function runVideo(env, args) {
  const saved = {...process.env};
  Object.assign(process.env, {OPENROUTER_API_KEY: 'test', MEDIA_VIDEO_POLL_MS: '1'}, env);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-video-'));
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST') { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({id: 'job1', status: 'pending'})); }
    if (String(url).includes('/content')) return new Response(new Uint8Array([0, 0, 0, 24]), {headers: {'Content-Type': 'video/mp4'}});
    return new Response(JSON.stringify({id: 'job1', status: 'completed', usage: {cost: 0.4}}));
  };
  try {
    const session = mediaSession({dir, allow: {images: false, video: true}});
    const out = await session.video({prompt: 'A slow push-in on a storefront at blue hour, warm light.', name: 'clip', ...args});
    return {body: bodies[0], out};
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
    await fs.rm(dir, {recursive: true, force: true});
  }
}

test('H3 Max: 5–15 s, 768p, no generate_audio field', async () => {
  const {body, out} = await runVideo({OPENROUTER_VIDEO_MODEL: 'minimax/hailuo-3-max', OPENROUTER_VIDEO_RESOLUTION: '768p'}, {duration: 3, aspect_ratio: '9:16'});
  assert.equal(body.model, 'minimax/hailuo-3-max');
  assert.equal(body.duration, 5);
  assert.equal(body.resolution, '768p');
  assert.equal('generate_audio' in body, false);
  assert.equal(out.duration, 5);
});

test('H3: a resolution it does not have falls back to 2K; audio stays off', async () => {
  const {body} = await runVideo({OPENROUTER_VIDEO_MODEL: 'minimax/hailuo-3', OPENROUTER_VIDEO_RESOLUTION: '480p'}, {duration: 8});
  assert.equal(body.resolution, '2K');
  assert.equal(body.generate_audio, false);
  assert.equal(body.duration, 8);
});

test('dated model slugs share the capabilities of their model', () => {
  assert.ok(videoCaps('minimax/hailuo-3-max-20260901'));
  assert.equal(videoCaps('some/unknown-video'), null);
});

test('H3 Max: one keyframe; refused and failed requests do not use the budget', async () => {
  const saved = {...process.env};
  Object.assign(process.env, {OPENROUTER_API_KEY: 'test', MEDIA_VIDEO_POLL_MS: '1', OPENROUTER_VIDEO_MODEL: 'minimax/hailuo-3-max', MEDIA_MAX_VIDEOS: '1'});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-video-'));
  await fs.writeFile(path.join(dir, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(dir, 'b.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const realFetch = globalThis.fetch;
  let posts = 0, fail = true;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST') { posts++; return new Response(JSON.stringify({id: 'job' + posts, status: 'pending'})); }
    if (String(url).includes('/content')) return new Response(new Uint8Array([0, 0, 0, 24]));
    return new Response(JSON.stringify(fail ? {status: 'failed', error: {message: 'bad frame'}} : {status: 'completed', usage: {cost: 0.4}}));
  };
  try {
    const session = mediaSession({dir, allow: {images: false, video: true}});
    const ask = extra => session.video({prompt: 'Two fast upward swipes on the phone, locked-off camera.', name: 'swipe', ...extra});
    await assert.rejects(ask({first_frame: 'a.png', last_frame: 'b.png'}), /one keyframe/);
    assert.equal(posts, 0, 'refused before any request');
    await assert.rejects(ask({first_frame: 'a.png'}), /did not use the video budget: 1 left/);
    fail = false;
    const out = await ask({first_frame: 'a.png'});
    assert.equal(out.remaining, 0);
    await assert.rejects(ask({first_frame: 'a.png'}), /budget for this build is used up/);
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
    await fs.rm(dir, {recursive: true, force: true});
  }
});
