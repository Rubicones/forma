// The brand book as people see it: the brand's files sorted into what an art director looks for first
// (colours, logos, type, pictures, video, documents). For the team only: no step and no model ever reads this.
import path from 'node:path';

export const BOARD_TEXT_LIMIT = 2 * 2 ** 20;   // colours are read from text files up to this size
const ext = name => path.posix.extname(name).toLowerCase();
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);
const FONT = new Set(['.ttf', '.otf', '.woff', '.woff2']);
const VIDEO = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const DOC = new Set(['.pdf']);
const TEXT = new Set(['.svg', '.css', '.scss', '.json', '.md', '.txt', '.html', '.xml', '.ase', '.js']);
const LOGO = /(^|[^a-z])(logo|logotype|wordmark|lockup|emblem|monogram|brandmark|symbol|mark)([^a-z]|$)/i;
export const isLogo = name => LOGO.test(path.posix.basename(name, ext(name)).replace(/[_\-.]+/g, ' ')) || /(^|\/)logos?\//i.test(name);

// Files the studio writes for the models: never counted as the client's materials.
export const SYSTEM_FILES = new Set(['BRAND-NOTES.md']);

export function boardGroup(name) {
  const e = ext(name);
  if (name.startsWith('figma/') && IMAGE.has(e)) return 'figma';
  if (IMAGE.has(e)) return isLogo(name) ? 'logos' : 'pictures';
  if (FONT.has(e)) return 'fonts';
  if (VIDEO.has(e)) return 'videos';
  if (DOC.has(e)) return 'documents';
  return 'other';
}

export const readsColours = name => TEXT.has(ext(name)) && !SYSTEM_FILES.has(name);

const short = hex => hex.length === 4 ? '#' + [...hex.slice(1)].map(c => c + c).join('') : hex;

// Hex colours named in the brand's own text files (tokens, CSS, SVG): the most used first, with where they appear.
export function extractColours(texts = [], {limit = 24} = {}) {
  const found = new Map();
  for (const {name, text} of texts) {
    const seen = new Set();
    for (const m of String(text).matchAll(/#(?:[0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-z])/gi)) {
      const hex = short(m[0].toLowerCase());
      const entry = found.get(hex) || {hex, count: 0, files: []};
      entry.count++;
      if (!seen.has(hex)) { seen.add(hex); entry.files.push(name); }
      found.set(hex, entry);
    }
  }
  return [...found.values()].sort((a, b) => b.files.length - a.files.length || b.count - a.count || a.hex.localeCompare(b.hex)).slice(0, limit);
}

export function buildBoard(brand, {colours = [], figmaConfigured = false} = {}) {
  const url = name => '/api/brands/' + encodeURIComponent(brand.id) + '/file?' + new URLSearchParams({v: String(brand.version), name});
  const groups = {figma: [], logos: [], pictures: [], fonts: [], videos: [], documents: [], other: []};
  for (const f of brand.files || []) {
    if (SYSTEM_FILES.has(f.name)) continue;
    groups[boardGroup(f.name)].push({name: f.name, url: url(f.name)});
  }
  for (const list of Object.values(groups)) list.sort((a, b) => a.name.localeCompare(b.name));
  const skipped = Array.isArray(brand.origin?.skipped) ? brand.origin.skipped : [];
  // Figma files: the ones read (still present in the brand) and the links from the questionnaire not read yet.
  const read = (brand.figma || []).filter(f => (brand.files || []).some(x => x.name.startsWith(f.folder + '/')));
  const links = (brand.origin?.figma || []).filter(url => !read.some(f => f.url === url));
  const figma = {configured: figmaConfigured,
    files: read.map(f => ({url: f.url, fileName: f.fileName, at: f.at, frames: f.frames, styles: f.styles, skipped: f.skipped || []})),
    links};
  return {brand: {id: brand.id, version: brand.version, name: brand.name}, groups, colours, skipped, figma};
}
