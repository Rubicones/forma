// In-memory fake cloud driver (FORMA_STORE=memory, test-only, §10).
// Implements the full Supabase + R2 contract in memory, including optimistic concurrency
// (forma_update_entry) and the partial unique run lock (runs_one_active_per_campaign).
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {createSupabaseStore, streamToBuffer} from './supabase.mjs';

export function createMemoryCloud({dataDir = null} = {}) {
  const tables = {
    schema_meta: new Map([['forma_schema', {key: 'forma_schema', value: '1'}]]),
    projects: new Map(),   // id -> row
    assets: new Map(),     // `${project_id}:${path}` -> row
    entries: new Map(),    // id -> row
    runs: new Map(),       // id -> row
    run_events: new Map(), // `${run_id}:${i}` -> row
  };

  const blobMap = new Map(); // key -> {buf, contentType, sha256, size}
  let onBeforeUpdateRpc = null;

  const blobs = {
    raw: blobMap,
    async put(key, bufOrStream, {contentType = 'application/octet-stream', sha256, ifAbsent} = {}) {
      const buf = await streamToBuffer(bufOrStream);
      const digest = sha256 || createHash('sha256').update(buf).digest('hex');
      if (ifAbsent && blobMap.has(key)) throw Object.assign(Error('Already exists'), {code:'EEXIST'});
      blobMap.set(key, {
        key,
        buf: Buffer.from(buf),
        size: buf.length,
        sha256: digest,
        contentType,
      });
      return {key, size: buf.length, sha256: digest, contentType};
    },
    async get(key) {
      const item = blobMap.get(key);
      if (!item) return null;
      return Readable.from([Buffer.from(item.buf)]);
    },
    async head(key) {
      const item = blobMap.get(key);
      if (!item) return null;
      return {
        key,
        size: item.size,
        sha256: item.sha256,
        contentType: item.contentType,
      };
    },
    async list(prefix = '') {
      const out = [];
      for (const item of blobMap.values()) {
        if (!prefix || item.key.startsWith(prefix)) {
          out.push({key: item.key, size: item.size});
        }
      }
      return out;
    },
  };

  function rowKey(tableName, row) {
    if (tableName === 'schema_meta') return row.key;
    if (tableName === 'assets') return `${row.project_id}:${row.path}`;
    if (tableName === 'run_events') return `${row.run_id}:${row.i}`;
    return row.id;
  }

  function checkRunUniqueConstraint(row, ignoreId = null) {
    if (row.status === 'running' && row.campaign_id) {
      for (const existing of tables.runs.values()) {
        if (
          existing.id !== ignoreId &&
          existing.campaign_id === row.campaign_id &&
          existing.status === 'running'
        ) {
          return {
            code: '23505',
            message: 'duplicate key value violates unique constraint "runs_one_active_per_campaign"',
          };
        }
      }
    }
    return null;
  }

  function makeQuery(tableName) {
    const tbl = tables[tableName];
    const filters = [];
    let isCountHead = false;
    let orderCol = null;
    let orderAsc = true;
    let limitCount = null;
    let op = 'select';
    let payload = null;

    const matches = r => filters.every(fn => fn(r));

    const execute = async () => {
      if (op === 'insert') {
        const rows = Array.isArray(payload) ? payload : [payload];
        const inserted = [];
        for (const r of rows) {
          if (tableName === 'runs') {
            const err = checkRunUniqueConstraint(r);
            if (err) return {data: null, error: err};
          }
          const k = rowKey(tableName, r);
          if (tbl.has(k)) {
            return {data: null, error: {code: '23505', message: 'duplicate key value'}};
          }
          const clone = structuredClone(r);
          tbl.set(k, clone);
          inserted.push(structuredClone(clone));
        }
        return {data: Array.isArray(payload) ? inserted : inserted[0], error: null};
      }

      if (op === 'upsert') {
        const rows = Array.isArray(payload) ? payload : [payload];
        const upserted = [];
        for (const r of rows) {
          const k = rowKey(tableName, r);
          const prev = tbl.get(k);
          const merged = prev
            ? {...structuredClone(prev), ...structuredClone(r)}
            : structuredClone(r);
          if (tableName === 'entries' && !merged.version) merged.version = 1;
          tbl.set(k, merged);
          upserted.push(structuredClone(merged));
        }
        return {data: Array.isArray(payload) ? upserted : upserted[0], error: null};
      }

      if (op === 'update') {
        const updated = [];
        for (const [k, r] of tbl.entries()) {
          if (matches(r)) {
            const next = {...structuredClone(r), ...structuredClone(payload)};
            if (tableName === 'runs') {
              const err = checkRunUniqueConstraint(next, next.id);
              if (err) return {data: null, error: err};
            }
            tbl.set(k, next);
            updated.push(structuredClone(next));
          }
        }
        return {data: updated, error: null};
      }

      if (op === 'delete') {
        for (const [k, r] of tbl.entries()) {
          if (matches(r)) tbl.delete(k);
        }
        return {data: null, error: null};
      }

      // select
      let rows = [...tbl.values()].filter(matches);
      if (isCountHead) {
        return {data: null, count: rows.length, error: null};
      }
      if (orderCol) {
        rows.sort((a, b) => {
          const va = a[orderCol];
          const vb = b[orderCol];
          if (typeof va === 'number' && typeof vb === 'number') {
            return orderAsc ? va - vb : vb - va;
          }
          return orderAsc
            ? String(va ?? '').localeCompare(String(vb ?? ''))
            : String(vb ?? '').localeCompare(String(va ?? ''));
        });
      }
      if (limitCount !== null) {
        rows = rows.slice(0, limitCount);
      }
      return {data: structuredClone(rows), error: null};
    };

    const builder = {
      select(_cols = '*', opts = {}) {
        if (opts.count === 'exact' && opts.head) isCountHead = true;
        return builder;
      },
      insert(rows) {
        op = 'insert';
        payload = rows;
        return builder;
      },
      upsert(rows) {
        op = 'upsert';
        payload = rows;
        return builder;
      },
      update(patch) {
        op = 'update';
        payload = patch;
        return builder;
      },
      delete() {
        op = 'delete';
        return builder;
      },
      eq(col, val) { filters.push(r => r[col] === val); return builder; },
      neq(col, val) { filters.push(r => r[col] !== null && r[col] !== undefined && r[col] !== val); return builder; },
      is(col, val) { filters.push(r => (r[col] ?? null) === val); return builder; },
      lt(col, val) { filters.push(r => String(r[col] ?? '') < String(val)); return builder; },
      gte(col, val) { filters.push(r => Number(r[col] ?? 0) >= Number(val)); return builder; },
      order(col, {ascending = true} = {}) { orderCol = col; orderAsc = ascending; return builder; },
      limit(n) { limitCount = n; return builder; },
      async maybeSingle() {
        const res = await execute();
        const row = Array.isArray(res.data) ? (res.data[0] || null) : (res.data ?? null);
        return {data: row, error: res.error};
      },
      async single() {
        const res = await execute();
        const row = Array.isArray(res.data) ? (res.data[0] || null) : (res.data ?? null);
        return {data: row, error: res.error || (row ? null : {message: 'Row not found'})};
      },
      then(onFulfilled, onRejected) {
        return execute().then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  const supabase = {
    from: tableName => makeQuery(tableName),
    async rpc(fnName, params) {
      if (fnName === 'forma_update_entry') {
        if (onBeforeUpdateRpc) {
          await onBeforeUpdateRpc(params, tables);
        }
        const row = tables.entries.get(params.p_id);
        if (!row || row.version !== params.p_expected) {
          return {data: [], error: null};
        }
        const updated = {
          ...row,
          doc: structuredClone(params.p_doc),
          version: row.version + 1,
          updated_at: new Date().toISOString(),
          campaign_id: params.p_campaign,
          parent_id: params.p_parent,
          output_path: params.p_output_path,
          status: params.p_status,
        };
        tables.entries.set(updated.id, updated);
        return {data: [structuredClone(updated)], error: null};
      }
      if (fnName === 'forma_thread') {
        const chain = [];
        let cur = tables.entries.get(params.p_id);
        while (cur && chain.length < 50) {
          chain.unshift(structuredClone(cur));
          cur = cur.parent_id ? tables.entries.get(cur.parent_id) : null;
        }
        return {data: chain, error: null};
      }
      return {data: null, error: {message: `Unknown RPC: ${fnName}`}};
    },
  };

  const storeInstance = createSupabaseStore({
    driver: 'memory',
    supabase,
    blobs,
    dataDir,
  });

  function reset() {
    tables.projects.clear();
    tables.assets.clear();
    tables.entries.clear();
    tables.runs.clear();
    tables.run_events.clear();
    tables.schema_meta.clear();
    tables.schema_meta.set('forma_schema', {key: 'forma_schema', value: '1'});
    blobMap.clear();
    onBeforeUpdateRpc = null;
  }

  function setBeforeUpdateHook(fn) {
    onBeforeUpdateRpc = fn;
  }

  return {
    ...storeInstance,
    tables,
    blobMap,
    supabase,
    reset,
    setBeforeUpdateHook,
  };
}

export const memoryStore = createMemoryCloud();
