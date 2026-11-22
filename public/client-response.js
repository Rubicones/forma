// The client's answer to a round of directions: approve one or rebuild, with comments pinned on the artboard.
// Pins are drawn over the same preview the client looked at; the comments become Forma's notes (a revision of the
// approved direction, or the feedback for three new directions) and are marked resolved (studio-campaign.mjs).
// The dialog is built once: picking a comment moves the preview and the focus, never the notes being edited.
import {apiJson} from './campaign.js';
import {el} from './dom.js';
import {openModal, button, busy, message} from './ui.js';

const FRAME_W = 360;
const when = iso => (iso ? new Date(iso).toLocaleString('en-GB', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}) : '');
const formatLabel = id => (id === '191x1' ? '1.91:1' : String(id || '').replace('x', ':'));
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

export async function openClientResponse(requestId, {onUseComments = () => {}, onUseRebuild = () => {}} = {}) {
  const base = '/api/studio/campaigns/' + encodeURIComponent(requestId);
  const m = openModal({key: 'client-response:' + requestId, className: 'is-xwide response-dialog', title: 'The client’s answer', backdropClose: false});
  if (!m) return;
  m.body.append(el('p', 'modal-loading', 'Loading the client’s answer…'));
  let data;
  try {
    data = await apiJson(base + '/response');
  } catch (err) {
    m.body.replaceChildren(el('p', 'q-flash is-error', err.message));
    m.foot.replaceChildren(button('Close', 'btn secondary', m.close));
    return;
  }
  if (!m.dialog.isConnected) return;

  const d = data.delivery;
  if (!d) {
    m.body.replaceChildren(el('p', 'note', 'Nothing was sent to the client yet.'));
    m.foot.replaceChildren(button('Close', 'btn secondary', m.close));
    return;
  }
  const r = d.response;
  const chosen = data.items.find(i => i.approved);
  m.setTitle(`Round ${d.round} · ` + (!r ? 'with the client' : r.decision === 'approve' ? `approved “${chosen?.title || 'a direction'}”` : 'rebuild requested'));
  const sub = el('p', 'note', (r ? 'Answered ' + when(d.respondedAt) : 'Sent ' + when(d.sentAt) + '. Their comments appear here when they decide.') +
    (r?.reason ? ` · Their reason: “${r.reason}”` : '') + (r?.decision === 'rebuild' ? ` · ${plural(data.rebuildsLeft, 'rebuild', 'rebuilds')} left` : ''));
  if (!r) {
    m.body.replaceChildren(sub);
    m.foot.replaceChildren(button('Close', 'btn secondary', m.close));
    return;
  }

  // ---- what is looked at: one direction, at one format, language and scene ----
  const first = chosen || data.items[0];
  const view = {itemId: first?.id, format: first?.format, lang: first?.lang, scene: first?.scenes[0] || null, focus: null};
  const itemOf = () => data.items.find(i => i.id === view.itemId) || data.items[0];
  const pinsOf = itemId => {
    // The dashboard's numbering: pins 1…n in their order, general comments apart.
    let n = 0;
    return data.comments.filter(c => c.itemId === itemId).sort((a, b) => a.number - b.number).map(c => ({...c, n: c.x != null ? ++n : null}));
  };

  const tabs = el('div', 'chips small');
  tabs.setAttribute('aria-label', 'Directions');
  const frameBox = el('div', 'response-frame');
  const iframe = el('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.tabIndex = -1;
  const pins = el('div', 'response-pins');
  frameBox.append(iframe, pins);
  const caption = el('p', 'note');
  const scenes = el('div', 'chips small');
  scenes.setAttribute('aria-label', 'Scenes');
  const stage = el('div', 'response-stage');
  stage.append(tabs, frameBox, caption, scenes);
  const list = el('div', 'response-list');
  let shownSrc = '';

  const drawStage = () => {
    const item = itemOf();
    tabs.replaceChildren(...data.items.map(i => {
      const b = button(i.title, '');
      b.setAttribute('aria-pressed', String(i.id === item.id));
      const n = data.comments.filter(c => c.itemId === i.id).length;
      if (n) b.append(el('small', '', String(n)));
      b.onclick = () => look(i);
      return b;
    }));
    const fmt = data.formats[view.format] || data.formats[item.format] || {w: 1080, h: 1080};
    const scale = FRAME_W / fmt.w;
    frameBox.style.width = FRAME_W + 'px';
    frameBox.style.height = Math.round(fmt.h * scale) + 'px';
    const q = new URLSearchParams({f: view.format, l: view.lang});
    if (view.scene) q.set('scene', view.scene);
    const src = item.url + '?' + q + '&paused';
    if (src !== shownSrc) {   // only a different view loads the preview again
      shownSrc = src;
      iframe.src = src;
      iframe.title = item.title;
      Object.assign(iframe.style, {width: fmt.w + 'px', height: fmt.h + 'px', transform: `scale(${scale})`});
    }
    pins.replaceChildren(...pinsOf(item.id).filter(c => c.n != null && (c.format || item.format) === view.format
      && (!item.scenes.length || (c.scene || item.scenes[0]) === view.scene)).map(c => {
      const pin = button(String(c.n), 'response-pin' + (c.id === view.focus ? ' is-focus' : '') + (c.state === 'resolved' ? ' is-resolved' : ''));
      pin.title = c.body;
      pin.setAttribute('aria-label', `Comment ${c.n}: ${c.body}`);
      pin.style.left = (c.x * 100) + '%';
      pin.style.top = (c.y * 100) + '%';
      pin.onclick = () => { view.focus = c.id; drawStage(); drawList(); list.querySelector('#rc-' + CSS.escape(c.id))?.scrollIntoView({block: 'nearest', behavior: 'smooth'}); };
      return pin;
    }));
    caption.textContent = [formatLabel(view.format), String(view.lang || '').toUpperCase(), view.scene && 'scene ' + view.scene].filter(Boolean).join(' · ');
    scenes.hidden = item.scenes.length < 2;
    scenes.replaceChildren(...item.scenes.map(s => {
      const b = button(s, '');
      b.setAttribute('aria-pressed', String(s === view.scene));
      b.onclick = () => { view.scene = s; view.focus = null; drawStage(); drawList(); };
      return b;
    }));
  };

  const drawList = () => {
    const nodes = [];
    for (const i of data.items) {
      const mine = pinsOf(i.id);
      const h = el('h3', '', i.title);
      if (i.approved) h.append(el('span', 'client-tag is-client', 'Approved'));
      nodes.push(h);
      if (!mine.length) { nodes.push(el('p', 'note', 'No comments.')); continue; }
      const ul = el('ul', 'response-comments');
      for (const c of mine) {
        const li = el('li');
        const b = el('button', 'response-comment' + (c.id === view.focus ? ' is-focus' : '') + (c.state === 'resolved' ? ' is-resolved' : ''));
        b.type = 'button';
        b.id = 'rc-' + c.id;
        b.setAttribute('aria-pressed', String(c.id === view.focus));
        b.append(el('span', 'response-num' + (c.n == null ? ' is-general' : ''), c.n != null ? String(c.n) : '•'));
        const body = el('span', 'response-comment-body');
        body.append(el('span', 'q-text', c.body));
        const meta = [c.place && 'pinned ' + c.place, c.scene && 'scene ' + c.scene, c.format && formatLabel(c.format), c.lang?.toUpperCase()].filter(Boolean).join(' · ') || 'about the direction as a whole';
        body.append(el('span', 'note', meta + (c.state === 'resolved' ? ' · resolved' + (c.resolvedNote ? ': ' + c.resolvedNote : '') : '')));
        b.append(body);
        b.onclick = () => look(i, c);
        li.append(b);
        ul.append(li);
      }
      nodes.push(ul);
    }
    list.replaceChildren(...nodes);
  };

  function look(item, comment = null) {
    view.itemId = item.id;
    view.format = comment?.format || item.format;
    view.lang = comment?.lang || item.lang;
    view.scene = comment?.scene || (item.scenes.length ? item.scenes[0] : null);
    view.focus = comment?.id || null;
    drawStage();
    drawList();
  }

  // ---- what Forma does with it ----
  const box = el('section', 'response-feedback');
  box.append(el('h3', '', r.decision === 'approve' ? 'Notes for a revision of the approved direction' : 'Feedback for three new directions'));
  box.append(el('p', 'note', r.decision === 'approve'
    ? 'Edit if needed, then put them into the chat of the approved direction and send them as a revision of its preview.'
    : 'Edit if needed, then put them into “What should change” of the visual directions and rework all three.'));
  const text = el('textarea');
  text.rows = 7;
  text.value = data.feedback;
  text.setAttribute('aria-label', 'Notes for Forma');
  box.append(text);

  const layout = el('div', 'response-layout');
  layout.append(stage, list);
  m.body.replaceChildren(sub, layout, box);
  drawStage();
  drawList();

  const status = el('p', 'note modal-status');
  status.setAttribute('aria-live', 'polite');
  const use = button(r.decision === 'approve' ? 'Put into the chat of “' + (chosen?.title || 'the direction') + '”' : 'Put into the feedback', 'btn primary', () => {
    m.close();
    if (r.decision === 'approve') onUseComments(text.value, chosen?.id); else onUseRebuild(text.value);
  });
  const copy = button('Copy', 'btn secondary', async () => {
    try { await navigator.clipboard.writeText(text.value); message(status, 'Copied.'); } catch { text.select(); message(status, 'Press ⌘C / Ctrl+C to copy.'); }
  });
  const resolve = button('', 'btn secondary');
  const drawResolve = () => {
    resolve.hidden = !data.open;
    resolve.textContent = `Mark ${plural(data.open, 'comment', 'comments')} resolved`;
  };
  resolve.onclick = async () => {
    busy(resolve);
    const before = data.feedback;
    try {
      data = await apiJson(base + '/comments/resolve', {method: 'POST', body: JSON.stringify({
        ids: data.comments.filter(c => c.state === 'sent').map(c => c.id),
        note: r.decision === 'approve' ? 'Applied in the revision' : 'Answered in the next round',
      })});
      // Resolved comments leave the notes; text the studio already edited is left as it is.
      if (text.value === before) text.value = data.feedback;
      message(status, 'Marked resolved.');
      drawStage();
      drawList();
    } catch (err) {
      message(status, err.message, {error: true});
    }
    busy(resolve, false);
    drawResolve();
  };
  drawResolve();
  m.foot.replaceChildren(status, resolve, copy, use);
}
