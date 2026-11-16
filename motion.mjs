// Formats, the in-creative runtime (window.FORMA) and the deterministic playback controller.
// Every saved creative gets the runtime in <head> and the controller before </body>.

// safe: platform UI zones as fractions of width/height that must stay free of copy and CTAs.
export const formats = {
  '1x1':   {id:'1x1',   label:'1:1',    name:'Post',            w:1080, h:1080, safe:{top:.05,  bottom:.05,  left:.05, right:.05}},
  '4x5':   {id:'4x5',   label:'4:5',    name:'Feed',            w:1080, h:1350, safe:{top:.05,  bottom:.06,  left:.05, right:.05}},
  '9x16':  {id:'9x16',  label:'9:16',   name:'Reels / Stories', w:1080, h:1920, safe:{top:.13,  bottom:.20,  left:.06, right:.12}},
  '16x9':  {id:'16x9',  label:'16:9',   name:'Pre-roll / YouTube', w:1920, h:1080, safe:{top:.06, bottom:.10, left:.05, right:.05}},
  '5x4':   {id:'5x4',   label:'5:4',    name:'Landscape post',  w:1350, h:1080, safe:{top:.05,  bottom:.05,  left:.05, right:.05}},
  '191x1': {id:'191x1', label:'1.91:1', name:'Link / Display',  w:1200, h:628,  safe:{top:.06,  bottom:.06,  left:.04, right:.04}},
};
export const defaultFormats = ['1x1','4x5','9x16','16x9'];
export const durations = [6,8,10,12,15];

export function pickFormats(ids) {
  const list = Array.isArray(ids) && ids.length ? ids : defaultFormats;
  if (list.length > Object.keys(formats).length || !list.every(id => Object.hasOwn(formats, id))) {
    throw Object.assign(Error('Select formats from the list.'), {status:400});
  }
  return [...new Set(list)].map(id => formats[id]);
}
export function pickDuration(value) {
  const d = Number(value ?? 8);
  if (!durations.includes(d)) throw Object.assign(Error('Unknown video duration.'), {status:400});
  return d;
}

// Pure URL + campaign data → runtime state resolver (also inlined into v2 creatives via .toString()).
export function resolveRuntime(params, data = {}) {
  const q = typeof params === 'string'
    ? new URLSearchParams(params)
    : params && typeof params.get === 'function'
      ? params
      : {get: k => (params && Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : null)};

  const fallbackFormats = {
    '1x1':   {id:'1x1',   label:'1:1',    name:'Post',            w:1080, h:1080, safe:{top:.05,  bottom:.05,  left:.05, right:.05}},
    '4x5':   {id:'4x5',   label:'4:5',    name:'Feed',            w:1080, h:1350, safe:{top:.05,  bottom:.06,  left:.05, right:.05}},
    '9x16':  {id:'9x16',  label:'9:16',   name:'Reels / Stories', w:1080, h:1920, safe:{top:.13,  bottom:.20,  left:.06, right:.12}},
    '16x9':  {id:'16x9',  label:'16:9',   name:'Pre-roll / YouTube', w:1920, h:1080, safe:{top:.06, bottom:.10, left:.05, right:.05}},
    '5x4':   {id:'5x4',   label:'5:4',    name:'Landscape post',  w:1350, h:1080, safe:{top:.05,  bottom:.05,  left:.05, right:.05}},
    '191x1': {id:'191x1', label:'1.91:1', name:'Link / Display',  w:1200, h:628,  safe:{top:.06,  bottom:.06,  left:.04, right:.04}},
  };

  const rawFormats = Array.isArray(data.formats) && data.formats.length ? data.formats : [fallbackFormats['1x1']];
  const list = rawFormats.map(f => (typeof f === 'string' ? fallbackFormats[f] || fallbackFormats['1x1'] : f));
  const reqF = q.get('f');
  const fmt = list.find(f => f.id === reqF) || list[0];
  const short = Math.min(fmt.w, fmt.h), long = Math.max(fmt.w, fmt.h);
  const ratio = fmt.w / fmt.h;
  const orientation = ratio > 1.05 ? 'landscape' : ratio < .95 ? 'portrait' : 'square';
  const safe = {
    top: Math.round(fmt.safe.top * fmt.h),
    bottom: Math.round(fmt.safe.bottom * fmt.h),
    left: Math.round(fmt.safe.left * fmt.w),
    right: Math.round(fmt.safe.right * fmt.w),
  };

  const sc = data.scenario || null;
  const stage = data.stage || 'final';
  const kind = data.kind || sc?.kind || 'multi';

  const rawLangs = Array.isArray(data.langs) && data.langs.length
    ? data.langs
    : Array.isArray(sc?.languages) && sc.languages.length
      ? sc.languages
      : ['en'];
  const langs = rawLangs.map(l => (typeof l === 'string' ? l : l.code));
  const reqL = q.get('l');
  const lang = langs.includes(reqL) ? reqL : langs[0];
  const dir = /^(ar|he|fa|ur)(-|$)/i.test(lang) ? 'rtl' : 'ltr';

  const rawLines = sc?.lines || {};
  const neverHide = {hook: true, offer: true, cta: true};
  const isHidden = key => {
    const ln = rawLines[key];
    if (!ln) return true;
    if (neverHide[ln.role]) return false;
    return Array.isArray(ln.hideIn) && ln.hideIn.includes(fmt.id);
  };

  const copy = {};
  const lines = {};
  for (const [key, ln] of Object.entries(rawLines)) {
    lines[key] = {role: ln.role, scene: ln.scene};
    if (!isHidden(key)) {
      copy[key] = ln.text?.[lang] ?? ln.text?.[langs[0]] ?? '';
    }
  }

  const scenes = (sc?.scenes || []).map(s => ({
    id: s.id,
    beat: s.beat,
    lines: (s.lines || []).filter(k => !isHidden(k)),
  }));

  let scene = null;
  if (stage === 'preview') {
    const reqScene = q.get('scene');
    scene = scenes.some(s => s.id === reqScene) ? reqScene : (scenes[0]?.id || null);
  } else {
    const reqScene = q.get('scene');
    if (reqScene && scenes.some(s => s.id === reqScene)) scene = reqScene;
  }

  const cutKeys = sc?.cuts ? Object.keys(sc.cuts).map(Number).filter(n => !Number.isNaN(n)) : [];
  const lengths = (Array.isArray(data.lengths) && data.lengths.length ? data.lengths : cutKeys).map(Number);

  let length = 0;
  let cut = null;
  let loop = null;

  if (stage !== 'preview' && kind !== 'poster') {
    const availLengths = lengths.length ? lengths : [Number(data.duration) || (kind === 'single' ? 6 : 8)];
    const reqD = Number(q.get('d'));
    length = availLengths.includes(reqD) ? reqD : availLengths[0];

    if (kind === 'single') {
      const repeats = Math.max(1, Math.round(length / 4));
      const period = length / repeats;
      loop = {period, repeats};
    } else if (kind === 'multi') {
      const rawCut = sc?.cuts?.[String(length)] || sc?.cuts?.[String(availLengths[0])] || null;
      if (rawCut && Array.isArray(rawCut.scenes)) {
        cut = {
          length,
          scenes: rawCut.scenes.map(w => ({
            id: w.id,
            start: w.start,
            end: w.end,
            lines: (w.lines || []).filter(k => !isHidden(k)),
          })),
        };
      }
    }
  }

  return {
    format: fmt.id,
    label: fmt.label,
    width: fmt.w,
    height: fmt.h,
    short,
    long,
    ratio,
    orientation,
    safe,
    formats: list.map(f => f.id),
    kind,
    stage,
    lang,
    langs,
    dir,
    copy,
    lines,
    scenes,
    cut,
    loop,
    length,
    duration: length,
    scene,
  };
}

// Legacy runtime: runs inside the preview iframe, before any creative code.
// Kept untouched so stage === 'legacy' produces byte-identical output.
function runtime(list, duration) {
  const params = new URLSearchParams(location.search);
  const fmt = list.find(f => f.id === params.get('f')) || list[0];
  const short = Math.min(fmt.w, fmt.h), long = Math.max(fmt.w, fmt.h);
  const ratio = fmt.w / fmt.h;
  const orientation = ratio > 1.05 ? 'landscape' : ratio < .95 ? 'portrait' : 'square';
  const safe = {top:Math.round(fmt.safe.top*fmt.h), bottom:Math.round(fmt.safe.bottom*fmt.h), left:Math.round(fmt.safe.left*fmt.w), right:Math.round(fmt.safe.right*fmt.w)};
  const root = document.documentElement;
  root.dataset.format = fmt.id;
  root.dataset.orientation = orientation;
  const vars = {'--w':fmt.w+'px','--h':fmt.h+'px','--s':short/100+'px','--l':long/100+'px',
    '--safe-top':safe.top+'px','--safe-bottom':safe.bottom+'px','--safe-left':safe.left+'px','--safe-right':safe.right+'px'};
  for (const [k,v] of Object.entries(vars)) root.style.setProperty(k,v);
  const setups = [];
  window.FORMA = {
    format:fmt.id, label:fmt.label, width:fmt.w, height:fmt.h, short, long, ratio, orientation, safe,
    formats:list.map(f => f.id), duration, playing:false,
    // Register async setup (measuring text, building timelines, loading textures). Runs after fonts and images load.
    setup(fn) { setups.push(fn); },
    _setups:setups,
    // Shrink an element's font-size until its content fits its own box. Returns the chosen px size.
    fit(el, {max=short*.2, min=short*.03, step=1} = {}) {
      if (!el) return 0;
      const fits = () => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1;
      let lo = min, hi = max, best = min;
      el.style.fontSize = hi + 'px';
      if (fits()) return hi;
      while (hi - lo > step) {
        const mid = (lo + hi) / 2;
        el.style.fontSize = mid + 'px';
        if (fits()) { best = mid; lo = mid; } else hi = mid;
      }
      el.style.fontSize = best + 'px';
      return best;
    },
    // Keep a muted <video> in step with timeline time t. offset = timeline second where the clip starts.
    syncVideo(video, t, offset = 0) {
      if (!video) return;
      video.muted = true; video.playsInline = true;
      const target = Math.max(0, Math.min((video.duration || Infinity) - .05, t - offset));
      if (window.FORMA.playing && t >= offset) {
        if (video.paused) video.play().catch(() => {});
        if (Math.abs(video.currentTime - target) > .25) video.currentTime = target;
      } else {
        if (!video.paused) video.pause();
        if (Math.abs(video.currentTime - target) > .04) video.currentTime = target;
      }
    },
    // Deterministic pseudo-random generator for particles, jitter, etc.
    random(seed = 1) { let s = seed >>> 0 || 1; return () => ((s = Math.imul(s ^ s >>> 15, 1 | s), s ^= s + Math.imul(s ^ s >>> 7, 61 | s), (s ^ s >>> 14) >>> 0) / 4294967296); },
  };
}

// Legacy controller: runs at the end of <body>. Drives window.renderFrame(t); the parent page controls it via postMessage.
function controller() {
  const F = window.FORMA, D = F.duration, params = new URLSearchParams(location.search);
  let t = Math.max(0, Math.min(D, Number(params.get('t')) || 0)), playing = !params.has('paused'), last = null, started = false;
  const send = () => { try { parent.postMessage({type:'forma:time', t, duration:D, playing, timeline:typeof window.renderFrame === 'function', format:F.format}, '*'); } catch {} };
  const draw = () => { try { window.renderFrame?.(t); } catch (e) { console.error(e); } send(); };
  function tick(now) {
    if (!playing) return;
    if (last !== null) t = Math.min(D, t + (now - last) / 1000);
    last = now;
    draw();
    if (t >= D) { playing = F.playing = false; send(); return; }
    requestAnimationFrame(tick);
  }
  function play() { if (!started) return; if (t >= D) t = 0; playing = F.playing = true; last = null; requestAnimationFrame(tick); }
  function pause() { playing = F.playing = false; draw(); }
  addEventListener('message', e => {
    if (e.source !== parent || !e.data) return;
    const m = e.data;
    if (m.type === 'forma:play') play();
    if (m.type === 'forma:pause') pause();
    if (m.type === 'forma:seek') { t = Math.max(0, Math.min(D, Number(m.t) || 0)); if (!playing) draw(); }
    if (m.type === 'forma:hello') send();
  });
  const loaded = document.readyState === 'complete' ? Promise.resolve() : new Promise(r => addEventListener('load', r, {once:true}));
  Promise.all([loaded, document.fonts.ready])
    .then(async () => { for (const fn of F._setups) await fn(); })
    .catch(e => console.error(e))
    .then(() => { started = true; F.playing = playing; draw(); if (playing) play(); });
}

// Runtime v2 for preview and final stages.
function runtimeV2(resolveFn, data) {
  const params = new URLSearchParams(location.search);
  const state = resolveFn(params, data);
  const short = state.short, long = state.long, safe = state.safe;
  const root = document.documentElement;
  root.lang = state.lang;
  root.dir = state.dir;
  root.dataset.format = state.format;
  root.dataset.orientation = state.orientation;
  root.dataset.kind = state.kind;
  root.dataset.stage = state.stage;
  root.dataset.lang = state.lang;
  const vars = {
    '--w': state.width + 'px',
    '--h': state.height + 'px',
    '--s': short / 100 + 'px',
    '--l': long / 100 + 'px',
    '--safe-top': safe.top + 'px',
    '--safe-bottom': safe.bottom + 'px',
    '--safe-left': safe.left + 'px',
    '--safe-right': safe.right + 'px',
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  const setups = [];
  window.FORMA = {
    ...state,
    playing: false,
    setup(fn) { setups.push(fn); },
    _setups: setups,
    fit(el, {max = short * .2, min = short * .03, step = 1} = {}) {
      if (!el) return 0;
      const fits = () => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1;
      let lo = min, hi = max, best = min;
      el.style.fontSize = hi + 'px';
      if (fits()) return hi;
      while (hi - lo > step) {
        const mid = (lo + hi) / 2;
        el.style.fontSize = mid + 'px';
        if (fits()) { best = mid; lo = mid; } else hi = mid;
      }
      el.style.fontSize = best + 'px';
      return best;
    },
    fitGroup(elements, {max = short * .2, min = short * .03, step = 1} = {}) {
      const list = Array.from(elements || []).filter(Boolean);
      if (!list.length) return 0;
      const fitsAll = size => {
        for (const el of list) el.style.fontSize = size + 'px';
        return list.every(el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1);
      };
      let lo = min, hi = max, best = min;
      if (fitsAll(hi)) return hi;
      while (hi - lo > step) {
        const mid = (lo + hi) / 2;
        if (fitsAll(mid)) { best = mid; lo = mid; } else hi = mid;
      }
      for (const el of list) el.style.fontSize = best + 'px';
      return best;
    },
    syncVideo(video, t, offset = 0) {
      if (!video) return;
      video.muted = true; video.playsInline = true;
      const target = Math.max(0, Math.min((video.duration || Infinity) - .05, t - offset));
      if (window.FORMA.playing && t >= offset) {
        if (video.paused) video.play().catch(() => {});
        if (Math.abs(video.currentTime - target) > .25) video.currentTime = target;
      } else {
        if (!video.paused) video.pause();
        if (Math.abs(video.currentTime - target) > .04) video.currentTime = target;
      }
    },
    random(seed = 1) {
      let s = seed >>> 0 || 1;
      return () => ((s = Math.imul(s ^ s >>> 15, 1 | s), s ^= s + Math.imul(s ^ s >>> 7, 61 | s), (s ^ s >>> 14) >>> 0) / 4294967296);
    },
  };
}

// Controller v2: static for poster/preview stages; timeline playback from 0 to FORMA.length for single/multi final.
function controllerV2() {
  const F = window.FORMA, isStatic = F.stage === 'preview' || F.kind === 'poster';
  if (isStatic) {
    const send = () => {
      try {
        parent.postMessage({type:'forma:time', t:0, duration:0, playing:false, timeline:false, static:true, format:F.format, lang:F.lang, scene:F.scene}, '*');
      } catch {}
    };
    const draw = () => { try { window.renderFrame?.(0); } catch (e) { console.error(e); } send(); };
    addEventListener('message', e => {
      if (e.source !== parent || !e.data) return;
      if (e.data.type === 'forma:hello') send();
    });
    const loaded = document.readyState === 'complete' ? Promise.resolve() : new Promise(r => addEventListener('load', r, {once:true}));
    Promise.all([loaded, document.fonts.ready])
      .then(async () => { for (const fn of F._setups) await fn(); })
      .catch(e => console.error(e))
      .then(() => { F.playing = false; draw(); });
    return;
  }

  const D = F.length, params = new URLSearchParams(location.search);
  let t = Math.max(0, Math.min(D, Number(params.get('t')) || 0)), playing = !params.has('paused'), last = null, started = false;
  const send = () => {
    try {
      parent.postMessage({type:'forma:time', t, duration:D, playing, timeline:typeof window.renderFrame === 'function', format:F.format, lang:F.lang, length:D}, '*');
    } catch {}
  };
  const draw = () => { try { window.renderFrame?.(t); } catch (e) { console.error(e); } send(); };
  function tick(now) {
    if (!playing) return;
    if (last !== null) t = Math.min(D, t + (now - last) / 1000);
    last = now;
    draw();
    if (t >= D) { playing = F.playing = false; send(); return; }
    requestAnimationFrame(tick);
  }
  function play() { if (!started) return; if (t >= D) t = 0; playing = F.playing = true; last = null; requestAnimationFrame(tick); }
  function pause() { playing = F.playing = false; draw(); }
  addEventListener('message', e => {
    if (e.source !== parent || !e.data) return;
    const m = e.data;
    if (m.type === 'forma:play') play();
    if (m.type === 'forma:pause') pause();
    if (m.type === 'forma:seek') { t = Math.max(0, Math.min(D, Number(m.t) || 0)); if (!playing) draw(); }
    if (m.type === 'forma:hello') send();
  });
  const loaded = document.readyState === 'complete' ? Promise.resolve() : new Promise(r => addEventListener('load', r, {once:true}));
  Promise.all([loaded, document.fonts.ready])
    .then(async () => { for (const fn of F._setups) await fn(); })
    .catch(e => console.error(e))
    .then(() => { started = true; F.playing = playing; draw(); if (playing) play(); });
}

const json = value => JSON.stringify(value).replaceAll('<', '\\u003c');

export function inject(html, {
  stage = 'legacy',
  kind,
  formats: list,
  langs = ['en'],
  lengths = [],
  duration,
  scenario = null,
  libs = '',
} = {}) {
  if (stage === 'legacy') {
    const head = '<script>(' + runtime.toString() + ')(' + json(list) + ',' + duration + ')</script>' + libs;
    html = /<head\b[^>]*>/i.test(html)
      ? html.replace(/<head\b[^>]*>/i, m => m + head)
      : html.replace(/<html\b[^>]*>/i, m => m + '<head>' + head + '</head>');
    const tail = '<script>(' + controller.toString() + ')()</script>';
    return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i, m => tail + m) : html.replace(/<\/html\s*>/i, m => tail + m);
  }

  const normalizedFormats = (Array.isArray(list) && list.length ? list : defaultFormats).map(f => (typeof f === 'string' ? formats[f] || formats['1x1'] : f));
  const payload = {
    stage,
    kind: kind || scenario?.kind || 'multi',
    formats: normalizedFormats,
    langs,
    lengths,
    duration,
    scenario,
  };
  const head = '<script>(' + runtimeV2.toString() + ')(' + resolveRuntime.toString() + ',' + json(payload) + ')</script>' + libs;
  html = /<head\b[^>]*>/i.test(html)
    ? html.replace(/<head\b[^>]*>/i, m => m + head)
    : html.replace(/<html\b[^>]*>/i, m => m + '<head>' + head + '</head>');
  const tail = '<script>(' + controllerV2.toString() + ')()</script>';
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i, m => tail + m) : html.replace(/<\/html\s*>/i, m => tail + m);
}

// Reverses inject(): returns the model-authored document (for revisions of creatives saved without a .src.html copy).
export function uninject(html) {
  return html
    .replace(/<script>\(function runtime\w*\([\s\S]*?<\/script>/, '')
    .replace(/<script>\(function controller\w*\([\s\S]*?<\/script>/, '')
    .replace(/<script>document\.fonts\.ready\.then\(\(\)=>\{\(function playShortFilm[\s\S]*?<\/script>/, '')
    .replace(/<script type="importmap">\{"imports":\{"three":"\/lib\/three\/build\/three\.module\.js"[\s\S]*?<\/script>/, '')
    .replace('<script src="/lib/gsap.js"></script>', '')
    .replace('<script src="/lib/lottie.js"></script>', '')
    .replace(/<head><\/head>/, '');
}
