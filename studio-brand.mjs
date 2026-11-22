// Stage 3: an approved questionnaire becomes Forma brands, one per client_brands row (one brand, or one per agency
// client). Each gets the client's files (zips unpacked) and the hard answers as client decisions in BRAND-NOTES.md;
// Figma links in the answers are read too when FIGMA_TOKEN is set (figma.mjs); then the notes writer reads it all. The questionnaire itself is not a brand file: which answers reach the brand is
// decided in clientDecisions only. The Forma brand id is the client_brands id,
// so a retry after any failure finds what was already made instead of making it twice.
import path from 'node:path';
import {classifyProjectFile, streamToBuffer} from './store/supabase.mjs';
import {unzip} from './zip.mjs';
import {createBrandFromFiles, addFigmaFiles, notesAfterNewFiles, isJunkPath} from './brands.mjs';
import {readFigma, figmaToken, figmaLinksIn} from './figma.mjs';
import {normalizeState, scopedKey} from './studio-questionnaire.mjs';
import {DECIDE} from './shared/questionnaire-schema.mjs';

const MB = 2 ** 20;
export const LIMITS = {file: 128 * MB, zip: 512 * MB, unpacked: 1024 * MB};
const invalid = (message, status = 400) => Object.assign(Error(message), {status});
const fail = error => { throw Object.assign(Error(error.message || 'The database refused the request.'), {status: 502}); };

// ---------- hard answers: client decisions every step follows ----------

const lowerFirst = s => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

export function clientDecisions(rawState, scope = null) {
  const s = normalizeState(rawState);
  const get = id => s.a[scopedKey(scope, id)];
  const list = id => {
    const v = get(id);
    const items = (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(String).filter(x => x !== DECIDE);
    return items.map(o => (o === 'Other' ? String(get(id + '__other') || '').trim() : o)).filter(Boolean);
  };
  const one = id => list(id)[0] || null;
  const out = [];
  const avoid = list('v_avoid').filter(o => o !== 'Nothing in particular');
  if (avoid.length) out.push(`Never: ${avoid.map(lowerFirst).join(', ')}.`);
  const gen = list('v_gen');
  if (gen.includes('No generated images')) out.push('No generated images: pictures come from the client\'s own materials or are drawn in code.');
  else if (gen.length) out.push(`Generated images only for ${gen.map(lowerFirst).join(', ')}; nothing else is generated.`);
  const people = {
    'No people': 'No people on screen.',
    'Just hands and details': 'People only as hands and details, no faces.',
    'Yes, real people': 'Real people on screen are welcome.',
  }[one('v_people')];
  if (people) out.push(people);
  const colour = {
    'Only our brand colors': 'Colours: only the brand\'s own colours.',
    'Brand colors + natural colors': 'Colours: the brand\'s colours plus the natural colours of real scenes.',
  }[one('v_color')];
  if (colour) out.push(colour);
  if (one('v_humor') === 'No jokes') out.push('No jokes.');
  if (one('v_change') === 'Exactly like us') out.push('Stay exactly on the brand\'s current look.');
  if (scope && one('kp_strict') === 'By the book') out.push('The client\'s brand guide is followed by the book.');
  if (list('m_proof').includes('Nothing yet')) out.push('No proof points yet: never invent numbers, reviews, client names, awards or press.');
  else if (list('m_proof').length) out.push('Claims and proof: only what the client supplies; never invent numbers, reviews, client names or awards.');
  const legal = String(get('k_legal_note') || '').replace(/\s+/g, ' ').trim();
  if (one('k_legal') === 'Yes' && legal) out.push(`Market rules: ${legal}`);
  return out.map(d => d + ' (questionnaire)');
}

// ---------- the client's files ----------

function cleanPath(name) {
  return String(name).replace(/\\/g, '/').split('/').map(seg => seg.replace(/[\0-\x1f]/g, '').trim()).filter(seg => seg && seg !== '.' && seg !== '..').join('/');
}

function namer() {
  const files = new Set(), dirs = new Set();
  const taken = n => {
    const low = n.toLowerCase();
    if (files.has(low) || dirs.has(low)) return true;
    for (let d = path.posix.dirname(low); d !== '.'; d = path.posix.dirname(d)) if (files.has(d)) return true;
    return false;
  };
  return raw => {
    let name = cleanPath(raw);
    if (!name || isJunkPath(name)) return null;
    if (classifyProjectFile('assets/' + name) !== 'upload') name = 'files/' + name;   // e.g. a folder named "generated"
    if (classifyProjectFile('assets/' + name) !== 'upload') return null;
    const e = path.posix.extname(name), stem = name.slice(0, name.length - e.length);
    for (let i = 2; taken(name); i++) name = `${stem} (${i})${e}`;
    files.add(name.toLowerCase());
    for (let d = path.posix.dirname(name.toLowerCase()); d !== '.'; d = path.posix.dirname(d)) dirs.add(d);
    return name;
  };
}

// rows: client_files rows of one scope. Returns brand files [{name, bytes}] and what was left out, with why.
export async function collectClientFiles(blobs, rows, {limits = LIMITS, log = () => {}} = {}) {
  const items = [], skipped = [];
  const name = namer();
  const add = (raw, bytes) => { const n = name(raw); if (n) items.push({name: n, bytes}); };
  let unpacked = 0;
  for (const f of rows) {
    const zip = /\.zip$/i.test(f.name);
    if (Number(f.size) > (zip ? limits.zip : limits.file)) { skipped.push({name: f.name, reason: 'too large to copy; open it in the client\'s files'}); continue; }
    const body = await blobs.get(f.r2_key);
    if (!body) { skipped.push({name: f.name, reason: 'missing from storage'}); continue; }
    const buf = await streamToBuffer(body);
    if (!zip) { add(f.name, buf); continue; }
    try {
      const {entries, skipped: left} = unzip(buf, {maxEntry: limits.file, maxTotal: Math.max(0, limits.unpacked - unpacked)});
      const base = cleanPath(f.name.replace(/\.zip$/i, '')) || 'archive';
      const kept = entries.filter(e => !isJunkPath(cleanPath(e.name)));
      // An archive of one folder ("Brand kit/…") unpacks into one folder, not "Brand kit/Brand kit/…".
      const tops = new Set(kept.map(e => cleanPath(e.name).split('/')[0]));
      const strip = tops.size === 1 && kept.every(e => cleanPath(e.name).includes('/'));
      for (const e of kept) {
        const inner = cleanPath(e.name);
        add(base + '/' + (strip ? inner.split('/').slice(1).join('/') : inner), e.bytes);
        unpacked += e.bytes.length;
      }
      for (const l of left) skipped.push({name: `${f.name} → ${l.name}`, reason: l.reason});
      log(`Unpacked ${f.name}: ${kept.length} files`);
    } catch (err) {
      add(f.name, buf);
      skipped.push({name: f.name, reason: 'could not be unpacked (' + err.message + '); kept as the archive'});
    }
  }
  return {items, skipped};
}

// ---------- making the brands ----------

export async function createBrandsForQuestionnaire(db, blobs, questionnaireId, {provider = null, deps = {}, log = () => {}, figma = {}} = {}) {
  const token = figma.token ?? figmaToken();
  const one = async query => { const {data, error} = await query; if (error) fail(error); return data; };
  const row = await one(db.from('brand_questionnaires').select('*, client_accounts(name, kind, test)').eq('id', questionnaireId).maybeSingle());
  if (!row) throw invalid("We couldn't find that.", 404);
  if (row.status !== 'approved') throw invalid('Approve the questionnaire first.', 409);
  const [files, brands] = await Promise.all([
    one(db.from('client_files').select('id, scope, name, size, content_type, category, r2_key, status, created_at').eq('account_id', row.account_id).order('created_at', {ascending: true})),
    one(db.from('client_brands').select('id, name, questionnaire_scope, forma_brand_id').eq('account_id', row.account_id).order('created_at', {ascending: true})),
  ]);
  const state = normalizeState(row.state);
  const scopes = state.role === 'agency' ? new Set(state.clients.map(c => c.id)) : new Set([null]);
  const results = [];
  for (const b of brands || []) {
    const scope = b.questionnaire_scope || null;
    if (b.forma_brand_id) { results.push({clientBrandId: b.id, formaBrandId: b.forma_brand_id, created: false}); continue; }
    if (!scopes.has(scope)) { results.push({clientBrandId: b.id, error: 'This brand has no part in the questionnaire.'}); continue; }
    try {
      log(`Making the brand “${b.name}”`);
      const own = (files || []).filter(f => f.status === 'ready' && f.scope === (scope || 'brand') && String(f.r2_key || '').startsWith('clients/'));
      const {items, skipped} = await collectClientFiles(blobs, own, {log});
      const links = figmaLinksIn(state.a, scope);
      let brand = await createBrandFromFiles({
        id: b.id, name: b.name, files: items, decisions: clientDecisions(row.state, scope),
        // For the brand page only (the manifest is never a model's input): what was left out, the Figma links found.
        origin: {kind: 'questionnaire', questionnaireId, accountId: row.account_id, clientBrandId: b.id,
          ...(skipped.length ? {skipped} : {}), ...(links.length ? {figma: links} : {})},
      });
      const figmaReads = [];
      if (token) {
        for (const url of links.slice(0, 3)) {
          if ((brand.figma || []).some(f => f.url === url)) continue;
          try {
            const read = await readFigma(url, {token, fetchImpl: figma.fetchImpl, log});
            if (!read.files.length) { figmaReads.push({url, error: 'Nothing could be read from this file.'}); continue; }
            brand = await addFigmaFiles(brand.id, read);
            figmaReads.push({url, frames: read.frames});
          } catch (err) {
            log(`Figma ${url}: ${err.message}`);
            figmaReads.push({url, error: err.message});
          }
        }
      }
      const {error} = await db.from('client_brands').update({forma_brand_id: brand.id}).eq('id', b.id).is('forma_brand_id', null);
      if (error) fail(error);
      const notes = await notesAfterNewFiles(brand, provider, deps);
      results.push({clientBrandId: b.id, formaBrandId: brand.id, created: true, files: items.length, skipped: skipped.length, notes,
        ...(figmaReads.length ? {figma: figmaReads} : {})});
    } catch (err) {
      log(`Could not make “${b.name}”: ${err.message}`);
      results.push({clientBrandId: b.id, error: err.message});
    }
  }
  return results;
}

// Runs in the background after approval: copying a brand kit from R2 can take a while.
const runs = new Map();   // questionnaireId -> {status:'running'|'done'|'failed', error, results, at}
export const brandCreation = id => runs.get(id) || null;

export function startBrandCreation(db, blobs, questionnaireId, opts = {}) {
  const current = runs.get(questionnaireId);
  if (current?.status === 'running') return current;
  const run = {status: 'running', error: null, results: [], at: Date.now()};
  runs.set(questionnaireId, run);
  run.promise = createBrandsForQuestionnaire(db, blobs, questionnaireId, opts).then(results => {
    const failed = results.filter(r => r.error);
    Object.assign(run, {status: failed.length ? 'failed' : 'done', results, error: failed.length ? failed.map(r => r.error).join(' ') : null});
  }, err => Object.assign(run, {status: 'failed', error: err.message}));
  return run;
}
