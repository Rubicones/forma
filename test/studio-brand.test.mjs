import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {unzip} from '../zip.mjs';
import {clientDecisions, collectClientFiles, createBrandsForQuestionnaire} from '../studio-brand.mjs';
import {notesHaveBody, splitClientDecisions, BRAND_NOTES_FILE} from '../creative.mjs';
import {extractColours, boardGroup, buildBoard} from '../brand-board.mjs';
import {selectStore, store} from '../store/index.mjs';
import {memoryStore} from '../store/memory.mjs';
import {streamToBuffer} from '../store/supabase.mjs';

// A small zip writer for the tests (the reader ignores CRCs).
function makeZip(files, {encrypt = []} = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content, method = 8] of files) {
    const data = Buffer.from(content);
    const packed = method === 8 ? deflateRawSync(data) : data;
    const n = Buffer.from(name);
    const flags = 0x800 | (encrypt.includes(name) ? 1 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, packed);
    centrals.push(central, n);
    offset += 30 + n.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('unzip: stored and deflated entries, folders skipped, locked entries listed', () => {
  const zip = makeZip([['Kit/', '', 0], ['Kit/logo.svg', '<svg fill="#FF4F17"/>'], ['Kit/readme.txt', 'hello', 0], ['Kit/secret.pdf', 'x']], {encrypt: ['Kit/secret.pdf']});
  const {entries, skipped} = unzip(zip);
  assert.deepEqual(entries.map(e => [e.name, e.bytes.toString()]), [['Kit/logo.svg', '<svg fill="#FF4F17"/>'], ['Kit/readme.txt', 'hello']]);
  assert.deepEqual(skipped, [{name: 'Kit/secret.pdf', reason: 'password-protected'}]);
  assert.throws(() => unzip(Buffer.from('not a zip at all, really not')), /Not a zip/);
  const capped = unzip(makeZip([['a.txt', 'x'.repeat(100)]]), {maxEntry: 10});
  assert.deepEqual([capped.entries.length, capped.skipped[0].reason], [0, 'too large']);
});

const blobsWith = files => ({get: async key => (key in files ? Buffer.from(files[key]) : null)});

test('client files: archives unpack into one folder, junk is dropped, names never collide', async () => {
  const zip = makeZip([['Brand kit/logo.svg', '<svg/>'], ['Brand kit/fonts/Grit.woff2', 'font'], ['__MACOSX/Brand kit/._logo.svg', 'junk'], ['Brand kit/.DS_Store', 'junk']]);
  const blobs = blobsWith({'clients/a/1/logo.svg': 'top', 'clients/a/2/kit.zip': zip, 'clients/a/3/bad.zip': 'broken'});
  const {items, skipped} = await collectClientFiles(blobs, [
    {name: 'logo.svg', size: 3, r2_key: 'clients/a/1/logo.svg'},
    {name: 'logo.svg', size: 3, r2_key: 'clients/a/1/logo.svg'},
    {name: 'kit.zip', size: zip.length, r2_key: 'clients/a/2/kit.zip'},
    {name: 'bad.zip', size: 6, r2_key: 'clients/a/3/bad.zip'},
    {name: 'huge.mov', size: 9e9, r2_key: 'clients/a/4/huge.mov'},
    {name: 'gone.png', size: 1, r2_key: 'clients/a/5/gone.png'},
  ]);
  assert.deepEqual(items.map(i => i.name), ['logo.svg', 'logo (2).svg', 'kit/logo.svg', 'kit/fonts/Grit.woff2', 'bad.zip']);
  assert.deepEqual(skipped.map(s => s.name), ['bad.zip', 'huge.mov', 'gone.png']);
  assert.match(skipped[0].reason, /kept as the archive/);
});

const state = {
  role: 'brand', mode: 'self',
  a: {
    c_company: 'Grit Gym', c_what: 'A strength gym for beginners.',
    v_avoid: ['Stock-photo look', 'AI-looking images', 'Other'], v_avoid__other: 'gym bros',
    v_gen: ['Backgrounds & scenes', 'Objects & products'], v_people: 'Just hands and details', v_color: 'Only our brand colors',
    v_humor: 'Up to you', m_proof: ['Nothing yet'], k_legal: 'Yes', k_legal_note: 'Prices in RSD with VAT in Serbia.',
    v_pairs: {warm: 2, volume: 'decide', tone: 5},
  },
  flags: {}, clients: [{id: 'c1'}], legal: {},
};

test('client decisions: the hard answers, in the client’s terms; "Up to you" decides nothing', () => {
  assert.deepEqual(clientDecisions(state), [
    'Never: stock-photo look, AI-looking images, gym bros. (questionnaire)',
    'Generated images only for backgrounds & scenes, objects & products; nothing else is generated. (questionnaire)',
    'People only as hands and details, no faces. (questionnaire)',
    'Colours: only the brand\'s own colours. (questionnaire)',
    'No proof points yet: never invent numbers, reviews, client names, awards or press. (questionnaire)',
    'Market rules: Prices in RSD with VAT in Serbia. (questionnaire)',
  ]);
  const agency = {role: 'agency', a: {'c1:v_gen': ['No generated images'], 'c1:kp_strict': 'By the book', 'c2:v_people': 'No people'}, clients: [{id: 'c1'}, {id: 'c2'}]};
  assert.deepEqual(clientDecisions(agency, 'c1'), [
    'No generated images: pictures come from the client\'s own materials or are drawn in code. (questionnaire)',
    'The client\'s brand guide is followed by the book. (questionnaire)',
  ]);
  assert.deepEqual(clientDecisions(agency, 'c2'), ['No people on screen. (questionnaire)']);
});

test('notes with only client decisions are not written notes yet', () => {
  assert.equal(notesHaveBody('# Grit — brand notes\n\n## Client decisions\n- No jokes.\n'), false);
  assert.equal(notesHaveBody('# Grit — brand notes\n\n## Client decisions\n- No jokes.\n\n## Character\nCalm.\n'), true);
  assert.equal(notesHaveBody(''), false);
});

test('board: colours by how widely they are used, files sorted for people', () => {
  const colours = extractColours([{name: 'tokens.json', text: '{"brand":"#FF4F17","ink":"#0c2b3f","x":"#fff"}'}, {name: 'logo.svg', text: '<path fill="#ff4f17"/><path fill="#FFF"/>'}]);
  assert.deepEqual(colours.map(c => [c.hex, c.files.length]), [['#ff4f17', 2], ['#ffffff', 2], ['#0c2b3f', 1]]);
  assert.deepEqual(['logo.svg', 'Logos/mark-white.png', 'hero.jpg', 'Grit.woff2', 'brandbook.pdf', 'spot.mp4', 'tokens.json'].map(boardGroup),
    ['logos', 'logos', 'pictures', 'fonts', 'documents', 'videos', 'other']);
  const board = buildBoard({id: 'b', version: 3, name: 'Grit', files: [{name: 'hero.jpg'}, {name: BRAND_NOTES_FILE}], origin: {skipped: [{name: 'huge.mov', reason: 'too large'}]}});
  assert.deepEqual(board.groups.pictures, [{name: 'hero.jpg', url: '/api/brands/b/file?v=3&name=hero.jpg'}]);
  assert.equal(Object.values(board.groups).flat().length, 1, 'the brand notes are not shown as a material');
  assert.deepEqual(board.skipped, [{name: 'huge.mov', reason: 'too large'}]);
});

// A Supabase stand-in for the four tables the brand making reads and the one update it writes.
function fakeDb(tables) {
  const updates = [];
  const query = (table) => {
    let rows = tables[table] || [];
    const q = {
      select: () => q, order: () => q,
      eq: (k, v) => { rows = rows.filter(r => r[k] === v); return q; },
      is: (k, v) => { rows = rows.filter(r => (r[k] ?? null) === v); return q; },
      maybeSingle: async () => ({data: rows[0] || null, error: null}),
      then: (ok, bad) => Promise.resolve({data: rows, error: null}).then(ok, bad),
    };
    return q;
  };
  return {
    updates,
    from(table) {
      return {
        ...query(table),
        update(patch) {
          const q = query(table);
          const run = q.then.bind(q);
          q.then = (ok, bad) => run(({data}) => { for (const r of data) Object.assign(r, patch); updates.push({table, patch, rows: data.length}); return {data, error: null}; }).then(ok, bad);
          return q;
        },
      };
    },
  };
}

test('approval makes the brand once: the client files and the decisions, no questionnaire file; a second run finds it', async () => {
  memoryStore.reset();
  selectStore('memory');
  const brandId = '3f1c2b9a-1111-4222-8333-444455556666';
  const zip = makeZip([['logo.svg', '<svg fill="#FF4F17"/>']]);
  await store.blobs.put('clients/a1/files/f1/kit.zip', zip);
  const tables = {
    brand_questionnaires: [{id: 'q1', account_id: 'a1', status: 'approved', version: 5, state, approved_at: '2026-11-20T12:00:00Z', client_accounts: {name: 'Grit'}}],
    client_files: [
      {id: 'f1', account_id: 'a1', scope: 'brand', name: 'kit.zip', size: zip.length, r2_key: 'clients/a1/files/f1/kit.zip', status: 'ready'},
      {id: 'f2', account_id: 'a1', scope: 'refs', name: 'ref.png', size: 1, r2_key: 'clients/a1/files/f2/ref.png', status: 'ready'},
    ],
    client_brands: [{id: brandId, account_id: 'a1', name: 'Grit Gym', questionnaire_scope: null, forma_brand_id: null}],
  };
  const db = fakeDb(tables);
  const [made] = await createBrandsForQuestionnaire(db, store.blobs, 'q1');
  assert.deepEqual([made.formaBrandId, made.created, made.files], [brandId, true, 1]);
  assert.equal(tables.client_brands[0].forma_brand_id, brandId);
  const manifest = JSON.parse((await streamToBuffer(await store.blobs.get(`brands/versions/${brandId}/1.json`))).toString());
  assert.deepEqual(manifest.files.map(f => f.name), ['kit/logo.svg', BRAND_NOTES_FILE]);
  assert.deepEqual([manifest.notes.source, manifest.origin.questionnaireId], ['questionnaire', 'q1']);
  const notesHash = manifest.files.find(f => f.name === BRAND_NOTES_FILE).hash;
  const notes = (await streamToBuffer(await store.blobs.get('brands/files/' + notesHash))).toString();
  assert.ok(splitClientDecisions(notes).decisions.includes('People only as hands and details, no faces. (questionnaire)'));
  assert.equal(notesHaveBody(notes), false);
  const again = await createBrandsForQuestionnaire(db, store.blobs, 'q1');
  assert.deepEqual(again, [{clientBrandId: brandId, formaBrandId: brandId, created: false}]);
  tables.brand_questionnaires[0].status = 'submitted';
  await assert.rejects(createBrandsForQuestionnaire(db, store.blobs, 'q1'), /Approve the questionnaire first/);
});
