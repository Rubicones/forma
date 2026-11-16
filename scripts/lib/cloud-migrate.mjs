// Core of scripts/migrate-to-cloud.mjs and scripts/pull-from-cloud.mjs (§6 of docs/cloud-sync-prompt.md).
// Every function takes an injected `cloud` driver with the store contract (createSupabaseStore / createMemoryCloud):
// {status, registerProject, history:{get,list,record,update,thread}, blobs:{put,get,head,list}, assets:{index,upsert}}.
// Nothing here deletes or modifies local files; only scanLocal reads, writeReport writes the report.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {classifyProjectFile, contentTypeForPath, entryToRow, streamToBuffer} from '../../store/supabase.mjs';
import {upgradeCampaign} from '../../campaigns.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const stable = value => JSON.stringify(value, (key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const docHash = doc => sha256(Buffer.from(stable(doc)));
export const mb = bytes => (bytes / 1024 / 1024).toFixed(1) + ' МБ';

async function pool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(concurrency, items.length) || 0}, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}
async function retry(fn, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (error) {
      if (attempt >= tries) throw error;
      await new Promise(r => setTimeout(r, 250 * 2 ** (attempt - 1)));
    }
  }
}

// Deterministic UUID from a seed, so re-running the migration produces identical documents.
export function seededUUID(seed) {
  const h = sha256(Buffer.from(String(seed)));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 + (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// upgradeCampaign + stable variant ids (upgradeCampaign itself uses random UUIDs for new variants).
export function upgradeForCloud(doc) {
  const hadVariants = Array.isArray(doc.variants) && doc.variants.length > 0;
  const up = upgradeCampaign(doc);
  if (!hadVariants && up.variants?.length === 1) {
    const id = seededUUID(doc.id + ':variant:0');
    up.variants[0].id = id;
    up.activeVariant = id;
  }
  return up;
}

// ---------- local scan ----------
export async function scanLocal(dataDir) {
  const root = path.resolve(dataDir);
  const projects = [], files = [], entries = [], broken = [];
  for (const name of await fs.readdir(root).catch(() => [])) {
    if (!UUID.test(name)) continue;
    const dir = path.join(root, name);
    const st = await fs.stat(dir).catch(() => null);
    if (!st?.isDirectory()) continue;
    const created = st.birthtimeMs > 0 && st.birthtimeMs <= st.mtimeMs ? st.birthtime : st.mtime;
    projects.push({id:name, createdAt:created.toISOString()});
    for (const e of await fs.readdir(dir, {recursive:true, withFileTypes:true})) {
      if (!e.isFile()) continue;
      const full = path.join(e.parentPath, e.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      const kind = classifyProjectFile(rel);
      if (!kind) continue;
      const fst = await fs.stat(full);
      files.push({project:name, rel, kind, size:fst.size, full, key:`projects/${name}/${rel}`});
    }
  }
  const historyDir = path.join(root, 'history');
  for (const name of await fs.readdir(historyDir).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    try {
      const entry = JSON.parse(await fs.readFile(path.join(historyDir, name), 'utf8'));
      if (!entry?.id || !UUID.test(entry.id) || !entry.type) throw Error('no id/type');
      entries.push(entry);
    } catch (error) { broken.push({file:name, error:error.message}); }
  }
  return {root, projects, files, entries, broken};
}

// Files referenced by no entry (still migrated; reported so the owner knows what is loose).
export function orphanFiles(scan) {
  const referenced = new Set();
  const addPath = (project, rel) => project && rel && referenced.add(project + '/' + rel);
  for (const e of scan.entries) {
    const project = e.project;
    const out = e.output?.path;
    if (typeof out === 'string') {
      const m = out.match(/^\/p\/([^/]+)\/(.+)$/);
      if (m) { addPath(m[1], m[2]); addPath(m[1], m[2].replace(/\.html$/, '.src.html')); }
    }
    for (const media of e.media || []) addPath(project, 'assets/' + media.file);
    for (const a of e.input?.revision?.attachments || []) addPath(project, 'assets/' + a);
    for (const f of e.input?.files || []) addPath(project, 'assets/' + f);
  }
  return scan.files.filter(f => !referenced.has(f.project + '/' + f.rel));
}

export function summarize(scan) {
  const byKind = {}, byType = {};
  for (const f of scan.files) { byKind[f.kind] ??= {count:0, bytes:0}; byKind[f.kind].count++; byKind[f.kind].bytes += f.size; }
  for (const e of scan.entries) byType[e.type] = (byType[e.type] || 0) + 1;
  return {projects:scan.projects.length, files:scan.files.length, bytes:scan.files.reduce((a, f) => a + f.size, 0),
    byKind, entries:scan.entries.length, byType, broken:scan.broken.length, orphans:orphanFiles(scan).length};
}

// ---------- fork merging ----------
const FORK_SUFFIX = /\s\((копия|ветка|[^()]{1,80})\)$/;
// Campaigns that share one scenario entry are style forks of the earliest one.
export function planForkMerges(campaigns) {
  const groups = new Map();
  for (const c of campaigns) {
    if (c.status === 'merged') continue;
    const sc = c.steps?.scenario?.entryId;
    if (!sc) continue;
    if (!groups.has(sc)) groups.set(sc, []);
    groups.get(sc).push(c);
  }
  const merges = [];
  for (const [scenarioId, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const [base, ...forks] = list;
    merges.push({scenarioId, base:{id:base.id, name:base.name}, forks:forks.map(f => ({id:f.id, name:f.name, suffix:FORK_SUFFIX.test(f.name || '')}))});
  }
  return merges;
}

const sameVariant = (a, b) => a.styles?.entryId && a.styles.entryId === b.styles?.entryId && a.styles.chosenIndex === b.styles?.chosenIndex
  && (a.preview?.entryId || null) === (b.preview?.entryId || null) && (a.final?.entryId || null) === (b.final?.entryId || null);
const sumCost = (a = {}, b = {}) => ({llm:(a.llm || 0) + (b.llm || 0), image:(a.image || 0) + (b.image || 0), video:(a.video || 0) + (b.video || 0),
  total:(a.total || 0) + (b.total || 0), unknown:Boolean(a.unknown || b.unknown)});

// Pure: returns the updated base campaign and the merged fork docs.
export function mergeForkDocs(base, forks) {
  const out = upgradeForCloud(base);
  const merged = [];
  for (const forkDoc of forks) {
    const fork = upgradeForCloud(forkDoc);
    for (const v of fork.variants || []) {
      if (out.variants.some(existing => existing.id === v.id || sameVariant(existing, v))) continue;
      const suffix = (forkDoc.name || '').match(FORK_SUFFIX)?.[1];
      out.variants.push({...structuredClone(v), label:suffix && !/^(копия|ветка)$/.test(suffix) ? suffix : v.label, mergedFrom:fork.id});
    }
    out.cost = sumCost(out.cost, fork.cost);
    merged.push({...fork, status:'merged', mergedInto:out.id});
  }
  out.mergedCampaigns = [...new Set([...(out.mergedCampaigns || []), ...forks.map(f => f.id)])];
  return {base:out, merged};
}

// ---------- migration ----------
export async function preflight(cloud) {
  const status = await cloud.status();
  if (!status.ready) throw Error('Облако не готово: ' + (status.error || 'неизвестная ошибка'));
  await cloud.blobs.list('__forma_preflight__/');
  return status;
}

// Prepares the target documents: campaigns upgraded to variants (stable ids), author filled in.
export function prepareEntries(entries, {author, mergeForks = false}) {
  const docs = new Map(entries.map(e => [e.id, structuredClone(e)]));
  for (const doc of docs.values()) {
    if (!doc.author && author) doc.author = author;
    doc.status ??= 'ok'; // history.record() defaults it; mirror that so re-runs compare equal
    if (doc.type === 'campaign') docs.set(doc.id, upgradeForCloud(doc));
  }
  const merges = mergeForks ? planForkMerges([...docs.values()].filter(d => d.type === 'campaign')) : [];
  for (const m of merges) {
    const {base, merged} = mergeForkDocs(docs.get(m.base.id), m.forks.map(f => docs.get(f.id)));
    docs.set(base.id, base);
    for (const f of merged) docs.set(f.id, f);
  }
  // Non-campaign entries first, then campaigns (§6 step 4).
  const ordered = [...docs.values()].sort((a, b) => (a.type === 'campaign') - (b.type === 'campaign') || String(a.createdAt).localeCompare(String(b.createdAt)));
  return {ordered, merges};
}

const rowDoc = entry => entryToRow(entry).doc;

export async function migrate({cloud, dataDir, apply = false, mergeForks = false, concurrency = 4, author, log = () => {}}) {
  const started = Date.now();
  const scan = await scanLocal(dataDir);
  const report = {startedAt:new Date(started).toISOString(), apply, mergeForks, dataDir:scan.root, author,
    summary:summarize(scan), broken:scan.broken, projects:{upserted:0}, files:{uploaded:0, skipped:0, indexed:0, bytes:0, failed:[]},
    entries:{written:0, skipped:0, failed:[]}, merges:[], verify:null};

  // Projects
  if (apply) for (const p of scan.projects) { await cloud.registerProject(p.id, {author}); report.projects.upserted++; }
  else report.projects.upserted = scan.projects.length;

  // Files: R2 object with equal size + sha256 → skip upload, still make sure the index row exists.
  const indexByProject = new Map();
  for (const p of scan.projects) indexByProject.set(p.id, new Map((await cloud.assets.index(p.id).catch(() => [])).map(r => [r.path, r])));
  let done = 0, doneBytes = 0;
  const totalBytes = scan.files.reduce((a, f) => a + f.size, 0);
  const pending = new Map();
  await pool(scan.files, concurrency, async f => {
    try {
      const buf = await fs.readFile(f.full);
      const digest = sha256(buf);
      const head = await retry(() => cloud.blobs.head(f.key));
      const indexed = indexByProject.get(f.project)?.get(f.rel);
      const inR2 = head && head.size === buf.length && head.sha256 === digest;
      if (!inR2) {
        if (apply) await retry(() => cloud.blobs.put(f.key, buf, {contentType:contentTypeForPath(f.rel), sha256:digest}));
        report.files.uploaded++; report.files.bytes += buf.length;
      } else report.files.skipped++;
      if (!(indexed && indexed.sha256 === digest && Number(indexed.size) === buf.length)) {
        if (!pending.has(f.project)) pending.set(f.project, []);
        pending.get(f.project).push({path:f.rel, kind:f.kind, size:buf.length, sha256:digest, contentType:contentTypeForPath(f.rel), author});
      }
    } catch (error) {
      report.files.failed.push({key:f.key, error:error.message});
    }
    done++; doneBytes += f.size;
    if (done % 25 === 0 || done === scan.files.length) {
      const elapsed = (Date.now() - started) / 1000, rate = doneBytes / Math.max(elapsed, 0.1);
      log(`Файлы: ${done}/${scan.files.length} · ${mb(doneBytes)} из ${mb(totalBytes)}` + (done < scan.files.length ? ` · осталось ~${Math.ceil((totalBytes - doneBytes) / Math.max(rate, 1))} с` : ''));
    }
  });
  for (const [project, rows] of pending) {
    for (let i = 0; i < rows.length; i += 200) {
      if (apply) await retry(() => cloud.assets.upsert(project, rows.slice(i, i + 200)));
      report.files.indexed += rows.slice(i, i + 200).length;
    }
  }

  // Entries
  const {ordered, merges} = prepareEntries(scan.entries, {author, mergeForks});
  report.merges = merges;
  for (const doc of ordered) {
    try {
      const existing = await retry(() => cloud.history.get(doc.id));
      const logKey = `logs/${doc.id}.json`;
      const hasLog = Array.isArray(doc.log) && doc.log.length > 0;
      const logOk = !hasLog || Boolean(await retry(() => cloud.blobs.head(logKey)));
      const same = existing && docHash(rowDoc({...existing, log:undefined, logSize:undefined, version:undefined})) === docHash(rowDoc(doc));
      if (same && logOk && (existing.logSize || 0) === (doc.log?.length || 0)) { report.entries.skipped++; continue; }
      if (apply) await retry(() => cloud.history.record(doc));
      report.entries.written++;
    } catch (error) {
      report.entries.failed.push({id:doc.id, type:doc.type, error:error.message});
    }
  }
  log(`Записи: записать ${report.entries.written}, без изменений ${report.entries.skipped}` + (report.entries.failed.length ? `, ошибок ${report.entries.failed.length}` : ''));

  if (apply) report.verify = await verify({cloud, scan, ordered, log});
  report.finishedAt = new Date().toISOString();
  report.durationSec = Math.round((Date.now() - started) / 1000);
  return report;
}

// §6 step 6: counts, every output.path in R2, sha of 10 random files, campaign references, revision threads.
export async function verify({cloud, scan, ordered, log = () => {}, sample = 10}) {
  const problems = [];
  const expected = {};
  for (const e of ordered) expected[e.type] = (expected[e.type] || 0) + 1;
  const counts = {};
  for (const type of Object.keys(expected)) {
    let n = 0, before;
    const ids = new Set(ordered.filter(e => e.type === type).map(e => e.id));
    do {
      const page = await cloud.history.list({type, before, limit:200});
      n += page.items.filter(i => ids.has(i.id)).length;
      before = page.next;
    } while (before);
    counts[type] = n;
    if (n !== expected[type]) problems.push(`Записей типа ${type}: в облаке ${n}, локально ${expected[type]}`);
  }
  for (const e of ordered) {
    const out = e.output?.path;
    if (typeof out !== 'string' || !out.startsWith('/p/')) continue;
    if (!await cloud.blobs.head('projects/' + out.slice(3))) problems.push(`Нет файла в R2: ${out} (запись ${e.id})`);
  }
  const picks = [...scan.files].sort(() => Math.random() - .5).slice(0, sample);
  for (const f of picks) {
    const stream = await cloud.blobs.get(f.key);
    const remote = stream ? sha256(await streamToBuffer(stream)) : null;
    const local = sha256(await fs.readFile(f.full));
    if (remote !== local) problems.push(`Контрольная сумма не совпала: ${f.key}`);
  }
  const ids = new Set(ordered.map(e => e.id));
  for (const c of ordered.filter(e => e.type === 'campaign')) {
    const refs = [c.steps?.scenario?.entryId, ...(c.variants || []).flatMap(v => [v.styles?.entryId, v.preview?.entryId, v.final?.entryId])].filter(Boolean);
    for (const ref of refs) if (!ids.has(ref) && !await cloud.history.get(ref)) problems.push(`Кампания ${c.id} ссылается на отсутствующую запись ${ref}`);
  }
  let threads = 0;
  for (const e of ordered.filter(x => x.input?.revision?.parent)) {
    const chain = await cloud.history.thread(e.id);
    threads++;
    if (chain.length < 2 || chain.at(-1)?.id !== e.id) problems.push(`Цепочка правок не собирается для ${e.id}`);
  }
  log(problems.length ? `Проверка: найдено проблем ${problems.length}` : `Проверка пройдена · записи ${JSON.stringify(counts)} · цепочек правок ${threads} · выборка файлов ${picks.length}`);
  return {ok:!problems.length, counts, threads, sampled:picks.length, problems};
}

export async function writeReport(dataDir, report) {
  const file = path.join(path.resolve(dataDir), 'migration-report.json');
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  return file;
}

// ---------- pull (cloud → fresh local DATA_DIR) ----------
export async function pull({cloud, outDir, concurrency = 6, log = () => {}}) {
  const root = path.resolve(outDir);
  const existing = await fs.readdir(root).catch(() => null);
  if (existing && existing.length) throw Error(`Папка ${root} не пуста. Укажите новую папку — pull никогда не перезаписывает данные.`);
  await fs.mkdir(path.join(root, 'history'), {recursive:true});
  const report = {outDir:root, entries:0, files:0, bytes:0, failed:[]};

  const objects = (await cloud.blobs.list('projects/')).filter(o => {
    const rel = o.key.split('/').slice(2).join('/');
    return UUID.test(o.key.split('/')[1] || '') && classifyProjectFile(rel);
  });
  let done = 0;
  await pool(objects, concurrency, async o => {
    try {
      const target = path.join(root, ...o.key.split('/').slice(1));
      if (!target.startsWith(root + path.sep)) throw Error('unsafe key');
      const stream = await retry(() => cloud.blobs.get(o.key));
      if (!stream) throw Error('missing');
      const buf = await streamToBuffer(stream);
      await fs.mkdir(path.dirname(target), {recursive:true});
      await fs.writeFile(target + '.part', buf);
      await fs.rename(target + '.part', target);
      report.files++; report.bytes += buf.length;
    } catch (error) { report.failed.push({key:o.key, error:error.message}); }
    if (++done % 25 === 0 || done === objects.length) log(`Файлы: ${done}/${objects.length} · ${mb(report.bytes)}`);
  });

  let before;
  do {
    const page = await cloud.history.list({before, limit:200});
    for (const light of page.items) {
      try {
        const {logSize, version, ...entry} = await retry(() => cloud.history.get(light.id, {withLog:true}));
        await fs.writeFile(path.join(root, 'history', entry.id + '.json'), JSON.stringify(entry, null, 1));
        report.entries++;
      } catch (error) { report.failed.push({id:light.id, error:error.message}); }
    }
    before = page.next;
  } while (before);
  log(`Записи: ${report.entries}`);
  return report;
}
