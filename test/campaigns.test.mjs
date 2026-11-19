import {describe, it, before, after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import * as history from '../history.mjs';
import {resolveRuntime} from '../motion.mjs';
import {
  validateSetup,
  createCampaignRecord,
  upgradeCampaign,
  applyCampaignPatch,
  addCost,
  emptyCost,
  acquireJob,
  releaseJob,
  runningJob,
  registerCampaignRoutes,
} from '../campaigns.mjs';

const sampleScenario = () => ({
  version: 2,
  kind: 'multi',
  theme: 'Splitting bills without the argument',
  idea: 'Two flatmates both swear they paid; the app ends it in one tap.',
  languages: ['en', 'ru'],
  lines: {
    h1:  {role:'hook',  scene:'s1', maxChars:24, hideIn:[], text:{en:'“I paid last.”',       ru:'«Платил уже я.»'}},
    p1:  {role:'proof', scene:'s2', maxChars:28, hideIn:[], text:{en:'One list. Split fast.', ru:'Один список на всех.'}},
    o1:  {role:'offer', scene:'s3', maxChars:32, hideIn:[], text:{en:'Free 3 months',         ru:'3 месяца бесплатно'}},
    cta: {role:'cta',   scene:'s3', maxChars:24, hideIn:[], text:{en:'Start budget',          ru:'Начать бюджет'}},
  },
  scenes: [
    {id:'s1', beat:'HOOK',        story:'Two voices claim the same bill.',         lines:['h1']},
    {id:'s2', beat:'PROOF',       story:'The shared list settles who paid what.',  lines:['p1']},
    {id:'s3', beat:'OFFER + CTA', story:'The offer lands with the brand and CTA.', lines:['o1', 'cta']},
  ],
  cuts: {
    '4': {
      scenes: [
        {id:'s1', start:0,   end:2.0, lines:['h1']},
        {id:'s3', start:2.0, end:4,   lines:['cta']},
      ],
      note: 'Short cut.',
    },
    '10': {
      scenes: [
        {id:'s1', start:0,   end:3.0, lines:['h1']},
        {id:'s2', start:3.0, end:5.6, lines:['p1']},
        {id:'s3', start:5.6, end:10,  lines:['o1', 'cta']},
      ],
      note: 'Full cut.',
    },
  },
});

describe('campaigns.mjs: setup validation, concurrency, invalidation and cost roll-up', () => {
  it('validates setup for poster, single and multi and rejects invalid setups with 409', () => {
    const poster = validateSetup({
      kind: 'poster',
      languages: ['ru', 'en'],
      lengths: [6, 10], // stripped to [] for poster
      formats: ['1x1', '9x16'],
      provider: {mode: 'demo'},
    });
    assert.deepEqual(poster.lengths, []);
    assert.deepEqual(poster.languages, ['ru', 'en']);

    const single = validateSetup({
      kind: 'single',
      languages: ['en'],
      lengths: [2, 6],
      formats: ['9x16'],
      provider: {mode: 'demo'},
    });
    assert.deepEqual(single.lengths, [2, 6]);

    // Multi rejects length < 4
    assert.throws(
      () => validateSetup({kind:'multi', languages:['en'], lengths:[3], formats:['1x1']}),
      err => err.status === 409 && /between 4 and 60/.test(err.message)
    );
    // Rejects empty languages
    assert.throws(
      () => validateSetup({kind:'poster', languages:[], formats:['1x1']}),
      err => err.status === 409
    );
    // Rejects unknown format
    assert.throws(
      () => validateSetup({kind:'poster', languages:['en'], formats:['bad']}),
      err => err.status === 409
    );
  });

  it('enforces one running job per campaign', () => {
    const cid = randomUUID();
    const r1 = randomUUID();
    acquireJob(cid, r1);
    assert.throws(
      () => acquireJob(cid, randomUUID()),
      err => err.status === 409 && /Wait for the current step to finish/.test(err.message)
    );
    releaseJob(cid, r1);
    assert.equal(runningJob.has(cid), false);
  });

  it('rolls up costs accurately', () => {
    let cost = emptyCost();
    cost = addCost(cost, {llm: 0.045, image: 0, video: 0, total: 0.045, unknown: false});
    cost = addCost(cost, {llm: 0.12, image: 0.08, video: 0, total: 0.2, unknown: true});
    assert.equal(cost.llm, 0.165);
    assert.equal(cost.image, 0.08);
    assert.equal(cost.total, 0.245);
    assert.equal(cost.unknown, true);
  });

  it('applies §2.5 invalidation rules on setup changes', () => {
    const sc = sampleScenario();
    const baseCampaign = () => {
      const c = createCampaignRecord({
        project: randomUUID(),
        setup: {
          kind: 'multi',
          languages: ['en', 'ru'],
          lengths: [4, 10],
          formats: ['9x16', '1x1'],
          provider: {mode: 'demo'},
        },
      });
      c.steps.scenario = {entryId: randomUUID(), approvedAt: new Date().toISOString(), stale: false, needs: []};
      c.steps.styles = {entryId: randomUUID(), chosenIndex: 0, direction: 'Dir'};
      c.steps.preview = {entryId: randomUUID(), approvedAt: new Date().toISOString(), stale: false};
      c.steps.final = {entryId: randomUUID(), stale: false};
      return c;
    };

    // 1. Adding a secondary language -> needs:['translation'] and final stale (preview not stale)
    const cLang = baseCampaign();
    const pLang = applyCampaignPatch(cLang, {setup: {languages: ['en', 'ru', 'de']}}, sc);
    assert.deepEqual(pLang.steps.scenario.needs, ['translation']);
    assert.equal(pLang.steps.preview.stale, false);
    assert.equal(pLang.steps.final.stale, true);

    // 2. Changing primary language -> preview + final stale
    const cPrimLang = baseCampaign();
    const pPrimLang = applyCampaignPatch(cPrimLang, {setup: {languages: ['ru', 'en']}}, sc);
    assert.equal(pPrimLang.steps.preview.stale, true);
    assert.equal(pPrimLang.steps.final.stale, true);

    // 3. Adding a new length -> needs:['cuts'] and final stale (preview not stale)
    const cLen = baseCampaign();
    const pLen = applyCampaignPatch(cLen, {setup: {lengths: [4, 6, 10]}}, sc);
    assert.deepEqual(pLen.steps.scenario.needs, ['cuts']);
    assert.equal(pLen.steps.preview.stale, false);
    assert.equal(pLen.steps.final.stale, true);

    // 4. Changing primary format -> preview + final stale
    const cPrimFmt = baseCampaign();
    const pPrimFmt = applyCampaignPatch(cPrimFmt, {setup: {formats: ['1x1', '9x16']}}, sc);
    assert.equal(pPrimFmt.steps.preview.stale, true);
    assert.equal(pPrimFmt.steps.final.stale, true);

    // 5. Changing kind -> everything stale
    const cKind = baseCampaign();
    const pKind = applyCampaignPatch(cKind, {setup: {kind: 'poster'}}, sc);
    assert.equal(pKind.steps.scenario.stale, true);
    assert.equal(pKind.steps.scenario.approvedAt, null);
    assert.equal(pKind.steps.preview.stale, true);
    assert.equal(pKind.steps.final.stale, true);
  });
});

describe('campaigns.mjs: HTTP endpoints, gating and history integration', () => {
  let tempDir, app, projectId;
  let modelCalls = [];
  let mockTextImpl = async () => '{}';
  let mockHtmlImpl = async () => '<html><body></body></html>';
  let mockReviseImpl = async () => ({html: '<html><body></body></html>', reply: 'ok'});
  const renderCalls = [];

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(tmpdir(), 'forma-camp-test-'));
    await history.openHistory(tempDir);
    projectId = randomUUID();
    await fs.mkdir(path.join(tempDir, projectId, 'assets'), {recursive: true});

    app = express();
    const {reviseCampaignEntry} = registerCampaignRoutes(app, {
      root: path.resolve('.'),
      dataDir: tempDir,
      previewURL: 'http://127.0.0.1:4318',
      libs: '',
      folder: id => path.join(tempDir, id),
      assetName: n => n,
      checkProvider: async () => {},
      listAssets: async () => ['logo.svg'],
      generatedMedia: () => [],
      costLine: () => '',
      assetURL: (id, f) => `/p/${id}/assets/${f}`,
      runModelText: async args => { modelCalls.push({fn: 'text', ...args}); return mockTextImpl(args); },
      runModelHtml: async args => { modelCalls.push({fn: 'html', ...args}); return mockHtmlImpl(args); },
      runModelRevise: async args => { modelCalls.push({fn: 'revise', ...args}); return mockReviseImpl(args); },
      renderSheets: async args => {
        renderCalls.push(args);
        const name = args.stage === 'preview' ? 'preview' : 'format-9x16';
        return [{name, title: name, file: path.join(args.outDir, name + '.png'), url: args.publicBase + '/' + name + '.png', frames: 4}];
      },
    });
    app.post('/api/history/:id/revise', async (req, res) => {
      const parent = await history.get(req.params.id);
      if (parent && parent.campaign && ['preview', 'creative'].includes(parent.type) && parent.output?.path) {
        return reviseCampaignEntry(req, res, parent);
      }
      res.status(404).json({error: 'Not found'});
    });
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({error: err.message});
    });
  });

  after(async () => {
    if (tempDir) await fs.rm(tempDir, {recursive: true, force: true}).catch(() => {});
  });

  const req = (method, urlPath, body) => new Promise((resolve, reject) => {
    const u = new URL(urlPath, 'http://127.0.0.1:4317');
    const mockReq = {
      method: method.toUpperCase(),
      url: u.pathname + u.search,
      originalUrl: u.pathname + u.search,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams.entries()),
      headers: {'content-type': 'application/json', 'x-forma': 'studio'},
      body: body ?? {},
      on() {},
      once() {},
      emit() {},
    };
    Object.setPrototypeOf(mockReq, express.request);
    const headers = {};
    const mockRes = {
      statusCode: 200,
      writableFinished: false,
      status(code) { this.statusCode = code; return this; },
      set(k, v) { if (typeof k === 'object') Object.assign(headers, k); else headers[k] = v; return this; },
      setHeader(k, v) { headers[k] = v; return this; },
      getHeader(k) { return headers[k]; },
      json(payload) {
        this.writableFinished = true;
        resolve({status: this.statusCode, body: payload});
        return this;
      },
      sendStatus(code) {
        this.statusCode = code;
        this.writableFinished = true;
        resolve({status: code, body: null});
        return this;
      },
      end(data) {
        this.writableFinished = true;
        resolve({status: this.statusCode, body: data});
      },
    };
    Object.setPrototypeOf(mockRes, express.response);
    app.handle(mockReq, mockRes, err => {
      if (err) resolve({status: err.status || 500, body: {error: err.message}});
    });
  });

  it('creates a campaign, enforces 409 gates before approvals, saves manual scenario, approves, and invalidates on PATCH', async () => {
    // Create campaign
    const created = await req('POST', '/api/campaigns', {
      project: projectId,
      setup: {
        kind: 'multi',
        languages: ['en', 'ru'],
        lengths: [4, 10],
        formats: ['9x16', '1x1'],
        provider: {mode: 'demo'},
      },
    });
    assert.equal(created.status, 201);
    const cid = created.body.id;

    // Gate: styles before scenario approval -> 409
    const stylesBlocked = await req('POST', `/api/campaigns/${cid}/styles`, {});
    assert.equal(stylesBlocked.status, 409);

    // Gate: preview before scenario approval -> 409
    const previewBlocked = await req('POST', `/api/campaigns/${cid}/preview`, {});
    assert.equal(previewBlocked.status, 409);

    // Gate: final before preview approval -> 409
    const finalBlocked = await req('POST', `/api/campaigns/${cid}/final`, {});
    assert.equal(finalBlocked.status, 409);

    // Save scenario via PUT
    const putSc = await req('PUT', `/api/campaigns/${cid}/scenario`, {scenario: sampleScenario()});
    assert.equal(putSc.status, 200);
    assert.deepEqual(putSc.body.validation.errors, []);
    assert.equal(putSc.body.campaign.name, 'Splitting bills without the argument');

    // Approve scenario
    const approved = await req('POST', `/api/campaigns/${cid}/approve`, {step: 'scenario'});
    assert.equal(approved.status, 200);
    assert.ok(approved.body.steps.scenario.approvedAt);

    // PATCH language -> needs:['translation']
    const patchedLang = await req('PATCH', `/api/campaigns/${cid}/ {setup}`.replace('/ {setup}', ''), {
      setup: {languages: ['en', 'ru', 'sr-Latn']},
    });
    assert.equal(patchedLang.status, 200);
    assert.deepEqual(patchedLang.body.steps.scenario.needs, ['translation']);

    // PATCH length -> needs includes 'cuts'
    const patchedLen = await req('PATCH', `/api/campaigns/${cid}`, {
      setup: {lengths: [4, 6, 10]},
    });
    assert.equal(patchedLen.status, 200);
    assert.ok(patchedLen.body.steps.scenario.needs.includes('cuts'));

    // List campaigns
    const list = await req('GET', '/api/campaigns');
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].id, cid);
  });

  it('runs the full end-to-end demo flow (scenario → approve → styles → choose → preview → approve → final → translate/cuts → copy patch)', async () => {
    const created = await req('POST', '/api/campaigns', {
      project: projectId,
      setup: {
        kind: 'multi',
        languages: ['en', 'ru'],
        lengths: [4, 10],
        formats: ['9x16', '1x1'],
        provider: {mode: 'demo'},
      },
    });
    assert.equal(created.status, 201);
    const cid = created.body.id;

    // 1. Generate scenario in demo mode
    const scRes = await req('POST', `/api/campaigns/${cid}/scenario`, {notes: 'Make it snappy'});
    assert.equal(scRes.status, 200);
    assert.deepEqual(scRes.body.validation.errors, [], JSON.stringify(scRes.body.validation.errors));

    // 2. Approve scenario
    const appSc = await req('POST', `/api/campaigns/${cid}/approve`, {step: 'scenario'});
    assert.equal(appSc.status, 200);

    // 3. Generate 3 style directions
    const stRes = await req('POST', `/api/campaigns/${cid}/styles`, {});
    assert.equal(stRes.status, 200);
    assert.equal(stRes.body.styles.length, 3);

    // Gate: preview before choosing style -> 409
    const prevBeforeChoose = await req('POST', `/api/campaigns/${cid}/preview`, {});
    assert.equal(prevBeforeChoose.status, 409);

    // 4. Choose style 1
    const chRes = await req('POST', `/api/campaigns/${cid}/styles/choose`, {index: 1});
    assert.equal(chRes.status, 200);
    assert.equal(chRes.body.steps.styles.chosenIndex, 1);

    // 5. Build preview
    const prevRes = await req('POST', `/api/campaigns/${cid}/preview`, {});
    assert.equal(prevRes.status, 200);
    assert.ok(prevRes.body.url.endsWith('.html'));

    // Gate: final before preview approval -> 409
    const finalBeforeApprove = await req('POST', `/api/campaigns/${cid}/final`, {});
    assert.equal(finalBeforeApprove.status, 409);

    // 6. Approve preview
    const appPrev = await req('POST', `/api/campaigns/${cid}/approve`, {step: 'preview'});
    assert.equal(appPrev.status, 200);

    // 7. Build final
    const finalRes = await req('POST', `/api/campaigns/${cid}/final`, {media: {images: false, video: false}});
    assert.equal(finalRes.status, 200);
    assert.ok(finalRes.body.url.endsWith('.html'));
    const finalHistoryId = finalRes.body.historyId;

    // 8. Copy patch on final -> new entry & re-injected file containing the new string
    const copyRes = await req('POST', `/api/history/${finalHistoryId}/copy`, {
      patch: {o1: {en: 'Zero fees for 90 days', ru: '90 дней без комиссии'}},
    });
    assert.equal(copyRes.status, 200);
    assert.notEqual(copyRes.body.historyId, finalHistoryId);
    const reinjectedFile = path.join(tempDir, new URL(copyRes.body.url).pathname.replace(/^\/p\//, ''));
    const reinjectedHtml = await fs.readFile(reinjectedFile, 'utf8');
    assert.ok(reinjectedHtml.includes('Zero fees for 90 days'));
    assert.ok(reinjectedHtml.includes('90 дней без комиссии'));

    // 9. Change language -> needs:['translation'] and final stale, then translate clears needs
    const patchLang = await req('PATCH', `/api/campaigns/${cid}`, {
      setup: {languages: ['en', 'ru', 'de']},
    });
    assert.equal(patchLang.status, 200);
    assert.deepEqual(patchLang.body.steps.scenario.needs, ['translation']);
    assert.equal(patchLang.body.steps.final.stale, true);

    const trRes = await req('POST', `/api/campaigns/${cid}/translate`, {});
    assert.equal(trRes.status, 200);
    assert.deepEqual(trRes.body.campaign.steps.scenario.needs, []);
    assert.ok(trRes.body.scenario.lines.h1.text.de.startsWith('[de]'));

    // 10. Change length -> needs:['cuts'], then cuts clears needs
    const patchLen = await req('PATCH', `/api/campaigns/${cid}`, {
      setup: {lengths: [4, 6, 10]},
    });
    assert.equal(patchLen.status, 200);
    assert.deepEqual(patchLen.body.steps.scenario.needs, ['cuts']);

    const cutsRes = await req('POST', `/api/campaigns/${cid}/cuts`, {});
    assert.equal(cutsRes.status, 200);
    assert.deepEqual(cutsRes.body.campaign.steps.scenario.needs, []);
    assert.ok(cutsRes.body.scenario.cuts['6']);

    // 11. Parallel job gate -> 409 while a job is running
    const p1 = req('POST', `/api/campaigns/${cid}/styles`, {});
    // Give the first request time to take the campaign's run lock (the demo step itself lasts ~0.4 s); without it the two raced.
    await new Promise(resolve => setTimeout(resolve, 120));
    const p2 = await req('POST', `/api/campaigns/${cid}/styles`, {});
    assert.equal(p2.status, 409);
    const p1Done = await p1;
    assert.equal(p1Done.status, 200);

    // 12. Fork campaign -> clones setup, scenario and styles into a new pipeline run without losing the original
    const forked = await req('POST', `/api/campaigns/${cid}/fork`, {styleIndex: 2, name: 'Ветка 3'});
    assert.equal(forked.status, 201);
    assert.notEqual(forked.body.id, cid);
    assert.equal(forked.body.name, 'Ветка 3');
    assert.equal(forked.body.steps.scenario.entryId, cutsRes.body.historyId);
    assert.equal(forked.body.steps.styles.chosenIndex, 2);
    assert.equal(forked.body.steps.preview.entryId, null);
    assert.equal(forked.body.steps.final.entryId, null);

    const listRes = await req('GET', '/api/campaigns');
    const origInList = listRes.body.items.find(c => c.id === cid);
    assert.ok(origInList.pipeline.scenario);
    assert.equal(origInList.pipeline.styles.styles.length, 3);
    assert.ok(origInList.pipeline.final);
  });

  it('verifies demo final fixture: seamless single loop (renderFrame(0) === renderFrame(period)) and multi cut isolation', async () => {
    const finalHtml = await fs.readFile(path.resolve('fixtures/final.html'), 'utf8');
    const scriptMatch = finalHtml.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch);

    const runFixture = (search, data) => {
      const state = resolveRuntime(search, data);
      const setups = [];
      const makeNode = (tag) => ({
        tagName: tag,
        className: '',
        dataset: {},
        style: {},
        hidden: false,
        textContent: '',
        children: [],
        appendChild(c) { this.children.push(c); return c; },
        replaceChildren(...nodes) { this.children = [...nodes]; },
        get clientWidth() { return 400; },
        get clientHeight() { return 100; },
        get scrollWidth() { return 300; },
        get scrollHeight() { return 80; },
      });
      const elements = {
        scenesLayer: makeNode('div'),
        heroDial: makeNode('div'),
        heroBar: makeNode('div'),
        ctaBtn: makeNode('div'),
      };
      const windowObj = {
        FORMA: {
          ...state,
          setup(fn) { setups.push(fn); },
          fitGroup() { return 32; },
        },
      };
      const sandbox = {
        window: windowObj,
        document: {
          getElementById: id => elements[id] || makeNode('div'),
          createElement: tag => makeNode(tag),
        },
      };
      vm.runInNewContext(scriptMatch[1], sandbox);
      for (const fn of setups) fn();
      return {window: windowObj, elements};
    };

    // Single-scene seamless loop check: renderFrame(0) and renderFrame(period) produce identical state
    const singleSc = JSON.parse(await fs.readFile(path.resolve('fixtures/scenario-single.json'), 'utf8'));
    const singleCtx = runFixture('?d=6', {
      stage: 'final',
      kind: 'single',
      formats: ['9x16'],
      langs: ['en'],
      lengths: [6, 10],
      scenario: singleSc,
    });
    const period = singleCtx.window.FORMA.loop.period;
    assert.equal(period, 3);
    const state0 = structuredClone(singleCtx.window.renderFrame(0));
    const stateMid = structuredClone(singleCtx.window.renderFrame(period / 2));
    const statePeriod = structuredClone(singleCtx.window.renderFrame(period));
    assert.equal(state0.transform, statePeriod.transform);
    assert.equal(state0.shiftX, statePeriod.shiftX);
    assert.equal(state0.scaleX, statePeriod.scaleX);
    assert.notEqual(state0.scaleX, stateMid.scaleX);

    // Multi-scene cut check: 4s cut omits s2 and h1b; 10s cut includes s1, s2, s3
    const multiSc = JSON.parse(await fs.readFile(path.resolve('fixtures/scenario-multi.json'), 'utf8'));
    const multi4 = runFixture('?d=4', {
      stage: 'final',
      kind: 'multi',
      formats: ['9x16'],
      langs: ['en'],
      lengths: [4, 10],
      scenario: multiSc,
    });
    const s4Start = JSON.parse(JSON.stringify(multi4.window.renderFrame(0.5)));
    assert.deepEqual(s4Start.cutScenes, ['s1', 's3']);
    assert.deepEqual(s4Start.visibleLines, ['h1']);

    const multi10 = runFixture('?d=10', {
      stage: 'final',
      kind: 'multi',
      formats: ['9x16'],
      langs: ['en'],
      lengths: [4, 10],
      scenario: multiSc,
    });
    const s10Mid = JSON.parse(JSON.stringify(multi10.window.renderFrame(4.0)));
    assert.deepEqual(s10Mid.cutScenes, ['s1', 's2', 's3']);
    assert.equal(s10Mid.activeScene, 's2');
    assert.deepEqual(s10Mid.visibleLines, ['p1']);
  });

  it('revises the three directions before the preview: one direction, all three, with Claude prompts', async () => {
    const created = await req('POST', '/api/campaigns', {
      project: projectId,
      setup: {kind: 'multi', languages: ['en'], lengths: [4], formats: ['9x16'], provider: {mode: 'demo'}},
    });
    const cid = created.body.id;
    await req('PUT', `/api/campaigns/${cid}/scenario`, {scenario: sampleScenario()});
    await req('POST', `/api/campaigns/${cid}/approve`, {step: 'scenario'});

    // Revising before any directions exist is refused
    assert.equal((await req('POST', `/api/campaigns/${cid}/styles`, {revise: 0})).status, 409);

    const st = await req('POST', `/api/campaigns/${cid}/styles`, {});
    const before = st.body.styles.map(x => x.name);
    await req('POST', `/api/campaigns/${cid}/styles/choose`, {index: 1});

    assert.equal((await req('POST', `/api/campaigns/${cid}/styles`, {revise: 7})).status, 400);
    assert.equal((await req('POST', `/api/campaigns/${cid}/styles`, {revise: 'all'})).status, 400);

    // One direction: only it changes, a choice of another direction survives
    const r0 = await req('POST', `/api/campaigns/${cid}/styles`, {revise: 0, feedback: 'Warmer, less corporate'});
    assert.equal(r0.status, 200);
    assert.deepEqual(r0.body.styles.map(x => x.name), [before[0] + ' · v2', before[1], before[2]]);
    assert.equal(r0.body.campaign.variants.length, 1);
    assert.equal(r0.body.campaign.variants[0].styles.chosenIndex, 1);
    assert.equal(r0.body.campaign.variants[0].label, before[1]);
    const e0 = await history.get(r0.body.historyId);
    assert.equal(e0.input.revise, 0);
    assert.equal(e0.input.feedback, 'Warmer, less corporate');
    assert.equal(e0.input.parentId, st.body.historyId);

    // Reworking the chosen direction resets the choice and the auto label
    const r1 = await req('POST', `/api/campaigns/${cid}/styles`, {revise: 1});
    assert.equal(r1.status, 200);
    assert.equal(r1.body.campaign.variants[0].styles.chosenIndex, null);
    assert.equal(r1.body.campaign.variants[0].label, 'Style 1');

    // All three
    const ra = await req('POST', `/api/campaigns/${cid}/styles`, {revise: 'all', feedback: 'Go darker'});
    assert.equal(ra.status, 200);
    assert.deepEqual(ra.body.styles.map(x => x.name), [before[0] + ' · v3', before[1] + ' · v3', before[2] + ' · v2']);

    // Claude: the revision prompt and message reach the model; a single returned direction is merged in
    const cc = await req('POST', '/api/campaigns', {
      project: projectId,
      setup: {kind: 'multi', languages: ['en'], lengths: [4], formats: ['9x16'], provider: {mode: 'claude', billing: 'subscription'}},
    });
    const ccid = cc.body.id;
    await req('PUT', `/api/campaigns/${ccid}/scenario`, {scenario: sampleScenario()});
    await req('POST', `/api/campaigns/${ccid}/approve`, {step: 'scenario'});
    const stylesFixture = await fs.readFile(path.resolve('fixtures/styles.json'), 'utf8');
    mockTextImpl = async () => stylesFixture;
    const cst = await req('POST', `/api/campaigns/${ccid}/styles`, {});
    assert.equal(cst.status, 200);
    modelCalls = [];
    const one = {style: {name: cst.body.styles[0].name, idea: 'A cut-paper stage', direction: 'Approach: paper · stage · puppetry · Leap: x', svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>'}};
    mockTextImpl = async ({onText}) => { onText?.(JSON.stringify(one)); return JSON.stringify(one); };
    const rc = await req('POST', `/api/campaigns/${ccid}/styles`, {revise: 2, feedback: 'More handmade'});
    assert.equal(rc.status, 200);
    assert.equal(rc.body.styles[2].name, cst.body.styles[0].name + ' 2');
    assert.equal(rc.body.styles[0].name, cst.body.styles[0].name);
    assert.match(modelCalls[0].system, /REVISION ROUND: REWORK ONE DIRECTION/);
    assert.match(modelCalls[0].user, /More handmade/);
    assert.doesNotMatch(modelCalls[0].user, /<svg/);
  });

  it('wires Claude and Codex per step: scenario auto-repair, translate, cuts, styles, preview, final, stage-aware revise and copy patches', async () => {
    const created = await req('POST', '/api/campaigns', {
      project: projectId,
      setup: {
        kind: 'multi',
        languages: ['en', 'ru'],
        lengths: [4, 10],
        formats: ['9x16', '1x1'],
        provider: {mode: 'claude', billing: 'subscription'},
      },
    });
    assert.equal(created.status, 201);
    const cid = created.body.id;

    // 1. Scenario auto-repair: 1st attempt fails validation (missing cut '10'), 2nd attempt succeeds
    modelCalls = [];
    let attempt = 0;
    mockTextImpl = async ({onText}) => {
      attempt++;
      if (attempt === 1) {
        const bad = sampleScenario();
        delete bad.cuts['10'];
        const str = JSON.stringify(bad);
        onText?.(str);
        return str;
      }
      const good = sampleScenario();
      const str = JSON.stringify(good);
      onText?.(str);
      return str;
    };

    const scRes = await req('POST', `/api/campaigns/${cid}/scenario`, {notes: 'Test auto-repair'});
    assert.equal(scRes.status, 200);
    assert.equal(modelCalls.length, 2);
    assert.ok(modelCalls[1].user.includes('Your previous scenario failed automatic validation. Errors:'));
    assert.deepEqual(scRes.body.validation.errors, []);
    const scEntry = await history.get(scRes.body.historyId, {withLog: true});
    assert.equal(scEntry.status, 'ok');
    assert.ok(scEntry.log.some(e => e.msg.includes('Script validation failed. Trying one repair.')));

    // 1b. Scenario auto-repair when 2nd attempt STILL has validation errors -> saves with status:'ok' and returns validation errors
    attempt = 0;
    mockTextImpl = async () => {
      const bad = sampleScenario();
      delete bad.cuts['10'];
      return JSON.stringify(bad);
    };
    const scStillBad = await req('POST', `/api/campaigns/${cid}/scenario`, {});
    assert.equal(scStillBad.status, 200);
    assert.ok(scStillBad.body.validation.errors.length > 0);
    const stillBadEntry = await history.get(scStillBad.body.historyId);
    assert.equal(stillBadEntry.status, 'ok');

    // Restore valid scenario via PUT and approve
    await req('PUT', `/api/campaigns/${cid}/scenario`, {scenario: sampleScenario()});
    await req('POST', `/api/campaigns/${cid}/approve`, {step: 'scenario'});

    // 2. Styles step with Claude
    const stylesFixture = await fs.readFile(path.resolve('fixtures/styles.json'), 'utf8');
    modelCalls = [];
    mockTextImpl = async ({onText}) => {
      onText?.(stylesFixture);
      return stylesFixture;
    };
    const stRes = await req('POST', `/api/campaigns/${cid}/styles`, {});
    assert.equal(stRes.status, 200);
    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0].task, 'style');
    await req('POST', `/api/campaigns/${cid}/styles/choose`, {index: 0});

    // 3. Preview step with Claude (no media tools)
    const previewFixture = await fs.readFile(path.resolve('fixtures/preview.html'), 'utf8');
    modelCalls = [];
    mockHtmlImpl = async () => previewFixture;
    const prevRes = await req('POST', `/api/campaigns/${cid}/preview`, {});
    assert.equal(prevRes.status, 200);
    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0].task, 'preview');
    assert.equal(modelCalls[0].media, null);
    const previewHistoryId = prevRes.body.historyId;
    await req('POST', `/api/campaigns/${cid}/approve`, {step: 'preview'});

    // 4. Final step with Claude (writes approved preview .src.html to temp dir, passes extraReadDirs/extraReadFiles)
    const finalFixture = await fs.readFile(path.resolve('fixtures/final.html'), 'utf8');
    modelCalls = [];
    let readPreviewContent = null;
    mockHtmlImpl = async ({extraReadFiles}) => {
      if (extraReadFiles?.[0]) {
        readPreviewContent = await fs.readFile(extraReadFiles[0], 'utf8');
      }
      return finalFixture;
    };
    const finalRes = await req('POST', `/api/campaigns/${cid}/final`, {media: {images: false, video: false}});
    assert.equal(finalRes.status, 200);
    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0].task, 'final');
    assert.equal(modelCalls[0].extraReadDirs.length, 1);
    assert.equal(modelCalls[0].extraReadFiles.length, 1);
    assert.equal(readPreviewContent, previewFixture);
    const finalHistoryId = finalRes.body.historyId;

    // 5. Final step with Codex (inlines approvedPreviewHtml in user message)
    await req('PATCH', `/api/campaigns/${cid}`, {setup: {provider: {mode: 'codex', billing: 'api', model: 'gpt-5.4', effort: 'high'}}});
    modelCalls = [];
    mockHtmlImpl = async () => finalFixture;
    const codexFinalRes = await req('POST', `/api/campaigns/${cid}/final`, {media: {images: false, video: false}});
    assert.equal(codexFinalRes.status, 200);
    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0].mode, 'codex');
    const codexUserMsg = JSON.parse(modelCalls[0].user);
    assert.equal(codexUserMsg.approvedPreviewHtml, previewFixture);

    // 6. Stage-aware revise on preview (Claude) with forma-copy block -> merges copyPatch, strips block from reply, marks final stale
    modelCalls = [];
    mockReviseImpl = async ({workFile}) => {
      const cur = await fs.readFile(workFile, 'utf8');
      return {
        html: cur,
        reply: 'Обновил заголовок и оффер.\n```forma-copy\n{"o1":{"en":"Free for 6 months","ru":"Бесплатно 6 месяцев"}}\n```',
      };
    };
    const revPrev = await req('POST', `/api/history/${previewHistoryId}/revise`, {
      mode: 'claude',
      billing: 'subscription',
      message: 'Поменяй оффер на 6 месяцев',
    });
    assert.equal(revPrev.status, 200);
    assert.equal(revPrev.body.reply, 'Обновил заголовок и оффер.');
    assert.ok(!revPrev.body.reply.includes('forma-copy'));
    assert.equal(revPrev.body.campaign.steps.final.stale, true);
    assert.equal(modelCalls[0].stage, 'preview');
    assert.ok(modelCalls[0].systemPrompt.includes('TASK: REVISE THE PREVIEW'));
    const revPrevEntry = await history.get(revPrev.body.historyId);
    assert.deepEqual(revPrevEntry.input.copyPatch, {o1: {en: 'Free for 6 months', ru: 'Бесплатно 6 месяцев'}});

    // 7. Stage-aware revise on final (Codex) with forma-copy inside <!-- forma-reply: ... --> comment
    modelCalls = [];
    mockHtmlImpl = async () => {
      return `<!DOCTYPE html><!-- forma-reply: Усилил CTA.\n\`\`\`forma-copy\n{"cta":{"en":"Join free today","ru":"Подключить бесплатно"}}\n\`\`\` -->\n` + finalFixture;
    };
    const revFinal = await req('POST', `/api/history/${finalHistoryId}/revise`, {
      mode: 'codex',
      billing: 'api',
      model: 'gpt-5.4',
      effort: 'high',
      message: 'Сделай CTA энергичнее',
    });
    assert.equal(revFinal.status, 200);
    assert.equal(revFinal.body.reply, 'Усилил CTA.');
    assert.ok(!revFinal.body.reply.includes('forma-copy'));
    const revFinalEntry = await history.get(revFinal.body.historyId);
    assert.deepEqual(revFinalEntry.input.copyPatch, {cta: {en: 'Join free today', ru: 'Подключить бесплатно'}});
    const revFinalHtml = await fs.readFile(path.join(tempDir, new URL(revFinal.body.url).pathname.replace(/^\/p\//, '')), 'utf8');
    assert.ok(revFinalHtml.includes('Join free today'));
    assert.ok(revFinalHtml.includes('Подключить бесплатно'));

    // 8. The art director's look: Claude only, renders the entry, keeps notes, and is marked applied by the revision
    const blockedLook = await req('POST', `/api/campaigns/${cid}/review`, {entryId: revFinal.body.historyId});
    assert.equal(blockedLook.status, 409);
    const toClaude = await req('PATCH', `/api/campaigns/${cid}`, {setup: {provider: {mode: 'claude', billing: 'subscription'}, review: {autoApplyPreview: true}}});
    assert.equal(toClaude.body.setup.review.autoApplyPreview, true);
    modelCalls = [];
    mockTextImpl = async () => 'Here you go:\n{"summary":"Reads well.","notes":[{"priority":"p0","where":"9:16 · end hold","problem":"The offer is cut at the right edge.","fix":"Shrink it."}]}';
    const look = await req('POST', `/api/campaigns/${cid}/review`, {entryId: revFinal.body.historyId});
    assert.equal(look.status, 200);
    assert.equal(look.body.review.for, revFinal.body.historyId);
    assert.equal(look.body.review.stage, 'final');
    assert.deepEqual(look.body.review.notes.map(n => n.priority), ['P0']);
    assert.ok(renderCalls.some(c => c.stage === 'final'));
    const lookCall = modelCalls.find(c => c.task === 'review');
    assert.ok(lookCall.system.includes('judge the execution'));
    assert.ok(JSON.parse(lookCall.user).sheets[0].file.startsWith('review/'));
    const listedLooks = await req('GET', `/api/campaigns/${cid}/reviews`);
    assert.equal(listedLooks.body[0].id, look.body.review.id);
    mockReviseImpl = async ({workFile}) => ({html: await fs.readFile(workFile, 'utf8'), reply: 'Fixed the offer.'});
    const appliedLook = await req('POST', `/api/history/${revFinal.body.historyId}/revise`, {
      mode: 'claude', billing: 'subscription',
      message: "Art director's notes on this final. Solve each one inside the chosen idea.\n1. [P0] 9:16 · end hold: The offer is cut at the right edge.",
      reviewId: look.body.review.id, reviewNotes: [0], auto: true,
    });
    assert.equal(appliedLook.status, 200);
    const afterLooks = await req('GET', `/api/campaigns/${cid}/reviews`);
    assert.equal(afterLooks.body[0].applied.entryId, appliedLook.body.historyId);
    assert.equal(afterLooks.body[0].applied.auto, true);

    // 8. Translate and Cuts with model (Claude/Codex)
    await req('PATCH', `/api/campaigns/${cid}`, {setup: {languages: ['en', 'ru', 'de'], lengths: [4, 6, 10]}});
    modelCalls = [];
    mockTextImpl = async () => JSON.stringify({
      lines: {
        h1:  {text: {de: '„Ich zahlte zuletzt.”'}},
        p1:  {text: {de: 'Eine Liste für alle.'}},
        o1:  {text: {de: '3 Monate gratis'}},
        cta: {text: {de: 'Budget starten'}},
      },
    });
    const trModel = await req('POST', `/api/campaigns/${cid}/translate`, {});
    assert.equal(trModel.status, 200);
    assert.equal(modelCalls[0].task, 'translate');
    assert.equal(trModel.body.scenario.lines.h1.text.de, '„Ich zahlte zuletzt.”');

    modelCalls = [];
    mockTextImpl = async () => {
      const next = structuredClone(trModel.body.scenario);
      next.cuts['6'] = {
        scenes: [
          {id: 's1', start: 0, end: 2.6, lines: ['h1']},
          {id: 's3', start: 2.6, end: 6.0, lines: ['cta']},
        ],
        note: '6s cut: hook → CTA (a proof scene does not fit with time to read).',
      };
      return JSON.stringify(next);
    };
    const cutsModel = await req('POST', `/api/campaigns/${cid}/cuts`, {});
    assert.equal(cutsModel.status, 200);
    assert.equal(modelCalls[0].task, 'cuts');
    assert.ok(modelCalls[0].user.includes('Add cuts for these lengths: 6 s. Keep all existing lines, translations and cuts unchanged.'));
    assert.deepEqual(cutsModel.body.validation.errors, []);
  });

  it('supports style variants (§4): upgradeCampaign, variant creation rules, per-variant gating, rename, switch and multi-variant invalidation', async () => {
    // 1. upgradeCampaign unit check: converts legacy single-step doc to variants[] + activeVariant and is idempotent
    const legacyDoc = {
      id: randomUUID(),
      type: 'campaign',
      createdAt: '2026-11-15T10:00:00.000Z',
      updatedAt: '2026-11-15T10:05:00.000Z',
      name: 'Legacy Campaign',
      project: projectId,
      setup: {kind: 'multi', languages: ['en'], lengths: [6], formats: ['9x16'], provider: {mode: 'demo'}},
      steps: {
        scenario: {entryId: randomUUID(), approvedAt: '2026-11-15T10:01:00.000Z', stale: false, needs: []},
        styles:   {entryId: randomUUID(), chosenIndex: 1, direction: 'Circular Photo Cutout\n\nHand with card\n\nNotes'},
        preview:  {entryId: randomUUID(), approvedAt: '2026-11-15T10:03:00.000Z', stale: false},
        final:    {entryId: randomUUID(), stale: false},
      },
      cost: {llm: 0.12, image: 0.04, video: 0, total: 0.16, unknown: false},
    };
    const up1 = upgradeCampaign(legacyDoc);
    assert.equal(up1.variants.length, 1);
    assert.equal(up1.activeVariant, up1.variants[0].id);
    assert.equal(up1.variants[0].label, 'Circular Photo Cutout');
    assert.equal(up1.variants[0].styles.entryId, legacyDoc.steps.styles.entryId);
    assert.equal(up1.variants[0].preview.entryId, legacyDoc.steps.preview.entryId);
    assert.equal(up1.variants[0].preview.approvedAt, legacyDoc.steps.preview.approvedAt);
    assert.equal(up1.variants[0].final.entryId, legacyDoc.steps.final.entryId);
    assert.deepEqual(up1.variants[0].cost, legacyDoc.cost);

    // Idempotence: second call preserves variant id, label, approvals and costs
    const up2 = upgradeCampaign(up1);
    assert.deepEqual(up2, up1);

    // 2. End-to-end variant rules on HTTP routes
    const created = await req('POST', '/api/campaigns', {
      project: projectId,
      setup: {
        kind: 'multi',
        languages: ['en', 'ru'],
        lengths: [4, 10],
        formats: ['9x16', '1x1'],
        provider: {mode: 'demo'},
      },
    });
    assert.equal(created.status, 201);
    const cid = created.body.id;
    assert.equal(created.body.variants.length, 1);
    const v1Id = created.body.activeVariant;

    // Put & approve scenario
    await req('PUT', `/api/campaigns/${cid}/scenario`, {scenario: sampleScenario()});
    await req('POST', `/api/campaigns/${cid}/approve`, {step: 'scenario'});

    // Generate 3 styles on initial variant (no preview yet -> updates v1 in place)
    const st1 = await req('POST', `/api/campaigns/${cid}/styles`, {});
    assert.equal(st1.status, 200);
    assert.equal(st1.body.campaign.variants.length, 1);
    assert.equal(st1.body.campaign.activeVariant, v1Id);

    // Choosing style when v1 has NO preview yet mutates v1 in place
    const ch0 = await req('POST', `/api/campaigns/${cid}/styles/choose`, {index: 0});
    assert.equal(ch0.status, 200);
    assert.equal(ch0.body.variants.length, 1);
    assert.equal(ch0.body.variants[0].styles.chosenIndex, 0);
    assert.equal(ch0.body.variants[0].label, 'Editorial Split Card');

    const ch1 = await req('POST', `/api/campaigns/${cid}/styles/choose`, {index: 1});
    assert.equal(ch1.status, 200);
    assert.equal(ch1.body.variants.length, 1);
    assert.equal(ch1.body.variants[0].styles.chosenIndex, 1);
    assert.equal(ch1.body.variants[0].label, 'Circular Photo Cutout');

    // Build & approve preview on v1
    const prev1 = await req('POST', `/api/campaigns/${cid}/preview`, {});
    assert.equal(prev1.status, 200);
    const v1PreviewEntryId = prev1.body.historyId;
    await req('POST', `/api/campaigns/${cid}/approve`, {step: 'preview'});

    // Build final on v1
    const fin1 = await req('POST', `/api/campaigns/${cid}/final`, {media: {images: false, video: false}});
    assert.equal(fin1.status, 200);
    const v1FinalEntryId = fin1.body.historyId;

    // Rule: A variant that has a preview is NEVER mutated by a style choice!
    // Picking another direction (index 2) via /styles/choose creates a NEW variant v2 sharing styles.entryId
    const ch2NewVar = await req('POST', `/api/campaigns/${cid}/styles/choose`, {index: 2});
    assert.equal(ch2NewVar.status, 200);
    assert.equal(ch2NewVar.body.variants.length, 2);
    let v2Id = ch2NewVar.body.activeVariant;
    assert.notEqual(v2Id, v1Id);

    // Verify v1 is completely untouched
    const v1After = ch2NewVar.body.variants.find(v => v.id === v1Id);
    assert.equal(v1After.styles.chosenIndex, 1);
    assert.equal(v1After.previewId, v1PreviewEntryId);
    assert.equal(v1After.finalId, v1FinalEntryId);
    assert.equal(v1After.previewApproved, true);

    // Verify v2 shares styles.entryId with chosenIndex 2 and has no preview/final yet
    const v2 = ch2NewVar.body.variants.find(v => v.id === v2Id);
    assert.equal(v2.styles.entryId, v1After.styles.entryId);
    assert.equal(v2.styles.chosenIndex, 2);
    assert.equal(v2.label, 'Tactile Paper Receipt');
    assert.equal(v2.previewId, null);
    assert.equal(v2.finalId, null);

    // Looking at directions does not pile up styles: the draft slot is reused...
    const look0 = await req('POST', `/api/campaigns/${cid}/styles/choose`, {index: 0});
    assert.equal(look0.body.variants.length, 2);
    assert.equal(look0.body.activeVariant, v2Id);
    assert.equal(look0.body.variants.find(v => v.id === v2Id).styles.chosenIndex, 0);
    // ...picking the direction that already has a preview reopens that style and drops the draft...
    const back1 = await req('POST', `/api/campaigns/${cid}/styles/choose`, {index: 1});
    assert.equal(back1.body.activeVariant, v1Id);
    assert.equal(back1.body.variants.length, 1);
    assert.equal(back1.body.variants[0].previewId, v1PreviewEntryId);
    // ...and a new look from the built style starts one draft again.
    const again2 = await req('POST', `/api/campaigns/${cid}/styles/choose`, {index: 2});
    assert.equal(again2.body.variants.length, 2);
    v2Id = again2.body.activeVariant;
    assert.notEqual(v2Id, v1Id);

    // Per-variant gating: v2 cannot build final before v2 has an approved preview (even though v1 is approved!)
    const fin2Blocked = await req('POST', `/api/campaigns/${cid}/final`, {});
    assert.equal(fin2Blocked.status, 409);

    // Build preview on v2
    const prev2 = await req('POST', `/api/campaigns/${cid}/preview`, {});
    assert.equal(prev2.status, 200);
    const v2PreviewEntryId = prev2.body.historyId;

    // Rule: Calling /styles when active variant (v2) already has a preview creates a NEW variant v3!
    const st3 = await req('POST', `/api/campaigns/${cid}/styles`, {});
    assert.equal(st3.status, 200);
    assert.equal(st3.body.campaign.variants.length, 3);
    const v3Id = st3.body.campaign.activeVariant;
    assert.notEqual(v3Id, v2Id);
    const v2Untouched = st3.body.campaign.variants.find(v => v.id === v2Id);
    assert.equal(v2Untouched.previewId, v2PreviewEntryId);

    // Per-variant gating: v3 has no chosenIndex yet -> preview blocked with 409
    const prev3Blocked = await req('POST', `/api/campaigns/${cid}/preview`, {});
    assert.equal(prev3Blocked.status, 409);

    // Explicit POST /api/campaigns/:id/variants endpoint
    const explicitVar = await req('POST', `/api/campaigns/${cid}/variants`, {
      stylesEntryId: v1After.styles.entryId,
      index: 0,
      label: 'Custom Style Label',
    });
    assert.equal(explicitVar.status, 201);
    assert.equal(explicitVar.body.variants.length, 4);
    const v4Id = explicitVar.body.activeVariant;
    assert.equal(explicitVar.body.steps.styles.chosenIndex, 0);

    // Rename variant via PATCH /api/campaigns/:id/variants/:vid
    const renamed = await req('PATCH', `/api/campaigns/${cid}/variants/${v4Id}`, {label: 'Переименованный стиль'});
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.variants.find(v => v.id === v4Id).label, 'Переименованный стиль');

    // Switch activeVariant via PATCH /api/campaigns/:id {activeVariant}
    const switched = await req('PATCH', `/api/campaigns/${cid}`, {activeVariant: v1Id});
    assert.equal(switched.status, 200);
    assert.equal(switched.body.activeVariant, v1Id);
    assert.equal(switched.body.entries.preview.id, v1PreviewEntryId);
    assert.equal(switched.body.entries.final.id, v1FinalEntryId);

    // Scenario edit marks EVERY variant's preview and final stale
    const editedSc = sampleScenario();
    editedSc.theme = 'Updated theme after variants';
    const scEditRes = await req('PUT', `/api/campaigns/${cid}/scenario`, {scenario: editedSc});
    assert.equal(scEditRes.status, 200);
    const afterScEdit = scEditRes.body.campaign;
    const v1Stale = afterScEdit.variants.find(v => v.id === v1Id);
    const v2Stale = afterScEdit.variants.find(v => v.id === v2Id);
    assert.equal(v1Stale.previewStale, true);
    assert.equal(v1Stale.finalStale, true);
    assert.equal(v2Stale.previewStale, true);
  });

  it('archives a campaign out of the list and restores it', async () => {
    const created = await req('POST', '/api/campaigns', {project: projectId, setup: {kind: 'poster', languages: ['en'], formats: ['1x1'], provider: {mode: 'demo'}}, name: 'To archive'});
    assert.equal(created.status, 201);
    const id = created.body.id;
    const ids = async q => (await req('GET', '/api/campaigns?limit=200' + q)).body.items.map(c => c.id);
    assert.ok((await ids('')).includes(id));
    const arch = await req('POST', `/api/campaigns/${id}/archive`, {archived: true});
    assert.equal(arch.status, 200);
    assert.ok(!(await ids('')).includes(id));
    assert.ok((await ids('&archived=1')).includes(id));
    await req('POST', `/api/campaigns/${id}/archive`, {archived: false});
    assert.ok((await ids('')).includes(id));
    assert.ok(!(await ids('&archived=1')).includes(id));
  });
});
