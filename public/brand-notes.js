// Brand notes: one page per brand that every step reads first. Client decisions in it override the brief.
import {apiJson} from './campaign.js';
import {el} from './dom.js';

const path = id => '/api/brands/' + encodeURIComponent(id) + '/notes';
export const fetchBrandNotes = id => apiJson(path(id));
export const saveBrandNotes = (id, {text, version}) =>
  apiJson(path(id), {method: 'PUT', body: JSON.stringify({text, version})});
export const rewriteBrandNotes = (id, provider) =>
  apiJson(path(id), {method: 'POST', body: JSON.stringify({provider})});
export const decideQuestion = (id, question, decision) =>
  apiJson(path(id) + '/decide', {method: 'POST', body: JSON.stringify({question, decision})});
export const rememberDecision = (campaignId, text) =>
  apiJson('/api/campaigns/' + encodeURIComponent(campaignId) + '/remember', {method: 'POST', body: JSON.stringify({text})});

export function notesStatusText(n) {
  if (!n) return '';
  const base = {
    writing: 'Forma is reading the brand and writing the notes (usually 1–3 minutes). You can start a campaign meanwhile.',
    failed: 'Could not write the notes: ' + (n.error || 'unknown error') + (n.text ? ' The previous notes are kept.' : ''),
    missing: 'No notes yet. “Write notes” reads the brand files and writes them (1–3 minutes).',
    ready: n.source === 'edited' ? 'Edited by hand.' : n.source === 'supplied' ? 'Supplied with the brand files.'
      : 'Written by Forma from the brand files' + (n.model ? ' · ' + n.model : '') + (typeof n.cost === 'number' && n.cost > 0 ? ' · ≈ $' + n.cost.toFixed(2) + ' at API rates' : '') + '.',
  }[n.status] || '';
  return base + (n.outdated ? ' The brand files have changed since: consider “Rewrite”.' : '');
}

// Renders the notes' small Markdown subset (#, ##, ###, lists, **bold**, paragraphs) with DOM nodes only, never HTML.
function inline(parent, text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/);
  for (const part of parts) {
    if (/^\*\*[^*]+\*\*$/.test(part)) parent.append(el('strong', '', part.slice(2, -2)));
    else if (part) parent.append(document.createTextNode(part));
  }
  return parent;
}

export function renderNotes(text = '') {
  const frag = document.createDocumentFragment();
  let list = null, para = [];
  const flush = () => {
    if (para.length) frag.append(inline(el('p'), para.join(' ')));
    para = [];
  };
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (heading) {
      flush(); list = null;
      frag.append(inline(el(['h3', 'h4', 'h5'][heading[1].length - 1]), heading[2]));
    } else if (item) {
      flush();
      if (!list) { list = el('ul'); frag.append(list); }
      list.append(inline(el('li'), item[1]));
    } else if (!line.trim()) {
      flush(); list = null;
    } else {
      list = null;
      para.push(line.trim());
    }
  }
  flush();
  return frag;
}

// The notes without their open questions: those are shown apart, each with a place to answer it.
export const withoutOpenQuestions = (text = '') =>
  String(text).replace(/^##\s*Open questions\s*\n[\s\S]*?(?=^##\s|$(?![\s\S]))/m, '').trim();
