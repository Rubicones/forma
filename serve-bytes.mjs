// Serving whole files read from the blob store to the browser: byte ranges (a <video> seeks only when the server
// answers 206) and HEAD, plus a small in-memory cache so a video's many range requests read R2 once, not each time.
import {streamToBuffer} from './store/supabase.mjs';

const MB = 2 ** 20;

// Least recently used first out; only for keys whose bytes never change (content hashes, upload keys).
export function blobCache({maxBytes = 384 * MB, maxItem = 160 * MB} = {}) {
  const items = new Map();   // key -> Buffer, oldest first
  const loading = new Map(); // key -> Promise<Buffer|null>, so parallel ranges share one read
  let bytes = 0;
  const keep = (key, buf) => {
    if (buf.length > maxItem) return;
    items.set(key, buf);
    bytes += buf.length;
    for (const [k, b] of items) {
      if (bytes <= maxBytes) break;
      items.delete(k);
      bytes -= b.length;
    }
  };
  return {
    // load(): a readable stream or null (missing).
    async get(key, load) {
      const hit = items.get(key);
      if (hit) { items.delete(key); items.set(key, hit); return hit; }
      if (loading.has(key)) return loading.get(key);
      const p = (async () => {
        const body = await load();
        if (!body) return null;
        const buf = await streamToBuffer(body);
        keep(key, buf);
        return buf;
      })().finally(() => loading.delete(key));
      loading.set(key, p);
      return p;
    },
    get size() { return bytes; },
  };
}

// The range a request asks for: null (the whole file), {start, end}, or 'unsatisfiable'.
export function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start, end;
  if (!m[1]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  if (start > end || start >= size) return 'unsatisfiable';
  return {start, end};
}

// Sends buf (headers such as Content-Type are set by the caller), honouring Range and HEAD.
export function sendBytes(req, res, buf) {
  res.set('Accept-Ranges', 'bytes');
  const range = byteRange(req.headers.range, buf.length);
  if (range === 'unsatisfiable') return res.status(416).set('Content-Range', `bytes */${buf.length}`).end();
  const part = range ? buf.subarray(range.start, range.end + 1) : buf;
  if (range) res.status(206).set('Content-Range', `bytes ${range.start}-${range.end}/${buf.length}`);
  res.set('Content-Length', String(part.length));
  return req.method === 'HEAD' ? res.end() : res.end(part);
}
