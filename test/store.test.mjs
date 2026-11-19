import {describe, it, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {store, selectStore} from '../store/index.mjs';
import {createMemoryCloud, memoryStore} from '../store/memory.mjs';
import {
  entryToRow,
  rowToEntry,
  createSupabaseStore,
  classifyProjectFile,
  createPreviewReadThrough,
  PREVIEW_SECURITY_HEADERS,
  SCHEMA_NOT_READY_MSG,
} from '../store/supabase.mjs';
import {registerBrandRoutes} from '../brands.mjs';
import {upgradeCampaign, registerCampaignRoutes} from '../campaigns.mjs';
import * as history from '../history.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('store/file.mjs & history.mjs async interface (§2, M1)', () => {
  let tempDir;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(tmpdir(), 'forma-store-m1-'));
    await history.open(tempDir);
  });

  after(async () => {
    if (tempDir) await fs.rm(tempDir, {recursive: true, force: true}).catch(() => {});
  });

  it('exposes the store contract with history, blobs, assets, runs, sync', () => {
    assert.equal(store.driver, 'file');
    for (const fn of ['open', 'record', 'update', 'get', 'list', 'thread', 'findBy', 'importExisting']) {
      assert.equal(typeof store.history[fn], 'function', `store.history.${fn}`);
      assert.equal(typeof history[fn], 'function', `history.${fn}`);
    }
    for (const fn of ['put', 'get', 'head', 'list']) {
      assert.equal(typeof store.blobs[fn], 'function', `store.blobs.${fn}`);
    }
    for (const fn of ['index', 'upsert', 'remove']) {
      assert.equal(typeof store.assets[fn], 'function', `store.assets.${fn}`);
    }
    for (const fn of ['start', 'heartbeat', 'events', 'finish', 'active', 'get']) {
      assert.equal(typeof store.runs[fn], 'function', `store.runs.${fn}`);
    }
    for (const fn of ['down', 'up']) {
      assert.equal(typeof store.sync[fn], 'function', `store.sync.${fn}`);
    }
  });

  it('records, gets (with/without withLog), updates without losing log, lists, finds, and builds thread asynchronously', async () => {
    const project = randomUUID();
    const first = await history.record({
      type: 'creative',
      project,
      input: {scenario: 'Theme A', style: 'Style A'},
      output: {revision: randomUUID(), path: `/p/${project}/first.html`, formats: ['1x1'], duration: 6},
      log: [
        {i: 0, at: 10, level: 'step', msg: 'Started'},
        {i: 1, at: 100, level: 'done', msg: 'Finished'},
      ],
    });
    assert.ok(first.id);

    // Without withLog -> log: [], logSize: 2
    const light = await history.get(first.id);
    assert.deepEqual(light.log, []);
    assert.equal(light.logSize, 2);

    // With withLog:true -> full log returned
    const full = await history.get(first.id, {withLog: true});
    assert.equal(full.log.length, 2);
    assert.equal(full.logSize, 2);
    assert.equal(full.log[0].msg, 'Started');

    // Update preserves log on disk even when patch does not include log
    await history.update(first.id, {caption: 'Updated caption'});
    const afterUpdate = await history.get(first.id, {withLog: true});
    assert.equal(afterUpdate.caption, 'Updated caption');
    assert.equal(afterUpdate.log.length, 2);

    // Chained child entry for thread()
    const second = await history.record({
      type: 'creative',
      project,
      input: {scenario: 'Theme A', style: 'Style A', revision: {parent: first.id, message: 'Make headline bigger', attachments: []}},
      output: {revision: randomUUID(), path: `/p/${project}/second.html`, formats: ['1x1'], duration: 6},
      log: [{i: 0, at: 5, level: 'done', msg: 'Revised'}],
    });

    const chain = await history.thread(second.id);
    assert.equal(chain.length, 2);
    assert.equal(chain[0].id, first.id);
    assert.equal(chain[1].id, second.id);
    assert.equal(chain[0].logSize, 2);
    assert.equal(chain[0].log, undefined);

    const listed = await history.list({project});
    assert.equal(listed.total, 2);
    assert.equal(listed.items.length, 2);

    const found = await history.findBy(e => e.output?.path === `/p/${project}/second.html`);
    assert.equal(found?.id, second.id);
  });
});

describe('Supabase migrations & entryToRow / rowToEntry round-trip (§3, M3)', () => {
  it('verifies supabase/config.toml and SQL migration files exist with required schema and RPCs', async () => {
    const configToml = await fs.readFile(path.join(rootDir, 'supabase', 'config.toml'), 'utf8');
    assert.ok(configToml.includes('project_id'));

    const initSql = await fs.readFile(
      path.join(rootDir, 'supabase', 'migrations', '20261116000001_forma_init.sql'),
      'utf8'
    );
    for (const tbl of ['projects', 'assets', 'entries', 'runs', 'run_events', 'schema_meta']) {
      assert.match(initSql, new RegExp(`create table if not exists ${tbl}\\b`));
      assert.match(initSql, new RegExp(`alter table ${tbl}\\s+enable row level security`));
    }
    assert.ok(initSql.includes("insert into schema_meta(key, value) values ('forma_schema', '1')"));
    assert.ok(initSql.includes('create unique index if not exists runs_one_active_per_campaign'));

    const rpcSql = await fs.readFile(
      path.join(rootDir, 'supabase', 'migrations', '20261116000002_forma_rpc.sql'),
      'utf8'
    );
    assert.ok(rpcSql.includes('create or replace function forma_update_entry'));
    assert.ok(rpcSql.includes('create or replace function forma_thread'));
  });

  it('round-trips synthetic fixtures of every entry type losslessly', async () => {
    const scFixture = JSON.parse(await fs.readFile(path.join(rootDir, 'fixtures', 'scenario-multi.json'), 'utf8'));
    const stFixture = JSON.parse(await fs.readFile(path.join(rootDir, 'fixtures', 'styles.json'), 'utf8'));
    const project = randomUUID();
    const campaignId = randomUUID();
    const parentId = randomUUID();

    const fixtures = [
      {
        id: randomUUID(),
        type: 'scenario',
        status: 'ok',
        createdAt: '2026-11-16T09:00:00.000Z',
        author: 'Дмитрий',
        project,
        campaign: campaignId,
        stage: 'scenario',
        kind: 'multi',
        mode: 'demo',
        model: null,
        effort: null,
        input: {setup: {kind: 'multi', languages: ['en'], lengths: [4, 10], formats: ['9x16']}},
        output: {scenario: scFixture, validation: {errors: [], warnings: [], cells: {}}},
        cost: {llm: 0, image: 0, video: 0, total: 0, unknown: false},
        log: [{i: 0, at: 10, level: 'done', msg: 'Scenario built'}],
      },
      {
        id: randomUUID(),
        type: 'style',
        status: 'ok',
        createdAt: '2026-11-16T09:01:00.000Z',
        author: 'Дмитрий',
        project,
        campaign: campaignId,
        stage: 'styles',
        kind: 'multi',
        mode: 'demo',
        model: null,
        effort: null,
        input: {scenarioId: randomUUID()},
        output: {styles: stFixture.styles},
        cost: {llm: 0.05, image: 0, video: 0, total: 0.05, unknown: false},
        log: [{i: 0, at: 15, level: 'done', msg: 'Styles built'}, {i: 1, at: 20, level: 'info', msg: 'Done'}],
      },
      {
        id: parentId,
        type: 'preview',
        status: 'ok',
        createdAt: '2026-11-16T09:02:00.000Z',
        author: 'Анна',
        project,
        campaign: campaignId,
        stage: 'preview',
        kind: 'multi',
        mode: 'claude',
        model: 'claude-sonnet-5-5',
        effort: 'high',
        input: {scenarioId: randomUUID(), styleIndex: 0, formats: ['9x16'], langs: ['en']},
        output: {revision: randomUUID(), path: `/p/${project}/${randomUUID()}.html`, format: '9x16', lang: 'en', scenes: ['s1', 's2', 's3']},
        cost: {llm: 0.12, image: 0, video: 0, total: 0.12, unknown: false},
        log: [],
      },
      {
        id: randomUUID(),
        type: 'creative',
        status: 'ok',
        createdAt: '2026-11-16T09:03:00.000Z',
        author: 'Анна',
        project,
        campaign: campaignId,
        stage: 'final',
        kind: 'multi',
        mode: 'claude',
        model: 'claude-opus-5-5',
        effort: 'high',
        input: {
          scenarioId: randomUUID(),
          previewId: parentId,
          revision: {parent: parentId, message: 'Polish typography', attachments: ['revisions/1.png']},
        },
        output: {
          revision: randomUUID(),
          path: `/p/${project}/${randomUUID()}.html`,
          stage: 'final',
          kind: 'multi',
          formats: ['9x16', '1x1'],
          langs: ['en'],
          lengths: [4, 10],
          duration: 4,
          copyVersion: 1,
        },
        media: [{kind: 'image', file: 'generated/hero.png', path: `/p/${project}/assets/generated/hero.png`, cost: 0.04}],
        cost: {llm: 0.3, image: 0.04, video: 0, total: 0.34, unknown: false},
        log: [{i: 0, at: 100, level: 'done', msg: 'Final built'}],
      },
      upgradeCampaign({
        id: campaignId,
        type: 'campaign',
        status: 'ok',
        createdAt: '2026-11-16T09:00:00.000Z',
        updatedAt: '2026-11-16T09:05:00.000Z',
        author: 'Дмитрий',
        name: 'Bill Split Campaign',
        project,
        setup: {kind: 'multi', languages: ['en'], lengths: [4, 10], formats: ['9x16', '1x1'], provider: {mode: 'demo'}},
        steps: {
          scenario: {entryId: randomUUID(), approvedAt: '2026-11-16T09:01:00.000Z', stale: false, needs: []},
          styles: {entryId: randomUUID(), chosenIndex: 0, direction: 'Editorial Split Card\n\nIdea'},
          preview: {entryId: parentId, approvedAt: '2026-11-16T09:02:30.000Z', stale: false},
          final: {entryId: randomUUID(), stale: false},
        },
        cost: {llm: 0.47, image: 0.04, video: 0, total: 0.51, unknown: false},
        log: [],
      }),
    ];

    for (const entry of fixtures) {
      const row = entryToRow(entry);
      assert.equal(row.id, entry.id);
      assert.equal(row.type, entry.type);
      assert.equal(row.status, entry.status);
      assert.equal(row.created_at, entry.createdAt);
      assert.equal(row.author, entry.author);
      assert.equal(row.project_id, entry.project);
      assert.equal(row.campaign_id, entry.type === 'campaign' ? entry.id : entry.campaign);
      assert.equal(row.parent_id, entry.input?.revision?.parent || null);
      assert.equal(row.output_path, entry.output?.path || null);
      assert.equal(row.log_size, entry.log.length);
      assert.equal(row.doc.log, undefined);

      const restored = rowToEntry(row);
      const {log, ...expectedWithoutLog} = entry;
      assert.deepEqual(restored, {
        ...expectedWithoutLog,
        logSize: log.length,
        version: 1,
      });

      // Second round-trip is identical
      assert.deepEqual(entryToRow(restored), row);
    }
  });

  it('round-trips every real entry in data/history/*.json (read-only) losslessly', async () => {
    const histDir = path.join(rootDir, 'data', 'history');
    const files = (await fs.readdir(histDir).catch(() => [])).filter(f => f.endsWith('.json'));
    let checked = 0;
    for (const file of files) {
      const raw = JSON.parse(await fs.readFile(path.join(histDir, file), 'utf8'));
      const entry = raw.type === 'campaign' ? upgradeCampaign(raw) : raw;
      const row = entryToRow(entry);
      const restored = rowToEntry(row);

      const {log, logSize, version, ...expectedDoc} = entry;
      const {logSize: actualLogSize, version: actualVersion, ...actualDoc} = restored;

      assert.deepEqual(actualDoc, expectedDoc, `Mismatch in ${file}`);
      assert.equal(actualLogSize, Array.isArray(log) ? log.length : (logSize || 0), `logSize mismatch in ${file}`);
      assert.equal(actualVersion, version || 1);
      assert.deepEqual(entryToRow(restored), row, `Second round-trip mismatch in ${file}`);
      checked++;
    }
    assert.ok(checked >= 0);
  });

  it('verifies store/supabase.mjs history operations: schema_meta check, record/get with R2 logs, list, thread, and optimistic concurrency update', async () => {
    // In-memory fake Supabase + Blobs for testing store/supabase.mjs contract
    const tables = {
      schema_meta: new Map([['forma_schema', {key: 'forma_schema', value: '1'}]]),
      entries: new Map(),
    };
    const blobMap = new Map();
    let simulateConcurrentWriter = null;

    const fakeBlobs = {
      async put(key, buf) {
        blobMap.set(key, Buffer.from(buf));
        return {key};
      },
      async get(key) {
        const b = blobMap.get(key);
        return b ? [b] : null;
      },
    };

    function makeQuery(tableName) {
      const filters = [];
      let isCountHead = false;
      let orderCol = null;
      let orderAsc = true;
      let limitCount = null;
      let op = 'select';
      let upsertPayload = null;
      let updatePayload = null;

      const matchRow = row => filters.every(fn => fn(row));
      const execute = async () => {
        if (op === 'upsert') {
          const existing = tables[tableName].get(upsertPayload.id);
          const stored = existing
            ? {...existing, ...structuredClone(upsertPayload)}
            : {...structuredClone(upsertPayload), version: upsertPayload.version || 1};
          tables[tableName].set(stored.id, stored);
          return {data: structuredClone(stored), error: null};
        }
        if (op === 'update') {
          let updated = null;
          for (const [k, r] of tables[tableName].entries()) {
            if (matchRow(r)) {
              const next = {...r, ...structuredClone(updatePayload)};
              tables[tableName].set(k, next);
              updated = next;
            }
          }
          return {data: updated, error: null};
        }
        let rows = [...tables[tableName].values()].filter(matchRow);
        if (isCountHead) {
          return {data: null, count: rows.length, error: null};
        }
        if (orderCol) {
          rows.sort((a, b) =>
            orderAsc
              ? String(a[orderCol]).localeCompare(String(b[orderCol]))
              : String(b[orderCol]).localeCompare(String(a[orderCol]))
          );
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
        upsert(row) {
          op = 'upsert';
          upsertPayload = row;
          return builder;
        },
        update(patch) {
          op = 'update';
          updatePayload = patch;
          return builder;
        },
        eq(col, val) { filters.push(r => r[col] === val); return builder; },
        neq(col, val) { filters.push(r => r[col] !== val); return builder; },
        is(col, val) { filters.push(r => (r[col] ?? null) === val); return builder; },
        lt(col, val) { filters.push(r => String(r[col]) < String(val)); return builder; },
        or(expr) {
          const tests = String(expr).split(',').map(part => {
            const [col, op, ...rest] = part.split('.');
            const val = rest.join('.');
            if (op === 'is') return r => (r[col] ?? null) === (val === 'null' ? null : val);
            if (op === 'eq') return r => String(r[col]) === val;
            if (op === 'neq') return r => r[col] !== null && r[col] !== undefined && String(r[col]) !== val;
            return () => false;
          });
          filters.push(r => tests.some(t => t(r)));
          return builder;
        },
        order(col, {ascending = true} = {}) { orderCol = col; orderAsc = ascending; return builder; },
        limit(n) { limitCount = n; return builder; },
        async maybeSingle() {
          const res = await execute();
          const row = Array.isArray(res.data) ? (res.data[0] || null) : res.data;
          return {data: row, error: res.error};
        },
        async single() {
          const res = await execute();
          const row = Array.isArray(res.data) ? (res.data[0] || null) : res.data;
          return {data: row, error: row ? null : {message: 'Not found'}};
        },
        then(onFulfilled, onRejected) {
          return execute().then(onFulfilled, onRejected);
        },
      };
      return builder;
    }

    const fakeSupabase = {
      from: tableName => makeQuery(tableName),
      async rpc(fnName, params) {
        if (fnName === 'forma_update_entry') {
          if (simulateConcurrentWriter) {
            simulateConcurrentWriter();
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
        return {data: null, error: {message: 'Unknown RPC'}};
      },
    };

    const sbStore = createSupabaseStore({supabase: fakeSupabase, blobs: fakeBlobs});

    // 1. Fails fast when schema_meta is missing or != '1'
    tables.schema_meta.clear();
    await assert.rejects(
      () => sbStore.history.open(),
      err => err.message === SCHEMA_NOT_READY_MSG
    );

    tables.schema_meta.set('forma_schema', {key: 'forma_schema', value: '1'});
    assert.equal(await sbStore.history.open(), 0);

    // 2. Record entry with log -> log uploaded to blobs, DB row has log_size
    const project = randomUUID();
    const rec1 = await sbStore.history.record({
      type: 'creative',
      author: 'Дмитрий',
      project,
      input: {scenario: 'Theme 1'},
      output: {path: `/p/${project}/1.html`},
      log: [{i: 0, at: 12, level: 'done', msg: 'Built'}],
    });
    assert.equal(rec1.logSize, 1);
    assert.ok(blobMap.has(`logs/${rec1.id}.json`));

    // Get without withLog -> log: [], logSize: 1
    const gotLight = await sbStore.history.get(rec1.id);
    assert.deepEqual(gotLight.log, []);
    assert.equal(gotLight.logSize, 1);

    // Get with withLog:true -> loads log from R2 blobs
    const gotFull = await sbStore.history.get(rec1.id, {withLog: true});
    assert.equal(gotFull.log.length, 1);
    assert.equal(gotFull.log[0].msg, 'Built');

    // 3. Thread via forma_thread RPC
    const rec2 = await sbStore.history.record({
      type: 'creative',
      author: 'Анна',
      project,
      input: {scenario: 'Theme 1', revision: {parent: rec1.id, message: 'Edit 1', attachments: []}},
      output: {path: `/p/${project}/2.html`},
      log: [],
    });
    const thread = await sbStore.history.thread(rec2.id);
    assert.equal(thread.length, 2);
    assert.equal(thread[0].id, rec1.id);
    assert.equal(thread[1].id, rec2.id);

    // 4. Optimistic concurrency on campaign update
    const camp = await sbStore.history.record({
      type: 'campaign',
      author: 'Дмитрий',
      name: 'Initial Name',
      project,
      setup: {kind: 'poster', languages: ['en'], lengths: [], formats: ['1x1']},
      steps: {scenario: {entryId: null, approvedAt: null, stale: false, needs: []}},
    });
    assert.equal(camp.version, 1);

    // Normal update increments version to 2
    const up1 = await sbStore.history.update(camp.id, {name: 'Name v2'});
    assert.equal(up1.name, 'Name v2');
    assert.equal(up1.version, 2);

    // Single concurrent conflict -> retries once and succeeds (version becomes 4)
    let conflictFired = false;
    simulateConcurrentWriter = () => {
      if (!conflictFired) {
        conflictFired = true;
        const r = tables.entries.get(camp.id);
        r.version += 1;
        r.author = 'Анна';
      }
    };
    const upRetryOk = await sbStore.history.update(camp.id, {name: 'Name after 1 retry'});
    assert.equal(upRetryOk.name, 'Name after 1 retry');
    assert.equal(upRetryOk.version, 4);

    // Double concurrent conflict -> throws 409 «Анна just updated this campaign. Refresh the page.»
    simulateConcurrentWriter = () => {
      const r = tables.entries.get(camp.id);
      r.version += 1;
      r.author = 'Анна';
    };
    await assert.rejects(
      () => sbStore.history.update(camp.id, {name: 'Should fail'}),
      err => err.status === 409 && err.message === 'Анна just updated this campaign. Refresh the page.'
    );
    simulateConcurrentWriter = null;
  });
});

describe('R2 blobs, asset index, sync.up/down & preview read-through middleware (§2.1, M4)', () => {
  let tempDir;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(tmpdir(), 'forma-sync-m4-'));
  });

  after(async () => {
    if (tempDir) await fs.rm(tempDir, {recursive: true, force: true}).catch(() => {});
  });

  it('classifies project files according to §2.1 and excludes draft.html, *.tmp, dotfiles and outside paths', () => {
    const rev = randomUUID();
    assert.equal(classifyProjectFile('assets/generated/hero-1.png'), 'generated');
    assert.equal(classifyProjectFile('assets/generated/sub/clip.mp4'), 'generated');
    assert.equal(classifyProjectFile('assets/revisions/1234abcd/1-shot.png'), 'attachment');
    assert.equal(classifyProjectFile('assets/logo.svg'), 'upload');
    assert.equal(classifyProjectFile('assets/fonts/brand-bold.woff2'), 'upload');
    assert.equal(classifyProjectFile(`${rev}.src.html`), 'source');
    assert.equal(classifyProjectFile(`${rev}.html`), 'creative');

    // Excluded files
    assert.equal(classifyProjectFile('draft.html'), null);
    assert.equal(classifyProjectFile(`${rev}.html.1234.tmp`), null);
    assert.equal(classifyProjectFile('assets/logo.svg.part'), null);
    assert.equal(classifyProjectFile('.DS_Store'), null);
    assert.equal(classifyProjectFile('assets/.DS_Store'), null);
    assert.equal(classifyProjectFile('assets/.hidden/file.png'), null);
    assert.equal(classifyProjectFile('../outside.html'), null);
    assert.equal(classifyProjectFile('assets/../../outside.png'), null);
    assert.equal(classifyProjectFile('not-a-uuid.html'), null);
  });

  it('sync.up skips unchanged files (matching size + sha256), uploads changed/new files with retries, and sync.down downloads missing/changed files atomically', async () => {
    const project = randomUUID();
    const projDir = path.join(tempDir, project);
    const rev = randomUUID();

    await fs.mkdir(path.join(projDir, 'assets', 'generated'), {recursive: true});
    await fs.mkdir(path.join(projDir, 'assets', 'revisions', 'r1'), {recursive: true});

    await fs.writeFile(path.join(projDir, 'assets', 'logo.svg'), '<svg>logo-v1</svg>');
    await fs.writeFile(path.join(projDir, 'assets', 'generated', 'hero.png'), 'png-bytes-v1');
    await fs.writeFile(path.join(projDir, 'assets', 'revisions', 'r1', 'note.png'), 'att-bytes');
    await fs.writeFile(path.join(projDir, `${rev}.src.html`), '<html><body>src</body></html>');
    await fs.writeFile(path.join(projDir, `${rev}.html`), '<html><body>injected</body></html>');
    // Excluded files that must never be uploaded
    await fs.writeFile(path.join(projDir, 'draft.html'), '<html>draft</html>');
    await fs.writeFile(path.join(projDir, 'temp.tmp'), 'tmp');
    await fs.writeFile(path.join(projDir, '.DS_Store'), 'dotfile');

    const assetTable = new Map(); // `${project}:${path}` -> row
    const projectTable = new Map();
    const blobStore = new Map(); // key -> {buf, contentType, sha256}
    let putCalls = 0;
    let failNextPut = 0;

    const fakeBlobs = {
      async put(key, buf, {contentType, sha256} = {}) {
        putCalls++;
        if (failNextPut > 0) {
          failNextPut--;
          throw Error('Simulated transient R2 error');
        }
        const b = Buffer.from(buf);
        blobStore.set(key, {buf: b, contentType, sha256, size: b.length});
        return {key, size: b.length, sha256};
      },
      async get(key) {
        const entry = blobStore.get(key);
        return entry ? [entry.buf] : null;
      },
      async head(key) {
        const entry = blobStore.get(key);
        return entry ? {key, size: entry.size, sha256: entry.sha256, contentType: entry.contentType} : null;
      },
    };

    const fakeSupabase = {
      from(table) {
        const filters = [];
        return {
          select() { return this; },
          eq(col, val) { filters.push(r => r[col] === val); return this; },
          async upsert(payload) {
            const rows = Array.isArray(payload) ? payload : [payload];
            if (table === 'projects') {
              for (const r of rows) projectTable.set(r.id, r);
            } else if (table === 'assets') {
              for (const r of rows) assetTable.set(`${r.project_id}:${r.path}`, structuredClone(r));
            }
            return {data: rows, error: null};
          },
          then(resolve) {
            if (table === 'assets') {
              const rows = [...assetTable.values()].filter(r => filters.every(fn => fn(r)));
              return Promise.resolve({data: rows, error: null}).then(resolve);
            }
            return Promise.resolve({data: [], error: null}).then(resolve);
          },
        };
      },
    };

    const sbStore = createSupabaseStore({
      supabase: fakeSupabase,
      blobs: fakeBlobs,
      dataDir: tempDir,
    });

    // 1. First sync.up uploads all 5 classified files and ignores the 3 excluded files
    const res1 = await sbStore.sync.up(project);
    assert.equal(res1.uploaded, 5);
    assert.equal(res1.skipped, 0);
    assert.equal(putCalls, 5);
    assert.equal(blobStore.has(`projects/${project}/draft.html`), false);
    assert.equal(blobStore.has(`projects/${project}/.DS_Store`), false);
    assert.ok(projectTable.has(project));

    const indexed = await sbStore.assets.index(project);
    assert.equal(indexed.length, 5);
    const byPath = Object.fromEntries(indexed.map(r => [r.path, r]));
    assert.equal(byPath['assets/logo.svg'].kind, 'upload');
    assert.equal(byPath['assets/generated/hero.png'].kind, 'generated');
    assert.equal(byPath['assets/revisions/r1/note.png'].kind, 'attachment');
    assert.equal(byPath[`${rev}.src.html`].kind, 'source');
    assert.equal(byPath[`${rev}.html`].kind, 'creative');

    // 2. Second sync.up with no changes skips all 5 files (0 PutObject calls)
    putCalls = 0;
    const res2 = await sbStore.sync.up(project);
    assert.equal(res2.uploaded, 0);
    assert.equal(res2.skipped, 5);
    assert.equal(putCalls, 0);

    // 3. Modify 1 file with same byte size (different sha256) and simulate 2 transient PutObject failures -> retries and succeeds
    await fs.writeFile(path.join(projDir, 'assets', 'logo.svg'), '<svg>logo-v2</svg>');
    failNextPut = 2; // succeeds on 3rd attempt
    const res3 = await sbStore.sync.up(project);
    assert.equal(res3.uploaded, 1);
    assert.equal(res3.skipped, 4);
    assert.equal(putCalls, 3); // 2 failed attempts + 1 success

    // 4. sync.down into a fresh cache dir downloads all 5 files and skips them on second run
    const cacheDir2 = await fs.mkdtemp(path.join(tmpdir(), 'forma-down-m4-'));
    try {
      const down1 = await sbStore.sync.down(project, {dataDir: cacheDir2});
      assert.equal(down1.downloaded, 5);
      assert.equal(down1.skipped, 0);
      const downloadedLogo = await fs.readFile(path.join(cacheDir2, project, 'assets', 'logo.svg'), 'utf8');
      assert.equal(downloadedLogo, '<svg>logo-v2</svg>');

      const down2 = await sbStore.sync.down(project, {dataDir: cacheDir2});
      assert.equal(down2.downloaded, 0);
      assert.equal(down2.skipped, 5);
    } finally {
      await fs.rm(cacheDir2, {recursive: true, force: true}).catch(() => {});
    }
  });

  it('read-through middleware serves cached files, fetches & caches on miss, and returns 404 with security headers on missing objects', async () => {
    const cacheDir = await fs.mkdtemp(path.join(tmpdir(), 'forma-preview-rt-'));
    try {
      const project = randomUUID();
      const rev = randomUUID();
      const blobMap = new Map([
        [`projects/${project}/${rev}.html`, Buffer.from('<!doctype html><html><body>From R2</body></html>')],
      ]);
      let blobGets = 0;

      const fakeBlobs = {
        async get(key) {
          blobGets++;
          const buf = blobMap.get(key);
          return buf ? [buf] : null;
        },
      };

      const middleware = createPreviewReadThrough({dataDir: cacheDir, blobs: fakeBlobs});

      const callPreview = (urlPath, method = 'GET') =>
        new Promise((resolve, reject) => {
          const headers = {};
          const chunks = [];
          const req = {method, path: urlPath, url: urlPath};
          const res = {
            statusCode: 200,
            headersSent: false,
            set(k, v) {
              if (typeof k === 'object') Object.assign(headers, k);
              else headers[k] = v;
              return this;
            },
            status(code) {
              this.statusCode = code;
              return this;
            },
            sendStatus(code) {
              this.statusCode = code;
              this.headersSent = true;
              resolve({status: code, headers, body: ''});
              return this;
            },
            write(chunk) {
              this.headersSent = true;
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              return true;
            },
            end(chunk) {
              this.headersSent = true;
              if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              resolve({status: this.statusCode, headers, body: Buffer.concat(chunks).toString('utf8')});
              return this;
            },
            on() { return this; },
            once() { return this; },
            emit() { return this; },
          };
          middleware(req, res, reject);
        });

      // 1. Cache miss -> fetches from R2, writes to local cache, returns 200 with security headers + Content-Type
      const missRes = await callPreview(`/${project}/${rev}.html`);
      assert.equal(missRes.status, 200);
      assert.equal(missRes.body, '<!doctype html><html><body>From R2</body></html>');
      assert.equal(missRes.headers['Content-Type'], 'text/html; charset=utf-8');
      assert.equal(missRes.headers['Content-Security-Policy'], PREVIEW_SECURITY_HEADERS['Content-Security-Policy']);
      assert.equal(missRes.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(blobGets, 1);

      // Verify file is now cached on disk
      const cachedOnDisk = await fs.readFile(path.join(cacheDir, project, `${rev}.html`), 'utf8');
      assert.equal(cachedOnDisk, '<!doctype html><html><body>From R2</body></html>');

      // 2. Second request is a cache hit -> served from local disk without calling blobs.get
      const hitRes = await callPreview(`/${project}/${rev}.html`);
      assert.equal(hitRes.status, 200);
      assert.equal(hitRes.body, '<!doctype html><html><body>From R2</body></html>');
      assert.equal(blobGets, 1);

      // 3. Missing object -> returns 404 with security headers present
      const notFoundRes = await callPreview(`/${project}/${randomUUID()}.html`);
      assert.equal(notFoundRes.status, 404);
      assert.equal(notFoundRes.headers['Content-Security-Policy'], PREVIEW_SECURITY_HEADERS['Content-Security-Policy']);
      assert.equal(notFoundRes.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(notFoundRes.headers['Referrer-Policy'], 'no-referrer');

      // 4. /history guard -> 404 with security headers
      const historyGuardRes = await callPreview(`/history/${randomUUID()}.json`);
      assert.equal(historyGuardRes.status, 404);
      assert.equal(historyGuardRes.headers['Content-Security-Policy'], PREVIEW_SECURITY_HEADERS['Content-Security-Policy']);

      // 5. A brand file referenced without the assets/ prefix falls back to assets/<rest>, locally and from R2
      await fs.mkdir(path.join(cacheDir, project, 'assets', 'Pack'), {recursive: true});
      await fs.writeFile(path.join(cacheDir, project, 'assets', 'Pack', 'logo.svg'), '<svg></svg>');
      const localFallback = await callPreview(`/${project}/Pack/logo.svg`);
      assert.equal(localFallback.status, 200);
      assert.equal(localFallback.body, '<svg></svg>');
      blobMap.set(`projects/${project}/assets/Pack/font.ttf`, Buffer.from('FONT'));
      const remoteFallback = await callPreview(`/${project}/Pack/font.ttf`);
      assert.equal(remoteFallback.status, 200);
      assert.equal(remoteFallback.body, 'FONT');
    } finally {
      await fs.rm(cacheDir, {recursive: true, force: true}).catch(() => {});
    }
  });
});

describe('Runs locking, heartbeat, event flushing, render-progress fallback & FORMA_STORE=memory integration (§3.3, §3.4, §10, M5)', () => {
  let tempDir, app, projectId;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(tmpdir(), 'forma-memory-m5-'));
    memoryStore.reset();
    selectStore('memory');
    await history.open(tempDir);

    projectId = randomUUID();
    await fs.mkdir(path.join(tempDir, projectId, 'assets'), {recursive: true});

    app = express();
    registerBrandRoutes(app);
    const {reviseCampaignEntry} = registerCampaignRoutes(app, {
      root: rootDir,
      dataDir: tempDir,
      previewURL: 'http://127.0.0.1:4318',
      libs: '',
      folder: id => path.join(tempDir, id),
      assetName: n => n,
      checkProvider: async () => {},
      listAssets: async () => ['logo.svg'],
      generatedMedia: () => [],
      costLine: () => '',
      assetURL: (id, f) => `/p/${id}/assets/${f}`,
      runModelText: async () => '{}',
      runModelHtml: async () => '<html><body></body></html>',
      runModelRevise: async () => ({html: '<html><body></body></html>', reply: 'ok'}),
    });
    app.post('/api/history/:id/revise', async (req, res) => {
      const parent = await history.get(req.params.id);
      if (parent && parent.campaign && ['preview', 'creative'].includes(parent.type) && parent.output?.path) {
        return reviseCampaignEntry(req, res, parent);
      }
      res.status(404).json({error: 'Not found'});
    });
    app.use((err, _req, res, _next) => {
      res.status(err.status || 500).json({error: err.message});
    });
  });

  after(async () => {
    selectStore('file');
    if (tempDir) await fs.rm(tempDir, {recursive: true, force: true}).catch(() => {});
  });

  const req = (method, urlPath, body, {author = 'Дмитрий'} = {}) =>
    new Promise(resolve => {
      const u = new URL(urlPath, 'http://127.0.0.1:4317');
      const mockReq = {
        method: method.toUpperCase(),
        url: u.pathname + u.search,
        originalUrl: u.pathname + u.search,
        path: u.pathname,
        query: Object.fromEntries(u.searchParams.entries()),
        headers: {
          'content-type': 'application/json',
          'x-forma': 'studio',
          ...(author ? {'x-forma-author': author} : {}),
        },
        body: body ?? {},
        on() {},
        once() {},
        emit() {},
      };
      Object.setPrototypeOf(mockReq, express.request);
      const headers = {};
      const mockRes = {
        statusCode: 200,
        writableFinished: false,
        status(code) { this.statusCode = code; return this; },
        set(k, v) { if (typeof k === 'object') Object.assign(headers, k); else headers[k] = v; return this; },
        setHeader(k, v) { headers[k] = v; return this; },
        getHeader(k) { return headers[k]; },
        json(payload) {
          this.writableFinished = true;
          resolve({status: this.statusCode, body: payload});
          return this;
        },
        sendStatus(code) {
          this.statusCode = code;
          this.writableFinished = true;
          resolve({status: code, body: null});
          return this;
        },
        end(data) {
          this.writableFinished = true;
          resolve({status: this.statusCode, body: data});
          return this;
        },
      };
      Object.setPrototypeOf(mockRes, express.response);
      app.handle(mockReq, mockRes, err => {
        if (err) resolve({status: err.status || 500, body: {error: err.message}});
      });
    });

  it('sweeps dead runs older than 120s with «Run interrupted», batches >100 events, and serves colleague runs via render-progress fallback', async () => {
    const cloud = createMemoryCloud({dataDir: tempDir});
    const campaignId = randomUUID();
    const deadRunId = randomUUID();

    // Start a run and backdate its heartbeat_at by 130 seconds
    await cloud.runs.start({
      id: deadRunId,
      campaignId,
      projectId,
      task: 'scenario',
      author: 'Дмитрий',
    });
    const deadRow = cloud.tables.runs.get(deadRunId);
    deadRow.heartbeat_at = new Date(Date.now() - 130_000).toISOString();

    // Starting a new run on the same campaign marks the dead run as error «Run interrupted» and succeeds
    const liveRunId = randomUUID();
    await cloud.runs.start({
      id: liveRunId,
      campaignId,
      projectId,
      task: 'preview',
      author: 'Анна',
    });
    assert.equal(cloud.tables.runs.get(deadRunId).status, 'error');
    assert.equal(cloud.tables.runs.get(deadRunId).status_text, 'Run interrupted');

    // Batch 135 events into run_events and update heartbeat
    const eventsBatch = Array.from({length: 135}, (_, i) => ({
      i,
      at: i * 10,
      level: i === 134 ? 'done' : 'info',
      msg: `Event #${i}`,
    }));
    await cloud.runs.events(liveRunId, eventsBatch);
    await cloud.runs.heartbeat(liveRunId, {
      statusText: 'Сборка превью…',
      costs: {llm: 0.08, image: 0, video: 0, total: 0.08, unknown: false},
    });

    // Colleague polls runs.get(id, since) (same shape as render-progress, without draft/tail)
    const snap0 = await cloud.runs.get(liveRunId, 0);
    assert.equal(snap0.done, false);
    assert.equal(snap0.status, 'Сборка превью…');
    assert.equal(snap0.events.length, 135);
    assert.equal(snap0.next, 135);
    assert.equal(snap0.draft, undefined);
    assert.equal(snap0.tail, undefined);

    const snapSince130 = await cloud.runs.get(liveRunId, 130);
    assert.equal(snapSince130.events.length, 5);
    assert.equal(snapSince130.events[0].i, 130);

    // Finish run -> uploads logs/<entryId>.json to R2 blobs
    const entryId = randomUUID();
    await cloud.runs.finish(liveRunId, {
      status: 'done',
      entryId,
      costs: {llm: 0.08, image: 0, video: 0, total: 0.08, unknown: false},
      log: eventsBatch,
    });
    assert.ok(cloud.blobMap.has(`logs/${entryId}.json`));
    const snapDone = await cloud.runs.get(liveRunId, 135);
    assert.equal(snapDone.done, true);
  });

  it('runs the full demo campaign flow on FORMA_STORE=memory with two simulated authors (§10)', async () => {
    assert.equal(store.driver, 'memory');

    // Author A (Дмитрий) creates a campaign
    const created = await req(
      'POST',
      '/api/campaigns',
      {
        project: projectId,
        setup: {
          kind: 'multi',
          languages: ['en', 'ru'],
          lengths: [4, 10],
          formats: ['9x16', '1x1'],
          provider: {mode: 'demo'},
        },
      },
      {author: 'Дмитрий'}
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.author, 'Дмитрий');
    const cid = created.body.id;

    // 1. Author A starts scenario step; while it is running:
    //    - Author B sees it in GET /api/runs/active
    //    - Author B starting a step on the same campaign gets 409 «Wait for the current step to finish (started by Дмитрий).»
    const stepAPromise = req('POST', `/api/campaigns/${cid}/scenario`, {notes: 'Author A scenario'}, {author: 'Дмитрий'});

    // Wait a tick so Author A's run is registered in DB
    await new Promise(r => setTimeout(r, 30));

    const activeRes = await req('GET', '/api/runs/active', null, {author: 'Анна'});
    assert.equal(activeRes.status, 200);
    assert.equal(activeRes.body.runs.length, 1);
    assert.equal(activeRes.body.runs[0].campaignId, cid);
    assert.equal(activeRes.body.runs[0].author, 'Дмитрий');
    assert.equal(activeRes.body.runs[0].task, 'scenario');

    // Colleague render-progress fallback for a run not in local jobs map
    const fakeRemoteRunId = randomUUID();
    await memoryStore.runs.start({
      id: fakeRemoteRunId,
      campaignId: randomUUID(),
      projectId,
      task: 'preview',
      author: 'Дмитрий',
    });
    await memoryStore.runs.events(fakeRemoteRunId, [{i: 0, at: 50, level: 'step', msg: 'Remote step'}]);
    const remoteProg = await req('GET', `/api/render-progress/${fakeRemoteRunId}?since=0`, null, {author: 'Анна'});
    assert.equal(remoteProg.status, 200);
    assert.equal(remoteProg.body.events.length, 1);
    assert.equal(remoteProg.body.events[0].msg, 'Remote step');
    assert.equal(remoteProg.body.draft, undefined);
    await memoryStore.runs.finish(fakeRemoteRunId, {status: 'done'});

    // Author B tries to start a step on the same campaign while Author A's step is running -> 409
    const blockedB = await req('POST', `/api/campaigns/${cid}/scenario`, {}, {author: 'Анна'});
    assert.equal(blockedB.status, 409);
    assert.equal(blockedB.body.error, 'Wait for the current step to finish (started by Дмитрий).');

    const stepADone = await stepAPromise;
    assert.equal(stepADone.status, 200);

    // Approve scenario
    const appSc = await req('POST', `/api/campaigns/${cid}/approve`, {step: 'scenario'}, {author: 'Дмитрий'});
    assert.equal(appSc.status, 200);

    // 2. Two concurrent PATCHes -> when version conflicts across both attempts, returns 409 with conflict message
    memoryStore.setBeforeUpdateHook((params, tables) => {
      const row = tables.entries.get(params.p_id);
      if (row) {
        row.version += 1;
        row.author = 'Дмитрий';
        if (row.doc) row.doc.author = 'Дмитрий';
      }
    });
    const conflictPatch = await req('PATCH', `/api/campaigns/${cid}`, {name: 'Conflicting Rename'}, {author: 'Анна'});
    memoryStore.setBeforeUpdateHook(null);
    assert.equal(conflictPatch.status, 409);
    assert.equal(conflictPatch.body.error, 'Дмитрий just updated this campaign. Refresh the page.');

    // 3. Build Variant 1 (styles -> choose 0 -> preview -> approve -> final) by Author A
    const cover = async () => {
      const response = await req('GET', '/api/brand-campaigns?covers=1');
      assert.equal(response.status, 200);
      return response.body.find(c => c.id === cid).cover;
    };
    assert.equal(await cover(), null);
    const stRes = await req('POST', `/api/campaigns/${cid}/styles`, {}, {author: 'Дмитрий'});
    assert.equal(stRes.status, 200);
    assert.equal((await cover()).stage, 'sketch');
    await req('POST', `/api/campaigns/${cid}/styles/choose`, {index: 0}, {author: 'Дмитрий'});
    const prev1 = await req('POST', `/api/campaigns/${cid}/preview`, {}, {author: 'Дмитрий'});
    assert.equal(prev1.status, 200);
    assert.equal((await cover()).stage, 'preview');
    await req('POST', `/api/campaigns/${cid}/approve`, {step: 'preview'}, {author: 'Дмитрий'});
    const fin1 = await req('POST', `/api/campaigns/${cid}/final`, {media: {images: false, video: false}}, {author: 'Дмитрий'});
    assert.equal(fin1.status, 200);
    const v1Id = fin1.body.campaign.activeVariant;

    // 4. Author B creates a new style variant (choosing index 1 from existing styles) and builds preview + final
    const chooseVar2 = await req('POST', `/api/campaigns/${cid}/styles/choose`, {index: 1}, {author: 'Анна'});
    assert.equal(chooseVar2.status, 200);
    assert.equal(chooseVar2.body.variants.length, 2);
    const v2Id = chooseVar2.body.activeVariant;
    assert.notEqual(v2Id, v1Id);
    assert.equal((await cover()).path, fin1.body.campaign.entries.final.output.path);
    assert.equal(chooseVar2.body.variants.find(v => v.id === v2Id).author, 'Анна');

    const prev2 = await req('POST', `/api/campaigns/${cid}/preview`, {}, {author: 'Анна'});
    assert.equal(prev2.status, 200);
    await req('POST', `/api/campaigns/${cid}/approve`, {step: 'preview'}, {author: 'Анна'});
    const fin2 = await req('POST', `/api/campaigns/${cid}/final`, {media: {images: false, video: false}}, {author: 'Анна'});
    assert.equal(fin2.status, 200);

    // Campaign now lists 2 variants with both previewPath and finalPath
    const hydrated = fin2.body.campaign;
    assert.equal(hydrated.variants.length, 2);
    assert.ok(hydrated.variants[0].finalPath);
    assert.ok(hydrated.variants[1].finalPath);

    // Switching variants via PATCH /api/campaigns/:id {activeVariant} preserves setup formats, languages, lengths
    const switchedToV1 = await req('PATCH', `/api/campaigns/${cid}`, {activeVariant: v1Id}, {author: 'Дмитрий'});
    assert.equal(switchedToV1.status, 200);
    assert.equal(switchedToV1.body.activeVariant, v1Id);
    assert.deepEqual(switchedToV1.body.entries.final.output.formats, ['9x16', '1x1']);
    assert.deepEqual(switchedToV1.body.entries.final.output.langs, ['en', 'ru']);
    assert.deepEqual(switchedToV1.body.entries.final.output.lengths, [4, 10]);
    assert.equal(switchedToV1.body.entries.final.id, fin1.body.historyId);

    // The third direction can carry edited art direction without overwriting the first two finals.
    const third = await req('POST', `/api/campaigns/${cid}/styles/choose`, {index:2, direction:'Custom art direction'});
    assert.equal(third.body.steps.styles.direction, 'Custom art direction');
    assert.equal((await req('POST', `/api/campaigns/${cid}/preview`, {})).status, 200);
    await req('POST', `/api/campaigns/${cid}/approve`, {step:'preview'});
    const fin3 = await req('POST', `/api/campaigns/${cid}/final`, {media:{images:false,video:false}});
    assert.equal(new Set(fin3.body.campaign.variants.map(v => v.finalPath)).size, 3);

    // 5. Author B creates a second campaign; verify author/excludeAuthor filters on GET /api/campaigns and store.status() (M6)
    const createdByAnna = await req(
      'POST',
      '/api/campaigns',
      {
        project: projectId,
        name: 'Кампания Анны',
        setup: {
          kind: 'poster',
          languages: ['ru'],
          lengths: [],
          formats: ['1x1'],
          provider: {mode: 'demo'},
        },
      },
      {author: 'Анна'}
    );
    assert.equal(createdByAnna.status, 201);
    assert.equal(createdByAnna.body.author, 'Анна');

    const allCamps = await req('GET', '/api/campaigns', null, {author: 'Дмитрий'});
    assert.equal(allCamps.body.items.length, 2);

    const mineDima = await req('GET', '/api/campaigns?author=' + encodeURIComponent('Дмитрий'), null, {author: 'Дмитрий'});
    assert.equal(mineDima.body.items.length, 1);
    assert.equal(mineDima.body.items[0].id, cid);

    const colleaguesOfDima = await req('GET', '/api/campaigns?excludeAuthor=' + encodeURIComponent('Дмитрий'), null, {author: 'Дмитрий'});
    assert.equal(colleaguesOfDima.body.items.length, 1);
    assert.equal(colleaguesOfDima.body.items[0].id, createdByAnna.body.id);
    assert.equal(colleaguesOfDima.body.items[0].author, 'Анна');

    const stMissingAuthor = await store.status();
    assert.equal(stMissingAuthor.driver, 'memory');
    assert.equal(stMissingAuthor.ready, false);
    assert.match(stMissingAuthor.error, /FORMA_AUTHOR/);

    const prevAuthor = process.env.FORMA_AUTHOR;
    process.env.FORMA_AUTHOR = 'Дмитрий';
    try {
      const stStatus = await store.status();
      assert.equal(stStatus.driver, 'memory');
      assert.equal(stStatus.author, 'Дмитрий');
      assert.equal(stStatus.ready, true);
    } finally {
      if (prevAuthor === undefined) delete process.env.FORMA_AUTHOR;
      else process.env.FORMA_AUTHOR = prevAuthor;
    }
  });
  it('reuses and versions brand files across independent campaign projects', async () => {
    const create = async (name, text, previous = {}) => {
      const file = await req('PUT', '/api/brand-files', Buffer.from(text));
      assert.equal(file.status, 200);
      return req('POST', '/api/brands', {...previous, name, files:[{name:'logos/mark.svg', hash:file.body.hash}]});
    };
    const first = await create('Original', 'v1');
    assert.equal(first.status, 201);
    const brand = first.body;
    const setup = {kind:'poster', languages:['en'], lengths:[], formats:['1x1'], provider:{mode:'demo'}};
    const campaign = version => req('POST', '/api/campaigns', {brandId:brand.id, brandVersion:version, setup});
    const a = await campaign(1);
    assert.equal(a.status, 201);
    const second = await create('Renamed', 'v2', brand);
    assert.equal(second.body.version, 2);
    assert.equal((await create('Stale edit', 'v3', brand)).status, 409);
    assert.equal((await req('GET','/api/brands')).body[0].name, 'Renamed');
    const b = await campaign(2);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.project,b.body.project);
    for (const [c,text] of [[a,'v1'],[b,'v2']]) {
      const file = path.join(tempDir,c.body.project,'assets','logos','mark.svg');
      await fs.unlink(file);
      await store.sync.down(c.body.project,{dataDir:tempDir});
      assert.equal(await fs.readFile(file,'utf8'),text);
    }
    const listed = await req('GET','/api/brand-campaigns?brand=' + brand.id);
    assert.deepEqual(new Set(listed.body.map(c => c.id)),new Set([a.body.id,b.body.id]));
  });

  it('writes brand notes on save, keeps hand edits and client decisions, and carries them into campaigns', async () => {
    const file = await req('PUT', '/api/brand-files', Buffer.from('<svg/>'));
    const created = await req('POST', '/api/brands', {name:'Notes Co', files:[{name:'logos/mark.svg', hash:file.body.hash}], provider:{mode:'demo'}});
    assert.equal(created.status, 201);
    const id = created.body.id;
    const setup = {kind:'poster', languages:['en'], lengths:[], formats:['1x1'], provider:{mode:'demo'}};
    // A campaign started before the notes exist (pinned to version 1).
    const early = await req('POST', '/api/campaigns', {brandId:id, brandVersion:1, setup});
    assert.equal(early.status, 201);
    // Demo never writes notes on its own; the explicit button does.
    assert.equal((await req('GET', `/api/brands/${id}/notes`)).body.status, 'missing');
    assert.equal((await req('POST', `/api/brands/${id}/notes`, {provider:{mode:'demo'}})).status, 202);

    let notes;
    for (let i = 0; i < 50; i++) {
      notes = await req('GET', `/api/brands/${id}/notes`);
      if (notes.body.status === 'ready') break;
      await new Promise(ok => setTimeout(ok, 20));
    }
    assert.equal(notes.body.status, 'ready');
    assert.equal(notes.body.source, 'generated');
    assert.equal(notes.body.brand.version, 2);
    assert.match(notes.body.text, /## Client decisions\n- none yet/);
    assert.match(notes.body.text, /## Character/);

    // An editor opened on version 1 (before the notes) still saves, on top of the notes, and keeps them.
    const logo2 = await req('PUT', '/api/brand-files', Buffer.from('<svg id="2"/>'));
    const rebased = await req('POST', '/api/brands', {id, version:1, name:'Notes Co', files:[{name:'logos/mark.svg', hash:logo2.body.hash}]});
    assert.equal(rebased.status, 201);
    assert.equal(rebased.body.version, 3);
    assert.ok(rebased.body.files.some(f => f.name === 'BRAND-NOTES.md'));
    notes = await req('GET', `/api/brands/${id}/notes`);
    assert.equal(notes.body.outdated, true);

    // Hand edit is saved as is and survives a plain brand re-save with the same files.
    const edited = await req('PUT', `/api/brands/${id}/notes`, {text:notes.body.text.replace('Demo notes', 'Calm and precise'), version:3});
    assert.equal(edited.status, 200);
    assert.equal(edited.body.source, 'edited');
    const latest = (await req('GET', '/api/brands')).body.find(b => b.id === id);
    const resaved = await req('POST', '/api/brands', {id, version:latest.version, name:'Notes Co', files:latest.files, provider:{mode:'demo'}});
    assert.equal(resaved.status, 201);
    assert.equal(resaved.body.notes.source, 'edited');
    const stale = await req('PUT', `/api/brands/${id}/notes`, {text:'# x\n## Character\nx', version:3});
    assert.equal(stale.status, 409);

    // Remember for the brand: the early campaign picks the notes up and adds the decision; the brand gets it too.
    const remembered = await req('POST', `/api/campaigns/${early.body.id}/remember`, {text:"The founder's face is not shown."});
    assert.equal(remembered.status, 200);
    assert.match(remembered.body.notes, /## Client decisions\n- The founder's face is not shown\./);
    assert.match(remembered.body.notes, /Calm and precise/);
    const local = await fs.readFile(path.join(tempDir, early.body.project, 'assets', 'BRAND-NOTES.md'), 'utf8');
    assert.equal(local, remembered.body.notes);
    const after = await req('GET', `/api/brands/${id}/notes`);
    assert.equal(after.body.brand.version, remembered.body.brandVersion);
    assert.match(after.body.text, /The founder's face is not shown\./);

    // A rewrite replaces the text but keeps the client decisions.
    const rewrite = await req('POST', `/api/brands/${id}/notes`, {provider:{mode:'demo'}});
    assert.equal(rewrite.status, 202);
    for (let i = 0; i < 50; i++) {
      notes = await req('GET', `/api/brands/${id}/notes`);
      if (notes.body.status === 'ready' && notes.body.source === 'generated') break;
      await new Promise(ok => setTimeout(ok, 20));
    }
    assert.equal(notes.body.source, 'generated');
    assert.doesNotMatch(notes.body.text, /Calm and precise/);
    assert.match(notes.body.text, /## Client decisions\n- The founder's face is not shown\./);

    // Open questions: answering one turns it into a client decision.
    const withQuestion = notes.body.text.trimEnd() + '\n\n## Open questions\n- Faces? shown or not\n';
    const q1 = await req('PUT', `/api/brands/${id}/notes`, {text:withQuestion, version:notes.body.brand.version});
    assert.deepEqual(q1.body.questions, ['Faces? shown or not']);
    const decided = await req('POST', `/api/brands/${id}/notes/decide`, {question:'Faces? shown or not', decision:'No faces.'});
    assert.equal(decided.status, 200);
    assert.deepEqual(decided.body.questions, []);
    assert.match(decided.body.text, /- No faces\./);
    assert.equal((await req('POST', `/api/brands/${id}/notes/decide`, {question:'Faces? shown or not', decision:'x'})).status, 409);
    notes = decided;

    // A new campaign from the latest version gets the notes with its materials.
    const fresh = await req('POST', '/api/campaigns', {brandId:id, brandVersion:notes.body.brand.version, setup});
    const copied = await fs.readFile(path.join(tempDir, fresh.body.project, 'assets', 'BRAND-NOTES.md'), 'utf8');
    assert.match(copied, /The founder's face is not shown\./);
  });

});



