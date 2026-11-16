// Client-side campaign state, persistence, invalidation diffing and API calls (§6, §8, §10).

export const state = {
  campaign: null,
  activeStep: 1, // 1 = Сценарий, 2 = Превью, 3 = Финал
  reviewUnlocked: {1: false, 2: false, 3: false},
  config: null,
  formatInfo: {'1x1': {id: '1x1', label: '1:1', name: 'Post', w: 1080, h: 1080}},
};

const STORAGE_KEY = 'forma.campaign';

export function getSavedCampaignId() {
  return localStorage.getItem(STORAGE_KEY) || null;
}

export function setSavedCampaignId(id) {
  if (id) localStorage.setItem(STORAGE_KEY, id);
  else localStorage.removeItem(STORAGE_KEY);
}

export const money = v =>
  typeof v === 'number' ? '$' + (v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)) : '—';

export const moneyPrecise = v =>
  typeof v === 'number' ? '$' + (v < 0.01 ? v.toFixed(4) : v.toFixed(3)) : '—';

export function stepCostLabel(cost) {
  if (!cost || (!cost.total && !cost.unknown)) return '';
  return `≈ ${money(cost.total)}${cost.unknown ? ' +?' : ''} по API`;
}

export async function api(url, init = {}) {
  const headers = {...(init.headers || {})};
  if (init.method && init.method !== 'GET') {
    headers['x-forma'] = 'studio';
  }
  const res = await fetch(url, {...init, headers});
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw Error(error.error || 'Не удалось выполнить запрос.');
  }
  return res;
}

export async function apiJson(url, init = {}) {
  const headers = {'Content-Type': 'application/json', ...(init.headers || {})};
  const res = await api(url, {...init, headers});
  return res.json();
}

export function furthestStep(c) {
  if (!c?.steps) return 1;
  if (c.steps.final?.entryId || (c.steps.preview?.approvedAt && !c.steps.preview?.stale && !c.steps.scenario?.stale && !c.steps.scenario?.needs?.length)) {
    return 3;
  }
  if (c.steps.preview?.entryId || c.steps.styles?.entryId || (c.steps.scenario?.approvedAt && !c.steps.scenario?.stale && !c.steps.scenario?.needs?.length)) {
    return 2;
  }
  return 1;
}

export function setCampaign(campaign, {chooseStep = false} = {}) {
  state.campaign = campaign || null;
  if (!campaign) {
    setSavedCampaignId(null);
    state.activeStep = 1;
    state.reviewUnlocked = {1: false, 2: false, 3: false};
    return;
  }
  setSavedCampaignId(campaign.id);
  if (chooseStep) {
    state.activeStep = furthestStep(campaign);
    state.reviewUnlocked = {1: false, 2: false, 3: false};
  } else {
    // Clamp activeStep if downstream was locked
    const scReady = Boolean(campaign.steps?.scenario?.approvedAt && !campaign.steps?.scenario?.stale && !campaign.steps?.scenario?.needs?.length);
    const prevReady = Boolean(scReady && campaign.steps?.preview?.approvedAt && !campaign.steps?.preview?.stale);
    if (state.activeStep === 3 && !prevReady && !campaign.steps?.final?.entryId) {
      state.activeStep = scReady || campaign.steps?.preview?.entryId ? 2 : 1;
    } else if (state.activeStep === 2 && !scReady && !campaign.steps?.preview?.entryId && !campaign.steps?.styles?.entryId) {
      state.activeStep = 1;
    }
  }
}

export function applyPatchToScenario(scenario, patch) {
  if (!scenario) return null;
  const clone = structuredClone(scenario);
  if (!patch || typeof patch !== 'object') return clone;
  for (const [k, langMap] of Object.entries(patch)) {
    if (clone.lines?.[k] && langMap && typeof langMap === 'object') {
      clone.lines[k].text = {...clone.lines[k].text, ...langMap};
    }
  }
  return clone;
}

export function effectiveScenario(stage = 'final') {
  const c = state.campaign;
  const base = c?.entries?.scenario?.output?.scenario;
  if (!base) return null;
  const entry = stage === 'preview' ? c?.entries?.preview : (c?.entries?.final || c?.entries?.preview);
  const patch = entry?.input?.copyPatch;
  return patch ? applyPatchToScenario(base, patch) : structuredClone(base);
}

// Describes what becomes stale when changing setup in the Campaign Bar popover (§2.5, §8.1).
export function describeSetupInvalidation(prev, next, campaign) {
  if (!prev || !next || !campaign?.steps) return [];
  const effects = [];
  const s = campaign.steps;

  if (prev.kind !== next.kind) {
    if (s.scenario?.entryId) effects.push('Сценарий устареет (сменился тип креатива)');
    if (s.preview?.entryId) effects.push('Превью устареет');
    if (s.final?.entryId) effects.push('Финал устареет');
    return effects;
  }

  if (prev.languages?.[0] !== next.languages?.[0]) {
    if (s.preview?.entryId) effects.push('Превью устареет (сменился основной язык)');
    if (s.final?.entryId) effects.push('Финал устареет');
  }
  if (prev.formats?.[0] !== next.formats?.[0]) {
    if (s.preview?.entryId) effects.push('Превью устареет (сменился основной формат)');
    if (s.final?.entryId) effects.push('Финал устареет');
  }

  const addedLangs = (next.languages || []).filter(l => !(prev.languages || []).includes(l));
  const langsChanged = (prev.languages || []).join(',') !== (next.languages || []).join(',');
  if (addedLangs.length && s.scenario?.entryId) {
    effects.push(`Сценарию потребуется перевод на: ${addedLangs.join(', ')}`);
  }
  if (langsChanged && s.final?.entryId && !effects.some(e => e.includes('Финал'))) {
    effects.push('Финал устареет (изменился список языков)');
  }

  const addedLengths = (next.lengths || []).filter(l => !(prev.lengths || []).includes(l));
  const lengthsChanged = (prev.lengths || []).join(',') !== (next.lengths || []).join(',');
  if (next.kind === 'multi' && addedLengths.length && s.scenario?.entryId) {
    effects.push(`Сценарию потребуется расчёт нарезки для: ${addedLengths.join(', ')} с`);
  }
  if (lengthsChanged && s.final?.entryId && !effects.some(e => e.includes('Финал'))) {
    effects.push('Финал устареет (изменились длины роликов)');
  }

  const formatsChanged = (prev.formats || []).join(',') !== (next.formats || []).join(',');
  if (formatsChanged && s.final?.entryId && !effects.some(e => e.includes('Финал'))) {
    effects.push('Финал устареет (изменился набор форматов)');
  }

  return effects;
}

// ---- Campaign HTTP client ----

export const createCampaign = ({project, setup, name}) =>
  apiJson('/api/campaigns', {method: 'POST', body: JSON.stringify({project, setup, name})});

export const forkCampaign = (id, {styleIndex, name} = {}) =>
  apiJson(`/api/campaigns/${encodeURIComponent(id)}/fork`, {
    method: 'POST',
    body: JSON.stringify({styleIndex, name}),
  });

export const fetchCampaign = id =>
  apiJson(`/api/campaigns/${encodeURIComponent(id)}`);

export const listCampaigns = ({before, limit = 30, author, excludeAuthor} = {}) => {
  const q = new URLSearchParams({limit: String(limit)});
  if (before) q.set('before', before);
  if (author) q.set('author', author);
  if (excludeAuthor) q.set('excludeAuthor', excludeAuthor);
  return apiJson('/api/campaigns?' + q);
};

export const fetchActiveRuns = () =>
  apiJson('/api/runs/active');

export const patchCampaign = (id, patch) =>
  apiJson(`/api/campaigns/${encodeURIComponent(id)}`, {method: 'PATCH', body: JSON.stringify(patch)});

export const generateScenario = (id, {requestId, notes, signal} = {}) =>
  apiJson(`/api/campaigns/${encodeURIComponent(id)}/scenario`, {
    method: 'POST',
    signal,
    body: JSON.stringify({requestId, notes}),
  });

export const saveScenarioManual = (id, scenario) =>
  apiJson(`/api/campaigns/${encodeURIComponent(id)}/scenario`, {
    method: 'PUT',
    body: JSON.stringify({scenario}),
  });

export const translateScenario = (id, {requestId, languages, signal} = {}) =>
  apiJson(`/api/campaigns/${encodeURIComponent(id)}/translate`, {
    method: 'POST',
    signal,
    body: JSON.stringify({requestId, languages}),
  });

export const recalcCuts = (id, {requestId, signal} = {}) =>
  apiJson(`/api/campaigns/${encodeURIComponent(id)}/cuts`, {
    method: 'POST',
    signal,
    body: JSON.stringify({requestId}),
  });

export const approveStep = (id, step, {variant} = {}) =>
  apiJson(`/api/campaigns/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: JSON.stringify({step, variant}),
  });

export const proposeStyles = (id, {requestId, variant, signal} = {}) =>
  apiJson(`/api/campaigns/${encodeURIComponent(id)}/styles`, {
    method: 'POST',
    signal,
    body: JSON.stringify({requestId, variant}),
  });

export const chooseStyle = (id, {index, direction, label, variant}) =>
  apiJson(`/api/campaigns/${encodeURIComponent(id)}/styles/choose`, {
    method: 'POST',
    body: JSON.stringify({index, direction, label, variant}),
  });

export const createVariant = (id, {stylesEntryId, index, direction, label} = {}) =>
  apiJson(`/api/campaigns/${encodeURIComponent(id)}/variants`, {
    method: 'POST',
    body: JSON.stringify({stylesEntryId, index, direction, label}),
  });

export const renameVariant = (id, vid, label) =>
  apiJson(`/api/campaigns/${encodeURIComponent(id)}/variants/${encodeURIComponent(vid)}`, {
    method: 'PATCH',
    body: JSON.stringify({label}),
  });

export const switchActiveVariant = (id, activeVariant) =>
  patchCampaign(id, {activeVariant});

export const buildPreview = (id, {requestId, direction, variant, signal} = {}) =>
  apiJson(`/api/campaigns/${encodeURIComponent(id)}/preview`, {
    method: 'POST',
    signal,
    body: JSON.stringify({requestId, direction, variant}),
  });

export const buildFinal = (id, {requestId, media, variant, signal} = {}) =>
  apiJson(`/api/campaigns/${encodeURIComponent(id)}/final`, {
    method: 'POST',
    signal,
    body: JSON.stringify({requestId, media, variant}),
  });

export const saveCopyPatch = (historyId, patch) =>
  apiJson(`/api/history/${encodeURIComponent(historyId)}/copy`, {
    method: 'POST',
    body: JSON.stringify({patch}),
  });
