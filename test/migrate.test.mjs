// scripts/lib/cloud-migrate.mjs against the in-memory cloud (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createMemoryCloud} from '../store/memory.mjs';
import {authorStorage} from '../store/supabase.mjs';
import {migrate, pull, scanLocal, summarize, planForkMerges, seededUUID, upgradeForCloud} from '../scripts/lib/cloud-migrate.mjs';

const P1 = '11111111-1111-4111-8111-111111111111';
const id = n => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REV = 'bbbbbbbb-0000-4000-8000-000000000001', REV2 = 'bbbbbbbb-0000-4000-8000-000000000002', PREV = 'bbbbbbbb-0000-4000-8000-000000000003';
const sha = buf => createHash('sha256').update(buf).digest('hex');
const AUTHOR = 'Дмитрий';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-mig-'));
  const p = (...parts) => path.join(root, P1, ...parts);
  await fs.mkdir(p('assets', 'generated'), {recursive:true});
  await fs.mkdir(p('assets', 'revisions', 'abc'), {recursive:true});
  await fs.writeFile(p('assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await fs.writeFile(p('assets', 'generated', 'hero.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  await fs.writeFile(p('assets', 'revisions', 'abc', '1-shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]));
  for (const rev of [REV, REV2, PREV]) {
    await fs.writeFile(p(rev + '.html'), `<html><body>${rev}</body></html>`);
    await fs.writeFile(p(rev + '.src.html'), `<html><body>src ${rev}</body></html>`);
  }
  await fs.writeFile(p('draft.html'), 'excluded');
  await fs.writeFile(p('assets', '.DS_Store'), 'excluded');
  const t = n => `2026-11-15T10:${String(n).padStart(2, '0')}:00.000Z`;
  const log = [{at:0, level:'step', msg:'start'}, {at:900, level:'done', msg:'ok'}];
  const entries = [
    {id:id(1), type:'scenario', createdAt:t(1), project:P1, campaign:id(10), output:{scenario:{theme:'T'}}, log},
    {id:id(2), type:'style', createdAt:t(2), project:P1, campaign:id(10), output:{styles:[{name:'А'}, {name:'Б'}, {name:'В'}]}, log},
    {id:id(3), type:'preview', createdAt:t(3), project:P1, campaign:id(10), output:{path:`/p/${P1}/${PREV}.html`}, log},
    {id:id(4), type:'creative', createdAt:t(4), project:P1, campaign:id(10), output:{path:`/p/${P1}/${REV}.html`}, log},
    {id:id(5), type:'creative', createdAt:t(5), project:P1, campaign:id(10), output:{path:`/p/${P1}/${REV2}.html`, reply:'Готово'},
      input:{revision:{parent:id(4), message:'Подними заголовок', attachments:['revisions/abc/1-shot.png']}}, log},
    {id:id(6), type:'creative', createdAt:t(6), project:P1, output:{path:`/p/${P1}/${REV}.html`}, log:[]},
    {id:id(10), type:'campaign', createdAt:t(7), project:P1, name:'Кампания', status:'ok', cost:{llm:1, image:0, video:0, total:1, unknown:false},
      steps:{scenario:{entryId:id(1), approvedAt:t(1), stale:false, needs:[]}, styles:{entryId:id(2), chosenIndex:0, direction:'А\n\nидея'},
        preview:{entryId:id(3), approvedAt:t(3), stale:false}, final:{entryId:id(4), stale:false}}},
    {id:id(11), type:'campaign', createdAt:t(8), project:P1, name:'Кампания (Б)', status:'ok', cost:{llm:0.5, image:0, video:0, total:0.5, unknown:false},
      steps:{scenario:{entryId:id(1), approvedAt:t(1), stale:false, needs:[]}, styles:{entryId:id(2), chosenIndex:1, direction:'Б\n\nидея'},
        preview:{entryId:null, approvedAt:null, stale:false}, final:{entryId:null, stale:false}}},
  ];
  await fs.mkdir(path.join(root, 'history'));
  for (const e of entries) await fs.writeFile(path.join(root, 'history', e.id + '.json'), JSON.stringify(e));
  await fs.writeFile(path.join(root, 'history', 'broken.json'), '{not json');
  return root;
}
const run = (fn) => authorStorage.run(AUTHOR, fn);

test('seededUUID is a stable v4-shaped UUID', () => {
  assert.equal(seededUUID('x'), seededUUID('x'));
  assert.notEqual(seededUUID('x'), seededUUID('y'));
  assert.match(seededUUID('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('upgradeForCloud gives old campaigns a deterministic variant id', () => {
  const doc = {id:id(10), type:'campaign', steps:{scenario:{entryId:id(1)}, styles:{entryId:id(2), chosenIndex:0, direction:'А\n\nидея'}}};
  const a = upgradeForCloud(doc), b = upgradeForCloud(doc);
  assert.equal(a.variants.length, 1);
  assert.equal(a.variants[0].id, b.variants[0].id);
  assert.equal(a.activeVariant, a.variants[0].id);
});

test('scan classifies files, skips drafts/dotfiles and broken history', async () => {
  const root = await fixture();
  const scan = await scanLocal(root);
  const s = summarize(scan);
  assert.equal(s.projects, 1);
  assert.equal(s.files, 9); // logo, hero, attachment, 3 × (html + src)
  assert.deepEqual(Object.keys(s.byKind).sort(), ['attachment', 'creative', 'generated', 'source', 'upload']);
  assert.equal(s.entries, 8);
  assert.equal(s.broken, 1);
  assert.equal(planForkMerges(scan.entries.filter(e => e.type === 'campaign')).length, 1);
});

test('dry run writes nothing; apply uploads and verifies; second apply is a no-op', async () => {
  const root = await fixture();
  const cloud = createMemoryCloud({dataDir:root});
  await run(async () => {
    const dry = await migrate({cloud, dataDir:root, apply:false, author:AUTHOR});
    assert.equal(dry.files.uploaded, 9);
    assert.equal(dry.entries.written, 8);
    assert.equal((await cloud.blobs.list('')).length, 0);
    assert.equal((await cloud.history.list({limit:200})).items.length, 0);

    const first = await migrate({cloud, dataDir:root, apply:true, author:AUTHOR});
    assert.equal(first.files.uploaded, 9);
    assert.equal(first.files.indexed, 9);
    assert.equal(first.entries.written, 8);
    assert.deepEqual(first.files.failed, []);
    assert.deepEqual(first.entries.failed, []);
    assert.equal(first.verify.ok, true, JSON.stringify(first.verify.problems));
    assert.equal(first.verify.threads, 1);

    const camp = await cloud.history.get(id(10));
    assert.equal(camp.variants.length, 1);
    assert.equal(camp.author, AUTHOR);
    const withLog = await cloud.history.get(id(4), {withLog:true});
    assert.equal(withLog.log.length, 2);
    assert.equal((await cloud.assets.index(P1)).length, 9);

    const second = await migrate({cloud, dataDir:root, apply:true, author:AUTHOR});
    assert.equal(second.files.uploaded, 0);
    assert.equal(second.files.indexed, 0);
    assert.equal(second.entries.written, 0);
    assert.equal(second.entries.skipped, 8);
    assert.equal(second.verify.ok, true);
  });
});

test('--merge-style-forks folds forks into variants of the earliest campaign, idempotently', async () => {
  const root = await fixture();
  const cloud = createMemoryCloud({dataDir:root});
  await run(async () => {
    const report = await migrate({cloud, dataDir:root, apply:true, mergeForks:true, author:AUTHOR});
    assert.equal(report.merges.length, 1);
    assert.equal(report.verify.ok, true, JSON.stringify(report.verify.problems));
    const base = await cloud.history.get(id(10));
    assert.equal(base.variants.length, 2);
    assert.equal(base.variants[1].label, 'Б');
    assert.equal(base.variants[1].styles.chosenIndex, 1);
    assert.equal(base.cost.total, 1.5);
    const fork = await cloud.history.get(id(11));
    assert.equal(fork.status, 'merged');
    assert.equal(fork.mergedInto, id(10));
    const again = await migrate({cloud, dataDir:root, apply:true, mergeForks:true, author:AUTHOR});
    assert.equal(again.entries.written, 0);
    assert.equal(again.files.uploaded, 0);
  });
});

test('pull restores files byte-for-byte and entries with logs into a fresh folder', async () => {
  const root = await fixture();
  const cloud = createMemoryCloud({dataDir:root});
  await run(async () => {
    await migrate({cloud, dataDir:root, apply:true, author:AUTHOR});
    const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'forma-pull-')), 'data');
    const report = await pull({cloud, outDir:out});
    assert.equal(report.files, 9);
    assert.equal(report.entries, 8);
    assert.deepEqual(report.failed, []);
    for (const rel of ['assets/logo.svg', 'assets/generated/hero.png', `${REV}.src.html`]) {
      assert.equal(sha(await fs.readFile(path.join(out, P1, rel))), sha(await fs.readFile(path.join(root, P1, rel))));
    }
    const pulled = JSON.parse(await fs.readFile(path.join(out, 'history', id(5) + '.json'), 'utf8'));
    assert.equal(pulled.log.length, 2);
    assert.equal(pulled.input.revision.parent, id(4));
    assert.equal(pulled.logSize, undefined);
    await assert.rejects(pull({cloud, outDir:out}), /не пуста/);
  });
});
