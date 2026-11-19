// Structured Scenario Editor with live Cut Table (§8.4) and Copy Editor Drawer (§6.6, §8.6).
import {language} from '/shared/languages.mjs';
import {windowNeed, verdict} from '/shared/reading.mjs';
import {state} from '/campaign.js';

import {$} from './dom.js';

const ROLES_NO_HIDE = new Set(['hook', 'offer', 'cta']);
const LANG_PREF_KEY = 'forma.scenLang';

let draftScenario = null;
let dirty = false;
let jsonMode = false;
let activeLang = localStorage.getItem(LANG_PREF_KEY) || 'en';
let callbacks = {};

export function isScenarioDirty() {
  return dirty;
}

export function getDraftScenario() {
  if (jsonMode) {
    const raw = $('#scenarioRawText')?.value || '';
    return JSON.parse(raw);
  }
  return draftScenario;
}

// Client-side scenario validator matching scenario.mjs (§4.3)
export function validateScenarioClient(scenario, setup) {
  const errors = [];
  const warnings = [];
  const cells = {};
  if (!scenario || typeof scenario !== 'object') {
    return {errors: [{msg: 'No script provided.', target: '#scenarioRawText'}], warnings, cells};
  }

  const reqKind = setup?.kind || scenario.kind;
  const reqLangs = Array.isArray(setup?.languages) && setup.languages.length ? setup.languages : (scenario.languages || ['en']);
  const reqLengths = reqKind === 'poster' ? [] : (Array.isArray(setup?.lengths) ? setup.lengths.map(Number) : []);
  const primaryLang = reqLangs[0] || 'en';

  if (scenario.kind !== reqKind) {
    errors.push({msg: `Script type "${scenario.kind}" does not match "${reqKind}".`, target: '#scenarioTheme'});
  }

  const scenes = Array.isArray(scenario.scenes) ? scenario.scenes : [];
  const lines = scenario.lines && typeof scenario.lines === 'object' ? scenario.lines : {};
  const sceneMap = new Map(scenes.map((s, idx) => [s.id, {...s, index: idx}]));
  const lineEntries = Object.entries(lines);

  if (reqKind === 'poster' && (scenes.length !== 1 || scenes[0]?.id !== 'poster')) {
    errors.push({msg: 'A poster needs exactly one scene with the ID "poster".', target: '#scenarioScenes'});
  } else if (reqKind === 'single' && (scenes.length !== 1 || scenes[0]?.id !== 'loop')) {
    errors.push({msg: 'A single-scene video needs exactly one scene with the ID "loop".', target: '#scenarioScenes'});
  }

  for (const [key, line] of lineEntries) {
    const inputSel = `#line-${key}-${activeLang}`;
    if (!sceneMap.has(line.scene)) {
      errors.push({msg: `Line "${key}" refers to an unknown scene "${line.scene}".`, target: inputSel});
    }
    if (ROLES_NO_HIDE.has(line.role) && Array.isArray(line.hideIn) && line.hideIn.length > 0) {
      errors.push({msg: `Line "${key}" (${line.role}) must be visible in every format.`, target: inputSel});
    }
    for (const lang of reqLangs) {
      const val = line.text?.[lang];
      if (typeof val !== 'string' || !val.trim()) {
        errors.push({msg: `Missing or empty ${lang} translation for line "${key}".`, target: `#line-${key}-${lang}`});
      } else if ([...val.trim()].length > line.maxChars) {
        warnings.push({
          msg: `Line "${key}" (${lang}): ${[...val.trim()].length}/${line.maxChars} characters.`,
          target: `#line-${key}-${lang}`,
        });
      }
    }
    if (reqKind === 'poster' && line.role === 'hook') {
      const pText = (line.text?.[primaryLang] || '').trim();
      if (pText && !language(primaryLang).cjk && pText.split(/\s+/).length > 7) {
        warnings.push({
          msg: `Poster hook "${key}" has ${pText.split(/\s+/).length} words (7 or fewer recommended).`,
          target: `#line-${key}-${primaryLang}`,
        });
      }
    }
  }

  for (const scene of scenes) {
    for (const lk of scene.lines || []) {
      if (!lines[lk]) {
        errors.push({msg: `Scene "${scene.id}" refers to an unknown line "${lk}".`, target: '#scenarioScenes'});
      }
    }
  }

  if (reqKind === 'single' && reqLengths.length > 0) {
    const minLen = Math.min(...reqLengths);
    const allKeys = scenes[0]?.lines || Object.keys(lines);
    for (const lang of reqLangs) {
      const texts = allKeys.map(k => lines[k]?.text?.[lang] || '').filter(Boolean);
      const need = windowNeed(texts, lang, {closing: false});
      if (need > minLen - 0.5) {
        warnings.push({
          msg: `Reading all lines (${lang}: ${need.toFixed(1)} s) takes longer than ${minLen} − 0.5 s.`,
          target: '#scenarioLoopInfo',
        });
      }
    }
  }

  if (reqKind === 'multi') {
    const cuts = scenario.cuts || {};
    const rank = {ok: 0, tight: 1, fail: 2};
    for (const len of reqLengths) {
      const lenKey = String(len);
      const cut = cuts[lenKey];
      cells[lenKey] = {};
      if (!cut || !Array.isArray(cut.scenes) || !cut.scenes.length) {
        errors.push({msg: `No cut for the ${len} s version.`, target: '#scenarioCutsTable'});
        continue;
      }
      const winList = cut.scenes;
      let prevIdx = -1;
      for (let i = 0; i < winList.length; i++) {
        const w = winList[i];
        const cellTarget = `#cut-${lenKey}-${w.id}-end`;
        const sc = sceneMap.get(w.id);
        if (!sc) {
          errors.push({msg: `${len} s cut: unknown scene "${w.id}".`, target: cellTarget});
          continue;
        }
        if (sc.index <= prevIdx) {
          errors.push({msg: `${len} s cut: scene "${w.id}" is out of order.`, target: cellTarget});
        }
        prevIdx = sc.index;
        if (i === 0 && Math.abs(w.start - 0) > 0.05) {
          errors.push({msg: `${len} s cut: the first window must start at 0 s.`, target: `#cut-${lenKey}-${w.id}-start`});
        }
        if (i > 0 && Math.abs(w.start - winList[i - 1].end) > 0.05) {
          errors.push({msg: `${len} s cut: gap or overlap before scene "${w.id}".`, target: `#cut-${lenKey}-${w.id}-start`});
        }
        if (i === winList.length - 1 && Math.abs(w.end - len) > 0.05) {
          errors.push({msg: `${len} s cut: the last window must end at ${len} s (currently ${w.end} s).`, target: cellTarget});
        }
        const allowed = new Set(sc.lines || []);
        for (const lk of w.lines || []) {
          if (!allowed.has(lk)) {
            errors.push({msg: `${len} s cut, scene "${w.id}": line "${lk}" belongs to a different scene.`, target: cellTarget});
          }
        }
        const isClosing = i === winList.length - 1;
        if (isClosing && !(w.lines || []).some(lk => lines[lk]?.role === 'cta')) {
          errors.push({msg: `${len} s cut: the last scene "${w.id}" has no CTA.`, target: cellTarget});
        }

        const have = Number((w.end - w.start).toFixed(3));
        const byLang = {};
        let maxNeed = 0;
        let worstVerdict = 'ok';
        for (const lang of reqLangs) {
          const texts = (w.lines || []).map(k => lines[k]?.text?.[lang] || '');
          const need = Number(windowNeed(texts, lang, {closing: isClosing, picture: true}).toFixed(2));
          const v = verdict(have, need);
          byLang[lang] = {need, have, verdict: v};
          if (need > maxNeed) maxNeed = need;
          if (rank[v] > rank[worstVerdict]) worstVerdict = v;
        }
        cells[lenKey][w.id] = {need: maxNeed, have, verdict: worstVerdict, byLang};
        if (worstVerdict === 'fail') {
          errors.push({
            msg: `${len} s cut, scene "${w.id}": the ${have.toFixed(1)} s window is shorter than the ${maxNeed.toFixed(1)} s reading time.`,
            target: cellTarget,
          });
        } else if (worstVerdict === 'tight') {
          warnings.push({
            msg: `${len} s cut, scene "${w.id}": tight timing (${have.toFixed(1)} s available, ${maxNeed.toFixed(1)} s needed).`,
            target: cellTarget,
          });
        }
      }
    }
  }

  return {errors, warnings, cells};
}

export function loadScenarioIntoEditor(scenario, opts = {}) {
  callbacks = opts;
  draftScenario = scenario ? structuredClone(scenario) : null;
  dirty = false;
  jsonMode = false;
  const setupLangs = state.campaign?.setup?.languages || scenario?.languages || ['en'];
  if (!setupLangs.includes(activeLang)) {
    activeLang = setupLangs[0] || 'en';
  }
  renderScenarioEditor();
}

function markDirty() {
  dirty = true;
  refreshValidationAndActions();
}

export function renderScenarioEditor() {
  const c = state.campaign;
  const setup = c?.setup || {kind: 'multi', languages: ['en'], lengths: [6, 10], formats: ['9x16']};
  const promptBox = $('#scenarioPromptBox');
  const resultBox = $('#scenarioResultBox');
  const streamBox = $('#scenarioStreamBox');

  streamBox.hidden = true;

  if (!draftScenario) {
    promptBox.hidden = false;
    resultBox.hidden = true;
    return;
  }

  resultBox.hidden = false;
  // Keep promptBox hidden unless user toggled "Перегенерировать…"
  if (!promptBox.dataset.expanded) {
    promptBox.hidden = true;
  }

  const reviewOnly = Boolean(callbacks.readOnly);

  $('#scenarioJsonToggle').setAttribute('aria-pressed', String(jsonMode));
  $('#scenarioStructured').hidden = jsonMode;
  $('#scenarioRawBox').hidden = !jsonMode;

  if (jsonMode) {
    const rawArea = $('#scenarioRawText');
    rawArea.value = JSON.stringify(draftScenario, null, 2);
    rawArea.disabled = reviewOnly;
    rawArea.oninput = () => {
      dirty = true;
      try {
        const parsed = JSON.parse(rawArea.value);
        draftScenario = parsed;
      } catch {}
      refreshValidationAndActions();
    };
    refreshValidationAndActions();
    return;
  }

  // Theme & Idea
  const themeInput = $('#scenarioTheme');
  const ideaInput = $('#scenarioIdea');
  themeInput.value = draftScenario.theme || '';
  ideaInput.value = draftScenario.idea || '';
  themeInput.disabled = reviewOnly;
  ideaInput.disabled = reviewOnly;
  themeInput.oninput = () => { draftScenario.theme = themeInput.value; markDirty(); };
  ideaInput.oninput = () => { draftScenario.idea = ideaInput.value; markDirty(); };

  // Language tabs
  renderLangTabs(setup.languages || draftScenario.languages || ['en']);

  // Scenes & lines
  renderScenesList(setup, reviewOnly);

  // Cuts table (multi) or Loop info (single)
  const cutsSec = $('#scenarioCutsSection');
  const loopSec = $('#scenarioLoopSection');
  if (setup.kind === 'multi') {
    cutsSec.hidden = false;
    loopSec.hidden = true;
    renderCutsTable(setup, reviewOnly);
  } else if (setup.kind === 'single') {
    cutsSec.hidden = true;
    loopSec.hidden = false;
    renderSingleLoopRow(setup.lengths || []);
  } else {
    cutsSec.hidden = true;
    loopSec.hidden = true;
  }

  refreshValidationAndActions();
}

function renderLangTabs(languages) {
  const bar = $('#scenarioLangTabs');
  if (!languages.includes(activeLang)) activeLang = languages[0] || 'en';
  bar.replaceChildren(
    ...languages.map((code, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const info = language(code);
      btn.textContent = `${idx === 0 ? '★ ' : ''}${code.toUpperCase()} · ${info.name}`;
      btn.setAttribute('aria-pressed', String(code === activeLang));
      btn.onclick = () => {
        activeLang = code;
        localStorage.setItem(LANG_PREF_KEY, code);
        renderLangTabs(languages);
        renderScenesList(state.campaign?.setup || {}, Boolean(callbacks.readOnly));
      };
      return btn;
    })
  );
}

function renderScenesList(setup, reviewOnly) {
  const container = $('#scenarioScenes');
  const scenes = draftScenario?.scenes || [];
  const lines = draftScenario?.lines || {};
  const formats = setup.formats || ['1x1'];

  container.replaceChildren(
    ...scenes.map(scene => {
      const card = document.createElement('div');
      card.className = 'scene-card';

      const head = document.createElement('div');
      head.className = 'scene-head';
      const badge = document.createElement('span');
      badge.className = 'beat-badge';
      badge.textContent = scene.beat || scene.id;
      head.append(badge);

      if (setup.kind === 'multi' || scene.story !== undefined) {
        const storyInput = document.createElement('input');
        storyInput.type = 'text';
        storyInput.className = 'scene-story-input';
        storyInput.placeholder = 'What happens in this scene?';
        storyInput.value = scene.story || '';
        storyInput.disabled = reviewOnly;
        storyInput.oninput = () => {
          scene.story = storyInput.value;
          markDirty();
        };
        head.append(storyInput);
      }
      card.append(head);

      const linesWrap = document.createElement('div');
      linesWrap.className = 'scene-lines';

      for (const lineKey of scene.lines || []) {
        const line = lines[lineKey];
        if (!line) continue;
        const row = document.createElement('div');
        row.className = 'line-row';

        const roleTag = document.createElement('span');
        roleTag.className = `role-tag role-${line.role}`;
        roleTag.textContent = line.role;
        roleTag.title = `Key: ${lineKey}`;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'line-input';
        input.id = `line-${lineKey}-${activeLang}`;
        input.dir = language(activeLang).dir || 'ltr';
        input.value = line.text?.[activeLang] || '';
        input.placeholder = `Copy (${activeLang})…`;
        input.disabled = reviewOnly;

        const counter = document.createElement('span');
        counter.className = 'char-counter';
        const updateCounter = () => {
          const len = [...(input.value || '').trim()].length;
          counter.textContent = `${len}/${line.maxChars}`;
          counter.classList.toggle('over', len > line.maxChars);
        };
        updateCounter();

        input.oninput = () => {
          if (!line.text) line.text = {};
          line.text[activeLang] = input.value;
          updateCounter();
          markDirty();
          if ((state.campaign?.setup?.kind || draftScenario.kind) === 'multi') {
            renderCutsTable(state.campaign?.setup || {}, reviewOnly);
          }
        };

        row.append(roleTag, input, counter);

        // hideIn tags & toggle menu (for roles that can be hidden)
        if (!ROLES_NO_HIDE.has(line.role) && formats.length > 1) {
          const hideWrap = document.createElement('div');
          hideWrap.className = 'hidein-wrap';
          const renderHideBadges = () => {
            hideWrap.replaceChildren();
            const hiddenIn = Array.isArray(line.hideIn) ? line.hideIn : [];
            for (const fid of hiddenIn) {
              const tag = document.createElement('span');
              tag.className = 'hidein-tag';
              const f = state.formatInfo[fid] || {label: fid};
              tag.textContent = `hidden in ${f.label}`;
              hideWrap.append(tag);
            }
            if (!reviewOnly) {
              const menu = document.createElement('details');
              menu.className = 'hidein-menu';
              const sum = document.createElement('summary');
              sum.textContent = 'Formats ▾';
              sum.title = 'Hide this line in narrow or wide formats';
              const pop = document.createElement('div');
              pop.className = 'hidein-pop';
              for (const fid of formats) {
                const lbl = document.createElement('label');
                lbl.className = 'hidein-opt';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = hiddenIn.includes(fid);
                const f = state.formatInfo[fid] || {label: fid};
                cb.onchange = () => {
                  const cur = new Set(line.hideIn || []);
                  if (cb.checked) cur.add(fid);
                  else cur.delete(fid);
                  line.hideIn = [...cur];
                  renderHideBadges();
                  markDirty();
                };
                lbl.append(cb, document.createTextNode(`Hide in ${f.label}`));
                pop.append(lbl);
              }
              menu.append(sum, pop);
              hideWrap.append(menu);
            }
          };
          renderHideBadges();
          row.append(hideWrap);
        }

        linesWrap.append(row);
      }

      card.append(linesWrap);
      return card;
    })
  );
}

function renderSingleLoopRow(lengths) {
  const el = $('#scenarioLoopInfo');
  const parts = lengths.map(L => {
    const repeats = Math.max(1, Math.round(L / 4));
    const period = (L / repeats).toFixed(L % repeats === 0 ? 1 : 2).replace('.', ',');
    return `${L} s = ${repeats} × ${period} s`;
  });
  el.textContent = parts.join(' · ') || 'Seamless loop';
}

function renderCutsTable(setup, reviewOnly) {
  const table = $('#scenarioCutsTable');
  const scenes = draftScenario?.scenes || [];
  const cuts = draftScenario?.cuts || {};
  const lengths = setup.lengths || Object.keys(cuts).map(Number);
  const {cells} = validateScenarioClient(draftScenario, setup);

  const thead = document.createElement('thead');
  const hRow = document.createElement('tr');
  hRow.append(
    Object.assign(document.createElement('th'), {textContent: 'Length'}),
    ...scenes.map(s => Object.assign(document.createElement('th'), {textContent: `${s.id} · ${s.beat}`})),
    Object.assign(document.createElement('th'), {textContent: 'Note'})
  );
  thead.append(hRow);

  const tbody = document.createElement('tbody');
  for (const len of lengths) {
    const lenKey = String(len);
    const cut = cuts[lenKey] || {scenes: [], note: ''};
    const tr = document.createElement('tr');

    const tdLen = document.createElement('th');
    tdLen.className = 'cut-len-cell';
    tdLen.textContent = `${len} s`;
    tr.append(tdLen);

    for (let sIdx = 0; sIdx < scenes.length; sIdx++) {
      const scene = scenes[sIdx];
      const td = document.createElement('td');
      const winIdx = (cut.scenes || []).findIndex(w => w.id === scene.id);
      const win = winIdx >= 0 ? cut.scenes[winIdx] : null;
      const cellInfo = cells?.[lenKey]?.[scene.id];

      if (!win) {
        td.className = 'cut-cell dropped';
        const dash = document.createElement('span');
        dash.className = 'cut-dropped-dash';
        dash.textContent = '—';
        td.append(dash);
        if (!reviewOnly) {
          const addBtn = document.createElement('button');
          addBtn.type = 'button';
          addBtn.className = 'cut-toggle-scene';
          addBtn.textContent = '+ Include';
          addBtn.onclick = () => includeSceneInCut(len, scene, scenes);
          td.append(addBtn);
        }
      } else {
        const vClass = cellInfo?.verdict ? `cell-${cellInfo.verdict}` : '';
        td.className = `cut-cell ${vClass}`;
        if (cellInfo?.byLang) {
          td.title = Object.entries(cellInfo.byLang)
            .map(([l, d]) => `${l.toUpperCase()}: ${d.need.toFixed(1)} s needed / ${d.have.toFixed(1)} s available (${d.verdict})`)
            .join('\n');
        }

        const timeRow = document.createElement('div');
        timeRow.className = 'cut-time-row';

        const startIn = document.createElement('input');
        startIn.type = 'number';
        startIn.step = '0.1';
        startIn.min = '0';
        startIn.max = String(len);
        startIn.id = `cut-${lenKey}-${scene.id}-start`;
        startIn.value = Number(win.start).toFixed(1);
        startIn.disabled = reviewOnly || winIdx === 0;
        startIn.setAttribute('aria-label', `Start of ${scene.id} (${len} s)`);

        const sep = document.createElement('span');
        sep.textContent = '–';

        const endIn = document.createElement('input');
        endIn.type = 'number';
        endIn.step = '0.1';
        endIn.min = '0.1';
        endIn.max = String(len);
        endIn.id = `cut-${lenKey}-${scene.id}-end`;
        endIn.value = Number(win.end).toFixed(1);
        endIn.disabled = reviewOnly;
        endIn.setAttribute('aria-label', `End of ${scene.id} (${len} s)`);

        startIn.onchange = () => {
          const val = Math.max(0, Math.min(len, Number(startIn.value) || 0));
          win.start = Number(val.toFixed(1));
          if (winIdx > 0) cut.scenes[winIdx - 1].end = win.start;
          markDirty();
          renderCutsTable(setup, reviewOnly);
        };

        endIn.onchange = () => {
          const val = Math.max(0.1, Math.min(len, Number(endIn.value) || len));
          win.end = Number(val.toFixed(1));
          if (winIdx < cut.scenes.length - 1) {
            cut.scenes[winIdx + 1].start = win.end;
          }
          markDirty();
          renderCutsTable(setup, reviewOnly);
        };

        timeRow.append(startIn, sep, endIn);

        if (!reviewOnly && sIdx > 0 && sIdx < scenes.length - 1 && cut.scenes.length > 2) {
          const dropBtn = document.createElement('button');
          dropBtn.type = 'button';
          dropBtn.className = 'cut-drop-btn';
          dropBtn.textContent = '×';
          dropBtn.title = 'Remove this scene from the cut';
          dropBtn.onclick = () => dropSceneFromCut(len, winIdx);
          timeRow.append(dropBtn);
        }

        const chipsRow = document.createElement('div');
        chipsRow.className = 'cut-line-chips';
        for (const lk of scene.lines || []) {
          const chip = document.createElement('button');
          chip.type = 'button';
          const active = (win.lines || []).includes(lk);
          chip.className = 'cut-line-chip';
          chip.setAttribute('aria-pressed', String(active));
          chip.textContent = lk;
          chip.disabled = reviewOnly;
          chip.onclick = () => {
            const set = new Set(win.lines || []);
            if (set.has(lk)) {
              if (set.size <= 1) return;
              set.delete(lk);
            } else {
              set.add(lk);
            }
            win.lines = (scene.lines || []).filter(k => set.has(k));
            markDirty();
            renderCutsTable(setup, reviewOnly);
          };
          chipsRow.append(chip);
        }

        const budget = document.createElement('div');
        budget.className = 'cut-budget';
        if (cellInfo) {
          budget.textContent = `reading time ${cellInfo.need.toFixed(1)} / ${cellInfo.have.toFixed(1)} s`;
        }

        td.append(timeRow, chipsRow, budget);
      }

      tr.append(td);
    }

    const tdNote = document.createElement('td');
    tdNote.className = 'cut-note-cell';
    const noteIn = document.createElement('input');
    noteIn.type = 'text';
    noteIn.className = 'cut-note-input';
    noteIn.value = cut.note || '';
    noteIn.placeholder = 'Cut notes…';
    noteIn.disabled = reviewOnly;
    noteIn.oninput = () => {
      if (!draftScenario.cuts) draftScenario.cuts = {};
      if (!draftScenario.cuts[lenKey]) draftScenario.cuts[lenKey] = {scenes: [], note: ''};
      draftScenario.cuts[lenKey].note = noteIn.value;
      markDirty();
    };
    tdNote.append(noteIn);
    tr.append(tdNote);

    tbody.append(tr);
  }

  table.replaceChildren(thead, tbody);
}

function dropSceneFromCut(len, winIdx) {
  const cut = draftScenario?.cuts?.[String(len)];
  if (!cut || cut.scenes.length <= 2) return;
  const removed = cut.scenes[winIdx];
  cut.scenes.splice(winIdx, 1);
  if (winIdx > 0 && winIdx <= cut.scenes.length) {
    cut.scenes[winIdx - 1].end = removed.end;
  }
  markDirty();
  renderCutsTable(state.campaign?.setup || {}, false);
}

function includeSceneInCut(len, scene, allScenes) {
  if (!draftScenario.cuts) draftScenario.cuts = {};
  const lenKey = String(len);
  const cut = draftScenario.cuts[lenKey] || (draftScenario.cuts[lenKey] = {scenes: [], note: ''});
  const order = new Map(allScenes.map((s, i) => [s.id, i]));
  const targetOrder = order.get(scene.id) ?? 0;

  // Insert at proper position and split surrounding window
  let insertIdx = cut.scenes.findIndex(w => (order.get(w.id) ?? 0) > targetOrder);
  if (insertIdx < 0) insertIdx = cut.scenes.length;

  const donorIdx = Math.max(0, insertIdx - 1);
  const donor = cut.scenes[donorIdx];
  if (donor) {
    const mid = Number(((donor.start + donor.end) / 2).toFixed(1));
    const oldEnd = donor.end;
    donor.end = mid;
    cut.scenes.splice(insertIdx, 0, {
      id: scene.id,
      start: mid,
      end: oldEnd,
      lines: [...(scene.lines || []).slice(0, 1)],
    });
  } else {
    cut.scenes.push({id: scene.id, start: 0, end: len, lines: [...(scene.lines || [])]});
  }
  markDirty();
  renderCutsTable(state.campaign?.setup || {}, false);
}

export function refreshValidationAndActions() {
  const c = state.campaign;
  if (!c || !draftScenario) return;
  const setup = c.setup || {};
  let validation;
  if (jsonMode) {
    try {
      const parsed = JSON.parse($('#scenarioRawText').value);
      validation = validateScenarioClient(parsed, setup);
    } catch (e) {
      validation = {
        errors: [{msg: 'JSON syntax error: ' + e.message, target: '#scenarioRawText'}],
        warnings: [],
        cells: {},
      };
    }
  } else {
    validation = validateScenarioClient(draftScenario, setup);
  }

  const box = $('#scenarioValidation');
  box.replaceChildren();

  if (validation.errors.length) {
    const errList = document.createElement('ul');
    errList.className = 'val-list val-errors';
    for (const err of validation.errors) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '✕ ' + err.msg;
      btn.onclick = () => {
        const el = err.target ? $(err.target) : null;
        el?.focus();
        el?.scrollIntoView({behavior: 'smooth', block: 'center'});
      };
      li.append(btn);
      errList.append(li);
    }
    box.append(errList);
  }

  if (validation.warnings.length) {
    const warnList = document.createElement('ul');
    warnList.className = 'val-list val-warnings';
    for (const w of validation.warnings) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '⚠ ' + w.msg;
      btn.onclick = () => {
        const el = w.target ? $(w.target) : null;
        el?.focus();
        el?.scrollIntoView({behavior: 'smooth', block: 'center'});
      };
      li.append(btn);
      warnList.append(li);
    }
    box.append(warnList);
  }

  const needs = c.steps?.scenario?.needs || [];
  const saveBtn = $('#saveScenarioBtn');
  const trBtn = $('#translateScenarioBtn');
  const cutsBtn = $('#recalcCutsBtn');
  const approveBtn = $('#approveScenarioBtn');

  saveBtn.hidden = !dirty;
  saveBtn.disabled = !dirty || (jsonMode && validation.errors.some(e => e.msg.startsWith('JSON syntax error')));

  trBtn.hidden = !needs.includes('translation');
  cutsBtn.hidden = !(setup.kind === 'multi' && needs.includes('cuts'));

  const isApproved = Boolean(c.steps?.scenario?.approvedAt && !c.steps?.scenario?.stale && !needs.length && !dirty);
  approveBtn.disabled = validation.errors.length > 0 || needs.length > 0 || dirty;
  approveBtn.textContent = isApproved ? '✓ Script approved · Continue to preview →' : 'Approve script →';
  approveBtn.dataset.warnings = String(validation.warnings.length);
}

export function bindScenarioControls({onSave, onRegenerate, onTranslate, onRecalcCuts, onApprove}) {
  $('#scenarioJsonToggle').onclick = () => {
    if (jsonMode) {
      try {
        draftScenario = JSON.parse($('#scenarioRawText').value);
        jsonMode = false;
      } catch (e) {
        alert('Fix the JSON syntax before switching: ' + e.message);
        return;
      }
    } else {
      jsonMode = true;
    }
    renderScenarioEditor();
  };

  $('#regenScenarioToggleBtn').onclick = () => {
    const box = $('#scenarioPromptBox');
    if (box.hidden) {
      box.hidden = false;
      box.dataset.expanded = '1';
      $('#scenarioNotes').focus();
    } else {
      box.hidden = true;
      delete box.dataset.expanded;
    }
  };

  $('#saveScenarioBtn').onclick = () => {
    try {
      const sc = getDraftScenario();
      onSave?.(sc);
    } catch (e) {
      alert('Invalid script JSON: ' + e.message);
    }
  };

  $('#generateScenarioBtn').onclick = () => {
    const notes = $('#scenarioNotes').value.trim();
    delete $('#scenarioPromptBox').dataset.expanded;
    onRegenerate?.(notes);
  };

  $('#translateScenarioBtn').onclick = () => onTranslate?.();
  $('#recalcCutsBtn').onclick = () => onRecalcCuts?.();
  $('#approveScenarioBtn').onclick = () => {
    const warnCount = Number($('#approveScenarioBtn').dataset.warnings || 0);
    if (warnCount > 0) {
      if (!confirm(`The script has ${warnCount} warnings. Approve it anyway?`)) return;
    }
    onApprove?.();
  };
}

// ---- Copy Editor Drawer (§6.6, §8.6) ----

export function openCopyEditor({scenario, setup, currentLength, onSave}) {
  const drawer = $('#copyDrawer');
  const body = $('#copyEditorBody');
  const errBox = $('#copyError');
  errBox.textContent = '';
  if (!scenario || !setup) return;

  const langs = setup.languages || scenario.languages || ['en'];
  const scenes = scenario.scenes || [];
  const lines = scenario.lines || {};
  const working = structuredClone(lines);

  const activeLen = setup.kind === 'multi' ? (currentLength || setup.lengths?.[0] || 0) : 0;
  $('#copyReadingLen').textContent = activeLen ? `Timing for ${activeLen} s` : setup.kind === 'single' ? 'Single scene' : 'Poster';

  const renderVerdictBadge = (sceneId, isClosing) => {
    if (setup.kind !== 'multi' || !activeLen) return '';
    const cut = scenario.cuts?.[String(activeLen)];
    const win = cut?.scenes?.find(w => w.id === sceneId);
    if (!win) return 'not in this cut';
    const have = Number((win.end - win.start).toFixed(2));
    let worst = 'ok';
    let maxNeed = 0;
    const rank = {ok: 0, tight: 1, fail: 2};
    for (const l of langs) {
      const texts = (win.lines || []).map(k => working[k]?.text?.[l] || '');
      const need = windowNeed(texts, l, {closing: isClosing, picture: true});
      if (need > maxNeed) maxNeed = need;
      const v = verdict(have, need);
      if (rank[v] > rank[worst]) worst = v;
    }
    return `reading time ${maxNeed.toFixed(1)} / ${have.toFixed(1)} s (${worst})`;
  };

  body.replaceChildren();
  scenes.forEach((scene, sIdx) => {
    const isClosing = sIdx === scenes.length - 1;
    const sec = document.createElement('section');
    sec.className = 'copy-scene-group';

    const head = document.createElement('div');
    head.className = 'copy-scene-head';
    const title = document.createElement('strong');
    title.textContent = `${scene.id} · ${scene.beat}`;
    const vBadge = document.createElement('span');
    vBadge.className = 'pill';
    vBadge.textContent = renderVerdictBadge(scene.id, isClosing);
    head.append(title, vBadge);
    sec.append(head);

    for (const lk of scene.lines || []) {
      const line = working[lk];
      if (!line) continue;
      const block = document.createElement('div');
      block.className = 'copy-line-block';

      const lineHead = document.createElement('div');
      lineHead.className = 'copy-line-head';
      lineHead.innerHTML = `<span class="role-tag role-${line.role}">${line.role}</span> <code>${lk}</code> <small>max. ${line.maxChars} characters</small>`;
      block.append(lineHead);

      const grid = document.createElement('div');
      grid.className = 'copy-lang-grid';

      for (const l of langs) {
        const cell = document.createElement('div');
        cell.className = 'copy-lang-cell';
        const lbl = document.createElement('label');
        const count = document.createElement('span');
        count.className = 'char-counter';
        lbl.textContent = l.toUpperCase() + ' ';
        lbl.append(count);

        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'line-input';
        inp.dir = language(l).dir || 'ltr';
        inp.value = line.text?.[l] || '';

        const refreshCount = () => {
          const n = [...(inp.value || '').trim()].length;
          count.textContent = `${n}/${line.maxChars}`;
          count.classList.toggle('over', n > line.maxChars);
        };
        refreshCount();

        inp.oninput = () => {
          if (!line.text) line.text = {};
          line.text[l] = inp.value;
          refreshCount();
          vBadge.textContent = renderVerdictBadge(scene.id, isClosing);
        };

        cell.append(lbl, inp);
        grid.append(cell);
      }

      block.append(grid);
      sec.append(block);
    }

    body.append(sec);
  });

  drawer.hidden = false;
  drawer.scrollIntoView({behavior: 'smooth', block: 'nearest'});

  $('#copyCloseBtn').onclick = $('#copyCancelBtn').onclick = () => {
    drawer.hidden = true;
  };

  $('#copySaveBtn').onclick = async () => {
    errBox.textContent = '';
    const patch = {};
    for (const [lk, line] of Object.entries(working)) {
      patch[lk] = {};
      for (const l of langs) {
        const val = (line.text?.[l] || '').trim();
        if (!val) {
          errBox.textContent = `Line "${lk}" (${l}) is empty.`;
          return;
        }
        patch[lk][l] = val;
      }
    }
    try {
      $('#copySaveBtn').disabled = true;
      await onSave?.(patch);
      drawer.hidden = true;
    } catch (e) {
      errBox.textContent = e.message;
    } finally {
      $('#copySaveBtn').disabled = false;
    }
  };
}
