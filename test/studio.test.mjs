import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planQuestionnaireTransition, planCampaignTransition, applyQuestionnaireTransition, applyCampaignTransition,
  buildInbox, studioAvailability, TransitionError, CONFLICT_MESSAGE,
} from '../studio.mjs';

const throwsCode = (fn, code, message) => assert.throws(fn, err => err instanceof TransitionError && err.code === code && (!message || message.test(err.message)));

test('questionnaire: the studio asks questions or approves, only from submitted', () => {
  const plan = planQuestionnaireTransition('submitted', {type: 'request_changes', noteCount: 1, unlocked: ['c_what', 'c_what', '']});
  assert.deepEqual([plan.to, plan.unlocked, plan.event.type, plan.event.payload], ['changes_requested', ['c_what'], 'questionnaire.changes_requested', {questions: 1}]);
  throwsCode(() => planQuestionnaireTransition('submitted', {type: 'request_changes', noteCount: 0, unlocked: ['c_what']}), 'invalid');
  throwsCode(() => planQuestionnaireTransition('submitted', {type: 'request_changes', noteCount: 1, unlocked: []}), 'invalid');
  const ok = planQuestionnaireTransition('submitted', {type: 'approve', brands: [{name: ' Grit Gym ', questionnaire_scope: null}]});
  assert.deepEqual(ok.brands, [{name: 'Grit Gym', questionnaire_scope: null}]);
  assert.equal(ok.event.type, 'questionnaire.approved');
  throwsCode(() => planQuestionnaireTransition('submitted', {type: 'approve', brands: [{name: ' '}]}), 'invalid');
  throwsCode(() => planQuestionnaireTransition('submitted', {type: 'approve', brands: [{name: 'A', questionnaire_scope: 'c1'}, {name: 'B', questionnaire_scope: 'c1'}]}), 'invalid');
  for (const from of ['draft', 'changes_requested', 'approved']) throwsCode(() => planQuestionnaireTransition(from, {type: 'approve', brands: [{name: 'A'}]}), 'conflict', /Refresh/);
  throwsCode(() => planQuestionnaireTransition('draft', {type: 'submit'}), 'forbidden');
});

test('campaign: studio actions follow the dashboard rules', () => {
  const accept = planCampaignTransition('submitted', {type: 'accept', formaCampaignId: 'f1'});
  assert.deepEqual([accept.to, accept.patch.formaCampaignId, accept.event.type], ['in_progress', 'f1', 'campaign.accepted']);
  const items = {directions: [{id: 'a'}, {id: 'b'}, {id: 'c'}]};
  const sent = planCampaignTransition('in_progress', {type: 'send_directions', items, sentBy: 'Dmitry'});
  assert.deepEqual(sent.newDelivery, {stage: 'directions', items, sentBy: 'Dmitry'});
  throwsCode(() => planCampaignTransition('in_progress', {type: 'send_directions', items: {directions: [{id: 'a'}, {id: 'a'}, {id: 'c'}]}}), 'invalid', /exactly 3/);
  throwsCode(() => planCampaignTransition('in_progress', {type: 'send_directions', items: {directions: [{id: 'a'}, {id: 'b'}]}}), 'invalid');
  const fin = planCampaignTransition('in_production', {type: 'send_final', items: {final: {id: 'v'}}});
  assert.equal(fin.to, 'delivered');
  throwsCode(() => planCampaignTransition('in_production', {type: 'send_final', items: {final: {}}}), 'invalid');
  for (const from of ['submitted', 'in_progress', 'review_directions', 'in_production']) assert.equal(planCampaignTransition(from, {type: 'cancel'}).to, 'cancelled');
  throwsCode(() => planCampaignTransition('delivered', {type: 'cancel'}), 'conflict');
  throwsCode(() => planCampaignTransition('review_directions', {type: 'approve'}), 'forbidden');
  throwsCode(() => planCampaignTransition('review_directions', {type: 'send_directions', items}), 'conflict');
});

function fakeDb({row, rpcRows = [{id: 'x', status: 'next'}], rpcError = null}) {
  const calls = [];
  const db = {
    from(table) {
      const q = {select() { return q; }, eq(col, val) { calls.push({table, col, val}); return q; }, async maybeSingle() { return {data: row, error: null}; }};
      return q;
    },
    async rpc(name, params) { calls.push({rpc: name, params}); return {data: rpcRows, error: rpcError}; },
  };
  return {db, calls};
}

test('apply: checks the version, calls the dashboard functions with the full parameter set', async () => {
  const {db, calls} = fakeDb({row: {id: 'q1', status: 'submitted', version: 3}});
  await applyQuestionnaireTransition(db, 'q1', 3, {type: 'request_changes', noteCount: 1, unlocked: ['c_site']});
  const call = calls.find(c => c.rpc);
  assert.equal(call.rpc, 'client_questionnaire_transition');
  assert.deepEqual(Object.keys(call.params).sort(), ['p_brands', 'p_event_payload', 'p_event_type', 'p_expected_version', 'p_from', 'p_id', 'p_to', 'p_unlocked']);
  assert.deepEqual([call.params.p_from, call.params.p_to, call.params.p_expected_version], ['submitted', 'changes_requested', 3]);

  await assert.rejects(applyQuestionnaireTransition(db, 'q1', 2, {type: 'approve', brands: [{name: 'A'}]}), err => err.code === 'conflict' && err.message === CONFLICT_MESSAGE);
  await assert.rejects(applyQuestionnaireTransition(fakeDb({row: null}).db, 'q9', 1, {type: 'approve', brands: [{name: 'A'}]}), err => err.status === 404);
  await assert.rejects(applyQuestionnaireTransition(fakeDb({row: {id: 'q1', status: 'submitted', version: 1}, rpcRows: []}).db, 'q1', 1, {type: 'approve', brands: [{name: 'A'}]}), err => err.status === 409);

  const camp = fakeDb({row: {id: 'c1', status: 'submitted', version: 1}});
  await applyCampaignTransition(camp.db, 'c1', 1, {type: 'accept', formaCampaignId: 'f9'});
  const cc = camp.calls.find(c => c.rpc);
  assert.equal(cc.rpc, 'client_campaign_transition');
  assert.deepEqual(Object.keys(cc.params).sort(), ['p_approved_item_id', 'p_event_payload', 'p_event_type', 'p_expected_version', 'p_forma_campaign_id', 'p_from', 'p_id', 'p_new_delivery', 'p_rebuilds_inc', 'p_respond_delivery', 'p_response', 'p_to']);
  assert.deepEqual([cc.params.p_forma_campaign_id, cc.params.p_respond_delivery, cc.params.p_rebuilds_inc], ['f9', null, false]);
  const raced = fakeDb({row: {id: 'c1', status: 'in_progress', version: 1}, rpcError: {message: 'delivery_not_open'}});
  await assert.rejects(applyCampaignTransition(raced.db, 'c1', 1, {type: 'send_directions', items: {directions: [{id: 'a'}, {id: 'b'}, {id: 'c'}]}}), err => err.status === 409);
});

test('inbox: whose turn it is, labels, the waiting count and test accounts', () => {
  const acc = (name, test = false) => ({name, kind: 'brand', test});
  const inbox = buildInbox({
    questionnaires: [
      {id: 'q1', account_id: 'a1', status: 'submitted', company: 'Grit Gym', client_accounts: acc('Grit'), updated_at: '2026-11-20T10:00:00Z'},
      {id: 'q2', account_id: 'a2', status: 'changes_requested', role: 'agency', clients: [{id: 'c1'}, {id: 'c2'}], client_accounts: {name: 'Blue Harbor', kind: 'agency', test: true}},
      {id: 'q3', account_id: 'a3', status: 'approved', client_accounts: acc('Lumo')},
    ],
    campaigns: [
      {id: 'k1', account_id: 'a1', name: 'Spring', status: 'submitted', setup: {kind: 'multi', formats: ['9x16'], languages: ['en'], lengths: [10]}, rebuilds_used: 0, client_accounts: acc('Grit'), client_brands: {name: 'Grit Gym'}},
      {id: 'k2', account_id: 'a1', name: 'Rebuilt', status: 'in_progress', rebuilds_used: 1, client_accounts: acc('Grit')},
      {id: 'k3', account_id: 'a1', name: 'Review', status: 'review_directions', rebuilds_used: 0, client_accounts: acc('Grit', true)},
      {id: 'k4', account_id: 'a1', name: 'Final', status: 'in_production', rebuilds_used: 2, client_accounts: acc('Grit')},
      {id: 'k5', account_id: 'a1', name: 'Done', status: 'delivered', client_accounts: acc('Grit')},
    ],
    deliveries: [
      {campaign_request_id: 'k2', stage: 'directions', round: 1, response: {decision: 'rebuild'}},
      {campaign_request_id: 'k3', stage: 'directions', round: 2, response: null},
      {campaign_request_id: 'k3', stage: 'directions', round: 1, response: {decision: 'rebuild'}},
      {campaign_request_id: 'k5', stage: 'final', round: 1},
    ],
    events: [{id: 1, type: 'directions.rebuild_requested', at: '2026-11-20T10:00:00Z', account_id: 'a1', client_accounts: acc('Grit'), campaign_requests: {name: 'Rebuilt'}}],
  });
  const q = Object.fromEntries(inbox.questionnaires.map(x => [x.id, x]));
  assert.deepEqual([q.q1.turn, q.q1.label, q.q1.name], ['studio', 'New questionnaire', 'Grit Gym']);
  assert.deepEqual([q.q2.turn, q.q2.kind, q.q2.clients, q.q2.test], ['client', 'agency', 2, true]);
  assert.equal(q.q3.turn, 'done');
  const c = Object.fromEntries(inbox.campaigns.map(x => [x.id, x]));
  assert.deepEqual([c.k1.turn, c.k1.label, c.k1.brand, c.k1.rebuildsLeft], ['studio', 'New request', 'Grit Gym', 2]);
  assert.match(c.k2.label, /Rebuild requested · round 2 next/);
  assert.deepEqual([c.k3.turn, c.k3.round], ['client', 2]);
  assert.match(c.k3.label, /round 2/);
  assert.deepEqual([c.k4.turn, c.k4.rebuildsLeft], ['studio', 0]);
  assert.equal(c.k5.turn, 'done');
  assert.equal(inbox.waiting, 4);
  assert.equal(inbox.activity[0].text, 'Grit asked to rebuild “Rebuilt”');

  const real = buildInbox({questionnaires: [{id: 'q2', status: 'submitted', client_accounts: {name: 'T', test: true}}], campaigns: []}, {includeTest: false});
  assert.equal(real.questionnaires.length, 0);
  assert.equal(real.waiting, 0);
});

test('availability: the studio is off on the file store and says why', async () => {
  const state = await studioAvailability({driver: 'file'}, {fresh: true});
  assert.equal(state.enabled, false);
  assert.match(state.reason, /FORMA_STORE=supabase/);
  const missing = await studioAvailability({driver: 'supabase', db: async () => ({from: t => ({select: () => ({limit: async () => (t === 'delivery_exports' ? {data: null, error: {code: 'PGRST205', message: "Could not find the table 'public.delivery_exports' in the schema cache"}} : {data: [], error: null})})})})}, {fresh: true});
  assert.match(missing.reason, /delivery_exports.*supabase db push/);
  const ready = await studioAvailability({driver: 'supabase', db: async () => ({from: t => ({select: () => ({limit: async () => ({data: [], error: null})})})})}, {fresh: true});
  assert.equal(ready.enabled, true);
  // A column error is not a missing table (the first version of this check asked delivery_exports for an id it has not got).
  const column = await studioAvailability({driver: 'supabase', db: async () => ({from: () => ({select: () => ({limit: async () => ({data: null, error: {code: '42703', message: 'column delivery_exports.id does not exist'}})})})})}, {fresh: true});
  assert.doesNotMatch(column.reason, /tables are missing/);
  assert.match(column.reason, /column delivery_exports\.id/);
});

import {timeline} from '../studio.mjs';

test('timeline: one questionnaire or campaign, oldest first, in plain words', () => {
  const items = timeline([
    {id: 3, type: 'directions.sent', at: '2026-11-21T10:00:00Z', payload: {round: 2}},
    {id: 1, type: 'campaign.submitted', at: '2026-11-20T10:00:00Z', payload: {kind: 'multi'}},
    {id: 2, type: 'campaign.accepted', at: '2026-11-20T11:00:00Z'},
    {id: 4, type: 'questionnaire.changes_requested', at: '2026-11-22T10:00:00Z', payload: {questions: 1}},
    {id: 5, type: 'something.new', at: '2026-11-23T10:00:00Z'},
  ], 'Grit');
  assert.deepEqual(items.map(i => i.text), ['Grit sent the request', 'Accepted into Forma', 'Three directions sent · round 2', 'We asked Grit 1 question', 'something.new']);
});
