// "Send directions": the studio picks three directions of a client campaign, words them for the client (titles
// without Forma's Native/World/Bold, one-line ideas, an optional note each) and sends them (studio-campaign.mjs).
import {apiJson} from './campaign.js';
import {el} from './dom.js';

const PICKS = 3;
const svgSrc = svg => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

export async function openSendDirections(requestId, {onSent = () => {}} = {}) {
  const url = '/api/studio/campaigns/' + encodeURIComponent(requestId) + '/directions';
  const dialog = el('dialog', 'q-dialog card send-dialog');
  dialog.append(el('p', 'note', 'Loading the directions…'));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  let data;
  try {
    data = await apiJson(url);
  } catch (err) {
    dialog.replaceChildren(el('p', 'q-flash is-error', err.message), closeRow(dialog));
    return;
  }

  const picked = [];   // ids, in the order the client will see them
  const fields = new Map();
  const head = el('div', 'send-head');
  head.append(el('h2', '', `Send three directions to ${data.brand}`));
  head.append(el('p', 'note', `Round ${data.round} · ${data.rebuildsLeft} ${data.rebuildsLeft === 1 ? 'rebuild' : 'rebuilds'} left after this. The client sees the title, the idea and your note, plays each preview, comments and approves one or asks for a rebuild.`));
  const nodes = [head];
  if (data.lastRound?.response?.decision === 'rebuild') {
    nodes.push(el('p', 'q-flash', `Round ${data.lastRound.round}: the client asked for a rebuild${data.lastRound.response.reason ? ' · “' + data.lastRound.response.reason + '”' : ''}.`));
  }
  if (!data.canSend) nodes.push(el('p', 'q-flash is-error', 'Directions can be sent only while the campaign is in progress (now: ' + data.label + ').'));
  if (data.available.length < PICKS) {
    nodes.push(el('p', 'q-flash is-error', `Only ${data.available.length} of the directions have a preview. Build previews until there are at least three.`));
  }

  const list = el('ol', 'send-list');
  const count = el('span', 'note');
  const send = el('button', 'btn primary', 'Send to ' + data.brand);
  send.type = 'button';
  const refresh = () => {
    for (const [id, f] of fields) {
      const n = picked.indexOf(id);
      f.item.classList.toggle('is-picked', n >= 0);
      f.badge.textContent = n >= 0 ? String(n + 1) : '';
      f.box.checked = n >= 0;
      f.box.disabled = n < 0 && picked.length >= PICKS;
    }
    count.textContent = `${picked.length} of ${PICKS} picked`;
    send.disabled = !data.canSend || picked.length !== PICKS;
  };
  for (const d of data.available) {
    const item = el('li', 'send-item');
    const pick = el('label', 'send-pick');
    const box = el('input');
    box.type = 'checkbox';
    box.setAttribute('aria-label', 'Send ' + d.title);
    const badge = el('span', 'send-badge');
    pick.append(box, badge);
    const thumb = el('div', 'send-thumb');
    if (d.keyframeSvg) {
      const img = el('img');
      img.src = svgSrc(d.keyframeSvg);
      img.alt = '';
      thumb.append(img);
    }
    const open = el('a', 'link', 'Open preview');
    open.href = d.url;
    open.target = '_blank';
    open.rel = 'noopener';
    thumb.append(open);
    const body = el('div', 'send-body');
    const title = el('input');
    title.type = 'text';
    title.maxLength = 80;
    title.value = d.title;
    title.setAttribute('aria-label', 'Title for the client');
    const idea = el('textarea');
    idea.rows = 2;
    idea.maxLength = 300;
    idea.value = d.idea;
    idea.placeholder = 'One line the client understands';
    idea.setAttribute('aria-label', 'Idea for the client');
    const note = el('textarea');
    note.rows = 2;
    note.maxLength = 600;
    note.placeholder = 'A note from us (optional)';
    note.setAttribute('aria-label', 'Note for the client');
    const flags = el('div', 'client-item-meta');
    flags.append(el('span', 'client-tag', d.label || 'Variant'));
    if (d.stale) flags.append(el('span', 'client-tag is-warn', 'Script changed since this preview'));
    if (d.approved) flags.append(el('span', 'client-tag', 'Preview approved'));
    if (data.lastRound?.ids.includes(d.id)) flags.append(el('span', 'client-tag', 'Sent in round ' + data.lastRound.round));
    body.append(title, idea, note, flags);
    item.append(pick, thumb, body);
    fields.set(d.id, {item, box, badge, title, idea, note});
    box.onchange = () => {
      const n = picked.indexOf(d.id);
      if (n >= 0) picked.splice(n, 1); else if (picked.length < PICKS) picked.push(d.id);
      refresh();
    };
    list.append(item);
  }
  nodes.push(list);

  const status = el('p', 'note');
  status.setAttribute('aria-live', 'polite');
  const cancel = el('button', 'btn secondary', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => dialog.close();
  send.onclick = async () => {
    if (!confirm(`Send these three directions to ${data.brand} now? They see them at once and can’t be unsent.`)) return;
    send.disabled = true;
    send.classList.add('is-loading');
    try {
      await apiJson(url, {method: 'POST', body: JSON.stringify({
        version: data.version,
        picks: picked.map(id => { const f = fields.get(id); return {id, title: f.title.value, idea: f.idea.value, note: f.note.value}; }),
      })});
      dialog.close();
      onSent();
    } catch (err) {
      send.classList.remove('is-loading');
      status.textContent = err.message;
      refresh();
    }
  };
  const foot = el('div', 'send-foot');
  const buttons = el('div', 'q-askbar-actions');
  buttons.append(cancel, send);
  foot.append(count, buttons);
  nodes.push(status, foot);
  dialog.replaceChildren(...nodes);
  refresh();
}

function closeRow(dialog) {
  const b = el('button', 'btn secondary', 'Close');
  b.type = 'button';
  b.onclick = () => dialog.close();
  return b;
}
