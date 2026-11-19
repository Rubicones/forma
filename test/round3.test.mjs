// Rounds 2–3 of the lab: render problems for the art director, brand-notes guesses, one film, screens, 3D in code.
import test from 'node:test';
import assert from 'node:assert/strict';
import {brandNotesPrompt, reviewMessage, reviewPrompt, finalPrompt, previewPrompt, stylesPrompt, scenarioPrompt} from '../creative.mjs';
import {planShots} from '../render.mjs';
import {inject} from '../motion.mjs';
import {windowNeed, readingSeconds, PICTURE_SECONDS} from '../shared/reading.mjs';

const setup = {kind: 'multi', formats: ['9x16', '1x1'], languages: ['en', 'ru'], lengths: [10], provider: {mode: 'claude'}};
const scenario = {kind: 'multi', scenes: [{id: 's1'}, {id: 's2'}], lines: {}};

test('brand notes: guesses never become bans', () => {
  const p = brandNotesPrompt();
  assert.match(p, /No guesses here/);
  assert.match(p, /A guess is a possibility, never a rule/);
  assert.doesNotMatch(p, /and what it is never used as/);
});

test('the art director gets browser errors and flat frames as facts', () => {
  const problems = {errors: [{message: 'Script error: Tainted canvases may not be loaded.', where: ['9:16 · en']}], blank: ['9:16 · s1 in']};
  const msg = JSON.parse(reviewMessage({stage: 'final', setup, scenario, sheets: [], problems}));
  assert.equal(msg.render_problems.browser_errors[0].message, problems.errors[0].message);
  assert.deepEqual(msg.render_problems.flat_frames, problems.blank);
  assert.equal(JSON.parse(reviewMessage({stage: 'final', setup, scenario, sheets: []})).render_problems, undefined);
  assert.match(reviewPrompt({stage: 'final'}), /render_problems/);
  assert.match(reviewPrompt({stage: 'preview'}), /The first second/);
});

test('render plan asks for text close-ups on the frames that carry the copy', () => {
  assert.ok(planShots({stage: 'final', setup, scenario}).filter(s => s.sheet !== 'languages').every(s => s.details));
  assert.ok(planShots({stage: 'preview', setup, scenario}).every(s => s.details));
  assert.ok(planShots({stage: 'final', setup, scenario}).filter(s => s.sheet === 'languages').every(s => !s.details));
});

test('final: one film, one way of making, screens pinned under glass, 3D kept, no tainted textures', () => {
  const p = finalPrompt({kind: 'multi', scenario, style: {}, setup, media: {images: true, video: true}});
  assert.match(p, /ONE FILM, NOT A SLIDESHOW/);
  assert.match(p, /One way of making for the whole spot/);
  assert.match(p, /FORMA\.findSurface\(img\)/);
  assert.match(p, /Tainted canvases may not be loaded/);
  assert.match(p, /stays that object, now moving/);
});

test('preview and directions: a narrow path for 3D in code', () => {
  assert.match(stylesPrompt({kind: 'multi', scenario, setup}), /3D in code:/);
  assert.match(previewPrompt({kind: 'multi', scenario, style: {}, setup}), /when the direction says "3D in code:"/);
});

test('reading time: a new scene picture needs time, the closing window keeps its hold', () => {
  const one = readingSeconds('Hello world', 'en');
  assert.equal(windowNeed(['Hello world'], 'en', {picture: true}), one + PICTURE_SECONDS);
  assert.equal(windowNeed(['Hello world'], 'en', {picture: true, closing: true}), one + 1.0);
  assert.match(scenarioPrompt({kind: 'multi'}), /0\.6 s to take in the scene's picture/);
});

test('runtime exposes FORMA.pin and FORMA.findSurface', () => {
  const html = inject('<!doctype html><html><head></head><body></body></html>', {stage: 'final', kind: 'multi', formats: [{id: '1x1', w: 1080, h: 1080, label: '1:1', safe: {top: 0, bottom: 0, left: 0, right: 0}}], langs: ['en'], copy: {}, scenario: {kind: 'multi', scenes: [], lines: {}}});
  assert.match(html, /findSurface\(img/);
  assert.match(html, /pin\(el, quad\)/);
});
