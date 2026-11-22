// Clients: the studio's inbox for the client dashboard (questionnaires and campaign requests).
// Data comes from /api/studio/* (studio.mjs): moderation of questionnaires, and the brands made from them.
import {$, el} from './dom.js';
import {openModal, button, busy, message, confirmAction} from './ui.js';

const TURNS = [
  {id: 'studio', label: 'Waiting for us'},
  {id: 'client', label: 'With the client'},
  {id: 'done', label: 'Done'},
];

const view = {status: null, inbox: null, turn: 'studio', includeTest: true, loading: false, error: '', timer: null,
  detail: null, detailId: null, detailKind: 'questionnaire', detailError: '', part: null, selected: new Set(), pending: [], busy: false,
  busyAction: null, flash: null, draft: ''};
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
// The inbox list is on screen (not a questionnaire or a campaign, not another page of Forma).
const inboxVisible = () => !view.detailId && !$('#clientsPage')?.hidden;
let onCount = () => {};
let onRoute = () => {};
let providerFor = () => null;   // app.js: the model settings, so the brand notes are written with the chosen model
let detailTimer = null;

// The address of what is on screen: /clients, /clients/questionnaires/<id> or /clients/campaigns/<id>.
export function clientsPath() {
  if (!view.detailId) return '/clients';
  return '/clients/' + (view.detailKind === 'campaign' ? 'campaigns/' : 'questionnaires/') + encodeURIComponent(view.detailId);
}

const KIND = {poster: 'Static poster', single: 'Single-scene video', multi: 'Multi-scene video'};
const formatLabel = id => (id === '191x1' ? '1.91:1' : String(id).replace('x', ':'));

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  if (s < 86400 * 7) return Math.round(s / 86400) + ' d ago';
  return new Date(iso).toLocaleDateString('en-GB', {day: 'numeric', month: 'short'});
}

async function getJSON(url) {
  const res = await fetch(url, {cache: 'no-store'});
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(Error(body.error || 'The request failed.'), {status: res.status});
  return body;
}

export async function loadStudioStatus({fresh = false} = {}) {
  view.status = await getJSON('/api/studio/status' + (fresh ? '?fresh=1' : '')).catch(err => ({enabled: false, reason: err.message}));
  // On the cloud store the button shows even when client work is off, so the page can say why (a missing migration…).
  $('#clientsOpen').hidden = !(view.status.enabled || view.status.cloud);
  $('#clientsOpen').classList.toggle('is-off', !view.status.enabled);
  return view.status;
}

// quiet: the 30-second refresh. It keeps the counter fresh and redraws only the inbox list, never a questionnaire or
// a campaign being read (that would lose the scroll, the selection and what is being typed).
async function loadInbox({quiet = false} = {}) {
  if (view.loading) return;
  view.loading = true;
  if (!quiet && inboxVisible()) renderClients();
  try {
    view.inbox = await getJSON('/api/studio/inbox?test=' + (view.includeTest ? '1' : '0'));
    view.error = '';
  } catch (err) {
    view.error = err.message;
  } finally {
    view.loading = false;
  }
  updateCount();
  if (inboxVisible()) renderClients();
}

function updateCount() {
  const n = view.inbox?.waiting || 0;
  const badge = $('#clientsCount');
  badge.textContent = n ? String(n) : '';
  $('#clientsOpen').classList.toggle('has-waiting', n > 0);
  $('#clientsOpen').title = n ? n + (n === 1 ? ' item waits' : ' items wait') + ' for the studio' : 'Clients';
  onCount(n);
}

// Called by app.js: keeps the counter fresh while the app is open (every 30 s, only when the studio is on).
export async function startClientsPolling({onWaiting} = {}) {
  if (onWaiting) onCount = onWaiting;
  const status = await loadStudioStatus();
  if (!status.enabled) return;
  await loadInbox();
  clearInterval(view.timer);
  view.timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    loadInbox({quiet: true});
    refreshDetailQuietly();
  }, 30000);
}

// parts: the path after /clients, e.g. ['questionnaires', '<id>']. onUrl: called when the address should change.
export async function openClientsPage(parts = [], {onUrl, provider} = {}) {
  if (onUrl) onRoute = onUrl;
  if (provider) providerFor = provider;
  if (!view.status?.enabled) {
    // Off before (the migration was missing, the database unreachable): look again, and start the counter if it is on now.
    const wasOff = Boolean(view.status);
    await loadStudioStatus({fresh: true});
    if (wasOff && view.status.enabled) startClientsPolling();
  }
  if (parts[0] === 'questionnaires' && parts[1]) return openQuestionnaire(parts[1], {push: false});
  if (parts[0] === 'campaigns' && parts[1]) return openCampaign(parts[1], {push: false});
  view.detailId = null;
  view.detail = null;
  renderClients();
  if (view.status?.enabled) await loadInbox();
}

// A questionnaire or campaign left open picks up the client's moves, unless the studio is in the middle of something
// there (typing, a selection, questions not sent yet, an action running, a dialog open).
async function refreshDetailQuietly() {
  const id = view.detailId;
  const idle = () => view.detailId === id && !view.busy && !view.selected.size && !view.pending.length
    && !document.querySelector('dialog[open]') && !document.activeElement?.matches?.('input, textarea, select') && !$('#clientsPage')?.hidden;
  if (!id || !view.detail || !idle()) return;
  const before = JSON.stringify(view.detail);
  try { await reloadDetail(id); } catch { return; }
  if (idle() && JSON.stringify(view.detail) !== before) renderClients();
}

function goInbox() {
  view.flash = null;
  view.detailId = null;
  view.detail = null;
  onRoute();
  renderClients();
  window.scrollTo(0, 0);
  loadInbox();
}

async function openQuestionnaire(id, {push = true} = {}) {
  if (view.detailId !== id) { view.selected = new Set(); view.pending = []; view.part = null; view.flash = null; view.draft = ''; }
  view.detailKind = 'questionnaire';
  view.detailId = id;
  view.detailError = '';
  if (view.detail?.id !== id) view.detail = null;
  if (push) onRoute();
  renderClients();
  window.scrollTo(0, 0);
  let detail = null, error = '';
  try { detail = await getJSON('/api/studio/questionnaires/' + encodeURIComponent(id)); } catch (err) { error = err.message; }
  if (view.detailId !== id || view.detailKind !== 'questionnaire') return;   // the studio moved on meanwhile
  view.detail = detail;
  view.detailError = error;
  renderClients();
  watchBrands();
}

async function postJSON(url, body) {
  const res = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json', 'x-forma': 'studio'}, body: JSON.stringify(body)});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(Error(data.error || 'The request failed.'), {status: res.status});
  return data;
}

// Runs one action of the page (accept, cancel, send questions…) with its button busy and the outcome in the flash.
// A conflict (someone moved it meanwhile) reloads what is on screen, so the next try starts from the latest state.
async function act(name, run, {done = '', reload = null} = {}) {
  if (view.busy) return false;
  view.busy = true;
  view.busyAction = name;
  view.flash = null;
  renderClients();
  let ok = false;
  try {
    await run();
    if (done) flash(done);
    ok = true;
  } catch (err) {
    if (err.status === 409 && reload) {
      await reload().catch(() => {});
      flash('Someone updated this meanwhile. This is the latest now: check it and try again.', true);
    } else flash(err.message, true);
  } finally {
    view.busy = false;
    view.busyAction = null;
    renderClients();
  }
  return ok;
}

// A page button that shows the spinner while its own action runs and is off while any other does.
function actionButton(label, cls, name, onClick) {
  const b = button(label, cls, onClick);
  b.disabled = view.busy;
  if (view.busyAction === name) busy(b);
  return b;
}

function tag(text, cls = '') {
  return el('span', 'client-tag' + (cls ? ' ' + cls : ''), text);
}

function questionnaireItem(q) {
  const li = el('li', 'client-item is-link turn-' + q.turn);
  li.tabIndex = 0;
  li.setAttribute('role', 'link');
  li.onclick = () => openQuestionnaire(q.id);
  li.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQuestionnaire(q.id); } };
  const head = el('div', 'client-item-head');
  head.append(el('strong', 'client-item-title', q.name), el('span', 'client-status', q.label));
  const meta = el('div', 'client-item-meta');
  meta.append(tag(q.kind === 'agency' ? 'Agency' + (q.clients ? ' · ' + q.clients + (q.clients === 1 ? ' client' : ' clients') : '') : 'Brand'));
  if (q.test) meta.append(tag('Test', 'is-test'));
  const time = q.status === 'approved' ? q.approvedAt : q.status === 'submitted' ? q.submittedAt : q.updatedAt;
  meta.append(el('time', 'client-time', (q.status === 'submitted' ? 'Sent ' : 'Updated ') + ago(time || q.updatedAt)));
  li.append(head, meta);
  return li;
}

async function openCampaign(id, {push = true} = {}) {
  if (view.detailId !== id) view.flash = null;
  view.detailKind = 'campaign';
  view.detailId = id;
  view.detailError = '';
  if (view.detail?.id !== id) view.detail = null;
  if (push) onRoute();
  renderClients();
  window.scrollTo(0, 0);
  let detail = null, error = '';
  try { detail = await getJSON('/api/studio/campaigns/' + encodeURIComponent(id)); } catch (err) { error = err.message; }
  if (view.detailId !== id || view.detailKind !== 'campaign') return;
  view.detail = detail;
  view.detailError = error;
  renderClients();
}

function campaignItem(c) {
  const li = el('li', 'client-item is-link turn-' + c.turn);
  li.tabIndex = 0;
  li.setAttribute('role', 'link');
  li.onclick = () => openCampaign(c.id);
  li.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCampaign(c.id); } };
  const head = el('div', 'client-item-head');
  head.append(el('strong', 'client-item-title', c.name), el('span', 'client-status', c.label));
  const sub = el('p', 'client-item-sub', [c.brand, KIND[c.kind] || '', c.formats.map(formatLabel).join(' '), c.languages.map(l => l.toUpperCase()).join(', '), c.kind !== 'poster' && c.lengths.length ? c.lengths.join(' / ') + ' s' : ''].filter(Boolean).join(' · '));
  const meta = el('div', 'client-item-meta');
  if (c.round) meta.append(tag('Round ' + c.round));
  if (c.status !== 'delivered' && c.status !== 'cancelled') meta.append(tag(c.rebuildsLeft + (c.rebuildsLeft === 1 ? ' rebuild left' : ' rebuilds left')));
  if (c.formaCampaignId) meta.append(tag('In Forma'));
  if (c.test) meta.append(tag('Test', 'is-test'));
  meta.append(el('time', 'client-time', (c.status === 'submitted' ? 'Requested ' : 'Updated ') + ago(c.status === 'submitted' ? c.createdAt : c.updatedAt)));
  li.append(head, sub, meta);
  return li;
}

function section(title, items, render, empty) {
  const box = el('section', 'client-section');
  const h = el('h2', 'collection-heading', title);
  if (items.length) h.append(el('span', 'client-count', String(items.length)));
  box.append(h);
  if (!items.length) box.append(el('p', 'library-empty', empty));
  else {
    const list = el('ul', 'client-list');
    for (const item of items) list.append(render(item));
    box.append(list);
  }
  return box;
}

export function renderClients() {
  const root = $('#clientsBody');
  if (!root) return;
  $('#clientsHead').hidden = Boolean(view.detailId);
  if (view.detailId && !(view.status && !view.status.enabled)) return view.detailKind === 'campaign' ? renderCampaign(root) : renderQuestionnaire(root);
  const status = view.status;
  if (status && !status.enabled) {
    root.replaceChildren(el('p', 'library-empty', status.reason || 'Client work is off.'));
    return;
  }
  const inbox = view.inbox;
  if (!inbox) {
    root.replaceChildren(el('p', 'library-empty', view.error || 'Loading clients…'));
    return;
  }
  const count = turn => inbox.questionnaires.filter(q => q.turn === turn).length + inbox.campaigns.filter(c => c.turn === turn).length;
  const tabs = el('div', 'chips client-tabs');
  tabs.setAttribute('role', 'tablist');
  for (const t of TURNS) {
    const b = el('button', '', t.label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-pressed', String(view.turn === t.id));
    b.setAttribute('aria-selected', String(view.turn === t.id));
    const n = count(t.id);
    if (n) b.append(el('small', '', String(n)));
    b.onclick = () => { view.turn = t.id; renderClients(); };
    tabs.append(b);
  }
  const testToggle = el('label', 'client-test-toggle');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = view.includeTest;
  box.onchange = () => { view.includeTest = box.checked; loadInbox(); };
  testToggle.append(box, document.createTextNode(' Show test accounts'));
  const toolbar = el('div', 'client-toolbar');
  toolbar.append(tabs, testToggle);

  const qs = inbox.questionnaires.filter(q => q.turn === view.turn);
  const cs = inbox.campaigns.filter(c => c.turn === view.turn);
  const emptyQ = {studio: 'No questionnaires waiting.', client: 'No questionnaires with clients.', done: 'No approved questionnaires yet.'}[view.turn];
  const emptyC = {studio: 'No campaigns waiting.', client: 'No campaigns with clients.', done: 'No finished campaigns yet.'}[view.turn];
  const main = el('div', 'client-main');
  main.append(section('Questionnaires', qs, questionnaireItem, emptyQ), section('Campaigns', cs, campaignItem, emptyC));

  const aside = el('aside', 'client-activity card');
  aside.append(el('h2', 'collection-heading', 'Activity'));
  if (!inbox.activity.length) aside.append(el('p', 'note', 'Nothing has happened yet.'));
  else {
    const list = el('ol', 'client-activity-list');
    for (const a of inbox.activity) {
      const li = el('li');
      // A line opens what it is about: the campaign request, or the account's questionnaire.
      const q = !a.campaignId ? inbox.questionnaires.find(x => x.accountId === a.accountId) : null;
      const open = a.campaignId ? () => openCampaign(a.campaignId) : q ? () => openQuestionnaire(q.id) : null;
      const text = open ? button(a.text, 'client-activity-link', open) : el('span', '', a.text);
      li.append(text, el('time', 'client-time', ago(a.at)));
      list.append(li);
    }
    aside.append(list);
  }
  const layout = el('div', 'client-layout');
  layout.append(main, aside);
  const note = el('p', 'note client-refresh', view.loading ? 'Refreshing…' : view.error ? view.error : 'Updates every 30 seconds.');
  root.replaceChildren(toolbar, layout, note);
}


// ---------- one questionnaire ----------

const MODE = {self: 'Filled in by the client', call: 'Pre-filled after our call', ai: 'Filled in with an AI assistant'};
// Where an answer came from, said once in the header and marked by a small sign on the answer.
const FLAG = {file: {sign: '✦', text: 'from their AI file'}, prefill: {sign: '◆', text: 'from our call'}};
const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;
const when = iso => (iso ? new Date(iso).toLocaleString('en-GB', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}) : '');
const size = n => (n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');

function valueNode(v) {
  switch (v.kind) {
    case 'text': return el('p', 'q-text', v.text);
    case 'list': {
      const box = el('div', 'q-chips');
      for (const item of v.items) box.append(el('span', 'q-chip' + (item === 'Up to you' ? ' is-decide' : ''), item));
      return box;
    }
    case 'rows': case 'links': {
      const list = el('ul', 'q-rows');
      for (const r of v.rows) {
        const li = el('li');
        if (v.kind === 'links' && /^https?:\/\//i.test(r.a)) {
          const a = el('a', '', r.a);
          a.href = r.a; a.target = '_blank'; a.rel = 'noopener noreferrer';
          li.append(a);
        } else li.append(el('strong', '', r.a + (r.star ? ' ★' : '')));
        if (r.b) li.append(el('span', '', ' — ' + r.b));
        list.append(li);
      }
      return list;
    }
    case 'pairs': {
      const box = el('div', 'q-pairs');
      for (const p of v.pairs) {
        const row = el('div', 'q-pair');
        const scale = el('span', 'q-scale');
        if (p.value === 'decide') scale.append(el('span', 'q-chip is-decide', 'Up to you'));
        else for (let i = 1; i <= 5; i++) scale.append(el('i', p.value === i ? 'is-on' : ''));
        row.append(el('span', 'q-pair-l', p.left), scale, el('span', 'q-pair-r', p.right));
        box.append(row);
      }
      return box;
    }
    default: return el('p', 'q-empty', 'Not answered');
  }
}

function noteNode(n, replies) {
  const box = el('div', 'q-note' + (n.resolvedAt ? ' is-resolved' : ''));
  box.append(el('p', 'q-note-meta', 'We asked' + (n.author ? ' · ' + n.author : '') + ' · ' + when(n.createdAt) + (n.resolvedAt ? ' · answered' : '')), el('p', '', n.body));
  for (const r of replies) {
    const reply = el('div', 'q-reply');
    reply.append(el('p', 'q-note-meta', 'Client replied · ' + when(r.createdAt)), el('p', '', r.body));
    box.append(reply);
  }
  return box;
}

function questionRow(q, d, canAsk) {
  const row = el('div', 'q-row' + (view.selected.has(q.key) ? ' is-selected' : '') + (canAsk ? ' is-selectable' : ''));
  row.id = 'q-' + q.key.replace(/[^\w-]/g, '_');
  const label = el('div', 'q-label');
  label.append(el('span', 'q-label-text', q.label));
  const flags = [];
  if (q.req && !q.answered) flags.push(el('span', 'q-flag is-warn', 'Missing'));
  if (q.unlocked) flags.push(el('span', 'q-flag is-open', 'Unlocked for the client'));
  if (q.flag) {
    const f = FLAG[q.flag] || {sign: '•', text: q.flag};
    const mark = el('span', 'q-flag is-source', f.sign);
    mark.title = 'Answer ' + f.text;
    mark.setAttribute('aria-label', 'Answer ' + f.text);
    label.querySelector('.q-label-text').append(' ', mark);
  }
  if (flags.length) { const line = el('span', 'q-flags'); line.append(...flags); label.append(line); }
  const body = el('div', 'q-value');
  body.append(valueNode(q.value));
  const replies = d.notes.filter(n => n.authorRole === 'client');
  for (const id of q.notes) {
    const n = d.notes.find(x => x.id === id);
    if (n) body.append(noteNode(n, replies.filter(r => r.replyTo === n.id)));
  }
  row.append(label, body);
  if (canAsk) {
    const box = el('input');
    box.type = 'checkbox';
    box.className = 'q-pick';
    box.checked = view.selected.has(q.key);
    box.setAttribute('aria-label', 'Ask about: ' + q.label);
    const toggle = () => {
      if (view.selected.has(q.key)) view.selected.delete(q.key); else view.selected.add(q.key);
      renderClients();
    };
    box.onclick = e => { e.stopPropagation(); toggle(); };
    row.onclick = e => { if (!e.target.closest('a')) toggle(); };
    row.prepend(box);
  }
  return row;
}

function filesNode(files) {
  const box = el('div', 'q-files');
  if (!files.length) { box.append(el('p', 'note', 'No files.')); return box; }
  const groups = new Map();
  for (const f of files) groups.set(f.category, [...(groups.get(f.category) || []), f]);
  const link = (f, cls) => {
    const a = el('a', cls);
    a.href = f.url; a.target = '_blank'; a.rel = 'noopener';
    a.title = f.name + ' · ' + size(f.size);
    return a;
  };
  for (const [cat, list] of groups) {
    const g = el('div', 'q-file-group');
    const h = el('h4', '', cat);
    h.append(el('span', 'client-count', String(list.length)));
    g.append(h);
    // Pictures as thumbnails; everything else as a line with its type: a wall of empty tiles helps no one.
    const pictures = list.filter(f => IMAGE.test(f.name));
    const others = list.filter(f => !IMAGE.test(f.name));
    if (pictures.length) {
      const grid = el('div', 'q-file-grid');
      for (const f of pictures) {
        const a = link(f, 'q-thumb');
        const img = el('img');
        img.src = f.url; img.alt = f.name; img.loading = 'lazy'; img.decoding = 'async';
        a.append(img);
        grid.append(a);
      }
      g.append(grid);
    }
    if (others.length) {
      const ul = el('ul', 'q-file-list');
      for (const f of others) {
        const li = el('li');
        const a = link(f, 'q-file');
        const ext = (f.name.includes('.') ? f.name.split('.').pop() : 'file').slice(0, 4).toUpperCase();
        a.append(el('span', 'q-file-ext', ext), el('span', 'q-file-name', f.name), el('span', 'q-file-size', size(f.size)));
        li.append(a);
        ul.append(li);
      }
      g.append(ul);
    }
    box.append(g);
  }
  return box;
}

function legalNode(l) {
  const box = el('div', 'q-legal');
  const sig = (title, s, own) => {
    const row = el('div', 'q-sig');
    row.append(el('strong', '', title), el('span', s ? 'is-ok' : 'is-miss', own ? 'They will send their own NDA' : s ? `Signed by ${s.by}${s.company ? ', ' + s.company : ''} · ${s.at}` : 'Not signed'));
    return row;
  };
  box.append(sig('NDA', l.nda, l.ndaOwn && !l.nda), sig('Terms & usage rights', l.terms));
  if (l.caseStudy) box.append(el('p', 'note', 'Allows showing the work as a case study.'));
  return box;
}

function askBar(d) {
  const bar = el('div', 'q-askbar card');
  const head = el('div', 'q-askbar-head');
  head.append(el('strong', '', view.pending.length ? view.pending.length + (view.pending.length === 1 ? ' question ready' : ' questions ready') : 'Ask the client'));
  head.append(el('span', 'note', view.selected.size ? view.selected.size + (view.selected.size === 1 ? ' answer selected' : ' answers selected') : 'Tick the answers a question is about.'));
  bar.append(head);
  for (const [i, p] of view.pending.entries()) {
    const row = el('div', 'q-pending');
    row.append(el('span', '', p.body), el('span', 'note', p.questionIds.length + (p.questionIds.length === 1 ? ' answer' : ' answers')));
    const rm = el('button', 'btn secondary small', 'Remove');
    rm.type = 'button';
    rm.onclick = () => { view.pending.splice(i, 1); renderClients(); };
    row.append(rm);
    bar.append(row);
  }
  const input = el('textarea');
  input.rows = 2;
  input.maxLength = 4000;
  input.placeholder = 'Your question about the selected answers…';
  input.id = 'qAskInput';
  input.value = view.draft || '';
  input.oninput = () => { view.draft = input.value; add.disabled = !input.value.trim() || !view.selected.size; };
  const add = el('button', 'btn secondary', 'Add question');
  add.type = 'button';
  add.disabled = !(view.draft || '').trim() || !view.selected.size;
  add.onclick = () => {
    view.pending.push({questionIds: [...view.selected], body: input.value.trim()});
    view.selected = new Set();
    view.draft = '';
    renderClients();
  };
  // ⌘/Ctrl+Enter adds the question, as in a chat.
  input.onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !add.disabled) { e.preventDefault(); add.click(); } };
  const send = actionButton(view.pending.length ? `Send ${view.pending.length} to the client` : 'Send to the client', 'btn primary', 'questions', async () => {
    const n = view.pending.length;
    const ok = await confirmAction({title: `Send ${plural(n, 'question', 'questions')}?`, confirm: 'Send',
      text: 'The client gets the questionnaire back with only these answers unlocked, and sees your questions next to them.'});
    if (!ok) return;
    await act('questions', async () => {
      setDetail(d.id, await postJSON('/api/studio/questionnaires/' + d.id + '/questions', {version: d.version, notes: view.pending}));
      view.pending = [];
      view.selected = new Set();
    }, {done: 'Questions sent. The client sees them in their dashboard.', reload: () => reloadDetail(d.id)});
  });
  if (!view.pending.length) send.disabled = true;
  const actions = el('div', 'q-askbar-actions');
  actions.append(add, send);
  bar.append(input, actions);
  return bar;
}

// What happened, oldest first: the client's moves and ours (client_events).
function timelineNode(items = []) {
  const box = el('section', 'card');
  box.append(el('h2', 'collection-heading', 'Timeline'));
  if (!items.length) { box.append(el('p', 'note', 'Nothing yet.')); return box; }
  const list = el('ol', 'client-timeline');
  for (const t of items) {
    const li = el('li', 'is-' + String(t.type).split('.')[0]);
    li.append(el('span', '', t.text), el('time', 'client-time', when(t.at)));
    list.append(li);
  }
  box.append(list);
  return box;
}

function flash(text, error = false) {
  const shown = {message: text, error};
  view.flash = shown;
  // Errors stay until the next action; good news fades after a few seconds.
  if (!error) setTimeout(() => { if (view.flash === shown) { view.flash = null; renderClients(); } }, 6000);
}

// What a request or an action returned, kept only while that questionnaire or campaign is still the one on screen.
function setDetail(id, detail) {
  if (view.detailId === id) view.detail = detail;
}

async function reloadDetail(id) {
  const path = view.detailKind === 'campaign' ? '/api/studio/campaigns/' : '/api/studio/questionnaires/';
  setDetail(id, await getJSON(path + encodeURIComponent(id)));
}

function flashNode() {
  if (!view.flash) return null;
  const p = el('p', 'q-flash' + (view.flash.error ? ' is-error' : ''), view.flash.message);
  p.setAttribute('role', view.flash.error ? 'alert' : 'status');
  return p;
}

function openApprove(d) {
  const m = openModal({key: 'approve:' + d.id, title: 'Approve the questionnaire'});
  if (!m) return;
  m.body.append(el('p', 'note', d.kind === 'agency'
    ? 'Each agency client becomes a brand in their dashboard and in Forma. Check the names: the client sees them as written here.'
    : 'The brand appears in their dashboard and in Forma, and they can start campaigns right after. Check the name: the client sees it as written here.'));
  const inputs = [];
  for (const b of d.brands) {
    const label = el('label', 'field');
    label.append(el('span', '', d.kind === 'agency' ? 'Client brand' : 'Brand name'));
    const input = el('input');
    input.type = 'text';
    input.maxLength = 160;
    input.value = b.name;
    input.required = true;
    inputs.push([b.questionnaire_scope || 'brand', input]);
    label.append(input);
    m.body.append(label);
  }
  const status = el('p', 'note modal-status');
  status.setAttribute('aria-live', 'polite');
  const ok = button('Approve', 'btn primary');
  const check = () => { ok.disabled = inputs.some(([, i]) => !i.value.trim()); };
  for (const [, i] of inputs) {
    i.oninput = check;
    i.onkeydown = e => { if (e.key === 'Enter' && !ok.disabled) { e.preventDefault(); ok.click(); } };
  }
  ok.onclick = async () => {
    busy(ok);
    message(status, '');
    try {
      setDetail(d.id, await postJSON('/api/studio/questionnaires/' + d.id + '/approve', {version: d.version, provider: providerFor(), names: Object.fromEntries(inputs.map(([k, i]) => [k, i.value.trim()]))}));
      m.close();
      flash('Approved. The client can start campaigns now; Forma is making the brand.');
      renderClients();
      watchBrands();
    } catch (err) {
      busy(ok, false);
      if (err.status === 409) {
        // Someone moved it meanwhile (the client edited, or another tab answered): show the latest instead.
        m.close();
        flash(err.message, true);
        await reloadDetail(d.id).catch(() => {});
        renderClients();
        return;
      }
      message(status, err.message, {error: true});
    }
  };
  m.foot.append(status, button('Cancel', 'btn secondary', m.close), ok);
  check();
  inputs[0]?.[1].focus();
  inputs[0]?.[1].select();
}

// While Forma makes the brands (studio-brand.mjs), the page asks every 3 s how it goes.
function watchBrands() {
  clearTimeout(detailTimer);
  const id = view.detailId;
  if (!id || view.detail?.formaBrands?.status !== 'running') return;
  detailTimer = setTimeout(async () => {
    if (view.detailId !== id) return;
    try { view.detail = await getJSON('/api/studio/questionnaires/' + encodeURIComponent(id)); } catch { /* the next look will tell */ }
    if (view.detailId !== id) return;
    renderClients();
    watchBrands();
  }, 3000);
}

function formaBrandsNode(d) {
  const fb = d.formaBrands;
  const box = el('section', 'card q-brands');
  box.append(el('h2', 'collection-heading', fb.items.length > 1 ? 'Brands in Forma' : 'Brand in Forma'));
  box.append(el('p', 'note', {
    running: 'Forma is copying the client’s files and unpacking archives. The brand notes are written after that, on the brand page.',
    done: 'Made from the questionnaire: the client’s files, and their hard answers as client decisions in the brand notes.',
    failed: 'Some brands could not be made: ' + (fb.error || 'unknown error'),
    pending: 'Not in Forma yet.',
  }[fb.status] || ''));
  const list = el('ul', 'q-brand-list');
  for (const b of fb.items) {
    const li = el('li');
    li.append(el('strong', '', b.name));
    if (b.formaBrandId) {
      const a = el('a', 'btn secondary small', 'Open in Forma →');
      a.href = '/brands/' + encodeURIComponent(b.formaBrandId);
      li.append(a);
      for (const f of b.figma || []) li.append(el('p', 'note q-brand-figma', f.error ? 'Figma not read: ' + f.error : 'Figma read: ' + f.frames + (f.frames === 1 ? ' frame' : ' frames')));
    } else {
      li.append(el('span', 'note', fb.status === 'running' ? 'Making…' : b.error || 'Not made yet'));
    }
    list.append(li);
  }
  box.append(list);
  if (fb.status === 'failed' || fb.status === 'pending') {
    const retry = actionButton(fb.status === 'failed' ? 'Try again' : 'Make the brand', 'btn primary small', 'brands', async () => {
      await act('brands', async () => {
        setDetail(d.id, await postJSON('/api/studio/questionnaires/' + d.id + '/brands', {provider: providerFor()}));
      });
      watchBrands();
    });
    box.append(retry);
  }
  return box;
}

function renderQuestionnaire(root) {
  const d = view.detail;
  const back = el('button', 'crumb q-back', '← Clients');
  back.type = 'button';
  back.onclick = goInbox;
  if (!d) {
    root.replaceChildren(back, el('p', 'library-empty', view.detailError || 'Loading the questionnaire…'));
    return;
  }
  const canAsk = d.status === 'submitted';
  const head = el('header', 'q-head');
  const titles = el('div');
  titles.append(el('h1', '', d.name));
  const meta = el('div', 'client-item-meta');
  meta.append(el('span', 'client-status', d.label));
  meta.append(el('span', 'client-tag', d.kind === 'agency' ? 'Agency · ' + (d.parts.length - 1) + (d.parts.length === 2 ? ' client' : ' clients') : 'Brand'));
  if (d.mode && MODE[d.mode]) meta.append(el('span', 'client-tag', MODE[d.mode]));
  if (d.test) meta.append(el('span', 'client-tag is-test', 'Test'));
  if (d.submittedAt) meta.append(el('time', 'client-time', 'Sent ' + when(d.submittedAt)));
  titles.append(meta);
  const actions = el('div', 'library-actions');
  if (canAsk) {
    const approve = actionButton('Approve…', 'btn primary', 'approve', () => openApprove(d));
    if (view.pending.length) { approve.disabled = true; approve.title = 'Send or remove your questions first'; }
    actions.append(approve);
  }
  head.append(titles, actions);

  const source = d.mode === 'ai' ? ' ✦ marks answers taken from their AI file.' : d.mode === 'call' ? ' ◆ marks answers we pre-filled after the call.' : '';
  const status = el('p', 'q-status note', ({
    submitted: 'Read it through. Click answers to ask about them, or approve.',
    changes_requested: 'Waiting for the client to answer. Only the unlocked answers can change.',
    approved: 'Approved' + (d.approvedAt ? ' ' + when(d.approvedAt) : '') + '.',
    draft: 'The client is still filling it in.',
  }[d.status] || '') + source);

  const tabs = el('div', 'chips q-parts');
  if (d.parts.length > 1) {
    if (!view.part || !d.parts.some(p => p.id === view.part)) view.part = d.parts[0].id;
    for (const p of d.parts) {
      const b = el('button', '', p.title);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(view.part === p.id));
      const missing = p.sections.reduce((n, s) => n + s.missing, 0);
      if (missing) b.append(el('small', '', missing + ' missing'));
      b.onclick = () => { view.part = p.id; renderClients(); };
      tabs.append(b);
    }
  }
  const part = d.parts.find(p => p.id === view.part) || d.parts[0];
  const main = el('div', 'q-main');
  for (const sec of part.sections) {
    const box = el('section', 'q-section card');
    const h = el('h2', 'collection-heading', sec.title);
    if (sec.missing) h.append(el('span', 'client-tag is-warn', sec.missing + ' missing'));
    box.append(h);
    if (!sec.questions.length) box.append(el('p', 'note', 'Nothing answered here.'));
    for (const q of sec.questions) box.append(questionRow(q, d, canAsk));
    if (sec.blankOptional) box.append(el('p', 'note', sec.blankOptional + ' optional ' + (sec.blankOptional === 1 ? 'question' : 'questions') + ' left blank.'));
    main.append(box);
  }

  const aside = el('aside', 'q-aside');
  const files = el('section', 'card');
  const filesHead = el('h2', 'collection-heading', 'Files');
  if (part.files.length) filesHead.append(el('span', 'client-count', String(part.files.length)));
  files.append(filesHead, filesNode(part.files));
  const legal = el('section', 'card');
  legal.append(el('h2', 'collection-heading', 'NDA & terms'), legalNode(d.legal));
  aside.append(files, legal);
  if (d.timeline) aside.append(timelineNode(d.timeline));
  const asked = d.notes.filter(n => n.authorRole === 'studio');
  if (asked.length) {
    const thread = el('section', 'card');
    thread.append(el('h2', 'collection-heading', 'Questions · ' + asked.length));
    const replies = d.notes.filter(n => n.authorRole === 'client');
    for (const n of asked) {
      const node = noteNode(n, replies.filter(r => r.replyTo === n.id));
      const first = n.questionIds[0];
      if (first) {
        node.classList.add('is-link');
        node.onclick = () => {
          const scope = first.includes(':') ? first.split(':')[0] : null;
          const target = d.parts.find(p => (p.scope || null) === scope) || d.parts[0];
          if (target.id !== view.part) { view.part = target.id; renderClients(); }
          document.getElementById('q-' + first.replace(/[^\w-]/g, '_'))?.scrollIntoView({behavior: 'smooth', block: 'center'});
        };
      }
      thread.append(node);
    }
    aside.append(thread);
  }
  const layout = el('div', 'q-layout');
  layout.append(main, aside);
  const nodes = [back, head, status];
  if (d.formaBrands) nodes.push(formaBrandsNode(d));
  if (view.flash) nodes.push(flashNode());
  if (d.parts.length > 1) nodes.push(tabs);
  nodes.push(layout);
  if (canAsk && (view.selected.size || view.pending.length)) nodes.push(askBar(d));
  const focused = document.activeElement?.id === 'qAskInput';
  root.replaceChildren(...nodes);
  if (focused) document.getElementById('qAskInput')?.focus();   // created on render, not in index.html
}

// ---------- a campaign request ----------

const LANG_NAMES = (() => { try { return new Intl.DisplayNames(['en'], {type: 'language'}); } catch { return null; } })();
const langLabel = code => { try { return LANG_NAMES?.of(code) || code; } catch { return code; } };

function infoRow(label, content) {
  const row = el('div', 'q-row');
  const l = el('div', 'q-label');
  l.append(el('span', '', label));
  const v = el('div', 'q-value');
  if (content instanceof Node) v.append(content); else v.append(el('p', 'q-text', content || '—'));
  row.append(l, v);
  return row;
}

const CAMPAIGN_STATUS = {
  submitted: 'Read the brief. Accepting makes the Forma campaign with this setup: the brief goes to the script step, the references into the project.',
  in_progress: 'In progress in Forma. Next: send three directions from the campaign page in Forma (“Send directions…”).',
  review_directions: 'Three directions are with the client.',
  in_production: 'The client approved a direction. Next: revise it with their comments, build the final and send it from the campaign page in Forma (“Send the final…”).',
  delivered: 'The final was delivered.',
  cancelled: 'Cancelled.',
};

function renderCampaign(root) {
  const d = view.detail;
  const back = el('button', 'crumb q-back', '← Clients');
  back.type = 'button';
  back.onclick = goInbox;
  if (!d) {
    root.replaceChildren(back, el('p', 'library-empty', view.detailError || 'Loading the campaign…'));
    return;
  }
  const head = el('header', 'q-head');
  const titles = el('div');
  titles.append(el('h1', '', d.name));
  const meta = el('div', 'client-item-meta');
  meta.append(el('span', 'client-status', d.label));
  meta.append(el('span', 'client-tag', d.kind === 'agency' ? d.brand.name + ' · via ' + d.account : d.brand.name));
  if (d.round) meta.append(el('span', 'client-tag', 'Round ' + d.round));
  if (d.canCancel) meta.append(el('span', 'client-tag', d.rebuildsLeft + (d.rebuildsLeft === 1 ? ' rebuild left' : ' rebuilds left')));
  if (d.test) meta.append(el('span', 'client-tag is-test', 'Test'));
  if (d.createdAt) meta.append(el('time', 'client-time', 'Requested ' + when(d.createdAt)));
  titles.append(meta);

  const actions = el('div', 'library-actions');
  if (d.canCancel) {
    actions.append(actionButton('Cancel campaign…', 'btn secondary is-danger', 'cancel', async () => {
      const ok = await confirmAction({title: `Cancel “${d.name}”?`, confirm: 'Cancel the campaign', cancel: 'Keep it', danger: true,
        text: 'The client sees it as cancelled, and it can’t be reopened. The Forma campaign stays as it is.'});
      if (!ok) return;
      await act('cancel', async () => {
        setDetail(d.id, await postJSON('/api/studio/campaigns/' + d.id + '/cancel', {version: d.version}));
      }, {done: 'Cancelled. The client sees it in their dashboard.', reload: () => reloadDetail(d.id)});
    }));
  }
  if (d.formaCampaignId) {
    const open = el('a', 'btn ' + (d.canAccept ? 'secondary' : 'primary'), 'Open in Forma →');
    open.href = '/campaigns/' + encodeURIComponent(d.formaCampaignId);
    actions.append(open);
  }
  if (d.canAccept) {
    const accept = actionButton('Accept', 'btn primary', 'accept', () => act('accept', async () => {
      const res = await postJSON('/api/studio/campaigns/' + d.id + '/accept', {version: d.version, provider: providerFor()});
      setDetail(d.id, res.detail);
    }, {done: 'Accepted. The campaign is in Forma with the client’s setup and brief.', reload: () => reloadDetail(d.id)}));
    if (!d.brand.formaBrandId) { accept.disabled = true; accept.title = 'The brand is not in Forma yet'; }
    actions.append(accept);
  }
  head.append(titles, actions);

  const nodes = [back, head, el('p', 'q-status note', CAMPAIGN_STATUS[d.status] || '')];
  if (d.canAccept && !d.brand.formaBrandId) nodes.push(el('p', 'q-flash is-error', 'This client’s brand is not in Forma yet. Open their questionnaire and use “Make the brand”, then accept.'));
  if (view.flash) nodes.push(flashNode());

  const b = d.brief;
  const want = el('section', 'q-section card');
  want.append(el('h2', 'collection-heading', 'What they want'));
  if (b.product) want.append(infoRow('The product or offer', b.product));
  want.append(infoRow('What to promote', b.promote));
  want.append(infoRow('The goal', b.goal));
  const offer = !b.offer ? '—' : b.offer === 'No offer' || b.offer === 'Up to you' ? b.offer : b.offer + (b.offerText ? ' · “' + b.offerText + '” (exact wording)' : '');
  want.append(infoRow('Offer', offer));
  want.append(infoRow('Button text', b.cta));
  if (b.links.length) {
    const ul = el('ul', 'q-rows');
    for (const l of b.links) {
      const li = el('li');
      const a = el('a', '', l.a);
      a.href = /^https?:\/\//i.test(l.a) ? l.a : 'https://' + l.a;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      li.append(a);
      if (l.b) li.append(document.createTextNode(' — ' + l.b));
      ul.append(li);
    }
    want.append(infoRow('Links', ul));
  }
  if (b.note) want.append(infoRow('Note', b.note));

  const s = d.setup;
  const make = el('section', 'q-section card');
  make.append(el('h2', 'collection-heading', 'What to make'));
  make.append(infoRow('Kind', KIND[s.kind] || s.kind));
  make.append(infoRow('Formats', (s.formats || []).map(formatLabel).join(', ')));
  make.append(infoRow('Languages', (s.languages || []).map(langLabel).join(', ')));
  if (s.kind !== 'poster') make.append(infoRow('Lengths', (s.lengths || []).map(n => n + ' s').join(', ')));

  const main = el('div', 'q-main');
  main.append(want, make);
  const aside = el('aside', 'q-aside');
  const refs = el('section', 'card');
  refs.append(el('h2', 'collection-heading', 'References' + (d.refs.length ? ' · ' + d.refs.length : '')), filesNode(d.refs));
  if (d.refsPending > 0) refs.append(el('p', 'note', d.refsPending + (d.refsPending === 1 ? ' file is' : ' files are') + ' still uploading or failed.'));
  aside.append(refs);
  if (d.deliveries.length) {
    const rounds = el('section', 'card');
    rounds.append(el('h2', 'collection-heading', 'Sent to the client'));
    const ul = el('ul', 'q-rows');
    for (const x of d.deliveries) {
      const answer = x.response ? (x.response.decision === 'approve' ? 'approved' : 'asked to rebuild' + (x.response.reason ? ': ' + x.response.reason : '')) : x.status === 'superseded' ? 'replaced' : 'waiting';
      ul.append(el('li', '', (x.stage === 'final' ? 'Final' : 'Directions, round ' + x.round) + ' · ' + when(x.sentAt) + ' · ' + answer));
    }
    rounds.append(ul);
    aside.append(rounds);
  }
  if (d.timeline) aside.append(timelineNode(d.timeline));
  const layout = el('div', 'q-layout');
  layout.append(main, aside);
  nodes.push(layout);
  root.replaceChildren(...nodes);
}
