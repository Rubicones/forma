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
  // The page runs in an opaque sandbox origin: a picture or clip loaded without CORS taints any canvas or WebGL that
  // reads it (empty 3D, green keying). Everything the creative makes in code asks for CORS; the server allows it.
  const NativeImage = window.Image;
  if (typeof NativeImage === 'function') {
    window.Image = function Image(w, h) { const img = new NativeImage(w, h); img.crossOrigin = 'anonymous'; return img; };
    window.Image.prototype = NativeImage.prototype;
  }
  if (typeof Document !== 'undefined' && Document.prototype?.createElement) {
    const createElement = Document.prototype.createElement;
    Document.prototype.createElement = function (name, options) {
      const el = createElement.call(this, name, options);
      if (/^(img|video|audio)$/i.test(String(name))) el.crossOrigin = 'anonymous';
      return el;
    };
  }
  // Pixel density for WebGL and canvas: ?pr= when Forma asks; otherwise 2 on a real GPU (smooth edges), 1 on the
  // software renderer of headless review (four times fewer pixels), and never past 4096 px on the long side.
  let pixelRatio = null;
  const findPixelRatio = () => {
    const asked = Number(params.get('pr'));
    let pr = asked > 0 ? asked : 2;
    if (!(asked > 0)) {
      try {
        const gl = document.createElement('canvas').getContext('webgl');
        const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
        const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
        if (!gl || /swiftshader|llvmpipe|software/i.test(name)) pr = 1;
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
      } catch { pr = 1; }
    }
    return Math.max(1, Math.min(pr, 4096 / Math.max(state.width, state.height)));
  };
  const setups = [];
  const pendingScreens = [];
  // ---- screens in clips: FORMA.screen(video, ui, {offset}) ----
  // Normal: the clip baked with this interface for this language plays instead (assets/screens/<rev>.json lists them).
  // No bake: the interface is pinned live to the track (<clip>.track.json), without occlusion, and the console says so.
  // ?bake=<clip>: Forma's bake renders only that interface, flat, frame by frame (FORMA._bakeFrame). ?bake=list lists them.
  // ?debug=track: the track's corners are drawn over the clip.
  const bakeParam = params.get('bake'), debugTrack = params.get('debug') === 'track';
  const clipKey = src => String(src || '').split(/[?#]/)[0].replace(/^\.\//, '').replace(/^.*\/p\/[^/]+\//, '');
  const revName = (String(location.pathname || '').split('/').pop() || '').replace(/\.html$/, '');
  let manifest = null;
  const loadManifest = () => manifest || (manifest = fetch('assets/screens/' + encodeURIComponent(revName) + '.json', {cache: 'no-store'})
    .then(r => (r.ok ? r.json() : {})).catch(() => ({})));
  const screens = [];
  const screenOf = new Map();   // video → screen
  // Maps a point in a picture's own pixels to CSS px in its offsetParent, honouring object-fit and object-position.
  const mapper = (el, nw, nh) => {
    const bw = el.clientWidth, bh = el.clientHeight, cs = getComputedStyle(el), fit = cs.objectFit;
    let sx = bw / nw, sy = bh / nh;
    if (fit === 'cover') sx = sy = Math.max(bw / nw, bh / nh);
    else if (fit === 'contain' || fit === 'scale-down') sx = sy = Math.min(bw / nw, bh / nh);
    else if (fit === 'none') sx = sy = 1;
    const pos = cs.objectPosition.split(' ');
    const frac = (v, free) => v.endsWith('%') ? parseFloat(v) / 100 * free : v.endsWith('px') ? parseFloat(v) : free / 2;
    const ox = frac(pos[0] || '50%', bw - nw * sx), oy = frac(pos[1] || pos[0] || '50%', bh - nh * sy);
    return ([x, y]) => [el.offsetLeft + ox + x * sx, el.offsetTop + oy + y * sy];
  };
  const quadAt = (track, t) => {
    const f = track.frames, x = Math.max(0, Math.min(f.length - 1, t * track.source.fps)), i = Math.floor(x), j = Math.min(f.length - 1, i + 1), k = x - i;
    const a = f[i], b = f[j];
    if (!a.q && !b.q) return null;
    if (!a.q || !b.q) { const c = a.q ? a : b; return {q: c.q, v: c.v}; }
    return {q: a.q.map((p, n) => [p[0] + (b.q[n][0] - p[0]) * k, p[1] + (b.q[n][1] - p[1]) * k]), v: a.v + (b.v - a.v) * k};
  };
  const drawScreen = (sc, clipTime) => {
    if (!sc.track) return;
    const at = quadAt(sc.track, clipTime);
    const map = mapper(sc.video, sc.track.source.width, sc.track.source.height);
    if (sc.mode === 'live') {
      if (!at || at.v <= 0.01) { sc.ui.style.opacity = '0'; }
      else {
        const [tl, tr, br, bl] = at.q.map(map);
        window.FORMA.pin(sc.ui, {tl, tr, br, bl});
        sc.ui.style.opacity = String(at.v);
      }
    }
    if (sc.overlay) {
      const poly = sc.overlay.firstChild;
      poly.setAttribute('points', at ? at.q.map(map).map(p => p.join(',')).join(' ') : '');
      poly.setAttribute('stroke', at && at.v > 0.5 ? '#ff00d4' : '#ffb000');
    }
  };
  window.FORMA = {
    ...state,
    get pixelRatio() { if (pixelRatio === null) pixelRatio = findPixelRatio(); return pixelRatio; },
    get screens() { return screens.map(sc => ({clip: sc.clip, size: sc.size, offset: sc.offset, mode: sc.mode})); },
    // Puts an interface on the green screen inside a clip. Call it in FORMA.setup with the <video> and the element
    // that holds the interface (data-forma-screen, data-size="1440x900": the screen's own pixels). offset: when the
    // clip starts on the timeline, as in FORMA.syncVideo. Keep calling FORMA.syncVideo(video, t, offset) every frame.
    screen(video, ui, {offset = 0} = {}) {
      if (!video || !ui) { console.error('FORMA.screen: needs the <video> and the interface element'); return Promise.resolve(null); }
      const clip = clipKey(video.getAttribute('src') || video.currentSrc);
      const [w, h] = String(ui.dataset.size || '1280x800').split('x').map(Number);
      const sc = {video, ui, clip, offset: Number(offset) || 0, size: [w > 0 ? w : 1280, h > 0 ? h : 800], mode: 'pending', track: null, overlay: null};
      screens.push(sc);
      screenOf.set(video, sc);
      ui.dataset.formaScreen = ui.dataset.formaScreen || clip;
      if (bakeParam) {
        sc.mode = 'bake';
        if (bakeParam === clip) {
          ui.setAttribute('data-forma-baking', '');
          document.documentElement.classList.add('forma-bake');
          const css = document.createElement('style');
          css.textContent = 'html.forma-bake,html.forma-bake body{background:transparent!important}html.forma-bake body *{visibility:hidden!important;animation-play-state:paused!important}'
            + 'html.forma-bake [data-forma-baking],html.forma-bake [data-forma-baking] *{visibility:visible!important}'
            // a parent that fades, moves or clips the interface on the timeline must not do it to the flat bake
            + 'html.forma-bake body *:has([data-forma-baking]){opacity:1!important;transform:none!important;filter:none!important;clip-path:none!important;mask:none!important;contain:none!important;will-change:auto!important;perspective:none!important;backdrop-filter:none!important}'
            + 'html.forma-bake [data-forma-baking]{position:fixed!important;left:0!important;top:0!important;width:' + sc.size[0] + 'px!important;height:' + sc.size[1] + 'px!important;transform:none!important;opacity:1!important;display:block!important;margin:0!important;z-index:2147483647!important}';
          document.head.append(css);
        }
        return Promise.resolve(sc);
      }
      const ready = (async () => {
        const list = await loadManifest();
        const baked = list?.clips?.[clip]?.[state.lang];
        if (baked) {
          sc.mode = 'baked';
          ui.style.display = 'none';
          video.crossOrigin = 'anonymous';
          video.src = baked;
          video.load();
          await new Promise(r => { if (video.readyState >= 1) r(); else { video.addEventListener('loadedmetadata', r, {once: true}); video.addEventListener('error', r, {once: true}); setTimeout(r, 20000); } });
        }
        if (sc.mode !== 'baked' || debugTrack) {
          try {
            const r = await fetch(clip.replace(/\.[a-z0-9]+$/i, '') + '.track.json', {cache: 'no-store'});
            if (r.ok) sc.track = await r.json();
          } catch {}
        }
        if (sc.mode !== 'baked') {
          if (sc.track?.found) {
            sc.mode = 'live';
            const box = video.offsetParent || document.body;
            if (ui.parentElement !== box) box.append(ui);
            ui.style.width = sc.size[0] + 'px'; ui.style.height = sc.size[1] + 'px';
            ui.style.zIndex = ui.style.zIndex || '1';
            console.warn('FORMA.screen: no baked clip for ' + clip + ' (' + state.lang + '): the interface is pinned live, without occlusion.');
          } else {
            sc.mode = 'missing';
            ui.style.display = 'none';
            console.error('FORMA.screen: ' + clip + ' has no screen track (' + clip.replace(/\.[a-z0-9]+$/i, '') + '.track.json). Track it with the track_screen tool.');
          }
        }
        if (debugTrack && sc.track) {
          const box = video.offsetParent || document.body;
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('style', 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2147483646;overflow:visible');
          const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
          poly.setAttribute('fill', 'none'); poly.setAttribute('stroke-width', '3');
          svg.append(poly);
          box.append(svg);
          sc.overlay = svg;
        }
        return sc;
      })();
      pendingScreens.push(ready);
      return ready;
    },
    // The bake: one flat frame of the interface at clip time tau (renderFrame at offset + tau).
    _bakeFrame(tau) {
      const sc = screens.find(x => x.clip === bakeParam);
      window.FORMA.playing = false;
      try { window.renderFrame?.((sc?.offset || 0) + tau); } catch (e) { console.error(e); }
      return Boolean(sc);
    },
    _screensReady: () => Promise.all(pendingScreens),
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
        // Paused (seeking, frame-by-frame review and export): every frame asks for its own moment of the clip.
        // A coarser threshold skips every other video frame at 30 fps and makes exported clips stutter.
        if (!video.paused) video.pause();
        if (Math.abs(video.currentTime - target) > .001) video.currentTime = target;
      }
      const sc = screenOf.get(video);
      if (sc && (sc.mode === 'live' || sc.overlay)) drawScreen(sc, target);
    },
    // Pins an element to four points, e.g. the corners of a screen in a picture, with a perspective transform.
    // The element is absolutely positioned at left:0; top:0 of the same container the points are measured in (CSS px).
    // quad: {tl:[x,y], tr:[x,y], br:[x,y], bl:[x,y]}. Call it again whenever the points move (it is cheap).
    pin(el, quad) {
      if (!el || !quad) return;
      const w = el.offsetWidth || 1, h = el.offsetHeight || 1;
      const adj = m => [m[4]*m[8]-m[5]*m[7], m[2]*m[7]-m[1]*m[8], m[1]*m[5]-m[2]*m[4], m[5]*m[6]-m[3]*m[8], m[0]*m[8]-m[2]*m[6], m[2]*m[3]-m[0]*m[5], m[3]*m[7]-m[4]*m[6], m[1]*m[6]-m[0]*m[7], m[0]*m[4]-m[1]*m[3]];
      const mul = (a, b) => { const c = [0,0,0,0,0,0,0,0,0]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) c[3*i+j] += a[3*i+k] * b[3*k+j]; return c; };
      const mulv = (m, v) => [m[0]*v[0]+m[1]*v[1]+m[2]*v[2], m[3]*v[0]+m[4]*v[1]+m[5]*v[2], m[6]*v[0]+m[7]*v[1]+m[8]*v[2]];
      const basis = p => { const m = [p[0][0], p[1][0], p[2][0], p[0][1], p[1][1], p[2][1], 1, 1, 1]; const v = mulv(adj(m), [p[3][0], p[3][1], 1]); return mul(m, [v[0],0,0, 0,v[1],0, 0,0,v[2]]); };
      const t = mul(basis([quad.tl, quad.tr, quad.bl, quad.br]), adj(basis([[0,0], [w,0], [0,h], [w,h]])));
      const n = t.map(x => x / t[8]);
      el.style.position = 'absolute'; el.style.left = '0px'; el.style.top = '0px';
      el.style.transformOrigin = '0 0';
      el.style.transform = 'matrix3d(' + [n[0], n[3], 0, n[6], n[1], n[4], 0, n[7], 0, 0, 1, 0, n[2], n[5], 0, n[8]].join(',') + ')';
    },
    // Finds the four corners of a flat key-coloured surface (pure green by default) in a loaded <img> — a screen,
    // a sign or a sheet the image model was asked to leave in #00FF00 — and returns them as a quad in the CSS px
    // of the img's offsetParent, ready for FORMA.pin. Honours object-fit (cover, contain, fill) and object-position.
    // Returns null when no such surface is found. Call it inside FORMA.setup, after the layout of the format is set.
    findSurface(img, {grow = 1.5} = {}) {
      if (!img || !img.naturalWidth) return null;
      const nw = img.naturalWidth, nh = img.naturalHeight;
      const k = Math.min(1, 900 / Math.max(nw, nh));
      const cw = Math.max(1, Math.round(nw * k)), ch = Math.max(1, Math.round(nh * k));
      let d;
      try {
        const c = document.createElement('canvas'); c.width = cw; c.height = ch;
        const x = c.getContext('2d', {willReadFrequently: true}); x.drawImage(img, 0, 0, cw, ch);
        d = x.getImageData(0, 0, cw, ch).data;
      } catch (e) { console.error('FORMA.findSurface: cannot read the image', e); return null; }
      let tl = null, tr = null, br = null, bl = null, count = 0;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const i = (y * cw + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
        if (g < 120 || g - Math.max(r, b) < 70) continue;
        count++;
        if (!tl || x + y < tl[0] + tl[1]) tl = [x, y];
        if (!br || x + y > br[0] + br[1]) br = [x, y];
        if (!tr || x - y > tr[0] - tr[1]) tr = [x, y];
        if (!bl || x - y < bl[0] - bl[1]) bl = [x, y];
      }
      if (count < cw * ch * 0.002) return null;
      const bw = img.clientWidth, bh = img.clientHeight;
      const fit = getComputedStyle(img).objectFit;
      let sx = bw / nw, sy = bh / nh;
      if (fit === 'cover') sx = sy = Math.max(bw / nw, bh / nh);
      else if (fit === 'contain' || fit === 'scale-down') sx = sy = Math.min(bw / nw, bh / nh);
      const pos = getComputedStyle(img).objectPosition.split(' ');
      const frac = (v, free) => v.endsWith('%') ? parseFloat(v) / 100 * free : v.endsWith('px') ? parseFloat(v) : free / 2;
      const ox = frac(pos[0] || '50%', bw - nw * sx), oy = frac(pos[1] || pos[0] || '50%', bh - nh * sy);
      const map = p => [img.offsetLeft + ox + (p[0] + 0.5) / k * sx, img.offsetTop + oy + (p[1] + 0.5) / k * sy];
      const q = {tl: map(tl), tr: map(tr), br: map(br), bl: map(bl)};
      const cx = (q.tl[0] + q.tr[0] + q.br[0] + q.bl[0]) / 4, cy = (q.tl[1] + q.tr[1] + q.br[1] + q.bl[1]) / 4;
      for (const key of ['tl', 'tr', 'br', 'bl']) {
        const [px, py] = q[key], len = Math.hypot(px - cx, py - cy) || 1;
        q[key] = [px + (px - cx) / len * grow, py + (py - cy) / len * grow];
      }
      return q;
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
      .then(async () => { for (const fn of F._setups) await fn(); await F._screensReady?.(); })
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
    .then(async () => { for (const fn of F._setups) await fn(); await F._screensReady?.(); })
    .catch(e => console.error(e))
    .then(() => { started = true; F.playing = playing; draw(); if (playing) play(); });
}

const json = value => JSON.stringify(value).replaceAll('<', '\\u003c');

// <img>, <video> and <audio> without a crossorigin attribute get crossorigin="anonymous".
export const withCors = html => String(html).replace(/<(img|video|audio)\b(?![^>]*\bcrossorigin\b)/gi, '<$1 crossorigin="anonymous"');

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
  // Pictures and clips in the markup ask for CORS too (the runtime covers the ones made in code).
  html = withCors(html);
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
