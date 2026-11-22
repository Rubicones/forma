// Reads a .zip held in memory, with nothing but node:zlib: stored and deflated entries, zip64 sizes and offsets.
// Encrypted entries, other compression methods and entries over the limits are listed in `skipped`, not thrown.
import {inflateRawSync} from 'node:zlib';

const MB = 2 ** 20;
const utf8 = new TextDecoder('utf-8', {fatal: true});

function entryName(bytes, flagged) {
  if (flagged) return Buffer.from(bytes).toString('utf8');
  // Many archivers write UTF-8 names without setting the flag; older ones write CP437, read here as Latin-1.
  try { return utf8.decode(bytes); } catch { return Buffer.from(bytes).toString('latin1'); }
}

function zip64Extra(buf, start, end, need) {
  for (let p = start; p + 4 <= end;) {
    const id = buf.readUInt16LE(p), len = buf.readUInt16LE(p + 2);
    if (id === 0x0001) {
      let q = p + 4;
      const out = {};
      for (const key of need) { if (q + 8 > p + 4 + len) break; out[key] = Number(buf.readBigUInt64LE(q)); q += 8; }
      return out;
    }
    p += 4 + len;
  }
  return {};
}

export function unzip(buf, {maxEntry = 128 * MB, maxTotal = 1024 * MB, maxFiles = 5000} = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw Error('Not a zip file.');
  let eocd = -1;
  for (let i = buf.length - 22, min = Math.max(0, buf.length - 65557); i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Error('Not a zip file.');
  let count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if ((count === 0xffff || offset === 0xffffffff) && eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z = Number(buf.readBigUInt64LE(eocd - 20 + 8));
    if (z + 56 <= buf.length && buf.readUInt32LE(z) === 0x06064b50) {
      count = Number(buf.readBigUInt64LE(z + 32));
      offset = Number(buf.readBigUInt64LE(z + 48));
    }
  }
  const entries = [], skipped = [];
  let total = 0;
  let p = offset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw Error('The zip file is damaged.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    let local = buf.readUInt32LE(p + 42);
    const name = entryName(buf.subarray(p + 46, p + 46 + nameLen), flags & 0x800).replace(/\\/g, '/');
    const need = [size === 0xffffffff && 'size', compSize === 0xffffffff && 'compSize', local === 0xffffffff && 'local'].filter(Boolean);
    if (need.length) {
      const z = zip64Extra(buf, p + 46 + nameLen, p + 46 + nameLen + extraLen, need);
      size = z.size ?? size; compSize = z.compSize ?? compSize; local = z.local ?? local;
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (entries.length >= maxFiles) { skipped.push({name, reason: 'too many files in the archive'}); continue; }
    if (flags & 1) { skipped.push({name, reason: 'password-protected'}); continue; }
    if (method !== 0 && method !== 8) { skipped.push({name, reason: 'unsupported compression'}); continue; }
    if (size > maxEntry) { skipped.push({name, reason: 'too large'}); continue; }
    if (total + size > maxTotal) { skipped.push({name, reason: 'the archive is too large to unpack whole'}); continue; }
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) { skipped.push({name, reason: 'damaged'}); continue; }
    const data = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(data, data + compSize);
    let bytes;
    try {
      bytes = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, {maxOutputLength: maxEntry});
    } catch {
      skipped.push({name, reason: 'damaged'});
      continue;
    }
    total += bytes.length;
    entries.push({name, bytes});
  }
  return {entries, skipped};
}
