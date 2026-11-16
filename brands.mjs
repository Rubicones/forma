// Immutable versions let campaigns keep the exact brand materials they started with.
import {randomUUID, createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {createWriteStream} from 'node:fs';
import express from 'express';
import {store} from './store/index.mjs';
import {classifyProjectFile, streamToBuffer} from './store/supabase.mjs';

const manifests = 'brands/versions/';
const files = 'brands/files/';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const invalid = (message, status = 400) => Object.assign(Error(message), {status});
// OS and VCS clutter that folder drops bring along (.DS_Store, __MACOSX, Thumbs.db, hidden dirs): dropped, not rejected.
const isJunkPath = name => name.split('/').some(seg => (seg.startsWith('.') && seg !== '.' && seg !== '..') || seg === '__MACOSX' || /^(thumbs\.db|desktop\.ini)$/i.test(seg));

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

export function registerBrandRoutes(app) {
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
    if (version) await readBrand(id, version);
    const brand = {id, version:version + 1, name:title, files:entries.map(({name, hash}) => ({name, hash}))};
    await writeVersion(brand);
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
    res.json(await readBrand(id, 1));
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
