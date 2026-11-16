// Forma Studio — Flow v2 main client module (§8, §10, §11).
import {LANGUAGES, language} from '/shared/languages.mjs';
import {
  state,
  api,
  money,
  moneyPrecise,
  stepCostLabel,
  setCampaign,
  effectiveScenario,
  describeSetupInvalidation,
  createCampaign,
  forkCampaign,
  fetchCampaign,
  listCampaigns,
  patchCampaign,
  generateScenario,
  saveScenarioManual,
  translateScenario,
  recalcCuts,
  approveStep,
  proposeStyles,
  chooseStyle,
  renameVariant,
  switchActiveVariant,
  buildPreview,
  buildFinal,
  saveCopyPatch,
  fetchActiveRuns,
} from '/campaign.js';
import {renderCampaignBar, renderStepper, isStepInReviewMode} from '/stepper.js';
import {
  loadScenarioIntoEditor,
  bindScenarioControls,
  openCopyEditor,
} from '/scenario-editor.js';
import {
  view,
  frameURL,
  layoutArtboard,
  updatePlayer,
  showEmptyStage,
  showStage,
  initPlayerControls,
  restartPlayer,
  setVariantSwitchHandler,
} from '/player.js';

import {$, el} from './dom.js';
import {libraryCard, listBrands, listBrandCampaigns, saveBrand} from './brand-library.js';
const items = new Map();
let busy = false;
let busyStep = null;
let pending = 0;
let editingSetup = false;
let brandLibrary = [];
let editingBrand = null;
let importingCampaign = null;
let brandNavigation = 0;
let activeBrandId = '';
const selectedBrand = () => brandLibrary.find(b => b.id === activeBrandId);

let lastStepRetry = {1: null, 2: null, 3: null};

// Setup form state
const PRESET_LENGTHS = [4, 6, 8, 10, 15, 20, 30];
let setupDraft = {
  kind: 'multi',
  languages: ['ru', 'en'],
  lengths: [6, 15],
  formats: ['9x16', '1x1'],
};

const status = $('#status');
const mode = $('#mode');
const modelField = $('#model');
const effortField = $('#effort');
const finalModelField = $('#finalModel');
const finalEffortField = $('#finalEffort');
const formatPicker = $('#formats');
const choices = $('#choices');
const keyframe = $('#keyframe');
let previousCaption = '';

const providerName = {claude: 'Claude', codex: 'Codex', demo: 'Тестовый шаблон'};
const KIND_NAMES = {poster: 'Постер', single: 'Односценовое', multi: 'Многосценовое'};

// ---- Journal and live preview ----
const logList = $('#log');
const tailBox = $('#tail');
const live = $('#live');
const draftBadge = $('#draftBadge');
const journal = $('#journal');
let clientStart = Date.now();
let serverOffset = null;

const stamp = ms => '+' + (Math.max(0, ms) / 1000).toFixed(1) + 's';

function addLog({at, level = 'info', msg, detail, media, cost}) {
  const li = document.createElement('li');
  const time = document.createElement('time');
  const text = document.createElement('span');
  li.className = 'lv-' + level;
  time.textContent = stamp(at);
  text.textContent = msg;
  li.append(time, text);
  if (cost && !/\$/.test(msg)) {
    text.append(
      ' ',
      Object.assign(document.createElement('b'), {
        className: 'cost',
        textContent: typeof cost.usd === 'number' ? moneyPrecise(cost.usd) : 'цена ?',
      })
    );
  }
  if (media) {
    const mediaEl = document.createElement(media.kind === 'video' ? 'video' : 'img');
    mediaEl.src = media.url;
    mediaEl.className = 'thumb';
    mediaEl.title = media.file;
    if (media.kind === 'video') {
      mediaEl.muted = mediaEl.loop = mediaEl.autoplay = mediaEl.playsInline = true;
    }
    mediaEl.onclick = () => showLive(media);
    li.append(mediaEl);
    if (busy) showLive(media);
  }
  if (detail) {
    const box = document.createElement('details');
    const summary = document.createElement('summary');
    const pre = document.createElement('pre');
    summary.textContent = level === 'think' ? 'мысли' : 'подробнее';
    pre.textContent = detail;
    box.append(summary, pre);
    li.append(box);
  }
  const stick = logList.scrollTop + logList.clientHeight >= logList.scrollHeight - 40;
  const prev = logList.lastElementChild;
  if (level === 'think' && !detail) li.dataset.live = '1';
  if (level === 'think' && prev?.dataset.live) prev.replaceWith(li);
  else logList.append(li);
  journal.hidden = false;
  if (stick) logList.scrollTop = logList.scrollHeight;
}

const localLog = (msg, level = 'info', detail) => addLog({at: Date.now() - clientStart, level, msg, detail});

function costText(c) {
  if (!c) return '';
  const parts = [
    c.llm && 'LLM ' + moneyPrecise(c.llm),
    c.image && 'изображения ' + moneyPrecise(c.image),
    c.video && 'видео ' + moneyPrecise(c.video),
  ].filter(Boolean);
  return c.total || c.unknown
    ? '≈ ' + moneyPrecise(c.total) + (c.unknown ? ' + неизвестно' : '') + (parts.length > 1 ? ' (' + parts.join(' · ') + ')' : '')
    : '';
}

function showCosts(c) {
  $('#costNow').textContent = costText(c) ? 'по API ' + costText(c) : '';
}

function resetLog() {
  logList.replaceChildren();
  tailBox.hidden = true;
  tailBox.textContent = '';
  clientStart = Date.now();
  serverOffset = null;
  $('#costNow').textContent = '';
}

$('#clearLog').onclick = () => {
  logList.replaceChildren();
  if (!busy) journal.hidden = true;
};

function showLive(media) {
  const mediaEl = document.createElement(media.kind === 'video' ? 'video' : 'img');
  const badge = document.createElement('span');
  mediaEl.src = media.url;
  if (media.kind === 'video') {
    mediaEl.muted = mediaEl.loop = mediaEl.autoplay = mediaEl.playsInline = true;
  }
  badge.textContent =
    (media.attached ? 'Вложение · ' : 'Сгенерировано · ') +
    media.file +
    (typeof media.cost === 'number' ? ' · ' + moneyPrecise(media.cost) : '');
  live.replaceChildren(mediaEl, badge);
  live.hidden = false;
}

const hideLive = () => {
  live.hidden = true;
  live.replaceChildren();
};

function closeKeyframe() {
  if (!keyframe.hidden && previousCaption) $('#caption').textContent = previousCaption;
  keyframe.hidden = true;
  $('#replay').textContent = '↻ Повторить';
}

$('#replay').onclick = () => {
  if (!keyframe.hidden) closeKeyframe();
  restartPlayer();
};

function applyProgress(p, task, trackerState) {
  if (!p || p.missing) return;
  if (p.costs) {
    trackerState.costs = p.costs;
    showCosts(p.costs);
  }
  if (serverOffset === null) serverOffset = Date.now() - clientStart - p.elapsed;
  for (const e of p.events) addLog({...e, at: e.at + serverOffset});
  trackerState.since = p.next;
  if (p.status) trackerState.message = p.status;

  if ((task === 'creative' || task === 'preview' || task === 'final') && p.tail) {
    tailBox.hidden = false;
    tailBox.textContent = p.tail.split('\n').slice(-7).join('\n');
  }
  if ((task === 'creative' || task === 'preview' || task === 'final') && p.draft && p.draft.rev !== view.draftRev && !p.done) {
    hideLive();
    closeKeyframe();
    const emptyEl = $('#stageEmpty');
    const artboard = $('.artboard');
    if (emptyEl) emptyEl.hidden = true;
    if (artboard) artboard.hidden = false;
    view.url = p.draft.url;
    view.draftRev = p.draft.rev;
    view.stage = task === 'preview' ? 'preview' : 'final';
    view.timeline = false;
    updatePlayer();
    draftBadge.hidden = false;
    const frame = $('#stageFrame');
    if (frame) frame.src = frameURL({keepTime: false});
  }
  if (task === 'scenario' && typeof p.text === 'string' && p.text) {
    const streamBox = $('#scenarioStreamBox');
    const streamPre = $('#scenarioStreamPre');
    if (streamBox && streamPre) {
      streamBox.hidden = false;
      streamPre.textContent = p.text;
    }
  }
  if (task === 'style' && p.sketches?.length > trackerState.sketches) {
    trackerState.sketches = p.sketches.length;
    const emptyEl = $('#stageEmpty');
    const artboard = $('.artboard');
    if (emptyEl) emptyEl.hidden = true;
    if (artboard) artboard.hidden = false;
    if (keyframe.hidden) previousCaption = $('#caption').textContent;
    keyframe.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(p.sketches.at(-1));
    keyframe.hidden = false;
    $('#caption').textContent = 'Эскиз ' + trackerState.sketches + ' из 3';
  }
}

function startTracking(requestId, task, message, onStatus = () => {}) {
  const trackerState = {since: 0, message, sketches: 0, costs: null};
  let polling = null;
  let stopped = false;
  const started = Date.now();
  const poll = async () => {
    try {
      const r = await fetch('/api/render-progress/' + requestId + '?since=' + trackerState.since, {cache: 'no-store'});
      if (r.ok) applyProgress(await r.json(), task, trackerState);
    } catch {}
  };
  const loop = async () => {
    if (stopped) return;
    polling = poll();
    await polling;
    if (!stopped) setTimeout(loop, 800);
  };
  setTimeout(loop, 350);
  const tick = setInterval(() => {
    const text =
      trackerState.message +
      ' · ' +
      Math.floor((Date.now() - started) / 1000) +
      ' с' +
      (trackerState.costs?.total ? ' · ≈ ' + moneyPrecise(trackerState.costs.total) : '');
    status.textContent = text;
    onStatus(text);
  }, 500);
  return {
    state: trackerState,
    async stop() {
      stopped = true;
      clearInterval(tick);
      await polling;
      await poll();
    },
  };
}

// ---- Materials Upload ----
function displayMaterials() {
  const list = $('#list');
  list.replaceChildren();
  for (const name of items.keys()) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '×';
    btn.setAttribute('aria-label', 'Убрать ' + name);
    btn.onclick = () => {
      items.delete(name);
      displayMaterials();
    };
    li.append(document.createTextNode(name), btn);
    list.append(li);
  }
}

function addMaterial(f, n) {
  items.set(n || f.webkitRelativePath || f.name, f);
}

async function walkEntry(entry, prefix = '') {
  if (entry.isFile) {
    const file = await new Promise((ok, no) => entry.file(ok, no));
    addMaterial(file, prefix + file.name);
    return;
  }
  const reader = entry.createReader();
  while (true) {
    const batch = await new Promise((ok, no) => reader.readEntries(ok, no));
    if (!batch.length) break;
    for (const e of batch) await walkEntry(e, prefix + entry.name + '/');
  }
}

for (const [button, input] of [['choose', 'files'], ['folder', 'folders']]) {
  $('#' + button).onclick = () => $('#' + input).click();
  $('#' + input).onchange = e => {
    for (const f of e.target.files) addMaterial(f);
    displayMaterials();
    e.target.value = '';
  };
}

const drop = $('#drop');
drop.ondragover = e => {
  e.preventDefault();
  drop.classList.add('over');
};
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = async e => {
  e.preventDefault();
  drop.classList.remove('over');
  if (busy) return;
  pending++;
  refreshUI();
  try {
    const entries = Array.from(e.dataTransfer.items || [], i => i.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length) {
      for (const entry of entries) await walkEntry(entry);
    } else {
      for (const f of e.dataTransfer.files) addMaterial(f);
    }
    displayMaterials();
  } catch (err) {
    status.textContent = err.message;
  } finally {
    pending--;
    refreshUI();
  }
};

function showLibraryPage(page, title = '') {
  for (const id of ['brandsPage', 'campaignsPage', 'brandEditor', 'pipelinePage']) {
    $('#' + id).hidden = id !== page;
  }
  $('#libraryNav').hidden = page === 'brandsPage';
  const parent = page === 'pipelinePage' || (page === 'brandEditor' && editingBrand);
  $('#brandBack').hidden = !parent;
  $('#brandBack').textContent = selectedBrand()?.name || 'Без бренда';
  $('#currentCrumb').textContent = title;
  $('#brandMessage').textContent = '';
}

function renderBrandCards() {
  const cards = brandLibrary.map(b => libraryCard(b.name, 'Файлов: ' + b.files.length, () => openBrand(b.id), true));
  $('#brandCards').replaceChildren(...(cards.length ? cards : [el('p', 'library-empty', 'Добавьте первый бренд, чтобы создать кампанию с его материалами.')]));
}

function openBrands() {
  ++brandNavigation;
  setCampaign(null);
  editingSetup = false;
  closeBrandEditor();
  showLibraryPage('brandsPage');
  renderBrandCards();
  window.scrollTo(0, 0);
}

async function openBrand(id) {
  if (busy) return;
  const request = ++brandNavigation;
  activeBrandId = id || '';
  setCampaign(null);
  editingSetup = false;
  closeBrandEditor();
  const brand = selectedBrand();
  const title = brand?.name || 'Без бренда';
  showLibraryPage('campaignsPage', title);
  $('#brandHeading').textContent = title;
  $('#editBrand').hidden = $('#addCampaign').hidden = !brand;
  $('#campaignCards').replaceChildren(el('p', 'library-empty', 'Загрузка кампаний…'));
  window.scrollTo(0, 0);
  try {
    const list = await listBrandCampaigns(activeBrandId);
    if (request !== brandNavigation) return;
    const cards = list.map(c => libraryCard(c.name,
      [KIND_NAMES[c.kind], c.updatedAt && when(c.updatedAt)].filter(Boolean).join(' · '), () => openCampaign(c.id)));
    $('#campaignCards').replaceChildren(...(cards.length ? cards : [el('p', 'library-empty', 'Здесь пока нет кампаний.')]));
  } catch (err) {
    if (request === brandNavigation) $('#campaignCards').replaceChildren(el('p', 'library-empty', err.message));
  }
}

async function openCampaign(id) {
  const request = ++brandNavigation;
  try {
    const campaign = await fetchCampaign(id);
    if (request !== brandNavigation) return;
    editingSetup = false;
    setCampaign(campaign, {chooseStep:true});
    renderWorkspace();
    syncRightPaneToCampaign();
    window.scrollTo(0, 0);
  } catch (err) { if (request === brandNavigation) $('#brandMessage').textContent = err.message; }
}

$('#brandsHome').onclick = openBrands;
$('#brandBack').onclick = () => openBrand(activeBrandId);
$('#legacyCampaigns').onclick = () => openBrand('');
$('#addCampaign').onclick = () => { ++brandNavigation; beginCampaign(); };

function beginCampaign() {
  setCampaign(null);
  editingSetup = false;
  $('#newCampaignName').value = '';
  openThread(null);
  renderWorkspace();
  showEmptyStage('Настройте кампанию и утвердите сценарий');
  refreshUI();
}

function closeBrandEditor() {
  $('#brandEditor').hidden = true;
  editingBrand = null;
  importingCampaign = null;
  items.clear();
}

function editBrand(brand, source = null) {
  importingCampaign = source;
  $('#drop').hidden = Boolean(source);
  $('#importBrandNote').hidden = !source;
  $('#importBrandNote').textContent = source ? `В бренд войдут материалы кампании «${source.name}».` : '';
  editingBrand = brand;
  items.clear();
  for (const file of brand?.files || []) items.set(file.name, file);
  $('#brandName').value = brand?.name || source?.name || '';
  const title = brand ? 'Редактирование бренда' : 'Новый бренд';
  $('#editorHeading').textContent = title;
  showLibraryPage('brandEditor', title);
  $('#brandMessage').textContent = '';
  displayMaterials();
  $('#brandName').focus();
}

$('#addBrand').onclick = () => editBrand(null);
$('#editBrand').onclick = () => editBrand(selectedBrand());
$('#importBrand').onclick = () => editBrand(null, state.campaign);
$('#cancelBrand').onclick = () => {
  if (importingCampaign) {
    closeBrandEditor();
    renderWorkspace();
  } else if (editingBrand) openBrand(activeBrandId);
  else openBrands();
};
$('#brandEditor').onsubmit = async e => {
  e.preventDefault();
  if (busy || pending) return;
  busy = true;
  refreshUI();
  try {
    const brand = await saveBrand({
      name: $('#brandName').value,
      brand: editingBrand,
      campaign: importingCampaign,
      materials: items,
    });
    brandLibrary = [...brandLibrary.filter(b => b.id !== brand.id), brand];
    activeBrandId = brand.id;
    closeBrandEditor();
    busy = false;
    await openBrand(brand.id);
    if (!$('#campaignsPage').hidden && activeBrandId === brand.id) $('#brandMessage').textContent = 'Бренд сохранён.';
  } catch (err) { $('#brandMessage').textContent = err.message; }
  finally { busy = false; refreshUI(); }
};

// ---- Setup Card Controls (§8.3) ----

function renderKindCards() {
  const cards = [...document.querySelectorAll('#kindGroup .kind-card')];
  cards.forEach((card, idx) => {
    const on = card.dataset.kind === setupDraft.kind;
    card.setAttribute('aria-checked', String(on));
    card.tabIndex = on ? 0 : -1;
    const selectKind = k => {
      if (busy) return;
      setupDraft.kind = k;
      if (setupDraft.kind === 'multi') {
        setupDraft.lengths = setupDraft.lengths.filter(l => l >= 4);
        if (!setupDraft.lengths.length) setupDraft.lengths = [6, 15];
      } else if (setupDraft.kind === 'single') {
        if (!setupDraft.lengths.length) setupDraft.lengths = [6];
      }
      renderKindCards();
      renderLengthsPicker();
      validateSetupForm();
    };
    card.onclick = () => selectKind(card.dataset.kind);
    card.onkeydown = e => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = cards[(idx + 1) % cards.length];
        selectKind(next.dataset.kind);
        next.focus();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = cards[(idx - 1 + cards.length) % cards.length];
        selectKind(prev.dataset.kind);
        prev.focus();
      }
    };
  });
}

function renderLangChips() {
  const box = $('#langChips');
  box.replaceChildren(
    ...setupDraft.languages.map((code, idx) => {
      const info = language(code);
      const chip = el('span', 'lang-chip' + (idx === 0 ? ' is-primary' : ''));

      const star = el('button', 'lang-star', '★');
      star.type = 'button';
      star.title = idx === 0 ? 'Основной язык' : 'Сделать основным языком';
      star.setAttribute('aria-pressed', String(idx === 0));
      star.onclick = () => {
        if (busy || idx === 0) return;
        setupDraft.languages = [code, ...setupDraft.languages.filter(c => c !== code)];
        renderLangChips();
        validateSetupForm();
      };

      const label = el('span', 'lang-label', `${code.toUpperCase()} · ${info.name}`);
      if (idx === 0) {
        const badge = el('small', 'primary-tag', 'основной');
        label.append(' ', badge);
      }

      const rm = el('button', 'lang-remove', '×');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'Убрать ' + info.name);
      rm.onclick = () => {
        if (busy) return;
        setupDraft.languages = setupDraft.languages.filter(c => c !== code);
        renderLangChips();
        validateSetupForm();
      };

      chip.append(star, label, rm);
      return chip;
    })
  );
}

let langActiveIndex = 0;
function renderLangDropdown(query = '') {
  const dd = $('#langDropdown');
  const q = query.trim().toLowerCase();
  const matches = LANGUAGES.filter(
    l => !setupDraft.languages.includes(l.code) && (!q || l.code.toLowerCase().includes(q) || l.name.toLowerCase().includes(q))
  );
  if (!matches.length) {
    dd.hidden = true;
    return;
  }
  if (langActiveIndex >= matches.length) langActiveIndex = 0;
  dd.replaceChildren(
    ...matches.map((l, idx) => {
      const btn = el('button', 'lang-opt' + (idx === langActiveIndex ? ' is-active' : ''));
      btn.type = 'button';
      btn.innerHTML = `<strong>${l.code.toUpperCase()}</strong> <span>${l.name}</span>${l.dir === 'rtl' ? ' <small>RTL</small>' : ''}`;
      btn.onmousedown = e => {
        e.preventDefault();
        setupDraft.languages.push(l.code);
        $('#langSearch').value = '';
        dd.hidden = true;
        renderLangChips();
        validateSetupForm();
      };
      return btn;
    })
  );
  dd.hidden = false;
}

$('#langSearch').onfocus = () => { langActiveIndex = 0; renderLangDropdown($('#langSearch').value); };
$('#langSearch').oninput = () => { langActiveIndex = 0; renderLangDropdown($('#langSearch').value); };
$('#langSearch').onblur = () => setTimeout(() => { $('#langDropdown').hidden = true; }, 150);
$('#langSearch').onkeydown = e => {
  const dd = $('#langDropdown');
  const opts = [...dd.querySelectorAll('button')];
  if (e.key === 'ArrowDown' && opts.length) {
    e.preventDefault();
    langActiveIndex = (langActiveIndex + 1) % opts.length;
    renderLangDropdown($('#langSearch').value);
  } else if (e.key === 'ArrowUp' && opts.length) {
    e.preventDefault();
    langActiveIndex = (langActiveIndex - 1 + opts.length) % opts.length;
    renderLangDropdown($('#langSearch').value);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const target = opts[langActiveIndex] || opts[0];
    if (target) target.dispatchEvent(new MouseEvent('mousedown'));
  } else if (e.key === 'Escape') {
    dd.hidden = true;
  }
};

function renderLengthsPicker() {
  const sec = $('#lengthsSection');
  if (setupDraft.kind === 'poster') {
    sec.hidden = true;
    return;
  }
  sec.hidden = false;
  const minLen = setupDraft.kind === 'multi' ? 4 : 2;
  const allNums = [...new Set([...PRESET_LENGTHS, ...setupDraft.lengths])].filter(n => n >= minLen).sort((a, b) => a - b);
  const box = $('#lengthPresets');
  box.replaceChildren(
    ...allNums.map(n => {
      const btn = el('button', '', `${n} с`);
      btn.type = 'button';
      const on = setupDraft.lengths.includes(n);
      btn.setAttribute('aria-pressed', String(on));
      btn.onclick = () => {
        if (busy) return;
        if (on) {
          setupDraft.lengths = setupDraft.lengths.filter(x => x !== n);
        } else {
          setupDraft.lengths = [...setupDraft.lengths, n].sort((a, b) => a - b);
        }
        renderLengthsPicker();
        validateSetupForm();
      };
      return btn;
    })
  );
}

$('#customLengthBtn').onclick = () => {
  const wrap = $('#customLengthWrap');
  wrap.hidden = !wrap.hidden;
  if (!wrap.hidden) {
    $('#customLengthInput').min = setupDraft.kind === 'multi' ? '4' : '2';
    $('#customLengthInput').focus();
  }
};

$('#customLengthAdd').onclick = () => {
  const minLen = setupDraft.kind === 'multi' ? 4 : 2;
  const val = Math.round(Number($('#customLengthInput').value));
  if (!Number.isFinite(val) || val < minLen || val > 60) {
    $('#setupReason').textContent = `Введите длину от ${minLen} до 60 секунд.`;
    return;
  }
  if (!setupDraft.lengths.includes(val)) {
    setupDraft.lengths = [...setupDraft.lengths, val].sort((a, b) => a - b);
  }
  $('#customLengthInput').value = '';
  $('#customLengthWrap').hidden = true;
  renderLengthsPicker();
  validateSetupForm();
};

function renderFormatPicker() {
  formatPicker.replaceChildren(
    ...Object.values(state.formatInfo).map(f => {
      const b = document.createElement('button');
      const small = document.createElement('small');
      b.type = 'button';
      b.dataset.id = f.id;
      const idx = setupDraft.formats.indexOf(f.id);
      const on = idx >= 0;
      b.append((idx === 0 ? '★ ' : '') + f.label);
      small.textContent = idx === 0 ? f.name + ' · основной' : f.name;
      b.append(small);
      b.setAttribute('aria-pressed', String(on));
      b.onclick = () => {
        if (busy) return;
        if (on) {
          setupDraft.formats = setupDraft.formats.filter(x => x !== f.id);
        } else {
          setupDraft.formats = [...setupDraft.formats, f.id];
        }
        renderFormatPicker();
        validateSetupForm();
      };
      return b;
    })
  );
}

// ---- Model selection ----
function fillOptions(field, values, preferred) {
  field.replaceChildren(...values.map(value => new Option(value, value)));
  if (values.length) {
    field.value = values.includes(preferred) ? preferred : values[0];
  }
}

function updateEffort(mField = modelField, eField = effortField, providerMode = mode.value) {
  const values = state.config?.models?.[providerMode]?.[mField.value] || [];
  fillOptions(eField, values, eField.value || 'high');
}

function updateModelSummaryText() {
  const selected = mode.value;
  if (selected === 'demo') {
    $('#modelSummaryText').textContent = 'Тестовый шаблон · без токенов';
  } else {
    const pName = providerName[selected] || selected;
    $('#modelSummaryText').textContent = [pName, modelField.value, effortField.value].filter(Boolean).join(' · ');
  }
}

async function refreshStatus() {
  try {
    const fresh = await (await api('/api/status')).json();
    state.config = fresh;
    refreshUI();
  } catch {}
}

function updateModels() {
  $('#options').hidden = mode.value === 'demo';
  if (mode.value === 'codex' && state.config?.chatReady) {
    $('#billing').value = 'chatgpt';
  }
  const modelsList = Object.keys(state.config?.models?.[mode.value] || {});
  fillOptions(modelField, modelsList, modelField.value);
  updateEffort(modelField, effortField, mode.value);
  // Step 3 per-step model select defaults to setup model
  fillOptions(finalModelField, modelsList, finalModelField.value || modelField.value);
  updateEffort(finalModelField, finalEffortField, mode.value);
  updateModelSummaryText();
  refreshUI();
  refreshStatus();
}

$('#modelSummaryBtn').onclick = () => {
  const details = $('#modelDetails');
  details.hidden = !details.hidden;
  $('#modelSummaryBtn').setAttribute('aria-expanded', String(!details.hidden));
};

mode.onchange = updateModels;
modelField.onchange = () => {
  updateEffort(modelField, effortField, mode.value);
  updateModelSummaryText();
};
effortField.onchange = updateModelSummaryText;
finalModelField.onchange = () => updateEffort(finalModelField, finalEffortField, state.campaign?.setup?.provider?.mode || mode.value);
$('#claudeBilling').onchange = () => { refreshUI(); refreshStatus(); };
$('#billing').onchange = () => { refreshUI(); refreshStatus(); };
$('#mediaImages').onchange = () => refreshUI();
$('#mediaVideo').onchange = () => refreshUI();

function currentProviderObject() {
  const m = mode.value;
  const billing = m === 'codex' ? $('#billing').value : m === 'claude' ? $('#claudeBilling').value : 'api';
  return {
    mode: m,
    billing,
    model: m === 'demo' ? null : modelField.value || null,
    effort: m === 'demo' ? null : effortField.value || null,
  };
}

function isProviderReady(provMode = mode.value, billingVal) {
  const cfg = state.config;
  if (!cfg) return false;
  if (provMode === 'demo') return true;
  if (provMode === 'claude') {
    const sub = (billingVal ?? $('#claudeBilling').value) === 'subscription';
    return sub ? Boolean(cfg.claudeSubscription) : Boolean(cfg.ready);
  }
  if (provMode === 'codex') {
    const chat = (billingVal ?? $('#billing').value) === 'chatgpt';
    return chat ? Boolean(cfg.chatReady) : Boolean(cfg.codexReady);
  }
  return false;
}

function validateSetupForm() {
  const reasonEl = $('#setupReason');
  const btn = $('#startCampaignBtn');
  let reason = '';

  if (!['poster', 'single', 'multi'].includes(setupDraft.kind)) {
    reason = 'Выберите тип креатива.';
  } else if (!setupDraft.languages.length) {
    reason = 'Выберите хотя бы один язык кампании.';
  } else if (setupDraft.kind !== 'poster') {
    const minLen = setupDraft.kind === 'multi' ? 4 : 2;
    if (!setupDraft.lengths.length) {
      reason = 'Выберите хотя бы одну длину ролика.';
    } else if (setupDraft.lengths.some(l => l < minLen || l > 60)) {
      reason = `Длина ролика должна быть от ${minLen} до 60 секунд.`;
    }
  }
  if (!reason && !state.campaign && !selectedBrand()) reason = 'Выберите бренд или создайте новый.';
  if (!reason && !setupDraft.formats.length) {
    reason = 'Выберите хотя бы один формат.';
  }
  const providerWarning = !reason && !isProviderReady()
    ? ($('#hint').textContent || 'Выбранный провайдер не настроен.')
    : '';

  reasonEl.textContent = reason || providerWarning;
  // Allow saving settings when editing an existing campaign even if status check is pending
  btn.disabled = Boolean(reason) || (!editingSetup && Boolean(providerWarning)) || busy || pending > 0 || !state.config;
  return !reason;
}

// ---- Step Panels & Workspace Rendering ----

function syncSetupDraftFromCampaign(c) {
  if (!c?.setup) return;
  setupDraft = {
    kind: c.setup.kind,
    languages: [...(c.setup.languages || ['en'])],
    lengths: [...(c.setup.lengths || [])],
    formats: [...(c.setup.formats || ['1x1'])],
  };
  if (c.setup.provider) {
    mode.value = c.setup.provider.mode || 'demo';
    if (c.setup.provider.mode === 'claude' && c.setup.provider.billing) {
      $('#claudeBilling').value = c.setup.provider.billing;
    }
    if (c.setup.provider.mode === 'codex' && c.setup.provider.billing) {
      $('#billing').value = c.setup.provider.billing;
    }
    const modelsList = Object.keys(state.config?.models?.[mode.value] || {});
    fillOptions(modelField, modelsList, c.setup.provider.model);
    updateEffort(modelField, effortField, mode.value);
    if (c.setup.provider.effort) effortField.value = c.setup.provider.effort;
  }
  renderKindCards();
  renderLangChips();
  renderLengthsPicker();
  renderFormatPicker();
  updateModelSummaryText();
  validateSetupForm();
}

function renderStep1Panel() {
  const c = state.campaign;
  if (!c) return;
  const s = c.steps?.scenario || {};
  const scEntry = c.entries?.scenario;
  const scenarioObj = scEntry?.output?.scenario || null;
  const reviewMode = isStepInReviewMode(c, 1);

  const banner = $('#step1Banner');
  const bannerText = $('#step1BannerText');
  const unlockBtn = $('#step1ReviewUnlockBtn');

  if (s.stale) {
    banner.hidden = false;
    banner.className = 'step-banner warn';
    bannerText.textContent = 'Настройки кампании изменились. Сценарий устарел — перегенерируйте или обновите его.';
    unlockBtn.hidden = false;
    unlockBtn.textContent = 'Пересобрать';
    unlockBtn.onclick = () => $('#generateScenarioBtn').click();
  } else if (s.needs?.length) {
    banner.hidden = false;
    banner.className = 'step-banner warn';
    const needParts = [];
    if (s.needs.includes('translation')) needParts.push('перевод на новые языки');
    if (s.needs.includes('cuts')) needParts.push('расчёт нарезки по длинам');
    bannerText.textContent = 'Настройки изменились: требуется ' + needParts.join(' и ') + '.';
    unlockBtn.hidden = true;
  } else if (s.approvedAt) {
    banner.hidden = false;
    banner.className = 'step-banner ok';
    bannerText.textContent = '✓ Сценарий утверждён. Вы можете править его здесь или ответвить новый пайплайн.';
    unlockBtn.hidden = false;
    unlockBtn.textContent = '⎘ В новую ветку';
    unlockBtn.onclick = () => handleForkCampaign({targetStep: 1});
  } else {
    banner.hidden = true;
  }

  loadScenarioIntoEditor(scenarioObj, {readOnly: reviewMode});
}

let pickingOtherDirection = false;

async function handleSwitchVariant(variantId, {targetStep = null} = {}) {
  if (busy || !state.campaign) return;
  try {
    pickingOtherDirection = false;
    const updated = variantId !== state.campaign.activeVariant
      ? await switchActiveVariant(state.campaign.id, variantId)
      : state.campaign;
    setCampaign(updated);
    if (targetStep) state.activeStep = targetStep;
    renderWorkspace();
    syncRightPaneToCampaign({keepTime: true});
  } catch (e) {
    status.textContent = e.message;
  }
}

function variantStatusText(v) {
  if (v.finalPath && !v.finalStale) return {text: '✓ Финал', cls: 'st-ok'};
  if (v.previewStale || v.finalStale) return {text: '⚠ Устарело', cls: 'st-warn'};
  if (v.previewApproved) return {text: '✓ Утверждено', cls: 'st-ok'};
  if (v.previewPath) return {text: 'Превью', cls: 'st-active'};
  if (v.styles?.chosenIndex !== null && v.styles?.chosenIndex !== undefined) return {text: 'Эскиз выбран', cls: 'st-active'};
  return {text: 'Черновик', cls: 'st-muted'};
}

function renderVariantsStrip() {
  const c = state.campaign;
  const listEl = $('#variantsList');
  const pickOtherBtn = $('#pickOtherDirectionBtn');
  const newPitchBtn = $('#newStylesPitchBtn');
  if (!c || !listEl) return;

  const variants = c.variants || [];
  const prevEntry = c.entries?.preview;
  const styles = c.entries?.styles?.output?.styles || [];

  listEl.replaceChildren(
    ...variants.map(v => {
      const isActive = v.id === c.activeVariant;
      const row = el('div', 'variant-row' + (isActive ? ' is-active' : ''));
      row.setAttribute('role', 'listitem');
      row.onclick = e => {
        if (e.target.tagName === 'INPUT') return;
        if (v.id !== c.activeVariant) handleSwitchVariant(v.id);
      };

      const svg = v.styleSvg || v.style?.svg;
      if (svg) {
        const img = new Image(14, 14);
        img.className = 'style-swatch';
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        img.alt = '';
        row.append(img);
      } else {
        row.append(el('span', 'style-swatch-empty'));
      }

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'variant-label-input';
      nameInput.value = v.label || 'Стиль';
      nameInput.setAttribute('aria-label', 'Название стиля');
      nameInput.disabled = busy;
      nameInput.onchange = async () => {
        const nextLabel = nameInput.value.trim();
        if (!nextLabel || nextLabel === v.label) {
          nameInput.value = v.label || 'Стиль';
          return;
        }
        try {
          const updated = await renameVariant(c.id, v.id, nextLabel);
          setCampaign(updated);
          renderWorkspace();
          syncRightPaneToCampaign({keepTime: true});
          refreshHistory();
        } catch (err) {
          nameInput.value = v.label || 'Стиль';
          status.textContent = err.message;
        }
      };
      row.append(nameInput);

      if (v.author) {
        row.append(el('span', 'variant-author', v.author));
      }

      const st = variantStatusText(v);
      row.append(el('span', 'variant-status ' + st.cls, st.text));

      const costText = stepCostLabel(v.cost);
      if (costText) {
        row.append(el('span', 'pill', costText));
      }

      return row;
    })
  );

  if (newPitchBtn) {
    newPitchBtn.disabled = busy;
  }
  if (pickOtherBtn) {
    const canPickOther = Boolean(styles.length && prevEntry?.output?.path);
    pickOtherBtn.hidden = !canPickOther;
    pickOtherBtn.disabled = busy;
    pickOtherBtn.setAttribute('aria-pressed', String(pickingOtherDirection));
  }
}

function renderStyleCards(styles = [], chosenIndex = null, cardsLocked = false) {
  choices.replaceChildren();
  if (!Array.isArray(styles) || !styles.length) {
    choices.hidden = true;
    return;
  }
  choices.hidden = false;
  styles.forEach((option, idx) => {
    const button = document.createElement('button');
    const img = new Image();
    button.type = 'button';
    const isChosen = !pickingOtherDirection && idx === chosenIndex;
    button.setAttribute('aria-pressed', String(isChosen));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(option.svg);
    img.alt = '';
    const name = el('strong', '', option.name);
    const idea = el('span', '', option.idea);
    button.append(img, name, idea);
    button.disabled = busy || cardsLocked;
    button.onclick = async () => {
      if (busy || cardsLocked) return;
      const defaultDir = [option.name, option.idea, option.direction].filter(Boolean).join('\n\n');
      $('#styleDirection').value = defaultDir;
      $('#styleDirectionBox').hidden = false;
      for (const sib of choices.children) sib.setAttribute('aria-pressed', String(sib === button));
      if (keyframe.hidden) previousCaption = $('#caption').textContent;
      keyframe.src = img.src;
      keyframe.hidden = false;
      $('#caption').textContent = 'Эскиз · ' + option.name;
      try {
        pickingOtherDirection = false;
        const updated = await chooseStyle(state.campaign.id, {index: idx, direction: defaultDir});
        setCampaign(updated);
        renderWorkspace();
        syncRightPaneToCampaign();
        refreshHistory();
      } catch (e) {
        status.textContent = e.message;
      }
    };
    choices.append(button);
  });
}

function renderStep2Panel() {
  const c = state.campaign;
  if (!c) return;
  const s = c.steps || {};
  const stEntry = c.entries?.styles;
  const prevEntry = c.entries?.preview;
  const styles = stEntry?.output?.styles || [];
  const chosenIndex = s.styles?.chosenIndex;
  const reviewMode = isStepInReviewMode(c, 2);

  renderVariantsStrip();

  const banner = $('#step2Banner');
  const bannerText = $('#step2BannerText');
  const unlockBtn = $('#step2ReviewUnlockBtn');
  const rebuildBtn = $('#step2RebuildBtn');

  if (s.preview?.stale) {
    banner.hidden = false;
    banner.className = 'step-banner warn';
    bannerText.textContent = 'Сценарий изменился после сборки превью. Превью устарело — пересоберите его, чтобы двигаться дальше.';
    unlockBtn.hidden = true;
    rebuildBtn.hidden = false;
    rebuildBtn.onclick = () => handleBuildPreview();
  } else if (s.preview?.approvedAt && prevEntry) {
    banner.hidden = false;
    banner.className = 'step-banner ok';
    bannerText.textContent = '✓ Превью утверждено. Вы можете переключиться на другой стиль или добавить новый.';
    unlockBtn.hidden = true;
    rebuildBtn.hidden = false;
    rebuildBtn.onclick = () => handleBuildPreview();
  } else {
    banner.hidden = true;
  }

  $('#proposeStylesBtn').disabled = busy || reviewMode;
  const cardsLocked = reviewMode || (Boolean(prevEntry?.output?.path) && !pickingOtherDirection);
  renderStyleCards(styles, chosenIndex, cardsLocked);

  const dirBox = $('#styleDirectionBox');
  if (styles.length && (chosenIndex !== null && chosenIndex !== undefined)) {
    dirBox.hidden = false;
    const chosen = styles[chosenIndex];
    const defaultDir = [chosen?.name, chosen?.idea, chosen?.direction].filter(Boolean).join('\n\n');
    if (document.activeElement !== $('#styleDirection')) {
      $('#styleDirection').value = s.styles?.direction || defaultDir;
    }
    $('#styleDirection').disabled = busy || reviewMode;
    $('#buildPreviewBtn').disabled = busy || reviewMode;
    $('#buildPreviewBtn').textContent = prevEntry ? 'Пересобрать превью' : 'Собрать превью';
  } else {
    dirBox.hidden = true;
  }

  const approveBox = $('#step2ApproveBox');
  if (prevEntry?.output?.path) {
    approveBox.hidden = false;
    const isApproved = Boolean(s.preview?.approvedAt && !s.preview?.stale);
    $('#approvePreviewBtn').disabled = busy || Boolean(s.preview?.stale);
    $('#approvePreviewBtn').textContent = isApproved ? '✓ Превью утверждено — к финалу →' : 'Утвердить превью →';
  } else {
    approveBox.hidden = true;
  }
}

function renderStep3Panel() {
  const c = state.campaign;
  if (!c) return;
  const setup = c.setup || {};
  const s = c.steps || {};
  const isPoster = setup.kind === 'poster';

  $('#step3Heading').textContent = isPoster ? 'Шаг 3 · Финал (Постер)' : 'Шаг 3 · Видео';
  $('#buildFinalBtn').textContent = isPoster ? 'Собрать финал' : 'Собрать видео';

  const banner = $('#step3Banner');
  banner.hidden = !s.final?.stale;
  $('#step3RebuildBtn').onclick = () => handleBuildFinal();

  const fCount = (setup.formats || []).length;
  const lCount = (setup.languages || []).length;
  const dCount = (setup.lengths || []).length;
  const summaryEl = $('#finalSummary');
  if (isPoster) {
    const total = fCount * lCount;
    summaryEl.textContent = `Будет собрано: ${fCount} формат(а) × ${lCount} язык(а) = ${total} вариант(ов)`;
  } else {
    const total = fCount * lCount * dCount;
    summaryEl.textContent = `Будет собрано: ${fCount} формат(а) × ${lCount} язык(а) × ${dCount} длин(ы) = ${total} вариант(ов)`;
  }

  $('#finalVideoLabel').hidden = isPoster;
  const provMode = setup.provider?.mode || 'demo';
  $('#finalModelBox').hidden = provMode === 'demo';
  if (provMode !== 'demo') {
    const modelsList = Object.keys(state.config?.models?.[provMode] || {});
    const stepOv = setup.stepModels?.final || setup.provider || {};
    fillOptions(finalModelField, modelsList, stepOv.model || finalModelField.value);
    updateEffort(finalModelField, finalEffortField, provMode);
    if (stepOv.effort) finalEffortField.value = stepOv.effort;
  }

  const hasFinalOrPreview = Boolean(c.entries?.final?.output?.path || c.entries?.preview?.output?.path);
  $('#openCopyBtn').hidden = !hasFinalOrPreview;
}

function syncRightPaneToCampaign({keepTime = false} = {}) {
  const c = state.campaign;
  if (!c) {
    $('#openCopyTopBtn').hidden = true;
    return;
  }
  const setup = c.setup || {};
  const scObj = effectiveScenario(state.activeStep === 2 ? 'preview' : 'final');
  const scenesList = (scObj?.scenes || []).map(s => ({id: s.id, beat: s.beat}));
  const finalEntry = c.entries?.final;
  const previewEntry = c.entries?.preview;

  const canEditCopy = Boolean((finalEntry?.output?.path || previewEntry?.output?.path) && scObj);
  $('#openCopyTopBtn').hidden = !canEditCopy;

  // On Step 2, prefer showing the preview (with storyboard) if built
  if (state.activeStep === 2 && previewEntry?.output?.path) {
    closeKeyframe();
    showStage({
      url: state.config.previewURL + previewEntry.output.path,
      stage: 'preview',
      kind: setup.kind,
      formats: [previewEntry.output.format || setup.formats?.[0] || '1x1'],
      langs: [previewEntry.output.lang || setup.languages?.[0] || 'en'],
      lengths: [],
      duration: 0,
      scenes: scenesList,
      keepTime,
    });
    $('#caption').textContent = `Превью · ${entryCaption(previewEntry)}`;
    openThread(previewEntry.id);
    return;
  }

  // On Step 3 or Step 1 (or Step 2 if preview not built), show the final if available
  if (finalEntry?.output?.path) {
    closeKeyframe();
    showStage({
      url: state.config.previewURL + finalEntry.output.path,
      stage: 'final',
      kind: setup.kind,
      formats: finalEntry.output.formats || setup.formats,
      langs: finalEntry.output.langs || setup.languages,
      lengths: finalEntry.output.lengths || setup.lengths,
      duration: setup.lengths?.[0] || 8,
      scenes: scenesList,
      keepTime,
    });
    $('#caption').textContent = `Финал · ${entryCaption(finalEntry)}`;
    openThread(finalEntry.id);
    return;
  }

  // Otherwise show the preview if available (even when viewing Step 1)
  if (previewEntry?.output?.path) {
    closeKeyframe();
    showStage({
      url: state.config.previewURL + previewEntry.output.path,
      stage: 'preview',
      kind: setup.kind,
      formats: [previewEntry.output.format || setup.formats?.[0] || '1x1'],
      langs: [previewEntry.output.lang || setup.languages?.[0] || 'en'],
      lengths: [],
      duration: 0,
      scenes: scenesList,
      keepTime,
    });
    $('#caption').textContent = `Превью · ${entryCaption(previewEntry)}`;
    openThread(previewEntry.id);
    return;
  }

  // If a style sketch is chosen before preview HTML is built, show the sketch in keyframe
  const chosenIdx = c.steps?.styles?.chosenIndex;
  const chosenStyle = c.entries?.styles?.output?.styles?.[chosenIdx];
  if (chosenStyle?.svg) {
    openThread(null);
    showEmptyStage('Здесь появится превью после шага «Сценарий»');
    $('#stageEmpty').hidden = true;
    $('.artboard').hidden = false;
    layoutArtboard();
    keyframe.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(chosenStyle.svg);
    keyframe.hidden = false;
    $('#caption').textContent = 'Эскиз · ' + chosenStyle.name;
    return;
  }

  // No preview/final yet
  closeKeyframe();
  openThread(null);
  showEmptyStage('Здесь появится превью после шага «Сценарий»');
  $('#caption').textContent = c.name || 'Новая кампания';
}

function renderWorkspace() {
  const c = state.campaign;
  if (c) activeBrandId = c.brandId || '';
  showLibraryPage('pipelinePage', c?.name || 'Новая кампания');
  $('#newCampaignBtn').hidden = !selectedBrand();
  $('#importBrand').hidden = !c || Boolean(c.brandId);
  $('#newCampaignNameGroup').hidden = Boolean(c);
  const setupCard = $('#brief');
  const s1 = $('#step1Panel');
  const s2 = $('#step2Panel');
  const s3 = $('#step3Panel');

  renderCampaignBar({
    onRename: async name => {
      try {
        const updated = await patchCampaign(c.id, {name});
        setCampaign(updated);
        renderWorkspace();
      } catch (e) {
        status.textContent = e.message;
      }
    },
    onOpenSetup: () => {
      editingSetup = !editingSetup;
      if (editingSetup) {
        syncSetupDraftFromCampaign(state.campaign);
        refreshStatus();
      }
      renderWorkspace();
    },
    onForkCampaign: () => {
      if (busy) return;
      handleForkCampaign({targetStep: 2});
    },
    onNewCampaign: () => {
      if (busy) return;
      beginCampaign();
      refreshHistory();
    },
  });

  renderStepper({
    busyStep,
    onSelectStep: num => {
      if (busy) return;
      editingSetup = false;
      state.activeStep = num;
      renderWorkspace();
      syncRightPaneToCampaign();
    },
    onSelectVariant: vid => {
      if (busy) return;
      handleSwitchVariant(vid);
    },
  });

  if (!c || editingSetup) {
    setupCard.hidden = false;
    $('#setupPopoverHead').hidden = !c;
    $('#setupCancelEditBtn').hidden = !c;
    $('#startCampaignBtn .label').textContent = c ? 'Сохранить настройки' : 'Начать — к сценарию →';
    s1.hidden = true;
    s2.hidden = true;
    s3.hidden = true;
    validateSetupForm();
    return;
  }

  setupCard.hidden = true;
  s1.hidden = state.activeStep !== 1;
  s2.hidden = state.activeStep !== 2;
  s3.hidden = state.activeStep !== 3;

  if (state.activeStep === 1) renderStep1Panel();
  else if (state.activeStep === 2) renderStep2Panel();
  else if (state.activeStep === 3) renderStep3Panel();
}

$('#setupPopoverClose').onclick = $('#setupCancelEditBtn').onclick = () => {
  editingSetup = false;
  renderWorkspace();
};

function setStepError(stepNum, msg, retryFn = null) {
  const box = $(`#step${stepNum}Error`);
  const txt = $(`#step${stepNum}ErrorText`);
  const btn = $(`#step${stepNum}RetryBtn`);
  if (!box || !txt || !btn) return;
  if (!msg) {
    box.hidden = true;
    txt.textContent = '';
    return;
  }
  box.hidden = false;
  txt.textContent = msg;
  lastStepRetry[stepNum] = retryFn;
  btn.hidden = !retryFn;
  btn.onclick = () => {
    box.hidden = true;
    lastStepRetry[stepNum]?.();
  };
}

let toastTimer = null;
function showToast(msg, durationMs = 4500) {
  const box = $('#toastAlert');
  if (!box) return;
  box.textContent = msg;
  box.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, durationMs);
}

function renderStoreStatusPill() {
  const pill = $('#storeStatusPill');
  const txt = $('#storeStatusText');
  if (!pill || !txt) return;
  const st = state.config?.store;
  if (!st || st.driver === 'file') {
    pill.classList.remove('is-error');
    pill.removeAttribute('title');
    txt.textContent = 'Локальный стенд';
    return;
  }
  const authorLabel = st.author || 'автор';
  txt.textContent = `Облако · ${authorLabel}`;
  if (!st.ready || st.error) {
    pill.classList.add('is-error');
    pill.title = st.error || 'Хранилище недоступно';
  } else {
    pill.classList.remove('is-error');
    pill.removeAttribute('title');
  }
}

function refreshUI() {
  const cfg = state.config;
  renderStoreStatusPill();
  const demo = mode.value === 'demo';
  const codex = mode.value === 'codex';
  const chat = codex && $('#billing').value === 'chatgpt';
  $('#billingRow').hidden = !codex;
  $('#billing').disabled = busy;
  const subscription = mode.value === 'claude' && $('#claudeBilling').value === 'subscription';
  $('#claudeBillingRow').hidden = mode.value !== 'claude';
  $('#claudeBilling').disabled = busy;
  const ready = isProviderReady();
  const key = codex ? 'CODEX_API_KEY' : 'ANTHROPIC_API_KEY';
  $('#hint').textContent = demo
    ? 'Проверка всего флоу на демо-шаблонах без расхода токенов.'
    : subscription
      ? ready
        ? 'Используется квота вашей подписки Claude.'
        : 'В папке стенда выполните npm run claude:login и обновите страницу.'
      : chat
        ? ready
          ? 'Генерация использует лимит Codex вашей подписки ChatGPT.'
          : 'Войдите через ChatGPT командой codex login.'
        : ready
          ? 'Бриф и материалы будут отправлены ' + (codex ? 'OpenAI.' : 'Anthropic.')
          : 'Добавьте ' + key + ' в .env и перезапустите сервер.';

  const mediaReady = Boolean(cfg?.media?.ready);
  const campMode = state.campaign?.setup?.provider?.mode || mode.value;
  $('#mediaRow').hidden = campMode === 'demo';
  for (const box of [$('#mediaImages'), $('#mediaVideo')]) box.disabled = busy || !mediaReady;
  $('#mediaHint').textContent = !cfg
    ? ''
    : mediaReady
      ? $('#mediaImages').checked || $('#mediaVideo').checked
        ? 'Модель сама решит, что сгенерировать, и проверит результат. Лимит на сборку: ' +
          cfg.media.limits.images +
          ' изобр., ' +
          cfg.media.limits.videos +
          ' видео. Модели: ' +
          cfg.media.imageModel +
          ($('#mediaVideo').checked ? ', ' + cfg.media.videoModel : '') +
          '.'
        : ''
      : 'Добавьте OPENROUTER_API_KEY в .env и перезапустите сервер.';

  for (const control of document.querySelectorAll('.library-nav button, .library-page button, .library-editor button, .library-editor input, #importBrand')) {
    control.disabled = busy || pending > 0;
  }
  document.body.classList.toggle('busy', busy);
  validateSetupForm();
  renderStepper({busyStep});
}

// ---- Setup Form Submit (Start or Patch Campaign) ----

$('#brief').onsubmit = async e => {
  e.preventDefault();
  if (busy || pending || !validateSetupForm()) return;

  const newSetup = {
    kind: setupDraft.kind,
    languages: [...setupDraft.languages],
    lengths: setupDraft.kind === 'poster' ? [] : [...setupDraft.lengths],
    formats: [...setupDraft.formats],
    provider: currentProviderObject(),
  };

  try {
    busy = true;
    refreshUI();


    if (state.campaign && editingSetup) {
      const effects = describeSetupInvalidation(state.campaign.setup, newSetup, state.campaign);
      if (effects.length > 0) {
        const ok = confirm('Изменение настроек приведёт к следующему:\n• ' + effects.join('\n• ') + '\n\nПрименить изменения?');
        if (!ok) return;
      }
      const updated = await patchCampaign(state.campaign.id, {setup: newSetup});
      editingSetup = false;
      setCampaign(updated);
      renderWorkspace();
      syncRightPaneToCampaign();
      status.textContent = 'Настройки кампании обновлены.';
      return;
    }

    const brand = selectedBrand();
    if (!brand) throw Error('Выберите бренд или сохраните новый бренд с материалами.');
    const created = await createCampaign({brandId:brand.id, brandVersion:brand.version, name:$('#newCampaignName').value.trim(), setup:newSetup});
    editingSetup = false;
    setCampaign(created, {chooseStep: true});
    renderWorkspace();
    syncRightPaneToCampaign();
    refreshHistory();
    status.textContent = 'Кампания создана. Сгенерируйте сценарий на шаге 1.';
  } catch (err) {
    status.textContent = err.message;
  } finally {
    busy = false;
    refreshUI();
  }
};

// ---- Step 1 Actions ----

async function runCampaignTask({stepNum, task, startMsg, triggerBtn, fn}) {
  if (busy || pending || !state.campaign) return;
  const controller = new AbortController();
  const cancel = $('#cancelRender');
  const requestId = crypto.randomUUID();
  let tracker = null;
  const origBtnText = triggerBtn ? triggerBtn.textContent : '';

  busy = true;
  busyStep = stepNum;
  setStepError(stepNum, null);
  if (triggerBtn) {
    triggerBtn.classList.add('is-loading');
    triggerBtn.textContent = 'Генерация…';
    triggerBtn.disabled = true;
  }
  refreshUI();
  resetLog();
  hideLive();
  draftBadge.hidden = true;
  cancel.hidden = false;
  cancel.onclick = () => controller.abort();
  status.textContent = startMsg;
  tracker = startTracking(requestId, task, startMsg);

  try {
    const res = await fn({requestId, signal: controller.signal});
    await tracker.stop();
    if (res?.campaign) {
      setCampaign(res.campaign);
    } else if (res?.id && res?.type === 'campaign') {
      setCampaign(res);
    }
    return res;
  } catch (err) {
    await tracker?.stop();
    const msg = controller.signal.aborted ? 'Генерация остановлена.' : err.message;
    status.textContent = msg;
    if (!controller.signal.aborted) {
      setStepError(stepNum, err.message, () => runCampaignTask({stepNum, task, startMsg, triggerBtn, fn}));
    }
    throw err;
  } finally {
    controller.abort();
    cancel.hidden = true;
    draftBadge.hidden = true;
    tailBox.hidden = true;
    $('#scenarioStreamBox').hidden = true;
    hideLive();
    if (triggerBtn) {
      triggerBtn.classList.remove('is-loading');
      triggerBtn.textContent = origBtnText;
      triggerBtn.disabled = false;
    }
    busy = false;
    busyStep = null;
    refreshUI();
    renderWorkspace();
    refreshHistory();
  }
}

bindScenarioControls({
  onSave: async sc => {
    if (!state.campaign) return;
    try {
      const res = await saveScenarioManual(state.campaign.id, sc);
      setCampaign(res.campaign);
      state.reviewUnlocked[1] = false;
      renderWorkspace();
      status.textContent = 'Сценарий сохранён.';
    } catch (e) {
      setStepError(1, e.message);
    }
  },
  onRegenerate: notes => {
    runCampaignTask({
      stepNum: 1,
      task: 'scenario',
      startMsg: 'Генерация сценария…',
      triggerBtn: $('#generateScenarioBtn'),
      fn: ({requestId, signal}) => generateScenario(state.campaign.id, {requestId, notes, signal}),
    }).then(() => {
      state.reviewUnlocked[1] = false;
      renderWorkspace();
      status.textContent = 'Сценарий готов. Проверьте строки и утвердите.';
    }).catch(() => {});
  },
  onTranslate: () => {
    runCampaignTask({
      stepNum: 1,
      task: 'scenario',
      startMsg: 'Перевод сценария…',
      triggerBtn: $('#translateScenarioBtn'),
      fn: ({requestId, signal}) => translateScenario(state.campaign.id, {requestId, signal}),
    }).then(() => {
      renderWorkspace();
      status.textContent = 'Перевод выполнен.';
    }).catch(() => {});
  },
  onRecalcCuts: () => {
    runCampaignTask({
      stepNum: 1,
      task: 'scenario',
      startMsg: 'Расчёт нарезки по длинам…',
      triggerBtn: $('#recalcCutsBtn'),
      fn: ({requestId, signal}) => recalcCuts(state.campaign.id, {requestId, signal}),
    }).then(() => {
      renderWorkspace();
      status.textContent = 'Нарезка обновлена.';
    }).catch(() => {});
  },
  onApprove: async () => {
    if (!state.campaign) return;
    try {
      const updated = await approveStep(state.campaign.id, 'scenario');
      state.reviewUnlocked[1] = false;
      setCampaign(updated);
      state.activeStep = 2;
      renderWorkspace();
      syncRightPaneToCampaign();
      status.textContent = 'Сценарий утверждён. Предложите 3 визуальных направления.';
    } catch (e) {
      setStepError(1, e.message);
    }
  },
});

// ---- Step 2 Actions ----

function handleProposeStyles(triggerBtn = $('#proposeStylesBtn')) {
  pickingOtherDirection = false;
  runCampaignTask({
    stepNum: 2,
    task: 'style',
    startMsg: 'Подбор 3 визуальных направлений…',
    triggerBtn,
    fn: ({requestId, signal}) => proposeStyles(state.campaign.id, {requestId, signal}),
  }).then(() => {
    state.reviewUnlocked[2] = false;
    renderWorkspace();
    syncRightPaneToCampaign();
    status.textContent = 'Выберите одно из трёх визуальных направлений.';
  }).catch(() => {});
}

$('#proposeStylesBtn').onclick = () => handleProposeStyles($('#proposeStylesBtn'));
$('#newStylesPitchBtn').onclick = () => handleProposeStyles($('#newStylesPitchBtn'));

$('#pickOtherDirectionBtn').onclick = () => {
  if (busy || !state.campaign) return;
  pickingOtherDirection = !pickingOtherDirection;
  renderStep2Panel();
  if (pickingOtherDirection) {
    status.textContent = 'Выберите одно из трёх направлений ниже — будет создан новый стиль кампании.';
    choices.scrollIntoView({behavior: 'smooth', block: 'nearest'});
  }
};

async function handleForkCampaign({targetStep = 2} = {}) {
  if (busy || !state.campaign) return;
  try {
    const forked = await forkCampaign(state.campaign.id, {name: `${state.campaign.name} (копия)`});
    editingSetup = false;
    setCampaign(forked);
    state.activeStep = targetStep;
    renderWorkspace();
    syncRightPaneToCampaign();
    refreshHistory();
    status.textContent = 'Создана копия кампании «' + forked.name + '».';
  } catch (e) {
    status.textContent = e.message;
  }
}

function handleBuildPreview() {
  const direction = $('#styleDirection').value.trim();
  runCampaignTask({
    stepNum: 2,
    task: 'preview',
    startMsg: 'Сборка статичного превью…',
    triggerBtn: $('#buildPreviewBtn'),
    fn: ({requestId, signal}) => buildPreview(state.campaign.id, {requestId, direction, signal}),
  }).then(() => {
    state.reviewUnlocked[2] = false;
    renderWorkspace();
    syncRightPaneToCampaign();
    status.textContent = 'Превью готово. Проверьте кадры и утвердите.';
  }).catch(() => {});
}

$('#buildPreviewBtn').onclick = handleBuildPreview;

$('#approvePreviewBtn').onclick = async () => {
  if (!state.campaign) return;
  try {
    const updated = await approveStep(state.campaign.id, 'preview');
    state.reviewUnlocked[2] = false;
    setCampaign(updated);
    state.activeStep = 3;
    renderWorkspace();
    syncRightPaneToCampaign();
    status.textContent = 'Превью утверждено. Можно собирать финал.';
  } catch (e) {
    setStepError(2, e.message);
  }
};

// ---- Step 3 Actions ----

async function handleBuildFinal() {
  if (!state.campaign) return;
  const c = state.campaign;
  const provMode = c.setup?.provider?.mode || 'demo';

  // Persist per-step model selection if changed
  if (provMode !== 'demo' && finalModelField.value) {
    const curOv = c.setup?.stepModels?.final || {};
    if (curOv.model !== finalModelField.value || curOv.effort !== finalEffortField.value) {
      const patched = await patchCampaign(c.id, {
        setup: {
          stepModels: {
            ...(c.setup.stepModels || {}),
            final: {model: finalModelField.value, effort: finalEffortField.value},
          },
        },
      });
      setCampaign(patched);
    }
  }

  const media = {
    images: Boolean(state.config?.media?.ready && $('#mediaImages').checked),
    video: Boolean(c.setup.kind !== 'poster' && state.config?.media?.ready && $('#mediaVideo').checked),
  };

  runCampaignTask({
    stepNum: 3,
    task: 'final',
    startMsg: c.setup.kind === 'poster' ? 'Сборка финального постера…' : 'Сборка финального видео…',
    triggerBtn: $('#buildFinalBtn'),
    fn: ({requestId, signal}) => buildFinal(state.campaign.id, {requestId, media, signal}),
  }).then(() => {
    renderWorkspace();
    syncRightPaneToCampaign();
    status.textContent = 'Финал готов.';
  }).catch(() => {});
}

$('#buildFinalBtn').onclick = handleBuildFinal;

// ---- Copy Editor Drawer Triggers (§6.6, §8.6) ----

function triggerCopyDrawer() {
  const c = state.campaign;
  if (!c) return;
  const targetStage = state.activeStep === 2 || !c.entries?.final?.output?.path ? 'preview' : 'final';
  const targetEntry = targetStage === 'preview' ? c.entries?.preview : c.entries?.final;
  if (!targetEntry?.id) return;
  const sc = effectiveScenario(targetStage);
  openCopyEditor({
    scenario: sc,
    setup: c.setup,
    currentLength: view.length,
    onSave: async patch => {
      const res = await saveCopyPatch(targetEntry.id, patch);
      setCampaign(res.campaign);
      renderWorkspace();
      syncRightPaneToCampaign();
      status.textContent = 'Тексты обновлены без вызова модели.';
    },
  });
}

$('#openCopyFromPreviewBtn').onclick = triggerCopyDrawer;
$('#openCopyBtn').onclick = triggerCopyDrawer;
$('#openCopyTopBtn').onclick = triggerCopyDrawer;

// ---- Revision Chat (§6, §8.5, §8.6) ----
const chat = $('#chat');
const threadList = $('#thread');
const chatInput = $('#chatInput');
const chatFiles = $('#chatFiles');
let currentEntry = null;
let chatAttachments = [];

const bubble = cls => el('li', 'bubble ' + cls);
const assetSrc = (entry, name) =>
  state.config.previewURL + '/p/' + entry.project + '/assets/' + name.split('/').map(encodeURIComponent).join('/');

function chatTarget() {
  const last = threadList.dataset.last;
  $('#chatTarget').textContent =
    currentEntry && last && currentEntry.id !== last ? 'Правка ответвится от версии ' + when(currentEntry.createdAt) : '';
  for (const b of threadList.querySelectorAll('[data-version]')) {
    const on = b.dataset.version === currentEntry?.id;
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? '✓ В превью' : 'Открыть';
  }
}

function versionButton(e) {
  const b = el('button', 'version', 'Открыть');
  b.type = 'button';
  b.dataset.version = e.id;
  b.title = 'Показать эту версию в предпросмотре';
  b.onclick = () => {
    if (busy) return;
    openVersion(e);
  };
  return b;
}

function openVersion(e) {
  closeKeyframe();
  const isPreview = e.type === 'preview' || e.stage === 'preview';
  const c = state.campaign;
  const scObj = effectiveScenario(isPreview ? 'preview' : 'final');
  const scenesList = (scObj?.scenes || []).map(s => ({id: s.id, beat: s.beat}));
  showStage({
    url: state.config.previewURL + e.output.path,
    stage: e.campaign ? (isPreview ? 'preview' : 'final') : 'legacy',
    kind: e.kind || c?.setup?.kind || 'multi',
    formats: e.output.formats || [e.output.format || '1x1'],
    langs: e.output.langs || [e.output.lang || 'en'],
    lengths: e.output.lengths || [],
    duration: e.output.duration || 8,
    scenes: scenesList,
  });
  $('#caption').textContent =
    entryCaption(e) + ' · ' + when(e.createdAt) + (e.cost?.total ? ' · ≈ ' + moneyPrecise(e.cost.total) + ' по API' : '');
  currentEntry = e;
  chatTarget();
}

function renderThread(thread) {
  threadList.replaceChildren();
  let total = 0;
  let unknown = false;
  for (const e of thread) {
    total += e.cost?.total || 0;
    unknown = unknown || Boolean(e.cost?.unknown);
    if (!e.input?.revision) {
      const li = bubble('root');
      li.append(
        el(
          'div',
          'meta',
          'Исходная версия · ' +
            when(e.createdAt) +
            (e.cost?.total ? ' · ≈ ' + moneyPrecise(e.cost.total) : '') +
            (e.imported ? ' · импорт' : '')
        )
      );
      if (e.input?.scenario) li.append(el('p', '', clip(e.input.scenario, 220)));
      if (e.output?.path) li.append(versionButton(e));
      threadList.append(li);
      continue;
    }
    const user = bubble('user');
    if (e.input.revision.message) user.append(el('p', '', e.input.revision.message));
    if (e.input.revision.attachments?.length) {
      const row = el('div', 'thumbs');
      for (const name of e.input.revision.attachments) {
        if (/\.(png|jpe?g|webp|gif|svg)$/i.test(name)) {
          const img = new Image();
          img.src = assetSrc(e, name);
          img.title = name;
          row.append(img);
        } else {
          row.append(el('span', 'file', name.split('/').pop()));
        }
      }
      user.append(row);
    }
    threadList.append(user);
    const bot = bubble('bot' + (e.status !== 'ok' ? ' failed' : ''));
    bot.append(
      el(
        'p',
        '',
        e.status === 'ok' ? e.output?.reply || 'Готово.' : e.status === 'cancelled' ? 'Остановлено.' : 'Ошибка: ' + (e.error || 'неизвестно')
      )
    );
    bot.append(
      el(
        'div',
        'meta',
        [
          entryCaption(e),
          when(e.createdAt),
          e.durationMs && Math.round(e.durationMs / 1000) + ' с',
          (e.cost?.total || e.cost?.unknown) && '≈ ' + moneyPrecise(e.cost.total) + (e.cost.unknown ? ' +?' : ''),
        ]
          .filter(Boolean)
          .join(' · ')
      )
    );
    if (e.output?.path) bot.append(versionButton(e));
    threadList.append(bot);
  }
  threadList.dataset.last = thread.at(-1)?.id || '';
  $('#chatCost').textContent = total || unknown ? 'всего по API ≈ ' + moneyPrecise(total) + (unknown ? ' +?' : '') : '';
  threadList.scrollTop = threadList.scrollHeight;
}

async function openThread(id) {
  if (!id) {
    currentEntry = null;
    chat.hidden = true;
    return;
  }
  try {
    const {thread} = await (await api('/api/history/' + id + '/thread')).json();
    renderThread(thread);
    currentEntry = thread.at(-1);
    chat.hidden = !(['creative', 'preview'].includes(currentEntry?.type) && currentEntry.output?.path);
    chatTarget();
  } catch {
    currentEntry = null;
    chat.hidden = true;
  }
}

const safeName = name =>
  (name || 'file')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-80) || 'file';

function renderChatFiles() {
  chatFiles.replaceChildren(
    ...chatAttachments.map((f, i) => {
      const chip = el('span', 'chip');
      if (f.type.startsWith('image/')) {
        const img = new Image();
        img.src = URL.createObjectURL(f);
        img.onload = () => URL.revokeObjectURL(img.src);
        chip.append(img);
      }
      chip.append(el('span', '', f.name));
      const x = el('button', '', '×');
      x.type = 'button';
      x.setAttribute('aria-label', 'Убрать ' + f.name);
      x.onclick = () => {
        chatAttachments.splice(i, 1);
        renderChatFiles();
      };
      chip.append(x);
      return chip;
    })
  );
}

function addChatFiles(list) {
  for (const f of list) {
    if (chatAttachments.length >= 12) break;
    const name =
      f.name && f.name !== 'image.png'
        ? f.name
        : 'screenshot-' + new Date().toTimeString().slice(0, 8).replaceAll(':', '') + '.png';
    chatAttachments.push(f.name === name ? f : new File([f], name, {type: f.type}));
  }
  renderChatFiles();
}

$('#chatAttach').onclick = () => $('#chatFileInput').click();
$('#chatFileInput').onchange = e => {
  addChatFiles(e.target.files);
  e.target.value = '';
};
chatInput.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    addChatFiles(files);
  }
});
chat.addEventListener('dragover', e => {
  e.preventDefault();
  chat.classList.add('over');
});
chat.addEventListener('dragleave', () => chat.classList.remove('over'));
chat.addEventListener('drop', e => {
  e.preventDefault();
  chat.classList.remove('over');
  addChatFiles(e.dataTransfer.files);
});
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    sendRevision();
  }
});
$('#chatForm').onsubmit = e => {
  e.preventDefault();
  sendRevision();
};

async function sendRevision() {
  if (busy || pending || !currentEntry) return;
  const message = chatInput.value.trim();
  const files = [...chatAttachments];
  if (!message && !files.length) {
    status.textContent = 'Напишите, что исправить, или приложите файл.';
    return;
  }

  const isCampaignEntry = Boolean(currentEntry.campaign);
  const prov = isCampaignEntry && state.campaign?.setup?.provider
    ? state.campaign.setup.provider
    : currentProviderObject();

  if (!isCampaignEntry && prov.mode === 'demo') {
    status.textContent = 'Для правок старой сборки выберите Claude или Codex в настройках модели.';
    return;
  }

  const controller = new AbortController();
  const requestId = crypto.randomUUID();
  const base = currentEntry;
  let tracker = null;
  busy = true;
  refreshUI();
  resetLog();
  hideLive();
  draftBadge.hidden = true;
  localLog('Правка · ' + (providerName[prov.mode] || prov.mode) + ' · к версии от ' + when(base.createdAt), 'step', message);

  const user = bubble('user');
  if (message) user.append(el('p', '', message));
  if (files.length) user.append(el('div', 'meta', 'вложения: ' + files.map(f => f.name).join(', ')));
  const bot = bubble('bot pending');
  bot.append(el('p', '', 'Вношу правки…'));
  threadList.append(user, bot);
  threadList.scrollTop = threadList.scrollHeight;

  try {
    const names = [];
    for (const [i, f] of files.entries()) {
      const name = 'revisions/' + requestId.slice(0, 8) + '/' + (i + 1) + '-' + safeName(f.name);
      localLog('↑ ' + name + ' · ' + (f.size / 1024).toFixed(0) + ' КБ');
      await api('/api/projects/' + base.project + '/file?name=' + encodeURIComponent(name), {
        method: 'PUT',
        headers: {'Content-Type': 'application/octet-stream'},
        body: f,
        signal: controller.signal,
      });
      names.push(name);
    }
    const cancel = $('#cancelRender');
    const stop = $('#chatStop');
    cancel.hidden = stop.hidden = false;
    cancel.onclick = stop.onclick = () => controller.abort();
    tracker = startTracking(requestId, base.type === 'preview' ? 'preview' : 'creative', 'Вношу правки…', text => {
      bot.firstChild.textContent = text;
    });
    const media = {
      images: Boolean(state.config?.media?.ready && $('#mediaImages').checked),
      video: Boolean(state.config?.media?.ready && $('#mediaVideo').checked),
    };
    const result = await (
      await api('/api/history/' + base.id + '/revise', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        signal: controller.signal,
        body: JSON.stringify({
          requestId,
          mode: prov.mode,
          billing: prov.billing,
          model: prov.model,
          effort: prov.effort,
          message,
          attachments: names,
          media,
        }),
      })
    ).json();
    await tracker.stop();
    chatInput.value = '';
    chatAttachments = [];
    renderChatFiles();
    if (result.campaign) {
      setCampaign(result.campaign);
      renderWorkspace();
      syncRightPaneToCampaign();
    } else {
      closeKeyframe();
      showStage({
        url: result.url,
        stage: 'legacy',
        formats: result.formats,
        duration: result.duration,
      });
      await openThread(result.historyId);
    }
    const costNote = result.cost?.total ? ' · ≈ ' + moneyPrecise(result.cost.total) + ' по API' : '';
    status.textContent = 'Правка готова.' + costNote;
  } catch (err) {
    await tracker?.stop();
    status.textContent = controller.signal.aborted ? 'Правка остановлена.' : err.message;
    bot.classList.remove('pending');
    bot.classList.add('failed');
    bot.firstChild.textContent = controller.signal.aborted ? 'Остановлено.' : 'Ошибка: ' + err.message;
  } finally {
    controller.abort();
    $('#cancelRender').hidden = true;
    $('#chatStop').hidden = true;
    draftBadge.hidden = true;
    tailBox.hidden = true;
    hideLive();
    busy = false;
    refreshUI();
    refreshHistory();
  }
}

// ---- History Drawer (§8.7): Кампании & Старые сборки ----
const historyPanel = $('#history');
const historyList = $('#historyList');
const historyMore = $('#historyMore');
let historyTab = 'campaigns'; // 'campaigns' | 'legacy'
let historyType = '';
let historyAuthorMode = 'all'; // 'all' | 'mine' | 'colleagues'
let historyNext = null;

const typeName = {creative: 'Креатив', style: 'Стили', scenario: 'Сценарий', preview: 'Превью'};
const when = iso => new Date(iso).toLocaleString('ru-RU', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
const authorWhen = (author, iso) => (author ? `${author} · ${when(iso)}` : when(iso));
const clip = (t, n = 180) => {
  t = String(t || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const entryCaption = e =>
  e?.caption || (e?.mode ? [providerName[e.mode] || e.mode, e.model, e.effort].filter(Boolean).join(' · ') : 'Сборка');

function actionBtn(label, fn) {
  const b = el('button', '', label);
  b.type = 'button';
  b.onclick = async () => {
    if (busy) {
      status.textContent = 'Дождитесь окончания сборки.';
      return;
    }
    try {
      await fn();
    } catch (err) {
      status.textContent = err.message;
    }
  };
  return b;
}

async function showSavedLog(entry) {
  const full = (Array.isArray(entry.log) && (entry.log.length > 0 || !entry.logSize)) ? entry : await (await api('/api/history/' + entry.id)).json();
  resetLog();
  localLog('Журнал из истории · ' + (typeName[full.type] || full.type) + ' · ' + when(full.createdAt), 'step');
  for (const e of full.log || []) {
    addLog({...e, media: e.media ? {...e.media, url: state.config.previewURL + '/p/' + full.project + '/assets/' + e.media.file} : undefined});
  }
  if ($('#pipelinePage').hidden) showLibraryPage('pipelinePage', 'Журнал сборки');
  journal.hidden = false;
  journal.scrollIntoView({behavior: 'smooth', block: 'nearest'});
}

function stepDotSymbol(c, stepNum) {
  const s = c.steps || {};
  if (stepNum === 1) {
    if (s.scenario?.stale || s.scenario?.needs?.length) return {sym: '⚠', cls: 'dot-warn', title: 'Сценарий: требует внимания'};
    if (s.scenario?.approvedAt) return {sym: '✓', cls: 'dot-ok', title: 'Сценарий: утверждён'};
    if (s.scenario?.entryId) return {sym: '●', cls: 'dot-active', title: 'Сценарий: в работе'};
    return {sym: '○', cls: 'dot-empty', title: 'Сценарий: пусто'};
  }
  if (stepNum === 2) {
    if (s.preview?.stale) return {sym: '⚠', cls: 'dot-warn', title: 'Превью: устарело'};
    if (s.preview?.approvedAt) return {sym: '✓', cls: 'dot-ok', title: 'Превью: утверждено'};
    if (s.preview?.entryId || s.styles?.entryId) return {sym: '●', cls: 'dot-active', title: 'Превью: в работе'};
    return {sym: '○', cls: 'dot-empty', title: 'Превью: пусто'};
  }
  if (s.final?.stale) return {sym: '⚠', cls: 'dot-warn', title: 'Финал: устарел'};
  if (s.final?.entryId) return {sym: '✓', cls: 'dot-ok', title: 'Финал: готов'};
  return {sym: '○', cls: 'dot-empty', title: 'Финал: пусто'};
}

function campaignHistoryItem(c) {
  const isCurrent = state.campaign?.id === c.id;
  const li = el('li', 'h-item h-campaign' + (isCurrent ? ' is-active-camp' : ''));
  const head = el('div', 'h-head');
  const badge = el('span', 'h-type', KIND_NAMES[c.setup?.kind] || c.setup?.kind || 'Кампания');
  const timeEl = el('time', '', authorWhen(c.author, c.updatedAt || c.createdAt));
  const dots = el('span', 'h-step-dots');
  for (const n of [1, 2, 3]) {
    const d = stepDotSymbol(c, n);
    const span = el('span', 'h-dot ' + d.cls, d.sym);
    span.title = d.title;
    dots.append(span);
  }
  head.append(badge, timeEl, dots);
  li.append(head);

  const title = el('strong', 'h-camp-title', (isCurrent ? '● ' : '') + (c.name || 'Новая кампания'));
  li.append(title);

  const metaParts = [];
  const brand = brandLibrary.find(b => b.id === c.brandId);
  if (brand) metaParts.push(brand.name);
  if (c.setup?.languages?.length) metaParts.push(c.setup.languages.map(l => l.toUpperCase()).join(', '));
  if (c.setup?.kind !== 'poster' && c.setup?.lengths?.length) metaParts.push(c.setup.lengths.join(' / ') + ' с');
  if (c.setup?.formats?.length) metaParts.push(c.setup.formats.map(id => state.formatInfo[id]?.label || id).join(' '));
  if (c.cost?.total || c.cost?.unknown) metaParts.push('≈ ' + money(c.cost.total) + (c.cost.unknown ? ' +?' : ''));
  li.append(el('div', 'h-meta', metaParts.join(' · ')));

  // Variant swatch chips inside History card (§4.3)
  if (Array.isArray(c.variants) && c.variants.length) {
    const varRow = el('div', 'h-variants chips small');
    for (const v of c.variants) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'h-variant-chip';
      chip.setAttribute('aria-pressed', String(isCurrent && v.id === c.activeVariant));

      const svg = v.styleSvg || v.style?.svg;
      if (svg) {
        const img = new Image(14, 14);
        img.className = 'style-swatch';
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        img.alt = '';
        chip.append(img);
      }
      chip.append(el('span', '', v.label || 'Стиль'));
      if (v.stale || v.approved) {
        chip.append(el('small', v.stale ? 'mark-warn' : 'mark-ok', v.stale ? '⚠' : '✓'));
      }
      chip.onclick = async () => {
        if (busy) return;
        try {
          const full = await switchActiveVariant(c.id, v.id);
          editingSetup = false;
          setCampaign(full, {chooseStep: true});
          renderWorkspace();
          syncRightPaneToCampaign();
          status.textContent = `Открыта кампания «${full.name}» · ${v.label}.`;
          if (innerWidth < 900) closeHistory();
        } catch (err) {
          status.textContent = err.message;
        }
      };
      varRow.append(chip);
    }
    li.append(varRow);
  }

  // Whole pipeline steps breakdown inside History card
  const pipe = c.pipeline || {};
  const pipeBox = el('div', 'h-pipeline');

  const openAtStep = async (stepNum, styleIndex = null) => {
    const full = await fetchCampaign(c.id);
    if (styleIndex !== null && full.steps?.styles?.entryId) {
      const updated = await chooseStyle(c.id, {index: styleIndex});
      editingSetup = false;
      setCampaign(updated);
    } else {
      editingSetup = false;
      setCampaign(full);
    }
    state.activeStep = stepNum;
    renderWorkspace();
    syncRightPaneToCampaign();
    status.textContent = `Открыт пайплайн «${full.name}» · Шаг ${stepNum}.`;
    if (innerWidth < 900) closeHistory();
  };

  // Step 1 row
  const s1Row = el('div', 'h-pipe-step');
  const s1Btn = actionBtn('① Сценарий', () => openAtStep(1));
  s1Btn.className = 'h-pipe-btn';
  const s1Text = el('span', 'h-pipe-desc', pipe.scenario ? clip(pipe.scenario.idea || pipe.scenario.theme || 'Готов', 90) : 'Не создан');
  s1Row.append(s1Btn, s1Text);
  pipeBox.append(s1Row);

  // Step 2 row + 3 style sketches
  const s2Row = el('div', 'h-pipe-step');
  const s2Btn = actionBtn('② Превью', () => openAtStep(2));
  s2Btn.className = 'h-pipe-btn';
  const chosenName = pipe.styles?.styles?.[pipe.styles.chosenIndex]?.name;
  const s2Text = el('span', 'h-pipe-desc', chosenName ? `Стиль: ${chosenName}` : pipe.styles ? '3 направления' : 'Нет превью');
  s2Row.append(s2Btn, s2Text);
  pipeBox.append(s2Row);

  if (pipe.styles?.styles?.length) {
    const skRow = el('div', 'h-sketches');
    pipe.styles.styles.forEach((s, idx) => {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s.svg);
      img.alt = s.name;
      img.title = `${s.name} — кликните, чтобы открыть это направление на Шаге 2`;
      if (idx === pipe.styles.chosenIndex) img.className = 'is-chosen';
      img.style.cursor = 'pointer';
      img.onclick = () => openAtStep(2, idx);
      skRow.append(img);
    });
    pipeBox.append(skRow);
  }

  // Step 3 row
  const s3Row = el('div', 'h-pipe-step');
  const s3Btn = actionBtn('③ Финал', () => openAtStep(3));
  s3Btn.className = 'h-pipe-btn';
  s3Btn.disabled = !pipe.final && !c.steps?.preview?.approvedAt;
  const s3Text = el('span', 'h-pipe-desc', pipe.final ? 'Собран во всех форматах' : 'Ещё не собран');
  s3Row.append(s3Btn, s3Text);
  pipeBox.append(s3Row);

  li.append(pipeBox);

  const actions = el('div', 'h-actions');
  actions.append(
    actionBtn(isCurrent ? '✓ Открыта' : 'Открыть', async () => {
      const full = await fetchCampaign(c.id);
      editingSetup = false;
      setCampaign(full, {chooseStep: true});
      renderWorkspace();
      syncRightPaneToCampaign();
      status.textContent = 'Открыта кампания «' + full.name + '».';
      if (innerWidth < 900) closeHistory();
    })
  );
  actions.append(
    actionBtn('＋ Новая ветка', async () => {
      const forked = await forkCampaign(c.id);
      editingSetup = false;
      setCampaign(forked);
      state.activeStep = forked.steps?.scenario?.approvedAt ? 2 : 1;
      renderWorkspace();
      syncRightPaneToCampaign();
      loadHistory(true).catch(() => {});
      status.textContent = 'Создана новая ветка пайплайна «' + forked.name + '».';
      if (innerWidth < 900) closeHistory();
    })
  );
  const logEntryId = pipe.final?.id || pipe.preview?.id || pipe.styles?.id || pipe.scenario?.id;
  if (logEntryId) {
    actions.append(actionBtn('Журнал', () => showSavedLog({id: logEntryId})));
  }
  li.append(actions);
  return li;
}

function legacyHistoryItem(e) {
  const li = el('li', 'h-item h-' + e.type + (e.status !== 'ok' ? ' h-failed' : ''));
  const head = el('div', 'h-head');
  head.append(el('span', 'h-type', e.input?.revision ? 'Правка' : typeName[e.type] || e.type), el('time', '', authorWhen(e.author, e.createdAt)));
  if (e.status !== 'ok') head.append(el('span', 'h-status', e.status === 'cancelled' ? 'остановлено' : 'ошибка'));
  li.append(head);

  const meta = [entryCaption(e)];
  if (e.type === 'creative' && e.output?.formats) meta.push(e.output.formats.map(id => state.formatInfo[id]?.label || id).join(' '));
  if (e.durationMs) meta.push(Math.round(e.durationMs / 1000) + ' с');
  if (e.media?.length) meta.push('медиа: ' + e.media.length);
  if (e.cost?.total || e.cost?.unknown) meta.push('≈ ' + moneyPrecise(e.cost.total) + (e.cost.unknown ? ' +?' : ''));
  li.append(el('div', 'h-meta', meta.join(' · ')));

  if (e.error) li.append(el('p', 'h-error', clip(e.error, 200)));
  const body = e.input?.revision
    ? '«' + (e.input.revision.message || 'вложения') + '»' + (e.output?.reply ? ' → ' + e.output.reply : '')
    : e.type === 'scenario'
      ? e.output?.text
      : e.type === 'style'
        ? e.output?.scenario || e.input?.scenario
        : e.input?.scenario || e.input?.style;
  if (body) li.append(el('p', 'h-text', clip(body)));

  if (e.type === 'style' && e.output?.styles) {
    const row = el('div', 'h-sketches');
    for (const s of e.output.styles) {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s.svg);
      img.alt = s.name;
      img.title = s.name;
      row.append(img);
    }
    li.append(row);
  }
  if (e.type === 'creative' && e.media?.length) {
    const row = el('div', 'h-media');
    for (const m of e.media.slice(0, 4)) {
      const n = document.createElement(m.kind === 'video' ? 'video' : 'img');
      n.src = state.config.previewURL + m.path;
      if (m.kind === 'video') n.muted = true;
      row.append(n);
    }
    li.append(row);
  }

  const actions = el('div', 'h-actions');
  if (e.type === 'creative' && e.output?.path) {
    actions.append(
      actionBtn('Открыть', () => {
        showLibraryPage('pipelinePage', 'Сборка из истории');
        closeKeyframe();
        showStage({
          url: state.config.previewURL + e.output.path,
          stage: 'legacy',
          formats: e.output.formats || ['1x1'],
          duration: e.output.duration || 8,
        });
        $('#caption').textContent = entryCaption(e) + ' · ' + when(e.createdAt);
        openThread(e.id);
        status.textContent = 'Открыта старая сборка из истории.';
        if (innerWidth < 900) closeHistory();
      })
    );
  }
  if (e.logSize) actions.append(actionBtn('Журнал', () => showSavedLog(e)));
  li.append(actions);
  return li;
}

async function loadHistory(reset = true) {
  const me = state.config?.store?.author || null;
  const authorParam = historyAuthorMode === 'mine' && me ? me : undefined;
  const excludeAuthorParam = historyAuthorMode === 'colleagues' && me ? me : undefined;

  if (historyTab === 'campaigns') {
    $('#historyFilter').hidden = true;
    const {items: campItems, next, total} = await listCampaigns({
      before: !reset && historyNext ? historyNext : undefined,
      limit: 30,
      author: authorParam,
      excludeAuthor: excludeAuthorParam,
    });
    if (reset) historyList.replaceChildren();
    for (const c of campItems) historyList.append(campaignHistoryItem(c));
    if (reset && !campItems.length) historyList.append(el('li', 'h-empty', 'Кампаний пока нет.'));
    historyNext = next;
    historyMore.hidden = !next;
    $('#historyCount').textContent = total ? String(total) : '';
    return;
  }

  $('#historyFilter').hidden = false;
  const q = new URLSearchParams({limit: '30', campaign: 'none'});
  if (historyType) q.set('type', historyType);
  if (authorParam) q.set('author', authorParam);
  if (excludeAuthorParam) q.set('excludeAuthor', excludeAuthorParam);
  if (!reset && historyNext) q.set('before', historyNext);
  const {items: legItems, next} = await (await api('/api/history?' + q)).json();
  if (reset) historyList.replaceChildren();
  for (const e of legItems) historyList.append(legacyHistoryItem(e));
  if (reset && !legItems.length) historyList.append(el('li', 'h-empty', 'Старых сборок нет.'));
  historyNext = next;
  historyMore.hidden = !next;
}

function openHistory() {
  historyPanel.hidden = false;
  $('#historyOpen').setAttribute('aria-expanded', 'true');
  loadHistory().catch(err => {
    status.textContent = err.message;
  });
}

function closeHistory() {
  historyPanel.hidden = true;
  $('#historyOpen').setAttribute('aria-expanded', 'false');
}

function refreshHistory() {
  if (historyPanel.hidden) {
    listCampaigns({limit: 1})
      .then(r => {
        $('#historyCount').textContent = r.total ? String(r.total) : '';
      })
      .catch(() => {});
  } else {
    loadHistory().catch(() => {});
  }
}

$('#historyOpen').onclick = () => (historyPanel.hidden ? openHistory() : closeHistory());
$('#historyClose').onclick = closeHistory;
historyMore.onclick = () => loadHistory(false).catch(err => { status.textContent = err.message; });

for (const b of document.querySelectorAll('#historyTabs button')) {
  b.onclick = () => {
    historyTab = b.dataset.tab;
    historyNext = null;
    for (const x of document.querySelectorAll('#historyTabs button')) {
      const on = x === b;
      x.setAttribute('aria-selected', String(on));
      x.setAttribute('aria-pressed', String(on));
    }
    loadHistory(true).catch(err => { status.textContent = err.message; });
  };
}

for (const b of document.querySelectorAll('#historyFilter button')) {
  b.onclick = () => {
    historyType = b.dataset.type;
    for (const x of document.querySelectorAll('#historyFilter button')) {
      x.setAttribute('aria-pressed', String(x === b));
    }
    loadHistory(true).catch(err => { status.textContent = err.message; });
  };
}

for (const b of document.querySelectorAll('#historyAuthorFilter button')) {
  b.onclick = () => {
    historyAuthorMode = b.dataset.authorFilter || 'all';
    historyNext = null;
    for (const x of document.querySelectorAll('#historyAuthorFilter button')) {
      x.setAttribute('aria-pressed', String(x === b));
    }
    loadHistory(true).catch(err => { status.textContent = err.message; });
  };
}

// ---- Active runs popover & live multi-user polling (§5) ----
const STEP_LABELS = {
  scenario: 'Сценарий',
  style: 'Стили',
  styles: 'Стили',
  preview: 'Превью',
  final: 'Финал',
  creative: 'Правка',
  revise: 'Правка',
};

let readonlyRunTracker = null;

async function attachReadonlyRun(run) {
  if (busy) return;
  if (readonlyRunTracker) {
    await readonlyRunTracker.stop().catch(() => {});
    readonlyRunTracker = null;
  }
  if (run.campaignId && state.campaign?.id !== run.campaignId) {
    try {
      const full = await fetchCampaign(run.campaignId);
      editingSetup = false;
      setCampaign(full, {chooseStep: true});
      renderWorkspace();
      syncRightPaneToCampaign();
    } catch {}
  }
  resetLog();
  const stepLabel = STEP_LABELS[run.step] || run.step || 'Шаг';
  const authorLabel = run.author || 'коллега';
  localLog(`Наблюдение за сборкой (${authorLabel} · ${stepLabel})`, 'step');
  if ($('#pipelinePage').hidden) showLibraryPage('pipelinePage', 'Журнал сборки');
  journal.hidden = false;
  journal.scrollIntoView({behavior: 'smooth', block: 'nearest'});

  const taskKind = run.step === 'styles' ? 'style' : (run.step || 'creative');
  const trackerState = {since: 0, message: `${authorLabel} · ${stepLabel}`, sketches: 0, costs: null};
  let stopped = false;
  const poll = async () => {
    if (stopped || busy) return;
    try {
      const r = await fetch('/api/render-progress/' + run.id + '?since=' + trackerState.since, {cache: 'no-store'});
      if (!r.ok) return;
      const p = await r.json();
      applyProgress(p, taskKind, trackerState);
      if (p.done || p.missing) {
        stopped = true;
        if (run.campaignId && state.campaign?.id === run.campaignId && !busy) {
          const fresh = await fetchCampaign(run.campaignId).catch(() => null);
          if (fresh) {
            setCampaign(fresh);
            renderWorkspace();
            syncRightPaneToCampaign();
          }
        }
      }
    } catch {}
  };
  const loop = async () => {
    if (stopped || busy) return;
    await poll();
    if (!stopped && !busy) setTimeout(loop, 1200);
  };
  loop();
  readonlyRunTracker = {
    async stop() {
      stopped = true;
    },
  };
}

async function pollActiveRuns() {
  const wrap = $('#activeRunsWrap');
  const label = $('#activeRunsLabel');
  const list = $('#activeRunsList');
  const pop = $('#activeRunsPopover');
  if (!wrap || !label || !list || !pop) return;
  try {
    const runs = await fetchActiveRuns();
    if (!runs.length) {
      wrap.hidden = true;
      pop.hidden = true;
      $('#activeRunsBtn')?.setAttribute('aria-expanded', 'false');
      return;
    }
    wrap.hidden = false;
    label.textContent = `Идёт: ${runs.length}`;
    list.replaceChildren(
      ...runs.map(r => {
        const li = el('li', 'active-run-item');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'active-run-btn';
        const elapsedSec = Math.max(0, Math.round((r.elapsed || (Date.now() - (r.startedAt || Date.now()))) / 1000));
        const parts = [
          r.author || 'автор',
          r.campaignName || (r.campaignId ? r.campaignId.slice(0, 8) : 'Кампания'),
          STEP_LABELS[r.step] || r.step || 'шаг',
          `${elapsedSec} с`,
        ];
        btn.textContent = parts.join(' · ');
        btn.onclick = () => {
          pop.hidden = true;
          $('#activeRunsBtn')?.setAttribute('aria-expanded', 'false');
          attachReadonlyRun(r);
        };
        li.append(btn);
        return li;
      })
    );
  } catch {}
}

$('#activeRunsBtn').onclick = () => {
  const pop = $('#activeRunsPopover');
  if (!pop) return;
  pop.hidden = !pop.hidden;
  $('#activeRunsBtn').setAttribute('aria-expanded', String(!pop.hidden));
};

// Live refresh timers (§5):
// 1. Refresh History drawer every 15s while open
setInterval(() => {
  if (!historyPanel.hidden && !busy) {
    loadHistory(true).catch(() => {});
  }
}, 15_000);

// 2. Poll active campaign every 10s while idle to detect colleague updates & poll active runs
setInterval(async () => {
  pollActiveRuns();
  if (busy || editingSetup || !state.campaign?.id) return;
  try {
    const latest = await fetchCampaign(state.campaign.id);
    if (latest?.id !== state.campaign?.id) return;
    if (latest && latest.version && state.campaign.version && latest.version !== state.campaign.version) {
      setCampaign(latest);
      renderWorkspace();
      syncRightPaneToCampaign({keepTime: true});
      showToast(`Обновлено: ${latest.author || 'коллега'} изменил кампанию`);
    }
  } catch {}
}, 10_000);

addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!historyPanel.hidden) closeHistory();
    else if (!$('#copyDrawer').hidden) $('#copyDrawer').hidden = true;
    else if (!$('#brandEditor').hidden && !busy && !pending) $('#cancelBrand').click();
    else if (editingSetup) {
      editingSetup = false;
      renderWorkspace();
    }
  }
});

async function importBrowserHistory() {
  if (localStorage.getItem('forma.historyImported')) return;
  const last = JSON.parse(localStorage.getItem('forma.last') || 'null');
  if (last) {
    await api('/api/history/import-local', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({last}),
    });
  }
  localStorage.setItem('forma.historyImported', '1');
}

// ---- Boot ----
initPlayerControls();
setVariantSwitchHandler(vid => handleSwitchVariant(vid));

addEventListener('click', e => {
  const menu = $('#stepperStyleMenu');
  const list = $('#stepperStyleList');
  if (menu && list && !list.hidden && !menu.contains(e.target)) {
    list.hidden = true;
    $('#stepperStyleBtn')?.setAttribute('aria-expanded', 'false');
  }
  const runsWrap = $('#activeRunsWrap');
  const runsPop = $('#activeRunsPopover');
  if (runsWrap && runsPop && !runsPop.hidden && !runsWrap.contains(e.target)) {
    runsPop.hidden = true;
    $('#activeRunsBtn')?.setAttribute('aria-expanded', 'false');
  }
});

(async () => {
  try {
    state.config = await (await api('/api/status')).json();
    try {
      brandLibrary = await listBrands();
      renderBrandCards();
      const legacy = await listBrandCampaigns();
      $('#legacyCampaigns').hidden = !legacy.length;
    } catch (err) {
      if (!brandLibrary.length) $('#brandCards').replaceChildren();
      $('#brandMessage').textContent = err.message;
    }
    await importBrowserHistory().catch(() => {});
    state.formatInfo = Object.fromEntries(state.config.formats.map(f => [f.id, f]));
    setupDraft.formats = state.config.defaultFormats.filter(id => state.formatInfo[id]);
    if (!setupDraft.formats.length) setupDraft.formats = ['9x16', '1x1'];

    $('#claudeBilling').value = state.config.claudeSubscription || !state.config.ready ? 'subscription' : 'api';
    $('#billing').value = state.config.chatReady ? 'chatgpt' : 'api';
    if (state.config.claudeSubscription || state.config.ready) {
      mode.value = 'claude';
    }

    renderKindCards();
    renderLangChips();
    renderLengthsPicker();
    renderFormatPicker();
    updateModels();
    refreshHistory();
    pollActiveRuns();

  } catch (err) {
    $('#brandMessage').textContent = err.message;
  }
  refreshUI();
})();
