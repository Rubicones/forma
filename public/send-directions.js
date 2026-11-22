// "Send directions": the studio picks three directions of a client campaign, words them for the client (titles
// without Forma's Native/World/Bold, one-line ideas, an optional note each) and sends them (studio-campaign.mjs).
import {apiJson} from './campaign.js';
import {el} from './dom.js';
import {openModal, button, busy, message, confirmAction} from './ui.js';

const PICKS = 3;
const svgSrc = svg => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

export async function openSendDirections(requestId, {onSent = () => {}} = {}) {
  const url = '/api/studio/campaigns/' + encodeURIComponent(requestId) + '/directions';
  const m = openModal({key: 'send-directions:' + requestId, className: 'is-wide send-dialog', title: 'Send three directions'});
  if (!m) return;
  // What the studio typed survives a reload after a conflict (someone else moved the request meanwhile).
  const typed = new Map();
  const picked = [];   // ids, in the order the client will see them

  const load = async () => {
    m.body.replaceChildren(el('p', 'modal-loading', 'Loading the directions…'));
    m.foot.replaceChildren();
    let data;
    try {
      data = await apiJson(url);
    } catch (err) {
      m.body.replaceChildren(el('p', 'q-flash is-error', err.message));
      m.foot.replaceChildren(button('Close', 'btn secondary', m.close), button('Try again', 'btn primary', load));
      return;
    }
    if (!m.dialog.isConnected) return;
    draw(data);
  };

  const draw = data => {
    m.setTitle(`Send three directions to ${data.brand}`);
    for (let i = picked.length - 1; i >= 0; i--) if (!data.available.some(d => d.id === picked[i])) picked.splice(i, 1);
    const nodes = [el('p', 'note', `Round ${data.round}. The client sees each title, idea and note, plays the previews, comments, and approves one or asks for a rebuild (${plural(data.rebuildsLeft, 'rebuild', 'rebuilds')} left).`)];
    if (data.lastRound?.response?.decision === 'rebuild') {
      nodes.push(el('p', 'q-flash', `Round ${data.lastRound.round}: the client asked for a rebuild${data.lastRound.response.reason ? ' · “' + data.lastRound.response.reason + '”' : ''}.`));
    }
    if (!data.canSend) nodes.push(el('p', 'q-flash is-error', 'Directions can be sent only while the campaign is in progress (now: ' + data.label + ').'));
    else if (data.available.length < PICKS) {
      nodes.push(el('p', 'q-flash is-error', `${data.available.length ? 'Only ' + plural(data.available.length, 'direction has', 'directions have') : 'No direction has'} a preview yet. Build previews until there are at least three.`));
    }

    const fields = new Map();
    const count = el('span', 'send-count');
    const send = button('Send to ' + data.brand, 'btn primary');
    const refresh = () => {
      error.textContent = '';
      for (const [id, f] of fields) {
        const n = picked.indexOf(id);
        f.item.classList.toggle('is-picked', n >= 0);
        f.badge.textContent = n >= 0 ? String(n + 1) : '';
        f.box.checked = n >= 0;
        f.box.disabled = !data.canSend || (n < 0 && picked.length >= PICKS);
        f.item.classList.toggle('is-off', f.box.disabled && n < 0);
      }
      count.textContent = `${picked.length} of ${PICKS} picked` + (picked.length === PICKS ? ' · the client sees them in this order' : '');
      send.disabled = !data.canSend || picked.length !== PICKS || [...fields.values()].some(f => picked.includes(f.id) && !f.title.value.trim());
    };

    const list = el('ol', 'send-list');
    for (const d of data.available) {
      const was = typed.get(d.id) || {};
      const item = el('li', 'send-item');
      const pick = el('label', 'send-pick');
      const box = el('input');
      box.type = 'checkbox';
      box.setAttribute('aria-label', 'Send “' + d.title + '”');
      const badge = el('span', 'send-badge');
      badge.setAttribute('aria-hidden', 'true');
      pick.append(box, badge);
      const thumb = el('div', 'send-thumb');
      if (d.keyframeSvg) {
        const img = el('img');
        img.src = svgSrc(d.keyframeSvg);
        img.alt = '';
        thumb.append(img);
      } else thumb.append(el('span', 'send-thumb-empty', d.format.replace('x', ':')));
      const open = el('a', 'link', 'Open preview ↗');
      open.href = d.url;
      open.target = '_blank';
      open.rel = 'noopener';
      thumb.append(open);
      const body = el('div', 'send-body');
      const title = el('input');
      title.type = 'text';
      title.maxLength = 80;
      title.value = was.title ?? d.title;
      title.placeholder = 'Title for the client';
      title.setAttribute('aria-label', 'Title for the client');
      const idea = el('textarea');
      idea.rows = 2;
      idea.maxLength = 300;
      idea.value = was.idea ?? d.idea;
      idea.placeholder = 'The idea in one line the client understands';
      idea.setAttribute('aria-label', 'Idea for the client');
      const note = el('textarea');
      note.rows = 2;
      note.maxLength = 600;
      note.value = was.note ?? '';
      note.placeholder = 'A note from us (optional)';
      note.setAttribute('aria-label', 'Note for the client');
      const flags = el('div', 'client-item-meta');
      flags.append(el('span', 'client-tag', d.label || 'Variant'));
      if (d.stale) flags.append(el('span', 'client-tag is-warn', 'Script changed since this preview'));
      if (d.approved) flags.append(el('span', 'client-tag', 'Preview approved'));
      if (data.lastRound?.ids.includes(d.id)) flags.append(el('span', 'client-tag', 'Sent in round ' + data.lastRound.round));
      body.append(title, idea, note, flags);
      item.append(pick, thumb, body);
      const f = {id: d.id, item, box, badge, title, idea, note};
      fields.set(d.id, f);
      // Typing in a direction's fields picks it, when there is room: the studio rarely words one it will not send.
      title.oninput = idea.oninput = note.oninput = () => {
        typed.set(d.id, {title: title.value, idea: idea.value, note: note.value});
        if (data.canSend && !picked.includes(d.id) && picked.length < PICKS) picked.push(d.id);
        refresh();
      };
      box.onchange = () => {
        const n = picked.indexOf(d.id);
        if (n >= 0) picked.splice(n, 1); else if (picked.length < PICKS) picked.push(d.id);
        refresh();
      };
      list.append(item);
    }
    if (data.available.length) nodes.push(list);

    const status = el('p', 'note modal-status');
    const error = el('span', 'modal-error');
    status.setAttribute('aria-live', 'polite');
    status.append(count, error);
    send.onclick = async () => {
      const ok = await confirmAction({title: `Send to ${data.brand}?`, confirm: 'Send now',
        text: 'They see the three directions at once, in this order. A round can’t be unsent.'});
      if (!ok) return;
      busy(send);
      try {
        await apiJson(url, {method: 'POST', body: JSON.stringify({
          version: data.version,
          picks: picked.map(id => { const f = fields.get(id); return {id, title: f.title.value, idea: f.idea.value, note: f.note.value}; }),
        })});
        m.close();
        onSent();
      } catch (err) {
        busy(send, false);
        if (err.status === 409) { await load(); m.body.prepend(el('p', 'q-flash', 'Someone updated this meanwhile. This is the latest now: check it and send again.')); return; }   // reloaded with the latest state; the typing is kept
        refresh();
        message(error, err.message, {error: true});
      }
    };
    m.body.replaceChildren(...nodes);
    m.foot.replaceChildren(status, button('Cancel', 'btn secondary', m.close), send);
    refresh();
  };

  await load();
}
