// The client's answer to a round of directions: approve one or rebuild, with comments pinned on the artboard.
// Pins are drawn over the same preview the client looked at; the comments become Forma's notes (a revision of the
// approved direction, or the feedback for three new directions) and are marked resolved (studio-campaign.mjs).
import {apiJson} from './campaign.js';
import {el} from './dom.js';

const FRAME_W = 360;
const when = iso => (iso ? new Date(iso).toLocaleString('en-GB', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}) : '');

export async function openClientResponse(requestId, {onUseComments = () => {}, onUseRebuild = () => {}} = {}) {
  const base = '/api/studio/campaigns/' + encodeURIComponent(requestId);
  const dialog = el('dialog', 'q-dialog card response-dialog');
  dialog.append(el('p', 'note', 'Loading the client’s answer…'));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  let data;
  try {
    data = await apiJson(base + '/response');
  } catch (err) {
    dialog.replaceChildren(el('p', 'q-flash is-error', err.message), closeButton(dialog));
    return;
  }
  const view = {itemId: null, format: null, lang: null, scene: null, focus: null};
  const draw = () => dialog.replaceChildren(...render());

  function pinsOf(itemId) {
    // The dashboard's numbering: pins 1…n in their order, general comments apart.
    const mine = data.comments.filter(c => c.itemId === itemId).sort((a, b) => a.number - b.number);
    let n = 0;
    return mine.map(c => ({...c, n: c.x != null ? ++n : null}));
  }

  function look(item, comment = null) {
    view.itemId = item.id;
    view.format = comment?.format || item.format;
    view.lang = comment?.lang || item.lang;
    view.scene = comment?.scene || (item.scenes.length ? item.scenes[0] : null);
    view.focus = comment?.id || null;
    draw();
  }

  function frame(item) {
    const fmt = data.formats[view.format] || data.formats[item.format] || {w: 1080, h: 1080};
    const scale = FRAME_W / fmt.w;
    const box = el('div', 'response-frame');
    box.style.width = FRAME_W + 'px';
    box.style.height = Math.round(fmt.h * scale) + 'px';
    const iframe = el('iframe');
    const q = new URLSearchParams({f: view.format, l: view.lang, paused: ''});
    if (view.scene) q.set('scene', view.scene);
    iframe.src = item.url + '?' + q.toString().replace('paused=', 'paused');
    iframe.title = item.title;
    iframe.setAttribute('sandbox', 'allow-scripts');
    Object.assign(iframe.style, {width: fmt.w + 'px', height: fmt.h + 'px', transform: `scale(${scale})`});
    box.append(iframe);
    for (const c of pinsOf(item.id)) {
      if (c.n == null) continue;
      if ((c.format || item.format) !== view.format) continue;
      if (item.scenes.length && (c.scene || item.scenes[0]) !== view.scene) continue;
      const pin = el('button', 'response-pin' + (c.id === view.focus ? ' is-focus' : '') + (c.state === 'resolved' ? ' is-resolved' : ''), String(c.n));
      pin.type = 'button';
      pin.title = c.body;
      pin.style.left = (c.x * 100) + '%';
      pin.style.top = (c.y * 100) + '%';
      pin.onclick = () => { view.focus = c.id; draw(); dialog.querySelector('#rc-' + c.id)?.scrollIntoView({block: 'nearest'}); };
      box.append(pin);
    }
    return box;
  }

  function render() {
    const d = data.delivery;
    if (!d) return [el('p', 'note', 'Nothing was sent to the client yet.'), closeButton(dialog)];
    const r = d.response;
    const chosen = data.items.find(i => i.approved);
    const head = el('div', 'send-head');
    head.append(el('h2', '', `Round ${d.round} · ` + (!r ? 'with the client' : r.decision === 'approve' ? `approved “${chosen?.title || 'a direction'}”` : 'rebuild requested')));
    head.append(el('p', 'note', (r ? 'Answered ' + when(d.respondedAt) : 'Sent ' + when(d.sentAt) + '. Comments appear here when the client decides.') +
      (r?.reason ? ` · Reason: “${r.reason}”` : '') + (r?.decision === 'rebuild' ? ` · ${data.rebuildsLeft} ${data.rebuildsLeft === 1 ? 'rebuild' : 'rebuilds'} left` : '')));
    const nodes = [head];
    if (!r) return [...nodes, closeButton(dialog)];

    if (!view.itemId && data.items.length) {
      const first = chosen || data.items[0];
      view.itemId = first.id; view.format = first.format; view.lang = first.lang; view.scene = first.scenes[0] || null;
    }
    const item = data.items.find(i => i.id === view.itemId) || data.items[0];
    const stage = el('div', 'response-stage');
    const tabs = el('div', 'chips small');
    for (const i of data.items) {
      const b = el('button', '', i.title);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(i.id === item.id));
      const n = data.comments.filter(c => c.itemId === i.id).length;
      if (n) b.append(el('small', '', String(n)));
      b.onclick = () => look(i);
      tabs.append(b);
    }
    stage.append(tabs, frame(item));
    const caption = [view.format?.replace('x', ':'), view.lang, view.scene && 'scene ' + view.scene].filter(Boolean).join(' · ');
    stage.append(el('p', 'note', caption));
    if (item.scenes.length > 1) {
      const scenes = el('div', 'chips small');
      for (const s of item.scenes) {
        const b = el('button', '', s);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(s === view.scene));
        b.onclick = () => { view.scene = s; view.focus = null; draw(); };
        scenes.append(b);
      }
      stage.append(scenes);
    }

    const list = el('div', 'response-list');
    for (const i of data.items) {
      const mine = pinsOf(i.id);
      const h = el('h3', '', i.title);
      if (i.approved) h.append(el('span', 'client-tag is-client', 'Approved'));
      list.append(h);
      if (!mine.length) { list.append(el('p', 'note', 'No comments.')); continue; }
      const ul = el('ul', 'response-comments');
      for (const c of mine) {
        const li = el('li', 'response-comment' + (c.id === view.focus ? ' is-focus' : '') + (c.state === 'resolved' ? ' is-resolved' : ''));
        li.id = 'rc-' + c.id;
        li.append(el('span', 'response-num', c.n != null ? String(c.n) : '•'));
        const body = el('div');
        body.append(el('p', 'q-text', c.body));
        const meta = [c.place && 'pinned ' + c.place, c.scene && 'scene ' + c.scene, c.format?.replace('x', ':'), c.lang].filter(Boolean).join(' · ') || 'about the direction as a whole';
        body.append(el('p', 'note', meta + (c.state === 'resolved' ? ' · resolved' + (c.resolvedNote ? ': ' + c.resolvedNote : '') : '')));
        li.append(body);
        li.onclick = () => look(i, c);
        ul.append(li);
      }
      list.append(ul);
    }
    const layout = el('div', 'response-layout');
    layout.append(stage, list);
    nodes.push(layout);

    // What Forma does with it.
    const box = el('div', 'response-feedback');
    box.append(el('h3', '', r.decision === 'approve' ? 'Revise the approved direction' : 'Brief for three new directions'));
    const text = el('textarea');
    text.rows = 7;
    text.value = data.feedback;
    text.setAttribute('aria-label', 'Notes for Forma');
    box.append(text);
    const status = el('p', 'note');
    status.setAttribute('aria-live', 'polite');
    const actions = el('div', 'q-askbar-actions');
    const use = el('button', 'btn primary', r.decision === 'approve' ? 'Put into the chat of “' + (chosen?.title || 'the direction') + '”' : 'Put into the feedback for new directions');
    use.type = 'button';
    use.onclick = () => {
      dialog.close();
      if (r.decision === 'approve') onUseComments(text.value, chosen?.id); else onUseRebuild(text.value);
    };
    const copy = el('button', 'btn secondary', 'Copy');
    copy.type = 'button';
    copy.onclick = async () => { try { await navigator.clipboard.writeText(text.value); status.textContent = 'Copied.'; } catch { text.select(); } };
    actions.append(copy, use);
    if (data.open) {
      const resolve = el('button', 'btn secondary', `Mark ${data.open} ${data.open === 1 ? 'comment' : 'comments'} resolved`);
      resolve.type = 'button';
      resolve.onclick = async () => {
        resolve.disabled = true;
        try {
          data = await apiJson(base + '/comments/resolve', {method: 'POST', body: JSON.stringify({
            ids: data.comments.filter(c => c.state === 'sent').map(c => c.id),
            note: r.decision === 'approve' ? 'Applied in the revision' : 'Answered in the next round',
          })});
          draw();
        } catch (err) {
          resolve.disabled = false;
          status.textContent = err.message;
        }
      };
      actions.prepend(resolve);
    }
    box.append(status, actions);
    nodes.push(box, closeButton(dialog));
    return nodes;
  }
  draw();
}

function closeButton(dialog) {
  const row = el('div', 'q-askbar-actions');
  const b = el('button', 'btn secondary', 'Close');
  b.type = 'button';
  b.onclick = () => dialog.close();
  row.append(b);
  return row;
}
