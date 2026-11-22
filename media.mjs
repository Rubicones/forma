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
};
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
};
export const toolText = {
  image: 'Generate a still image (photography, illustration, texture, product scene or cutout) with ' + 'OpenRouter and save it into the materials folder. Returns its local file name, URL and pixel size. Open the file afterwards to check it against the art direction; regenerate with the previous result in references to correct it.',
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
    const model = videoModel(), started = Date.now();
    const caps = videoCaps(model);
    if (caps?.keyframes === 1 && args.first_frame && args.last_frame) {
      throw Error(model + ' takes one keyframe: pass first_frame or last_frame, not both. This did not use the video budget; ask again with one.');
    }
    pending.videos++;
    try {
    // Fit the request to what the model accepts: the nearest allowed length at or above the ask, a ratio and resolution it lists,
    // and generate_audio only where the model has audio (the clip plays muted anyway).
    const duration = caps ? (caps.durations.find(d => d >= args.duration) ?? caps.durations.at(-1)) : args.duration;
    const aspect = caps && !caps.ratios.includes(args.aspect_ratio) ? '16:9' : args.aspect_ratio;
    const body = {model, prompt:args.prompt, aspect_ratio:aspect, duration};
    if (!caps || caps.audio) body.generate_audio = false;
    const resolution = process.env.OPENROUTER_VIDEO_RESOLUTION;
    if (resolution && (!caps || caps.resolutions.includes(resolution))) body.resolution = resolution;
    else if (caps) body.resolution = caps.resolutions[0];
    if (resolution && caps && !caps.resolutions.includes(resolution)) log(model + ' has no ' + resolution + '; using ' + body.resolution, {level:'warn'});
    if (duration !== args.duration) log(model + ' makes ' + caps.durations[0] + '–' + caps.durations.at(-1) + ' s clips; asking for ' + duration + ' s instead of ' + args.duration + ' s');
    const frames = [];
    if (args.first_frame) frames.push({type:'image_url', image_url:{url:await dataURL(dir, args.first_frame)}, frame_type:'first_frame'});
    if (args.last_frame) frames.push({type:'image_url', image_url:{url:await dataURL(dir, args.last_frame)}, frame_type:'last_frame'});
    if (frames.length) body.frame_images = frames;
    else if (args.references.length) body.input_references = await Promise.all(args.references.map(async r => ({type:'image_url', image_url:{url:await dataURL(dir, r)}})));
    log('OpenRouter → video “' + args.name + '” · ' + model + ' · ' + body.aspect_ratio + ' · ' + body.duration + ' s' + (body.resolution ? ' · ' + body.resolution : '') +
      (args.first_frame ? ' · first frame: ' + args.first_frame : '') + (args.last_frame ? ' · last frame: ' + args.last_frame : '') + (!frames.length ? refs(args.references) : ''),
      {level:'step', detail:args.prompt});
    let job;
    try { job = await (await call(API + '/videos', {method:'POST', body:JSON.stringify(body)}, signal)).json(); }
    catch (error) { log('OpenRouter ✗ video “' + args.name + '”', {level:'error', detail:error.message}); throw error; }
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
      used.videoFailures++;
      throw Object.assign(error, {message: error.message + ' (This did not use the video budget: ' + (limits.videos - used.videos - pending.videos + 1) + ' left.)'});
    } finally {
      pending.videos--;
    }
  }

  return {image, video, used, limits};
}

// Wraps a session call as an MCP tool result.
export async function asToolResult(fn) {
  try {
    return {content:[{type:'text', text:JSON.stringify(await fn())}]};
  } catch (error) {
    return {isError:true, content:[{type:'text', text:error instanceof z.ZodError ? 'Invalid arguments: ' + error.message : error.message}]};
  }
}
