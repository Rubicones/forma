// OpenRouter image and video generation, exposed to the creative model as tools.
// Generated files land in <assets>/generated/ so the creative can reference them like any upload.
import fs from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';

const API = 'https://openrouter.ai/api/v1';
export const mediaKey = () => process.env.OPENROUTER_API_KEY;
// Nano Banana 2: the lite tier gave mirrored corridors and badly fitted objects in the lab round; its cost is small next to the LLM.
export const imageModel = () => process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-3.1-flash-image';
// MiniMax H3 Max: 768p at about $0.08 a second, seconds to generate, one keyframe (first or last frame: both together are refused).
// H3 (minimax/hailuo-3) is 2K only at $0.13 a second.
export const videoModel = () => process.env.OPENROUTER_VIDEO_MODEL || 'minimax/hailuo-3-max';
const range = (a, b) => Array.from({length: b - a + 1}, (_, i) => a + i);
// What OpenRouter accepts per model (from its /videos/models listing); it rejects any other value or field.
// Models not listed here get the request as asked. keyframes: how many of first_frame / last_frame one request may carry.
const VIDEO_CAPS = {
  'minimax/hailuo-3-max': {durations: range(5, 15), resolutions: ['768p', '480p'], ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], audio: false, keyframes: 1},
  'minimax/hailuo-3': {durations: range(5, 15), resolutions: ['2K'], ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], audio: true},
  // Seedance: first and last frame together; the first resolution listed is the default (720p: sharp enough for a
  // layer of the frame, a fraction of 1080p's time). It refuses a keyframe that looks like a real person (realPerson).
  'bytedance/seedance-2.0-fast': {durations: range(4, 15), resolutions: ['720p', '480p'], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21'], audio: true, keyframes: 2, realPerson: true},
  'bytedance/seedance-2.0-mini': {durations: range(4, 15), resolutions: ['720p', '480p'], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21'], audio: true, keyframes: 2, realPerson: true},
  'bytedance/seedance-2.0': {durations: range(4, 15), resolutions: ['720p', '1080p', '480p', '4K'], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21'], audio: true, keyframes: 2, realPerson: true},
  'bytedance/seedance-2.5-flash': {durations: range(4, 30), resolutions: ['720p', '480p'], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], audio: true, keyframes: 2, realPerson: true},
  'bytedance/seedance-2.5': {durations: range(4, 30), resolutions: ['720p', '1080p', '480p'], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], audio: true, keyframes: 2, realPerson: true},
};
const REAL_PERSON = /real person|real people|likeness|portrait rights/i;
// Used when OpenRouter cannot route the chosen model for this account. OPENROUTER_VIDEO_FALLBACK=0 turns it off.
export const videoFallback = () => { const v = process.env.OPENROUTER_VIDEO_FALLBACK; return v === '0' || v === '' ? null : v || 'bytedance/seedance-2.0-fast'; };
// Clips in progress across every build on this computer: OpenRouter reserves credit for each until it ends.
const inFlight = {videos: 0}, settledWaiters = [];
const videosSettled = signal => new Promise((resolve, reject) => {
  const check = () => (inFlight.videos <= 1 ? resolve() : settledWaiters.push(check));
  signal?.addEventListener('abort', () => reject(signal.reason ?? Error('aborted')), {once: true});
  check();
});
// What is left to spend: the key's own limit (any key) and, with OPENROUTER_MANAGEMENT_KEY, the account balance.
let creditsCache = null;
export async function mediaCredits() {
  if (!mediaKey()) return null;
  if (creditsCache && Date.now() - creditsCache.at < 60000) return creditsCache.value;
  const get = async (url, key) => {
    const res = await fetch(url, {headers: {Authorization: 'Bearer ' + key}, signal: AbortSignal.timeout(4000)});
    return res.ok ? (await res.json()).data : null;
  };
  const [keyInfo, account] = await Promise.all([
    get(API + '/key', mediaKey()).catch(() => null),
    process.env.OPENROUTER_MANAGEMENT_KEY ? get(API + '/credits', process.env.OPENROUTER_MANAGEMENT_KEY).catch(() => null) : null,
  ]);
  const value = {
    keyRemaining: typeof keyInfo?.limit_remaining === 'number' ? Math.round(keyInfo.limit_remaining * 100) / 100 : null,
    keyUsage: typeof keyInfo?.usage === 'number' ? Math.round(keyInfo.usage * 100) / 100 : null,
    balance: account ? Math.round((account.total_credits - account.total_usage) * 100) / 100 : null,
    checked: Boolean(keyInfo || account),
  };
  creditsCache = {at: Date.now(), value};
  return value;
}
export const videoCaps = (model = videoModel()) => VIDEO_CAPS[model.replace(/-\d{8}$/, '')] || null;
// Gemini image models ("Nano Banana") cannot output alpha.
const supportsTransparency = model => !/gemini|nano-banana/i.test(model);
const kb = bytes => (bytes / 1024).toFixed(0) + ' KB';
const usd = cost => typeof cost === 'number' ? ' · $' + cost.toFixed(4) : '';
export const mediaLimits = () => ({
  images: Number(process.env.MEDIA_MAX_IMAGES || 8),
  videos: Number(process.env.MEDIA_MAX_VIDEOS || 2),
});

const ratios = ['1:1','4:5','5:4','3:4','4:3','2:3','3:2','9:16','16:9','21:9','9:21'];
const refPath = z.string().describe('Path of an uploaded or generated asset, relative to the materials folder (as in the manifest name).');

export const imageShape = {
  prompt: z.string().min(20).describe('Photographer/illustrator brief: subject, action, framing, lens, light, materials, exact background color hex, where to leave empty space for copy. Never ask for text, logos or UI in the image.'),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).describe('Short kebab-case file name without extension, e.g. "hero-milk-pour".'),
  aspect_ratio: z.enum(ratios).default('1:1').describe('Pick the ratio of the largest crop you will use; for multi-format heroes generate a wider/taller plate with generous margins.'),
  transparent: z.boolean().default(false).describe('Request a transparent PNG cutout. Prefer one whole scene with the object in it; ask for a cutout only when the object must be its own layer. Models that cannot output alpha return it on a flat background, which shows as a box over any other picture.'),
  references: z.array(refPath).max(4).default([]).describe('Brand or product images to keep the real product, packaging, palette or a previous generation consistent; the background plate when a layer must match its scene. Use for edits/variations too.'),
};
export const videoShape = {
  prompt: z.string().min(20).describe('Shot description: subject, one clear camera move or action, lens, light, pace. Silent. No text, logos or UI.'),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).describe('Short kebab-case file name without extension.'),
  aspect_ratio: z.enum(['16:9','9:16','1:1','4:3','3:4','21:9']).default('9:16').describe('Not every video model supports every ratio; 16:9 and 9:16 are the safest.'),
  duration: z.number().int().min(3).max(15).default(5).describe('Clip length in seconds. The current model takes 5–15 s; a shorter ask is rounded up, so plan a clip at least 5 s long and use the part you need.'),
  first_frame: refPath.optional().describe('Image to start from (image-to-video). Best results: generate and inspect a still first, then animate it.'),
  last_frame: refPath.optional().describe('Optional image to end on. Models that take one keyframe refuse first_frame and last_frame together: pass one of them.'),
  references: z.array(refPath).max(3).default([]).describe('Style or product references when no first_frame is given.'),
  screen: z.boolean().default(false).describe('The clip shows a flat #00FF00 screen (laptop, phone, monitor, billboard) that the creative will put an interface on with FORMA.screen. Forma then tracks the screen right after the clip arrives and returns how sure the track is plus a contact sheet to open.'),
};
const corners = z.array(z.tuple([z.number(), z.number()])).length(4);
export const trackShape = {
  clip: refPath.describe('The MP4 with the green screen, relative to the materials folder.'),
  hints: z.array(z.object({
    t: z.number().min(0).describe('Clip time in seconds.'),
    corners: corners.describe('Rough corners of the screen at that moment, in the clip\'s own pixels, in the order top-left, top-right, bottom-right, bottom-left. Within 5% is enough: the tracker snaps them to the real edges.'),
  })).max(12).default([]).describe('Where the screen is at moments the last track got wrong or was unsure about (see the contact sheet). Leave empty for a first track.'),
};
export const toolText = {
  image: 'Generate a still image (photography, illustration, texture, product scene or cutout) with ' + 'OpenRouter and save it into the materials folder. Returns its local file name, URL and pixel size. Open the file afterwards to check it against the art direction; regenerate with the previous result in references to correct it.',
  track: 'Track the green screen in a clip again, with rough corners for the moments the last track got wrong. Free (runs on this computer). Saves <clip>.track.json, which FORMA.screen uses, and returns how sure the track is, the unsure moments and a contact sheet (PNG) of the corners to open and check.',
  video: 'Generate a short silent video clip with OpenRouter (use it for the one move code cannot make: a hero shot or a change between two scenes) and save it as MP4 in the materials folder. Returns its local file name and URL. Play it in the creative with FORMA.syncVideo(video, t, startSecond).',
};

function inside(dir, rel) {
  const file = path.resolve(dir, String(rel || ''));
  if (!file.startsWith(dir + path.sep)) throw Error('Reference must be a file inside the materials folder: ' + rel);
  return file;
}
async function dataURL(dir, rel) {
  const file = inside(dir, rel);
  const type = {'.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp'}[path.extname(file).toLowerCase()];
  if (!type) throw Error('References must be PNG, JPEG or WebP: ' + rel);
  const buf = await fs.readFile(file);
  if (buf.length > 20 * 1024 * 1024) throw Error('Reference is larger than 20 MB: ' + rel);
  return 'data:' + type + ';base64,' + buf.toString('base64');
}
async function target(dir, name, ext) {
  await fs.mkdir(path.join(dir, 'generated'), {recursive:true});
  for (let i = 1; ; i++) {
    const rel = 'generated/' + name + (i > 1 ? '-' + i : '') + '.' + ext;
    try { await fs.access(path.join(dir, rel)); } catch { return rel; }
  }
}
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return {width:buf.readUInt32BE(16), height:buf.readUInt32BE(20)};
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return {width:1 + buf.readUIntLE(24, 3), height:1 + buf.readUIntLE(27, 3)};
    if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return {width:1 + (b & 0x3fff), height:1 + ((b >> 14) & 0x3fff)}; }
    if (chunk === 'VP8 ') return {width:buf.readUInt16LE(26) & 0x3fff, height:buf.readUInt16LE(28) & 0x3fff};
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i < buf.length - 9;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return {width:buf.readUInt16BE(i + 7), height:buf.readUInt16BE(i + 5)};
      i += 2 + len;
    }
  }
  return {};
}

async function call(url, init, signal) {
  const res = await fetch(url, {...init, signal, headers:{
    Authorization:'Bearer ' + mediaKey(), 'Content-Type':'application/json',
    'HTTP-Referer':'http://127.0.0.1', 'X-Title':'Forma Studio', ...init?.headers}});
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text;
    try { const body = JSON.parse(text); message = body.error?.message || body.error || text; } catch {}
    throw Object.assign(Error('OpenRouter ' + res.status + ': ' + String(message).slice(0, 600)), {status:res.status});
  }
  return res;
}
const wait = (ms, signal) => new Promise((ok, no) => {
  const timer = setTimeout(ok, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); no(signal.reason ?? Error('aborted')); }, {once:true});
});

// One session per build: enforces the per-build budget and logs every OpenRouter request.
// log(message, {level, detail, media:{kind,file,name}, quiet})
export function mediaSession({dir, signal, log = () => {}, allow = {images:true, video:false}}) {
  // A step may allow fewer pictures than the build limit (the preview gets one hero picture).
  const limits = {...mediaLimits(), ...(Number.isInteger(allow.maxImages) ? {images: allow.maxImages} : {})}, used = {images:0, videos:0, videoFailures:0}, pending = {videos:0};
  const refs = list => list.length ? ' · references: ' + list.join(', ') : '';

  async function image(input) {
    let args;
    try { args = z.object(imageShape).parse(input); }
    catch (error) { log('generate_image: invalid arguments', {level:'warn', detail:error.message}); throw error; }
    if (!allow.images) throw Error('Image generation is disabled for this build.');
    if (used.images >= limits.images) { log('Image limit reached (' + limits.images + ')', {level:'warn'}); throw Error('Image budget for this build is used up (' + limits.images + '). Work with the files you have.'); }
    used.images++;
    const model = imageModel(), started = Date.now();
    const transparent = args.transparent && supportsTransparency(model);
    const body = {model, prompt:args.prompt, n:1, aspect_ratio:args.aspect_ratio, quality:'high', resolution:process.env.OPENROUTER_IMAGE_RESOLUTION || '2K'};
    if (args.transparent && !transparent) body.prompt += '\nIsolated subject on a perfectly flat, uniform solid background with no shadow, gradient or texture.';
    if (transparent) Object.assign(body, {background:'transparent', output_format:'png'});
    log('OpenRouter → image “' + args.name + '” · ' + model + ' · ' + args.aspect_ratio + (transparent ? ' · transparent background' : '') + refs(args.references) + ' (' + used.images + '/' + limits.images + ')',
      {level:'step', detail:args.prompt});
    if (args.references.length) body.input_references = await Promise.all(args.references.map(async r => ({type:'image_url', image_url:{url:await dataURL(dir, r)}})));
    let res;
    try {
      res = await call(API + '/images', {method:'POST', body:JSON.stringify(body)}, signal);
    } catch (error) {
      if (error.status !== 400) { log('OpenRouter ✗ image “' + args.name + '”', {level:'error', detail:error.message}); throw error; }
      // Some providers reject quality/resolution tiers; retry with the bare minimum.
      log('OpenRouter rejected the parameters. Retrying without quality/resolution.', {level:'warn', detail:error.message});
      delete body.quality; delete body.resolution;
      try { res = await call(API + '/images', {method:'POST', body:JSON.stringify(body)}, signal); }
      catch (retry) { log('OpenRouter ✗ image “' + args.name + '”', {level:'error', detail:retry.message}); throw retry; }
    }
    const result = await res.json();
    const item = result.data?.[0];
    if (!item?.b64_json) { log('OpenRouter returned no image', {level:'error', detail:JSON.stringify(result).slice(0, 500)}); throw Error('OpenRouter returned no image. Try a different prompt.'); }
    const ext = {'image/jpeg':'jpg', 'image/webp':'webp', 'image/svg+xml':'svg'}[item.media_type] || 'png';
    const buf = Buffer.from(item.b64_json, 'base64');
    const file = await target(dir, args.name, ext);
    await fs.writeFile(path.join(dir, file), buf);
    const size = imageSize(buf);
    log('OpenRouter ✓ ' + file + ' · ' + (size.width ? size.width + '×' + size.height + ' · ' : '') + kb(buf.length) + ' · ' + ((Date.now() - started) / 1000).toFixed(1) + ' s' + usd(result.usage?.cost),
      {level:'done', media:{kind:'image', file, name:args.name, cost:result.usage?.cost}, cost:{kind:'image', usd:result.usage?.cost ?? null}});
    const note = args.transparent && !transparent ? 'This model cannot output transparency: the subject is on a flat solid background and will show as a box over any other picture. Use it only on a flat field of exactly that colour; otherwise generate the whole scene as one picture.' : undefined;
    return {file, url:'assets/' + file, ...size, model, transparent, note, cost:result.usage?.cost, remaining:limits.images - used.images};
  }

  async function video(input) {
    let args;
    try { args = z.object(videoShape).parse(input); }
    catch (error) { log('generate_video: invalid arguments', {level:'warn', detail:error.message}); throw error; }
    if (!allow.video) throw Error('Video generation is disabled for this build.');
    // Only a clip that comes back counts against the budget: a refused or failed request costs a retry, not a clip.
    if (used.videos + pending.videos >= limits.videos) { log('Video limit reached (' + limits.videos + ')', {level:'warn'}); throw Error('Video budget for this build is used up (' + limits.videos + ').'); }
    if (used.videoFailures >= 3) throw Error('Three video requests failed in this build. Continue without the clip and say why in your reply.');
    const started = Date.now();
    let model = videoModel(), caps = videoCaps(model);
    if (caps?.keyframes === 1 && args.first_frame && args.last_frame) {
      throw Error(model + ' takes one keyframe: pass first_frame or last_frame, not both. This did not use the video budget; ask again with one.');
    }
    pending.videos++;
    inFlight.videos++;
    try {
    const frameImages = [];
    if (args.first_frame) frameImages.push({type:'image_url', image_url:{url:await dataURL(dir, args.first_frame)}, frame_type:'first_frame'});
    if (args.last_frame) frameImages.push({type:'image_url', image_url:{url:await dataURL(dir, args.last_frame)}, frame_type:'last_frame'});
    const references = !frameImages.length && args.references.length ? await Promise.all(args.references.map(async r => ({type:'image_url', image_url:{url:await dataURL(dir, r)}}))) : null;
    // Fit the request to what the model accepts: the nearest allowed length at or above the ask, a ratio and resolution it lists,
    // and generate_audio only where the model has audio (the clip plays muted anyway).
    const fit = () => {
      const duration = caps ? (caps.durations.find(d => d >= args.duration) ?? caps.durations.at(-1)) : args.duration;
      const aspect = caps && !caps.ratios.includes(args.aspect_ratio) ? '16:9' : args.aspect_ratio;
      const body = {model, prompt:args.prompt, aspect_ratio:aspect, duration};
      if (!caps || caps.audio) body.generate_audio = false;
      const resolution = process.env.OPENROUTER_VIDEO_RESOLUTION;
      if (resolution && (!caps || caps.resolutions.includes(resolution))) body.resolution = resolution;
      else if (caps) body.resolution = caps.resolutions[0];
      if (resolution && caps && !caps.resolutions.includes(resolution)) log(model + ' has no ' + resolution + '; using ' + body.resolution, {level:'warn'});
      if (duration !== args.duration) log(model + ' makes ' + caps.durations[0] + '–' + caps.durations.at(-1) + ' s clips; asking for ' + duration + ' s instead of ' + args.duration + ' s');
      const frames = caps?.keyframes === 1 && frameImages.length > 1 ? frameImages.slice(0, 1) : frameImages;
      if (frames.length < frameImages.length) log(model + ' takes one keyframe: the last frame is left out', {level:'warn'});
      if (frames.length) body.frame_images = frames;
      else if (references) body.input_references = references;
      log('OpenRouter → video “' + args.name + '” · ' + model + ' · ' + body.aspect_ratio + ' · ' + body.duration + ' s' + (body.resolution ? ' · ' + body.resolution : '') +
        (args.first_frame ? ' · first frame: ' + args.first_frame : '') + (frames.length > 1 || (!args.first_frame && args.last_frame) ? ' · last frame: ' + args.last_frame : '') + (!frames.length ? refs(args.references) : ''),
        {level:'step', detail:args.prompt});
      return body;
    };
    let body = fit(), job, tries = {person: 0, credits: 0, fallback: 0};
    for (;;) {
      try { job = await (await call(API + '/videos', {method:'POST', body:JSON.stringify(body)}, signal)).json(); break; }
      catch (error) {
        const msg = String(error.message);
        // The real-person filter is not deterministic on the same picture: one more try often passes (round 8, Grit).
        if (error.status === 400 && REAL_PERSON.test(msg) && !tries.person++) { log(model + ' saw a real person in the keyframe; trying once more', {level:'warn', detail:msg}); continue; }
        // 402 counts the credits other running requests have reserved: wait for this computer's other clips, then once more.
        if (error.status === 402 && !tries.credits++ && inFlight.videos > 1) {
          log('OpenRouter credits are reserved by ' + (inFlight.videos - 1) + ' other clip' + (inFlight.videos > 2 ? 's' : '') + ' in progress; waiting for them, then trying again', {level:'warn', detail:msg});
          await videosSettled(signal);
          continue;
        }
        // A model OpenRouter lists but cannot route for this account (round 8: "No endpoints found" for MiniMax): the fallback model.
        const fallback = videoFallback();
        if (error.status === 404 && /no endpoints/i.test(msg) && fallback && fallback !== model && !tries.fallback++) {
          log(model + ' is not available on OpenRouter for this account (' + msg.slice(0, 120) + '); using ' + fallback + ' instead. Check the providers and privacy settings in OpenRouter.', {level:'warn'});
          model = fallback; caps = videoCaps(model); body = fit();
          continue;
        }
        log('OpenRouter ✗ video “' + args.name + '”', {level:'error', detail:msg});
        if (error.status === 400 && REAL_PERSON.test(msg)) throw Object.assign(Error(msg + ' — ' + model + ' refuses keyframes that look like a photo of a real person. Ask again without first_frame/last_frame (people described in the prompt), or from a keyframe where people are seen from behind, at a distance, or as hands only.'), {status: error.status});
        if (error.status === 402) throw Object.assign(Error('OpenRouter has too little credit left for this clip (' + msg.slice(0, 160) + '). Top up at openrouter.ai/settings/credits. Continue without the clip and say so in your reply.'), {status: 402});
        throw error;
      }
    }
    log('Video queued · job ' + job.id);
    const deadline = Date.now() + Number(process.env.MEDIA_VIDEO_TIMEOUT_MS || 12 * 60 * 1000);
    let state = job, lastStatus = job.status;
    while (state.status !== 'completed') {
      if (['failed', 'cancelled', 'expired'].includes(state.status)) {
        const reason = state.error?.message || state.error || 'unknown error';
        log('OpenRouter ✗ video “' + args.name + '” · ' + state.status, {level:'error', detail:reason});
        throw Error('Video generation ' + state.status + ': ' + reason);
      }
      if (Date.now() > deadline) { log('Video generation timed out', {level:'error'}); throw Error('Video generation timed out. Continue without the clip.'); }
      await wait(Number(process.env.MEDIA_VIDEO_POLL_MS || 5000), signal);
      state = await (await call(API + '/videos/' + encodeURIComponent(job.id), {method:'GET'}, signal)).json();
      const elapsed = Math.round((Date.now() - started) / 1000) + ' s';
      log('Video “' + args.name + '” · ' + state.status + ' · ' + elapsed, {level:state.status !== lastStatus ? 'step' : 'info'});
      lastStatus = state.status;
    }
    const content = await call(API + '/videos/' + encodeURIComponent(job.id) + '/content?index=0', {method:'GET'}, signal);
    const buf = Buffer.from(await content.arrayBuffer());
    const file = await target(dir, args.name, 'mp4');
    await fs.writeFile(path.join(dir, file), buf);
    log('OpenRouter ✓ ' + file + ' · ' + kb(buf.length) + ' · ' + Math.round((Date.now() - started) / 1000) + ' s' + usd(state.usage?.cost),
      {level:'done', media:{kind:'video', file, name:args.name, cost:state.usage?.cost}, cost:{kind:'video', usd:state.usage?.cost ?? null}});
    used.videos++;
    return {file, url:'assets/' + file, duration:body.duration, aspect_ratio:body.aspect_ratio, model, cost:state.usage?.cost, remaining:limits.videos - used.videos};
    } catch (error) {
      // A stopped build is not a failed clip; and a DOMException's message cannot be rewritten, so the note is a new error.
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      used.videoFailures++;
      const left = limits.videos - used.videos - pending.videos + 1;
      throw Object.assign(Error(String(error?.message || error) + ' (This did not use the video budget: ' + left + ' left.)', {cause: error}), error?.status ? {status: error.status} : {});
    } finally {
      pending.videos--;
      inFlight.videos--;
      for (const fn of settledWaiters.splice(0)) fn();
    }
  }

  // Tracks a clip's green screen (screen-track.mjs) and draws a contact sheet; the result tells the model what to check.
  async function track(input, {firstFrame, lastFrame} = {}) {
    let args;
    try { args = z.object(trackShape).parse(input); }
    catch (error) { log('track_screen: invalid arguments', {level:'warn', detail:error.message}); throw error; }
    const file = inside(dir, args.clip);
    if (!/\.(mp4|mov|webm|m4v)$/i.test(file)) throw Error('track_screen takes a video clip: ' + args.clip);
    const {trackScreen, probeVideo, readFrames, findScreen, keyColour, trackSummary} = await import('./screen-track.mjs');
    const {trackPath, trackSheet} = await import('./screen-bake.mjs');
    const started = Date.now();
    const info = await probeVideo(file);
    const hints = args.hints.map(h => ({t: h.t, quad: h.corners}));
    // A clip made from stills starts and ends where their screens are: the first frame's corners are the hint at 0,
    // the last frame's at the end (round 9: an imprint that appears only at the end was missed without it).
    const stillHint = async (file, t, which) => {
      try {
        const img = inside(dir, file);
        const w = 480, h = Math.max(2, Math.round(info.height * w / info.width / 2) * 2);
        let rgb = null;
        await readFrames(img, {width: w, height: h, onFrame: f => { rgb ||= f; }});
        const size = imageSize(await fs.readFile(img));
        const sameShape = size.width && Math.abs(size.width / size.height - info.width / info.height) < 0.02;
        const found = rgb && sameShape ? findScreen(rgb, w, h, {key: keyColour(rgb, w, h)}) : null;
        if (found?.conf > 0.5) hints.push({t, quad: found.quad.map(([x, y]) => [x * info.width / w, y * info.height / h])});
      } catch (error) { log('The ' + which + ' frame could not be read for the screen track', {level:'warn', detail:error.message}); }
    };
    if (!hints.length) {
      if (firstFrame) await stillHint(firstFrame, 0, 'first');
      if (lastFrame) await stillHint(lastFrame, Math.max(0, info.duration - 1 / (info.fps || 24)), 'last');
    }
    log('Tracking the screen in ' + args.clip + (hints.length ? ' · ' + hints.length + ' hint' + (hints.length > 1 ? 's' : '') : ''), {level:'step'});
    const result = await trackScreen(file, {hints});
    await fs.writeFile(trackPath(file), JSON.stringify(result));
    const sheet = args.clip.replace(/\.[a-z0-9]+$/i, '') + '.track.png';
    const times = await trackSheet(file, result, path.join(dir, sheet));
    const summary = trackSummary(result, {file: args.clip});
    const sure = result.found && summary.confidence >= 0.6 && !result.low.length;
    log('Screen track ' + (result.found ? (sure ? '✓' : '· unsure') : '✗') + ' ' + args.clip + ' · ' + summary.seen + ' · confidence ' + summary.confidence + ' · ' + ((Date.now() - started) / 1000).toFixed(1) + ' s',
      {level: result.found && sure ? 'done' : 'warn', detail: result.warnings.join(' ') || undefined});
    return {
      ...summary, size: [info.width, info.height], sheet, sheet_times: times,
      next: !result.found
        ? 'No green screen was found in this clip. Open the sheet: if the screen is there, call track_screen with its corners at one or two moments; if not, the clip cannot carry an interface.'
        : sure ? 'Open the sheet once: magenta corners should sit on the screen\'s corners. FORMA.screen will use this track.'
        : 'Open the sheet: amber corners are unsure. Where they are off the screen, call track_screen again with rough corners for those moments (clip pixels).',
    };
  }

  // A clip asked for with screen: true is tracked as soon as it arrives; a failed track never loses the clip.
  async function videoWithScreen(input) {
    const result = await video(input);
    if (!input?.screen) return result;
    try { result.screen = await track({clip: result.file}, {firstFrame: input.first_frame, lastFrame: input.last_frame}); }
    catch (error) { log('Screen track failed', {level:'warn', detail:error.message}); result.screen = {found: false, error: error.message, next: 'Call track_screen for this clip.'}; }
    return result;
  }

  return {image, video: videoWithScreen, track, used, limits};
}

// Wraps a session call as an MCP tool result.
export async function asToolResult(fn) {
  try {
    return {content:[{type:'text', text:JSON.stringify(await fn())}]};
  } catch (error) {
    return {isError:true, content:[{type:'text', text:error instanceof z.ZodError ? 'Invalid arguments: ' + error.message : error.message}]};
  }
}
