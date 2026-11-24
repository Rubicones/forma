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

// Answers POSTs from a list in turn (a status and a message, or a job), the rest like a finished job.
async function scripted(env, answers, args = {}) {
  const saved = {...process.env};
  Object.assign(process.env, {OPENROUTER_API_KEY: 'test', MEDIA_VIDEO_POLL_MS: '1'}, env);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-video-'));
  await fs.writeFile(path.join(dir, 'still.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const bodies = [], logs = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST') {
      bodies.push(JSON.parse(init.body));
      const a = answers.shift();
      if (a) return new Response(JSON.stringify({error: {message: a[1]}}), {status: a[0]});
      return new Response(JSON.stringify({id: 'job1', status: 'pending'}));
    }
    if (String(url).includes('/content')) return new Response(new Uint8Array([0, 0, 0, 24]));
    return new Response(JSON.stringify({id: 'job1', status: 'completed'}));
  };
  try {
    const session = mediaSession({dir, allow: {images: false, video: true}, log: (m, x) => logs.push([m, x?.level])});
    const out = await session.video({prompt: 'A coach lifts nine shopping bags at once, locked-off camera.', name: 'clip', ...args}).catch(e => e);
    return {bodies, out, logs};
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
    await fs.rm(dir, {recursive: true, force: true});
  }
}

test('Seedance 2.0 Fast: 720p by default, first and last frame together, audio off', async () => {
  const caps = videoCaps('bytedance/seedance-2.0-fast');
  assert.equal(caps.keyframes, 2);
  const {bodies, out} = await scripted({OPENROUTER_VIDEO_MODEL: 'bytedance/seedance-2.0-fast', OPENROUTER_VIDEO_RESOLUTION: ''}, [], {duration: 3, first_frame: 'still.png', last_frame: 'still.png'});
  assert.equal(out.file, 'generated/clip.mp4');
  assert.deepEqual([bodies[0].resolution, bodies[0].duration, bodies[0].generate_audio, bodies[0].frame_images.length], ['720p', 4, false, 2]);
});

test('Seedance: a "real person" refusal is tried once more; a second refusal says what to do', async () => {
  const env = {OPENROUTER_VIDEO_MODEL: 'bytedance/seedance-2.0-fast'};
  const once = await scripted(env, [[400, "The request failed because the input image 'content[1]' may contain real person"]], {first_frame: 'still.png'});
  assert.equal(once.bodies.length, 2);
  assert.equal(once.out.file, 'generated/clip.mp4');
  const twice = await scripted(env, [[400, 'may contain real person'], [400, 'may contain real person']], {first_frame: 'still.png'});
  assert.ok(twice.out instanceof Error);
  assert.match(twice.out.message, /without first_frame/);
  assert.match(twice.out.message, /did not use the video budget/);
});

test('a model OpenRouter cannot route ("No endpoints found") falls back once, with a warning', async () => {
  const {bodies, out, logs} = await scripted({OPENROUTER_VIDEO_MODEL: 'minimax/hailuo-3-max', OPENROUTER_VIDEO_RESOLUTION: '768p'},
    [[404, 'No endpoints found for minimax/hailuo-3-max.']], {first_frame: 'still.png'});
  assert.deepEqual(bodies.map(b => b.model), ['minimax/hailuo-3-max', 'bytedance/seedance-2.0-fast']);
  assert.equal(bodies[1].resolution, '720p', '768p is not a Seedance resolution');
  assert.equal(out.model, 'bytedance/seedance-2.0-fast');
  assert.ok(logs.some(([m, l]) => l === 'warn' && /privacy settings/.test(m)));
  const off = await scripted({OPENROUTER_VIDEO_MODEL: 'minimax/hailuo-3-max', OPENROUTER_VIDEO_FALLBACK: '0'}, [[404, 'No endpoints found for minimax/hailuo-3-max.']]);
  assert.ok(off.out instanceof Error);
  assert.equal(off.bodies.length, 1);
});

test('402 with no other clip running: no retry, a message that says to top up', async () => {
  const {bodies, out} = await scripted({OPENROUTER_VIDEO_MODEL: 'bytedance/seedance-2.0-fast'}, [[402, 'This request would exceed your available credits given your current in-flight requests']]);
  assert.equal(bodies.length, 1);
  assert.match(out.message, /Top up/);
});

test('402 while another clip is running: waits for it to finish, then tries once more', async () => {
  const saved = {...process.env};
  Object.assign(process.env, {OPENROUTER_API_KEY: 'test', MEDIA_VIDEO_POLL_MS: '1', OPENROUTER_VIDEO_MODEL: 'bytedance/seedance-2.0-fast'});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-video-'));
  const realFetch = globalThis.fetch;
  let posts = 0, aDone = false, aDoneAt = 0, retryAt = 0;
  setTimeout(() => { aDone = true; aDoneAt = Date.now(); }, 60);
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST') {
      posts++;
      if (posts === 1) return new Response(JSON.stringify({id: 'a', status: 'pending'}));
      if (posts === 2) return new Response(JSON.stringify({error: {message: 'would exceed your available credits given your current in-flight requests'}}), {status: 402});
      retryAt = Date.now();
      return new Response(JSON.stringify({id: 'b', status: 'pending'}));
    }
    if (String(url).includes('/content')) return new Response(new Uint8Array([0, 0, 0, 24]));
    const id = String(url).split('/videos/')[1];
    return new Response(JSON.stringify({id, status: id === 'a' && !aDone ? 'pending' : 'completed'}));
  };
  try {
    const one = mediaSession({dir, allow: {images: false, video: true}});
    const two = mediaSession({dir, allow: {images: false, video: true}});
    const a = one.video({prompt: 'A slow push-in on a storefront at blue hour.', name: 'clip-a'});
    await new Promise(r => setTimeout(r, 10));
    const b = two.video({prompt: 'Steam rises from a cup on a sunny sill.', name: 'clip-b'});
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.file, 'generated/clip-a.mp4');
    assert.equal(rb.file, 'generated/clip-b.mp4');
    assert.equal(posts, 3);
    assert.ok(retryAt >= aDoneAt, 'the retry waited for the other clip');
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
    await fs.rm(dir, {recursive: true, force: true});
  }
});
