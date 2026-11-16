import {api, apiJson} from './campaign.js';
import {el} from './dom.js';

export const listBrands = () => apiJson('/api/brands');
export const listBrandCampaigns = id => apiJson('/api/brand-campaigns?brand=' + encodeURIComponent(id || ''));

export async function saveBrand({name, brand, campaign, materials}) {
  if (campaign) {
    return apiJson('/api/campaigns/' + campaign.id + '/brand', {
      method: 'POST',
      body: JSON.stringify({name}),
    });
  }

  const files = [];
  for (const [path, material] of materials) {
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
    body: JSON.stringify({id: brand?.id, version: brand?.version, name, files}),
  });
}

export function libraryCard(name, detail, action, brand = false) {
  const button = el('button', 'collection-item' + (brand ? ' brand-tile' : ''));
  button.type = 'button';
  if (brand) {
    const initials = name.trim().split(/\s+/).slice(0,2).map(word => Array.from(word)[0]).join('');
    const mark = el('span', 'brand-mark', initials.toLocaleUpperCase('ru'));
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
