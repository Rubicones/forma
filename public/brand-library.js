import {api, apiJson} from './campaign.js';
import {el} from './dom.js';

export const listBrands = () => apiJson('/api/brands');

// Same rule as addMaterial in app.js and the server: OS/VCS clutter is skipped, not uploaded.
const isJunkPath = name => String(name).split('/').some(seg => (seg.startsWith('.') && seg !== '.' && seg !== '..') || seg === '__MACOSX' || /^(thumbs\.db|desktop\.ini)$/i.test(seg));
export const listBrandCampaigns = (id, covers = false) => apiJson('/api/brand-campaigns?' + new URLSearchParams({brand:id || '', covers:covers ? '1' : '0'}));

export async function saveBrand({name, brand, campaign, materials, provider}) {
  if (campaign) {
    return apiJson('/api/campaigns/' + campaign.id + '/brand', {
      method: 'POST',
      body: JSON.stringify({name, provider}),
    });
  }

  const files = [];
  for (const [path, material] of materials) {
    if (isJunkPath(path)) continue;
    let hash = material.hash;
    if (material instanceof File) {
      const response = await api('/api/brand-files', {
        method: 'PUT',
        headers: {'Content-Type': 'application/octet-stream'},
        body: material,
      });
      ({hash} = await response.json());
    }
    files.push({name: path, hash});
  }
  return apiJson('/api/brands', {
    method: 'POST',
    body: JSON.stringify({id: brand?.id, version: brand?.version, name, files, provider}),
  });
}

export function libraryCard(name, detail, action, brand = false) {
  const button = el('button', 'collection-item' + (brand ? ' brand-tile' : ''));
  button.type = 'button';
  if (brand) {
    const initials = name.trim().split(/\s+/).slice(0,2).map(word => Array.from(word)[0]).join('');
    const mark = el('span', 'brand-mark', initials.toLocaleUpperCase('en'));
    mark.setAttribute('aria-hidden', 'true');
    button.append(mark);
  }
  const text = el('span', 'collection-text');
  text.append(el('strong', '', name), el('small', '', detail));
  const arrow = el('span', 'collection-arrow', '→');
  arrow.setAttribute('aria-hidden', 'true');
  button.append(text, arrow);
  button.onclick = action;
  return button;
}

// Creatives lay themselves out at the chosen format's native size. Scale that
// viewport into the card so typography and framing match the full player.
class CampaignThumbnail extends HTMLElement {
  connectedCallback() {
    const frame = this.querySelector('iframe');
    if (!frame) return;
    this.resize = new ResizeObserver(([entry]) => {
      const {width, height} = entry.contentRect;
      const scale = Math.min(width / Number(frame.width), height / Number(frame.height));
      frame.style.transform = `translate(-50%, -50%) scale(${scale})`;
    });
    this.resize.observe(this);
  }

  disconnectedCallback() {
    this.resize?.disconnect();
  }
}
customElements.define('campaign-thumbnail', CampaignThumbnail);

export function campaignCard(campaign, detail, config, open) {
  const card = el('article', 'campaign-card');
  card.dataset.campaignId = campaign.id;
  const cover = campaign.cover;
  const thumb = document.createElement('campaign-thumbnail');
  thumb.setAttribute('aria-hidden', 'true');
  if (cover?.path) {
    const frame = document.createElement('iframe');
    const size = config.formats.find(f => f.id === cover.format) || {w:1080,h:1080};
    frame.width = size.w;
    frame.height = size.h;
    frame.title = campaign.name;
    frame.tabIndex = -1;
    frame.loading = 'lazy';
    frame.setAttribute('sandbox', 'allow-scripts');
    const url = new URL(cover.path, config.previewURL);
    url.search = new URLSearchParams({f:cover.format, paused:'', t:'1'});
    frame.src = url.href;
    thumb.append(frame);
  } else if (cover?.svg) {
    const img = new Image();
    img.alt = '';
    img.loading = 'lazy';
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(cover.svg);
    thumb.append(img);
  } else {
    thumb.textContent = 'No preview yet';
  }
  const label = {final:'Final', preview:'Preview', sketch:'Style sketch'}[cover?.stage];
  const button = libraryCard(campaign.name, [label, detail].filter(Boolean).join(' · '), open);
  card.append(thumb, button);
  return card;
}
