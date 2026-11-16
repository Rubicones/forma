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
  if (!uuid.test(id) || !Number.isSafeInteger(version) || version < 1) throw invalid('Выберите сохранённый бренд.');
  const body = await store.blobs.get(versionKey(id, version));
  if (!body) throw invalid('Версия бренда не найдена.', 404);
  return JSON.parse((await streamToBuffer(body)).toString());
}

async function saveFile(bytes) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (!await store.blobs.head(files + hash)) await store.blobs.put(files + hash, bytes, {sha256:hash});
  return hash;
}

function brandName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 160) throw invalid('Введите название бренда (до 160 символов).');
  return name;
}

const versionKey = (id, version) => manifests + id + '/' + version + '.json';

async function writeVersion(brand) {
  try {
    await store.blobs.put(versionKey(brand.id, brand.version), Buffer.from(JSON.stringify(brand)), {ifAbsent:true});
  } catch (err) {
    if (err.code === 'EEXIST' || err.name === 'PreconditionFailed' || err.$metadata?.httpStatusCode === 412) {
      throw invalid('Бренд уже изменён. Обновите страницу и повторите правку.', 409);
    }
    throw err;
  }
}

export async function materializeBrand(id, version, project, dir) {
  const brand = await readBrand(id, version);
  for (const {name, hash} of brand.files) {
    const source = await store.blobs.get(files + hash);
    if (!source) throw invalid('В хранилище отсутствует файл бренда: ' + name, 409);
    const dest = path.join(dir, 'assets', name);
    await fs.mkdir(path.dirname(dest), {recursive:true});
    await pipeline(source, createWriteStream(dest, {flags:'wx'}));
  }
  await store.sync.up(project, {dataDir:path.dirname(dir)});
}

export function registerBrandRoutes(app) {
  app.get('/api/brands', async (_req, res) => {
    const versions = await latestVersions();
    const brands = await Promise.all([...versions].map(([id, version]) => readBrand(id, version)));
    res.json(brands.sort((a,b) => a.name.localeCompare(b.name)));
  });

  app.put('/api/brand-files', express.raw({type:'application/octet-stream',limit:'128mb'}), async (req,res) => {
    if (!Buffer.isBuffer(req.body)) throw invalid('Не удалось прочитать файл.');
    const hash = await saveFile(req.body);
    res.json({hash});
  });

  app.post('/api/brands', async (req,res) => {
    const {name, files:entries, version = 0, id = randomUUID()} = req.body || {};
    if (!uuid.test(id) || !Number.isSafeInteger(version) || version < 0 ||
        !Array.isArray(entries)) throw invalid('Проверьте название и файлы бренда.');
    const title = brandName(name);
    const paths = new Set();
    for (const file of entries) {
      if (typeof file?.name !== 'string' || file.name.includes('\\') || classifyProjectFile('assets/' + file.name) !== 'upload' ||
          !/^[a-f0-9]{64}$/.test(file.hash) || paths.has(file.name)) throw invalid('Некорректный путь или файл бренда.');
      paths.add(file.name);
    }
    for (const file of entries) {
      let parent = path.posix.dirname(file.name);
      while (parent !== '.') {
        if (paths.has(parent)) throw invalid('Путь занят файлом: ' + parent);
        parent = path.posix.dirname(parent);
      }
      if (!await store.blobs.head(files + file.hash)) throw invalid('Загрузите файл: ' + file.name);
    }
    if (version) await readBrand(id, version);
    const brand = {id, version:version + 1, name:title, files:entries.map(({name, hash}) => ({name, hash}))};
    await writeVersion(brand);
    res.status(201).json(brand);
  });

  // Import only original uploads. Generated media and revision attachments belong to the campaign.
  app.post('/api/campaigns/:id/brand', async (req,res) => {
    const campaign = await store.history.get(req.params.id);
    if (campaign?.type !== 'campaign') throw invalid('Кампания не найдена.', 404);
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
        if (!body) throw invalid('Не найден материал ' + rel, 409);
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
      result.push(...page.items.filter(c => c.status !== 'merged' && (c.brandId || '') === (req.query.brand || ''))
        .map(({id,name,setup,updatedAt,createdAt}) => ({id,name,kind:setup?.kind,updatedAt:updatedAt || createdAt})));
      before = page.next;
    } while (before);
    res.json(result);
  });
}
