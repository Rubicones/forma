// "Send the final": the final of the direction the client approved goes to them (studio-campaign.mjs). It delivers
// the campaign, so the dialog shows exactly what they get and what stands in the way, and asks once more.
import {apiJson} from './campaign.js';
import {el} from './dom.js';

const KIND = {poster: 'Static poster', single: 'Single-scene video', multi: 'Multi-scene video'};

export async function openSendFinal(requestId, {onSent = () => {}} = {}) {
  const url = '/api/studio/campaigns/' + encodeURIComponent(requestId) + '/final';
  const dialog = el('dialog', 'q-dialog card send-final-dialog');
  dialog.append(el('p', 'note', 'Loading the final…'));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  let data;
  try {
    data = await apiJson(url);
  } catch (err) {
    dialog.replaceChildren(el('p', 'q-flash is-error', err.message), buttons(dialog));
    return;
  }
  const f = data.final;
  const nodes = [el('h2', '', `Send the final to ${data.brand}`)];
  nodes.push(el('p', 'note', 'This delivers the campaign: the client sees the final, plays every format, language and length, and downloads the files once they are exported. It can’t be sent again.'));
  for (const p of data.problems) nodes.push(el('p', 'q-flash is-error', p));
  if (data.openComments) nodes.push(el('p', 'q-flash', `${data.openComments} of the client’s comments on this direction are not marked resolved. Check that the final answers them.`));
  let title = null;
  if (f) {
    const label = el('label', 'q-brand-name');
    label.append(el('span', 'note', 'Title for the client'));
    title = el('input');
    title.type = 'text';
    title.maxLength = 80;
    title.value = f.title;
    label.append(title);
    nodes.push(label);
    const facts = el('dl', 'send-final-facts');
    const row = (k, v) => facts.append(el('dt', '', k), el('dd', '', v));
    row('Kind', KIND[f.kind] || f.kind);
    row('Formats', f.formats.map(x => x.replace('x', ':')).join(', '));
    row('Languages', f.langs.join(', '));
    if (f.kind !== 'poster') row('Lengths', f.lengths.map(n => n + ' s').join(', '));
    nodes.push(facts);
    const open = el('a', 'link', 'Open the final');
    open.href = data.url + '?' + new URLSearchParams({f: f.formats[0], l: f.langs[0], ...(f.kind !== 'poster' && f.lengths[0] ? {d: String(f.lengths[0])} : {})});
    open.target = '_blank';
    open.rel = 'noopener';
    nodes.push(open);
  }
  const status = el('p', 'note');
  status.setAttribute('aria-live', 'polite');
  const send = el('button', 'btn primary', 'Send the final');
  send.type = 'button';
  send.disabled = !data.canSend;
  if (!data.canSend && !data.problems.length) status.textContent = 'The final can be sent once the client has approved a direction (now: ' + data.label + ').';
  send.onclick = async () => {
    if (!confirm(`Send the final to ${data.brand}? This delivers the campaign and can’t be undone.`)) return;
    send.disabled = true;
    send.classList.add('is-loading');
    try {
      await apiJson(url, {method: 'POST', body: JSON.stringify({version: data.version, title: title?.value || ''})});
      dialog.close();
      onSent();
    } catch (err) {
      send.disabled = false;
      send.classList.remove('is-loading');
      status.textContent = err.message;
    }
  };
  nodes.push(status, buttons(dialog, send));
  dialog.replaceChildren(...nodes);
}

function buttons(dialog, primary = null) {
  const row = el('div', 'q-askbar-actions');
  const close = el('button', 'btn secondary', primary ? 'Cancel' : 'Close');
  close.type = 'button';
  close.onclick = () => dialog.close();
  row.append(close);
  if (primary) row.append(primary);
  return row;
}
