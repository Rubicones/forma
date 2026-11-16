import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  P0, P1, SCENARIO_SCHEMA,
  scenarioPrompt, scenarioMessage, scenarioRepairMessage,
  translatePrompt, translateMessage,
  stylesPrompt, previewPrompt, finalPrompt, stageRevisionPrompt,
  parseStyleChoices,
  extractCopyPatch, validateCopyPatch, mergeCopyPatches, applyCopyPatch,
} from '../creative.mjs';

const sampleSetup = {
  kind: 'multi',
  languages: ['en', 'ar', 'sr-Latn'],
  lengths: [4, 10],
  formats: ['9x16', '1x1'],
};

const sampleScenario = {
  version: 2,
  kind: 'multi',
  theme: 'Splitting bills without the argument',
  idea: 'Two flatmates both swear they paid; the app ends it in one tap.',
  languages: ['en', 'sr-Latn'],
  lines: {
    h1:  {role:'hook',  scene:'s1', maxChars:24, hideIn:[], text:{en:'“I paid last.”', 'sr-Latn':'„Ja sam platio.”'}},
    o1:  {role:'offer', scene:'s3', maxChars:30, hideIn:[], text:{en:'Free for 3 months', 'sr-Latn':'Besplatno 3 meseca'}},
    cta: {role:'cta',   scene:'s3', maxChars:20, hideIn:[], text:{en:'Start shared budget', 'sr-Latn':'Pokreni budžet'}},
  },
  scenes: [
    {id:'s1', beat:'HOOK', story:'Two voices claim the same bill.', lines:['h1']},
    {id:'s3', beat:'OFFER + CTA', story:'The offer lands.', lines:['o1', 'cta']},
  ],
};

describe('creative.mjs: prompts P0–P9 and message builders', () => {
  it('builds scenarioPrompt (P0 + P1[kind] + P2) with verbatim SCENARIO_SCHEMA', () => {
    const prompt = scenarioPrompt({kind: 'multi'});
    assert.ok(prompt.startsWith(P0));
    assert.ok(prompt.includes(P1.multi));
    assert.ok(prompt.includes('TASK: WRITE THE SCENARIO as structured JSON.'));
    assert.ok(prompt.endsWith(SCENARIO_SCHEMA));
  });

  it('builds scenarioMessage for fresh, revision and missing cuts (P4)', () => {
    const msg = JSON.parse(scenarioMessage({
      files: ['brand/logo.svg'],
      notes: 'Focus on students',
      current: sampleScenario,
      setup: sampleSetup,
    }));
    assert.equal(msg.setup.kind, 'multi');
    assert.equal(msg.setup.primaryLanguage, 'en');
    assert.equal(msg.setup.primaryFormat.id, '9x16');
    assert.equal(msg.files[0].url, 'assets/brand/logo.svg');
    assert.equal(msg.notes, 'Focus on students');
    assert.equal(msg.current.theme, sampleScenario.theme);

    const cutsMsg = JSON.parse(scenarioMessage({
      files: [],
      current: sampleScenario,
      setup: sampleSetup,
      missingCuts: [6, 15],
    }));
    assert.equal(cutsMsg.notes, 'Add cuts for these lengths: 6, 15 s. Keep all existing lines, translations and cuts unchanged.');
  });

  it('builds P3 scenarioRepairMessage and P5 translatePrompt / translateMessage', () => {
    const repair = scenarioRepairMessage(['Missing cut for 6 s', 'Window s1 too short']);
    assert.ok(repair.includes('- Missing cut for 6 s\n- Window s1 too short'));
    assert.ok(repair.endsWith('Never shorten the time below the need.'));

    const tp = translatePrompt({languages: ['sr-Latn', 'de'], primary: 'en'});
    assert.ok(tp.includes('target languages in an ad scenario: sr-Latn, de. The source of truth is the primary language (en).'));

    const tm = JSON.parse(translateMessage({scenario: sampleScenario, languages: ['sr-Latn']}));
    assert.equal(tm.primaryLanguage, 'en');
    assert.deepEqual(tm.languages, ['sr-Latn']);
  });

  it('builds P6 stylesPrompt, P7 previewPrompt, P8 finalPrompt and P9 stageRevisionPrompt across kinds', () => {
    for (const kind of ['poster', 'single', 'multi']) {
      const sp = stylesPrompt({kind, setup: {...sampleSetup, kind}});
      assert.ok(sp.includes(P1[kind]));
      assert.ok(sp.includes('1080×1920 viewBox'));

      const pp = previewPrompt({kind, setup: {...sampleSetup, kind}});
      assert.ok(pp.includes('STAGE: PREVIEW.'));
      assert.ok(pp.includes('ONE format: 9x16 (9:16), 1080×1920 CSS px, filling 100vw×100vh. ONE language: en.'));

      const fp = finalPrompt({
        kind,
        setup: {...sampleSetup, kind},
        media: {images: true, video: false},
        previewPath: '/tmp/preview.src.html',
      });
      assert.ok(fp.includes('TASK: UPGRADE THE APPROVED PREVIEW TO THE FINAL.'));
      assert.ok(fp.includes('/tmp/preview.src.html'));
      assert.ok(fp.includes('Languages: en, ar (RTL), sr-Latn.'));
      assert.ok(fp.includes('Never put text, logos or UI inside generated images.'));

      const revClaude = stageRevisionPrompt({stage: 'final', kind, setup: {...sampleSetup, kind}, editing: true});
      assert.ok(revClaude.includes('TASK: REVISE THE FINAL in a chat with the client.'));
      assert.ok(revClaude.includes('Change it only with the Edit tool'));
      assert.ok(revClaude.includes('```forma-copy'));

      const revCodex = stageRevisionPrompt({stage: 'preview', kind, setup: {...sampleSetup, kind}, editing: false});
      assert.ok(revCodex.includes('TASK: REVISE THE PREVIEW in a chat with the client.'));
      assert.ok(revCodex.includes('<!-- forma-reply:'));
    }
  });
});

describe('creative.mjs: parseStyleChoices', () => {
  const threeStyles = [
    {name:'UI Split', idea:'Crisp app card', direction:'Grid notes', svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920"><rect width="100" height="100"/></svg>'},
    {name:'Photo Cut', idea:'Hand with card', direction:'Photo notes', svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920"><circle r="50"/></svg>'},
    {name:'Paper Craft', idea:'Paper receipt', direction:'Craft notes', svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920"><path d="M0 0h10v10z"/></svg>'},
  ];

  it('accepts both v2 (without scenario) and legacy (with scenario) shapes', () => {
    const v2 = parseStyleChoices(JSON.stringify({styles: threeStyles}));
    assert.equal(v2.styles.length, 3);
    assert.equal(v2.scenario, undefined);

    const legacy = parseStyleChoices(JSON.stringify({scenario: 'Theme: X', styles: threeStyles}));
    assert.equal(legacy.styles.length, 3);
    assert.equal(legacy.scenario, 'Theme: X');
  });
});

describe('creative.mjs: copy patch extraction, validation and merge', () => {
  it('extracts forma-copy block from a Claude reply and strips it from display text', () => {
    const claudeReply = [
      'Обновил текст оффера на обоих языках.',
      '```forma-copy',
      '{"o1":{"en":"Free for 3 months","sr-Latn":"Besplatno 3 meseca"}}',
      '```',
    ].join('\n');

    const {reply, patch} = extractCopyPatch(claudeReply);
    assert.equal(reply, 'Обновил текст оффера на обоих языках.');
    assert.deepEqual(patch, {o1: {en: 'Free for 3 months', 'sr-Latn': 'Besplatno 3 meseca'}});
  });

  it('extracts forma-copy block from a Codex forma-reply comment and cleans the HTML comment', () => {
    const codexHtml = `<!doctype html><!-- forma-reply: Поправил кнопку и оффер.\n\`\`\`forma-copy\n{"cta":{"en":"Join free","sr-Latn":"Pridruži se"}}\n\`\`\` --><html><body></body></html>`;
    const {reply, patch, html} = extractCopyPatch(codexHtml, {fromHtml: true});
    assert.equal(reply, 'Поправил кнопку и оффер.');
    assert.deepEqual(patch, {cta: {en: 'Join free', 'sr-Latn': 'Pridruži se'}});
    assert.ok(!html.includes('forma-copy'));
    assert.ok(html.includes('<!-- forma-reply: Поправил кнопку и оффер. -->'));
  });

  it('validates copy patches and merges them into scenario without mutating original', () => {
    const valid = validateCopyPatch(
      {o1: {en: '  Free 90 days  ', 'sr-Latn': 'Besplatno 90 dana'}},
      sampleScenario,
      ['en', 'sr-Latn']
    );
    assert.deepEqual(valid, {o1: {en: 'Free 90 days', 'sr-Latn': 'Besplatno 90 dana'}});

    const mergedPatch = mergeCopyPatches({h1: {en: 'New hook'}}, valid);
    const updatedScenario = applyCopyPatch(sampleScenario, mergedPatch);
    assert.equal(updatedScenario.lines.h1.text.en, 'New hook');
    assert.equal(updatedScenario.lines.o1.text.en, 'Free 90 days');
    assert.equal(sampleScenario.lines.o1.text.en, 'Free for 3 months');

    // Invalid line key
    assert.throws(
      () => validateCopyPatch({unknownKey: {en: 'Hi'}}, sampleScenario, ['en', 'sr-Latn']),
      /Unknown line key/
    );
    // Invalid language
    assert.throws(
      () => validateCopyPatch({o1: {fr: 'Gratuit'}}, sampleScenario, ['en', 'sr-Latn']),
      /is not selected for this campaign/
    );
    // Empty string
    assert.throws(
      () => validateCopyPatch({o1: {en: '   '}}, sampleScenario, ['en', 'sr-Latn']),
      /cannot be empty/
    );
    // String over 200 chars
    assert.throws(
      () => validateCopyPatch({o1: {en: 'x'.repeat(201)}}, sampleScenario, ['en', 'sr-Latn']),
      /exceeds 200 characters/
    );
  });
});
