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

import {hardProblems, fixMessage, videoProblems} from '../campaigns.mjs';

test('check after build: hard problems are breakage, not taste; the fix message names causes', () => {
  const problems = {
    errors: [{message: 'Script error: SecurityError: Failed to execute getImageData: The canvas has been tainted', where: ['9:16 · en']}, {message: 'Console error: deprecated API', where: ['1:1']}],
    blank: ['9:16 · first frame'], green: ['1:1 · s1 in'],
  };
  const hard = hardProblems(problems);
  assert.equal(hard.length, 3);
  assert.match(hard[0], /^1 browser error \(Script error: SecurityError/);
  assert.deepEqual(hardProblems({errors: [{message: 'Console error: deprecated API', where: []}], blank: [], green: []}), []);
  const msg = fixMessage(problems);
  assert.match(msg, /change nothing else/);
  assert.match(msg, /tainted canvas means a picture or clip was read without CORS/);
  assert.match(msg, /#00FF00 is visible in: 1:1 · s1 in/);
  assert.doesNotMatch(msg, /deprecated API/);
});

test('check after build (round 8): a spot that does not move and a video that never came are breakage', () => {
  const failed = {level: 'error', msg: 'OpenRouter ✗ video “s1-pour”', detail: 'OpenRouter 404: No endpoints found for minimax/hailuo-3-max.'};
  const html = '<video src="assets/generated/s1-pour.mp4"></video><img src="assets/logo.svg"><script>const v = "https://cdn.example/x.mp4"; FORMA.screen(v, ui)</script>';
  const none = videoProblems({events: [failed, failed], html, assets: ['logo.svg']});
  assert.equal(none.length, 2);
  assert.match(none[0], /^No clip was generated: 2 video requests failed \(last: OpenRouter 404: No endpoints found/);
  assert.match(none[1], /plays assets\/generated\/s1-pour\.mp4, which is not in the materials/);
  assert.deepEqual(videoProblems({events: [failed, {level: 'done', msg: 'OpenRouter ✓', media: {kind: 'video', file: 'generated/s1-pour.mp4'}}], html, assets: ['logo.svg', 'generated/s1-pour.mp4']}), [], 'a retry that worked');
  assert.deepEqual(videoProblems({events: [], html: '<video src="./assets/brand/film.mp4?v=2">', assets: ['brand/film.mp4']}), []);
  assert.deepEqual(videoProblems({events: [], html: "src: 'assets/screens/ab12.mp4'", assets: []}), [], 'bakes are made after the build');
  const hard = hardProblems({errors: [], blank: [], green: [], still: ['9:16', '1:1'], video: none});
  assert.deepEqual(hard.map(h => h.split(':')[0]), ['the video does not move in', 'no video']);
  const msg = fixMessage({still: ['9:16'], video: none});
  assert.match(msg, /same picture at every moment in: 9:16/);
  assert.match(msg, /never pass stills off as the video/);
});

import {stageRevisionPrompt, revisionMessage} from '../creative.mjs';

test('revisions: sizes as numbers, no new lines of text, the frames of the current version', () => {
  const p = stageRevisionPrompt({stage: 'final', kind: 'multi', setup: {kind: 'multi', formats: ['9x16'], languages: ['en'], lengths: [10]}});
  assert.match(p, /at least a quarter for a size/);
  assert.match(p, /A revision cannot add a new line/);
  const m = revisionMessage({workFile: 'w.html', files: [], message: 'make the offer bigger', frames: [{rel: 'review/check-1/format-9x16.png', title: '9:16 · en · 10 s'}]});
  assert.match(m, /Frames of the current version[^\n]*review\/check-1\/format-9x16\.png/);
});

import {scenarioMessage, scenarioPrompt as scenarioPromptFor} from '../creative.mjs';

test('script step: the brand’s used ideas travel with a fresh script, not with a revision of one', () => {
  const setup = {kind: 'multi', formats: ['9x16'], languages: ['en'], lengths: [10]};
  const used = [{campaign: 'Spring', theme: 'Many versions of one idea', idea: 'One ad becomes a wall of variants', pictures: ['a contact sheet of ads']}];
  assert.deepEqual(JSON.parse(scenarioMessage({setup, usedIdeas: used})).used_ideas, used);
  assert.equal(JSON.parse(scenarioMessage({setup, usedIdeas: used, current: {theme: 'x'}})).used_ideas, undefined);
  assert.match(scenarioPromptFor(setup), /"used_ideas", when present/);
});
