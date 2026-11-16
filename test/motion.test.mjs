import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {formats, pickFormats, resolveRuntime, inject, uninject} from '../motion.mjs';

const sampleScenario = () => ({
  version: 2,
  kind: 'multi',
  theme: 'Splitting bills without the argument',
  idea: 'Two flatmates both swear they paid; the app ends it in one tap.',
  languages: ['en', 'ar', 'sr-Latn'],
  lines: {
    h1:  {role:'hook',  scene:'s1', maxChars:24, hideIn:[],        text:{en:'“I paid last.”',        ar:'«أنا دفعت آخر مرة»', 'sr-Latn':'„Ja sam platio.”'}},
    p1:  {role:'proof', scene:'s2', maxChars:28, hideIn:['191x1'], text:{en:'One list. Split fast.', ar:'قائمة واحدة للجميع', 'sr-Latn':'Jedna lista.'}},
    o1:  {role:'offer', scene:'s3', maxChars:32, hideIn:[],        text:{en:'Free 3 months',         ar:'مجاناً ٣ أشهر',      'sr-Latn':'Besplatno 3 meseca'}},
    cta: {role:'cta',   scene:'s3', maxChars:24, hideIn:[],        text:{en:'Start shared budget',   ar:'ابدأ الميزانية',     'sr-Latn':'Pokreni budžet'}},
  },
  scenes: [
    {id:'s1', beat:'HOOK',        story:'Two voices claim the same bill.',         lines:['h1']},
    {id:'s2', beat:'PROOF',       story:'The shared list settles who paid what.',  lines:['p1']},
    {id:'s3', beat:'OFFER + CTA', story:'The offer lands with the brand and CTA.', lines:['o1', 'cta']},
  ],
  cuts: {
    '4': {
      scenes: [
        {id:'s1', start:0, end:1.8, lines:['h1']},
        {id:'s3', start:1.8, end:4, lines:['o1', 'cta']},
      ],
      note: 'Short cut.',
    },
    '10': {
      scenes: [
        {id:'s1', start:0, end:3.2, lines:['h1']},
        {id:'s2', start:3.2, end:6.0, lines:['p1']},
        {id:'s3', start:6.0, end:10, lines:['o1', 'cta']},
      ],
      note: 'Full cut.',
    },
  },
});

describe('motion.mjs: resolveRuntime', () => {
  it('resolves format, language, length and default fallbacks', () => {
    const sc = sampleScenario();
    const data = {
      stage: 'final',
      kind: 'multi',
      formats: pickFormats(['9x16', '1x1', '191x1']),
      langs: ['en', 'ar', 'sr-Latn'],
      lengths: [4, 10],
      scenario: sc,
    };

    // Default fallbacks when query params are missing or invalid
    const def = resolveRuntime('?f=unknown&l=xx&d=999', data);
    assert.equal(def.format, '9x16');
    assert.equal(def.orientation, 'portrait');
    assert.equal(def.lang, 'en');
    assert.equal(def.dir, 'ltr');
    assert.equal(def.length, 4);
    assert.equal(def.duration, 4);
    assert.equal(def.cut.length, 4);
    assert.equal(def.cut.scenes.length, 2);
    assert.equal(def.loop, null);

    // Explicit format, language and length
    const explicit = resolveRuntime('?f=1x1&l=sr-Latn&d=10', data);
    assert.equal(explicit.format, '1x1');
    assert.equal(explicit.orientation, 'square');
    assert.equal(explicit.lang, 'sr-Latn');
    assert.equal(explicit.dir, 'ltr');
    assert.equal(explicit.length, 10);
    assert.equal(explicit.cut.length, 10);
    assert.equal(explicit.cut.scenes.length, 3);
    assert.equal(explicit.copy.h1, '„Ja sam platio.”');
    assert.equal(explicit.copy.p1, 'Jedna lista.');
  });

  it('filters lines in hideIn for copy, scenes and cut windows', () => {
    const sc = sampleScenario();
    const data = {
      stage: 'final',
      kind: 'multi',
      formats: pickFormats(['9x16', '191x1']),
      langs: ['en'],
      lengths: [10],
      scenario: sc,
    };

    const wide = resolveRuntime('?f=191x1&d=10', data);
    assert.equal(wide.orientation, 'landscape');
    assert.equal('p1' in wide.copy, false);
    assert.equal('h1' in wide.copy, true);
    assert.deepEqual(wide.scenes.find(s => s.id === 's2').lines, []);
    assert.deepEqual(wide.cut.scenes.find(s => s.id === 's2').lines, []);
    // metadata in FORMA.lines still exists
    assert.deepEqual(wide.lines.p1, {role:'proof', scene:'s2'});
  });

  it('sets RTL dir for Arabic and Hebrew', () => {
    const sc = sampleScenario();
    const data = {
      stage: 'final',
      kind: 'multi',
      formats: pickFormats(['1x1']),
      langs: ['en', 'ar', 'he'],
      lengths: [4],
      scenario: sc,
    };

    assert.equal(resolveRuntime('?l=ar', data).dir, 'rtl');
    assert.equal(resolveRuntime('?l=he', data).dir, 'rtl');
    assert.equal(resolveRuntime('?l=en', data).dir, 'ltr');
  });

  it('computes seamless loop periods for 4s, 6s and 10s in single-scene final', () => {
    const data = {
      stage: 'final',
      kind: 'single',
      formats: pickFormats(['1x1']),
      langs: ['en'],
      lengths: [4, 6, 10],
      scenario: {
        version: 2,
        kind: 'single',
        theme: 'T',
        idea: 'I',
        languages: ['en'],
        lines: {h1:{role:'hook', scene:'loop', maxChars:20, hideIn:[], text:{en:'Hook'}}},
        scenes: [{id:'loop', beat:'LOOP', story:'S', lines:['h1']}],
      },
    };

    const r4 = resolveRuntime('?d=4', data);
    assert.deepEqual(r4.loop, {period: 4, repeats: 1});
    assert.equal(r4.length, 4);
    assert.equal(r4.cut, null);

    const r6 = resolveRuntime('?d=6', data);
    assert.deepEqual(r6.loop, {period: 3, repeats: 2});
    assert.equal(r6.length, 6);

    const r10 = resolveRuntime('?d=10', data);
    assert.equal(r10.loop.repeats, 3);
    assert.ok(Math.abs(r10.loop.period - 10 / 3) < 1e-9);
    assert.equal(r10.length, 10);
  });

  it('handles preview and poster stages with length 0 and scene selection', () => {
    const sc = sampleScenario();
    const previewData = {
      stage: 'preview',
      kind: 'multi',
      formats: pickFormats(['9x16']),
      langs: ['en'],
      lengths: [4, 10],
      scenario: sc,
    };

    const pDef = resolveRuntime('', previewData);
    assert.equal(pDef.stage, 'preview');
    assert.equal(pDef.length, 0);
    assert.equal(pDef.duration, 0);
    assert.equal(pDef.cut, null);
    assert.equal(pDef.loop, null);
    assert.equal(pDef.scene, 's1');

    const pS2 = resolveRuntime('?scene=s2', previewData);
    assert.equal(pS2.scene, 's2');

    const posterData = {
      stage: 'final',
      kind: 'poster',
      formats: pickFormats(['1x1', '4x5']),
      langs: ['en'],
      lengths: [],
      scenario: {
        version: 2,
        kind: 'poster',
        theme: 'T',
        idea: 'I',
        languages: ['en'],
        lines: {h1:{role:'hook', scene:'poster', maxChars:20, hideIn:[], text:{en:'Poster'}}},
        scenes: [{id:'poster', beat:'POSTER', story:'S', lines:['h1']}],
      },
    };
    const poster = resolveRuntime('?f=4x5', posterData);
    assert.equal(poster.kind, 'poster');
    assert.equal(poster.length, 0);
    assert.equal(poster.duration, 0);
    assert.equal(poster.cut, null);
    assert.equal(poster.loop, null);
  });
});

// Original legacy inject reference implementation (top-level so .toString() indentation matches original motion.mjs)
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
function legacyReferenceInject(html, {formats: list, duration, libs = ''}) {
  const json = value => JSON.stringify(value).replaceAll('<', '\\u003c');
  const head = '<script>(' + runtime.toString() + ')(' + json(list) + ',' + duration + ')</script>' + libs;
  html = /<head\b[^>]*>/i.test(html)
    ? html.replace(/<head\b[^>]*>/i, m => m + head)
    : html.replace(/<html\b[^>]*>/i, m => m + '<head>' + head + '</head>');
  const tail = '<script>(' + controller.toString() + ')()</script>';
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i, m => tail + m) : html.replace(/<\/html\s*>/i, m => tail + m);
}

describe('motion.mjs: inject & legacy parity', () => {

  it('produces byte-identical output for stage="legacy" and default stage', () => {
    const src = '<!doctype html><html><head><title>Ad</title></head><body><h1>Hi</h1></body></html>';
    const fmtList = pickFormats(['1x1', '9x16']);
    const libs = '<script src="/lib/gsap.js"></script>';

    const expected = legacyReferenceInject(src, {formats: fmtList, duration: 8, libs});
    const actualDefault = inject(src, {formats: fmtList, duration: 8, libs});
    const actualExplicit = inject(src, {stage: 'legacy', formats: fmtList, duration: 8, libs});

    assert.equal(actualDefault, expected);
    assert.equal(actualExplicit, expected);
    assert.equal(uninject(actualDefault), src);
  });

  it('injects v2 runtime with working FORMA.fitGroup and DOM attributes, and uninjects cleanly', () => {
    const src = '<!doctype html><html><head><title>V2</title></head><body><div>Body</div></body></html>';
    const sc = sampleScenario();
    const injected = inject(src, {
      stage: 'final',
      kind: 'multi',
      formats: pickFormats(['9x16', '1x1']),
      langs: ['en', 'ar'],
      lengths: [4, 10],
      scenario: sc,
    });

    assert.equal(uninject(injected), src);

    // Extract head runtime script and execute in a sandboxed VM context
    const match = injected.match(/<head><script>([\s\S]*?)<\/script>/);
    assert.ok(match);

    const vars = {};
    const root = {lang:'', dir:'', dataset:{}, style:{setProperty:(k, v) => { vars[k] = v; }}};
    const sandbox = {
      location: {search: '?f=1x1&l=ar&d=10'},
      URLSearchParams,
      document: {documentElement: root},
      window: {},
    };
    vm.runInNewContext(match[1], sandbox);

    const F = sandbox.window.FORMA;
    assert.equal(root.lang, 'ar');
    assert.equal(root.dir, 'rtl');
    assert.equal(root.dataset.format, '1x1');
    assert.equal(root.dataset.orientation, 'square');
    assert.equal(root.dataset.kind, 'multi');
    assert.equal(root.dataset.stage, 'final');
    assert.equal(root.dataset.lang, 'ar');
    assert.equal(vars['--w'], '1080px');
    assert.equal(F.lang, 'ar');
    assert.equal(F.dir, 'rtl');
    assert.equal(F.length, 10);
    assert.equal(typeof F.fitGroup, 'function');

    // Test fitGroup sizing elements to the largest shared size where all fit
    const makeEl = (maxFittingSize) => {
      const el = {
        clientWidth: 200,
        clientHeight: 60,
        style: {fontSize: ''},
        get scrollWidth() { return parseFloat(this.style.fontSize) > maxFittingSize ? 250 : 180; },
        get scrollHeight() { return parseFloat(this.style.fontSize) > maxFittingSize ? 80 : 50; },
      };
      return el;
    };
    const el1 = makeEl(48);
    const el2 = makeEl(32);
    const chosen = F.fitGroup([el1, el2], {max: 64, min: 16, step: 0.5});
    assert.ok(chosen <= 32 && chosen >= 31.5);
    assert.equal(el1.style.fontSize, el2.style.fontSize);
  });
});
