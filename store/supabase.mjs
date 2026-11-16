// Supabase Postgres + Cloudflare R2 store driver (§2, §3).
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {Readable} from 'node:stream';
import {splitStyle, creativeMeta} from './file.mjs';

const valid = id => /^[0-9a-f-]{36}$/.test(String(id || ''));

export const authorStorage = new AsyncLocalStorage();
export const currentAuthor = () => authorStorage.getStore() || process.env.FORMA_AUTHOR || null;

export const SCHEMA_NOT_READY_MSG =
  'Supabase is not ready. Run npx supabase db push --remote (see docs/cloud-runbook.md).';

export const PREVIEW_SECURITY_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src blob:; base-uri 'none'; form-action 'none'",
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

export function contentTypeForPath(filePath = '') {
  const ext = path.extname(String(filePath)).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// §2.1 Classifying a file (relative to DATA_DIR/<project>/):
// - assets/generated/** -> 'generated'
// - assets/revisions/** -> 'attachment'
// - any other assets/** -> 'upload'
// - <uuid>.src.html     -> 'source'
// - <uuid>.html         -> 'creative'
// Excluded (returns null): draft.html, *.tmp, *.part, dotfiles, anything outside DATA_DIR/<project>/.
export function classifyProjectFile(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null;
  const norm = relPath.split(path.sep).join('/').replace(/^\/+/, '');
  if (!norm || norm.includes('\\') || norm.includes('\0')) return null;

  const parts = norm.split('/');
  for (const seg of parts) {
    if (!seg || seg === '.' || seg === '..' || seg.startsWith('.')) return null;
  }

  const base = parts.at(-1);
  if (base === 'draft.html' || base.endsWith('.tmp') || base.endsWith('.part')) {
    return null;
  }

  if (parts[0] === 'assets') {
    if (parts.length < 2) return null;
    if (parts[1] === 'generated') {
      return parts.length >= 3 ? 'generated' : null;
    }
    if (parts[1] === 'revisions') {
      return parts.length >= 3 ? 'attachment' : null;
    }
    return 'upload';
  }

  if (parts.length === 1) {
    if (/^[0-9a-f-]{36}\.src\.html$/i.test(base)) return 'source';
    if (/^[0-9a-f-]{36}\.html$/i.test(base)) return 'creative';
  }

  return null;
}

// Maps an application history entry to a Postgres `entries` row (§3.1).
export function entryToRow(entry) {
  if (!entry || typeof entry !== 'object') throw Error('Invalid entry');
  const {log, logSize, version, ...doc} = entry;
  const cleanDoc = structuredClone(doc);
  const id = valid(cleanDoc.id) ? cleanDoc.id : randomUUID();
  cleanDoc.id = id;

  const createdAt = cleanDoc.createdAt || new Date().toISOString();
  cleanDoc.createdAt = createdAt;
  const updatedAt = cleanDoc.updatedAt || createdAt;

  const projectId = valid(cleanDoc.project) ? cleanDoc.project : null;
  const campaignId = cleanDoc.type === 'campaign'
    ? id
    : (valid(cleanDoc.campaign) ? cleanDoc.campaign : null);
  const parentId = valid(cleanDoc.input?.revision?.parent) ? cleanDoc.input.revision.parent : null;
  const outputPath = typeof cleanDoc.output?.path === 'string' ? cleanDoc.output.path : null;
  const computedLogSize = Array.isArray(log) ? log.length : (Number(logSize) || 0);

  return {
    id,
    type: cleanDoc.type,
    status: cleanDoc.status ?? null,
    created_at: createdAt,
    updated_at: updatedAt,
    version: typeof version === 'number' && version >= 1 ? version : 1,
    author: cleanDoc.author ?? null,
    project_id: projectId,
    campaign_id: campaignId,
    parent_id: parentId,
    output_path: outputPath,
    log_size: computedLogSize,
    doc: cleanDoc,
  };
}

// Maps a Postgres `entries` row back to an application entry (§3.1).
export function rowToEntry(row) {
  if (!row || typeof row !== 'object') return null;
  const doc = structuredClone(row.doc || {});
  if (row.author && doc.author === undefined) {
    doc.author = row.author;
  }
  if (doc.type === 'campaign' && (!Array.isArray(doc.variants) || !doc.variants.length)) {
    const s = doc.steps || {};
    const vid = doc.id || row.id;
    const dir = s.styles?.direction || '';
    const firstLine = dir.includes('\n\n') ? dir.split('\n\n')[0].trim() : '';
    const v0 = {
      id: vid,
      label: s.styles?.label || (firstLine && firstLine.length <= 80 ? firstLine : 'Style 1'),
      createdAt: doc.createdAt || row.created_at || new Date().toISOString(),
      author: doc.author ?? row.author ?? null,
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
      cost: doc.cost ? structuredClone(doc.cost) : {llm: 0, image: 0, video: 0, total: 0, unknown: false},
    };
    doc.variants = [v0];
    doc.activeVariant = vid;
  }
  return {
    ...doc,
    logSize: Number(row.log_size ?? 0),
    version: Number(row.version ?? 1),
  };
}

export async function streamToBuffer(stream) {
  if (!stream) return Buffer.alloc(0);
  if (Buffer.isBuffer(stream)) return stream;
  if (typeof stream === 'string') return Buffer.from(stream);
  if (typeof stream.transformToByteArray === 'function') {
    return Buffer.from(await stream.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function mapPool(items, concurrency, fn) {
  const list = [...items];
  const results = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({length: Math.min(concurrency, list.length)}, async () => {
    while (cursor < list.length) {
      const idx = cursor++;
      results[idx] = await fn(list[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function withRetry(fn, {retries = 3, baseDelayMs = 40} = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt - 1)));
      }
    }
  }
  throw lastErr;
}

function mergeEntryPatch(baseDoc, patch) {
  const next = {...structuredClone(baseDoc), ...structuredClone(patch)};
  if (baseDoc.input !== undefined || patch.input !== undefined) {
    next.input = {...baseDoc.input, ...patch.input};
  }
  if (baseDoc.type === 'campaign' && !patch.updatedAt) {
    next.updatedAt = new Date().toISOString();
  }
  const author = currentAuthor();
  if (author && !patch.author) {
    next.author = author;
  }
  return next;
}

export async function createDefaultSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env for cloud storage.');
  }
  const {createClient} = await import('@supabase/supabase-js');
  return createClient(url, key, {auth: {persistSession: false}});
}

export function createR2Blobs({s3Client = null, bucket = null} = {}) {
  let client = s3Client;
  const getBucket = () => bucket || process.env.R2_BUCKET || 'forma';

  async function s3() {
    if (client) return client;
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw Error('Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in .env for cloud storage.');
    }
    const {S3Client} = await import('@aws-sdk/client-s3');
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {accessKeyId, secretAccessKey},
    });
    return client;
  }

  const isNotFound = err =>
    err?.name === 'NoSuchKey' ||
    err?.name === 'NotFound' ||
    err?.Code === 'NoSuchKey' ||
    err?.$metadata?.httpStatusCode === 404;

  return {
    async put(key, bufOrStream, {contentType, sha256, ifAbsent} = {}) {
      const c = await s3();
      const {PutObjectCommand} = await import('@aws-sdk/client-s3');
      const body = await streamToBuffer(bufOrStream);
      const digest = sha256 || createHash('sha256').update(body).digest('hex');
      const ct = contentType || contentTypeForPath(key);
      await c.send(
        new PutObjectCommand({
          Bucket: getBucket(),
          Key: key,
          Body: body,
          ...(ifAbsent ? {IfNoneMatch:'*'} : {}),
          ContentType: ct,
          Metadata: {sha256: digest},
        })
      );
      return {key, size: body.length, sha256: digest, contentType: ct};
    },

    async get(key) {
      const c = await s3();
      const {GetObjectCommand} = await import('@aws-sdk/client-s3');
      try {
        const res = await c.send(
          new GetObjectCommand({
            Bucket: getBucket(),
            Key: key,
          })
        );
        if (!res?.Body) return null;
        if (Buffer.isBuffer(res.Body) || typeof res.Body === 'string') {
          return Readable.from([Buffer.from(res.Body)]);
        }
        return res.Body;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async head(key) {
      const c = await s3();
      const {HeadObjectCommand} = await import('@aws-sdk/client-s3');
      try {
        const res = await c.send(
          new HeadObjectCommand({
            Bucket: getBucket(),
            Key: key,
          })
        );
        return {
          key,
          size: Number(res.ContentLength ?? 0),
          sha256: res.Metadata?.sha256 || null,
          contentType: res.ContentType || null,
        };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async list(prefix = '') {
      const c = await s3();
      const {ListObjectsV2Command} = await import('@aws-sdk/client-s3');
      const out = [];
      let continuationToken;
      do {
        const res = await c.send(
          new ListObjectsV2Command({
            Bucket: getBucket(),
            Prefix: prefix,
            ContinuationToken: continuationToken,
          })
        );
        for (const item of res.Contents || []) {
          out.push({
            key: item.Key,
            size: Number(item.Size ?? 0),
          });
        }
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (continuationToken);
      return out;
    },
  };
}

const DEAD_RUN_MS = 120 * 1000;

export function createSupabaseStore({
  driver = 'supabase',
  supabase: injectedSupabase = null,
  blobs: injectedBlobs = null,
  s3Client = null,
  dataDir: initialDataDir = null,
} = {}) {
  let sbClient = injectedSupabase;
  let cacheRoot = path.resolve(initialDataDir || process.env.CACHE_DIR || process.env.DATA_DIR || 'data');

  async function db() {
    if (!sbClient) {
      sbClient = await createDefaultSupabaseClient();
    }
    return sbClient;
  }

  const blobs = injectedBlobs || createR2Blobs({s3Client});

  async function open(dataDir) {
    if (dataDir) cacheRoot = path.resolve(process.env.CACHE_DIR || dataDir);
    const client = await db();
    const {data: meta, error: metaErr} = await client
      .from('schema_meta')
      .select('value')
      .eq('key', 'forma_schema')
      .maybeSingle();

    if (metaErr || !meta || meta.value !== '1') {
      throw Error(SCHEMA_NOT_READY_MSG);
    }

    const {count, error: countErr} = await client
      .from('entries')
      .select('*', {count: 'exact', head: true});
    if (countErr) throw Error(countErr.message);
    return count || 0;
  }

  async function record(entry) {
    const client = await db();
    const author = entry.author ?? currentAuthor();
    const full = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'ok',
      log: [],
      ...entry,
      ...(author ? {author} : {}),
    };
    if (!valid(full.id)) full.id = randomUUID();

    const logEvents = Array.isArray(full.log) ? full.log : [];
    if (logEvents.length > 0 && blobs?.put) {
      const logBuf = Buffer.from(JSON.stringify(logEvents));
      const sha256 = createHash('sha256').update(logBuf).digest('hex');
      await blobs.put(`logs/${full.id}.json`, logBuf, {
        contentType: 'application/json',
        sha256,
      });
    }

    const row = entryToRow(full);
    const {data, error} = await client
      .from('entries')
      .upsert(row, {onConflict: 'id'})
      .select('*')
      .single();
    if (error) throw Error(error.message);

    return {
      ...rowToEntry(data || row),
      log: logEvents,
    };
  }

  async function get(id, {withLog = false} = {}) {
    if (!valid(id)) return null;
    const client = await db();
    const {data, error} = await client
      .from('entries')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw Error(error.message);
    if (!data) return null;

    const entry = rowToEntry(data);
    if (withLog) {
      let log = [];
      if (entry.logSize > 0 && blobs?.get) {
        try {
          const stream = await blobs.get(`logs/${id}.json`);
          if (stream) {
            const buf = await streamToBuffer(stream);
            log = JSON.parse(buf.toString('utf8'));
          }
        } catch {
          log = [];
        }
      }
      return {...entry, log: Array.isArray(log) ? log : []};
    }
    return {...entry, log: []};
  }

  // §3.4 Optimistic concurrency with one automatic retry on version conflict
  async function update(id, patch) {
    if (!valid(id)) return null;
    const client = await db();

    for (let attempt = 0; attempt < 2; attempt++) {
      const {data: current, error: readErr} = await client
        .from('entries')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (readErr) throw Error(readErr.message);
      if (!current) return null;

      const mergedDoc = mergeEntryPatch(current.doc, patch);
      const nextRow = entryToRow({...mergedDoc, logSize: current.log_size, version: current.version});

      const {data: updatedRows, error: rpcErr} = await client.rpc('forma_update_entry', {
        p_id: id,
        p_expected: current.version,
        p_doc: nextRow.doc,
        p_campaign: nextRow.campaign_id,
        p_parent: nextRow.parent_id,
        p_output_path: nextRow.output_path,
        p_status: nextRow.status,
      });
      if (rpcErr) throw Error(rpcErr.message);

      const updated = Array.isArray(updatedRows) ? updatedRows[0] : updatedRows;
      if (updated && updated.id) {
        if (nextRow.author && nextRow.author !== current.author) {
          await client.from('entries').update({author: nextRow.author}).eq('id', id);
          updated.author = nextRow.author;
        }
        return {...rowToEntry(updated), log: []};
      }
    }

    // Both attempts conflicted -> 409 with the colleague's author name
    const {data: latest} = await client
      .from('entries')
      .select('author, doc')
      .eq('id', id)
      .maybeSingle();
    const who = latest?.author || latest?.doc?.author || 'teammate';
    throw Object.assign(
      Error(`${who} just updated this campaign. Refresh the page.`),
      {status: 409}
    );
  }

  // §3.2 list({type, project, path, campaign, before, limit, author, excludeAuthor})
  async function list({type, project, path: outputPath, campaign, before, limit = 30, author, excludeAuthor} = {}) {
    const client = await db();
    const pageSize = Math.min(Math.max(Number(limit) || 30, 1), 200);

    const applyFilters = q => {
      if (type) q = q.eq('type', type);
      if (campaign === 'none') {
        q = q.is('campaign_id', null).neq('type', 'campaign');
      } else if (campaign) {
        q = q.eq('campaign_id', campaign);
      }
      if (project) q = q.eq('project_id', project);
      if (outputPath) q = q.eq('output_path', outputPath);
      if (author) q = q.eq('author', author);
      if (excludeAuthor) q = q.neq('author', excludeAuthor);
      return q;
    };

    const countQuery = applyFilters(
      client.from('entries').select('*', {count: 'exact', head: true})
    );
    let dataQuery = applyFilters(client.from('entries').select('*'));
    if (before) {
      dataQuery = dataQuery.lt('created_at', before);
    }
    dataQuery = dataQuery.order('created_at', {ascending: false}).limit(pageSize + 1);

    const [{count, error: countErr}, {data: rows, error: dataErr}] = await Promise.all([
      countQuery,
      dataQuery,
    ]);
    if (countErr) throw Error(countErr.message);
    if (dataErr) throw Error(dataErr.message);

    const all = (rows || []).map(rowToEntry);
    const hasMore = all.length > pageSize;
    const page = hasMore ? all.slice(0, pageSize) : all;
    const next = hasMore ? page.at(-1).createdAt : null;

    return {
      items: page,
      next,
      total: count ?? page.length,
    };
  }

  // §3.2 thread(id) via recursive CTE RPC forma_thread
  async function thread(id) {
    if (!valid(id)) return [];
    const client = await db();
    const {data, error} = await client.rpc('forma_thread', {p_id: id});
    if (error) throw Error(error.message);
    return (data || []).map(rowToEntry);
  }

  async function findBy(predicate) {
    const client = await db();
    const {data, error} = await client
      .from('entries')
      .select('*')
      .order('created_at', {ascending: false})
      .limit(500);
    if (error) throw Error(error.message);
    for (const row of data || []) {
      const entry = rowToEntry(row);
      if (predicate(entry)) return entry;
    }
    return undefined;
  }

  async function importExisting(_dataDir) {
    return 0;
  }

  // ---- Assets index (§2, §2.1, §3) ----
  const assets = {
    async index(project) {
      if (!valid(project)) return [];
      const client = await db();
      const {data, error} = await client
        .from('assets')
        .select('path, size, sha256, kind, content_type, author')
        .eq('project_id', project);
      if (error) throw Error(error.message);
      return (data || []).map(r => ({
        path: r.path,
        size: Number(r.size),
        sha256: r.sha256,
        kind: r.kind,
        contentType: r.content_type || null,
        author: r.author || null,
      }));
    },

    async upsert(project, rows = []) {
      if (!valid(project) || !rows.length) return 0;
      const client = await db();
      const author = currentAuthor();

      // Ensure parent project row exists for FK constraint
      const {error: projErr} = await client
        .from('projects')
        .upsert({id: project, author}, {onConflict: 'id'});
      if (projErr) throw Error(projErr.message);

      const now = new Date().toISOString();
      const dbRows = rows.map(r => ({
        project_id: project,
        path: r.path,
        kind: r.kind || classifyProjectFile(r.path) || 'upload',
        size: Number(r.size),
        sha256: r.sha256,
        content_type: r.contentType || r.content_type || contentTypeForPath(r.path),
        author: r.author ?? author,
        updated_at: now,
      }));

      const {error} = await client
        .from('assets')
        .upsert(dbRows, {onConflict: 'project_id,path'});
      if (error) throw Error(error.message);
      return dbRows.length;
    },

    async remove(project, relPath) {
      if (!valid(project) || !relPath) return;
      const client = await db();
      const {error} = await client
        .from('assets')
        .delete()
        .eq('project_id', project)
        .eq('path', relPath);
      if (error) throw Error(error.message);
    },
  };

  // ---- Runs: DB lock, heartbeat, event batching, finish & active view (§3.3) ----
  const runs = {
    async start({id = randomUUID(), campaignId = null, projectId = null, task = 'creative', author = currentAuthor()} = {}) {
      const client = await db();
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();

      if (campaignId) {
        // Check if there is an existing running run on this campaign whose heartbeat_at is older than 120 s (§3.3)
        const {data: existingActive} = await client
          .from('runs')
          .select('*')
          .eq('campaign_id', campaignId)
          .eq('status', 'running')
          .maybeSingle();

        if (existingActive) {
          const hbMs = new Date(existingActive.heartbeat_at || existingActive.started_at).getTime();
          if (nowMs - hbMs > DEAD_RUN_MS) {
            await client
              .from('runs')
              .update({
                status: 'error',
                status_text: 'Run interrupted',
                finished_at: nowIso,
              })
              .eq('id', existingActive.id)
              .eq('status', 'running');
          } else {
            const who = existingActive.author ? ` (started by ${existingActive.author})` : '';
            throw Object.assign(
              Error(`Wait for the current step to finish${who}.`),
              {status: 409}
            );
          }
        }
      }

      const row = {
        id,
        campaign_id: campaignId || null,
        project_id: projectId || null,
        entry_id: null,
        task: task || 'creative',
        author: author || null,
        status: 'running',
        status_text: '',
        costs: {llm: 0, image: 0, video: 0, total: 0, unknown: false},
        started_at: nowIso,
        heartbeat_at: nowIso,
        finished_at: null,
      };

      const {data, error} = await client
        .from('runs')
        .insert(row)
        .select('*')
        .single();

      if (error) {
        if (error.code === '23505' || /unique|duplicate/i.test(error.message || '')) {
          const {data: activeRow} = campaignId
            ? await client
                .from('runs')
                .select('author')
                .eq('campaign_id', campaignId)
                .eq('status', 'running')
                .maybeSingle()
            : {data: null};
          const who = activeRow?.author ? ` (started by ${activeRow.author})` : '';
          throw Object.assign(
            Error(`Wait for the current step to finish${who}.`),
            {status: 409}
          );
        }
        throw Error(error.message);
      }

      return data || row;
    },

    async heartbeat(id, patch = {}) {
      if (!valid(id)) return null;
      const client = await db();
      const updateRow = {
        heartbeat_at: new Date().toISOString(),
      };
      if (patch.statusText !== undefined) updateRow.status_text = String(patch.statusText || '');
      if (patch.costs !== undefined) updateRow.costs = patch.costs;

      const {data, error} = await client
        .from('runs')
        .update(updateRow)
        .eq('id', id)
        .select('*')
        .maybeSingle();
      if (error) throw Error(error.message);
      return data;
    },

    async events(id, batch = []) {
      if (!valid(id) || !Array.isArray(batch) || !batch.length) return;
      try {
        const client = await db();
        for (let offset = 0; offset < batch.length; offset += 100) {
          const slice = batch.slice(offset, offset + 100).map(ev => ({
            run_id: id,
            i: Number(ev.i ?? 0),
            at_ms: Math.round(Number(ev.at ?? ev.at_ms ?? 0)),
            level: String(ev.level || 'info'),
            msg: String(ev.msg || ''),
            detail: ev.detail !== undefined ? String(ev.detail) : null,
            media: ev.media ?? null,
            cost: ev.cost ?? null,
          }));
          await client.from('run_events').upsert(slice, {onConflict: 'run_id,i'});
        }
      } catch {
        // Best-effort event flushing never fails the job (§3.3)
      }
    },

    async finish(id, statusOrPatch = 'done') {
      if (!valid(id)) return null;
      const client = await db();
      const patch = typeof statusOrPatch === 'string' ? {status: statusOrPatch} : (statusOrPatch || {});
      const rawStatus = patch.status || 'done';
      const normalizedStatus = rawStatus === 'ok'
        ? 'done'
        : ['running', 'done', 'error', 'cancelled'].includes(rawStatus)
          ? rawStatus
          : 'done';
      const nowIso = new Date().toISOString();

      const updateRow = {
        status: normalizedStatus,
        heartbeat_at: nowIso,
        finished_at: nowIso,
      };
      if (patch.statusText !== undefined) updateRow.status_text = String(patch.statusText || '');
      if (patch.costs !== undefined) updateRow.costs = patch.costs;
      if (patch.entryId !== undefined && valid(patch.entryId)) updateRow.entry_id = patch.entryId;

      const {data} = await client
        .from('runs')
        .update(updateRow)
        .eq('id', id)
        .select('*')
        .maybeSingle();

      // Upload full log to R2 as logs/<entryId>.json (§3.3)
      const targetEntryId = patch.entryId || data?.entry_id;
      if (targetEntryId && Array.isArray(patch.log) && blobs?.put) {
        try {
          const logBuf = Buffer.from(JSON.stringify(patch.log));
          const sha256 = createHash('sha256').update(logBuf).digest('hex');
          await blobs.put(`logs/${targetEntryId}.json`, logBuf, {
            contentType: 'application/json',
            sha256,
          });
        } catch {}
      }

      return data;
    },

    async active() {
      const client = await db();
      const {data, error} = await client
        .from('runs')
        .select('*')
        .eq('status', 'running')
        .order('heartbeat_at', {ascending: false});
      if (error) throw Error(error.message);

      const nowMs = Date.now();
      const alive = [];
      for (const r of data || []) {
        const hbMs = new Date(r.heartbeat_at || r.started_at).getTime();
        if (nowMs - hbMs > DEAD_RUN_MS) {
          // Sweep dead run lazily
          await client
            .from('runs')
            .update({
              status: 'error',
              status_text: 'Run interrupted',
              finished_at: new Date(nowMs).toISOString(),
            })
            .eq('id', r.id)
            .eq('status', 'running');
          continue;
        }
        alive.push({
          id: r.id,
          campaignId: r.campaign_id || null,
          projectId: r.project_id || null,
          entryId: r.entry_id || null,
          task: r.task,
          author: r.author || null,
          status: r.status,
          statusText: r.status_text || '',
          costs: r.costs || {llm: 0, image: 0, video: 0, total: 0, unknown: false},
          startedAt: r.started_at,
          heartbeatAt: r.heartbeat_at,
          elapsed: Math.max(0, nowMs - new Date(r.started_at).getTime()),
        });
      }
      return alive;
    },

    async get(id, since = 0) {
      if (!valid(id)) return {missing: true};
      const client = await db();
      const {data: run, error: runErr} = await client
        .from('runs')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (runErr || !run) return {missing: true};

      const {data: evRows} = await client
        .from('run_events')
        .select('*')
        .eq('run_id', id)
        .gte('i', Number(since) || 0)
        .order('i', {ascending: true});

      const events = (evRows || []).map(e => {
        const ev = {
          i: Number(e.i),
          at: Number(e.at_ms),
          level: e.level,
          msg: e.msg,
        };
        if (e.detail !== null && e.detail !== undefined) ev.detail = e.detail;
        if (e.media !== null && e.media !== undefined) ev.media = e.media;
        if (e.cost !== null && e.cost !== undefined) ev.cost = e.cost;
        return ev;
      });

      const next = events.length > 0 ? events.at(-1).i + 1 : Number(since) || 0;
      const endMs = run.finished_at ? new Date(run.finished_at).getTime() : Date.now();
      const elapsed = Math.max(0, endMs - new Date(run.started_at).getTime());

      return {
        status: run.status_text || run.status,
        done: run.status !== 'running',
        elapsed,
        costs: run.costs || {llm: 0, image: 0, video: 0, total: 0, unknown: false},
        events,
        next,
        author: run.author || null,
        campaignId: run.campaign_id || null,
        task: run.task,
      };
    },
  };

  // ---- Edge Sync (§2.1): sync.up & sync.down ----
  const sync = {
    async up(project, {kind: filterKind, path: onlyRelPath, dataDir} = {}) {
      if (!valid(project)) return {uploaded: 0, skipped: 0};
      const root = dataDir ? path.resolve(dataDir) : cacheRoot;
      const projectDir = path.join(root, project);

      const indexedList = await assets.index(project);
      const indexedMap = new Map(indexedList.map(r => [r.path, r]));

      let candidateRelPaths = [];
      if (onlyRelPath) {
        const norm = onlyRelPath.split(path.sep).join('/').replace(/^\/+/, '');
        if (classifyProjectFile(norm)) candidateRelPaths.push(norm);
      } else {
        const entries = await fs.readdir(projectDir, {recursive: true, withFileTypes: true}).catch(() => []);
        for (const e of entries) {
          if (!e.isFile()) continue;
          const full = path.join(e.parentPath, e.name);
          const rel = path.relative(projectDir, full).split(path.sep).join('/');
          const kind = classifyProjectFile(rel);
          if (!kind) continue;
          if (filterKind && kind !== filterKind) continue;
          candidateRelPaths.push(rel);
        }
      }

      const toUpload = [];
      let skipped = 0;

      for (const rel of candidateRelPaths) {
        const kind = classifyProjectFile(rel);
        if (!kind) continue;
        const full = path.join(projectDir, rel);
        let st;
        try {
          st = await fs.stat(full);
          if (!st.isFile()) continue;
        } catch {
          continue;
        }

        const existing = indexedMap.get(rel);
        const buf = await fs.readFile(full);
        const sha256 = createHash('sha256').update(buf).digest('hex');

        if (existing && Number(existing.size) === st.size && existing.sha256 === sha256) {
          skipped++;
          continue;
        }

        toUpload.push({
          rel,
          kind,
          size: st.size,
          sha256,
          contentType: contentTypeForPath(rel),
          buf,
        });
      }

      if (!toUpload.length) {
        return {uploaded: 0, skipped};
      }

      // Run up to 4 uploads in parallel and retry 3 times with backoff (§2.1)
      const uploadedRows = await mapPool(toUpload, 4, async item => {
        const r2Key = `projects/${project}/${item.rel}`;
        await withRetry(
          () =>
            blobs.put(r2Key, item.buf, {
              contentType: item.contentType,
              sha256: item.sha256,
            }),
          {retries: 3, baseDelayMs: 40}
        );
        return {
          path: item.rel,
          kind: item.kind,
          size: item.size,
          sha256: item.sha256,
          contentType: item.contentType,
          author: currentAuthor(),
        };
      });

      await assets.upsert(project, uploadedRows);
      return {uploaded: uploadedRows.length, skipped};
    },

    async down(project, {dataDir} = {}) {
      if (!valid(project)) return {downloaded: 0, skipped: 0};
      const root = dataDir ? path.resolve(dataDir) : cacheRoot;
      const projectDir = path.join(root, project);
      const indexedList = await assets.index(project);
      if (!indexedList.length) return {downloaded: 0, skipped: 0};

      let downloaded = 0;
      let skipped = 0;

      // Run up to 6 downloads in parallel; write to .part, then rename (§2.1)
      await mapPool(indexedList, 6, async row => {
        if (!classifyProjectFile(row.path)) return;
        const localFile = path.join(projectDir, row.path);
        try {
          const st = await fs.stat(localFile);
          if (st.isFile() && st.size === Number(row.size)) {
            skipped++;
            return;
          }
        } catch {}

        const stream = await blobs.get(`projects/${project}/${row.path}`);
        if (!stream) return;

        const buf = await streamToBuffer(stream);
        await fs.mkdir(path.dirname(localFile), {recursive: true});
        const partFile = `${localFile}.${process.pid}.${randomUUID().slice(0, 8)}.part`;
        await fs.writeFile(partFile, buf);
        await fs.rename(partFile, localFile);
        downloaded++;
      });

      return {downloaded, skipped};
    },
  };

  async function status() {
    const author = currentAuthor();
    if (!author) {
      return {
        driver,
        author: null,
        ready: false,
        error: 'Set FORMA_AUTHOR in .env for cloud storage.',
      };
    }
    try {
      const client = await db();
      const {data: meta, error: metaErr} = await client
        .from('schema_meta')
        .select('value')
        .eq('key', 'forma_schema')
        .maybeSingle();
      if (metaErr || !meta || meta.value !== '1') {
        return {
          driver,
          author,
          ready: false,
          error: metaErr?.message || SCHEMA_NOT_READY_MSG,
        };
      }
      return {driver, author, ready: true};
    } catch (err) {
      return {
        driver,
        author,
        ready: false,
        error: err.message,
      };
    }
  }

  async function registerProject(id, {name = null, author = currentAuthor()} = {}) {
    if (!valid(id)) return;
    const client = await db();
    await client
      .from('projects')
      .upsert({id, author, ...(name ? {name} : {})}, {onConflict: 'id'});
  }

  return {
    driver,
    status,
    registerProject,
    history: {
      open,
      openHistory: open,
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
}

// Preview origin read-through middleware (§2.1):
// Serves local file when it exists; on miss, fetches `projects/<rest>` from R2 blobs,
// writes to cache via atomic .part rename, and serves with security headers + Content-Type.
export function createPreviewReadThrough({dataDir, blobs}) {
  const root = path.resolve(dataDir);

  return async function previewReadThrough(req, res, next) {
    res.set(PREVIEW_SECURITY_HEADERS);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return res.sendStatus(404);
    }

    let rawPath = req.path || req.url.split('?')[0] || '';
    try {
      rawPath = decodeURIComponent(rawPath);
    } catch {
      return res.sendStatus(400);
    }

    const rel = rawPath.replace(/^\/+/, '');
    if (!rel || rel === 'history' || rel.startsWith('history/') || rel.includes('\\') || rel.includes('\0')) {
      return res.sendStatus(404);
    }

    const parts = rel.split('/');
    if (!valid(parts[0]) || parts.some(seg => !seg || seg === '.' || seg === '..' || seg.startsWith('.'))) {
      return res.sendStatus(404);
    }

    // Generated pages sometimes reference brand files relative to the assets folder the model worked in
    // ("Pack/logo.svg" instead of "assets/Pack/logo.svg"). A miss outside assets/ retries assets/<rest>.
    const fallbackRel = parts.length > 1 && parts[1] !== 'assets' ? [parts[0], 'assets', ...parts.slice(1)].join('/') : null;

    try {
      if (await serveRel(rel, req, res)) return;
      if (fallbackRel && await serveRel(fallbackRel, req, res)) return;
      return res.sendStatus(404);
    } catch (err) {
      if (next) return next(err);
      return res.sendStatus(500);
    }
  };

  // Serves one data-relative path: local cache first, then `projects/<rel>` from the blob store. false = not found.
  async function serveRel(rel, req, res) {
    const localFile = path.resolve(root, rel);
    if (!localFile.startsWith(root + path.sep)) return false;
    const contentType = contentTypeForPath(localFile);

    const st = await fs.stat(localFile).catch(() => null);
    if (st?.isFile()) {
      res.set('Content-Type', contentType);
      res.set('Content-Length', String(st.size));
      if (req.method === 'HEAD') {
        res.status(200).end();
        return true;
      }
      const rs = createReadStream(localFile);
      rs.on('error', () => {
        if (!res.headersSent) res.sendStatus(404);
        else res.end();
      });
      rs.pipe(res);
      return true;
    }

    if (!blobs?.get) return false;
    const stream = await blobs.get(`projects/${rel}`);
    if (!stream) return false;

    const buf = await streamToBuffer(stream);
    await fs.mkdir(path.dirname(localFile), {recursive: true});
    const partFile = `${localFile}.${process.pid}.${randomUUID().slice(0, 8)}.part`;
    await fs.writeFile(partFile, buf);
    await fs.rename(partFile, localFile);

    res.set('Content-Type', contentType);
    res.set('Content-Length', String(buf.length));
    if (req.method === 'HEAD') res.status(200).end();
    else res.status(200).end(buf);
    return true;
  }
}

export const supabaseStore = createSupabaseStore();
