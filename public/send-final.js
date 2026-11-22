// "Send the final": the final of the direction the client approved goes to them (studio-campaign.mjs). It delivers
// the campaign, so the dialog shows exactly what they get and what stands in the way, and asks once more.
import {apiJson} from './campaign.js';
import {el} from './dom.js';
import {openModal, button, busy, message, confirmAction} from './ui.js';

const KIND = {poster: 'Static poster', single: 'Single-scene video', multi: 'Multi-scene video'};
const formatLabel = id => (id === '191x1' ? '1.91:1' : String(id).replace('x', ':'));

export async function openSendFinal(requestId, {onSent = () => {}} = {}) {
  const url = '/api/studio/campaigns/' + encodeURIComponent(requestId) + '/final';
  const m = openModal({key: 'send-final:' + requestId, className: 'send-final-dialog', title: 'Send the final'});
  if (!m) return;
  let typedTitle = null;

  const load = async () => {
    m.body.replaceChildren(el('p', 'modal-loading', 'Loading the final…'));
    m.foot.replaceChildren();
    let data;
    try {
      data = await apiJson(url);
    } catch (err) {
      m.body.replaceChildren(el('p', 'q-flash is-error', err.message));
      m.foot.replaceChildren(button('Close', 'btn secondary', m.close), button('Try again', 'btn primary', load));
      return;
    }
    if (m.dialog.isConnected) draw(data);
  };

  const draw = data => {
    const f = data.final;
    m.setTitle(`Send the final to ${data.brand}`);
    const nodes = [el('p', 'note', 'This delivers the campaign: the client sees the final, plays every format, language and length, and downloads the files once they are exported. It is sent once.')];
    for (const p of data.problems) nodes.push(el('p', 'q-flash is-error', p));
    if (data.openComments) nodes.push(el('p', 'q-flash', `${data.openComments} of the client’s comments on this direction ${data.openComments === 1 ? 'is' : 'are'} not marked resolved. Check that the final answers them.`));
    let title = null;
    if (f) {
      const label = el('label', 'field');
      label.append(el('span', '', 'Title for the client'));
      title = el('input');
      title.type = 'text';
      title.maxLength = 80;
      title.value = typedTitle ?? f.title;
      title.oninput = () => { typedTitle = title.value; };
      label.append(title);
      nodes.push(label);
      const facts = el('dl', 'send-final-facts');
      const row = (k, v) => facts.append(el('dt', '', k), el('dd', '', v));
      row('Kind', KIND[f.kind] || f.kind);
      row('Formats', f.formats.map(formatLabel).join(', '));
      row('Languages', f.langs.map(x => x.toUpperCase()).join(', '));
      if (f.kind !== 'poster') row('Lengths', f.lengths.map(n => n + ' s').join(', '));
      const files = f.formats.length * f.langs.length * ((f.kind === 'poster' ? 0 : f.lengths.length) + 1);
      row('Files', files + (files === 1 ? ' file' : ' files') + ', exported on this computer after sending');
      nodes.push(facts);
      const open = el('a', 'link', 'Open the final ↗');
      open.href = data.url + '?' + new URLSearchParams({f: f.formats[0], l: f.langs[0], ...(f.kind !== 'poster' && f.lengths[0] ? {d: String(f.lengths[0])} : {})});
      open.target = '_blank';
      open.rel = 'noopener';
      nodes.push(open);
    }
    const status = el('p', 'note modal-status');
    status.setAttribute('aria-live', 'polite');
    const send = button('Send the final', 'btn primary');
    send.disabled = !data.canSend;
    if (!data.canSend && !data.problems.length) message(status, 'The final can be sent once the client has approved a direction (now: ' + data.label + ').');
    send.onclick = async () => {
      if (title && !title.value.trim()) { message(status, 'Give the final a title.', {error: true}); title.focus(); return; }
      const ok = await confirmAction({title: `Deliver to ${data.brand}?`, confirm: 'Send the final',
        text: 'This delivers the campaign. It can’t be sent again or taken back.'});
      if (!ok) return;
      busy(send);
      try {
        await apiJson(url, {method: 'POST', body: JSON.stringify({version: data.version, title: title?.value || ''})});
        m.close();
        onSent();
      } catch (err) {
        busy(send, false);
        if (err.status === 409) { await load(); m.body.prepend(el('p', 'q-flash', 'Someone updated this meanwhile. This is the latest now: check it and send again.')); return; }
        message(status, err.message, {error: true});
      }
    };
    m.body.replaceChildren(...nodes);
    m.foot.replaceChildren(status, button('Cancel', 'btn secondary', m.close), send);
  };

  await load();
}
