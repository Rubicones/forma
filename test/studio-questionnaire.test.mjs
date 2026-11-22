import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {buildQuestionnaireView, validQuestionKey, brandsForApproval, normalizeState, answerValue} from '../studio-questionnaire.mjs';
import {requestQuestionnaireChanges, approveQuestionnaire} from '../studio.mjs';
import {questionById} from '../shared/questionnaire-schema.mjs';

const brandState = {
  role: 'brand', mode: 'self',
  a: {
    c_company: 'Grit Gym', c_site: 'https://grit.example', c_what: 'A strength gym for beginners.', c_buyers: 'People (B2C)',
    c_industry: ['Health', 'Other'], c_industry__other: 'Fitness', c_markets: ['Serbia'], c_markets_world: false,
    p_list: [{a: 'Coached month', b: 'Four weeks with a coach', s: true}, {a: '', b: ''}],
    v_pairs: {warm: 2, volume: 'decide'}, v_mood: ['studio', 'people'], v_not: 'toy', f_links: [{a: 'https://figma.com/file/x', b: 'Brand book'}],
  },
  flags: {c_what: 'prefill'}, clients: [{id: 'c1'}],
  legal: {company: 'Grit d.o.o.', name: 'Ana', nda: {by: 'Ana', company: 'Grit d.o.o.', at: 'Nov 20, 2026', docVersion: 'v1'}, terms: null},
};

test('view: sections, labels, values, flags, notes and files for a brand', () => {
  const view = buildQuestionnaireView(
    {id: 'q1', account_id: 'a1', status: 'submitted', version: 4, state: brandState, unlocked: [], client_accounts: {name: 'Grit', test: true}},
    {notes: [
      {id: 'n1', author_role: 'studio', author: 'Dmitry', question_ids: ['c_what'], body: 'Who is it for?', created_at: '2026-11-20T10:00:00Z'},
      {id: 'n2', author_role: 'client', question_ids: ['reply:n1', 'c_what'], body: 'Beginners over 30.', created_at: '2026-11-20T11:00:00Z'},
    ], files: [
      {id: 'f1', scope: 'brand', name: 'logo.svg', size: 2000, category: 'Logos', status: 'ready'},
      {id: 'f2', scope: 'brand', name: 'big.zip', size: 9e6, category: 'Archives (we unpack)', status: 'uploading'},
      {id: 'f3', scope: 'refs', name: 'ref.png', size: 1000, category: 'References', status: 'ready'},
    ]});
  assert.deepEqual([view.name, view.kind, view.test, view.parts.length], ['Grit Gym', 'brand', true, 1]);
  const secs = view.parts[0].sections.map(s => s.sec);
  assert.deepEqual(secs, ['company', 'product', 'people', 'market', 'ads', 'make', 'vibe', 'files']);
  const company = view.parts[0].sections[0];
  const what = company.questions.find(q => q.key === 'c_what');
  assert.deepEqual([what.label, what.flag, what.notes], ['What does your company do?', 'prefill', ['n1']]);
  const industry = company.questions.find(q => q.key === 'c_industry');
  assert.deepEqual(industry.value, {kind: 'list', items: ['Health', 'Other: Fitness'], decide: false});
  assert.ok(company.questions.some(q => q.key === 'c_social' || q.key === 'c_site'), 'half partners appear with their row');
  assert.ok(company.missing > 0, 'required answers left blank are counted');
  assert.deepEqual(view.parts[0].files.map(f => f.id), ['f1']);
  assert.deepEqual(view.refs.map(f => f.id), ['f3']);
  assert.equal(view.notes[1].replyTo, 'n1');
  assert.deepEqual(view.notes[1].questionIds, ['c_what']);
  assert.equal(view.legal.nda.by, 'Ana');
  assert.equal(view.legal.terms, null);
  assert.deepEqual(view.brands, [{name: 'Grit Gym', questionnaire_scope: null}]);
});

test('values: rows, pairs, mood, links', () => {
  const s = normalizeState(brandState);
  assert.deepEqual(answerValue(s, null, questionById('p_list')), {kind: 'rows', rows: [{a: 'Coached month', b: 'Four weeks with a coach', star: true}]});
  const pairs = answerValue(s, null, questionById('v_pairs'));
  assert.equal(pairs.kind, 'pairs');
  assert.deepEqual(pairs.pairs.slice(0, 2).map(p => p.value), [2, 'decide']);
  assert.deepEqual(answerValue(s, null, questionById('v_mood')).items, ['Dark studio', 'Real people']);
  assert.equal(answerValue(s, null, questionById('f_links')).rows[0].a, 'https://figma.com/file/x');
  assert.deepEqual(answerValue(s, null, questionById('c_year')), {kind: 'empty'});
});

test('agency: one part for the agency and one per client; brands per client', () => {
  const state = {role: 'agency', a: {g_name: 'Blue Harbor', 'c1:c_company': 'Lumo', 'c2:c_what': 'x'}, clients: [{id: 'c1'}, {id: 'c2'}], flags: {}, legal: {}};
  const view = buildQuestionnaireView({id: 'q', account_id: 'a', status: 'submitted', version: 1, state}, {});
  assert.deepEqual(view.parts.map(p => [p.id, p.title]), [['agency', 'Blue Harbor'], ['c1', 'Lumo'], ['c2', 'Client 2']]);
  assert.deepEqual(brandsForApproval(normalizeState(state)), [{name: 'Lumo', questionnaire_scope: 'c1'}, {name: 'Client 2', questionnaire_scope: 'c2'}]);
  const s = normalizeState(state);
  assert.ok(validQuestionKey(s, 'c1:c_what'));
  assert.ok(validQuestionKey(s, 'g_name'));
  assert.ok(!validQuestionKey(s, 'c_what'), 'an agency answer about a client needs its scope');
  assert.ok(!validQuestionKey(s, 'c9:c_what'), 'unknown client');
  assert.ok(!validQuestionKey(s, 'c1:g_name'), 'agency questions have no client scope');
  assert.ok(!validQuestionKey(normalizeState(brandState), 'g_name'));
  assert.ok(!validQuestionKey(normalizeState(brandState), 'nope'));
});

function fakeDb({row, rpcRows = [{id: 'q1', status: 'changes_requested'}]}) {
  const log = [];
  const db = {
    from(table) {
      const q = {
        _op: 'select',
        select() { return q; }, eq() { return q; }, in(col, vals) { log.push({table, op: q._op, ids: vals}); return q; },
        async maybeSingle() { return {data: row, error: null}; },
        insert(rows) { log.push({table, op: 'insert', rows}); q._op = 'insert'; return {select: async () => ({data: rows.map((r, i) => ({id: 'n' + i})), error: null})}; },
        delete() { q._op = 'delete'; return q; },
        then(resolve) { resolve({data: null, error: null}); },
      };
      return q;
    },
    async rpc(name, params) { log.push({rpc: name, params}); return {data: rpcRows, error: null}; },
  };
  return {db, log};
}

test('questions: validated, written as notes, then the unlock; rolled back if the move fails', async () => {
  const row = {id: 'q1', status: 'submitted', version: 2, state: brandState};
  const ok = fakeDb({row});
  await requestQuestionnaireChanges(ok.db, 'q1', 2, [{questionIds: ['c_what', 'c_site'], body: 'Who is it for?'}, {questionIds: ['c_site'], body: 'Is this the right site?'}], {author: 'Dmitry'});
  const insert = ok.log.find(l => l.op === 'insert');
  assert.equal(insert.rows.length, 2);
  assert.deepEqual(insert.rows[0], {questionnaire_id: 'q1', author_role: 'studio', author: 'Dmitry', question_ids: ['c_what', 'c_site'], body: 'Who is it for?'});
  const rpc = ok.log.find(l => l.rpc);
  assert.deepEqual(rpc.params.p_unlocked, ['c_what', 'c_site']);

  const failing = fakeDb({row, rpcRows: []});
  await assert.rejects(requestQuestionnaireChanges(failing.db, 'q1', 2, [{questionIds: ['c_what'], body: 'Q'}]), err => err.status === 409);
  assert.ok(failing.log.some(l => l.op === 'delete' && l.ids.length === 1), 'notes removed after a failed move');

  await assert.rejects(requestQuestionnaireChanges(fakeDb({row}).db, 'q1', 2, [{questionIds: ['c_what'], body: ' '}]), err => err.status === 422);
  await assert.rejects(requestQuestionnaireChanges(fakeDb({row}).db, 'q1', 2, [{questionIds: [], body: 'Q'}]), err => err.status === 422);
  await assert.rejects(requestQuestionnaireChanges(fakeDb({row}).db, 'q1', 2, [{questionIds: ['g_name'], body: 'Q'}]), /not part of this questionnaire/);
  await assert.rejects(requestQuestionnaireChanges(fakeDb({row}).db, 'q1', 2, []), err => err.status === 422);
  const stale = fakeDb({row});
  await assert.rejects(requestQuestionnaireChanges(stale.db, 'q1', 1, [{questionIds: ['c_what'], body: 'Q'}]), err => err.status === 409);
  assert.ok(!stale.log.some(l => l.op === 'insert'), 'nothing written on a stale version');
});

test('approve: brands follow the questionnaire, the studio may rename them', async () => {
  const {db, log} = fakeDb({row: {id: 'q1', status: 'submitted', version: 3, state: brandState}, rpcRows: [{id: 'q1', status: 'approved'}]});
  await approveQuestionnaire(db, 'q1', 3, {brand: '  GRIT Gym  ', c7: 'ignored'});
  const rpc = log.find(l => l.rpc);
  assert.deepEqual(rpc.params.p_brands, [{name: 'GRIT Gym', questionnaire_scope: null}]);
  assert.equal(rpc.params.p_to, 'approved');
});

test('the schema copy matches the dashboard (when its repo is next to Forma)', async t => {
  const {generate, defaultDashboard, OUT, canGenerate} = await import('../scripts/sync-questionnaire-schema.mjs');
  if (!canGenerate) return t.skip('this Node cannot strip TypeScript types');
  const dashboard = defaultDashboard();
  const exists = await fs.access(path.join(dashboard, 'questionnaire', 'schema.ts')).then(() => true, () => false);
  if (!exists) return t.skip('toggle-concepts is not next to forma');
  assert.equal(await fs.readFile(OUT, 'utf8'), await generate(dashboard),
    'shared/questionnaire-schema.mjs is out of date: run node scripts/sync-questionnaire-schema.mjs');
});
