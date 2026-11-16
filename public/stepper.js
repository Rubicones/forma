// Campaign bar (§8.1) and 3-step Stepper (§8.2).
import {language} from '/shared/languages.mjs';
import {state, stepCostLabel} from '/campaign.js';

const $ = s => document.querySelector(s);

const KIND_LABELS = {
  poster: 'Постер',
  single: 'Односценовое видео',
  multi: 'Многосценовое видео',
};

export function stepInfo(campaign, stepNum, busyStep = null) {
  if (!campaign) {
    return {
      state: 'locked',
      badge: String(stepNum),
      status: stepNum === 1 ? 'Настройте кампанию' : stepNum === 2 ? 'Сначала утвердите сценарий' : 'Сначала утвердите превью',
      cost: '',
      locked: true,
      approved: false,
      stale: false,
    };
  }

  const s = campaign.steps || {};
  const entries = campaign.entries || {};
  const scApproved = Boolean(s.scenario?.approvedAt && !s.scenario?.stale && !s.scenario?.needs?.length);
  const prevApproved = Boolean(scApproved && s.preview?.approvedAt && !s.preview?.stale);

  if (stepNum === 1) {
    const cost = stepCostLabel(entries.scenario?.cost);
    if (busyStep === 1) {
      return {state: 'generating', badge: '1', status: 'Генерация…', cost, locked: false, approved: false, stale: false};
    }
    if (s.scenario?.stale || s.scenario?.needs?.length) {
      const status = s.scenario?.needs?.includes('translation')
        ? '⚠ Нужен перевод'
        : s.scenario?.needs?.includes('cuts')
          ? '⚠ Нужна нарезка'
          : '⚠ Устарело — пересоберите';
      return {state: 'stale', badge: '⚠', status, cost, locked: false, approved: false, stale: true};
    }
    if (scApproved) {
      return {state: 'approved', badge: '✓', status: '✓ Утверждено', cost, locked: false, approved: true, stale: false};
    }
    return {state: 'active', badge: '1', status: 'В работе', cost, locked: false, approved: false, stale: false};
  }

  if (stepNum === 2) {
    const sumCost = combineStepCosts(entries.styles?.cost, entries.preview?.cost);
    const cost = stepCostLabel(sumCost);
    const hasWork = Boolean(s.styles?.entryId || s.preview?.entryId);
    if (!scApproved && !hasWork) {
      return {state: 'locked', badge: '2', status: 'Сначала утвердите сценарий', cost, locked: true, approved: false, stale: false};
    }
    if (busyStep === 2) {
      return {state: 'generating', badge: '2', status: 'Генерация…', cost, locked: false, approved: false, stale: false};
    }
    if (s.preview?.stale || (!scApproved && hasWork)) {
      return {state: 'stale', badge: '⚠', status: '⚠ Устарело — пересоберите', cost, locked: false, approved: false, stale: true};
    }
    if (prevApproved) {
      return {state: 'approved', badge: '✓', status: '✓ Утверждено', cost, locked: false, approved: true, stale: false};
    }
    return {state: 'active', badge: '2', status: 'В работе', cost, locked: false, approved: false, stale: false};
  }

  // Step 3: Финал / Видео
  const cost = stepCostLabel(entries.final?.cost);
  const hasFinal = Boolean(s.final?.entryId);
  if (!prevApproved && !hasFinal) {
    return {state: 'locked', badge: '3', status: 'Сначала утвердите превью', cost, locked: true, approved: false, stale: false};
  }
  if (busyStep === 3) {
    return {state: 'generating', badge: '3', status: 'Генерация…', cost, locked: false, approved: false, stale: false};
  }
  if (s.final?.stale || (!prevApproved && hasFinal)) {
    return {state: 'stale', badge: '⚠', status: '⚠ Устарело — пересоберите', cost, locked: false, approved: false, stale: true};
  }
  if (hasFinal) {
    return {state: 'approved', badge: '✓', status: '✓ Готово', cost, locked: false, approved: true, stale: false};
  }
  return {state: 'active', badge: '3', status: 'В работе', cost, locked: false, approved: false, stale: false};
}

function combineStepCosts(c1, c2) {
  if (!c1 && !c2) return null;
  return {
    total: (c1?.total || 0) + (c2?.total || 0),
    unknown: Boolean(c1?.unknown || c2?.unknown),
  };
}

// Determines whether a step should render in read-only review mode (§8.2).
// Kept unlocked by default so the user can freely go back, edit the scenario, or pick/build a new visual direction.
export function isStepInReviewMode(campaign, stepNum) {
  if (!campaign) return false;
  return Boolean(state.reviewUnlocked[stepNum] === 'locked');
}

export function renderCampaignBar({onRename, onOpenSetup, onForkCampaign, onNewCampaign} = {}) {
  const bar = $('#campaignBar');
  const c = state.campaign;
  if (!c) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  const nameInput = $('#campaignName');
  if (document.activeElement !== nameInput) {
    nameInput.value = c.name || 'Новая кампания';
  }
  nameInput.onchange = () => {
    const val = nameInput.value.trim();
    if (val && val !== c.name) onRename?.(val);
    else nameInput.value = c.name || 'Новая кампания';
  };

  const setup = c.setup || {};
  $('#barKind').textContent = KIND_LABELS[setup.kind] || setup.kind || '';

  const langWrap = $('#barLanguages');
  langWrap.replaceChildren(
    ...(setup.languages || []).map((code, idx) => {
      const chip = document.createElement('span');
      chip.className = 'bar-chip' + (idx === 0 ? ' primary' : '');
      const info = language(code);
      chip.textContent = (idx === 0 ? '★ ' : '') + code.toUpperCase();
      chip.title = info.name + (idx === 0 ? ' (основной)' : '');
      return chip;
    })
  );

  const lenWrap = $('#barLengths');
  if (setup.kind === 'poster' || !(setup.lengths || []).length) {
    lenWrap.hidden = true;
    lenWrap.replaceChildren();
  } else {
    lenWrap.hidden = false;
    lenWrap.replaceChildren(
      ...(setup.lengths || []).map(l => {
        const chip = document.createElement('span');
        chip.className = 'bar-chip';
        chip.textContent = `${l} с`;
        return chip;
      })
    );
  }

  const fmtWrap = $('#barFormats');
  fmtWrap.replaceChildren(
    ...(setup.formats || []).map((id, idx) => {
      const chip = document.createElement('span');
      chip.className = 'bar-chip' + (idx === 0 ? ' primary' : '');
      const f = state.formatInfo[id] || {label: id};
      chip.textContent = (idx === 0 ? '★ ' : '') + f.label;
      return chip;
    })
  );

  const costPill = $('#campaignCost');
  costPill.textContent = stepCostLabel(c.cost);

  $('#campaignSummary').onclick = () => onOpenSetup?.();
  $('#forkCampaignBtn').onclick = () => onForkCampaign?.();
  $('#newCampaignBtn').onclick = () => onNewCampaign?.();
}

// Handlers survive re-renders that pass only {busyStep} (refreshUI does that after almost every action);
// without this, those re-renders replaced the step buttons' click handlers with no-ops.
const stepperHandlers = {onSelectStep: null, onSelectVariant: null};

export function renderStepper({busyStep = null, onSelectStep, onSelectVariant} = {}) {
  if (onSelectStep) stepperHandlers.onSelectStep = onSelectStep;
  if (onSelectVariant) stepperHandlers.onSelectVariant = onSelectVariant;
  const nav = $('#stepper');
  const c = state.campaign;
  nav.classList.toggle('muted', !c);

  const step3Title = c?.setup?.kind === 'poster' ? 'Финал' : 'Видео';
  const titles = {1: 'Сценарий', 2: 'Превью', 3: step3Title};

  const infos = {
    1: stepInfo(c, 1, busyStep),
    2: stepInfo(c, 2, busyStep),
    3: stepInfo(c, 3, busyStep),
  };

  for (const num of [1, 2, 3]) {
    const btn = $(`#stepBtn${num}`);
    const info = infos[num];
    const isCurrent = Boolean(c && state.activeStep === num);

    btn.className = `step-btn st-${info.state}${isCurrent ? ' is-current' : ''}`;
    if (isCurrent) btn.setAttribute('aria-current', 'step');
    else btn.removeAttribute('aria-current');

    btn.setAttribute('aria-disabled', String(info.locked));

    const numEl = btn.querySelector('.step-num');
    const titleEl = btn.querySelector('.step-title');
    const statusEl = btn.querySelector('.step-status');
    const costEl = btn.querySelector('.step-cost');

    if (numEl) numEl.textContent = info.badge;
    if (titleEl) titleEl.textContent = titles[num];
    if (statusEl) statusEl.textContent = info.status;
    if (costEl) costEl.textContent = info.cost;

    btn.onclick = () => {
      if (!c || info.locked) return;
      stepperHandlers.onSelectStep?.(num);
    };
  }

  $('#stepLine1').classList.toggle('done', Boolean(infos[1].approved && !infos[1].stale));
  $('#stepLine2').classList.toggle('done', Boolean(infos[2].approved && !infos[2].stale));

  // Small «Стиль: <label> ▾» menu next to the stepper (§4.3)
  const menuWrap = $('#stepperStyleMenu');
  const menuBtn = $('#stepperStyleBtn');
  const menuLabel = $('#stepperStyleLabel');
  const menuList = $('#stepperStyleList');
  if (menuWrap && menuBtn && menuLabel && menuList) {
    const variants = c?.variants || [];
    if (!c || !variants.length) {
      menuWrap.hidden = true;
      menuList.hidden = true;
      return;
    }
    menuWrap.hidden = false;
    const activeVar = variants.find(v => v.id === c.activeVariant) || variants[0];
    menuLabel.textContent = `Стиль: ${activeVar?.label || 'Стиль 1'}`;
    menuBtn.disabled = Boolean(busyStep);
    menuBtn.onclick = e => {
      e.stopPropagation();
      const open = menuList.hidden;
      menuList.hidden = !open;
      menuBtn.setAttribute('aria-expanded', String(open));
    };

    menuList.replaceChildren(
      ...variants.map(v => {
        const item = document.createElement('button');
        item.type = 'button';
        item.role = 'menuitem';
        item.className = 'stepper-style-item' + (v.id === c.activeVariant ? ' is-active' : '');
        const svg = v.styleSvg || v.style?.svg;
        if (svg) {
          const img = new Image(14, 14);
          img.className = 'style-swatch';
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
          img.alt = '';
          item.append(img);
        }
        const lbl = document.createElement('span');
        lbl.className = 'stepper-style-item-label';
        lbl.textContent = v.label || 'Стиль';
        item.append(lbl);

        const mark = document.createElement('small');
        mark.textContent = v.stale ? '⚠' : v.approved ? '✓' : '';
        item.append(mark);

        item.onclick = () => {
          menuList.hidden = true;
          menuBtn.setAttribute('aria-expanded', 'false');
          if (v.id !== c.activeVariant) {
            stepperHandlers.onSelectVariant?.(v.id);
          }
        };
        return item;
      })
    );
  }
}
