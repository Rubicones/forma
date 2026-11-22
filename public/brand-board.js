// The brand book board on the brand page: everything in the brand at a glance, for the team (art directors first).
// It is a view for people only; no step and no model reads it (brand-board.mjs on the server).
import {apiJson} from './campaign.js';
import {el} from './dom.js';
import {message} from './ui.js';

export const fetchBoard = id => apiJson('/api/brands/' + encodeURIComponent(id) + '/board');

const NAMES = {figma: ['Figma frame', 'Figma frames'], logos: ['logo', 'logos'], pictures: ['picture', 'pictures'], fonts: ['typeface', 'typefaces'],
  videos: ['video', 'videos'], documents: ['PDF', 'PDFs'], other: ['other file', 'other files']};
const count = (n, [one, many]) => n + ' ' + (n === 1 ? one : many);
const base = name => String(name).split('/').pop();

export function boardSummary(board) {
  const parts = [];
  if (board.colours.length) parts.push(count(board.colours.length, ['colour', 'colours']));
  for (const [key, list] of Object.entries(board.groups)) if (list.length) parts.push(count(list.length, NAMES[key]));
  const unread = board.figma?.links?.length || 0;
  if (unread) parts.push(count(unread, ['Figma link', 'Figma links']) + ' from the questionnaire not read yet');
  return parts.join(' · ') || 'No brand files yet.';
}

function section(title, n, body, extra) {
  const box = el('section', 'board-section');
  const head = el('div', 'board-section-head');
  head.append(el('h3', '', title), el('span', 'pill', String(n)));
  if (extra) head.append(extra);
  box.append(head, body);
  return box;
}

function swatches(colours) {
  const grid = el('div', 'board-swatches');
  for (const c of colours) {
    const b = el('button', 'board-swatch');
    b.type = 'button';
    b.title = 'Copy ' + c.hex + ' · in ' + c.files.join(', ');
    const chip = el('span', 'board-swatch-chip');
    chip.style.background = c.hex;
    const label = el('span', 'board-swatch-hex', c.hex);
    b.append(chip, label, el('small', '', count(c.files.length, ['file', 'files'])));
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(c.hex); label.textContent = 'Copied'; } catch { label.textContent = c.hex; }
      setTimeout(() => { label.textContent = c.hex; }, 1200);
    };
    grid.append(b);
  }
  return grid;
}

function tiles(list, cls) {
  const grid = el('div', 'board-grid ' + cls);
  for (const f of list) {
    const a = el('a', 'board-tile');
    a.href = f.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = f.name;
    const img = el('img');
    img.src = f.url;
    img.alt = f.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    a.append(img, el('span', 'board-caption', base(f.name)));
    grid.append(a);
  }
  return grid;
}

function logoBackgrounds(grid) {
  const chips = el('div', 'chips small board-bg');
  for (const [id, label] of [['light', 'Light'], ['dark', 'Dark'], ['check', 'Transparent']]) {
    const b = el('button', '', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(id === 'light'));
    b.onclick = () => {
      grid.dataset.bg = id;
      for (const x of chips.children) x.setAttribute('aria-pressed', String(x === b));
    };
    chips.append(b);
  }
  grid.dataset.bg = 'light';
  return chips;
}

let fontSeq = 0;
function fonts(list, brandName) {
  const wrap = el('div', 'board-fonts');
  for (const f of list) {
    const family = 'forma-board-' + (++fontSeq);
    const card = el('div', 'board-font');
    const name = el('div', 'board-font-name');
    const link = el('a', '', base(f.name));
    link.href = f.url + '&download=1';
    name.append(link);
    const big = el('div', 'board-font-big', 'Aa');
    const line = el('div', 'board-font-line', brandName || 'The quick brown fox jumps over the lazy dog');
    const chars = el('div', 'board-font-chars', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 € $ % & ?!');
    for (const n of [big, line, chars]) n.style.fontFamily = `"${family}", var(--sans)`;
    card.append(name, big, line, chars);
    try {
      new FontFace(family, `url("${f.url}")`).load()
        .then(face => document.fonts.add(face))
        .catch(() => card.append(el('p', 'note', 'This font file could not be loaded in the browser.')));
    } catch {
      card.append(el('p', 'note', 'This font file could not be loaded in the browser.'));
    }
    wrap.append(card);
  }
  return wrap;
}

function videos(list) {
  const grid = el('div', 'board-grid board-videos');
  for (const f of list) {
    const box = el('figure', 'board-tile');
    const v = el('video');
    v.src = f.url;
    v.controls = true;
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    box.append(v, el('figcaption', 'board-caption', base(f.name)));
    grid.append(box);
  }
  return grid;
}

function documents(list) {
  const wrap = el('div', 'board-docs');
  list.forEach((f, i) => {
    const card = el('div', 'board-doc');
    const head = el('div', 'board-doc-head');
    const open = el('a', 'btn secondary small', 'Open');
    open.href = f.url;
    open.target = '_blank';
    open.rel = 'noopener';
    head.append(el('strong', '', base(f.name)), open);
    card.append(head);
    // The browser's own PDF viewer, page by page. Only the first few open at once, to keep the page light.
    const frame = () => {
      const iframe = el('iframe');
      iframe.src = f.url + '#view=FitH';
      iframe.title = f.name;
      iframe.loading = 'lazy';
      return iframe;
    };
    if (i < 3) card.append(frame());
    else {
      const show = el('button', 'link', 'Show the pages');
      show.type = 'button';
      show.onclick = () => show.replaceWith(frame());
      card.append(show);
    }
    wrap.append(card);
  });
  return wrap;
}

function others(list) {
  const ul = el('ul', 'board-others');
  for (const f of list) {
    const li = el('li');
    const a = el('a', '', f.name);
    a.href = f.url + '&download=1';
    li.append(a);
    ul.append(li);
  }
  return ul;
}

export function renderBoard(board) {
  const frag = document.createDocumentFragment();
  const g = board.groups;
  if (board.colours.length) {
    const s = section('Colours', board.colours.length, swatches(board.colours));
    s.append(el('p', 'note', 'Hex values found in the brand’s own files (tokens, CSS, SVG), the most widely used first. Click to copy.'));
    frag.append(s);
  }
  if (g.figma.length) frag.append(section('From Figma', g.figma.length, tiles(g.figma, 'board-pictures')));
  if (g.logos.length) {
    const grid = tiles(g.logos, 'board-logos');
    frag.append(section('Logos', g.logos.length, grid, logoBackgrounds(grid)));
  }
  if (g.fonts.length) frag.append(section('Typefaces', g.fonts.length, fonts(g.fonts, board.brand.name)));
  if (g.pictures.length) frag.append(section('Pictures', g.pictures.length, tiles(g.pictures, 'board-pictures')));
  if (g.videos.length) frag.append(section('Video', g.videos.length, videos(g.videos)));
  if (g.documents.length) frag.append(section('Brand book and documents', g.documents.length, documents(g.documents)));
  if (g.other.length) frag.append(section('Other files', g.other.length, others(g.other)));
  if (board.skipped.length) {
    const ul = el('ul', 'board-others');
    for (const x of board.skipped) ul.append(el('li', '', x.name + ': ' + x.reason));
    frag.append(section('Not copied from the client’s files', board.skipped.length, ul));
  }
  if (!frag.childNodes.length) frag.append(el('p', 'note', 'No brand files yet.'));
  return frag;
}

// "Read Figma" (figma.mjs): the frames and styles of a client's Figma file become brand files, read through the
// Figma API with the studio's token. onRead(result) lets the brand page refresh what changed.
export function figmaPanel(board, {provider = () => null, onRead = () => {}} = {}) {
  const f = board.figma || {configured: false, files: [], links: []};
  const box = el('div', 'board-figma-box');
  const head = el('div', 'board-section-head');
  head.append(el('h3', '', 'Figma'));
  if (f.files.length) head.append(el('span', 'pill', String(f.files.length)));
  box.append(head);
  const status = el('p', 'note');
  status.setAttribute('aria-live', 'polite');
  let busy = false;
  const buttons = [];
  const read = async (url, button) => {
    if (busy || !url) return;
    busy = true;
    for (const b of buttons) b.disabled = true;
    button.classList.add('is-loading');
    message(status, 'Reading the Figma file: frames and styles (up to a minute)…');
    try {
      const result = await apiJson('/api/brands/' + encodeURIComponent(board.brand.id) + '/figma', {
        method: 'POST', body: JSON.stringify({url, provider: provider()}),
      });
      const r = result.read;
      const parts = [`Read “${r.fileName}”: ${count(r.frames, ['frame', 'frames'])}` + (r.styles ? `, ${count(r.styles, ['style', 'styles'])}` : '') + '.'];
      if (r.skipped.length) parts.push(count(r.skipped.length, ['frame', 'frames']) + ' left out (see the list in the brand book).');
      parts.push({writing: 'Forma is writing the brand notes now.', outdated: 'The brand notes were written before: rewrite them to take Figma in.',
        missing: 'Write the brand notes when ready.'}[result.notes] || '');
      busy = false;
      onRead(result, parts.filter(Boolean).join(' '));
    } catch (err) {
      busy = false;
      for (const b of buttons) b.disabled = !f.configured;
      button.classList.remove('is-loading');
      message(status, err.message, {error: true});
    }
  };
  const action = (label, url, cls = 'btn secondary small') => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.disabled = !f.configured;
    b.onclick = () => read(typeof url === 'function' ? url() : url, b);
    buttons.push(b);
    return b;
  };
  const list = el('ul', 'board-figma-list');
  for (const file of f.files) {
    const li = el('li');
    const a = el('a', '', file.fileName || file.url);
    a.href = file.url;
    a.target = '_blank';
    a.rel = 'noopener';
    li.append(a, el('span', 'note', count(file.frames, ['frame', 'frames']) +
      (file.at ? ' · read ' + new Date(file.at).toLocaleDateString('en-GB', {day: 'numeric', month: 'short'}) : '')), action('Read again', file.url));
    if (file.skipped.length) {
      const d = el('details', 'board-figma-skipped');
      d.append(el('summary', '', count(file.skipped.length, ['left out', 'left out'])));
      const ul = el('ul');
      for (const s of file.skipped) ul.append(el('li', '', s.name + ': ' + s.reason));
      d.append(ul);
      li.append(d);
    }
    list.append(li);
  }
  for (const url of f.links) {
    const li = el('li');
    const a = el('a', '', url);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    li.append(a, el('span', 'note', 'from the questionnaire, not read yet'), action('Read', url, 'btn primary small'));
    list.append(li);
  }
  const form = el('form', 'board-figma-form');
  const input = el('input');
  input.type = 'url';
  input.placeholder = 'https://www.figma.com/design/…';
  input.setAttribute('aria-label', 'Figma file link');
  input.disabled = !f.configured;
  const go = action('Read Figma', () => input.value.trim(), 'btn secondary small');
  go.type = 'submit';
  go.onclick = null;
  form.onsubmit = e => { e.preventDefault(); if (input.value.trim()) read(input.value.trim(), go); else input.focus(); };
  form.append(input, go);
  if (list.childElementCount) box.append(list);
  if (f.configured) box.append(form);
  box.append(el('p', 'note', f.configured
    ? 'A file, a page or a frame link. Frames come in as pictures, styles with exact values. The client shares the file with the studio’s Figma account; a file in a free Figma team must be duplicated into the studio’s team first.'
    : 'Reading Figma needs FIGMA_TOKEN in .env: a personal access token (scope file_content:read) from the studio’s Figma account with a Dev or Full seat on a paid plan.'));
  box.append(status);
  return box;
}
