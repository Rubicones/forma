import test from 'node:test';
import assert from 'node:assert/strict';
import {briefText, cleanBrief, loadCampaignDetail, acceptCampaign, REFS_DIR} from '../studio-campaign.mjs';
import {createBrandFromFiles} from '../brands.mjs';
import {selectStore, store} from '../store/index.mjs';
import {memoryStore} from '../store/memory.mjs';

const REQ = '11111111-2222-4333-8444-555555555555';
const BRAND = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const REF = '0aaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = '0fffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const brief = {
  requestId: '99999999-2222-4333-8444-555555555555', product: 'The family plan', promote: 'One plan for the whole family, before school starts.',
  goal: 'New customers', offer: 'Discount', offerText: '−30% for three months', cta: 'Get started',
  links: [{a: 'https://grit.example/family', b: 'landing page'}, {a: ''}], fileIds: [REF, OTHER, 'not-a-uuid'], note: 'No children’s faces.',
};

test('brief: the client’s answers as the script reads them, offer wording kept word for word', () => {
  const text = briefText({name: 'Back to school', brief}, {brand: 'Grit Gym', account: 'Studio North', refs: 1});
  assert.equal(text, [
    'The client\'s brief for the campaign “Back to school” (Grit Gym, through the agency Studio North). "Up to you" leaves that choice to the studio.',
    'Product or offer: The family plan',
    'What to promote: One plan for the whole family, before school starts.',
    'Goal: New customers',
    'Offer: Discount. Its exact wording, word for word: “−30% for three months”',
    'Button text: Get started',
    'Links from the client:',
    '- https://grit.example/family (landing page)',
    'Note from the client: No children’s faces.',
    `References: 1 file in ${REFS_DIR}/.`,
  ].join('\n'));
  assert.match(briefText({name: 'X', brief: {promote: 'Y', offer: 'No offer'}}), /Offer: none; show no offer\./);
  assert.deepEqual(cleanBrief(brief).fileIds, [REF, OTHER]);
});

function fakeDb(tables) {
  const rpc = [];
  const query = table => {
    let rows = (tables[table] || []).slice();
    const q = {
      select: () => q, order: () => q, limit: () => q,
      eq: (k, v) => { rows = rows.filter(r => r[k] === v); return q; },
      in: (k, vs) => { rows = rows.filter(r => vs.includes(r[k])); return q; },
      maybeSingle: async () => ({data: rows[0] || null, error: null}),
      then: (ok, bad) => Promise.resolve({data: rows, error: null}).then(ok, bad),
    };
    return q;
  };
  return {
    calls: rpc,
    from: query,
    async rpc(name, params) {
      rpc.push({name, params});
      const row = tables.campaign_requests.find(r => r.id === params.p_id);
      Object.assign(row, {status: params.p_to, version: row.version + 1, forma_campaign_id: params.p_forma_campaign_id ?? row.forma_campaign_id});
      return {data: [row], error: null};
    },
  };
}

function tables({formaBrandId = BRAND} = {}) {
  return {
    campaign_requests: [{
      id: REQ, account_id: 'a1', client_brand_id: 'cb1', name: 'Back to school', status: 'submitted', version: 2, rebuilds_used: 0,
      setup: {kind: 'multi', formats: ['9x16', '1x1'], languages: ['en', 'sr-Latn'], lengths: [10, 15]}, brief,
      client_accounts: {name: 'Grit', kind: 'brand', test: true}, client_brands: {id: 'cb1', name: 'Grit Gym', forma_brand_id: formaBrandId},
    }],
    client_files: [
      {id: REF, account_id: 'a1', scope: 'refs', name: 'mood.png', size: 4, category: 'References', r2_key: 'clients/a1/files/r/mood.png', status: 'ready'},
      {id: OTHER, account_id: 'someone-else', scope: 'refs', name: 'theirs.png', size: 4, category: 'References', r2_key: 'clients/x/files/o/theirs.png', status: 'ready'},
    ],
    deliveries: [],
    client_events: [
      {id: 2, account_id: 'a1', campaign_request_id: REQ, type: 'campaign.accepted', at: '2026-11-20T11:00:00Z', payload: {}},
      {id: 1, account_id: 'a1', campaign_request_id: REQ, type: 'campaign.submitted', at: '2026-11-20T10:00:00Z', payload: {}},
      {id: 9, account_id: 'a1', campaign_request_id: 'other', type: 'campaign.cancelled', at: '2026-11-20T12:00:00Z', payload: {}},
    ],
  };
}

test('detail: setup, brief, the account’s own ready references, what the studio may do', async () => {
  const d = await loadCampaignDetail(fakeDb(tables()), REQ);
  assert.deepEqual([d.label, d.turn, d.canAccept, d.canCancel, d.rebuildsLeft, d.test], ['New request', 'studio', true, true, 2, true]);
  assert.deepEqual(d.refs.map(r => r.name), ['mood.png']);
  assert.equal(d.refsPending, 1, 'a file of another account never shows');
  assert.equal(d.brief.offerText, '−30% for three months');
  assert.equal(d.brand.formaBrandId, BRAND);
  assert.deepEqual(d.timeline.map(t => t.text), ['Grit sent the request', 'Accepted into Forma'], 'only this campaign, oldest first');
  await assert.rejects(loadCampaignDetail(fakeDb(tables()), 'nope'), /couldn't find/);
});

test('accept: the campaign is made with the request id, the brief and the references, then the status moves', async () => {
  memoryStore.reset();
  selectStore('memory');
  await createBrandFromFiles({id: BRAND, name: 'Grit Gym', files: [{name: 'logo.svg', bytes: Buffer.from('<svg/>')}]});
  await store.blobs.put('clients/a1/files/r/mood.png', Buffer.from('png!'));
  const t = tables();
  const db = fakeDb(t);
  const made = [];
  const createClientCampaign = async args => { made.push(args); return {id: args.id}; };
  await assert.rejects(acceptCampaign(db, store.blobs, REQ, 1, {createClientCampaign}), /Refresh/);
  const campaign = await acceptCampaign(db, store.blobs, REQ, 2, {provider: {mode: 'claude'}, createClientCampaign});
  assert.equal(campaign.id, REQ);
  const args = made[0];
  assert.deepEqual([args.brandId, args.brandVersion, args.name], [BRAND, 1, 'Back to school']);
  assert.deepEqual(args.setup, {kind: 'multi', formats: ['9x16', '1x1'], languages: ['en', 'sr-Latn'], lengths: [10, 15], provider: {mode: 'claude'}});
  assert.deepEqual(args.files.map(f => [f.name, f.bytes.toString()]), [[`${REFS_DIR}/mood.png`, 'png!']]);
  assert.match(args.client.briefText, /References: 1 file in client-references\//);
  assert.deepEqual([args.client.requestId, args.client.brand, args.client.test], [REQ, 'Grit Gym', true]);
  assert.deepEqual([db.calls[0].params.p_from, db.calls[0].params.p_to, db.calls[0].params.p_forma_campaign_id], ['submitted', 'in_progress', REQ]);
  await assert.rejects(acceptCampaign(db, store.blobs, REQ, 3, {createClientCampaign}), /Refresh/, 'only from submitted');
});

test('accept: refused while the client’s brand is not in Forma', async () => {
  const made = [];
  await assert.rejects(acceptCampaign(fakeDb(tables({formaBrandId: null})), store.blobs, REQ, 2, {createClientCampaign: async a => made.push(a)}), /not in Forma yet/);
  assert.equal(made.length, 0);
});

import {directionsOf, buildDirectionsSnapshot, sendDirections, directionsDetail, clientTitle} from '../studio-campaign.mjs';

const PROJECT = 'abcdefab-1111-4222-8333-444455556666';
const entries = {
  st: {id: 'st', output: {styles: [
    {name: 'Native: Morning Light', idea: 'World: a quiet kitchen at dawn', svg: '<svg id="a"/>'},
    {name: 'World — Night Run', idea: 'City lights', svg: '<svg id="b"/>'},
    {name: 'Bold: Big Type', idea: 'Type as the hero', svg: '<svg id="c"/>'},
  ]}},
  p1: {id: 'p1', output: {path: `/p/${PROJECT}/r1.html`, format: '9x16', lang: 'en', scenes: ['s1', 's2']}},
  p2: {id: 'p2', output: {path: `/p/${PROJECT}/r2.html`, format: '9x16', lang: 'en', scenes: ['s1', 's2']}},
  p3: {id: 'p3', output: {path: `/p/${PROJECT}/r3.html`, format: '9x16', lang: 'en', scenes: []}},
};
const formaCampaign = {
  id: REQ, setup: {formats: ['9x16'], languages: ['en']},
  variants: [
    {id: 'v1', label: 'Style 1', styles: {entryId: 'st', chosenIndex: 0}, preview: {entryId: 'p1', approvedAt: '2026-11-20', stale: false}},
    {id: 'v2', label: 'Night Run', styles: {entryId: 'st', chosenIndex: 1}, preview: {entryId: 'p2', stale: true}},
    {id: 'v3', label: 'Style 3', styles: {entryId: 'st', chosenIndex: 2}, preview: {entryId: 'p3'}},
    {id: 'v4', label: 'Draft', styles: {entryId: 'st', chosenIndex: 0}},
  ],
};
const getEntry = async id => entries[id] || null;

test('directions: every variant with a preview, worded for the client', async () => {
  assert.equal(clientTitle('Bold · Big Type'), 'Big Type');
  const list = await directionsOf(formaCampaign, getEntry);
  assert.deepEqual(list.map(d => [d.id, d.title, d.idea, d.stale, d.approved]), [
    ['v1', 'Morning Light', 'a quiet kitchen at dawn', false, true],
    ['v2', 'Night Run', 'City lights', true, false],
    ['v3', 'Big Type', 'Type as the hero', false, false],
  ]);
  assert.deepEqual([list[0].path, list[0].previewEntryId, list[0].scenes, list[0].keyframeSvg], [`/p/${PROJECT}/r1.html`, 'p1', ['s1', 's2'], '<svg id="a"/>']);
});

test('snapshot: exactly three different directions in the picked order, studio wording, notes capped', async () => {
  const list = await directionsOf(formaCampaign, getEntry);
  const snap = buildDirectionsSnapshot(list, [
    {id: 'v3', title: 'Native: Type first', idea: '  The word does the work  ', note: 'x'.repeat(700)},
    {id: 'v1'}, {id: 'v2', note: '  '},
  ]);
  assert.deepEqual(snap.directions.map(d => [d.id, d.title, d.idea]), [['v3', 'Type first', 'The word does the work'], ['v1', 'Morning Light', 'a quiet kitchen at dawn'], ['v2', 'Night Run', 'City lights']]);
  assert.equal(snap.directions[0].studioNote.length, 600);
  assert.equal('studioNote' in snap.directions[2], false);
  assert.throws(() => buildDirectionsSnapshot(list, [{id: 'v1'}, {id: 'v1'}, {id: 'v2'}]), /exactly 3 different/);
  assert.throws(() => buildDirectionsSnapshot(list, [{id: 'v1'}, {id: 'v2'}]), /exactly 3 different/);
  assert.throws(() => buildDirectionsSnapshot(list, [{id: 'v1'}, {id: 'v2'}, {id: 'v4'}]), /no preview/);
  const bad = list.map(d => (d.id === 'v1' ? {...d, path: 'https://evil.example/x.html'} : d));
  assert.throws(() => buildDirectionsSnapshot(bad, [{id: 'v1'}, {id: 'v2'}, {id: 'v3'}]), /no valid preview/);
});

test('send: only while in progress, with the version, through the transition with the snapshot', async () => {
  const t = tables();
  Object.assign(t.campaign_requests[0], {status: 'in_progress', version: 4, forma_campaign_id: REQ});
  const db = fakeDb(t);
  const opts = {getCampaign: async id => (id === REQ ? formaCampaign : null), getEntry, sentBy: 'Dmitry'};
  const detail = await directionsDetail(db, REQ, opts);
  assert.deepEqual([detail.canSend, detail.round, detail.available.length, detail.lastRound], [true, 1, 3, null]);
  await assert.rejects(sendDirections(db, REQ, 3, [{id: 'v1'}, {id: 'v2'}, {id: 'v3'}], opts), /Refresh/);
  await sendDirections(db, REQ, 4, [{id: 'v1'}, {id: 'v2'}, {id: 'v3'}], opts);
  const call = db.calls[0].params;
  assert.deepEqual([call.p_from, call.p_to], ['in_progress', 'review_directions']);
  assert.equal(call.p_new_delivery.stage, 'directions');
  assert.equal(call.p_new_delivery.sentBy, 'Dmitry');
  assert.deepEqual(call.p_new_delivery.items.directions.map(d => d.id), ['v1', 'v2', 'v3']);
  await assert.rejects(sendDirections(db, REQ, 5, [{id: 'v1'}, {id: 'v2'}, {id: 'v3'}], opts), /Refresh/, 'not again while with the client');
});

import {pinPlace, responseDetail, feedbackText, resolveComments} from '../studio-campaign.mjs';

function answeredTables(decision) {
  const t = tables();
  Object.assign(t.campaign_requests[0], decision === 'approve'
    ? {status: 'in_production', version: 6, forma_campaign_id: REQ, approved_item_id: 'v2'}
    : {status: 'in_progress', version: 6, forma_campaign_id: REQ, rebuilds_used: 1});
  const dir = (id, title) => ({id, title, idea: title + ' idea', path: `/p/${PROJECT}/${id}.html`, format: '9x16', lang: 'en', scenes: ['s1', 's2']});
  t.deliveries = [
    {id: 'd1', campaign_request_id: REQ, stage: 'directions', round: 1, status: 'responded', items: {directions: [dir('v1', 'Morning Light'), dir('v2', 'Night Run'), dir('v3', 'Big Type')]},
      response: decision === 'approve' ? {decision: 'approve', itemId: 'v2', at: 'x'} : {decision: 'rebuild', reason: 'Too safe', at: 'x'}, sent_at: '2026-11-20T10:00:00Z', responded_at: '2026-11-20T12:00:00Z'},
  ];
  t.delivery_comments = [
    {id: 'c1', delivery_id: 'd1', item_id: 'v2', number: 1, body: 'Logo bigger', x: 0.8, y: 0.1, scene: 's2', format: '9x16', lang: 'en', state: 'sent', created_at: '1'},
    {id: 'c2', delivery_id: 'd1', item_id: 'v2', number: 2, body: 'Love the colours', x: null, y: null, state: 'sent', created_at: '2'},
    {id: 'c3', delivery_id: 'd1', item_id: 'v1', number: 1, body: 'Take this light', x: 0.5, y: 0.5, scene: 's1', format: '9x16', lang: 'en', state: 'sent', created_at: '3'},
    {id: 'c4', delivery_id: 'd1', item_id: 'v3', number: 1, body: 'still typing', x: 0.2, y: 0.9, state: 'draft', created_at: '4'},
  ];
  return t;
}

function withUpdates(db, t) {
  const from = db.from;
  db.from = table => {
    const q = from(table);
    q.update = patch => {
      let rows = t[table];
      const u = {
        in: (k, vs) => { rows = rows.filter(r => vs.includes(r[k])); return u; },
        eq: (k, v) => { rows = rows.filter(r => r[k] === v); return u; },
        then: (ok, bad) => { rows.forEach(r => Object.assign(r, patch)); return Promise.resolve({error: null}).then(ok, bad); },
      };
      return u;
    };
    return q;
  };
  return db;
}

test('pins in words', () => {
  assert.deepEqual([pinPlace(0.8, 0.1), pinPlace(0.5, 0.5), pinPlace(0.1, 0.5), pinPlace(0.5, 0.95), pinPlace(null, null)],
    ['top right', 'centre', 'middle left', 'bottom centre', null]);
});

test('answer: approved — the chosen direction first, sent comments only, notes for a revision', async () => {
  const d = await responseDetail(fakeDb(answeredTables('approve')), REQ);
  assert.deepEqual(d.items.map(i => [i.id, i.approved]), [['v2', true], ['v1', false], ['v3', false]]);
  assert.deepEqual(d.comments.map(c => c.id), ['c1', 'c2', 'c3'], 'drafts stay the client’s');
  assert.equal(d.open, 3);
  assert.equal(feedbackText(d), [
    'The client approved this direction (“Night Run”). Apply their comments and keep everything they did not mention as it is.',
    '', 'Their comments on it:',
    '1. Logo bigger (pinned top right · scene s2 · 9:16 · en)',
    '2. Love the colours (about the direction as a whole)',
    '', 'On “Morning Light”, which they did not choose (they may want something from it):',
    '1. Take this light (pinned centre · scene s1 · 9:16 · en)',
  ].join('\n'));
});

test('answer: rebuild — the reason and every comment become the brief for a new round', async () => {
  const d = await responseDetail(fakeDb(answeredTables('rebuild')), REQ);
  const text = feedbackText(d);
  assert.match(text, /^The client asked for a new round of three directions\. Their reason: “Too safe”\./);
  assert.match(text, /On “Night Run” \(Night Run idea\):\n1\. Logo bigger/);
  assert.match(text, /Make three new directions that answer this\./);
});

test('resolve: only sent comments of the latest round, with the studio’s note', async () => {
  const t = answeredTables('approve');
  const db = withUpdates(fakeDb(t), t);
  const after = await resolveComments(db, REQ, ['c1', 'c4', 'nope'], 'Applied in the revision');
  assert.deepEqual(t.delivery_comments.map(c => [c.id, c.state]), [['c1', 'resolved'], ['c2', 'sent'], ['c3', 'sent'], ['c4', 'draft']]);
  assert.equal(t.delivery_comments[0].resolved_note, 'Applied in the revision');
  assert.equal(after.open, 2);
  assert.match(feedbackText(after), /^The client approved/);
  assert.doesNotMatch(feedbackText(after), /Logo bigger/, 'resolved comments leave the notes');
});

import {finalOf, buildFinalSnapshot, finalDetail, sendFinal} from '../studio-campaign.mjs';

const finalEntries = {
  ...entries,
  f2: {id: 'f2', output: {path: `/p/${PROJECT}/final2.html`, kind: 'multi', formats: ['9x16', '1x1'], langs: ['en', 'sr-Latn'], lengths: [10, 15]}},
  fThin: {id: 'fThin', output: {path: `/p/${PROJECT}/thin.html`, kind: 'multi', formats: ['9x16'], langs: ['en'], lengths: [10]}},
};
const withFinal = (finalId, stale = false) => ({
  ...formaCampaign,
  variants: formaCampaign.variants.map(v => (v.id === 'v2' ? {...v, final: {entryId: finalId, stale}} : v)),
});
const setup = {kind: 'multi', formats: ['9x16', '1x1'], languages: ['en', 'sr-Latn'], lengths: [10, 15]};
const finalEntry = async id => finalEntries[id] || null;

test('final: the approved direction’s final, with what blocks sending it', async () => {
  const ok = await finalOf(withFinal('f2'), 'v2', finalEntry, {setup, title: 'World: Night Run'});
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.final, {id: 'v2', title: 'Night Run', entryId: 'f2', path: `/p/${PROJECT}/final2.html`, kind: 'multi', formats: ['9x16', '1x1'], langs: ['en', 'sr-Latn'], lengths: [10, 15]});
  assert.match((await finalOf(formaCampaign, 'v2', finalEntry, {setup})).problems[0], /no final yet/);
  assert.match((await finalOf(withFinal('f2', true), 'v2', finalEntry, {setup})).problems[0], /older than the latest preview/);
  assert.equal((await finalOf(withFinal('fThin'), 'v2', finalEntry, {setup})).problems[0],
    'The final lacks what the client asked for: formats 1:1; languages sr-Latn; lengths 15 s.');
  assert.match((await finalOf(withFinal('f2'), 'gone', finalEntry, {setup})).problems[0], /not in this Forma campaign/);
  finalEntries.fBroken = {id: 'fBroken', output: {...finalEntries.f2.output, check: {problems: {errors: [], still: ['9:16'], video: []}, hard: ['the video does not move in: 9:16']}}};
  assert.match((await finalOf(withFinal('fBroken'), 'v2', finalEntry, {setup})).problems[0], /^The final is broken: The video does not move in 9:16\./);
  const snap = buildFinalSnapshot(ok.final, {title: '  Bold: Night Run, final  '});
  assert.equal(snap.final.title, 'Night Run, final');
  assert.deepEqual(buildFinalSnapshot({...ok.final, kind: 'poster'}).final.lengths, []);
});

test('send the final: from in_production only, the approved title by default, through send_final', async () => {
  const t = answeredTables('approve');
  t.campaign_requests[0].setup = setup;
  const db = fakeDb(t);
  const opts = {getCampaign: async () => withFinal('f2'), getEntry: finalEntry, sentBy: 'Dmitry'};
  const d = await finalDetail(db, REQ, opts);
  assert.deepEqual([d.canSend, d.final.title, d.openComments, d.problems], [true, 'Night Run', 2, []]);
  await assert.rejects(sendFinal(db, REQ, 5, opts), /Refresh/);
  await sendFinal(db, REQ, 6, opts);
  const call = db.calls[0].params;
  assert.deepEqual([call.p_from, call.p_to, call.p_new_delivery.stage, call.p_new_delivery.sentBy], ['in_production', 'delivered', 'final', 'Dmitry']);
  assert.deepEqual([call.p_new_delivery.items.final.id, call.p_new_delivery.items.final.title], ['v2', 'Night Run']);
  await assert.rejects(sendFinal(db, REQ, 7, opts), /Refresh/, 'delivered is the end');
  const blocked = answeredTables('approve');
  blocked.campaign_requests[0].setup = setup;
  await assert.rejects(sendFinal(fakeDb(blocked), REQ, 6, {...opts, getCampaign: async () => withFinal('fThin')}), /lacks what the client asked for/);
});
