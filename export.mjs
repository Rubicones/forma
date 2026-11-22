// Stage 8: the final as files the client downloads (contract §7). For each final delivery: a video per format ×
// language × length and a still per format × language (posters: stills only), rendered from the final's own page
// (render.mjs), stored in R2 under deliveries/<id>/exports/ and listed in delivery_exports. The dashboard shows
// pending rows as "being prepared" and offers ready ones for download.
// For now it runs where Forma runs: a worker looks for final deliveries with files missing (sent while Forma was
// off, or asked for again) and exports them one at a time. Moving Forma to the cloud moves the worker with it.
import {renderVideo, renderStill, findFfmpeg} from './render.mjs';

const fail = error => { throw Object.assign(Error(error.message || 'The client database refused the request.'), {status: 502}); };
const PATH_OK = /^\/p\/[0-9a-f-]{36}\/[^?#]+$/i;
export const MAX_ATTEMPTS = 2;

// The dashboard's expectedExports (campaign/final.ts): known before anything renders.
export function expectedExports(final) {
  const out = [];
  const langs = final?.langs?.length ? final.langs : ['en'];
  for (const format of final?.formats || []) {
    for (const lang of langs) {
      if (final.kind !== 'poster') for (const length of final.lengths || []) out.push({format, lang, length: Math.round(Number(length)), fileType: 'mp4'});
      out.push({format, lang, length: 0, fileType: 'png'});
    }
  }
  return out;
}

export const fileKey = f => `${f.format}|${f.lang}|${f.length}|${f.fileType ?? f.file_type}`;
export const exportKey = (deliveryId, f) => `deliveries/${deliveryId}/exports/${f.format}_${f.lang}_${f.length ? f.length + 's' : 'still'}.${f.fileType}`;
const row = (deliveryId, f, patch = {}) => ({delivery_id: deliveryId, format: f.format, lang: f.lang, length: f.length, file_type: f.fileType, r2_key: exportKey(deliveryId, f), ...patch});

// What one delivery still needs: files never made, left pending by a run that stopped, or failed (retried a little).
export function todo(expected, rows, {attempts = new Map(), all = false} = {}) {
  const byKey = new Map(rows.map(r => [fileKey(r), r]));
  return expected.filter(f => {
    if (all) return true;
    const r = byKey.get(fileKey(f));
    if (!r || r.status === 'pending') return true;
    return r.status === 'failed' && (attempts.get(fileKey(f)) || 0) < MAX_ATTEMPTS;
  });
}

const ATTEMPTS = new Map();   // deliveryId -> Map(fileKey -> tries) for this run of Forma
const state = new Map();      // deliveryId -> {status:'running'|'done'|'failed', done, total, current, error}
export const exportState = id => state.get(id) || null;

export async function exportDelivery({db, blobs, delivery, previewURL, all = false, log = () => {}, render = {renderVideo, renderStill}}) {
  const final = delivery.items?.final;
  if (!final?.path || !PATH_OK.test(final.path)) throw Object.assign(Error('This delivery has no valid final.'), {status: 409});
  const expected = expectedExports(final);
  const {data: rows, error} = await db.from('delivery_exports').select('*').eq('delivery_id', delivery.id);
  if (error) fail(error);
  const tries = ATTEMPTS.get(delivery.id) || new Map();
  ATTEMPTS.set(delivery.id, tries);
  const work = todo(expected, rows || [], {attempts: tries, all});
  const run = {status: 'running', done: 0, total: work.length, current: null, error: null, failed: 0};
  state.set(delivery.id, run);
  if (!work.length) { run.status = 'done'; return run; }
  // Pending rows first, so the client sees the whole delivery being prepared.
  const {error: upErr} = await db.from('delivery_exports').upsert(work.map(f => row(delivery.id, f, {status: 'pending', size: null, width: null, height: null})),
    {onConflict: 'delivery_id,format,lang,length,file_type'});
  if (upErr) fail(upErr);
  const url = String(previewURL || '').replace(/\/$/, '') + final.path;
  const ffmpeg = work.some(f => f.fileType === 'mp4') ? await findFfmpeg() : null;
  log(`Exporting ${work.length} files of “${final.title}”`);
  for (const f of work) {
    const label = `${f.format.replace('x', ':')} · ${f.lang}${f.length ? ' · ' + f.length + ' s' : ' · still'}`;
    run.current = label;
    try {
      const out = f.fileType === 'mp4'
        ? await render.renderVideo({url, format: f.format, lang: f.lang, length: f.length, ffmpeg})
        : await render.renderStill({url, format: f.format, lang: f.lang, length: final.kind === 'poster' ? 0 : Math.max(0, ...(final.lengths || [0]))});
      if (!out.bytes?.length) throw Error('The render came out empty.');
      const key = exportKey(delivery.id, f);
      await blobs.put(key, out.bytes, {contentType: f.fileType === 'mp4' ? 'video/mp4' : 'image/png'});
      const {error: e} = await db.from('delivery_exports').upsert(row(delivery.id, f, {status: 'ready', size: out.bytes.length, width: out.width, height: out.height}),
        {onConflict: 'delivery_id,format,lang,length,file_type'});
      if (e) fail(e);
      if (out.problems?.errors?.length) log(`${label}: the browser reported ${out.problems.errors[0].message}`);
    } catch (err) {
      run.failed++;
      tries.set(fileKey(f), (tries.get(fileKey(f)) || 0) + 1);
      log(`${label} failed: ${err.message}`);
      run.error = err.message;
      await db.from('delivery_exports').upsert(row(delivery.id, f, {status: 'failed'}), {onConflict: 'delivery_id,format,lang,length,file_type'});
      if (err.status === 503) break;   // no Chrome or no ffmpeg: every next file would fail the same way
    }
    run.done++;
  }
  run.current = null;
  run.status = run.failed ? 'failed' : 'done';
  log(`Export of “${final.title}”: ${run.done - run.failed} of ${run.total} files ready`);
  return run;
}

// The latest final delivery of every delivered campaign, with its files: what the worker looks at.
export async function finalsToExport(db) {
  const {data, error} = await db.from('deliveries').select('id, campaign_request_id, round, items, status, sent_at')
    .eq('stage', 'final').neq('status', 'superseded').order('sent_at', {ascending: false}).limit(50);
  if (error) fail(error);
  const latest = new Map();
  for (const d of data || []) if (!latest.has(d.campaign_request_id)) latest.set(d.campaign_request_id, d);
  const out = [];
  for (const d of latest.values()) {
    const {data: rows, error: e} = await db.from('delivery_exports').select('format, lang, length, file_type, status').eq('delivery_id', d.id);
    if (e) fail(e);
    if (todo(expectedExports(d.items?.final), rows || [], {attempts: ATTEMPTS.get(d.id)}).length) out.push(d);
  }
  return out;
}

// One export at a time, oldest request first. kick() runs a pass now (after a final is sent, or asked from the UI).
export function startExportWorker({getDb, blobs, previewURL, every = 60000, log = m => console.log('[export] ' + m)}) {
  let running = false, timer = null, again = false;
  const forced = new Set();
  const pass = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      const db = await getDb();
      if (!db) return;
      const list = (await finalsToExport(db)).reverse();
      const extra = [...forced].filter(id => !list.some(d => d.id === id));
      for (const id of extra) {
        const {data} = await db.from('deliveries').select('id, campaign_request_id, round, items, status, sent_at').eq('id', id).maybeSingle();
        if (data) list.push(data);
      }
      for (const d of list) {
        forced.delete(d.id);
        await exportDelivery({db, blobs, delivery: d, previewURL, log}).catch(err => {
          state.set(d.id, {status: 'failed', done: 0, total: 0, current: null, error: err.message, failed: 0});
          log(`Export failed: ${err.message}`);
        });
      }
    } catch (err) {
      log('Export pass failed: ' + err.message);
    } finally {
      running = false;
      if (again) { again = false; setTimeout(pass, 0); }
    }
  };
  timer = setInterval(pass, every);
  timer.unref?.();
  setTimeout(pass, 5000).unref?.();
  return {
    kick: (deliveryId, {retry = false} = {}) => {
      if (deliveryId && retry) { ATTEMPTS.delete(deliveryId); forced.add(deliveryId); }
      setTimeout(pass, 0);
    },
    stop: () => clearInterval(timer),
  };
}
