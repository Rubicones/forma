// Preview stage, format/language/length switchers, storyboard strip and playback controls (§8.5, §8.6, §10).
import {language} from '/shared/languages.mjs';
import {state} from '/campaign.js';

import {$} from './dom.js';

export const view = {
  url: null,
  stage: 'legacy', // 'empty' | 'legacy' | 'preview' | 'final'
  kind: 'multi',
  formats: ['1x1'],
  langs: ['en'],
  lengths: [],
  format: '1x1',
  lang: 'en',
  length: 8,
  duration: 8,
  scene: null,
  scenes: [], // [{id, beat}]
  timeline: false,
  draftRev: 0,
};

export let playback = {t: 0, playing: false};
let scrubbing = false;
let onSwitchVariant = null;

export function setVariantSwitchHandler(fn) {
  onSwitchVariant = fn;
}

export function variantsForStage(campaign = state.campaign, stage = view.stage, activeStep = state.activeStep) {
  if (!Array.isArray(campaign?.variants)) return [];
  if (activeStep === 2 || stage === 'preview') {
    return campaign.variants.filter(v => Boolean(v.previewPath || v.preview?.path));
  }
  if (stage === 'final' || activeStep === 3) {
    return campaign.variants.filter(v => Boolean(v.finalPath || v.final?.path || v.previewPath || v.preview?.path));
  }
  return [];
}

export function frameURL({
  format = view.format,
  lang = view.lang,
  length = view.length,
  scene = view.scene,
  keepTime = false,
} = {}) {
  if (!view.url) return '';
  if (view.url.endsWith('/demo')) return view.url;
  const q = new URLSearchParams({f: format});
  if (view.stage === 'preview' || view.stage === 'final') {
    if (lang) q.set('l', lang);
  }
  if (view.stage === 'preview' && scene) {
    q.set('scene', scene);
  }
  if (view.stage === 'final' && view.kind !== 'poster' && length) {
    q.set('d', String(length));
  }
  if (view.draftRev) q.set('v', String(view.draftRev));
  if (keepTime && (view.timeline || (view.stage === 'final' && view.kind !== 'poster'))) {
    q.set('t', playback.t.toFixed(3));
    if (!playback.playing) q.set('paused', '');
  }
  return view.url + '?' + q.toString();
}

export function layoutArtboard() {
  const stage = $('.stage');
  const artboard = $('.artboard');
  const frame = $('#stageFrame');
  if (!stage || !artboard || !frame) return;
  const f = state.formatInfo[view.format] || state.formatInfo['1x1'] || {w: 1080, h: 1080};
  const cs = getComputedStyle(stage);
  const availW = Math.max(120, stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
  const maxH = Math.max(280, innerHeight * 0.68);
  const scale = Math.max(0.05, Math.min(availW / f.w, maxH / f.h));
  artboard.style.width = f.w * scale + 'px';
  artboard.style.height = f.h * scale + 'px';
  frame.style.width = f.w + 'px';
  frame.style.height = f.h + 'px';
  frame.style.transform = 'scale(' + scale + ')';
}

export function updatePlayer() {
  const scrub = $('#scrub');
  const playButton = $('#play');
  const timeLabel = $('#time');
  const playerBar = $('#playerBar');
  if (!scrub || !playButton || !timeLabel || !playerBar) return;

  const hideTransport = view.stage === 'empty' || view.stage === 'preview' || (view.stage === 'final' && view.kind === 'poster');
  playerBar.hidden = hideTransport;

  const dur = view.duration || view.length || 8;
  scrub.max = dur;
  if (!scrubbing) scrub.value = playback.t;
  timeLabel.textContent = playback.t.toFixed(1) + ' / ' + dur.toFixed(1) + ' с';
  playButton.textContent = playback.playing ? '❚❚' : '▶';
  playButton.setAttribute('aria-label', playback.playing ? 'Пауза' : 'Воспроизвести');
  playButton.disabled = scrub.disabled = !view.timeline;
}

export function renderSwitchers() {
  const switchers = $('#playerSwitchers');
  const stylesRow = $('#viewStylesRow');
  const viewStyles = $('#viewStyles');
  const formatsRow = $('#viewFormatsRow');
  const viewFormats = $('#viewFormats');
  const viewLangs = $('#viewLangs');
  const viewLengths = $('#viewLengths');
  const langRow = $('#viewLangsRow');
  const lenRow = $('#viewLengthsRow');
  const badge = $('#previewStageBadge');

  if (view.stage === 'empty') {
    switchers.hidden = true;
    badge.hidden = true;
    return;
  }

  // Style switcher row (§4.3): shown when ≥ 2 variants have a result for the stage on screen
  const stageVars = (view.stage === 'preview' || view.stage === 'final') ? variantsForStage() : [];
  const showStyles = stageVars.length >= 2;
  if (stylesRow && viewStyles) {
    stylesRow.hidden = !showStyles;
    if (showStyles) {
      const activeVid = state.campaign?.activeVariant;
      viewStyles.replaceChildren(
        ...stageVars.map(v => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'style-chip';
          b.setAttribute('aria-pressed', String(v.id === activeVid));
          const tipParts = [v.styleIdea || v.style?.idea || '', v.author ? `Автор: ${v.author}` : ''].filter(Boolean);
          b.title = tipParts.length ? tipParts.join(' · ') : (v.label || '');

          const svg = v.styleSvg || v.style?.svg;
          if (svg) {
            const img = new Image(14, 14);
            img.className = 'style-swatch';
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
            img.alt = '';
            b.append(img);
          }

          const lbl = document.createElement('span');
          lbl.textContent = v.label || 'Стиль';
          b.append(lbl);

          const isPreviewStage = view.stage === 'preview' || state.activeStep === 2;
          const isStale = isPreviewStage
            ? Boolean(v.previewStale ?? v.preview?.stale)
            : Boolean(v.finalPath ? (v.finalStale ?? v.final?.stale) : (v.previewStale ?? v.preview?.stale));
          const isApproved = isPreviewStage
            ? Boolean(v.previewApproved ?? (v.preview?.approvedAt && !v.preview?.stale))
            : Boolean((v.finalPath && !isStale) || (v.previewApproved ?? (v.preview?.approvedAt && !v.preview?.stale)));

          if (isStale || isApproved) {
            const mark = document.createElement('small');
            mark.className = isStale ? 'mark-warn' : 'mark-ok';
            mark.textContent = isStale ? '⚠' : '✓';
            b.append(mark);
          }

          b.onclick = () => {
            if (v.id !== state.campaign?.activeVariant) {
              onSwitchVariant?.(v.id);
            }
          };
          return b;
        })
      );
    } else {
      viewStyles.replaceChildren();
    }
  }

  if (view.stage === 'preview') {
    if (formatsRow) formatsRow.hidden = true;
    langRow.hidden = true;
    lenRow.hidden = true;
    switchers.hidden = !showStyles;
    const f = state.formatInfo[view.format] || {label: view.format};
    badge.textContent = `Превью · ${f.label} · ${(view.lang || 'en').toUpperCase()}`;
    badge.hidden = false;
    return;
  }

  badge.hidden = true;
  switchers.hidden = false;
  if (formatsRow) formatsRow.hidden = false;

  // Formats row
  viewFormats.replaceChildren(
    ...view.formats.map(id => {
      const f = state.formatInfo[id] || {label: id};
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = f.label;
      b.title = f.name || '';
      b.setAttribute('aria-pressed', String(id === view.format));
      b.onclick = () => setFormat(id);
      return b;
    })
  );

  if (view.stage === 'legacy') {
    langRow.hidden = true;
    lenRow.hidden = true;
    return;
  }

  // Languages row
  langRow.hidden = false;
  viewLangs.replaceChildren(
    ...view.langs.map((code, idx) => {
      const info = language(code);
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = (idx === 0 ? '★ ' : '') + code.toUpperCase();
      b.title = info.name;
      b.setAttribute('aria-pressed', String(code === view.lang));
      b.onclick = () => setLang(code);
      return b;
    })
  );

  // Lengths row (hidden for posters)
  if (view.kind === 'poster' || !view.lengths.length) {
    lenRow.hidden = true;
    viewLengths.replaceChildren();
  } else {
    lenRow.hidden = false;
    viewLengths.replaceChildren(
      ...view.lengths.map(len => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `${len} с`;
        b.setAttribute('aria-pressed', String(Number(len) === Number(view.length)));
        b.onclick = () => setLength(Number(len));
        return b;
      })
    );
  }
}

export function renderStoryboard() {
  const strip = $('#storyboard');
  if (view.stage !== 'preview' || view.kind !== 'multi' || !view.url || !view.scenes.length) {
    strip.hidden = true;
    strip.replaceChildren();
    return;
  }
  strip.hidden = false;
  const f = state.formatInfo[view.format] || {w: 1080, h: 1920};
  const thumbW = 84;
  const scale = thumbW / f.w;
  const thumbH = Math.round(f.h * scale);

  strip.replaceChildren(
    ...view.scenes.map(sc => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sb-thumb';
      btn.setAttribute('aria-pressed', String(sc.id === view.scene));

      const box = document.createElement('div');
      box.className = 'sb-frame-wrap';
      box.style.width = thumbW + 'px';
      box.style.height = thumbH + 'px';

      const mini = document.createElement('iframe');
      mini.setAttribute('sandbox', 'allow-scripts');
      mini.tabIndex = -1;
      mini.style.width = f.w + 'px';
      mini.style.height = f.h + 'px';
      mini.style.transform = `scale(${scale})`;
      mini.src = frameURL({scene: sc.id, keepTime: false});
      box.append(mini);

      const label = document.createElement('span');
      label.className = 'sb-beat';
      label.textContent = sc.beat || sc.id;

      btn.append(box, label);
      btn.onclick = () => setScene(sc.id);
      return btn;
    })
  );
}

export async function renderSingleMotionNote() {
  const noteBox = $('#singleLoopNote');
  const listEl = $('#singleMotionList');
  if (view.stage !== 'preview' || view.kind !== 'single' || !view.url) {
    noteBox.hidden = true;
    listEl.replaceChildren();
    return;
  }
  noteBox.hidden = false;
  listEl.replaceChildren();
  try {
    const res = await fetch(view.url);
    if (!res.ok) return;
    const html = await res.text();
    const match = html.match(/<script[^>]*id=["']forma-motion["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!match) return;
    const data = JSON.parse(match[1]);
    const items = [];
    if (data.loop) items.push('Петля: ' + data.loop);
    if (Array.isArray(data.still) && data.still.length) items.push('Статично: ' + data.still.join(', '));
    for (const text of items) {
      const li = document.createElement('li');
      li.textContent = text;
      listEl.append(li);
    }
  } catch {}
}

export function setFormat(id) {
  if (id === view.format || !view.formats.includes(id)) return;
  view.format = id;
  renderSwitchers();
  layoutArtboard();
  if (view.url) {
    const frame = $('#stageFrame');
    frame.src = frameURL({keepTime: true});
  }
}

export function setLang(code) {
  if (code === view.lang || !view.langs.includes(code)) return;
  view.lang = code;
  renderSwitchers();
  if (view.url) {
    const frame = $('#stageFrame');
    frame.src = frameURL({keepTime: true});
  }
}

export function setLength(len) {
  const num = Number(len);
  if (num === Number(view.length) || !view.lengths.map(Number).includes(num)) return;
  view.length = num;
  view.duration = num;
  playback = {t: 0, playing: true};
  view.timeline = false;
  renderSwitchers();
  updatePlayer();
  if (view.url) {
    const frame = $('#stageFrame');
    frame.src = frameURL({keepTime: false});
  }
}

export function setScene(sceneId) {
  if (sceneId === view.scene) return;
  view.scene = sceneId;
  for (const btn of document.querySelectorAll('#storyboard .sb-thumb')) {
    const idx = [...btn.parentNode.children].indexOf(btn);
    btn.setAttribute('aria-pressed', String(view.scenes[idx]?.id === sceneId));
  }
  if (view.url) {
    const frame = $('#stageFrame');
    frame.src = frameURL({scene: sceneId, keepTime: false});
  }
}

export function showEmptyStage(message = 'Здесь появится превью после шага «Сценарий»') {
  view.url = null;
  view.stage = 'empty';
  view.timeline = false;
  playback = {t: 0, playing: false};
  const emptyEl = $('#stageEmpty');
  const artboard = $('.artboard');
  const frame = $('#stageFrame');
  if (emptyEl) {
    emptyEl.textContent = message;
    emptyEl.hidden = false;
  }
  if (artboard) artboard.hidden = true;
  if (frame) frame.removeAttribute('src');
  renderSwitchers();
  renderStoryboard();
  renderSingleMotionNote();
  updatePlayer();
}

export function showStage({
  url,
  stage = 'legacy',
  kind = 'multi',
  formats = ['1x1'],
  langs = ['en'],
  lengths = [],
  duration = 8,
  scenes = [],
  scene = null,
  keepTime = false,
}) {
  const emptyEl = $('#stageEmpty');
  const artboard = $('.artboard');
  const frame = $('#stageFrame');
  if (emptyEl) emptyEl.hidden = true;
  if (artboard) artboard.hidden = false;

  const sameBaseUrl = view.url === url && view.stage === stage && view.kind === kind;

  view.url = url;
  view.stage = stage;
  view.kind = kind;
  view.draftRev = 0;
  view.formats = formats?.length ? [...formats] : ['1x1'];
  view.langs = langs?.length ? [...langs] : ['en'];
  view.lengths = lengths?.length ? lengths.map(Number) : [];
  if (!view.formats.includes(view.format)) view.format = view.formats[0];
  if (!view.langs.includes(view.lang)) view.lang = view.langs[0];
  if (view.lengths.length && !view.lengths.includes(Number(view.length))) {
    view.length = view.lengths[0];
  }
  view.duration = stage === 'final' && kind !== 'poster' ? (view.length || duration || 8) : (duration || 8);
  view.scenes = scenes;
  view.scene = scene || ((sameBaseUrl || keepTime) && view.scene && scenes.some(s => s.id === view.scene) ? view.scene : scenes[0]?.id || null);

  const preservePlayback = Boolean(keepTime && stage === 'final' && kind !== 'poster');
  const targetSrc = frameURL({keepTime: preservePlayback});
  const alreadyLoaded = sameBaseUrl && frame?.getAttribute('src') === targetSrc;

  if (!alreadyLoaded && !preservePlayback) {
    view.timeline = false;
    playback = {t: 0, playing: stage !== 'preview' && kind !== 'poster'};
  }

  renderSwitchers();
  layoutArtboard();
  updatePlayer();
  renderStoryboard();
  renderSingleMotionNote();

  if (frame && url) {
    if (alreadyLoaded) {
      frame.contentWindow?.postMessage({type: 'forma:hello'}, '*');
    } else {
      frame.src = targetSrc;
    }
  }
}

export function initPlayerControls() {
  const stage = $('.stage');
  const frame = $('#stageFrame');
  const scrub = $('#scrub');
  const playButton = $('#play');

  if (stage) new ResizeObserver(layoutArtboard).observe(stage);

  const post = message => frame?.contentWindow?.postMessage(message, '*');

  if (frame) {
    frame.addEventListener('load', () => {
      post({type: 'forma:hello'});
    });
  }

  addEventListener('message', e => {
    if (e.source !== frame?.contentWindow || e.data?.type !== 'forma:time') return;
    playback = {t: Number(e.data.t) || 0, playing: Boolean(e.data.playing)};
    view.timeline = Boolean(e.data.timeline);
    if (e.data.duration) view.duration = Number(e.data.duration);
    updatePlayer();
  });

  if (playButton) {
    playButton.onclick = () => post({type: playback.playing ? 'forma:pause' : 'forma:play'});
  }
  if (scrub) {
    scrub.oninput = () => {
      scrubbing = true;
      if (playback.playing) post({type: 'forma:pause'});
      post({type: 'forma:seek', t: Number(scrub.value)});
    };
    scrub.onchange = () => {
      scrubbing = false;
    };
  }

  // Keyboard shortcuts when stage / preview card has focus (§8.5, §8.6)
  addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;
    const previewCard = $('.preview.card');
    if (!previewCard) return;
    const stageFocused = previewCard.contains(document.activeElement) || document.activeElement === document.body;
    if (!stageFocused) return;

    if (view.timeline && (e.key === ' ' || e.key === 'Spacebar')) {
      e.preventDefault();
      post({type: playback.playing ? 'forma:pause' : 'forma:play'});
      return;
    }

    if (view.stage === 'preview' && view.kind === 'multi' && view.scenes.length > 1) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const idx = view.scenes.findIndex(s => s.id === view.scene);
        const delta = e.key === 'ArrowRight' ? 1 : -1;
        const next = view.scenes[(idx + delta + view.scenes.length) % view.scenes.length];
        if (next) setScene(next.id);
        return;
      }
    }

    if (view.timeline && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const dur = view.duration || view.length || 8;
      const nextT = Math.max(0, Math.min(dur, playback.t + (e.key === 'ArrowRight' ? 0.5 : -0.5)));
      if (playback.playing) post({type: 'forma:pause'});
      post({type: 'forma:seek', t: nextT});
      return;
    }

    const key = e.key.toLowerCase();
    if (key === 's' && (view.stage === 'preview' || view.stage === 'final')) {
      const stageVars = variantsForStage();
      if (stageVars.length >= 2) {
        e.preventDefault();
        const idx = stageVars.findIndex(v => v.id === state.campaign?.activeVariant);
        const next = stageVars[(idx + 1) % stageVars.length];
        if (next) onSwitchVariant?.(next.id);
        return;
      }
    }

    if (view.stage === 'final') {
      if (key === 'f' && view.formats.length > 1) {
        e.preventDefault();
        const idx = view.formats.indexOf(view.format);
        setFormat(view.formats[(idx + 1) % view.formats.length]);
      } else if (key === 'l' && view.langs.length > 1) {
        e.preventDefault();
        const idx = view.langs.indexOf(view.lang);
        setLang(view.langs[(idx + 1) % view.langs.length]);
      } else if (key === 'd' && view.lengths.length > 1 && view.kind !== 'poster') {
        e.preventDefault();
        const idx = view.lengths.indexOf(Number(view.length));
        setLength(view.lengths[(idx + 1) % view.lengths.length]);
      }
    }
  });
}

export function restartPlayer() {
  const frame = $('#stageFrame');
  if (!frame) return;
  if (view.timeline) {
    frame.contentWindow?.postMessage({type: 'forma:seek', t: 0}, '*');
    frame.contentWindow?.postMessage({type: 'forma:play'}, '*');
  } else if (view.url) {
    playback = {t: 0, playing: view.stage !== 'preview' && view.kind !== 'poster'};
    frame.src = frameURL({keepTime: false});
  }
}
