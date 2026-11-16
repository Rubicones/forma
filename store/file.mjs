// Local filesystem store driver (FORMA_STORE=file, the default).
// Preserves today's on-disk behaviour while exposing the async store interface (§2).
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {getJob, snapshot} from '../jobs.mjs';

const index = new Map();
const assetIndex = new Map(); // projectId -> Map<relPath, row>
const activeRuns = new Map(); // runId -> run record
const campaignRunLock = new Map(); // campaignId -> runId

let dataRoot = path.resolve(process.env.DATA_DIR || 'data');
let historyDir = path.join(dataRoot, 'history');

const valid = id => /^[0-9a-f-]{36}$/.test(String(id || ''));
const light = ({log, ...entry}) => {
  const out = {
    ...entry,
    logSize: entry.logSize ?? (Array.isArray(log) ? log.length : 0),
  };
  if (out.type === 'campaign' && (!Array.isArray(out.variants) || !out.variants.length)) {
    const s = out.steps || {};
    const vid = out.id;
    const dir = s.styles?.direction || '';
    const firstLine = dir.includes('\n\n') ? dir.split('\n\n')[0].trim() : '';
    const v0 = {
      id: vid,
      label: s.styles?.label || (firstLine && firstLine.length <= 80 ? firstLine : 'Стиль 1'),
      createdAt: out.createdAt || new Date().toISOString(),
      author: out.author ?? null,
      styles: {
        entryId: s.styles?.entryId ?? null,
        chosenIndex: s.styles?.chosenIndex ?? null,
        direction: dir,
      },
      preview: {
        entryId: s.preview?.entryId ?? null,
        approvedAt: s.preview?.approvedAt ?? null,
        stale: Boolean(s.preview?.stale),
      },
      final: {
        entryId: s.final?.entryId ?? null,
        stale: Boolean(s.final?.stale),
      },
      cost: out.cost ? structuredClone(out.cost) : {llm: 0, image: 0, video: 0, total: 0, unknown: false},
    };
    out.variants = [v0];
    out.activeVariant = vid;
  }
  return out;
};

async function readRaw(id) {
  if (!valid(id) || !index.has(id)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(historyDir, id + '.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function save(entry) {
  await fs.mkdir(historyDir, {recursive: true});
  const file = path.join(historyDir, entry.id + '.json');
  const temp = file + '.' + process.pid + '.' + randomUUID().slice(0, 8) + '.tmp';
  await fs.writeFile(temp, JSON.stringify(entry, null, 1));
  await fs.rename(temp, file);
  index.set(entry.id, light(entry));
  return entry;
}

export async function open(dataDir) {
  index.clear();
  if (dataDir) dataRoot = path.resolve(dataDir);
  historyDir = path.join(dataRoot, 'history');
  await fs.mkdir(historyDir, {recursive: true});
  for (const name of await fs.readdir(historyDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const entry = JSON.parse(await fs.readFile(path.join(historyDir, name), 'utf8'));
      index.set(entry.id, light(entry));
    } catch (error) {
      console.warn('[history] skipped broken entry', name, error.message);
    }
  }
  return index.size;
}

export const openHistory = open;

export async function record(entry) {
  const author = entry.author ?? process.env.FORMA_AUTHOR ?? null;
  const full = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'ok',
    log: [],
    ...entry,
    ...(author ? {author} : {}),
  };
  if (!valid(full.id)) full.id = randomUUID();
  return save(full);
}

export async function update(id, patch) {
  const entry = await readRaw(id);
  if (!entry) return null;
  const next = {...entry, ...patch};
  if (entry.input !== undefined || patch.input !== undefined) {
    next.input = {...entry.input, ...patch.input};
  }
  if (entry.type === 'campaign' && !patch.updatedAt) {
    next.updatedAt = new Date().toISOString();
  }
  if (process.env.FORMA_AUTHOR && !patch.author) {
    next.author = process.env.FORMA_AUTHOR;
  }
  next.version = (Number(entry.version) || 1) + 1;
  return save(next);
}

export async function get(id, {withLog = false} = {}) {
  const raw = await readRaw(id);
  if (!raw) return null;
  const logSize = Array.isArray(raw.log) ? raw.log.length : (raw.logSize || 0);
  const version = Number(raw.version) || 1;
  if (withLog) {
    return {...raw, log: Array.isArray(raw.log) ? raw.log : [], logSize, version};
  }
  return {...raw, log: [], logSize, version};
}

// Newest first. `before` is the updatedAt/createdAt of the last item of the previous page.
export async function list({type, project, path: outputPath, campaign, author, excludeAuthor, before, limit = 30} = {}) {
  let items = [...index.values()];
  if (type) items = items.filter(e => e.type === type);
  if (campaign === 'none') items = items.filter(e => !e.campaign && e.type !== 'campaign');
  else if (campaign) items = items.filter(e => e.campaign === campaign);
  if (outputPath) items = items.filter(e => e.output?.path === outputPath);
  if (project) items = items.filter(e => e.project === project);
  if (author) items = items.filter(e => e.author === author);
  if (excludeAuthor) items = items.filter(e => e.author && e.author !== excludeAuthor);
  items.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  const total = items.length;
  if (before) items = items.filter(e => (e.updatedAt || e.createdAt) < before);
  const page = items.slice(0, Math.min(Math.max(Number(limit) || 30, 1), 200));
  return {
    items: page,
    next: items.length > page.length ? (page.at(-1).updatedAt || page.at(-1).createdAt) : null,
    total,
  };
}

export async function findBy(predicate) {
  return [...index.values()].find(predicate);
}

// Chat thread of a creative: its chain of revision parents, oldest first (max 50 steps).
export async function thread(id) {
  const chain = [];
  let current = await readRaw(id);
  while (current && chain.length < 50) {
    chain.unshift(light(current));
    const parent = current.input?.revision?.parent;
    current = parent ? await readRaw(parent) : null;
  }
  return chain;
}

// The style field may carry the chosen SVG keyframe appended by the UI; keep them apart.
const REFERENCE = '\nUse this selected reference keyframe as the visual target for the animation:\n';
export function splitStyle(style = '') {
  const at = style.indexOf(REFERENCE);
  return at < 0 ? {style} : {style: style.slice(0, at), referenceSvg: style.slice(at + REFERENCE.length)};
}

// Reads formats and duration back from the runtime injected into a saved creative.
export function creativeMeta(html) {
  const match = html.match(/\)\((\[\{"id":[\s\S]*?\}\]),(\d+)\)<\/script>/);
  if (match) {
    try {
      return {formats: JSON.parse(match[1]).map(f => f.id), duration: Number(match[2])};
    } catch {}
  }
  return {formats: ['1x1'], duration: 6};
}

// One-time import of creatives that were saved before history existed.
export async function importExisting(dataDir) {
  const targetDir = dataDir ? path.resolve(dataDir) : dataRoot;
  const known = new Set(
    [...index.values()]
      .filter(e => (e.type === 'creative' || e.type === 'preview') && e.output?.path)
      .map(e => e.output.path)
  );
  let added = 0;
  for (const project of await fs.readdir(targetDir).catch(() => [])) {
    if (!valid(project)) continue;
    const folder = path.join(targetDir, project);
    const names = await fs.readdir(folder).catch(() => []);
    const assets = (await fs.readdir(path.join(folder, 'assets'), {recursive: true, withFileTypes: true}).catch(() => []))
      .filter(e => e.isFile())
      .map(e => path.relative(path.join(folder, 'assets'), path.join(e.parentPath, e.name)));
    for (const name of names) {
      const revision = name.replace(/\.html$/, '');
      if (!name.endsWith('.html') || !valid(revision)) continue;
      const rel = '/p/' + project + '/' + name;
      if (known.has(rel)) continue;
      const file = path.join(folder, name);
      const stat = await fs.stat(file);
      const meta = creativeMeta(await fs.readFile(file, 'utf8'));
      const created = stat.birthtimeMs > 0 && stat.birthtimeMs < stat.mtimeMs ? stat.birthtime : stat.mtime;
      await record({
        type: 'creative',
        imported: 'files',
        createdAt: created.toISOString(),
        project,
        mode: null,
        input: {scenario: '', style: '', formats: meta.formats, duration: meta.duration, files: assets},
        output: {revision, path: rel, ...meta},
        media: assets
          .filter(a => a.startsWith('generated/'))
          .map(a => ({kind: /\.mp4$/i.test(a) ? 'video' : 'image', file: a, path: '/p/' + project + '/assets/' + a})),
        log: [{at: 0, level: 'info', msg: 'Импортировано из data/ (журнал до появления истории не сохранялся)'}],
      });
      known.add(rel);
      added++;
    }
  }
  return added;
}

// Local fs blob helpers for store.blobs
function keyToFilePath(key) {
  const clean = String(key || '').replace(/^\/+/, '');
  if (clean.startsWith('projects/')) {
    return path.join(dataRoot, clean.slice('projects/'.length));
  }
  return path.join(dataRoot, clean);
}

async function streamToBuffer(stream) {
  if (Buffer.isBuffer(stream)) return stream;
  if (typeof stream === 'string') return Buffer.from(stream);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const blobs = {
  async put(key, bufOrStream, {contentType, sha256, ifAbsent} = {}) {
    const file = keyToFilePath(key);
    await fs.mkdir(path.dirname(file), {recursive: true});
    const buf = await streamToBuffer(bufOrStream);
    const tmp = file + '.' + randomUUID() + '.tmp';
    await fs.writeFile(tmp, buf);
    try {
      if (ifAbsent) await fs.link(tmp, file);
      else await fs.rename(tmp, file);
    } finally { await fs.rm(tmp, {force:true}); }
    const digest = sha256 || createHash('sha256').update(buf).digest('hex');
    return {key, size: buf.length, sha256: digest, contentType: contentType || null};
  },
  async get(key) {
    const file = keyToFilePath(key);
    try {
      await fs.access(file);
      return createReadStream(file);
    } catch {
      return null;
    }
  },
  async head(key) {
    const file = keyToFilePath(key);
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) return null;
      const buf = await fs.readFile(file);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      return {key, size: st.size, sha256};
    } catch {
      return null;
    }
  },
  async list(prefix = '') {
    const clean = String(prefix || '').replace(/^\/+/, '');
    const base = keyToFilePath(clean);
    const dir = clean.endsWith('/') ? base : path.dirname(base);
    const entries = await fs.readdir(dir, {recursive: true, withFileTypes: true}).catch(() => []);
    const out = [];
    for (const e of entries) {
      if (!e.isFile() || e.name.endsWith('.tmp') || e.name.startsWith('.')) continue;
      const full = path.join(e.parentPath, e.name);
      const relFromData = path.relative(dataRoot, full).split(path.sep).join('/');
      const key = relFromData.startsWith('brands/') || relFromData.startsWith('logs/') || relFromData.startsWith('history/')
        ? relFromData
        : 'projects/' + relFromData;
      if (clean && !key.startsWith(clean)) continue;
      const st = await fs.stat(full);
      out.push({key, size: st.size});
    }
    return out;
  },
};

const assets = {
  async index(project) {
    const map = assetIndex.get(project);
    return map ? [...map.values()] : [];
  },
  async upsert(project, rows = []) {
    let map = assetIndex.get(project);
    if (!map) {
      map = new Map();
      assetIndex.set(project, map);
    }
    for (const r of rows) {
      map.set(r.path, {...r});
    }
    return rows.length;
  },
  async remove(project, relPath) {
    const map = assetIndex.get(project);
    if (map) map.delete(relPath);
  },
};

const runs = {
  async start({id, campaignId = null, projectId = null, task, author = null}) {
    if (campaignId && campaignRunLock.has(campaignId)) {
      const activeId = campaignRunLock.get(campaignId);
      const activeRun = activeRuns.get(activeId);
      const who = activeRun?.author ? ` (запущен ${activeRun.author})` : '';
      const err = Object.assign(Error(`Дождитесь окончания текущего шага${who}.`), {status: 409});
      throw err;
    }
    const now = new Date().toISOString();
    const rec = {
      id,
      campaignId,
      projectId,
      entryId: null,
      task,
      author,
      status: 'running',
      statusText: '',
      costs: {llm: 0, image: 0, video: 0, total: 0, unknown: false},
      startedAt: now,
      heartbeatAt: now,
      finishedAt: null,
      events: [],
    };
    activeRuns.set(id, rec);
    if (campaignId) campaignRunLock.set(campaignId, id);
    return rec;
  },
  async heartbeat(id, patch = {}) {
    const rec = activeRuns.get(id);
    if (!rec) return null;
    rec.heartbeatAt = new Date().toISOString();
    if (patch.statusText !== undefined) rec.statusText = patch.statusText;
    if (patch.costs !== undefined) rec.costs = patch.costs;
    return rec;
  },
  async events(id, batch = []) {
    const rec = activeRuns.get(id);
    if (!rec) return;
    for (const ev of batch) {
      rec.events.push(ev);
    }
  },
  async finish(id, {status = 'done', statusText, costs, entryId} = {}) {
    const rec = activeRuns.get(id);
    if (!rec) return null;
    rec.status = status;
    if (statusText !== undefined) rec.statusText = statusText;
    if (costs !== undefined) rec.costs = costs;
    if (entryId !== undefined) rec.entryId = entryId;
    rec.finishedAt = new Date().toISOString();
    if (rec.campaignId && campaignRunLock.get(rec.campaignId) === id) {
      campaignRunLock.delete(rec.campaignId);
    }
    return rec;
  },
  async active() {
    return [...activeRuns.values()].filter(r => r.status === 'running');
  },
  async get(id, since = 0) {
    const job = getJob(id);
    if (job) return snapshot(job, since);
    const rec = activeRuns.get(id);
    if (!rec) return {missing: true};
    return {
      status: rec.statusText || rec.status,
      done: rec.status !== 'running',
      elapsed: Date.now() - new Date(rec.startedAt).getTime(),
      costs: rec.costs,
      events: rec.events.slice(since),
      next: rec.events.length,
    };
  },
};

const sync = {
  async down(_project) {
    return {downloaded: 0};
  },
  async up(_project, _opts = {}) {
    return {uploaded: 0};
  },
};

export const fileStore = {
  driver: 'file',
  async status() {
    return {
      driver: 'file',
      author: process.env.FORMA_AUTHOR || null,
      ready: true,
    };
  },
  async registerProject(_id) {},
  history: {
    open,
    openHistory,
    record,
    update,
    get,
    list,
    thread,
    findBy,
    importExisting,
    splitStyle,
    creativeMeta,
  },
  blobs,
  assets,
  runs,
  sync,
};
