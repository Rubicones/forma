// Immutable versions let campaigns keep the exact brand materials they started with.
import {randomUUID, createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {createWriteStream} from 'node:fs';
import express from 'express';
import {store} from './store/index.mjs';
import {classifyProjectFile, streamToBuffer, contentTypeForPath} from './store/supabase.mjs';
import {buildBoard, extractColours, readsColours, BOARD_TEXT_LIMIT} from './brand-board.mjs';
import {readFigma, figmaStatus, figmaToken} from './figma.mjs';
import {tmpdir} from 'node:os';
import {createJob, logger, finishJob} from './jobs.mjs';
import {settings} from './models.mjs';
import {BRAND_NOTES_FILE, brandNotesPrompt, brandNotesMessage, composeBrandNotes, splitClientDecisions, addClientDecision, extractBrandNotes, notesHaveBody, decideOpenQuestion, openQuestions} from './creative.mjs';

const manifests = 'brands/versions/';
const files = 'brands/files/';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const invalid = (message, status = 400) => Object.assign(Error(message), {status});
// OS and VCS clutter that folder drops bring along (.DS_Store, __MACOSX, Thumbs.db, hidden dirs): dropped, not rejected.
export const isJunkPath = name => name.split('/').some(seg => (seg.startsWith('.') && seg !== '.' && seg !== '..') || seg === '__MACOSX' || /^(thumbs\.db|desktop\.ini)$/i.test(seg));

async function latestVersions() {
  const keys = await store.blobs.list(manifests);
  const latest = new Map();
  for (const {key} of keys) {
    const [brand, filename] = key.slice(manifests.length).split('/');
    const version = Number(filename?.match(/^(\d+)\.json$/)?.[1]);
    if (uuid.test(brand) && version > (latest.get(brand) || 0)) latest.set(brand, version);
  }
  return latest;
}

async function readBrand(id, version) {
  if (!uuid.test(id) || !Number.isSafeInteger(version) || version < 1) throw invalid('Select a saved brand.');
  const body = await store.blobs.get(versionKey(id, version));
  if (!body) throw invalid('Brand version not found.', 404);
  return JSON.parse((await streamToBuffer(body)).toString());
}

async function saveFile(bytes) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (!await store.blobs.head(files + hash)) await store.blobs.put(files + hash, bytes, {sha256:hash});
  return hash;
}

function brandName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 160) throw invalid('Enter a brand name (up to 160 characters).');
  return name;
}

const versionKey = (id, version) => manifests + id + '/' + version + '.json';

async function writeVersion(brand) {
  try {
    await store.blobs.put(versionKey(brand.id, brand.version), Buffer.from(JSON.stringify(brand)), {ifAbsent:true});
  } catch (err) {
    if (err.code === 'EEXIST' || err.name === 'PreconditionFailed' || err.$metadata?.httpStatusCode === 412) {
      throw invalid('This brand has changed. Refresh the page and try again.', 409);
    }
    throw err;
  }
}

// ---- Brand notes: BRAND-NOTES.md travels as a brand file, so versions, campaigns and the cloud carry it as they are ----

const notesState = new Map(); // brandId -> {status:'writing'|'failed', error?, requestId, startedAt}
const sha = text => createHash('sha256').update(text).digest('hex');
// What the notes were written from: every brand file except the notes themselves.
export const brandFilesHash = (files = []) => sha(files.filter(f => f.name !== BRAND_NOTES_FILE).map(f => f.name + ':' + f.hash).sort().join('\n'));

export async function latestBrand(id) {
  const version = (await latestVersions()).get(id);
  return version ? readBrand(id, version) : null;
}

export async function brandNotesText(brand) {
  const file = brand?.files?.find(f => f.name === BRAND_NOTES_FILE);
  if (!file) return '';
  const body = await store.blobs.get(files + file.hash);
  return body ? (await streamToBuffer(body)).toString('utf8') : '';
}

export const brandNotesWriting = id => notesState.get(id)?.status === 'writing';

export async function brandNotesStatus(brand) {
  const state = notesState.get(brand.id);
  const text = await brandNotesText(brand);
  return {
    brand: {id:brand.id, version:brand.version, name:brand.name},
    status: state?.status || (notesHaveBody(text) ? 'ready' : 'missing'),
    error: state?.error || null,
    text,
    source: brand.notes?.source || (text ? 'supplied' : null),
    at: brand.notes?.at || null,
    cost: typeof brand.notes?.cost === 'number' ? brand.notes.cost : null,
    model: brand.notes?.model || null,
    questions: openQuestions(text),
    outdated: Boolean(text && brand.notes?.basedOn && brand.notes.basedOn !== brandFilesHash(brand.files)),
  };
}

// Saves new notes text as the next version of the brand's latest files. Retries once if the brand moved meanwhile.
export async function saveBrandNotes(id, text, notes, {expectVersion} = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const latest = await latestBrand(id);
    if (!latest) throw invalid('Brand not found.', 404);
    if (expectVersion && latest.version !== expectVersion) throw invalid('This brand has changed. Refresh the page and try again.', 409);
    const hash = await saveFile(Buffer.from(text, 'utf8'));
    const brand = {
      ...latest,
      version: latest.version + 1,
      files: [...latest.files.filter(f => f.name !== BRAND_NOTES_FILE), {name:BRAND_NOTES_FILE, hash}],
      notes: {...notes, basedOn: notes.basedOn ?? latest.notes?.basedOn ?? brandFilesHash(latest.files)},
    };
    try {
      await writeVersion(brand);
      return brand;
    } catch (err) {
      if (err.status !== 409 || expectVersion || attempt) throw err;
    }
  }
}

const demoNotes = brand => `# ${brand.name} — brand notes

## Character
Demo notes, written without a model. (guess)

## Pictures
not stated

## Devices in use
not stated

## The system
Files: ${brand.files.filter(f => f.name !== BRAND_NOTES_FILE).map(f => f.name).join(', ') || 'none'}.

## Never
not stated

## Quality bar
- With the logo covered, the frame still reads as this brand by its colour and type. (guess)
`;

// Writes the notes in the background. Never overwrites notes someone edited or supplied unless force is set.
export function startBrandNotes(id, provider, deps = {}, {force = false} = {}) {
  if (brandNotesWriting(id)) return notesState.get(id);
  const mode = provider?.mode || 'demo';
  if (mode !== 'demo' && !deps.runModelText) return null;
  const requestId = randomUUID();
  const state = {status:'writing', requestId, startedAt:Date.now()};
  notesState.set(id, state);
  (async () => {
    const job = createJob(requestId, {task:'brand-notes', mode});
    const log = logger(job);
    const controller = new AbortController();
    let tmp;
    try {
      const latest = await latestBrand(id);
      if (!latest) throw invalid('Brand not found.', 404);
      const before = await brandNotesText(latest);
      if (notesHaveBody(before) && !force) { notesState.delete(id); return; }
      let text;
      if (mode === 'demo') {
        text = demoNotes(latest);
      } else {
        const billing = provider.billing || (mode === 'claude' ? 'subscription' : 'api');
        const sel = settings(mode, provider.model ?? undefined, provider.effort ?? undefined);
        await deps.checkProvider?.(mode, billing);
        tmp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'forma-brand-')));
        const assets = path.join(tmp, 'assets');
        const names = [];
        for (const file of latest.files) {
          if (file.name === BRAND_NOTES_FILE) continue;
          const body = await store.blobs.get(files + file.hash);
          if (!body) continue;
          const dest = path.join(assets, file.name);
          await fs.mkdir(path.dirname(dest), {recursive:true});
          await pipeline(body, createWriteStream(dest));
          names.push(file.name);
        }
        log('Writing brand notes for “' + latest.name + '” · ' + mode + (sel.model ? ' · ' + sel.model : ''), {level:'step'});
        text = await deps.runModelText({
          mode, billing, model:sel.model, effort:sel.effort, dir:assets,
          system:brandNotesPrompt(), user:brandNotesMessage({name:latest.name, files:names, decisions:splitClientDecisions(before).decisions}),
          task:'brand-notes', controller, log, onText:t => { job.text = t; },
        });
      }
      const raw = String(text || '');
      text = extractBrandNotes(raw);
      if (!text) {
        log('The reply was not brand notes', {level:'warn', detail:raw});
        const start = raw.replace(/\s+/g, ' ').trim().slice(0, 160);
        throw invalid('The model replied with something other than the notes' + (start ? ': “' + start + (raw.length > 160 ? '…' : '') + '”' : ' (an empty reply)') + '. Try again.', 502);
      }
      // Re-read: someone may have supplied or edited notes while the model was writing.
      const now = await latestBrand(id);
      const current = await brandNotesText(now);
      if (notesHaveBody(current) && !force && current !== before) { notesState.delete(id); return; }
      const {decisions} = splitClientDecisions(current || before);
      await saveBrandNotes(id, composeBrandNotes(text, decisions), {
        source:'generated', at:new Date().toISOString(), basedOn:brandFilesHash(now.files),
        cost: Math.round((job.costs.total || 0) * 10000) / 10000, model: mode === 'demo' ? null : (provider.model || null),
      });
      log('Brand notes ready', {level:'done'});
      notesState.delete(id);
    } catch (err) {
      log('Brand notes failed: ' + err.message, {level:'error'});
      notesState.set(id, {status:'failed', error:err.message, requestId});
    } finally {
      finishJob(job);
      if (tmp) await fs.rm(tmp, {recursive:true, force:true}).catch(() => {});
    }
  })();
  return state;
}

// A brand the studio makes from files it already holds (stage 3: an approved client questionnaire). Idempotent on id:
// when the brand exists it is returned as it is. The client decisions go into BRAND-NOTES.md at once, so they hold
// even before (or without) the notes being written; the writer keeps them and fills in the rest.
export async function createBrandFromFiles({id, name, files: input = [], decisions = [], origin = null}) {
  if (!uuid.test(String(id))) throw invalid('Invalid brand id.');
  const existing = await latestBrand(id);
  if (existing) return existing;
  const title = brandName(name);
  const list = [];
  for (const file of input) list.push({name:file.name, hash:await saveFile(file.bytes)});
  const brand = {id, version:1, name:title, files:list, ...(origin ? {origin} : {})};
  if (decisions.length) {
    const hash = await saveFile(Buffer.from(composeBrandNotes(`# ${title} — brand notes\n`, decisions), 'utf8'));
    brand.notes = {source:'questionnaire', at:new Date().toISOString(), basedOn:brandFilesHash(list)};
    brand.files = [...list, {name:BRAND_NOTES_FILE, hash}];
  }
  try {
    await writeVersion(brand);
  } catch (err) {
    if (err.status === 409) return latestBrand(id);
    throw err;
  }
  return brand;
}

// Files read from a Figma file (figma.mjs) as the next brand version. A new read of the same file replaces what the
// previous read added; everything else, the notes included, stays. brand.figma remembers each file read.
export async function addFigmaFiles(id, read) {
  const hashed = [];
  for (const file of read.files) hashed.push({name:file.name, hash:await saveFile(file.bytes)});
  const entry = {key:read.key, url:read.url, fileName:read.fileName, folder:read.folder, at:new Date().toISOString(),
    frames:read.frames, styles:read.styles, ...(read.skipped?.length ? {skipped:read.skipped.slice(0, 50)} : {})};
  for (let attempt = 0; attempt < 2; attempt++) {
    const latest = await latestBrand(id);
    if (!latest) throw invalid('Brand not found.', 404);
    const previous = (latest.figma || []).find(f => f.key === read.key);
    const drop = [read.folder, previous?.folder].filter(Boolean).map(f => f + '/');
    const kept = latest.files.filter(f => !drop.some(d => f.name.startsWith(d)));
    const names = new Set(hashed.map(f => f.name));
    const brand = {...latest, version:latest.version + 1, files:[...kept.filter(f => !names.has(f.name)), ...hashed],
      figma:[...(latest.figma || []).filter(f => f.key !== read.key), entry]};
    try {
      await writeVersion(brand);
      return brand;
    } catch (err) {
      if (err.status !== 409 || attempt) throw err;
    }
  }
}

// After new files arrive: write the notes if there are none yet (only client decisions count as none); otherwise the
// notes are marked outdated by brandNotesStatus and the team chooses to rewrite.
export async function notesAfterNewFiles(brand, provider, deps = {}) {
  if (brandNotesWriting(brand.id)) return 'writing';
  if (notesHaveBody(await brandNotesText(brand))) return 'outdated';
  if (!provider?.mode || provider.mode === 'demo') return 'missing';
  return startBrandNotes(brand.id, provider, deps) ? 'writing' : 'missing';
}

// Adds a client decision to the brand's latest notes (creating the notes file if there is none yet).
export async function rememberForBrand(id, decision, fallbackText = '') {
  const latest = await latestBrand(id);
  if (!latest) throw invalid('Brand not found.', 404);
  const current = await brandNotesText(latest) || fallbackText || `# ${latest.name} — brand notes\n`;
  const next = addClientDecision(current, decision);
  return saveBrandNotes(id, next, {...(latest.notes || {source:'supplied'}), at:new Date().toISOString()});
}

export async function materializeBrand(id, version, project, dir) {
  const brand = await readBrand(id, version);
  for (const {name, hash} of brand.files) {
    const source = await store.blobs.get(files + hash);
    if (!source) throw invalid('Brand file missing from storage: ' + name, 409);
    const dest = path.join(dir, 'assets', name);
    await fs.mkdir(path.dirname(dest), {recursive:true});
    await pipeline(source, createWriteStream(dest, {flags:'wx'}));
  }
  await store.sync.up(project, {dataDir:path.dirname(dir)});
}

// Prefer the active variant within each stage, then the most recently added variants.
export async function campaignCover(campaign) {
  const variants = campaign.variants || [];
  const active = variants.find(v => v.id === campaign.activeVariant);
  const sources = [active, campaign.steps, ...variants.slice().reverse()].filter(Boolean);
  for (const stage of ['final', 'preview', 'styles']) {
    const checked = new Set();
    for (const source of sources) {
      const step = source[stage];
      if (!step?.entryId || checked.has(step.entryId)) continue;
      checked.add(step.entryId);
      const entry = await store.history.get(step.entryId);
      const output = entry?.output;
      if (stage === 'styles') {
        const sketch = output?.styles?.[step.chosenIndex] || output?.styles?.find(s => s.svg);
        if (sketch?.svg) return {stage:'sketch', svg:sketch.svg};
      } else if (output?.path) {
        return {stage, path:output.path, format:output.format || output.formats?.[0] || campaign.setup?.formats?.[0] || '1x1'};
      }
    }
  }
  return null;
}

export function registerBrandRoutes(app, deps = {}) {
  app.get('/api/brands', async (_req, res) => {
    const versions = await latestVersions();
    const brands = await Promise.all([...versions].map(([id, version]) => readBrand(id, version)));
    res.json(brands.sort((a,b) => a.name.localeCompare(b.name)));
  });

  app.put('/api/brand-files', express.raw({type:'application/octet-stream',limit:'128mb'}), async (req,res) => {
    if (!Buffer.isBuffer(req.body)) throw invalid('Could not read the file.');
    const hash = await saveFile(req.body);
    res.json({hash});
  });

  app.post('/api/brands', async (req,res) => {
    const {name, files:submitted, version = 0, id = randomUUID()} = req.body || {};
    if (!uuid.test(id) || !Number.isSafeInteger(version) || version < 0 ||
        !Array.isArray(submitted)) throw invalid('Check the brand name and files.');
    const title = brandName(name);
    const entries = submitted.filter(file => !(typeof file?.name === 'string' && isJunkPath(file.name)));
    const paths = new Set();
    for (const file of entries) {
      const label = typeof file?.name === 'string' ? file.name : '(no name)';
      if (typeof file?.name !== 'string' || file.name.includes('\\') || classifyProjectFile('assets/' + file.name) !== 'upload') {
        throw invalid('Invalid brand file or path: ' + label);
      }
      if (!/^[a-f0-9]{64}$/.test(file.hash)) throw invalid('This file was not uploaded correctly, add it again: ' + label);
      if (paths.has(file.name)) throw invalid('This file is listed twice: ' + label);
      paths.add(file.name);
    }
    for (const file of entries) {
      let parent = path.posix.dirname(file.name);
      while (parent !== '.') {
        if (paths.has(parent)) throw invalid('A file already uses this path: ' + parent);
        parent = path.posix.dirname(parent);
      }
      if (!await store.blobs.head(files + file.hash)) throw invalid('Upload this file: ' + file.name);
    }
    let previous = version ? await readBrand(id, version) : null;
    let nextFiles = entries.map(({name, hash}) => ({name, hash}));
    // The notes may have been written (or a decision remembered) while this editor was open. Versions that changed
    // nothing but the notes do not make the edit stale: it is applied on top of them and keeps their notes.
    if (previous) {
      const latest = await latestBrand(id);
      if (latest && latest.version > previous.version && latest.name === previous.name && brandFilesHash(latest.files) === brandFilesHash(previous.files)) {
        const baseNotes = previous.files.find(f => f.name === BRAND_NOTES_FILE)?.hash;
        const sentNotes = nextFiles.find(f => f.name === BRAND_NOTES_FILE)?.hash;
        const latestNotes = latest.files.find(f => f.name === BRAND_NOTES_FILE);
        const deleted = baseNotes && !sentNotes;
        if (sentNotes === baseNotes && !deleted) {
          nextFiles = nextFiles.filter(f => f.name !== BRAND_NOTES_FILE);
          if (latestNotes) nextFiles.push({name:latestNotes.name, hash:latestNotes.hash});
        }
        previous = latest;
      }
    }
    const brand = {id, version:(previous?.version || 0) + 1, name:title, files:nextFiles, ...(previous?.origin ? {origin:previous.origin} : {}), ...(previous?.figma ? {figma:previous.figma} : {})};
    const notesFile = brand.files.find(f => f.name === BRAND_NOTES_FILE);
    if (notesFile) {
      const kept = previous?.files.find(f => f.name === BRAND_NOTES_FILE)?.hash === notesFile.hash;
      brand.notes = kept && previous.notes ? previous.notes : {source:'supplied', at:new Date().toISOString(), basedOn:brandFilesHash(brand.files)};
    }
    await writeVersion(brand);
    // Notes are written in the background while the client fills in the campaign questionnaire.
    // Demo mode never writes them on its own: placeholder notes would block the real ones.
    if (!notesFile && req.body?.provider?.mode && req.body.provider.mode !== 'demo') startBrandNotes(id, req.body.provider, deps);
    res.status(201).json(brand);
  });

  // Import only original uploads. Generated media and revision attachments belong to the campaign.
  app.post('/api/campaigns/:id/brand', async (req,res) => {
    const campaign = await store.history.get(req.params.id);
    if (campaign?.type !== 'campaign') throw invalid('Campaign not found.', 404);
    const name = brandName(req.body?.name);
    if (campaign.brandId) return res.json(await readBrand(campaign.brandId, campaign.brandVersion));
    const id = campaign.id;
    const key = versionKey(id, 1);
    if (!await store.blobs.head(key)) {
      const prefix = 'projects/' + campaign.project + '/';
      const entries = [];
      for (const {key:objectKey} of await store.blobs.list(prefix + 'assets/')) {
        const rel = objectKey.slice(prefix.length);
        if (classifyProjectFile(rel) !== 'upload') continue;
        const body = await store.blobs.get(objectKey);
        if (!body) throw invalid('Material not found: ' + rel, 409);
        entries.push({name:rel.slice('assets/'.length), hash:await saveFile(await streamToBuffer(body))});
      }
      const brand = {id, version:1, name, files:entries};
      await writeVersion(brand);
    }
    await store.history.update(campaign.id, {brandId:id, brandVersion:1});
    const imported = await readBrand(id, 1);
    if (req.body?.provider?.mode && req.body.provider.mode !== 'demo' && !imported.files.some(f => f.name === BRAND_NOTES_FILE)) startBrandNotes(id, req.body.provider, deps);
    res.json(imported);
  });

  // The brand book board (brand-board.mjs): for people only, never part of a step or a model's input.
  app.get('/api/brands/:id/board', async (req,res) => {
    const brand = await latestBrand(req.params.id);
    if (!brand) throw invalid('Brand not found.', 404);
    const texts = [];
    for (const f of brand.files.filter(f => readsColours(f.name)).slice(0, 200)) {
      const body = await store.blobs.get(files + f.hash);
      if (!body) continue;
      const buf = await streamToBuffer(body);
      if (buf.length <= BOARD_TEXT_LIMIT) texts.push({name:f.name, text:buf.toString('utf8')});
    }
    res.set('Cache-Control','no-store').json(buildBoard(brand, {colours:extractColours(texts), figmaConfigured:Boolean(figmaToken())}));
  });

  app.get('/api/figma/status', async (_req,res) => {
    res.set('Cache-Control','no-store').json(await figmaStatus());
  });

  // "Read Figma": the file's frames and styles become brand files (figma.mjs). Notes are written if there are none yet.
  app.post('/api/brands/:id/figma', async (req,res) => {
    const latest = await latestBrand(req.params.id);
    if (!latest) throw invalid('Brand not found.', 404);
    const read = await readFigma(req.body?.url, {log:message => console.log('[figma] ' + message)});
    if (!read.files.length) throw invalid('Nothing could be read from this file' + (read.skipped[0] ? ': ' + read.skipped[0].reason : '.'), 422);
    const brand = await addFigmaFiles(latest.id, read);
    const notes = await notesAfterNewFiles(brand, req.body?.provider, deps);
    res.json({brand, read:{fileName:read.fileName, frames:read.frames, styles:read.styles, skipped:read.skipped}, notes});
  });

  // One brand file, by version and path. Versions are immutable, so the browser may keep it.
  app.get('/api/brands/:id/file', async (req,res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    const brand = await readBrand(req.params.id, Number(req.query.v));
    const file = brand.files.find(f => f.name === name);
    if (!file) throw invalid('File not found.', 404);
    const body = await store.blobs.get(files + file.hash);
    if (!body) throw invalid('The file is missing from storage.', 404);
    const buf = await streamToBuffer(body);
    const type = /\.pdf$/i.test(name) ? 'application/pdf' : /\.(md|txt)$/i.test(name) ? 'text/plain; charset=utf-8' : contentTypeForPath(name);
    const inline = /\.(png|jpe?g|gif|webp|avif|svg|pdf|mp4|mov|webm|m4v|md|txt|ttf|otf|woff2?)$/i.test(name) && req.query.download !== '1';
    res.set({'Content-Type':type, 'Accept-Ranges':'bytes', 'Cache-Control':'private, max-age=86400, immutable', 'X-Content-Type-Options':'nosniff',
      'Content-Disposition':`${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.posix.basename(name))}`});
    if (/\.svg$/i.test(name)) res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, buf.length - Number(range[2]));
      let end = range[1] && range[2] ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1;
      if (start >= buf.length || start > end) return res.status(416).set('Content-Range', `bytes */${buf.length}`).end();
      return res.status(206).set({'Content-Range':`bytes ${start}-${end}/${buf.length}`, 'Content-Length':String(end - start + 1)}).end(buf.subarray(start, end + 1));
    }
    res.set('Content-Length', String(buf.length)).end(buf);
  });

  app.get('/api/brands/:id/notes', async (req,res) => {
    const brand = await latestBrand(req.params.id);
    if (!brand) throw invalid('Brand not found.', 404);
    res.set('Cache-Control','no-store').json(await brandNotesStatus(brand));
  });

  // Hand edits: the text is saved as is, and never overwritten without an explicit rewrite.
  app.put('/api/brands/:id/notes', async (req,res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.replace(/\r\n/g, '\n').trim() : '';
    if (!text || text.length > 20000) throw invalid('Write the brand notes (up to 20,000 characters).');
    if (brandNotesWriting(req.params.id)) throw invalid('The notes are being written. Wait for them to finish.', 409);
    const latest = await latestBrand(req.params.id);
    if (!latest) throw invalid('Brand not found.', 404);
    const brand = await saveBrandNotes(req.params.id, text + '\n', {source:'edited', at:new Date().toISOString(), basedOn:latest.notes?.basedOn ?? brandFilesHash(latest.files)}, {expectVersion:Number(req.body?.version) || undefined});
    res.json(await brandNotesStatus(brand));
  });

  // Answer an open question: it becomes a client decision and leaves the list.
  app.post('/api/brands/:id/notes/decide', async (req,res) => {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    const decision = typeof req.body?.decision === 'string' ? req.body.decision.replace(/\s+/g, ' ').trim() : '';
    if (!question || !decision || decision.length > 500) throw invalid('Write the answer (up to 500 characters).');
    if (brandNotesWriting(req.params.id)) throw invalid('The notes are being written. Wait for them to finish.', 409);
    const latest = await latestBrand(req.params.id);
    if (!latest) throw invalid('Brand not found.', 404);
    const text = await brandNotesText(latest);
    if (!openQuestions(text).includes(question)) throw invalid('This question is no longer open. Refresh the page.', 409);
    const brand = await saveBrandNotes(latest.id, decideOpenQuestion(text, question, decision), {...(latest.notes || {source:'supplied'}), at:new Date().toISOString()}, {expectVersion:latest.version});
    res.json(await brandNotesStatus(brand));
  });

  // Write (or rewrite) the notes with a model. Client decisions survive a rewrite.
  app.post('/api/brands/:id/notes', async (req,res) => {
    const latest = await latestBrand(req.params.id);
    if (!latest) throw invalid('Brand not found.', 404);
    const provider = req.body?.provider || {mode:'demo'};
    if (!startBrandNotes(latest.id, provider, deps, {force:true})) throw invalid('This provider cannot write brand notes here.', 400);
    res.status(202).json(await brandNotesStatus(latest));
  });

  app.get('/api/brand-campaigns', async (req,res) => {
    const result = [];
    let before;
    do {
      const page = await store.history.list({type:'campaign', before, limit:200});
      const campaigns = page.items.filter(c => c.status !== 'merged' && (c.brandId || '') === (req.query.brand || ''));
      for (const c of campaigns) {
        const summary = {id:c.id, name:c.name, kind:c.setup?.kind, updatedAt:c.updatedAt || c.createdAt};
        if (req.query.covers === '1') summary.cover = await campaignCover(c);
        result.push(summary);
      }
      before = page.next;
    } while (before);
    res.json(result);
  });
}
