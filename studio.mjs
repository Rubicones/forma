// Studio side of the client dashboard (repo toggle-concepts, docs/contract.md).
// Forma reads the dashboard's tables and moves statuses only through the same Postgres functions the dashboard uses
// (client_questionnaire_transition, client_campaign_transition), which do compare-and-set on `version`, re-check the
// from-status, write side effects and the client_events row in one transaction. The planners below mirror the studio
// half of the dashboard's lib/state-machine.ts: same rules, same events, same messages. Keep them in step.
// Works only on the cloud store; on the file store the studio is off and says why.

import {contentTypeForPath, streamToBuffer} from './store/supabase.mjs';
import {buildQuestionnaireView, normalizeState, brandsForApproval, validQuestionKey} from './studio-questionnaire.mjs';
import {startBrandCreation, brandCreation} from './studio-brand.mjs';
import {loadCampaignDetail, acceptCampaign, cancelCampaign, directionsDetail, sendDirections, responseDetail, feedbackText, resolveComments, finalDetail, sendFinal} from './studio-campaign.mjs';
import {formats as allFormats} from './motion.mjs';
import {startExportWorker, exportState, expectedExports, fileKey} from './export.mjs';
import * as history from './history.mjs';
import {upgradeCampaign} from './campaigns.mjs';

export const DIRECTIONS_PER_DELIVERY = 3;
export const MAX_REBUILDS = 2;
export const CONFLICT_MESSAGE = 'Someone just updated this. Refresh to see the latest.';
const MIGRATION = 'supabase/migrations/20261120000001_client_dashboard.sql';

export class TransitionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
    this.details = details;
    this.status = {forbidden: 403, invalid: 422, conflict: 409, not_found: 404}[code] || 400;
  }
}

// ---------- planners (pure) ----------

const Q_RULES = {
  request_changes: {from: ['submitted'], to: 'changes_requested'},
  approve: {from: ['submitted'], to: 'approved'},
};

// action: {type:'request_changes', noteCount, unlocked:[scoped ids]} | {type:'approve', brands:[{name, questionnaire_scope}]}
export function planQuestionnaireTransition(current, action) {
  const rule = Q_RULES[action?.type];
  if (!rule) throw new TransitionError('forbidden', "You can't do that here.");
  if (!rule.from.includes(current)) throw new TransitionError('conflict', CONFLICT_MESSAGE, {current, action: action.type});
  if (action.type === 'request_changes') {
    const unlocked = [...new Set((action.unlocked || []).filter(Boolean))];
    if ((action.noteCount || 0) < 1 || unlocked.length < 1) {
      throw new TransitionError('invalid', 'Write at least one question and pick the answers it concerns.');
    }
    return {from: current, to: rule.to, unlocked, brands: null,
      event: {type: 'questionnaire.changes_requested', payload: {questions: unlocked.length}}};
  }
  const brands = (action.brands || [])
    .map(b => ({name: String(b?.name || '').trim(), questionnaire_scope: b?.questionnaire_scope || null}))
    .filter(b => b.name);
  if (!brands.length) throw new TransitionError('invalid', 'An approved questionnaire needs at least one brand name.');
  const scopes = brands.map(b => b.questionnaire_scope ?? '');
  if (new Set(scopes).size !== scopes.length) throw new TransitionError('invalid', 'Each brand needs its own profile.');
  return {from: current, to: rule.to, unlocked: [], brands,
    event: {type: 'questionnaire.approved', payload: {brands: brands.length}}};
}

const NOT_DELIVERED = ['submitted', 'in_progress', 'review_directions', 'in_production'];
const C_RULES = {
  accept: {from: ['submitted'], to: 'in_progress'},
  send_directions: {from: ['in_progress'], to: 'review_directions'},
  send_final: {from: ['in_production'], to: 'delivered'},
  cancel: {from: NOT_DELIVERED, to: 'cancelled'},
};
const noPatch = {rebuildsInc: false, approvedItemId: null, formaCampaignId: null};

// action: {type:'accept', formaCampaignId?} | {type:'send_directions', items:{directions:[…3]}, sentBy?}
//       | {type:'send_final', items:{final:{id,…}}, sentBy?} | {type:'cancel'}
export function planCampaignTransition(current, action) {
  const rule = C_RULES[action?.type];
  if (!rule) throw new TransitionError('forbidden', "You can't do that here.");
  if (!rule.from.includes(current)) throw new TransitionError('conflict', CONFLICT_MESSAGE, {current, action: action.type});
  const base = {from: current, to: rule.to, patch: noPatch, newDelivery: null, respond: null};
  switch (action.type) {
    case 'accept':
      return {...base, patch: {...noPatch, formaCampaignId: action.formaCampaignId ?? null}, event: {type: 'campaign.accepted', payload: {}}};
    case 'send_directions': {
      const ids = (action.items?.directions || []).map(d => d?.id);
      if (ids.length !== DIRECTIONS_PER_DELIVERY || new Set(ids).size !== ids.length || ids.some(id => !id)) {
        throw new TransitionError('invalid', `Send exactly ${DIRECTIONS_PER_DELIVERY} different directions.`);
      }
      return {...base, newDelivery: {stage: 'directions', items: action.items, sentBy: action.sentBy ?? null}, event: {type: 'directions.sent', payload: {}}};
    }
    case 'send_final':
      if (!action.items?.final?.id) throw new TransitionError('invalid', 'Pick the final to send.');
      return {...base, newDelivery: {stage: 'final', items: action.items, sentBy: action.sentBy ?? null}, event: {type: 'final.delivered', payload: {}}};
    case 'cancel':
      return {...base, event: {type: 'campaign.cancelled', payload: {}}};
  }
}

// ---------- persistence (through the dashboard's Postgres functions) ----------

const fail = error => { throw Object.assign(Error(error.message || 'The client database refused the request.'), {status: 502}); };

export async function applyQuestionnaireTransition(db, id, expectedVersion, action) {
  const {data: row, error} = await db.from('brand_questionnaires').select('id, status, version').eq('id', id).maybeSingle();
  if (error) fail(error);
  if (!row) throw new TransitionError('not_found', "We couldn't find that.");
  if (row.version !== expectedVersion) throw new TransitionError('conflict', CONFLICT_MESSAGE);
  const plan = planQuestionnaireTransition(row.status, action);
  const {data, error: rpcError} = await db.rpc('client_questionnaire_transition', {
    p_id: id, p_expected_version: expectedVersion, p_from: plan.from, p_to: plan.to,
    p_unlocked: plan.unlocked, p_brands: plan.brands, p_event_type: plan.event.type, p_event_payload: plan.event.payload,
  });
  if (rpcError) fail(rpcError);
  const next = data?.[0];
  if (!next) throw new TransitionError('conflict', CONFLICT_MESSAGE);
  return next;
}

export async function applyCampaignTransition(db, id, expectedVersion, action) {
  const {data: row, error} = await db.from('campaign_requests').select('id, status, version').eq('id', id).maybeSingle();
  if (error) fail(error);
  if (!row) throw new TransitionError('not_found', "We couldn't find that.");
  if (row.version !== expectedVersion) throw new TransitionError('conflict', CONFLICT_MESSAGE);
  const plan = planCampaignTransition(row.status, action);
  const {data, error: rpcError} = await db.rpc('client_campaign_transition', {
    p_id: id, p_expected_version: expectedVersion, p_from: plan.from, p_to: plan.to,
    p_rebuilds_inc: plan.patch.rebuildsInc, p_approved_item_id: plan.patch.approvedItemId,
    p_forma_campaign_id: plan.patch.formaCampaignId, p_new_delivery: plan.newDelivery,
    p_respond_delivery: null, p_response: null, p_event_type: plan.event.type, p_event_payload: plan.event.payload,
  });
  if (rpcError) {
    if (rpcError.message?.includes('delivery_not_open')) throw new TransitionError('conflict', CONFLICT_MESSAGE);
    fail(rpcError);
  }
  const next = data?.[0];
  if (!next) throw new TransitionError('conflict', CONFLICT_MESSAGE);
  return next;
}

// ---------- inbox (pure) ----------
// turn: whose move it is. 'studio' items are what the studio has to act on; they drive the counter.

const Q_VIEW = {
  draft: {turn: 'client', label: 'Filling in'},
  submitted: {turn: 'studio', label: 'New questionnaire'},
  changes_requested: {turn: 'client', label: 'Questions sent'},
  approved: {turn: 'done', label: 'Approved'},
};

export function campaignView(status, latestDirections) {
  const round = latestDirections?.round || 0;
  switch (status) {
    case 'submitted': return {turn: 'studio', label: 'New request'};
    case 'in_progress':
      return latestDirections?.response?.decision === 'rebuild'
        ? {turn: 'studio', label: `Rebuild requested · round ${round + 1} next`}
        : {turn: 'studio', label: 'In progress'};
    case 'review_directions': return {turn: 'client', label: `Directions with the client · round ${round || 1}`};
    case 'in_production': return {turn: 'studio', label: 'Direction approved · build the final'};
    case 'delivered': return {turn: 'done', label: 'Delivered'};
    case 'cancelled': return {turn: 'done', label: 'Cancelled'};
    default: return {turn: 'done', label: status};
  }
}

const EVENT_TEXT = {
  'questionnaire.submitted': (a) => `${a} sent the questionnaire`,
  'questionnaire.resubmitted': (a) => `${a} answered our questions`,
  'questionnaire.changes_requested': (a) => `Questions sent to ${a}`,
  'questionnaire.approved': (a) => `${a}: questionnaire approved`,
  'campaign.submitted': (a, c) => `${a} requested “${c}”`,
  'campaign.accepted': (a, c) => `“${c}” accepted`,
  'directions.sent': (a, c) => `Directions sent for “${c}”`,
  'direction.approved': (a, c) => `${a} approved a direction in “${c}”`,
  'directions.rebuild_requested': (a, c) => `${a} asked to rebuild “${c}”`,
  'final.delivered': (a, c) => `Final delivered for “${c}”`,
  'campaign.cancelled': (a, c) => `“${c}” cancelled`,
};

const accountName = (account, fallback) => account?.name || fallback || 'A client';

// One line of a timeline that is already about one questionnaire or one campaign (no campaign name needed).
const TIMELINE_TEXT = {
  'questionnaire.submitted': a => `${a} sent the questionnaire`,
  'questionnaire.resubmitted': a => `${a} answered our questions`,
  'questionnaire.changes_requested': (a, p) => `We asked ${a} ${p?.questions ? p.questions + (p.questions === 1 ? ' question' : ' questions') : 'questions'}`,
  'questionnaire.approved': () => 'Approved; the brand was made',
  'campaign.submitted': a => `${a} sent the request`,
  'campaign.accepted': () => 'Accepted into Forma',
  'directions.sent': (a, p) => 'Three directions sent' + (p?.round ? ` · round ${p.round}` : ''),
  'direction.approved': a => `${a} approved a direction`,
  'directions.rebuild_requested': a => `${a} asked for a rebuild`,
  'final.delivered': () => 'Final delivered',
  'campaign.cancelled': () => 'Cancelled',
};
export function timeline(events = [], account = 'The client') {
  return events.slice().sort((x, y) => String(x.at).localeCompare(String(y.at)))
    .map(e => ({id: e.id, type: e.type, at: e.at, text: (TIMELINE_TEXT[e.type] || (() => e.type))(account, e.payload || {})}));
}

export async function loadTimeline(db, {accountId, campaignId = null}) {
  let q = db.from('client_events').select('id, type, at, payload').eq('account_id', accountId);
  q = campaignId ? q.eq('campaign_request_id', campaignId) : q.is('campaign_request_id', null);
  const {data, error} = await q.order('at', {ascending: true}).limit(200);
  if (error) fail(error);
  return data || [];
}

export function buildInbox({questionnaires = [], campaigns = [], deliveries = [], events = []} = {}, {includeTest = true} = {}) {
  const keep = row => includeTest || !row.client_accounts?.test;
  const qs = questionnaires.filter(keep).map(q => {
    const view = Q_VIEW[q.status] || {turn: 'done', label: q.status};
    const clients = Array.isArray(q.clients) ? q.clients.length : 0;
    return {
      id: q.id, accountId: q.account_id, version: q.version, status: q.status, ...view,
      name: q.company || accountName(q.client_accounts, 'Unnamed brand'),
      kind: q.role === 'agency' || q.client_accounts?.kind === 'agency' ? 'agency' : 'brand',
      clients: q.role === 'agency' ? clients : 0,
      test: Boolean(q.client_accounts?.test),
      submittedAt: q.submitted_at || null, approvedAt: q.approved_at || null, updatedAt: q.updated_at || null,
    };
  });
  const latest = new Map();
  for (const d of deliveries) {
    if (d.stage !== 'directions') continue;
    const prev = latest.get(d.campaign_request_id);
    if (!prev || d.round > prev.round) latest.set(d.campaign_request_id, d);
  }
  const cs = campaigns.filter(keep).map(c => {
    const directions = latest.get(c.id) || null;
    return {
      id: c.id, accountId: c.account_id, version: c.version, status: c.status, ...campaignView(c.status, directions),
      name: c.name, brand: c.client_brands?.name || accountName(c.client_accounts),
      account: accountName(c.client_accounts), test: Boolean(c.client_accounts?.test),
      kind: c.setup?.kind || null, formats: c.setup?.formats || [], languages: c.setup?.languages || [], lengths: c.setup?.lengths || [],
      round: directions?.round || 0, rebuildsLeft: Math.max(0, MAX_REBUILDS - (c.rebuilds_used || 0)),
      formaCampaignId: c.forma_campaign_id || null, createdAt: c.created_at || null, updatedAt: c.updated_at || null,
    };
  });
  const byTime = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  qs.sort(byTime);
  cs.sort(byTime);
  const activity = events.filter(keep).map(e => ({
    id: e.id, type: e.type, at: e.at, campaignId: e.campaign_request_id || null, accountId: e.account_id,
    text: (EVENT_TEXT[e.type] || ((a) => `${a}: ${e.type}`))(accountName(e.client_accounts), e.campaign_requests?.name || 'a campaign'),
  }));
  return {
    questionnaires: qs, campaigns: cs, activity,
    waiting: qs.filter(q => q.turn === 'studio').length + cs.filter(c => c.turn === 'studio').length,
  };
}

// ---------- availability and loading ----------

let availability = {at: 0, value: null};
export async function studioAvailability(store, {fresh = false} = {}) {
  if (!fresh && availability.value && Date.now() - availability.at < 60000) return availability.value;
  let value;
  if (store.driver !== 'supabase') {
    value = {enabled: false, reason: 'Client work needs the cloud store: set FORMA_STORE=supabase in .env and restart.'};
  } else {
    try {
      const db = await store.db();
      const {data, error} = await db.from('schema_meta').select('value').eq('key', 'client_dashboard').maybeSingle();
      value = error || data?.value !== '1'
        ? {enabled: false, reason: `The client tables are missing: apply ${MIGRATION} (npx supabase db push).`}
        : {enabled: true};
    } catch (err) {
      value = {enabled: false, reason: 'The cloud database is unreachable: ' + err.message};
    }
  }
  availability = {at: Date.now(), value};
  return value;
}

export async function loadInbox(db, {includeTest = true} = {}) {
  const run = async query => { const {data, error} = await query; if (error) fail(error); return data || []; };
  const [questionnaires, campaigns, events] = await Promise.all([
    run(db.from('brand_questionnaires')
      .select('id, account_id, status, version, submitted_at, approved_at, updated_at, role:state->>role, company:state->a->>c_company, clients:state->clients, client_accounts(name, kind, test)')
      .order('updated_at', {ascending: false}).limit(200)),
    run(db.from('campaign_requests')
      .select('id, account_id, name, status, version, setup, rebuilds_used, forma_campaign_id, created_at, updated_at, client_accounts(name, test), client_brands(name)')
      .order('updated_at', {ascending: false}).limit(200)),
    run(db.from('client_events')
      .select('id, type, at, account_id, campaign_request_id, client_accounts(name, test), campaign_requests(name)')
      .order('at', {ascending: false}).limit(40)),
  ]);
  const ids = campaigns.map(c => c.id);
  const deliveries = ids.length
    ? await run(db.from('deliveries').select('campaign_request_id, stage, round, status, response, sent_at, responded_at').in('campaign_request_id', ids))
    : [];
  return buildInbox({questionnaires, campaigns, deliveries, events}, {includeTest});
}

// ---------- questionnaire detail and moderation ----------

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const invalid = (message, status = 400) => Object.assign(Error(message), {status});

export async function loadQuestionnaireDetail(db, id) {
  if (!uuid.test(String(id))) throw new TransitionError('not_found', "We couldn't find that.");
  const one = async query => { const {data, error} = await query; if (error) fail(error); return data; };
  const row = await one(db.from('brand_questionnaires').select('*, client_accounts(name, kind, test)').eq('id', id).maybeSingle());
  if (!row) throw new TransitionError('not_found', "We couldn't find that.");
  const [notes, files] = await Promise.all([
    one(db.from('questionnaire_notes').select('*').eq('questionnaire_id', id).order('created_at', {ascending: true})),
    one(db.from('client_files').select('id, scope, name, size, content_type, category, status, created_at').eq('account_id', row.account_id).order('created_at', {ascending: true})),
  ]);
  const view = buildQuestionnaireView(row, {notes: notes || [], files: files || []});
  const events = await loadTimeline(db, {accountId: row.account_id}).catch(() => []);
  return {...view, ...Q_VIEW[row.status], formaBrands: row.status === 'approved' ? await formaBrands(db, row) : null,
    timeline: timeline(events, view.name)};
}

// The Forma brands made from an approved questionnaire (studio-brand.mjs), and how the making goes.
async function formaBrands(db, row) {
  const {data, error} = await db.from('client_brands').select('id, name, questionnaire_scope, forma_brand_id').eq('account_id', row.account_id).order('created_at', {ascending: true});
  if (error) fail(error);
  const run = brandCreation(row.id);
  const byId = new Map((run?.results || []).map(r => [r.clientBrandId, r]));
  const items = (data || []).map(b => ({id: b.id, name: b.name, scope: b.questionnaire_scope || null, formaBrandId: b.forma_brand_id || null,
    error: byId.get(b.id)?.error || null, figma: byId.get(b.id)?.figma || []}));
  const status = run?.status === 'running' ? 'running' : items.every(b => b.formaBrandId) ? 'done' : run?.status === 'failed' ? 'failed' : 'pending';
  return {status, error: status === 'failed' ? run.error : null, items};
}

// notes: [{questionIds:[scoped ids], body}]. The notes are written first, then the status moves; if the move fails
// they are removed again, so the client never sees questions without the unlock, or the unlock without questions.
export async function requestQuestionnaireChanges(db, id, expectedVersion, notes, {author = null} = {}) {
  const {data: row, error} = await db.from('brand_questionnaires').select('id, status, version, state').eq('id', id).maybeSingle();
  if (error) fail(error);
  if (!row) throw new TransitionError('not_found', "We couldn't find that.");
  const state = normalizeState(row.state);
  const clean = (Array.isArray(notes) ? notes : []).map(n => ({
    body: String(n?.body || '').trim(),
    questionIds: [...new Set((Array.isArray(n?.questionIds) ? n.questionIds : []).map(String))],
  })).filter(n => n.body || n.questionIds.length);
  for (const n of clean) {
    if (!n.body) throw new TransitionError('invalid', 'Write the question for every group of answers you picked.');
    if (n.body.length > 4000) throw new TransitionError('invalid', 'Keep each question under 4,000 characters.');
    if (!n.questionIds.length) throw new TransitionError('invalid', 'Pick the answers each question is about.');
    const bad = n.questionIds.find(key => !validQuestionKey(state, key));
    if (bad) throw new TransitionError('invalid', 'That answer is not part of this questionnaire: ' + bad);
  }
  const unlocked = [...new Set(clean.flatMap(n => n.questionIds))];
  planQuestionnaireTransition(row.status, {type: 'request_changes', noteCount: clean.length, unlocked});   // fail early, before writing
  if (row.version !== expectedVersion) throw new TransitionError('conflict', CONFLICT_MESSAGE);
  const {data: inserted, error: insertError} = await db.from('questionnaire_notes')
    .insert(clean.map(n => ({questionnaire_id: id, author_role: 'studio', author, question_ids: n.questionIds, body: n.body})))
    .select('id');
  if (insertError) fail(insertError);
  try {
    return await applyQuestionnaireTransition(db, id, expectedVersion, {type: 'request_changes', noteCount: clean.length, unlocked});
  } catch (err) {
    const ids = (inserted || []).map(r => r.id);
    if (ids.length) await db.from('questionnaire_notes').delete().in('id', ids);
    throw err;
  }
}

export async function approveQuestionnaire(db, id, expectedVersion, names) {
  const {data: row, error} = await db.from('brand_questionnaires').select('id, status, version, state').eq('id', id).maybeSingle();
  if (error) fail(error);
  if (!row) throw new TransitionError('not_found', "We couldn't find that.");
  // The brands follow the questionnaire (one, or one per agency client); the studio may only correct their names.
  const brands = brandsForApproval(normalizeState(row.state)).map(b => {
    const custom = names && typeof names === 'object' ? names[b.questionnaire_scope || 'brand'] : null;
    return typeof custom === 'string' && custom.trim() ? {...b, name: custom.trim().slice(0, 160)} : b;
  });
  return applyQuestionnaireTransition(db, id, expectedVersion, {type: 'approve', brands});
}

const INLINE = /\.(png|jpe?g|gif|webp|svg|pdf|mp4|mov|webm|txt|md)$/i;

// ---------- routes ----------

export function registerStudioRoutes(app, {store, deps = {}}) {
  // Exports run where Forma runs (export.mjs), only with the client tables in place.
  const exportWorker = deps.previewURL && process.env.FORMA_EXPORTS !== '0'
    ? startExportWorker({getDb: async () => ((await studioAvailability(store)).enabled ? store.db() : null), blobs: store.blobs, previewURL: deps.previewURL})
    : null;
  const makeBrands = (db, id, provider) => startBrandCreation(db, store.blobs, id, {
    provider: provider && typeof provider === 'object' ? provider : null, deps,
    log: message => console.log('[studio] ' + message),
  });
  const requireStudio = async () => {
    const state = await studioAvailability(store);
    if (!state.enabled) throw Object.assign(Error(state.reason), {status: 503});
    return store.db();
  };
  app.get('/api/studio/status', async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await studioAvailability(store, {fresh: req.query.fresh === '1'}));
  });
  // Where each client campaign stands, by Forma campaign id: badges on Forma's campaign lists.
  app.get('/api/studio/campaign-statuses', async (req, res) => {
    const state = await studioAvailability(store);
    if (!state.enabled) return res.set('Cache-Control', 'no-store').json({enabled: false, byCampaign: {}});
    const inbox = await loadInbox(store.db());
    const byCampaign = Object.fromEntries(inbox.campaigns.filter(c => c.formaCampaignId)
      .map(c => [c.formaCampaignId, {requestId: c.id, status: c.status, label: c.label, turn: c.turn, test: c.test, account: c.account}]));
    res.set('Cache-Control', 'no-store').json({enabled: true, byCampaign});
  });
  app.get('/api/studio/inbox', async (req, res) => {
    const db = await requireStudio();
    res.set('Cache-Control', 'no-store').json(await loadInbox(db, {includeTest: req.query.test !== '0'}));
  });
  app.get('/api/studio/questionnaires/:id', async (req, res) => {
    const db = await requireStudio();
    res.set('Cache-Control', 'no-store').json(await loadQuestionnaireDetail(db, req.params.id));
  });
  app.post('/api/studio/questionnaires/:id/questions', async (req, res) => {
    const db = await requireStudio();
    await requestQuestionnaireChanges(db, req.params.id, Number(req.body?.version), req.body?.notes, {author: process.env.FORMA_AUTHOR || null});
    res.json(await loadQuestionnaireDetail(db, req.params.id));
  });
  app.post('/api/studio/questionnaires/:id/approve', async (req, res) => {
    const db = await requireStudio();
    await approveQuestionnaire(db, req.params.id, Number(req.body?.version), req.body?.names);
    makeBrands(db, req.params.id, req.body?.provider);   // in the background; the page polls for the result
    res.json(await loadQuestionnaireDetail(db, req.params.id));
  });
  // Make the Forma brands again for the ones still missing (after a failure, or for an approval made elsewhere).
  app.post('/api/studio/questionnaires/:id/brands', async (req, res) => {
    const db = await requireStudio();
    if (!uuid.test(req.params.id)) throw invalid("We couldn't find that.", 404);
    makeBrands(db, req.params.id, req.body?.provider);
    res.json(await loadQuestionnaireDetail(db, req.params.id));
  });
  // Campaign requests: read, accept into a Forma campaign, cancel (studio-campaign.mjs).
  app.get('/api/studio/campaigns/:id', async (req, res) => {
    const db = await requireStudio();
    res.set('Cache-Control', 'no-store').json(await loadCampaignDetail(db, req.params.id));
  });
  app.post('/api/studio/campaigns/:id/accept', async (req, res) => {
    const db = await requireStudio();
    if (!deps.createClientCampaign) throw invalid('Campaigns cannot be made here.', 500);
    const campaign = await acceptCampaign(db, store.blobs, req.params.id, Number(req.body?.version), {
      provider: req.body?.provider, createClientCampaign: deps.createClientCampaign, log: message => console.log('[studio] ' + message),
    });
    res.json({campaignId: campaign.id, detail: await loadCampaignDetail(db, req.params.id)});
  });
  // Three directions to the client: what can be sent, and the send itself (manual, by the studio).
  const formaData = {
    getCampaign: async id => { const doc = await history.get(id).catch(() => null); return doc?.type === 'campaign' ? upgradeCampaign(doc) : null; },
    getEntry: id => history.get(id).catch(() => null),
  };
  app.get('/api/studio/campaigns/:id/directions', async (req, res) => {
    const db = await requireStudio();
    const data = await directionsDetail(db, req.params.id, formaData);
    const base = deps.previewURL || '';
    res.set('Cache-Control', 'no-store').json({...data, available: data.available.map(d => ({...d, url: base + d.path}))});
  });
  app.post('/api/studio/campaigns/:id/directions', async (req, res) => {
    const db = await requireStudio();
    await sendDirections(db, req.params.id, Number(req.body?.version), req.body?.picks, {...formaData, sentBy: req.headers['x-forma-author'] || process.env.FORMA_AUTHOR || null});
    res.json(await loadCampaignDetail(db, req.params.id));
  });
  // The client's answer to the latest round: decision, comments with pins, and the notes Forma acts on.
  const withFeedback = detail => {
    const base = deps.previewURL || '';
    const formats = Object.fromEntries(Object.values(allFormats).map(f => [f.id, {w: f.w, h: f.h, label: f.label}]));
    return {...detail, items: detail.items.map(d => ({...d, url: base + d.path})), formats, feedback: feedbackText(detail)};
  };
  app.get('/api/studio/campaigns/:id/response', async (req, res) => {
    const db = await requireStudio();
    res.set('Cache-Control', 'no-store').json(withFeedback(await responseDetail(db, req.params.id)));
  });
  app.post('/api/studio/campaigns/:id/comments/resolve', async (req, res) => {
    const db = await requireStudio();
    res.json(withFeedback(await resolveComments(db, req.params.id, req.body?.ids, req.body?.note)));
  });
  // The final of the approved direction: what would be sent, and the send (it delivers the campaign).
  app.get('/api/studio/campaigns/:id/final', async (req, res) => {
    const db = await requireStudio();
    const data = await finalDetail(db, req.params.id, formaData);
    res.set('Cache-Control', 'no-store').json({...data, url: data.final ? (deps.previewURL || '') + data.final.path : null});
  });
  app.post('/api/studio/campaigns/:id/final', async (req, res) => {
    const db = await requireStudio();
    await sendFinal(db, req.params.id, Number(req.body?.version), {...formaData, title: req.body?.title, sentBy: req.headers['x-forma-author'] || process.env.FORMA_AUTHOR || null});
    exportWorker?.kick();   // the files start right away
    res.json(await loadCampaignDetail(db, req.params.id));
  });

  // The final's files (export.mjs): what exists, what is being made, and "export again" for what failed.
  const latestFinal = async (db, id) => {
    const {data, error} = await db.from('deliveries').select('id, items, sent_at').eq('campaign_request_id', id).eq('stage', 'final')
      .order('sent_at', {ascending: false}).limit(1);
    if (error) fail(error);
    return data?.[0] || null;
  };
  app.get('/api/studio/campaigns/:id/exports', async (req, res) => {
    const db = await requireStudio();
    const delivery = await latestFinal(db, req.params.id);
    if (!delivery) return res.set('Cache-Control', 'no-store').json({delivery: null, files: [], counts: {}, state: null});
    const {data: rows, error} = await db.from('delivery_exports').select('format, lang, length, file_type, status, size').eq('delivery_id', delivery.id);
    if (error) fail(error);
    const byKey = new Map((rows || []).map(r => [fileKey(r), r]));
    const files = expectedExports(delivery.items?.final).map(f => ({...f, status: byKey.get(fileKey(f))?.status || 'missing', size: byKey.get(fileKey(f))?.size ?? null}));
    const counts = files.reduce((n, f) => ({...n, [f.status]: (n[f.status] || 0) + 1}), {});
    res.set('Cache-Control', 'no-store').json({delivery: {id: delivery.id}, files, counts, total: files.length, state: exportState(delivery.id), worker: Boolean(exportWorker)});
  });
  app.post('/api/studio/campaigns/:id/exports', async (req, res) => {
    const db = await requireStudio();
    const delivery = await latestFinal(db, req.params.id);
    if (!delivery) throw invalid('Nothing was delivered yet.', 409);
    if (!exportWorker) throw invalid('Exports are turned off here (FORMA_EXPORTS=0).', 503);
    exportWorker.kick(delivery.id, {retry: true});
    res.json({ok: true});
  });
  app.post('/api/studio/campaigns/:id/cancel', async (req, res) => {
    const db = await requireStudio();
    await cancelCampaign(db, req.params.id, Number(req.body?.version));
    res.json(await loadCampaignDetail(db, req.params.id));
  });

  // A client's file, streamed from R2. Pictures, PDFs and videos open in the browser; everything else downloads.
  app.get('/api/studio/files/:id', async (req, res) => {
    const db = await requireStudio();
    if (!uuid.test(req.params.id)) throw invalid('File not found.', 404);
    const {data: file, error} = await db.from('client_files').select('name, r2_key, status').eq('id', req.params.id).maybeSingle();
    if (error) fail(error);
    if (!file || file.status !== 'ready' || !String(file.r2_key).startsWith('clients/')) throw invalid('File not found.', 404);
    const body = await store.blobs.get(file.r2_key);
    if (!body) throw invalid('The file is missing from storage.', 404);
    const buf = await streamToBuffer(body);
    const disposition = INLINE.test(file.name) && req.query.download !== '1' ? 'inline' : 'attachment';
    const type = /\.pdf$/i.test(file.name) ? 'application/pdf' : /\.(txt|md)$/i.test(file.name) ? 'text/plain; charset=utf-8' : contentTypeForPath(file.name);
    res.set({'Content-Type': type, 'Content-Length': String(buf.length), 'Cache-Control': 'private, max-age=300',
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'X-Content-Type-Options': 'nosniff'});
    if (/\.svg$/i.test(file.name)) res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.end(buf);
  });
}
