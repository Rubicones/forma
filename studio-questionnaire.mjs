// The brand questionnaire as the studio reads it: sections, answers with their labels, who flagged what.
// Built on the server from the stored state and the dashboard's schema (shared/questionnaire-schema.mjs, generated),
// so the browser gets plain data. Mirrors the parts of the dashboard's questionnaire/logic.ts it needs.
import {SEC, SEC_NAMES, CLIENT_SECS, BRAND_STEPS, PAIRS, MOOD, DECIDE, questionById} from './shared/questionnaire-schema.mjs';

export const scopedKey = (scope, id) => (scope ? `${scope}:${id}` : id);
const isEmpty = v => v == null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
const isAgency = s => s?.role === 'agency';

export function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    role: s.role === 'agency' || s.role === 'brand' ? s.role : null,
    mode: s.mode || null,
    a: s.a && typeof s.a === 'object' ? s.a : {},
    flags: s.flags && typeof s.flags === 'object' ? s.flags : {},
    clients: Array.isArray(s.clients) && s.clients.length ? s.clients.filter(c => c && c.id) : [{id: 'c1'}],
    legal: s.legal && typeof s.legal === 'object' ? s.legal : {},
  };
}

function makeCtx(s, scope) {
  const get = id => s.a[scopedKey(scope, id)];
  const arr = id => (Array.isArray(get(id)) ? get(id) : []);
  return {get, arr, has: (id, o) => { const v = get(id); return Array.isArray(v) ? v.includes(o) : v === o; }, isAgency: isAgency(s), inClient: scope !== null};
}
const text = (t, c) => (t === undefined ? '' : typeof t === 'function' ? t(c) : t);

export function clientName(s, cid) {
  const v = s.a[`${cid}:c_company`];
  const i = s.clients.findIndex(c => c.id === cid);
  return typeof v === 'string' && v.trim() ? v.trim() : `Client ${i + 1}`;
}

export function accountName(s) {
  const v = isAgency(s) ? s.a.g_name : s.a.c_company;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// Same as the dashboard's brandsForApproval: one brand for a brand account, one per agency client.
export function brandsForApproval(s) {
  if (!isAgency(s)) return [{name: String(s.a.c_company ?? '').trim() || 'Your brand', questionnaire_scope: null}];
  return s.clients.map(c => ({name: clientName(s, c.id), questionnaire_scope: c.id}));
}

export function visible(s, scope, q) {
  if (q.skipRender) return false;
  if (q.agency && !(isAgency(s) && scope)) return false;
  if (q.brandOnly && isAgency(s)) return false;
  if (q.show && !q.show(makeCtx(s, scope))) return false;
  return true;
}

export function answered(s, scope, q) {
  const c = makeCtx(s, scope);
  const v = c.get(q.id);
  if (q.type === 'rows') return Array.isArray(v) && v.some(r => r && r.a);
  if (q.type === 'pairs') return !!v && PAIRS.every(p => v[p[0]] != null);
  if (q.type === 'pick') return !isEmpty(v) || !!(q.world && c.get(q.id + '_world'));
  if (q.type === 'mood') return !isEmpty(v) || !!c.get('v_mood_decide');
  if (q.type === 'files') return false;
  return !isEmpty(v);
}

// An answer as plain data the page can draw.
export function answerValue(s, scope, q) {
  const c = makeCtx(s, scope);
  const v = c.get(q.id);
  switch (q.type) {
    case 'text': case 'short':
      return isEmpty(v) ? {kind: 'empty'} : {kind: 'text', text: String(v)};
    case 'chips': case 'months': {
      const items = (Array.isArray(v) ? v : isEmpty(v) ? [] : [v]).map(String).map(o => {
        if (o === 'Other') { const other = c.get(q.id + '__other'); return other ? 'Other: ' + other : 'Other'; }
        return o;
      });
      return items.length ? {kind: 'list', items, decide: items.includes(DECIDE)} : {kind: 'empty'};
    }
    case 'pick': {
      const items = (Array.isArray(v) ? v : []).map(String);
      if (q.world && c.get(q.id + '_world')) items.unshift('Worldwide');
      return items.length ? {kind: 'list', items} : {kind: 'empty'};
    }
    case 'rows': {
      const rows = (Array.isArray(v) ? v : []).filter(r => r && (r.a || r.b)).map(r => ({a: String(r.a || ''), b: String(r.b || ''), star: Boolean(r.s)}));
      return rows.length ? {kind: 'rows', rows} : {kind: 'empty'};
    }
    case 'links': {
      const rows = (Array.isArray(v) ? v : []).filter(r => r && r.a).map(r => ({a: String(r.a), b: String(r.b || '')}));
      return rows.length ? {kind: 'links', rows} : {kind: 'empty'};
    }
    case 'pairs': {
      const val = v && typeof v === 'object' ? v : {};
      const pairs = PAIRS.map(([key, left, leftColor, right, rightColor]) => ({key, left, leftColor, right, rightColor, value: val[key] ?? null}));
      return pairs.some(p => p.value != null) ? {kind: 'pairs', pairs} : {kind: 'empty'};
    }
    case 'mood': {
      const caption = Object.fromEntries(MOOD);
      const items = (Array.isArray(v) ? v : []).map(k => caption[k] || k);
      if (c.get('v_mood_decide')) return {kind: 'list', items: [DECIDE], decide: true};
      return items.length ? {kind: 'list', items} : {kind: 'empty'};
    }
    case 'notyou': {
      const caption = Object.fromEntries(MOOD);
      return v ? {kind: 'list', items: [caption[v] || String(v)]} : {kind: 'empty'};
    }
    case 'tick':
      return v ? {kind: 'text', text: 'Yes'} : {kind: 'empty'};
    default:
      return {kind: 'empty'};
  }
}

function sectionView(s, sec, scope, {unlocked, noteIdsByKey}) {
  const def = SEC[sec];
  const c = makeCtx(s, scope);
  const rows = [];
  let blankOptional = 0;
  for (const q of def.qs) {
    if (q.type === 'files') continue;
    const partner = q.half ? questionById(q.half) : null;
    for (const item of [q, partner].filter(Boolean)) {
      if (!visible(s, scope, q)) continue;   // a half partner shows when its row does
      const done = answered(s, scope, item);
      if (!done && !item.req) { blankOptional++; continue; }
      const key = scopedKey(scope, item.id);
      rows.push({
        key, id: item.id, type: item.type, label: text(item.label, c) || item.id, req: Boolean(item.req), answered: done,
        value: answerValue(s, scope, item), flag: s.flags[key] || null,
        unlocked: unlocked.includes(key), notes: noteIdsByKey.get(key) || [],
      });
    }
  }
  return {sec, title: SEC_NAMES[sec] ?? text(def.title, c), kicker: def.k, questions: rows, missing: rows.filter(r => r.req && !r.answered).length, blankOptional};
}

const signature = sig => (sig ? {by: sig.by || '', company: sig.company || '', at: sig.at || '', docVersion: sig.docVersion || ''} : null);

// row: brand_questionnaires row (+ client_accounts); notes: questionnaire_notes rows; files: client_files rows.
export function buildQuestionnaireView(row, {notes = [], files = []} = {}) {
  const s = normalizeState(row.state);
  const unlocked = Array.isArray(row.unlocked) ? row.unlocked : [];
  const noteIdsByKey = new Map();
  for (const n of notes) {
    if (n.author_role !== 'studio') continue;
    for (const id of n.question_ids || []) noteIdsByKey.set(id, [...(noteIdsByKey.get(id) || []), n.id]);
  }
  const opts = {unlocked, noteIdsByKey};
  const fileView = f => ({id: f.id, name: f.name, size: Number(f.size) || 0, category: f.category, scope: f.scope, status: f.status, createdAt: f.created_at, url: '/api/studio/files/' + f.id});
  const ready = files.filter(f => f.status === 'ready');
  const parts = [];
  if (isAgency(s)) {
    parts.push({id: 'agency', title: accountName(s) || 'Agency', scope: null, sections: [sectionView(s, 'agency', null, opts)], files: []});
    for (const cl of s.clients) {
      parts.push({id: cl.id, title: clientName(s, cl.id), scope: cl.id,
        sections: CLIENT_SECS.map(sec => sectionView(s, sec, cl.id, opts)),
        files: ready.filter(f => f.scope === cl.id).map(fileView)});
    }
  } else {
    const secs = BRAND_STEPS.filter(st => SEC[st]);
    parts.push({id: 'brand', title: accountName(s) || row.client_accounts?.name || 'Brand', scope: null,
      sections: secs.map(sec => sectionView(s, sec, null, opts)),
      files: ready.filter(f => f.scope === 'brand').map(fileView)});
  }
  const l = s.legal;
  return {
    id: row.id, accountId: row.account_id, status: row.status, version: row.version,
    submittedAt: row.submitted_at || null, approvedAt: row.approved_at || null, updatedAt: row.updated_at || null,
    name: accountName(s) || row.client_accounts?.name || 'Unnamed brand',
    kind: isAgency(s) ? 'agency' : 'brand', mode: s.mode, test: Boolean(row.client_accounts?.test),
    parts,
    refs: ready.filter(f => f.scope === 'refs').map(fileView),
    legal: {company: l.company || '', name: l.name || '', nda: signature(l.nda), ndaOwn: Boolean(l.ndaOwn), terms: signature(l.terms), caseStudy: Boolean(l.caseStudy)},
    notes: notes.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map(n => {
      const reply = (n.question_ids || []).find(id => id.startsWith('reply:'));
      return {id: n.id, authorRole: n.author_role, author: n.author || null, body: n.body, createdAt: n.created_at, resolvedAt: n.resolved_at || null,
        questionIds: (n.question_ids || []).filter(id => !id.startsWith('reply:')), replyTo: reply ? reply.slice(6) : null};
    }),
    brands: brandsForApproval(s),
    unlocked,
  };
}

// Keys a studio note may point at: scoped ids of questions that exist for this account.
export function validQuestionKey(s, key) {
  const m = /^(?:(c[\w-]+):)?([a-z]\w*)$/.exec(String(key || ''));
  if (!m) return false;
  const [, scope, id] = m;
  const q = questionById(id);
  if (!q) return false;
  if (scope) return isAgency(s) && s.clients.some(c => c.id === scope) && CLIENT_SECS.some(sec => SEC[sec].qs.includes(q));
  return isAgency(s) ? SEC.agency.qs.includes(q) : !SEC.agency.qs.includes(q);
}
