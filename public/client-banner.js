// The client's request on a Forma campaign made from the client dashboard (studio-campaign.mjs): who asked, where the
// request stands for the client (live from /api/studio/campaigns/:id), rebuilds left, and the brief the script read.
import {el} from './dom.js';
import {openSendDirections} from './send-directions.js';
import {openClientResponse} from './client-response.js';
import {openSendFinal} from './send-final.js';

let live = {id: null, data: null, at: 0};
let current = {root: null, campaign: null, actions: {}};

function draw(root, client, data) {
  const head = el('div', 'client-banner-head');
  const who = el('div', 'client-banner-who');
  who.append(el('span', 'client-tag is-client', 'Client request'), el('strong', '', client.brand || 'Client'));
  if (client.account && client.account !== client.brand) who.append(el('span', 'note', 'via ' + client.account));
  if (client.test) who.append(el('span', 'client-tag is-test', 'Test'));
  const state = el('div', 'client-banner-state');
  if (data) {
    state.append(el('span', 'client-status', data.label));
    if (data.round) state.append(el('span', 'client-tag', 'Round ' + data.round));
    if (data.canCancel) state.append(el('span', 'client-tag', data.rebuildsLeft + (data.rebuildsLeft === 1 ? ' rebuild left' : ' rebuilds left')));
  }
  if (data?.status === 'in_progress') {
    const send = el('button', 'btn primary small', 'Send directions…');
    send.type = 'button';
    send.onclick = () => openSendDirections(client.requestId, {onSent: () => {
      live.at = 0;
      if (current.root) renderClientBanner(current.root, current.campaign, current.actions);
    }});
    state.append(send);
  }
  if (data?.status === 'in_production') {
    const send = el('button', 'btn primary small', 'Send the final…');
    send.type = 'button';
    send.onclick = () => openSendFinal(client.requestId, {onSent: () => {
      live.at = 0;
      if (current.root) renderClientBanner(current.root, current.campaign, current.actions);
    }});
    state.append(send);
  }
  const answered = (data?.deliveries || []).filter(x => x.stage === 'directions').sort((a, b) => b.round - a.round)[0];
  if (answered?.response) {
    state.append(el('span', 'client-tag ' + (answered.response.decision === 'approve' ? 'is-client' : 'is-warn'),
      `Round ${answered.round}: ` + (answered.response.decision === 'approve' ? 'direction approved' : 'rebuild requested')));
    const read = el('button', 'btn secondary small', 'Client’s answer…');
    read.type = 'button';
    read.onclick = () => openClientResponse(client.requestId, current.actions);
    state.append(read);
  }
  if (data?.status === 'delivered') state.append(exportsLine(client.requestId));
  const link = el('a', 'btn secondary small', 'View request');
  link.href = '/clients/campaigns/' + encodeURIComponent(client.requestId);
  state.append(link);
  head.append(who, state);
  const brief = el('details', 'client-banner-brief');
  brief.append(el('summary', '', 'The client’s brief'));
  brief.append(el('p', 'q-text', client.briefText || ''));
  if (client.refsSkipped?.length) {
    brief.append(el('p', 'note', 'References not copied: ' + client.refsSkipped.map(s => s.name + ' (' + s.reason + ')').join('; ')));
  }
  brief.append(el('p', 'note', 'The script step reads this brief with the brand notes. Your script notes come on top of it.'));
  const open = root.querySelector('.client-banner-brief')?.open;
  if (open) brief.open = true;
  root.replaceChildren(head, brief);
}

// actions: {onUseComments(text, variantId), onUseRebuild(text)} from app.js, to put the client's answer to work.
// The final's files for the client (export.mjs): how many are ready, being made or failed, and "Export again".
function exportsLine(requestId) {
  const box = el('span', 'client-banner-exports note', 'Files: checking…');
  const url = '/api/studio/campaigns/' + encodeURIComponent(requestId) + '/exports';
  let timer = null;
  const load = async () => {
    clearTimeout(timer);
    if (!box.isConnected && timer !== null) return;
    try {
      const res = await fetch(url, {cache: 'no-store'});
      if (!res.ok) throw Error();
      const x = await res.json();
      const c = x.counts || {};
      const busy = x.state?.status === 'running';
      const parts = [`Files: ${c.ready || 0} of ${x.total || 0} ready`];
      if (busy) parts.push(`making ${x.state.current || '…'} (${x.state.done} of ${x.state.total})`);
      else if (c.pending || c.missing) parts.push(`${(c.pending || 0) + (c.missing || 0)} waiting`);
      if (c.failed) parts.push(`${c.failed} failed`);
      box.replaceChildren(document.createTextNode(parts.join(' · ')));
      if (!busy && (c.failed || c.missing || c.pending)) {
        const again = el('button', 'link', 'Export again');
        again.type = 'button';
        again.onclick = async () => {
          again.disabled = true;
          await fetch(url, {method: 'POST', headers: {'x-forma': 'studio', 'Content-Type': 'application/json'}, body: '{}'}).catch(() => {});
          setTimeout(load, 1500);
        };
        box.append(' ', again);
      }
      if (busy || c.pending || c.missing) timer = setTimeout(load, 5000);
    } catch {
      box.textContent = 'Files: status unavailable';
    }
  };
  timer = 0;
  setTimeout(load, 0);
  return box;
}

export async function renderClientBanner(root, campaign, actions = {}) {
  current = {root, campaign, actions};
  const client = campaign?.client;
  root.hidden = !client;
  if (!client) { root.replaceChildren(); delete root.dataset.request; return; }
  const id = client.requestId;
  const fresh = live.id === id && Date.now() - live.at < 30000;
  if (root.dataset.request !== id || !root.childElementCount || fresh) draw(root, client, live.id === id ? live.data : null);
  root.dataset.request = id;
  if (fresh) return;
  live = {id, data: live.id === id ? live.data : null, at: Date.now()};
  try {
    const res = await fetch('/api/studio/campaigns/' + encodeURIComponent(id), {cache: 'no-store'});
    if (!res.ok) return;
    live = {id, data: await res.json(), at: Date.now()};
    if (root.dataset.request === id) draw(root, client, live.data);
  } catch { /* the banner works without the live status */ }
}

// Badges on Forma's campaign cards: where each client campaign stands for the client, and whose move it is.
let statuses = {at: 0, data: null};
export async function decorateClientCampaigns(root) {
  if (!root) return;
  try {
    if (!statuses.data || Date.now() - statuses.at > 30000) {
      const res = await fetch('/api/studio/campaign-statuses', {cache: 'no-store'});
      statuses = {at: Date.now(), data: res.ok ? await res.json() : {byCampaign: {}}};
    }
  } catch { return; }
  const by = statuses.data?.byCampaign || {};
  for (const card of root.querySelectorAll('.campaign-card[data-campaign-id]')) {
    card.querySelector('.card-client')?.remove();
    const s = by[card.dataset.campaignId];
    if (!s) continue;
    const tag = el('span', 'client-tag card-client turn-' + s.turn, (s.turn === 'studio' ? 'Client · our move · ' : 'Client · ') + s.label);
    tag.title = (s.account || 'Client') + (s.test ? ' (test)' : '');
    card.append(tag);
  }
}
