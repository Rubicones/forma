// Stage 4: campaign requests from the client dashboard. The studio reads the request (setup, brief, references),
// accepts it into a Forma campaign or cancels it. Accepting makes the campaign first (its id is the request id, so a
// retry finds it) and then moves the status through client_campaign_transition with forma_campaign_id set.
import {collectClientFiles} from './studio-brand.mjs';
import {latestBrand} from './brands.mjs';
import {applyCampaignTransition, planCampaignTransition, campaignView, TransitionError, CONFLICT_MESSAGE, MAX_REBUILDS, DIRECTIONS_PER_DELIVERY, loadTimeline, timeline} from './studio.mjs';

export const REFS_DIR = 'client-references';
const UP_TO_YOU = 'Up to you';
const NOT_DELIVERED = ['submitted', 'in_progress', 'review_directions', 'in_production'];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const invalid = (message, status = 400) => Object.assign(Error(message), {status});
const fail = error => { throw Object.assign(Error(error.message || 'The client database refused the request.'), {status: 502}); };
const str = v => (typeof v === 'string' ? v.trim() : '');

export function cleanBrief(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  return {
    product: str(b.product), promote: str(b.promote), goal: str(b.goal), offer: str(b.offer), offerText: str(b.offerText), cta: str(b.cta),
    links: (Array.isArray(b.links) ? b.links : []).filter(l => str(l?.a)).map(l => ({a: str(l.a), b: str(l.b)})),
    fileIds: (Array.isArray(b.fileIds) ? b.fileIds : []).map(String).filter(id => uuid.test(id)),
    note: str(b.note),
  };
}

// The brief as the script step reads it ("brief" in the scenario message).
export function briefText({name = '', brief} = {}, {brand = '', account = '', refs = 0} = {}) {
  const b = cleanBrief(brief);
  const who = brand && account && account !== brand ? `${brand}, through the agency ${account}` : brand || account;
  const lines = [`The client's brief for the campaign “${name}”${who ? ' (' + who + ')' : ''}. "${UP_TO_YOU}" leaves that choice to the studio.`];
  if (b.product) lines.push(`Product or offer: ${b.product}`);
  lines.push(`What to promote: ${b.promote || 'not given'}`);
  if (b.goal) lines.push(`Goal: ${b.goal}`);
  if (b.offer === 'No offer') lines.push('Offer: none; show no offer.');
  else if (b.offer === UP_TO_YOU) lines.push(`Offer: ${UP_TO_YOU}.`);
  else if (b.offer) lines.push(`Offer: ${b.offer}. Its exact wording, word for word: “${b.offerText}”`);
  if (b.cta) lines.push(`Button text: ${b.cta}`);
  if (b.links.length) lines.push('Links from the client:', ...b.links.map(l => `- ${l.a}${l.b ? ' (' + l.b + ')' : ''}`));
  if (b.note) lines.push(`Note from the client: ${b.note}`);
  if (refs) lines.push(`References: ${refs} ${refs === 1 ? 'file' : 'files'} in ${REFS_DIR}/.`);
  return lines.join('\n');
}

async function loadRow(db, id) {
  if (!uuid.test(String(id))) throw new TransitionError('not_found', "We couldn't find that.");
  const {data, error} = await db.from('campaign_requests')
    .select('*, client_accounts(name, kind, test), client_brands(id, name, forma_brand_id, questionnaire_scope)').eq('id', id).maybeSingle();
  if (error) fail(error);
  if (!data) throw new TransitionError('not_found', "We couldn't find that.");
  return data;
}

async function refRows(db, row, ids) {
  if (!ids.length) return [];
  const {data, error} = await db.from('client_files').select('id, account_id, scope, name, size, content_type, category, r2_key, status, created_at').in('id', ids);
  if (error) fail(error);
  return (data || []).filter(f => f.account_id === row.account_id);
}

export async function loadCampaignDetail(db, id) {
  const row = await loadRow(db, id);
  const brief = cleanBrief(row.brief);
  const [files, deliveries, events] = await Promise.all([
    refRows(db, row, brief.fileIds),
    (async () => {
      const {data, error} = await db.from('deliveries').select('id, stage, round, status, response, sent_at, responded_at').eq('campaign_request_id', id).order('sent_at', {ascending: true});
      if (error) fail(error);
      return data || [];
    })(),
    loadTimeline(db, {accountId: row.account_id, campaignId: id}).catch(() => []),
  ]);
  const directions = deliveries.filter(d => d.stage === 'directions').sort((a, b) => b.round - a.round)[0] || null;
  const ready = files.filter(f => f.status === 'ready');
  return {
    id: row.id, name: row.name, status: row.status, version: row.version, ...campaignView(row.status, directions),
    account: row.client_accounts?.name || 'A client', kind: row.client_accounts?.kind || 'brand', test: Boolean(row.client_accounts?.test),
    brand: {id: row.client_brands?.id || row.client_brand_id, name: row.client_brands?.name || row.client_accounts?.name || 'Brand', formaBrandId: row.client_brands?.forma_brand_id || null},
    setup: row.setup || {}, brief: {...brief, fileIds: undefined},
    refs: ready.map(f => ({id: f.id, name: f.name, size: Number(f.size) || 0, category: f.category, url: '/api/studio/files/' + f.id})),
    refsPending: brief.fileIds.length - ready.length,
    round: directions?.round || 0, rebuildsLeft: Math.max(0, MAX_REBUILDS - (row.rebuilds_used || 0)),
    formaCampaignId: row.forma_campaign_id || null, createdAt: row.created_at || null, updatedAt: row.updated_at || null,
    deliveries: deliveries.map(d => ({id: d.id, stage: d.stage, round: d.round, status: d.status, response: d.response || null, sentAt: d.sent_at || null, respondedAt: d.responded_at || null})),
    canAccept: row.status === 'submitted', canCancel: NOT_DELIVERED.includes(row.status),
    timeline: timeline(events, row.client_accounts?.name || 'The client'),
  };
}

// createClientCampaign: from registerCampaignRoutes (campaigns.mjs). provider: the studio's model settings.
export async function acceptCampaign(db, blobs, id, expectedVersion, {provider = null, createClientCampaign, log = () => {}} = {}) {
  const row = await loadRow(db, id);
  if (row.version !== expectedVersion) throw new TransitionError('conflict', CONFLICT_MESSAGE);
  planCampaignTransition(row.status, {type: 'accept'});   // fail early, before copying anything
  const formaBrandId = row.client_brands?.forma_brand_id;
  if (!formaBrandId) throw invalid('This client’s brand is not in Forma yet. Open its questionnaire and use “Make the brand”.', 409);
  const brand = await latestBrand(formaBrandId);
  if (!brand) throw invalid('This client’s brand is missing from Forma. Open its questionnaire and make the brand again.', 409);
  const brief = cleanBrief(row.brief);
  const refs = (await refRows(db, row, brief.fileIds)).filter(f => f.status === 'ready' && f.scope === 'refs' && String(f.r2_key || '').startsWith('clients/'));
  const {items, skipped} = await collectClientFiles(blobs, refs, {log});
  const files = items.map(f => ({name: `${REFS_DIR}/${f.name}`, bytes: f.bytes}));
  const names = {brand: row.client_brands?.name || brand.name, account: row.client_accounts?.name || ''};
  const campaign = await createClientCampaign({
    id: row.id, brandId: brand.id, brandVersion: brand.version, name: row.name, files,
    setup: {...(row.setup || {}), provider: provider && typeof provider === 'object' ? provider : {mode: 'demo'}},
    client: {
      requestId: row.id, accountId: row.account_id, account: names.account, brand: names.brand, clientBrandId: row.client_brand_id,
      test: Boolean(row.client_accounts?.test), brief, briefText: briefText(row, {...names, refs: files.length}),
      ...(skipped.length ? {refsSkipped: skipped} : {}), acceptedAt: new Date().toISOString(),
    },
  });
  await applyCampaignTransition(db, id, expectedVersion, {type: 'accept', formaCampaignId: campaign.id});
  return campaign;
}

export async function cancelCampaign(db, id, expectedVersion) {
  return applyCampaignTransition(db, id, expectedVersion, {type: 'cancel'});
}

// ---------- three directions to the client (stage 5) ----------
// Mirrors the dashboard's lib/forma-map.ts (toGalleryCampaign) and campaign/review.ts (buildDirectionsSnapshot):
// every variant with a preview is a direction; the studio picks three, words them for the client and sends them.

export const NOTE_MAX = 600;
const PATH_OK = /^\/p\/[0-9a-f-]{36}\/[^?#]+$/i;

// Strips Forma's internal direction prefixes ("Native: ", "World: ", "Bold: ") and tidies spacing.
export const clientTitle = raw => String(raw ?? '').replace(/^\s*(native|world|bold)\s*[:·—–-]\s*/i, '').replace(/\s+/g, ' ').trim();
const defaultLabel = label => !label || /^(?:style|стиль)\s*\d+$/i.test(String(label).trim());

// campaign: the Forma campaign doc; getEntry: id -> history entry.
export async function directionsOf(campaign, getEntry) {
  const setup = campaign?.setup || {};
  const out = [];
  for (const [i, v] of (campaign?.variants || []).entries()) {
    const preview = v.preview?.entryId ? await getEntry(v.preview.entryId) : null;
    const path = preview?.output?.path;
    if (typeof path !== 'string') continue;
    const styles = v.styles?.entryId ? (await getEntry(v.styles.entryId))?.output?.styles : null;
    const style = Array.isArray(styles) ? styles[v.styles.chosenIndex] || null : null;
    out.push({
      id: v.id,
      label: v.label || '',
      title: clientTitle(style?.name) || (defaultLabel(v.label) ? `Direction ${i + 1}` : clientTitle(v.label)),
      idea: clientTitle(style?.idea),
      path,
      format: preview.output.format || setup.formats?.[0] || '1x1',
      lang: preview.output.lang || setup.languages?.[0] || 'en',
      scenes: Array.isArray(preview.output.scenes) ? preview.output.scenes.filter(x => typeof x === 'string') : [],
      keyframeSvg: typeof style?.svg === 'string' ? style.svg : null,
      previewEntryId: preview.id,
      stale: Boolean(v.preview.stale),
      approved: Boolean(v.preview.approvedAt),
      hasFinal: Boolean(v.final?.entryId),
    });
  }
  return out;
}

// picks: [{id, title?, idea?, note?}] in the order the client will see them.
export function buildDirectionsSnapshot(available, picks = []) {
  const list = (Array.isArray(picks) ? picks : []).filter(p => p && typeof p.id === 'string');
  const ids = [...new Set(list.map(p => p.id))];
  if (ids.length !== DIRECTIONS_PER_DELIVERY || list.length !== ids.length) throw new TransitionError('invalid', `Pick exactly ${DIRECTIONS_PER_DELIVERY} different directions.`);
  const directions = list.map(p => {
    const d = available.find(x => x.id === p.id);
    if (!d) throw new TransitionError('invalid', 'A picked direction has no preview. Build its preview first.');
    if (!PATH_OK.test(d.path)) throw new TransitionError('invalid', 'A picked direction has no valid preview.');
    const title = clientTitle(typeof p.title === 'string' ? p.title : d.title).slice(0, 80) || d.title || 'Direction';
    const idea = clientTitle(typeof p.idea === 'string' ? p.idea : d.idea).slice(0, 300);
    const snap = {id: d.id, title, idea, previewEntryId: d.previewEntryId, path: d.path, format: d.format, lang: d.lang, scenes: d.scenes, keyframeSvg: d.keyframeSvg};
    const note = typeof p.note === 'string' ? p.note.trim() : '';
    if (note) snap.studioNote = note.slice(0, NOTE_MAX);
    return snap;
  });
  return {directions};
}

// What the send dialog needs: the request's state, the directions Forma has, the last round sent and the answer.
export async function directionsDetail(db, id, {getCampaign, getEntry}) {
  const detail = await loadCampaignDetail(db, id);
  const campaign = detail.formaCampaignId ? await getCampaign(detail.formaCampaignId) : null;
  const available = campaign ? await directionsOf(campaign, getEntry) : [];
  const {data, error} = await db.from('deliveries').select('id, round, items, status, response').eq('campaign_request_id', id).eq('stage', 'directions').order('round', {ascending: false});
  if (error) fail(error);
  const last = (data || [])[0] || null;
  return {
    id, version: detail.version, status: detail.status, label: detail.label, name: detail.name, brand: detail.brand.name,
    canSend: detail.status === 'in_progress' && Boolean(campaign), round: (last?.round || 0) + 1, rebuildsLeft: detail.rebuildsLeft,
    lastRound: last ? {round: last.round, ids: (last.items?.directions || []).map(d => d.id), response: last.response || null} : null,
    available,
  };
}

export async function sendDirections(db, id, expectedVersion, picks, {getCampaign, getEntry, sentBy = null} = {}) {
  const row = await loadRow(db, id);
  if (row.version !== expectedVersion) throw new TransitionError('conflict', CONFLICT_MESSAGE);
  planCampaignTransition(row.status, {type: 'send_directions', items: {directions: [{id: 'a'}, {id: 'b'}, {id: 'c'}]}});   // status check first
  if (!row.forma_campaign_id) throw invalid('This request has no Forma campaign yet. Accept it first.', 409);
  const campaign = await getCampaign(row.forma_campaign_id);
  if (!campaign) throw invalid('The Forma campaign of this request is missing.', 409);
  const items = buildDirectionsSnapshot(await directionsOf(campaign, getEntry), picks);
  return applyCampaignTransition(db, id, expectedVersion, {type: 'send_directions', items, sentBy});
}

// ---------- the client's answer to a round of directions (stage 6) ----------
// The client approves one direction or asks for a rebuild, with comments (pins on the artboard or general ones).
// The studio reads them here; Forma turns them into a revision of the approved direction or the feedback for the
// next round, and the studio marks them resolved. Drafts stay the client's until they decide.

const third = (v, words) => words[Math.min(2, Math.floor(v * 3))];
// Where a pin sits, in words a designer (or a model) can act on: "top left", "centre"…
export function pinPlace(x, y) {
  if (x == null || y == null) return null;
  const v = third(y, ['top', 'middle', 'bottom']);
  const h = third(x, ['left', 'centre', 'right']);
  return v === 'middle' && h === 'centre' ? 'centre' : v === 'middle' ? `middle ${h}` : h === 'centre' ? `${v} centre` : `${v} ${h}`;
}

const commentView = c => ({
  id: c.id, itemId: c.item_id, number: c.number, body: c.body, scene: c.scene || null, format: c.format || null, lang: c.lang || null,
  x: c.x ?? null, y: c.y ?? null, place: pinPlace(c.x ?? null, c.y ?? null), state: c.state, resolvedNote: c.resolved_note || null, createdAt: c.created_at,
});

export async function responseDetail(db, id) {
  const detail = await loadCampaignDetail(db, id);
  const {data: rounds, error} = await db.from('deliveries').select('id, round, items, status, response, sent_at, responded_at')
    .eq('campaign_request_id', id).eq('stage', 'directions').order('round', {ascending: false});
  if (error) fail(error);
  const last = (rounds || [])[0] || null;
  if (!last) return {id, version: detail.version, status: detail.status, label: detail.label, brand: detail.brand.name, delivery: null, items: [], comments: []};
  const {data: rows, error: cErr} = await db.from('delivery_comments').select('*').eq('delivery_id', last.id).order('number', {ascending: true});
  if (cErr) fail(cErr);
  const comments = (rows || []).filter(c => c.state !== 'draft').map(commentView);
  const approvedId = last.response?.decision === 'approve' ? last.response.itemId : null;
  const items = (last.items?.directions || []).map(d => ({
    id: d.id, title: d.title, idea: d.idea, path: d.path, format: d.format, lang: d.lang, scenes: d.scenes || [], approved: d.id === approvedId,
  })).sort((a, b) => Number(b.approved) - Number(a.approved));
  return {
    id, version: detail.version, status: detail.status, label: detail.label, brand: detail.brand.name, rebuildsLeft: detail.rebuildsLeft,
    delivery: {id: last.id, round: last.round, status: last.status, sentAt: last.sent_at, respondedAt: last.responded_at || null, response: last.response || null},
    items, comments, open: comments.filter(c => c.state === 'sent').length,
  };
}

function commentLine(c, i) {
  const where = [c.place && `pinned ${c.place}`, c.scene && `scene ${c.scene}`, c.format && c.format.replace('x', ':'), c.lang].filter(Boolean).join(' · ');
  return `${i + 1}. ${c.body.replace(/\s+/g, ' ').trim()}${where ? ` (${where})` : ' (about the direction as a whole)'}`;
}

// The client's answer as notes for Forma: a revision of the approved direction, or the brief for a new round.
export function feedbackText(detail) {
  const response = detail.delivery?.response;
  if (!response) return '';
  const open = detail.comments.filter(c => c.state === 'sent');
  const on = id => open.filter(c => c.itemId === id);
  const lines = [];
  if (response.decision === 'approve') {
    const chosen = detail.items.find(d => d.approved);
    lines.push(`The client approved this direction${chosen ? ` (“${chosen.title}”)` : ''}. Apply their comments and keep everything they did not mention as it is.`);
    const mine = chosen ? on(chosen.id) : [];
    if (mine.length) lines.push('', 'Their comments on it:', ...mine.map(commentLine));
    for (const d of detail.items.filter(x => !x.approved && on(x.id).length)) {
      lines.push('', `On “${d.title}”, which they did not choose (they may want something from it):`, ...on(d.id).map(commentLine));
    }
    if (!open.length) lines.push('', 'They left no comments.');
  } else {
    lines.push(`The client asked for a new round of three directions${response.reason ? `. Their reason: “${response.reason}”` : ''}.`);
    for (const d of detail.items) {
      if (!on(d.id).length) continue;
      lines.push('', `On “${d.title}”${d.idea ? ` (${d.idea})` : ''}:`, ...on(d.id).map(commentLine));
    }
    lines.push('', 'Make three new directions that answer this. Keep what they liked; drop what they named.');
  }
  return lines.join('\n');
}

// Marks sent comments of the latest round as resolved by the studio (the guard trigger lets nothing else change).
export async function resolveComments(db, id, ids, note = '') {
  const detail = await responseDetail(db, id);
  if (!detail.delivery) throw invalid('Nothing was sent to the client yet.', 409);
  const open = new Set(detail.comments.filter(c => c.state === 'sent').map(c => c.id));
  const chosen = (Array.isArray(ids) ? ids : []).map(String).filter(x => open.has(x));
  if (!chosen.length) return detail;
  const {error} = await db.from('delivery_comments').update({state: 'resolved', resolved_note: String(note || '').trim().slice(0, 500) || null})
    .in('id', chosen).eq('delivery_id', detail.delivery.id).eq('state', 'sent');
  if (error) fail(error);
  return responseDetail(db, id);
}

// ---------- the final to the client (stage 7) ----------
// The final of the approved direction, as the dashboard's buildFinalSnapshot shapes it. Sent by hand, once: in the
// contract `delivered` is the end of the campaign.

const KINDS = ['poster', 'single', 'multi'];
const list = v => (Array.isArray(v) ? v : []);

// The final Forma has for the approved direction, and what stands in the way of sending it.
export async function finalOf(campaign, approvedItemId, getEntry, {setup = {}, title = ''} = {}) {
  const variant = (campaign?.variants || []).find(v => v.id === approvedItemId) || null;
  const problems = [];
  if (!variant) return {variant: null, final: null, problems: ['The approved direction is not in this Forma campaign any more.']};
  const entry = variant.final?.entryId ? await getEntry(variant.final.entryId) : null;
  const out = entry?.output || null;
  if (!out?.path) return {variant, final: null, problems: ['The approved direction has no final yet. Build it in step 3.']};
  const kind = KINDS.includes(out.kind) ? out.kind : KINDS.includes(setup.kind) ? setup.kind : 'single';
  const final = {
    id: variant.id, title: clientTitle(title) || clientTitle(variant.label) || 'Final', entryId: entry.id, path: out.path, kind,
    formats: list(out.formats).length ? list(out.formats) : list(setup.formats),
    langs: list(out.langs).length ? list(out.langs) : list(setup.languages).length ? list(setup.languages) : ['en'],
    lengths: kind === 'poster' ? [] : (list(out.lengths).length ? list(out.lengths) : list(setup.lengths)).map(Number),
  };
  if (!PATH_OK.test(final.path)) problems.push('The final has no valid preview path.');
  if (variant.final.stale) problems.push('The final is older than the latest preview or script. Build it again in step 3.');
  const missing = {
    formats: list(setup.formats).filter(f => !final.formats.includes(f)),
    langs: list(setup.languages).filter(l => !final.langs.includes(l)),
    lengths: kind === 'poster' ? [] : list(setup.lengths).map(Number).filter(n => !final.lengths.includes(n)),
  };
  const gaps = [missing.formats.length && 'formats ' + missing.formats.map(f => f.replace('x', ':')).join(', '),
    missing.langs.length && 'languages ' + missing.langs.join(', '), missing.lengths.length && 'lengths ' + missing.lengths.join(', ') + ' s'].filter(Boolean);
  if (gaps.length) problems.push('The final lacks what the client asked for: ' + gaps.join('; ') + '.');
  return {variant, final, problems};
}

export function buildFinalSnapshot(final, {title} = {}) {
  if (!final?.id || !final.entryId) throw new TransitionError('invalid', 'This campaign has no final yet.');
  if (!PATH_OK.test(final.path)) throw new TransitionError('invalid', 'The final has no valid preview path.');
  if (!final.formats.length) throw new TransitionError('invalid', 'The final has no formats.');
  const name = clientTitle(typeof title === 'string' && title.trim() ? title : final.title).slice(0, 80) || 'Final';
  return {final: {id: final.id, title: name, entryId: final.entryId, path: final.path, kind: final.kind,
    formats: final.formats, langs: final.langs.length ? final.langs : ['en'], lengths: final.kind === 'poster' ? [] : final.lengths}};
}

// The title the client knows: the one they approved in the last round.
async function approvedTitle(db, id, itemId) {
  const {data, error} = await db.from('deliveries').select('round, items').eq('campaign_request_id', id).eq('stage', 'directions').order('round', {ascending: false});
  if (error) fail(error);
  for (const d of data || []) {
    const hit = (d.items?.directions || []).find(x => x.id === itemId);
    if (hit) return hit.title || '';
  }
  return '';
}

export async function finalDetail(db, id, {getCampaign, getEntry}) {
  const row = await loadRow(db, id);
  const detail = await loadCampaignDetail(db, id);
  const campaign = row.forma_campaign_id ? await getCampaign(row.forma_campaign_id) : null;
  const title = row.approved_item_id ? await approvedTitle(db, id, row.approved_item_id) : '';
  const found = campaign && row.approved_item_id
    ? await finalOf(campaign, row.approved_item_id, getEntry, {setup: row.setup || {}, title})
    : {final: null, problems: [row.approved_item_id ? 'The Forma campaign of this request is missing.' : 'The client has not approved a direction yet.']};
  let open = 0;
  if (row.approved_item_id) {
    const answer = await responseDetail(db, id);
    open = answer.comments.filter(c => c.state === 'sent' && c.itemId === row.approved_item_id).length;
  }
  return {
    id, version: row.version, status: row.status, label: detail.label, name: detail.name, brand: detail.brand.name,
    canSend: row.status === 'in_production' && Boolean(found.final) && !found.problems.length,
    final: found.final, problems: found.problems, openComments: open,
  };
}

export async function sendFinal(db, id, expectedVersion, {title, getCampaign, getEntry, sentBy = null} = {}) {
  const row = await loadRow(db, id);
  if (row.version !== expectedVersion) throw new TransitionError('conflict', CONFLICT_MESSAGE);
  planCampaignTransition(row.status, {type: 'send_final', items: {final: {id: 'x'}}});   // status check first
  const campaign = row.forma_campaign_id ? await getCampaign(row.forma_campaign_id) : null;
  if (!campaign) throw invalid('The Forma campaign of this request is missing.', 409);
  const known = await approvedTitle(db, id, row.approved_item_id);
  const {final, problems} = await finalOf(campaign, row.approved_item_id, getEntry, {setup: row.setup || {}, title: known});
  if (problems.length) throw new TransitionError('invalid', problems[0]);
  return applyCampaignTransition(db, id, expectedVersion, {type: 'send_final', items: buildFinalSnapshot(final, {title}), sentBy});
}
