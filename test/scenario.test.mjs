import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {LANGUAGES, language, isRTL} from '../shared/languages.mjs';
import {readingSeconds, windowNeed, verdict} from '../shared/reading.mjs';
import {parseScenario, validateScenario, missingLanguages, missingCuts} from '../scenario.mjs';

const validMulti = () => ({
  version: 2,
  kind: 'multi',
  theme: 'Splitting bills without the argument',
  idea: 'Two flatmates both swear they paid; the app ends it in one tap.',
  languages: ['en', 'sr-Latn'],
  lines: {
    h1:  {role:'hook',  scene:'s1', maxChars:24, hideIn:[],        text:{en:'“I paid last.”',                 'sr-Latn':'„Ja sam platio.”'}},
    h1b: {role:'hook',  scene:'s1', maxChars:16, hideIn:[],        text:{en:'“No, I did.”',                   'sr-Latn':'„Ne, ja sam.”'}},
    p1:  {role:'proof', scene:'s2', maxChars:28, hideIn:['191x1'], text:{en:'One list. Split fast.',          'sr-Latn':'Jedna lista. Delite.'}},
    o1:  {role:'offer', scene:'s3', maxChars:32, hideIn:[],        text:{en:'Free 3 months',                  'sr-Latn':'Besplatno 3 meseca'}},
    cta: {role:'cta',   scene:'s3', maxChars:24, hideIn:[],        text:{en:'Start budget',                   'sr-Latn':'Pokreni budžet'}},
  },
  scenes: [
    {id:'s1', beat:'HOOK',        story:'Two voices claim the same bill.',         lines:['h1', 'h1b']},
    {id:'s2', beat:'PROOF',       story:'The shared list settles who paid what.',  lines:['p1']},
    {id:'s3', beat:'OFFER + CTA', story:'The offer lands with the brand and CTA.', lines:['o1', 'cta']},
  ],
  cuts: {
    '4': {
      scenes: [
        {id:'s1', start:0,   end:2.0, lines:['h1']},
        {id:'s3', start:2.0, end:4,   lines:['cta']},
      ],
      note: 'PROOF and secondary lines dropped for 4 s.',
    },
    '10': {
      scenes: [
        {id:'s1', start:0,   end:2.4, lines:['h1']},
        {id:'s2', start:2.4, end:5.0, lines:['p1']},
        {id:'s3', start:5.0, end:10,  lines:['o1', 'cta']},
      ],
      note: 'Full story; the reply line is dropped to keep time to read.',
    },
  },
  notes: 'Keep it punchy.',
});

const defaultSetup = () => ({
  kind: 'multi',
  languages: ['en', 'sr-Latn'],
  lengths: [4, 10],
  formats: ['9x16', '1x1'],
});

describe('shared/languages.mjs', () => {
  it('lists languages and detects RTL and CJK', () => {
    assert.ok(LANGUAGES.length >= 19);
    assert.equal(language('ru').name, 'Russian');
    assert.equal(language('unknown-code').code, 'unknown-code');
    assert.equal(isRTL('ar'), true);
    assert.equal(isRTL('he'), true);
    assert.equal(isRTL('en'), false);
    assert.equal(language('zh').cjk, true);
    assert.equal(language('ja').cjk, true);
    assert.equal(language('ko').cjk, true);
  });
});

describe('shared/reading.mjs', () => {
  it('computes readingSeconds for Latin, Cyrillic and CJK', () => {
    assert.equal(readingSeconds('', 'en'), 0);
    assert.equal(readingSeconds('   ', 'ru'), 0);
    // 4 words in Latin: 0.4 + 4 / 2.6
    assert.ok(Math.abs(readingSeconds('I paid last time', 'en') - (0.4 + 4 / 2.6)) < 1e-9);
    // 3 words in Cyrillic: 0.4 + 3 / 2.6
    assert.ok(Math.abs(readingSeconds('Оплати в касание', 'ru') - (0.4 + 3 / 2.6)) < 1e-9);
    // 6 CJK chars (ignoring whitespace): 0.4 + 6 / 6 = 1.4
    assert.ok(Math.abs(readingSeconds('免费 试用 三个月', 'zh') - (0.4 + 7 / 6)) < 1e-9);
    assert.ok(Math.abs(readingSeconds('今すぐ始めよう', 'ja') - (0.4 + 7 / 6)) < 1e-9);
  });

  it('computes windowNeed with extra line travel and closing hold', () => {
    const one = readingSeconds('Hello world', 'en');
    const two = readingSeconds('Try now', 'en');
    assert.ok(Math.abs(windowNeed(['Hello world', 'Try now'], 'en') - (one + two + 0.25)) < 1e-9);
    assert.ok(Math.abs(windowNeed(['Hello world', 'Try now'], 'en', {closing: true}) - (one + two + 0.25 + 1.0)) < 1e-9);
  });

  it('returns ok, tight and fail verdicts', () => {
    assert.equal(verdict(2.0, 2.0), 'ok');
    assert.equal(verdict(2.5, 2.0), 'ok');
    assert.equal(verdict(1.75, 2.0), 'tight'); // >= 1.7 (0.85 * 2.0)
    assert.equal(verdict(1.65, 2.0), 'fail');  // < 1.7
  });
});

describe('scenario.mjs: parseScenario', () => {
  it('parses fenced and raw JSON v2', () => {
    const raw = JSON.stringify(validMulti(), null, 2);
    const fenced = '```json\n' + raw + '\n```';
    const parsed = parseScenario(fenced);
    assert.equal(parsed.kind, 'multi');
    assert.equal(parsed.version, 2);
  });

  it('throws an English error on invalid JSON or schema mismatch', () => {
    assert.throws(() => parseScenario('not json'), /Could not parse the script JSON/);
    assert.throws(() => parseScenario('{}'), /Invalid script format/);
  });
});

describe('scenario.mjs: validateScenario', () => {
  it('passes a valid multi fixture', () => {
    const res = validateScenario(validMulti(), defaultSetup());
    assert.deepEqual(res.errors, []);
    assert.equal(res.cells['10'].s1.verdict, 'ok');
    assert.equal(res.cells['10'].s3.verdict, 'ok');
  });

  it('passes valid poster and single fixtures', () => {
    const poster = {
      version: 2,
      kind: 'poster',
      theme: 'Split bills cleanly',
      idea: 'One shared receipt.',
      languages: ['en'],
      lines: {
        h1:  {role:'hook', scene:'poster', maxChars:24, hideIn:[], text:{en:'Split bills in one tap'}},
        cta: {role:'cta',  scene:'poster', maxChars:20, hideIn:[], text:{en:'Get the app'}},
      },
      scenes: [{id:'poster', beat:'POSTER', story:'Static poster.', lines:['h1', 'cta']}],
    };
    assert.deepEqual(validateScenario(poster, {kind:'poster', languages:['en'], lengths:[]}).errors, []);

    const single = {
      version: 2,
      kind: 'single',
      theme: 'Split bills cleanly',
      idea: 'Looping receipt balance.',
      languages: ['en'],
      lines: {
        h1:  {role:'hook', scene:'loop', maxChars:24, hideIn:[], text:{en:'Split bills fast'}},
        cta: {role:'cta',  scene:'loop', maxChars:20, hideIn:[], text:{en:'Try free'}},
      },
      scenes: [{id:'loop', beat:'LOOP', story:'Seamless loop.', lines:['h1', 'cta']}],
    };
    assert.deepEqual(validateScenario(single, {kind:'single', languages:['en'], lengths:[6, 10]}).errors, []);
  });

  it('fires on kind mismatch', () => {
    const res = validateScenario(validMulti(), {...defaultSetup(), kind: 'poster'});
    assert.ok(res.errors.some(e => /Kind mismatch/i.test(e)));
  });

  it('fires on missing or empty language text', () => {
    const sc = validMulti();
    sc.lines.h1.text['sr-Latn'] = '   ';
    const res = validateScenario(sc, defaultSetup());
    assert.ok(res.errors.some(e => /missing text for language "sr-Latn"/i.test(e)));
  });

  it('fires on scene referencing unknown line or line referencing unknown scene', () => {
    const sc1 = validMulti();
    sc1.scenes[0].lines.push('nonexistent');
    assert.ok(validateScenario(sc1, defaultSetup()).errors.some(e => /unknown line "nonexistent"/i.test(e)));

    const sc2 = validMulti();
    sc2.lines.orphan = {role:'sub', scene:'no_such_scene', maxChars:20, hideIn:[], text:{en:'Hi', 'sr-Latn':'Ćao'}};
    assert.ok(validateScenario(sc2, defaultSetup()).errors.some(e => /unknown scene "no_such_scene"/i.test(e)));
  });

  it('fires when hook, offer or cta is in hideIn', () => {
    for (const key of ['h1', 'o1', 'cta']) {
      const sc = validMulti();
      sc.lines[key].hideIn = ['191x1'];
      const res = validateScenario(sc, defaultSetup());
      assert.ok(res.errors.some(e => e.includes(`Line "${key}"`) && /hideIn/i.test(e)), `Expected error for ${key}`);
    }
  });

  it('fires on poster/single scene rule violations', () => {
    const badPoster = {
      version: 2,
      kind: 'poster',
      theme: 'Theme',
      idea: 'Idea',
      languages: ['en'],
      lines: {h1: {role:'hook', scene:'s1', maxChars:20, hideIn:[], text:{en:'Hook'}}},
      scenes: [{id:'s1', beat:'HOOK', story:'Wrong id', lines:['h1']}],
    };
    assert.ok(validateScenario(badPoster, {kind:'poster', languages:['en']}).errors.some(e => /Poster scenario must have/i.test(e)));
  });

  it('fires on multi cut errors: missing cut, wrong order, start!=0, gap/overlap, end!=length, missing cta, wrong scene line, reading fail', () => {
    // Missing cut
    const resMissing = validateScenario(validMulti(), {...defaultSetup(), lengths: [4, 6, 10]});
    assert.ok(resMissing.errors.some(e => /Missing cut for length 6/i.test(e)));

    // Wrong scene order
    const scOrder = validMulti();
    scOrder.cuts['4'].scenes = [
      {id:'s3', start:0, end:2, lines:['cta']},
      {id:'s1', start:2, end:4, lines:['h1', 'cta']},
    ];
    assert.ok(validateScenario(scOrder, defaultSetup()).errors.some(e => /not in scenario order/i.test(e)));

    // First window not starting at 0
    const scStart = validMulti();
    scStart.cuts['4'].scenes[0].start = 0.3;
    assert.ok(validateScenario(scStart, defaultSetup()).errors.some(e => /must start at 0/i.test(e)));

    // Gap between windows > 0.05s
    const scGap = validMulti();
    scGap.cuts['4'].scenes[0].end = 1.5;
    scGap.cuts['4'].scenes[1].start = 1.7;
    assert.ok(validateScenario(scGap, defaultSetup()).errors.some(e => /gap or overlap/i.test(e)));

    // Last window not ending at length
    const scEnd = validMulti();
    scEnd.cuts['4'].scenes[1].end = 3.8;
    assert.ok(validateScenario(scEnd, defaultSetup()).errors.some(e => /must end exactly at 4/i.test(e)));

    // Last scene lacking CTA
    const scNoCta = validMulti();
    scNoCta.cuts['4'].scenes[1].lines = ['o1'];
    assert.ok(validateScenario(scNoCta, defaultSetup()).errors.some(e => /lacks the cta line/i.test(e)));

    // Window line not belonging to that scene
    const scForeignLine = validMulti();
    scForeignLine.cuts['4'].scenes[0].lines = ['h1', 'p1'];
    assert.ok(validateScenario(scForeignLine, defaultSetup()).errors.some(e => /does not belong to scene/i.test(e)));

    // Reading time failure & worst language verdict per cell
    const scSlow = validMulti();
    scSlow.lines.h1.text['sr-Latn'] = 'Ovo je veoma dugačka rečenica koja nikako ne može da se pročita za manje od dve sekunde u ovom kadru';
    const resSlow = validateScenario(scSlow, defaultSetup());
    // A 4 s two-scene cut is tight by design once the picture needs time; English still passes, Serbian fails.
    assert.notEqual(resSlow.cells['4'].s1.byLang.en.verdict, 'fail');
    assert.equal(resSlow.cells['4'].s1.byLang['sr-Latn'].verdict, 'fail');
    assert.equal(resSlow.cells['4'].s1.verdict, 'fail');
    assert.ok(resSlow.errors.some(e => /fails reading-time check/i.test(e)));
  });

  it('produces warnings for tight windows, maxChars overflow, single-scene length and long poster hooks', () => {
    const sc = validMulti();
    // Make s2 in 10s cut tight: 5 words -> need = 0.4 + 5/2.6 + 0.6 (picture) = 2.923s; have = 2.6s (0.889 >= 0.85 -> tight)
    sc.lines.p1.text.en = 'One shared list settles all';
    sc.cuts['10'].scenes[1].start = 2.4;
    sc.cuts['10'].scenes[1].end = 5.0;
    sc.cuts['10'].scenes[2].start = 5.0;
    // Also exceed maxChars on h1b without adding words
    sc.lines.h1b.maxChars = 8;
    const res = validateScenario(sc, defaultSetup());
    assert.equal(res.errors.length, 0);
    assert.equal(res.cells['10'].s2.verdict, 'tight');
    assert.ok(res.warnings.some(w => /is tight/i.test(w)));
    assert.ok(res.warnings.some(w => />100%/i.test(w)));

    // Poster hook > 7 words
    const poster = {
      version: 2,
      kind: 'poster',
      theme: 'T',
      idea: 'I',
      languages: ['en'],
      lines: {
        h1:  {role:'hook', scene:'poster', maxChars:80, hideIn:[], text:{en:'One two three four five six seven eight'}},
        cta: {role:'cta',  scene:'poster', maxChars:20, hideIn:[], text:{en:'Start now'}},
      },
      scenes: [{id:'poster', beat:'POSTER', story:'S', lines:['h1', 'cta']}],
    };
    const resPoster = validateScenario(poster, {kind:'poster', languages:['en']});
    assert.ok(resPoster.warnings.some(w => />7 words/i.test(w)));

    // Single-scene total windowNeed > min(lengths) - 0.5
    const single = {
      version: 2,
      kind: 'single',
      theme: 'T',
      idea: 'I',
      languages: ['en'],
      lines: {
        h1:  {role:'hook',  scene:'loop', maxChars:40, hideIn:[], text:{en:'Five words in the hook'}},
        o1:  {role:'offer', scene:'loop', maxChars:40, hideIn:[], text:{en:'Another five words right here'}},
        cta: {role:'cta',   scene:'loop', maxChars:20, hideIn:[], text:{en:'Try free now'}},
      },
      scenes: [{id:'loop', beat:'LOOP', story:'S', lines:['h1', 'o1', 'cta']}],
    };
    const resSingle = validateScenario(single, {kind:'single', languages:['en'], lengths:[4, 10]});
    assert.equal(resSingle.errors.length, 0);
    assert.ok(resSingle.warnings.some(w => /Single-scene reading time/i.test(w)));
  });

  it('detects missingLanguages and missingCuts', () => {
    const sc = validMulti();
    assert.deepEqual(missingLanguages(sc, ['en', 'sr-Latn', 'de']), ['de']);
    assert.deepEqual(missingCuts(sc, [4, 6, 10]), [6]);
  });
});
