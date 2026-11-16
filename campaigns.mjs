import {materializeBrand} from './brands.mjs';
// Campaign state, invalidation (§2.5), concurrency gating (§6.2), cost roll-up and HTTP routes (§6).
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import * as history from './history.mjs';
import {store, authorStorage, currentAuthor} from './store/index.mjs';
import {createJob, getJob, logger, finishJob, snapshot, draftHTML, streamedSketches, setJobRunSink} from './jobs.mjs';
import {formats, pickFormats, inject, uninject} from './motion.mjs';
import {LANGUAGES} from './shared/languages.mjs';
import {windowNeed} from './shared/reading.mjs';
import {parseScenario, validateScenario, missingLanguages, missingCuts} from './scenario.mjs';
import {
  scenarioPrompt, scenarioMessage, scenarioRepairMessage,
  translatePrompt, translateMessage,
  stylesPrompt, stylesMessage, parseStyleChoices,
  previewPrompt, previewMessage,
  finalPrompt, finalMessage,
  stageRevisionPrompt, revisionMessage, output as checkHTML,
  extractCopyPatch, validateCopyPatch, mergeCopyPatches, applyCopyPatch,
} from './creative.mjs';
import {settings} from './models.mjs';
import {mediaKey} from './media.mjs';

const validId = id => /^[0-9a-f-]{36}$/.test(String(id || ''));
const knownLangCodes = new Set(LANGUAGES.map(l => l.code));
export const conflict = (msg, status = 409) => Object.assign(Error(msg), {status});

// Active running job per campaign: Map<campaignId, requestId>
export const runningJob = new Map();

export function acquireJob(campaignId, requestId) {
  if (runningJob.has(campaignId)) {
    throw conflict('Wait for the current step to finish.', 409);
  }
  runningJob.set(campaignId, requestId);
}

export function releaseJob(campaignId, requestId) {
  if (!requestId || runningJob.get(campaignId) === requestId) {
    runningJob.delete(campaignId);
  }
}

export function emptyCost() {
  return {llm: 0, image: 0, video: 0, total: 0, unknown: false};
}

export function addCost(base = emptyCost(), delta = {}) {
  return {
    llm: Number(((base.llm || 0) + (delta.llm || 0)).toFixed(6)),
    image: Number(((base.image || 0) + (delta.image || 0)).toFixed(6)),
    video: Number(((base.video || 0) + (delta.video || 0)).toFixed(6)),
    total: Number(((base.total || 0) + (delta.total || 0)).toFixed(6)),
    unknown: Boolean(base.unknown || delta.unknown),
  };
}

export function validateSetup(raw = {}) {
  if (!raw || typeof raw !== 'object') {
    throw conflict('Invalid campaign settings.');
  }
  const kind = raw.kind;
  if (!['poster', 'single', 'multi'].includes(kind)) {
    throw conflict('Choose a poster, single-scene video or multi-scene video.');
  }

  const rawLangs = Array.isArray(raw.languages) ? raw.languages : [];
  const languages = [...new Set(rawLangs.map(l => (typeof l === 'string' ? l.trim() : l?.code)).filter(Boolean))];
  if (!languages.length || !languages.every(code => knownLangCodes.has(code) || /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(code))) {
    throw conflict('Select at least one campaign language.');
  }

  let lengths = [];
  if (kind !== 'poster') {
    const rawLengths = Array.isArray(raw.lengths) ? raw.lengths : [];
    lengths = [...new Set(rawLengths.map(Number))];
    const minLen = kind === 'multi' ? 4 : 2;
    if (!lengths.length || !lengths.every(n => Number.isFinite(n) && n >= minLen && n <= 60)) {
      throw conflict(
        kind === 'multi'
          ? 'Choose lengths between 4 and 60 seconds for a multi-scene video.'
          : 'Choose lengths between 2 and 60 seconds for a single-scene video.'
      );
    }
  }

  const rawFormats = Array.isArray(raw.formats) ? raw.formats : [];
  const fmtIds = [...new Set(rawFormats.map(f => (typeof f === 'string' ? f : f?.id)).filter(Boolean))];
  if (!fmtIds.length || !fmtIds.every(id => Object.hasOwn(formats, id))) {
    throw conflict('Select at least one format from the list.');
  }

  const prov = raw.provider || {};
  const mode = prov.mode || 'demo';
  if (!['demo', 'claude', 'codex'].includes(mode)) {
    throw conflict('Choose a generation mode: demo, claude or codex.');
  }
  const billing = prov.billing || (mode === 'claude' ? 'subscription' : 'api');
  let sel = {model: prov.model || null, effort: prov.effort || null};
  if (mode !== 'demo' && (prov.model !== undefined || prov.effort !== undefined || mode === 'codex')) {
    try {
      sel = settings(mode, prov.model, prov.effort);
    } catch (e) {
      throw conflict(e.message);
    }
  }

  const stepModels = {};
  if (raw.stepModels && typeof raw.stepModels === 'object') {
    for (const step of ['scenario', 'styles', 'preview', 'final']) {
      const ov = raw.stepModels[step];
      if (ov && typeof ov === 'object' && (ov.model || ov.effort)) {
        if (mode !== 'demo') {
          try {
            stepModels[step] = settings(mode, ov.model, ov.effort);
          } catch (e) {
            throw conflict(e.message);
          }
        } else {
          stepModels[step] = {model: ov.model || null, effort: ov.effort || null};
        }
      }
    }
  }

  return {
    kind,
    languages,
    lengths,
    formats: fmtIds,
    provider: {mode, billing, model: sel.model || null, effort: sel.effort || null},
    stepModels,
  };
}

export function stepSelection(setup, step) {
  const mode = setup.provider?.mode || 'demo';
  const billing = setup.provider?.billing || 'api';
  if (mode === 'demo') return {mode, billing, model: null, effort: null};
  const ov = setup.stepModels?.[step];
  const model = ov?.model || setup.provider?.model;
  const effort = ov?.effort || setup.provider?.effort;
  const resolved = settings(mode, model, effort);
  return {mode, billing, model: resolved.model || null, effort: resolved.effort || null};
}

export function createVariantRecord({
  id = randomUUID(),
  label = 'Style 1',
  createdAt = new Date().toISOString(),
  author = currentAuthor(),
  styles = {entryId: null, chosenIndex: null, direction: ''},
  preview = {entryId: null, approvedAt: null, stale: false},
  final = {entryId: null, stale: false},
  cost = emptyCost(),
} = {}) {
  return {
    id,
    label,
    createdAt,
    author,
    styles: {
      entryId: styles?.entryId ?? null,
      chosenIndex: styles?.chosenIndex ?? null,
      direction: styles?.direction ?? '',
    },
    preview: {
      entryId: preview?.entryId ?? null,
      approvedAt: preview?.approvedAt ?? null,
      stale: Boolean(preview?.stale),
    },
    final: {
      entryId: final?.entryId ?? null,
      stale: Boolean(final?.stale),
    },
    cost: cost ? structuredClone(cost) : emptyCost(),
  };
}

// Pure function that converts the old single-variant campaign shape into variants[] + activeVariant (§4.1).
export function upgradeCampaign(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const clone = structuredClone(doc);
  const oldSteps = clone.steps || {};
  const scenario = {
    entryId: oldSteps.scenario?.entryId ?? null,
    approvedAt: oldSteps.scenario?.approvedAt ?? null,
    stale: Boolean(oldSteps.scenario?.stale),
    needs: Array.isArray(oldSteps.scenario?.needs) ? [...oldSteps.scenario.needs] : [],
  };

  if (Array.isArray(clone.variants) && clone.variants.length > 0) {
    clone.variants = clone.variants.map((v, i) => createVariantRecord({
      id: v.id || randomUUID(),
      label: v.label || `Style ${i + 1}`,
      createdAt: v.createdAt || clone.createdAt || new Date().toISOString(),
      author: v.author ?? clone.author ?? null,
      styles: v.styles,
      preview: v.preview,
      final: v.final,
      cost: v.cost,
    }));
    if (!clone.activeVariant || !clone.variants.some(v => v.id === clone.activeVariant)) {
      clone.activeVariant = clone.variants[0].id;
    }
    const active = clone.variants.find(v => v.id === clone.activeVariant) || clone.variants[0];
    // If caller mutated doc.steps.{styles,preview,final} directly on an unhydrated record (e.g. unit tests), sync to active variant
    if (oldSteps.styles?.entryId && !active.styles.entryId) active.styles = structuredClone(oldSteps.styles);
    if (oldSteps.preview?.entryId && !active.preview.entryId) active.preview = structuredClone(oldSteps.preview);
    if (oldSteps.final?.entryId && !active.final.entryId) active.final = structuredClone(oldSteps.final);
    clone.steps = {
      scenario,
      styles: structuredClone(active.styles),
      preview: structuredClone(active.preview),
      final: structuredClone(active.final),
    };
    return clone;
  }

  const styles = oldSteps.styles || {entryId: null, chosenIndex: null, direction: ''};
  const preview = oldSteps.preview || {entryId: null, approvedAt: null, stale: false};
  const final = oldSteps.final || {entryId: null, stale: false};

  let inferredLabel = 'Style 1';
  if (typeof styles.label === 'string' && styles.label.trim()) {
    inferredLabel = styles.label.trim();
  } else if (typeof styles.direction === 'string' && styles.direction.includes('\n\n')) {
    const firstLine = styles.direction.split('\n\n')[0].trim();
    if (firstLine && firstLine.length <= 80) inferredLabel = firstLine;
  }

  const variant = createVariantRecord({
    id: clone.id || randomUUID(),
    label: inferredLabel,
    createdAt: clone.createdAt || new Date().toISOString(),
    author: clone.author ?? null,
    styles,
    preview,
    final,
    cost: clone.cost ? structuredClone(clone.cost) : emptyCost(),
  });

  clone.variants = [variant];
  clone.activeVariant = variant.id;
  clone.steps = {
    scenario,
    styles: structuredClone(variant.styles),
    preview: structuredClone(variant.preview),
    final: structuredClone(variant.final),
  };
  return clone;
}

export function syncActiveVariantSteps(stepsScenario, variants, activeVariantId) {
  const active = variants.find(v => v.id === activeVariantId) || variants[0];
  return {
    scenario: structuredClone(stepsScenario),
    styles: structuredClone(active.styles),
    preview: structuredClone(active.preview),
    final: structuredClone(active.final),
  };
}

export function createCampaignRecord({project, setup, name = '', author = currentAuthor()}) {
  const validSetup = validateSetup(setup);
  const now = new Date().toISOString();
  const initialVariant = createVariantRecord({
    label: 'Style 1',
    createdAt: now,
    author,
  });
  const scenarioStep = {entryId: null, approvedAt: null, stale: false, needs: []};
  return {
    id: randomUUID(),
    type: 'campaign',
    createdAt: now,
    updatedAt: now,
    author,
    name: String(name || '').trim() || 'New campaign',
    project,
    setup: validSetup,
    steps: syncActiveVariantSteps(scenarioStep, [initialVariant], initialVariant.id),
    variants: [initialVariant],
    activeVariant: initialVariant.id,
    cost: emptyCost(),
  };
}

function computeNeeds(scenarioObj, setup) {
  if (!scenarioObj) return [];
  const needs = [];
  if (missingLanguages(scenarioObj, setup.languages).length > 0) {
    needs.push('translation');
  }
  if (setup.kind === 'multi' && missingCuts(scenarioObj, setup.lengths).length > 0) {
    needs.push('cuts');
  }
  return needs;
}

// Applies setup/name/activeVariant changes and §2.5 / §4.2 invalidation rules across all variants.
export function applyCampaignPatch(campaign, patch = {}, currentScenario = null) {
  const up = upgradeCampaign(campaign);
  const nextName = typeof patch.name === 'string' ? (patch.name.trim() || up.name) : up.name;
  const variants = structuredClone(up.variants);
  let activeVariant = up.activeVariant;

  if (patch.activeVariant !== undefined) {
    const found = variants.find(v => v.id === patch.activeVariant);
    if (!found) throw conflict('Selected style variant not found.', 404);
    activeVariant = found.id;
  }

  const scenarioStep = structuredClone(up.steps.scenario);

  if (!patch.setup) {
    return {
      name: nextName,
      setup: up.setup,
      steps: syncActiveVariantSteps(scenarioStep, variants, activeVariant),
      variants,
      activeVariant,
    };
  }

  const prev = up.setup;
  const modeSwitching = patch.setup.provider?.mode && patch.setup.provider.mode !== prev.provider?.mode;
  const mergedProvider = patch.setup.provider
    ? {
        ...(modeSwitching ? {} : prev.provider),
        ...patch.setup.provider,
      }
    : prev.provider;
  const next = validateSetup({
    ...prev,
    ...patch.setup,
    provider: mergedProvider,
    stepModels: patch.setup.stepModels !== undefined ? patch.setup.stepModels : (modeSwitching ? {} : prev.stepModels),
  });

  const staleAllPreviews = () => {
    for (const v of variants) {
      if (v.preview?.entryId) v.preview.stale = true;
    }
  };
  const staleAllFinals = () => {
    for (const v of variants) {
      if (v.final?.entryId) v.final.stale = true;
    }
  };

  if (prev.kind !== next.kind) {
    // kind → everything stale
    if (scenarioStep.entryId) {
      scenarioStep.stale = true;
      scenarioStep.approvedAt = null;
      scenarioStep.needs = [];
    }
    staleAllPreviews();
    staleAllFinals();
    return {
      name: nextName,
      setup: next,
      steps: syncActiveVariantSteps(scenarioStep, variants, activeVariant),
      variants,
      activeVariant,
    };
  }

  // Primary language or primary format changed → preview + final stale on all variants
  if (prev.languages[0] !== next.languages[0] || prev.formats[0] !== next.formats[0]) {
    staleAllPreviews();
    staleAllFinals();
  }

  // Languages changed → scenario needs translation; final stale on all variants
  const langsChanged = prev.languages.join(',') !== next.languages.join(',');
  if (langsChanged) {
    staleAllFinals();
  }

  // Lengths changed → scenario needs cuts; final stale on all variants
  const lengthsChanged = prev.lengths.join(',') !== next.lengths.join(',');
  if (lengthsChanged) {
    staleAllFinals();
  }

  // Other formats changed → final stale on all variants
  const formatsChanged = prev.formats.join(',') !== next.formats.join(',');
  if (formatsChanged) {
    staleAllFinals();
  }

  if (scenarioStep.entryId) {
    const needsSet = new Set(scenarioStep.needs || []);
    if (currentScenario) {
      if (missingLanguages(currentScenario, next.languages).length > 0) needsSet.add('translation');
      else needsSet.delete('translation');

      if (next.kind === 'multi' && missingCuts(currentScenario, next.lengths).length > 0) needsSet.add('cuts');
      else needsSet.delete('cuts');
    } else {
      if (next.languages.some(l => !prev.languages.includes(l))) needsSet.add('translation');
      if (next.kind === 'multi' && next.lengths.some(l => !prev.lengths.includes(l))) needsSet.add('cuts');
    }
    scenarioStep.needs = [...needsSet];
  }

  return {
    name: nextName,
    setup: next,
    steps: syncActiveVariantSteps(scenarioStep, variants, activeVariant),
    variants,
    activeVariant,
  };
}

const lightEntry = entry => {
  if (!entry) return null;
  const {log, ...rest} = entry;
  return {...rest, logSize: entry.logSize ?? log?.length ?? 0};
};

export async function hydrateCampaign(rawCampaign) {
  if (!rawCampaign) return null;
  const campaign = upgradeCampaign(rawCampaign);
  const entryIds = new Set();
  if (campaign.steps?.scenario?.entryId) entryIds.add(campaign.steps.scenario.entryId);
  for (const v of campaign.variants) {
    if (v.styles?.entryId) entryIds.add(v.styles.entryId);
    if (v.preview?.entryId) entryIds.add(v.preview.entryId);
    if (v.final?.entryId) entryIds.add(v.final.entryId);
  }

  const entryMap = new Map();
  await Promise.all(
    [...entryIds].map(async id => {
      const e = await history.get(id);
      if (e) entryMap.set(id, e);
    })
  );

  const scenario = campaign.steps?.scenario?.entryId ? entryMap.get(campaign.steps.scenario.entryId) || null : null;
  const hydratedVariants = campaign.variants.map((v, idx) => {
    const stEntry = v.styles?.entryId ? entryMap.get(v.styles.entryId) || null : null;
    const prevEntry = v.preview?.entryId ? entryMap.get(v.preview.entryId) || null : null;
    const finEntry = v.final?.entryId ? entryMap.get(v.final.entryId) || null : null;
    const chosenIdx = v.styles?.chosenIndex;
    const chosenStyle = (chosenIdx !== null && chosenIdx !== undefined)
      ? stEntry?.output?.styles?.[chosenIdx] || null
      : null;
    const defaultLabel = `Style ${idx + 1}`;
    const label = (v.label && v.label !== defaultLabel && v.label !== 'Style 1')
      ? v.label
      : (chosenStyle?.name || v.label || defaultLabel);

    const previewApproved = Boolean(v.preview?.approvedAt && !v.preview?.stale);
    const previewStale = Boolean(v.preview?.stale);
    const finalStale = Boolean(v.final?.stale);

    return {
      id: v.id,
      label,
      createdAt: v.createdAt,
      author: v.author || null,
      styles: structuredClone(v.styles),
      preview: {
        ...v.preview,
        path: prevEntry?.output?.path || null,
        format: prevEntry?.output?.format || null,
        lang: prevEntry?.output?.lang || null,
      },
      final: {
        ...v.final,
        path: finEntry?.output?.path || null,
        formats: finEntry?.output?.formats || [],
        langs: finEntry?.output?.langs || [],
        lengths: finEntry?.output?.lengths || [],
      },
      style: chosenStyle
        ? {name: chosenStyle.name || '', idea: chosenStyle.idea || '', svg: chosenStyle.svg || ''}
        : null,
      styleName: chosenStyle?.name || '',
      styleIdea: chosenStyle?.idea || '',
      styleSvg: chosenStyle?.svg || '',
      previewId: v.preview?.entryId || null,
      previewPath: prevEntry?.output?.path || null,
      finalId: v.final?.entryId || null,
      finalPath: finEntry?.output?.path || null,
      approved: Boolean((finEntry?.output?.path && !finalStale) || previewApproved),
      stale: Boolean(previewStale || finalStale),
      previewApproved,
      previewStale,
      finalStale,
      cost: v.cost || emptyCost(),
    };
  });

  const activeVar = hydratedVariants.find(v => v.id === campaign.activeVariant) || hydratedVariants[0];
  const activeStylesEntry = activeVar?.styles?.entryId ? entryMap.get(activeVar.styles.entryId) || null : null;
  const activePreviewEntry = activeVar?.preview?.entryId ? entryMap.get(activeVar.preview.entryId) || null : null;
  const activeFinalEntry = activeVar?.final?.entryId ? entryMap.get(activeVar.final.entryId) || null : null;

  const {log, ...clean} = campaign;
  return {
    ...clean,
    steps: {
      scenario: structuredClone(campaign.steps.scenario),
      styles: structuredClone(activeVar.styles),
      preview: {
        entryId: activeVar.preview.entryId,
        approvedAt: activeVar.preview.approvedAt,
        stale: activeVar.preview.stale,
      },
      final: {
        entryId: activeVar.final.entryId,
        stale: activeVar.final.stale,
      },
    },
    variants: hydratedVariants,
    activeVariant: activeVar.id,
    runningRequestId: runningJob.get(campaign.id) || null,
    entries: {
      scenario: lightEntry(scenario),
      styles: lightEntry(activeStylesEntry),
      preview: lightEntry(activePreviewEntry),
      final: lightEntry(activeFinalEntry),
    },
  };
}

// Resolves the effective scenario for a preview or final entry (applying input.copyPatch if any).
export async function resolveEntryScenario(entry, campaign) {
  const scenarioId = entry?.input?.scenarioId || campaign?.steps?.scenario?.entryId;
  if (!scenarioId) return null;
  const scEntry = await history.get(scenarioId);
  const baseScenario = scEntry?.output?.scenario || null;
  if (!baseScenario) return null;
  return entry?.input?.copyPatch ? applyCopyPatch(baseScenario, entry.input.copyPatch) : baseScenario;
}

// Re-injects a preview or final HTML document with updated scenario/copyPatch.
export function injectForEntry(sourceHtml, {stage, setup, scenario, libs = ''}) {
  if (stage === 'preview') {
    const primaryFmt = pickFormats([setup.formats[0]]);
    return inject(sourceHtml, {
      stage: 'preview',
      kind: setup.kind,
      formats: primaryFmt,
      langs: [setup.languages[0]],
      lengths: [],
      scenario,
      libs,
    });
  }
  const fmtList = pickFormats(setup.formats);
  return inject(sourceHtml, {
    stage: 'final',
    kind: setup.kind,
    formats: fmtList,
    langs: setup.languages,
    lengths: setup.kind === 'poster' ? [] : setup.lengths,
    scenario,
    libs,
  });
}

// Demo fixture loader and adapter (§6.5).
const wait = (ms, signal) => new Promise((ok, no) => {
  const t = setTimeout(ok, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); no(signal.reason ?? Error('aborted')); }, {once: true});
});

export async function loadDemoScenario(rootDir, setup, currentScenario = null) {
  const file = path.join(rootDir, 'fixtures', `scenario-${setup.kind}.json`);
  const fixture = JSON.parse(await fs.readFile(file, 'utf8'));
  const base = currentScenario ? structuredClone(currentScenario) : fixture;
  base.version = 2;
  base.kind = setup.kind;
  base.languages = [...setup.languages];

  const primary = setup.languages[0];
  for (const line of Object.values(base.lines || {})) {
    const srcText = line.text?.[primary] || line.text?.en || Object.values(line.text || {})[0] || 'Sample copy';
    const nextText = {};
    for (const lang of setup.languages) {
      if (line.text?.[lang]) {
        nextText[lang] = line.text[lang];
      } else if (lang === primary) {
        nextText[lang] = srcText;
      } else {
        // Prefix with [xx] while staying compact for reading-time budgets
        const words = srcText.split(/\s+/);
        const core = words.slice(0, Math.max(1, words.length - 1)).join(' ');
        nextText[lang] = `[${lang}] ${core}`.slice(0, line.maxChars);
      }
    }
    line.text = nextText;
  }

  if (setup.kind === 'multi') {
    base.cuts = buildProportionalCuts(base, setup.lengths, setup.languages);
  } else {
    delete base.cuts;
  }
  return base;
}

export function buildProportionalCuts(scenario, lengths = [], languages = scenario.languages || ['en']) {
  const scenes = scenario.scenes || [];
  if (!scenes.length) return {};
  const firstScene = scenes[0];
  const lastScene = scenes[scenes.length - 1];
  const midScenes = scenes.slice(1, -1);
  const cuts = {};

  const minNeedForLines = (lineKeys, closing) => {
    let max = 0.6;
    for (const lang of languages) {
      const texts = lineKeys.map(k => scenario.lines?.[k]?.text?.[lang] || '');
      const n = windowNeed(texts, lang, {closing});
      if (n > max) max = n;
    }
    return max;
  };

  for (const rawLen of lengths) {
    const L = Number(rawLen);
    let chosenScenes;
    if (L <= 5 || scenes.length <= 2) {
      const hLines = firstScene.lines.slice(0, 1);
      const ctaLines = lastScene.lines.filter(k => scenario.lines?.[k]?.role === 'cta');
      const offerLines = lastScene.lines.filter(k => scenario.lines?.[k]?.role === 'offer');
      let closeLines = [...offerLines.slice(0, 1), ...(ctaLines.length ? ctaLines : lastScene.lines.slice(-1))];
      if (minNeedForLines(hLines, false) + minNeedForLines(closeLines, true) > L - 0.1 && ctaLines.length) {
        closeLines = ctaLines;
      }
      chosenScenes = [
        {id: firstScene.id, lines: hLines},
        {id: lastScene.id, lines: closeLines},
      ];
    } else if (L <= 8) {
      const mid = midScenes[0];
      chosenScenes = [
        {id: firstScene.id, lines: firstScene.lines.slice(0, 1)},
        ...(mid ? [{id: mid.id, lines: mid.lines.slice(0, 1)}] : []),
        {id: lastScene.id, lines: lastScene.lines},
      ];
    } else {
      chosenScenes = scenes.map(s => ({id: s.id, lines: [...s.lines]}));
    }

    // Drop optional lines if total need exceeds L
    let needs = chosenScenes.map((s, idx) => minNeedForLines(s.lines, idx === chosenScenes.length - 1));
    let sumNeed = needs.reduce((a, b) => a + b, 0);
    if (sumNeed > L && chosenScenes.length > 2) {
      // Drop middle scenes until it fits
      while (chosenScenes.length > 2 && sumNeed > L) {
        chosenScenes.splice(1, 1);
        needs = chosenScenes.map((s, idx) => minNeedForLines(s.lines, idx === chosenScenes.length - 1));
        sumNeed = needs.reduce((a, b) => a + b, 0);
      }
    }
    if (sumNeed > L) {
      // Trim non-CTA lines in closing scene if still tight
      const last = chosenScenes[chosenScenes.length - 1];
      const ctaOnly = last.lines.filter(k => scenario.lines?.[k]?.role === 'cta');
      if (ctaOnly.length) {
        last.lines = ctaOnly;
        needs = chosenScenes.map((s, idx) => minNeedForLines(s.lines, idx === chosenScenes.length - 1));
        sumNeed = needs.reduce((a, b) => a + b, 0);
      }
    }

    const extra = Math.max(0, L - sumNeed);
    let cursor = 0;
    const windows = chosenScenes.map((s, idx) => {
      const start = idx === 0 ? 0 : cursor;
      const share = sumNeed > 0 ? needs[idx] / sumNeed : 1 / chosenScenes.length;
      const minEnd = Math.ceil((start + needs[idx]) * 100) / 100;
      const propEnd = Math.round((start + needs[idx] + extra * share) * 10) / 10;
      const end = idx === chosenScenes.length - 1 ? L : Math.min(L - 0.5, Math.max(minEnd, propEnd));
      cursor = end;
      return {id: s.id, start, end, lines: s.lines};
    });

    cuts[String(L)] = {
      scenes: windows,
      note: L <= 5 ? 'Short cut: hook → offer/CTA.' : L <= 8 ? 'Medium cut: 3 scenes.' : 'Full story.',
    };
  }
  return cuts;
}

export function registerCampaignRoutes(app, {
  root,
  dataDir,
  previewURL,
  libs,
  folder,
  assetName,
  checkProvider,
  listAssets,
  generatedMedia,
  costLine,
  assetURL,
  runModelText,
  runModelHtml,
  runModelRevise,
}) {
  setJobRunSink(store.runs);

  // Propagate author from x-forma-author header or FORMA_AUTHOR env across async execution
  app.use((req, _res, next) => {
    const existing = authorStorage.getStore();
    if (existing) return next();
    const author = req.headers?.['x-forma-author'] || process.env.FORMA_AUTHOR || null;
    authorStorage.run(author, next);
  });

  app.get('/api/runs/active', async (_req, res) => {
    const raw = await store.runs.active();
    const runs = await Promise.all(raw.map(async r => {
      const c = r.campaignId ? await history.get(r.campaignId).catch(() => null) : null;
      return {...r, campaignName: c?.name || null};
    }));
    res.set('Cache-Control', 'no-store').json({runs});
  });

  app.get('/api/render-progress/:requestId', async (req, res) => {
    const since = Number(req.query.since) || 0;
    const job = getJob(req.params.requestId);
    const data = job ? snapshot(job, since) : await store.runs.get(req.params.requestId, since);
    res.set('Cache-Control', 'no-store').json(data);
  });

  async function requireCampaign(id) {
    const c = await history.get(id);
    if (!c || c.type !== 'campaign') throw conflict('Campaign not found.', 404);
    return upgradeCampaign(c);
  }

  async function ensureIdle(campaignId) {
    const activeList = await store.runs.active();
    const activeOnCamp = activeList.find(r => r.campaignId === campaignId);
    if (activeOnCamp) {
      const who = activeOnCamp.author ? ` (started by ${activeOnCamp.author})` : '';
      throw conflict(`Wait for the current step to finish${who}.`, 409);
    }
    if (runningJob.has(campaignId)) {
      throw conflict('Wait for the current step to finish.', 409);
    }
  }

  async function startCampaignRun(campaign, requestId, task) {
    await store.runs.start({
      id: requestId,
      campaignId: campaign.id,
      projectId: campaign.project,
      task,
      author: currentAuthor(),
    });
    if (runningJob.has(campaign.id) && runningJob.get(campaign.id) !== requestId) {
      await store.runs.finish(requestId, {status: 'error'}).catch(() => {});
      throw conflict('Wait for the current step to finish.', 409);
    }
    runningJob.set(campaign.id, requestId);
  }

  async function finishCampaignRun(campaignId, requestId, job, {status = 'done', entryId = null} = {}) {
    releaseJob(campaignId, requestId);
    finishJob(job, {status, entryId});
    await store.runs.finish(requestId, {
      status,
      statusText: job?.status || '',
      costs: job?.costs,
      entryId,
      log: job?.events,
    }).catch(() => {});
  }

  function findTargetVariant(variants, requestedVariantId, activeVariantId) {
    const targetId = requestedVariantId || activeVariantId;
    const found = variants.find(v => v.id === targetId);
    if (requestedVariantId && !found) {
      throw conflict('Selected style variant not found.', 404);
    }
    return found || variants[0];
  }

  function findVariantForEntry(variants, entry, activeVariantId) {
    if (entry?.input?.variantId) {
      const byInput = variants.find(v => v.id === entry.input.variantId);
      if (byInput) return byInput;
    }
    const byEntryId = variants.find(
      v => v.preview?.entryId === entry?.id || v.final?.entryId === entry?.id
    );
    if (byEntryId) return byEntryId;
    return variants.find(v => v.id === activeVariantId) || variants[0];
  }

  // POST /api/campaigns {project, setup, name?}
  app.post('/api/campaigns', async (req, res) => {
    const {brandId, brandVersion, setup, name} = req.body || {};
    const project = brandId ? randomUUID() : req.body?.project;
    if (!project || !validId(project)) throw conflict('Specify a valid project folder.', 409);
    const dir = folder(project);
    await fs.mkdir(path.join(dir, 'assets'), {recursive: true});
    await store.registerProject(project);
    const rec = createCampaignRecord({project, setup, name});
    if (brandId) {
      await materializeBrand(brandId, brandVersion, project, dir);
      Object.assign(rec, {brandId, brandVersion});
    }
    const saved = await history.record(rec);
    res.status(201).json(await hydrateCampaign(saved));
  });

  // GET /api/campaigns?limit&before
  app.get('/api/campaigns', async (req, res) => {
    const {before, limit, author, excludeAuthor} = req.query;
    const page = await history.list({type: 'campaign', before, limit, author, excludeAuthor});
    // Campaigns merged into another one by scripts/migrate-to-cloud.mjs --merge-style-forks live on as its variants.
    const items = await Promise.all(page.items.filter(c => c.status !== 'merged').map(async raw => {
      const hydrated = await hydrateCampaign(raw);
      const scEntry = hydrated.entries?.scenario;
      let stEntry = hydrated.entries?.styles;
      let prevEntry = hydrated.entries?.preview;
      let finEntry = hydrated.entries?.final;
      let chosenIdx = hydrated.steps?.styles?.chosenIndex ?? null;

      if (!stEntry) {
        const vWithSt = [...(hydrated.variants || [])].reverse().find(v => v.styles?.entryId);
        if (vWithSt) {
          stEntry = await history.get(vWithSt.styles.entryId);
          chosenIdx = vWithSt.styles?.chosenIndex ?? null;
        }
      }
      if (!prevEntry) {
        const vWithPrev = [...(hydrated.variants || [])].reverse().find(v => v.preview?.entryId);
        if (vWithPrev) prevEntry = await history.get(vWithPrev.preview.entryId);
      }
      if (!finEntry) {
        const vWithFin = [...(hydrated.variants || [])].reverse().find(v => v.final?.entryId);
        if (vWithFin) finEntry = await history.get(vWithFin.final.entryId);
      }

      const thumbEntry = finEntry || prevEntry || null;
      const stylesList = (stEntry?.output?.styles || []).map(s => ({name: s.name, idea: s.idea, svg: s.svg}));
      return {
        ...hydrated,
        runningRequestId: runningJob.get(hydrated.id) || null,
        thumbnailPath: thumbEntry?.output?.path || null,
        thumbnailFormat: thumbEntry?.output?.format || thumbEntry?.output?.formats?.[0] || hydrated.setup?.formats?.[0] || '1x1',
        pipeline: {
          scenario: scEntry ? {id: scEntry.id, theme: scEntry.output?.scenario?.theme || '', idea: scEntry.output?.scenario?.idea || '', logSize: scEntry.logSize ?? scEntry.log?.length ?? 0} : null,
          styles: stEntry ? {id: stEntry.id, styles: stylesList, chosenIndex: chosenIdx, logSize: stEntry.logSize ?? stEntry.log?.length ?? 0} : null,
          preview: prevEntry ? {id: prevEntry.id, path: prevEntry.output?.path || null, format: prevEntry.output?.format || null, logSize: prevEntry.logSize ?? prevEntry.log?.length ?? 0} : null,
          final: finEntry ? {id: finEntry.id, path: finEntry.output?.path || null, formats: finEntry.output?.formats || [], logSize: finEntry.logSize ?? finEntry.log?.length ?? 0} : null,
        },
      };
    }));
    res.set('Cache-Control', 'no-store').json({items, next: page.next, total: page.total});
  });

  // POST /api/campaigns/:id/fork {styleIndex?, name?} — clones a campaign ("Копия кампании", §4.2)
  app.post('/api/campaigns/:id/fork', async (req, res) => {
    const src = await requireCampaign(req.params.id);
    const now = new Date().toISOString();
    const rec = createCampaignRecord({
      project: src.project,
      setup: src.setup,
      name: (typeof req.body?.name === 'string' && req.body.name.trim()) ? req.body.name.trim() : `${src.name} (copy)`,
    });
    if (src.brandId) Object.assign(rec, {brandId:src.brandId, brandVersion:src.brandVersion});
    if (src.steps?.scenario?.entryId) {
      rec.steps.scenario = structuredClone(src.steps.scenario);
    }
    const activeSrcVar = findTargetVariant(src.variants, null, src.activeVariant);
    const v0 = rec.variants[0];
    if (activeSrcVar?.styles?.entryId) {
      v0.styles = structuredClone(activeSrcVar.styles);
      if (typeof req.body?.styleIndex === 'number' && [0, 1, 2].includes(req.body.styleIndex)) {
        const stEntry = await history.get(activeSrcVar.styles.entryId);
        const chosen = stEntry?.output?.styles?.[req.body.styleIndex];
        if (chosen) {
          v0.styles.chosenIndex = req.body.styleIndex;
          v0.styles.direction = [chosen.name, chosen.idea, chosen.direction].filter(Boolean).join('\n\n');
          v0.label = chosen.name || v0.label;
        }
      }
    }
    rec.steps = syncActiveVariantSteps(rec.steps.scenario, rec.variants, rec.activeVariant);
    rec.updatedAt = now;
    const saved = await history.record(rec);
    res.status(201).json(await hydrateCampaign(saved));
  });

  // POST /api/campaigns/:id/variants {stylesEntryId?, index?, direction?, label?} (§4.2)
  app.post('/api/campaigns/:id/variants', async (req, res) => {
    const campaign = await requireCampaign(req.params.id);
    await ensureIdle(campaign.id);
    if (!campaign.steps.scenario.approvedAt || campaign.steps.scenario.stale || campaign.steps.scenario.needs?.length) {
      throw conflict('Approve the script first.', 409);
    }

    const variants = structuredClone(campaign.variants);
    const activeVar = findTargetVariant(variants, null, campaign.activeVariant);
    const stylesEntryId = req.body?.stylesEntryId || activeVar?.styles?.entryId || null;

    let chosenIndex = null;
    let directionText = typeof req.body?.direction === 'string' ? req.body.direction.trim() : '';
    let styleName = '';

    if (req.body?.index !== undefined && req.body?.index !== null) {
      if (!stylesEntryId) {
        throw conflict('Generate three visual directions first.', 409);
      }
      const stEntry = await history.get(stylesEntryId);
      const styles = stEntry?.output?.styles;
      const idx = Number(req.body.index);
      if (!Array.isArray(styles) || ![0, 1, 2].includes(idx) || !styles[idx]) {
        throw conflict('Select one of the three directions (0, 1 or 2).', 409);
      }
      chosenIndex = idx;
      const chosen = styles[idx];
      styleName = chosen.name || '';
      if (!directionText) {
        directionText = [chosen.name, chosen.idea, chosen.direction].filter(Boolean).join('\n\n');
      }
    }

    const rawLabel = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    const newVar = createVariantRecord({
      label: rawLabel || styleName || `Style ${variants.length + 1}`,
      createdAt: new Date().toISOString(),
      author: currentAuthor(),
      styles: {
        entryId: stylesEntryId,
        chosenIndex,
        direction: directionText,
      },
    });
    variants.push(newVar);
    const activeVariant = newVar.id;
    const steps = syncActiveVariantSteps(campaign.steps.scenario, variants, activeVariant);
    const updated = await history.update(campaign.id, {steps, variants, activeVariant});
    res.status(201).json(await hydrateCampaign(updated));
  });

  // PATCH /api/campaigns/:id/variants/:vid {label} (§4.2)
  app.patch('/api/campaigns/:id/variants/:vid', async (req, res) => {
    const campaign = await requireCampaign(req.params.id);
    const variants = structuredClone(campaign.variants);
    const target = variants.find(v => v.id === req.params.vid);
    if (!target) throw conflict('Style variant not found.', 404);
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    if (!label) throw conflict('Enter a style name.', 400);
    target.label = label;
    const updated = await history.update(campaign.id, {variants});
    res.json(await hydrateCampaign(updated));
  });

  // GET /api/campaigns/:id
  app.get('/api/campaigns/:id', async (req, res) => {
    const campaign = await requireCampaign(req.params.id);
    res.set('Cache-Control', 'no-store').json(await hydrateCampaign(campaign));
  });

  // PATCH /api/campaigns/:id {name?, setup?, activeVariant?}
  app.patch('/api/campaigns/:id', async (req, res) => {
    const campaign = await requireCampaign(req.params.id);
    await ensureIdle(campaign.id);
    const scEntry = campaign.steps?.scenario?.entryId ? await history.get(campaign.steps.scenario.entryId) : null;
    const currentScenario = scEntry?.output?.scenario || null;
    const patched = applyCampaignPatch(campaign, req.body || {}, currentScenario);
    const updated = await history.update(campaign.id, patched);
    res.json(await hydrateCampaign(updated));
  });

  // PUT /api/campaigns/:id/scenario {scenario} — manual edit
  app.put('/api/campaigns/:id/scenario', async (req, res) => {
    const campaign = await requireCampaign(req.params.id);
    await ensureIdle(campaign.id);
    const rawScenario = req.body?.scenario;
    if (!rawScenario) throw conflict('Provide a script object.', 400);
    let parsed;
    try {
      parsed = typeof rawScenario === 'string' ? parseScenario(rawScenario) : parseScenario(JSON.stringify(rawScenario));
    } catch (e) {
      throw conflict(e.message, 400);
    }
    const validation = validateScenario(parsed, campaign.setup);
    const needs = computeNeeds(parsed, campaign.setup);
    const prevScenarioId = campaign.steps.scenario.entryId;
    const wasApproved = Boolean(campaign.steps.scenario.approvedAt);

    const entry = await history.record({
      type: 'scenario',
      campaign: campaign.id,
      stage: 'scenario',
      kind: campaign.setup.kind,
      project: campaign.project,
      mode: 'manual',
      model: null,
      effort: null,
      input: {editedFrom: prevScenarioId || null, setup: campaign.setup},
      output: {scenario: parsed, validation},
      cost: emptyCost(),
      log: [{i: 0, at: 0, level: 'done', msg: 'Script saved manually'}],
    });

    const variants = structuredClone(campaign.variants);
    const anyDownstream = variants.some(v => v.preview?.entryId || v.final?.entryId);
    if (wasApproved || anyDownstream) {
      for (const v of variants) {
        if (v.preview?.entryId) v.preview.stale = true;
        if (v.final?.entryId) v.final.stale = true;
      }
    }
    const scenarioStep = {
      entryId: entry.id,
      approvedAt: null,
      stale: false,
      needs,
    };
    const steps = syncActiveVariantSteps(scenarioStep, variants, campaign.activeVariant);

    const name = campaign.name === 'New campaign' && parsed.theme ? parsed.theme : campaign.name;
    const updated = await history.update(campaign.id, {name, steps, variants});
    res.json({
      scenario: parsed,
      validation,
      historyId: entry.id,
      campaign: await hydrateCampaign(updated),
    });
  });

  // POST /api/campaigns/:id/scenario {requestId, notes?}
  app.post('/api/campaigns/:id/scenario', async (req, res) => {
    const campaign = await requireCampaign(req.params.id);
    const requestId = validId(req.body?.requestId) ? req.body.requestId : randomUUID();
    await startCampaignRun(campaign, requestId, 'scenario');

    const sel = stepSelection(campaign.setup, 'scenario');
    const dir = folder(campaign.project), assets = path.join(dir, 'assets');
    const job = createJob(requestId, {task: 'scenario', mode: sel.mode, project: campaign.project, campaign: campaign.id});
    const log = logger(job, {mediaURL: file => assetURL(campaign.project, file)});
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) {
        controller.abort();
        if (!job.done) log('Client canceled script generation', {level: 'warn'});
      }
    });

    let runStatus = 'done';
    let entryId = null;
    try {
      await checkProvider(sel.mode, sel.billing);
      await store.sync.down(campaign.project, {dataDir});
      const files = await listAssets(assets).catch(() => []);
      const prevEntry = campaign.steps.scenario.entryId ? await history.get(campaign.steps.scenario.entryId) : null;
      const currentScenario = prevEntry?.output?.scenario || null;
      const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';

      log(`Step 1 · Script · ${sel.mode}${sel.model ? ' · ' + sel.model : ''}`, {level: 'step'});
      let scenarioObj, validation;

      if (sel.mode === 'demo') {
        await wait(350, controller.signal);
        scenarioObj = await loadDemoScenario(root, campaign.setup, null);
        if (notes) scenarioObj.notes = notes;
        job.text = JSON.stringify(scenarioObj, null, 2);
        validation = validateScenario(scenarioObj, campaign.setup);
        log('Demo script generated', {level: 'done'});
      } else {
        const system = scenarioPrompt(campaign.setup);
        const user = scenarioMessage({files, notes: notes || undefined, current: currentScenario, setup: campaign.setup});
        const onText = text => { job.text = text; job.tail = text.slice(-600); };
        let rawText = await runModelText({
          mode: sel.mode, billing: sel.billing, model: sel.model, effort: sel.effort,
          dir: assets, system, user, task: 'scenario', controller, log, onText,
        });

        let repairErrors = [];
        try {
          scenarioObj = parseScenario(rawText);
          validation = validateScenario(scenarioObj, campaign.setup);
          repairErrors = validation.errors;
        } catch (parseErr) {
          repairErrors = [parseErr.message];
        }

        if (repairErrors.length > 0) {
          log('Script validation failed. Trying one repair.', {level: 'warn', detail: repairErrors.join('\n')});
          const repairUser = user + '\n\n' + scenarioRepairMessage(repairErrors);
          rawText = await runModelText({
            mode: sel.mode, billing: sel.billing, model: sel.model, effort: sel.effort,
            dir: assets, system, user: repairUser, task: 'scenario', controller, log, onText,
          });
          try {
            scenarioObj = parseScenario(rawText);
            validation = validateScenario(scenarioObj, campaign.setup);
          } catch (parseErr2) {
            if (scenarioObj) {
              validation = validateScenario(scenarioObj, campaign.setup);
              validation.errors = [...new Set([...validation.errors, parseErr2.message])];
            } else {
              throw parseErr2;
            }
          }
        }
      }

      const needs = computeNeeds(scenarioObj, campaign.setup);
      await store.sync.up(campaign.project, {dataDir});
      const entry = await history.record({
        id: requestId,
        type: 'scenario',
        status: 'ok',
        campaign: campaign.id,
        stage: 'scenario',
        kind: campaign.setup.kind,
        project: campaign.project,
        mode: sel.mode,
        model: sel.model,
        effort: sel.effort,
        durationMs: Date.now() - job.started,
        input: {setup: campaign.setup, notes: notes || undefined, files, parentScenarioId: prevEntry?.id || null},
        output: {scenario: scenarioObj, validation},
        cost: job.costs,
        log: job.events,
      });
      entryId = entry.id;

      const variants = structuredClone(campaign.variants);
      const hadDownstream = Boolean(
        campaign.steps.scenario.approvedAt ||
        variants.some(v => v.preview?.entryId || v.final?.entryId)
      );
      if (hadDownstream) {
        for (const v of variants) {
          if (v.preview?.entryId) v.preview.stale = true;
          if (v.final?.entryId) v.final.stale = true;
        }
      }
      const scenarioStep = {entryId: entry.id, approvedAt: null, stale: false, needs};
      const steps = syncActiveVariantSteps(scenarioStep, variants, campaign.activeVariant);
      const name = campaign.name === 'New campaign' && scenarioObj.theme ? scenarioObj.theme : campaign.name;
      const updated = await history.update(campaign.id, {
        name,
        steps,
        variants,
        cost: addCost(campaign.cost, job.costs),
      });

      res.json({
        scenario: scenarioObj,
        validation,
        historyId: entry.id,
        campaign: await hydrateCampaign(updated),
      });
    } catch (error) {
      runStatus = controller.signal.aborted ? 'cancelled' : 'error';
      log(controller.signal.aborted ? 'Build stopped' : 'Error: ' + error.message, {
        level: controller.signal.aborted ? 'warn' : 'error',
      });
      await history.record({
        id: requestId,
        type: 'scenario',
        campaign: campaign.id,
        stage: 'scenario',
        kind: campaign.setup.kind,
        project: campaign.project,
        mode: sel.mode,
        model: sel.model,
        effort: sel.effort,
        status: controller.signal.aborted ? 'cancelled' : 'error',
        error: error.message,
        durationMs: Date.now() - job.started,
        input: {setup: campaign.setup},
        output: null,
        cost: job.costs,
        log: job.events,
      }).catch(() => {});
      await history.update(campaign.id, {cost: addCost(campaign.cost, job.costs)}).catch(() => {});
      throw error;
    } finally {
      await finishCampaignRun(campaign.id, requestId, job, {status: runStatus, entryId});
    }
  });

  // POST /api/campaigns/:id/translate {requestId, languages?}
  app.post('/api/campaigns/:id/translate', async (req, res) => {
    const campaign = await requireCampaign(req.params.id);
    await ensureIdle(campaign.id);
    if (!campaign.steps.scenario.entryId) {
      throw conflict('Create a script first.', 409);
    }
    const scEntry = await history.get(campaign.steps.scenario.entryId);
    const currentScenario = scEntry?.output?.scenario;
    if (!currentScenario) throw conflict('Script not found.', 409);

    const requestId = validId(req.body?.requestId) ? req.body.requestId : randomUUID();
    await startCampaignRun(campaign, requestId, 'scenario');

    const sel = stepSelection(campaign.setup, 'scenario');
    const dir = folder(campaign.project), assets = path.join(dir, 'assets');
    const job = createJob(requestId, {task: 'scenario', mode: sel.mode, project: campaign.project, campaign: campaign.id});
    const log = logger(job, {mediaURL: file => assetURL(campaign.project, file)});
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });

    let runStatus = 'done';
    let entryId = null;
    try {
      await checkProvider(sel.mode, sel.billing);
      await store.sync.down(campaign.project, {dataDir});
      const reqLangs = Array.isArray(req.body?.languages) && req.body.languages.length
        ? req.body.languages
        : missingLanguages(currentScenario, campaign.setup.languages);
      const targetLangs = reqLangs.length ? reqLangs : campaign.setup.languages.slice(1);
      const primary = campaign.setup.languages[0];

      log(`Translating script · languages: ${targetLangs.join(', ')}`, {level: 'step'});
      const merged = structuredClone(currentScenario);
      merged.languages = [...campaign.setup.languages];

      if (sel.mode === 'demo' || !targetLangs.length) {
        await wait(300, controller.signal);
        const adapted = await loadDemoScenario(root, campaign.setup, merged);
        Object.assign(merged, adapted);
        log('Demo translation ready', {level: 'done'});
      } else {
        const system = translatePrompt({languages: targetLangs, primary});
        const user = translateMessage({scenario: currentScenario, languages: targetLangs});
        const onText = text => { job.text = text; };
        const rawText = await runModelText({
          mode: sel.mode, billing: sel.billing, model: sel.model, effort: sel.effort,
          dir: assets, system, user, task: 'translate', controller, log, onText,
        });
        const clean = rawText.trim().replace(/^`{3}(?:json)?\s*/i, '').replace(/`{3}\s*$/, '').trim();
        let parsed;
        try { parsed = JSON.parse(clean); } catch (e) { throw Error('Could not parse translation JSON: ' + e.message); }
        for (const [k, linePatch] of Object.entries(parsed?.lines || {})) {
          if (merged.lines[k] && linePatch?.text && typeof linePatch.text === 'object') {
            merged.lines[k].text = {...merged.lines[k].text, ...linePatch.text};
          }
        }
      }

      const validation = validateScenario(merged, campaign.setup);
      const needs = computeNeeds(merged, campaign.setup);
      await store.sync.up(campaign.project, {dataDir});
      const entry = await history.record({
        id: requestId,
        type: 'scenario',
        campaign: campaign.id,
        stage: 'scenario',
        kind: campaign.setup.kind,
        project: campaign.project,
        mode: sel.mode,
        model: sel.model,
        effort: sel.effort,
        durationMs: Date.now() - job.started,
        input: {setup: campaign.setup, translatedFrom: scEntry.id, languages: targetLangs},
        output: {scenario: merged, validation},
        cost: job.costs,
        log: job.events,
      });
      entryId = entry.id;

      const variants = structuredClone(campaign.variants);
      for (const v of variants) {
        if (v.final?.entryId) v.final.stale = true;
      }
      const scenarioStep = structuredClone(campaign.steps.scenario);
      scenarioStep.entryId = entry.id;
      scenarioStep.needs = needs;
      if (validation.errors.length > 0) scenarioStep.approvedAt = null;
      const steps = syncActiveVariantSteps(scenarioStep, variants, campaign.activeVariant);

      const updated = await history.update(campaign.id, {
        steps,
        variants,
        cost: addCost(campaign.cost, job.costs),
      });

      res.json({
        scenario: merged,
        validation,
        historyId: entry.id,
        campaign: await hydrateCampaign(updated),
      });
    } catch (error) {
      runStatus = controller.signal.aborted ? 'cancelled' : 'error';
      log('Translation error: ' + error.message, {level: 'error'});
      await history.update(campaign.id, {cost: addCost(campaign.cost, job.costs)}).catch(() => {});
      throw error;
    } finally {
      await finishCampaignRun(campaign.id, requestId, job, {status: runStatus, entryId});
    }
  });

  // POST /api/campaigns/:id/cuts {requestId}
  app.post('/api/campaigns/:id/cuts', async (req, res) => {
    const campaign = await requireCampaign(req.params.id);
    await ensureIdle(campaign.id);
    if (campaign.setup.kind !== 'multi') {
      throw conflict('Cuts by duration are available only for multi-scene videos.', 409);
    }
    if (!campaign.steps.scenario.entryId) {
      throw conflict('Create a script first.', 409);
    }
    const scEntry = await history.get(campaign.steps.scenario.entryId);
    const currentScenario = scEntry?.output?.scenario;
    if (!currentScenario) throw conflict('Script not found.', 409);

    const requestId = validId(req.body?.requestId) ? req.body.requestId : randomUUID();
    await startCampaignRun(campaign, requestId, 'scenario');

    const sel = stepSelection(campaign.setup, 'scenario');
    const dir = folder(campaign.project), assets = path.join(dir, 'assets');
    const job = createJob(requestId, {task: 'scenario', mode: sel.mode, project: campaign.project, campaign: campaign.id});
    const log = logger(job, {mediaURL: file => assetURL(campaign.project, file)});
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });

    let runStatus = 'done';
    let entryId = null;
    try {
      await checkProvider(sel.mode, sel.billing);
      await store.sync.down(campaign.project, {dataDir});
      const files = await listAssets(assets).catch(() => []);
      const missing = missingCuts(currentScenario, campaign.setup.lengths);
      const targetLengths = missing.length ? missing : campaign.setup.lengths;

      log(`Calculating cuts · lengths: ${targetLengths.join(', ')} s`, {level: 'step'});
      let nextScenario;

      if (sel.mode === 'demo') {
        await wait(300, controller.signal);
        nextScenario = structuredClone(currentScenario);
        const built = buildProportionalCuts(nextScenario, campaign.setup.lengths, campaign.setup.languages);
        nextScenario.cuts = {...(nextScenario.cuts || {}), ...built};
        log('Demo cuts calculated', {level: 'done'});
      } else {
        const system = scenarioPrompt(campaign.setup);
        const user = scenarioMessage({
          files,
          current: currentScenario,
          setup: campaign.setup,
          missingCuts: targetLengths,
        });
        const onText = text => { job.text = text; };
        let rawText = await runModelText({
          mode: sel.mode, billing: sel.billing, model: sel.model, effort: sel.effort,
          dir: assets, system, user, task: 'cuts', controller, log, onText,
        });
        let validation;
        let repairErrors = [];
        try {
          nextScenario = parseScenario(rawText);
          validation = validateScenario(nextScenario, campaign.setup);
          repairErrors = validation.errors;
        } catch (parseErr) {
          repairErrors = [parseErr.message];
        }
        if (repairErrors.length > 0) {
          log('Script validation failed. Trying one repair.', {level: 'warn', detail: repairErrors.join('\n')});
          rawText = await runModelText({
            mode: sel.mode, billing: sel.billing, model: sel.model, effort: sel.effort,
            dir: assets, system, user: user + '\n\n' + scenarioRepairMessage(repairErrors),
            task: 'cuts', controller, log, onText,
          });
          try {
            nextScenario = parseScenario(rawText);
          } catch (parseErr2) {
            if (!nextScenario) nextScenario = structuredClone(currentScenario);
          }
        }
      }

      const validation = validateScenario(nextScenario, campaign.setup);
      const needs = computeNeeds(nextScenario, campaign.setup);
      await store.sync.up(campaign.project, {dataDir});
      const entry = await history.record({
        id: requestId,
        type: 'scenario',
        campaign: campaign.id,
        stage: 'scenario',
        kind: campaign.setup.kind,
        project: campaign.project,
        mode: sel.mode,
        model: sel.model,
        effort: sel.effort,
        durationMs: Date.now() - job.started,
        input: {setup: campaign.setup, cutsFrom: scEntry.id, lengths: targetLengths},
        output: {scenario: nextScenario, validation},
        cost: job.costs,
        log: job.events,
      });
      entryId = entry.id;

      const variants = structuredClone(campaign.variants);
      for (const v of variants) {
        if (v.final?.entryId) v.final.stale = true;
      }
      const scenarioStep = structuredClone(campaign.steps.scenario);
      scenarioStep.entryId = entry.id;
      scenarioStep.needs = needs;
      if (validation.errors.length > 0) scenarioStep.approvedAt = null;
      const steps = syncActiveVariantSteps(scenarioStep, variants, campaign.activeVariant);

      const updated = await history.update(campaign.id, {
        steps,
        variants,
        cost: addCost(campaign.cost, job.costs),
      });

      res.json({
        scenario: nextScenario,
        validation,
        historyId: entry.id,
        campaign: await hydrateCampaign(updated),
      });
    } catch (error) {
      runStatus = controller.signal.aborted ? 'cancelled' : 'error';
      log('Could not calculate cuts: ' + error.message, {level: 'error'});
      await history.update(campaign.id, {cost: addCost(campaign.cost, job.costs)}).catch(() => {});
      throw error;
    } finally {
      await finishCampaignRun(campaign.id, requestId, job, {status: runStatus, entryId});
    }
  });

  // POST /api/campaigns/:id/approve {step:'scenario'|'preview', variant?}
  app.post('/api/campaigns/:id/approve', async (req, res) => {
    const campaign = await requireCampaign(req.params.id);
    await ensureIdle(campaign.id);
    const step = req.body?.step;
    if (step !== 'scenario' && step !== 'preview') {
      throw conflict('Specify a step to approve: scenario or preview.', 409);
    }

    const variants = structuredClone(campaign.variants);
    const scenarioStep = structuredClone(campaign.steps.scenario);
    let activeVariant = campaign.activeVariant;
    const now = new Date().toISOString();

    if (step === 'scenario') {
      if (!scenarioStep.entryId || scenarioStep.stale) {
        throw conflict('Generate an up-to-date script first.', 409);
      }
      const scEntry = await history.get(scenarioStep.entryId);
      const scenarioObj = scEntry?.output?.scenario;
      if (!scenarioObj) throw conflict('Script not found.', 409);
      const validation = validateScenario(scenarioObj, campaign.setup);
      const needs = computeNeeds(scenarioObj, campaign.setup);
      if (validation.errors.length > 0) {
        throw conflict('Resolve validation errors before approving the script.', 409);
      }
      if (needs.length > 0) {
        throw conflict('Update the script translations or cuts first.', 409);
      }
      scenarioStep.approvedAt = now;
      scenarioStep.stale = false;
      scenarioStep.needs = [];
    } else if (step === 'preview') {
      if (!scenarioStep.approvedAt || scenarioStep.stale || scenarioStep.needs?.length) {
        throw conflict('Approve the script first.', 409);
      }
      const targetVar = findTargetVariant(variants, req.body?.variant, activeVariant);
      if (!targetVar.preview?.entryId || targetVar.preview?.stale) {
        throw conflict('Build an up-to-date preview first.', 409);
      }
      targetVar.preview.approvedAt = now;
      targetVar.preview.stale = false;
      activeVariant = targetVar.id;
    }

    const steps = syncActiveVariantSteps(scenarioStep, variants, activeVariant);
    const updated = await history.update(campaign.id, {steps, variants, activeVariant});
    res.json(await hydrateCampaign(updated));
  });

  // POST /api/campaigns/:id/styles {requestId, variant?}
  app.post('/api/campaigns/:id/styles', async (req, res) => {
    const campaign = await requireCampaign(req.params.id);
    await ensureIdle(campaign.id);
    if (!campaign.steps.scenario.approvedAt || campaign.steps.scenario.stale || campaign.steps.scenario.needs?.length) {
      throw conflict('Approve the script first.', 409);
    }

    const targetVarCheck = findTargetVariant(campaign.variants, req.body?.variant, campaign.activeVariant);
    const requestId = validId(req.body?.requestId) ? req.body.requestId : randomUUID();
    await startCampaignRun(campaign, requestId, 'style');

    const sel = stepSelection(campaign.setup, 'styles');
    const dir = folder(campaign.project), assets = path.join(dir, 'assets');
    const job = createJob(requestId, {task: 'style', mode: sel.mode, project: campaign.project, campaign: campaign.id});
    const log = logger(job, {mediaURL: file => assetURL(campaign.project, file)});
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });

    let runStatus = 'done';
    let entryId = null;
    try {
      await checkProvider(sel.mode, sel.billing);
      await store.sync.down(campaign.project, {dataDir});
      const files = await listAssets(assets).catch(() => []);
      const scEntry = await history.get(campaign.steps.scenario.entryId);
      const scenarioObj = scEntry?.output?.scenario;
      if (!scenarioObj) throw conflict('Script not found.', 409);

      log(`Step 2 · Three visual directions · ${sel.mode}`, {level: 'step'});
      let pitch;
      if (sel.mode === 'demo') {
        await wait(350, controller.signal);
        const raw = await fs.readFile(path.join(root, 'fixtures', 'styles.json'), 'utf8');
        pitch = parseStyleChoices(raw);
        job.sketches = pitch.styles.map(s => s.svg);
        log('Three demo directions ready: ' + pitch.styles.map(s => s.name).join(' · '), {level: 'done'});
      } else {
        const system = stylesPrompt({kind: campaign.setup.kind, scenario: scenarioObj, setup: campaign.setup});
        const user = stylesMessage({setup: campaign.setup, scenario: scenarioObj, files});
        const onText = text => {
          job.text = text;
          const found = streamedSketches(text);
          if (found.length > job.sketches.length) {
            job.sketches = found;
            log('Sketch ' + found.length + ' of 3 ready', {level: 'done'});
          }
        };
        const rawText = await runModelText({
          mode: sel.mode, billing: sel.billing, model: sel.model, effort: sel.effort,
          dir: assets, system, user, task: 'style', controller, log, onText,
        });
        pitch = parseStyleChoices(rawText);
        log('Three directions ready: ' + pitch.styles.map(s => s.name).join(' · '), {level: 'done'});
      }

      await store.sync.up(campaign.project, {dataDir});
      const entry = await history.record({
        id: requestId,
        type: 'style',
        campaign: campaign.id,
        stage: 'styles',
        kind: campaign.setup.kind,
        project: campaign.project,
        mode: sel.mode,
        model: sel.model,
        effort: sel.effort,
        durationMs: Date.now() - job.started,
        input: {setup: campaign.setup, scenarioId: scEntry.id, files},
        output: {styles: pitch.styles},
        cost: job.costs,
        log: job.events,
      });
      entryId = entry.id;

      const variants = structuredClone(campaign.variants);
      const targetVar = findTargetVariant(variants, targetVarCheck.id, campaign.activeVariant);
      let activeVariant = targetVar.id;

      // §4.2: /styles always creates a new variant when the target/active variant already has a preview.
      if (targetVar.preview?.entryId) {
        const newVar = createVariantRecord({
          label: `Style ${variants.length + 1}`,
          createdAt: new Date().toISOString(),
          author: currentAuthor(),
          styles: {entryId: entry.id, chosenIndex: null, direction: ''},
          cost: addCost(emptyCost(), job.costs),
        });
        variants.push(newVar);
        activeVariant = newVar.id;
      } else {
        targetVar.styles = {entryId: entry.id, chosenIndex: null, direction: ''};
        targetVar.cost = addCost(targetVar.cost, job.costs);
      }

      const steps = syncActiveVariantSteps(campaign.steps.scenario, variants, activeVariant);
      const updated = await history.update(campaign.id, {
        steps,
        variants,
        activeVariant,
        cost: addCost(campaign.cost, job.costs),
      });

      res.json({
        styles: pitch.styles,
        historyId: entry.id,
        campaign: await hydrateCampaign(updated),
      });
    } catch (error) {
      runStatus = controller.signal.aborted ? 'cancelled' : 'error';
      log('Could not generate styles: ' + error.message, {level: 'error'});
      await history.update(campaign.id, {cost: addCost(campaign.cost, job.costs)}).catch(() => {});
      throw error;
    } finally {
      await finishCampaignRun(campaign.id, requestId, job, {status: runStatus, entryId});
    }
  });

  // POST /api/campaigns/:id/styles/choose {index, direction?, label?, variant?}
  app.post('/api/campaigns/:id/styles/choose', async (req, res) => {
    const campaign = await requireCampaign(req.params.id);
    await ensureIdle(campaign.id);
    const variants = structuredClone(campaign.variants);
    const targetVar = findTargetVariant(variants, req.body?.variant, campaign.activeVariant);

    if (!targetVar.styles?.entryId) {
      throw conflict('Generate three visual directions first.', 409);
    }
    const stEntry = await history.get(targetVar.styles.entryId);
    const styles = stEntry?.output?.styles;
    const index = Number(req.body?.index);
    if (!Array.isArray(styles) || ![0, 1, 2].includes(index) || !styles[index]) {
      throw conflict('Select one of the three directions (0, 1 or 2).', 409);
    }
    const chosen = styles[index];
    const defaultDirection = [chosen.name, chosen.idea, chosen.direction].filter(Boolean).join('\n\n');
    const direction = typeof req.body?.direction === 'string' && req.body.direction.trim()
      ? req.body.direction.trim()
      : defaultDirection;
    const customLabel = typeof req.body?.label === 'string' && req.body.label.trim()
      ? req.body.label.trim()
      : '';

    let activeVariant = targetVar.id;

    // §4.2: A variant that has a preview is never mutated by a style choice; only new variants are created.
    if (targetVar.preview?.entryId) {
      const newVar = createVariantRecord({
        label: customLabel || chosen.name || `Style ${variants.length + 1}`,
        createdAt: new Date().toISOString(),
        author: currentAuthor(),
        styles: {
          entryId: targetVar.styles.entryId,
          chosenIndex: index,
          direction,
        },
      });
      variants.push(newVar);
      activeVariant = newVar.id;
    } else {
      const prevStyleNames = new Set(styles.map(s => s?.name).filter(Boolean));
      const hadAutoLabel = !targetVar.label || /^(?:Style|Стиль) \d+$/.test(targetVar.label) || prevStyleNames.has(targetVar.label);
      targetVar.styles.chosenIndex = index;
      targetVar.styles.direction = direction;
      if (customLabel) {
        targetVar.label = customLabel;
      } else if (chosen.name && hadAutoLabel) {
        targetVar.label = chosen.name;
      }
    }

    const steps = syncActiveVariantSteps(campaign.steps.scenario, variants, activeVariant);
    const updated = await history.update(campaign.id, {steps, variants, activeVariant});
    res.json(await hydrateCampaign(updated));
  });

  // POST /api/campaigns/:id/preview {requestId, direction?, variant?}
  app.post('/api/campaigns/:id/preview', async (req, res) => {
    const campaign = await requireCampaign(req.params.id);
    await ensureIdle(campaign.id);
    if (!campaign.steps.scenario.approvedAt || campaign.steps.scenario.stale || campaign.steps.scenario.needs?.length) {
      throw conflict('Approve the script first.', 409);
    }
    const targetVarInit = findTargetVariant(campaign.variants, req.body?.variant, campaign.activeVariant);
    if (!targetVarInit.styles?.entryId || ![0, 1, 2].includes(targetVarInit.styles?.chosenIndex)) {
      throw conflict('Select a visual direction first.', 409);
    }

    const requestId = validId(req.body?.requestId) ? req.body.requestId : randomUUID();
    await startCampaignRun(campaign, requestId, 'preview');

    const sel = stepSelection(campaign.setup, 'preview');
    const dir = folder(campaign.project), assets = path.join(dir, 'assets');
    const job = createJob(requestId, {task: 'preview', mode: sel.mode, project: campaign.project, campaign: campaign.id});
    const log = logger(job, {mediaURL: file => assetURL(campaign.project, file)});
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });

    let runStatus = 'done';
    let entryId = null;
    try {
      await checkProvider(sel.mode, sel.billing);
      await store.sync.down(campaign.project, {dataDir});
      const files = await listAssets(assets).catch(() => []);
      const scEntry = await history.get(campaign.steps.scenario.entryId);
      const scenarioObj = scEntry?.output?.scenario;
      const stEntry = await history.get(targetVarInit.styles.entryId);
      const chosenStyle = stEntry?.output?.styles?.[targetVarInit.styles.chosenIndex];
      const directionText = (typeof req.body?.direction === 'string' && req.body.direction.trim())
        ? req.body.direction.trim()
        : (targetVarInit.styles.direction || [chosenStyle?.name, chosenStyle?.idea, chosenStyle?.direction].filter(Boolean).join('\n\n'));
      const stylePayload = {
        name: chosenStyle?.name || '',
        idea: chosenStyle?.idea || '',
        direction: directionText,
        referenceSvg: chosenStyle?.svg || '',
      };

      const primaryFormatId = campaign.setup.formats[0];
      const primaryLang = campaign.setup.languages[0];
      log(`Step 2 · Building preview (${primaryFormatId}, ${primaryLang}) · ${sel.mode}`, {level: 'step'});

      let draftAt = 0, draftLen = 0, draftRev = 0, writing = false;
      const onText = text => {
        job.text = text; job.tail = text.slice(-600);
        if (writing || Date.now() - draftAt < 1500 || text.length - draftLen < 350) return;
        const draft = draftHTML(text);
        if (!draft) return;
        writing = true; draftAt = Date.now(); draftLen = text.length;
        const injectedDraft = injectForEntry(draft, {stage: 'preview', setup: campaign.setup, scenario: scenarioObj, libs});
        fs.writeFile(path.join(dir, 'draft.html'), injectedDraft).then(() => {
          draftRev++; job.draft = {url: previewURL + '/p/' + campaign.project + '/draft.html', rev: draftRev};
        }).catch(() => {}).finally(() => { writing = false; });
      };

      let srcHtml;
      if (sel.mode === 'demo') {
        await wait(400, controller.signal);
        srcHtml = await fs.readFile(path.join(root, 'fixtures', 'preview.html'), 'utf8');
        log('Demo preview built', {level: 'done'});
      } else {
        const system = previewPrompt({kind: campaign.setup.kind, scenario: scenarioObj, style: stylePayload, setup: campaign.setup});
        const user = previewMessage({setup: campaign.setup, scenario: scenarioObj, style: stylePayload, files});
        srcHtml = await runModelHtml({
          mode: sel.mode, billing: sel.billing, model: sel.model, effort: sel.effort,
          dir: assets, system, user, task: 'preview', media: null, controller, log, onText,
        });
      }

      if (!/<\/body\s*>/i.test(srcHtml)) {
        throw conflict('The model returned incomplete preview HTML. Try building again.', 502);
      }

      const revision = randomUUID();
      await fs.writeFile(path.join(dir, revision + '.src.html'), srcHtml);
      const injected = injectForEntry(srcHtml, {stage: 'preview', setup: campaign.setup, scenario: scenarioObj, libs});
      await fs.writeFile(path.join(dir, revision + '.html'), injected);
      await store.sync.up(campaign.project, {dataDir});

      const rel = '/p/' + campaign.project + '/' + revision + '.html';
      const sceneIds = (scenarioObj?.scenes || []).map(s => s.id);
      const entry = await history.record({
        id: requestId,
        type: 'preview',
        campaign: campaign.id,
        stage: 'preview',
        kind: campaign.setup.kind,
        project: campaign.project,
        mode: sel.mode,
        model: sel.model,
        effort: sel.effort,
        durationMs: Date.now() - job.started,
        input: {
          variantId: targetVarInit.id,
          scenarioId: scEntry.id,
          styleId: stEntry.id,
          styleIndex: targetVarInit.styles.chosenIndex,
          style: directionText,
          referenceSvg: chosenStyle?.svg,
          formats: [primaryFormatId],
          langs: [primaryLang],
          files,
        },
        output: {
          revision,
          path: rel,
          format: primaryFormatId,
          lang: primaryLang,
          scenes: sceneIds,
        },
        cost: job.costs,
        log: job.events,
      });
      entryId = entry.id;

      const variants = structuredClone(campaign.variants);
      const targetVar = findTargetVariant(variants, targetVarInit.id, campaign.activeVariant);
      targetVar.styles.direction = directionText;
      if (chosenStyle?.name && (!targetVar.label || /^(?:Style|Стиль) \d+$/.test(targetVar.label))) {
        targetVar.label = chosenStyle.name;
      }
      targetVar.preview = {entryId: entry.id, approvedAt: null, stale: false};
      if (targetVar.final?.entryId) targetVar.final.stale = true;
      targetVar.cost = addCost(targetVar.cost, job.costs);

      const activeVariant = targetVar.id;
      const steps = syncActiveVariantSteps(campaign.steps.scenario, variants, activeVariant);

      const updated = await history.update(campaign.id, {
        steps,
        variants,
        activeVariant,
        cost: addCost(campaign.cost, job.costs),
      });

      res.json({
        url: previewURL + rel,
        format: primaryFormatId,
        lang: primaryLang,
        scenes: sceneIds,
        historyId: entry.id,
        campaign: await hydrateCampaign(updated),
      });
    } catch (error) {
      runStatus = controller.signal.aborted ? 'cancelled' : 'error';
      log('Preview build failed: ' + error.message, {level: 'error'});
      await history.update(campaign.id, {cost: addCost(campaign.cost, job.costs)}).catch(() => {});
      throw error;
    } finally {
      await finishCampaignRun(campaign.id, requestId, job, {status: runStatus, entryId});
    }
  });

  // POST /api/campaigns/:id/final {requestId, media?, variant?}
  app.post('/api/campaigns/:id/final', async (req, res) => {
    const campaign = await requireCampaign(req.params.id);
    await ensureIdle(campaign.id);
    if (!campaign.steps.scenario.approvedAt || campaign.steps.scenario.stale || campaign.steps.scenario.needs?.length) {
      throw conflict('Approve the script first.', 409);
    }
    const targetVarInit = findTargetVariant(campaign.variants, req.body?.variant, campaign.activeVariant);
    if (!targetVarInit.preview?.approvedAt || !targetVarInit.preview?.entryId || targetVarInit.preview?.stale) {
      throw conflict('Approve an up-to-date preview first.', 409);
    }

    const requestId = validId(req.body?.requestId) ? req.body.requestId : randomUUID();
    await startCampaignRun(campaign, requestId, 'final');

    const sel = stepSelection(campaign.setup, 'final');
    const media = {
      images: req.body?.media?.images === true,
      video: campaign.setup.kind !== 'poster' && req.body?.media?.video === true,
    };
    const dir = folder(campaign.project), assets = path.join(dir, 'assets');
    const job = createJob(requestId, {task: 'final', mode: sel.mode, project: campaign.project, campaign: campaign.id});
    const log = logger(job, {mediaURL: file => assetURL(campaign.project, file)});
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });

    let tempPreviewDir = null;
    let runStatus = 'done';
    let entryId = null;
    try {
      if ((media.images || media.video) && sel.mode !== 'demo' && !mediaKey()) {
        throw conflict('To generate images, add OPENROUTER_API_KEY to .env and restart the server.', 503);
      }
      await checkProvider(sel.mode, sel.billing);
      await store.sync.down(campaign.project, {dataDir});

      const files = await listAssets(assets).catch(() => []);
      const previewEntry = await history.get(targetVarInit.preview.entryId);
      if (!previewEntry?.output?.path) throw conflict('Preview not found.', 409);

      const scenarioObj = await resolveEntryScenario(previewEntry, campaign);
      const copyPatch = previewEntry.input?.copyPatch || undefined;

      const previewFile = path.join(dataDir, previewEntry.output.path.replace(/^\/p\//, ''));
      const previewSrc = await fs.readFile(previewFile.replace(/\.html$/, '.src.html'), 'utf8')
        .catch(async () => uninject(await fs.readFile(previewFile, 'utf8')));

      log(`Step 3 · Building final · ${sel.mode}`, {level: 'step'});

      let draftAt = 0, draftLen = 0, draftRev = 0, writing = false;
      const onText = text => {
        job.text = text; job.tail = text.slice(-600);
        if (writing || Date.now() - draftAt < 1800 || text.length - draftLen < 400) return;
        const draft = draftHTML(text);
        if (!draft) return;
        writing = true; draftAt = Date.now(); draftLen = text.length;
        const injectedDraft = injectForEntry(draft, {stage: 'final', setup: campaign.setup, scenario: scenarioObj, libs});
        fs.writeFile(path.join(dir, 'draft.html'), injectedDraft).then(() => {
          draftRev++; job.draft = {url: previewURL + '/p/' + campaign.project + '/draft.html', rev: draftRev};
        }).catch(() => {}).finally(() => { writing = false; });
      };

      let srcHtml;
      if (sel.mode === 'demo') {
        await wait(450, controller.signal);
        srcHtml = await fs.readFile(path.join(root, 'fixtures', 'final.html'), 'utf8');
        log('Demo final built', {level: 'done'});
      } else {
        tempPreviewDir = await fs.mkdtemp(path.join(tmpdir(), 'forma-preview-'));
        const tempPreviewPath = path.join(tempPreviewDir, 'approved-preview.src.html');
        await fs.writeFile(tempPreviewPath, previewSrc);

        const stylePayload = {
          direction: targetVarInit.styles?.direction || previewEntry.input?.style || '',
          referenceSvg: previewEntry.input?.referenceSvg || '',
        };
        const system = finalPrompt({
          kind: campaign.setup.kind,
          scenario: scenarioObj,
          style: stylePayload,
          setup: campaign.setup,
          media: (media.images || media.video) ? media : null,
          previewPath: sel.mode === 'claude' ? tempPreviewPath : 'approvedPreviewHtml in the user message',
        });
        const user = finalMessage({
          setup: campaign.setup,
          scenario: scenarioObj,
          style: stylePayload,
          files,
          previewPath: sel.mode === 'claude' ? tempPreviewPath : undefined,
          previewHtml: sel.mode === 'codex' ? previewSrc : undefined,
        });

        srcHtml = await runModelHtml({
          mode: sel.mode, billing: sel.billing, model: sel.model, effort: sel.effort,
          dir: assets, system, user, task: 'final',
          media: (media.images || media.video) ? media : null,
          extraReadDirs: [tempPreviewDir],
          extraReadFiles: [tempPreviewPath],
          controller, log, onText,
        });
      }

      if (!/<\/body\s*>/i.test(srcHtml)) {
        throw conflict('The model returned incomplete final HTML.', 502);
      }
      if (campaign.setup.kind !== 'poster' && !/window\.renderFrame\s*=/.test(srcHtml)) {
        throw conflict('The model did not define window.renderFrame for the video. Try building again.', 502);
      }

      const revision = randomUUID();
      await fs.writeFile(path.join(dir, revision + '.src.html'), srcHtml);
      const injected = injectForEntry(srcHtml, {stage: 'final', setup: campaign.setup, scenario: scenarioObj, libs});
      await fs.writeFile(path.join(dir, revision + '.html'), injected);
      await store.sync.up(campaign.project, {dataDir});

      const rel = '/p/' + campaign.project + '/' + revision + '.html';
      const entry = await history.record({
        id: requestId,
        type: 'creative',
        campaign: campaign.id,
        stage: 'final',
        kind: campaign.setup.kind,
        project: campaign.project,
        mode: sel.mode,
        model: sel.model,
        effort: sel.effort,
        durationMs: Date.now() - job.started,
        input: {
          variantId: targetVarInit.id,
          scenarioId: campaign.steps.scenario.entryId,
          previewId: previewEntry.id,
          style: targetVarInit.styles?.direction || '',
          formats: campaign.setup.formats,
          langs: campaign.setup.languages,
          lengths: campaign.setup.lengths,
          media,
          files,
          copyPatch,
        },
        output: {
          revision,
          path: rel,
          stage: 'final',
          kind: campaign.setup.kind,
          formats: campaign.setup.formats,
          langs: campaign.setup.languages,
          lengths: campaign.setup.lengths,
          duration: campaign.setup.lengths[0] || 0,
          copyVersion: 1,
        },
        media: generatedMedia(job, campaign.project),
        cost: job.costs,
        log: job.events,
      });
      entryId = entry.id;

      const variants = structuredClone(campaign.variants);
      const targetVar = findTargetVariant(variants, targetVarInit.id, campaign.activeVariant);
      targetVar.final = {entryId: entry.id, stale: false};
      targetVar.cost = addCost(targetVar.cost, job.costs);

      const activeVariant = targetVar.id;
      const steps = syncActiveVariantSteps(campaign.steps.scenario, variants, activeVariant);
      const updated = await history.update(campaign.id, {
        steps,
        variants,
        activeVariant,
        cost: addCost(campaign.cost, job.costs),
      });

      res.json({
        url: previewURL + rel,
        formats: campaign.setup.formats,
        langs: campaign.setup.languages,
        lengths: campaign.setup.lengths,
        historyId: entry.id,
        campaign: await hydrateCampaign(updated),
      });
    } catch (error) {
      runStatus = controller.signal.aborted ? 'cancelled' : 'error';
      log('Final build failed: ' + error.message, {level: 'error'});
      await history.update(campaign.id, {cost: addCost(campaign.cost, job.costs)}).catch(() => {});
      throw error;
    } finally {
      await finishCampaignRun(campaign.id, requestId, job, {status: runStatus, entryId});
      if (tempPreviewDir) await fs.rm(tempPreviewDir, {recursive: true, force: true}).catch(() => {});
    }
  });

  // POST /api/history/:id/copy {patch} — re-injects with updated copy, no model call (§6.6)
  app.post('/api/history/:id/copy', async (req, res) => {
    const parent = await history.get(req.params.id);
    if (!parent || !['preview', 'creative'].includes(parent.type) || !parent.output?.path) {
      throw conflict('Copy editing is available only for previews and final creatives.', 409);
    }
    const campaign = parent.campaign ? await requireCampaign(parent.campaign) : null;
    if (!campaign) {
      throw conflict('This entry is not linked to a campaign.', 409);
    }
    await ensureIdle(campaign.id);

    const scEntryId = parent.input?.scenarioId || campaign.steps.scenario.entryId;
    const scEntry = scEntryId ? await history.get(scEntryId) : null;
    const baseScenario = scEntry?.output?.scenario;
    if (!baseScenario) throw conflict('Script for this build not found.', 409);

    const validatedPatch = validateCopyPatch(req.body?.patch, baseScenario, campaign.setup.languages);
    const combinedPatch = mergeCopyPatches(parent.input?.copyPatch || {}, validatedPatch);
    const patchedScenario = applyCopyPatch(baseScenario, combinedPatch);

    const dir = folder(parent.project);
    await store.sync.down(parent.project, {dataDir});
    const parentFile = path.join(dataDir, parent.output.path.replace(/^\/p\//, ''));
    const sourceHtml = await fs.readFile(parentFile.replace(/\.html$/, '.src.html'), 'utf8')
      .catch(async () => uninject(await fs.readFile(parentFile, 'utf8')));

    const stage = parent.type === 'preview' ? 'preview' : 'final';
    const revision = randomUUID();
    const rel = '/p/' + parent.project + '/' + revision + '.html';
    await fs.writeFile(path.join(dir, revision + '.src.html'), sourceHtml);
    const injected = injectForEntry(sourceHtml, {stage, setup: campaign.setup, scenario: patchedScenario, libs});
    await fs.writeFile(path.join(dir, revision + '.html'), injected);
    await store.sync.up(parent.project, {dataDir});

    const variants = structuredClone(campaign.variants);
    const targetVar = findVariantForEntry(variants, parent, campaign.activeVariant);

    const nextCopyVersion = (parent.output.copyVersion || 1) + 1;
    const newEntry = await history.record({
      id: randomUUID(),
      type: parent.type,
      campaign: campaign.id,
      stage,
      kind: campaign.setup.kind,
      project: parent.project,
      mode: parent.mode,
      model: parent.model,
      effort: parent.effort,
      durationMs: 0,
      input: {
        ...parent.input,
        variantId: targetVar.id,
        scenarioId: scEntry.id,
        copyPatch: combinedPatch,
        revision: {parent: parent.id, message: 'Copy edit', attachments: []},
      },
      output: {
        ...parent.output,
        revision,
        path: rel,
        copyVersion: nextCopyVersion,
        reply: 'Copy updated without a model call.',
      },
      cost: emptyCost(),
      log: [{i: 0, at: 0, level: 'done', msg: 'Copy updated without a model call'}],
    });

    if (stage === 'preview') {
      targetVar.preview.entryId = newEntry.id;
      if (targetVar.final?.entryId) targetVar.final.stale = true;
    } else {
      targetVar.final.entryId = newEntry.id;
    }
    const steps = syncActiveVariantSteps(campaign.steps.scenario, variants, campaign.activeVariant);
    const updated = await history.update(campaign.id, {steps, variants});

    res.json({
      url: previewURL + rel,
      historyId: newEntry.id,
      scenario: patchedScenario,
      copyPatch: combinedPatch,
      campaign: await hydrateCampaign(updated),
    });
  });

  // Handler for revising a campaign preview or final entry (delegated from POST /api/history/:id/revise)
  async function reviseCampaignEntry(req, res, parent) {
    const campaign = await requireCampaign(parent.campaign);
    await ensureIdle(campaign.id);

    const stage = parent.type === 'preview' ? 'preview' : 'final';
    const message = typeof req.body?.message === 'string' ? req.body.message : '';
    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments.map(assetName) : [];
    if (!message.trim() && !attachments.length) {
      throw conflict('Describe a change or attach a file.', 400);
    }
    if (message.length > 8000 || attachments.length > 12) {
      throw conflict('The message is too long or has too many attachments.', 400);
    }

    const reqMode = req.body?.mode || campaign.setup.provider?.mode || 'demo';
    const sameProvider = reqMode === campaign.setup.provider?.mode;
    const sel = reqMode === 'demo'
      ? {mode: 'demo', billing: 'api', model: null, effort: null}
      : {
          mode: reqMode,
          billing: req.body?.billing ?? (sameProvider ? campaign.setup.provider?.billing : undefined) ?? (reqMode === 'claude' ? 'subscription' : 'api'),
          ...settings(
            reqMode,
            req.body?.model ?? (sameProvider ? campaign.setup.provider?.model : undefined),
            req.body?.effort ?? (sameProvider ? campaign.setup.provider?.effort : undefined)
          ),
        };

    const media = stage === 'final'
      ? {images: req.body?.media?.images === true, video: campaign.setup.kind !== 'poster' && req.body?.media?.video === true}
      : {images: false, video: false};

    if ((media.images || media.video) && sel.mode !== 'demo' && !mediaKey()) {
      throw conflict('To generate images, add OPENROUTER_API_KEY to .env and restart the server.', 503);
    }
    await checkProvider(sel.mode, sel.billing);

    const requestId = validId(req.body?.requestId) ? req.body.requestId : randomUUID();
    await startCampaignRun(campaign, requestId, stage);

    const dir = folder(parent.project), assets = path.join(dir, 'assets');
    await store.sync.down(parent.project, {dataDir});
    const files = await listAssets(assets).catch(() => []);
    for (const a of attachments) {
      if (!files.includes(a)) {
        await finishCampaignRun(campaign.id, requestId, null, {status: 'error'});
        throw conflict('Attachment not found: ' + a, 400);
      }
    }

    const parentFile = path.join(dataDir, parent.output.path.replace(/^\/p\//, ''));
    const source = await fs.readFile(parentFile.replace(/\.html$/, '.src.html'), 'utf8')
      .catch(async () => uninject(await fs.readFile(parentFile, 'utf8')));

    const scEntryId = parent.input?.scenarioId || campaign.steps.scenario.entryId;
    const scEntry = scEntryId ? await history.get(scEntryId) : null;
    const baseScenario = scEntry?.output?.scenario;
    let currentCopyPatch = parent.input?.copyPatch || {};
    let effectiveScenario = applyCopyPatch(baseScenario, currentCopyPatch);

    const targetVarInit = findVariantForEntry(campaign.variants, parent, campaign.activeVariant);

    const job = createJob(requestId, {task: stage, mode: sel.mode, project: parent.project, campaign: campaign.id});
    const log = logger(job, {mediaURL: file => assetURL(parent.project, file)});
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });

    const chain = (await history.thread(parent.id))
      .filter(e => e.input?.revision)
      .map(e => ({message: e.input.revision.message, attachments: e.input.revision.attachments, reply: e.output?.reply}));

    const work = await fs.mkdtemp(path.join(tmpdir(), 'forma-edit-'));
    const workFile = path.join(work, 'creative.html');
    let draftRev = 0;
    const onEdit = async () => {
      const html = await fs.readFile(workFile, 'utf8');
      const injectedDraft = injectForEntry(html, {stage, setup: campaign.setup, scenario: effectiveScenario, libs});
      await fs.writeFile(path.join(dir, 'draft.html'), injectedDraft);
      draftRev++;
      job.draft = {url: previewURL + '/p/' + parent.project + '/draft.html', rev: draftRev};
    };

    let runStatus = 'done';
    let entryId = null;
    try {
      await fs.writeFile(workFile, source);
      let html, rawReply;

      if (sel.mode === 'demo') {
        await wait(350, controller.signal);
        html = source;
        const blockMatch = message.match(/`{3}forma-copy\s*([\s\S]*?)`{3}/i);
        rawReply = 'Demo revision applied.' + (blockMatch ? '\n' + blockMatch[0] : '');
      } else if (sel.mode === 'claude') {
        const systemPrompt = stageRevisionPrompt({
          stage,
          kind: campaign.setup.kind,
          setup: campaign.setup,
          media: (media.images || media.video) ? media : null,
          editing: true,
        });
        const prompt = revisionMessage({
          workFile,
          files,
          thread: chain,
          message,
          attachments,
          setup: campaign.setup,
          stage,
          scenario: effectiveScenario,
          style: targetVarInit.styles?.direction || campaign.steps.styles.direction,
        });
        ({html, reply: rawReply} = await runModelRevise({
          dir: assets, workFile, files, billing: sel.billing, model: sel.model, effort: sel.effort,
          systemPrompt, prompt, media: (media.images || media.video) ? media : null,
          stage, controller, log, onEdit,
        }));
      } else {
        const system = stageRevisionPrompt({
          stage,
          kind: campaign.setup.kind,
          setup: campaign.setup,
          media: (media.images || media.video) ? media : null,
          editing: false,
        });
        const user = revisionMessage({
          files,
          thread: chain,
          message,
          attachments,
          current: source,
          setup: campaign.setup,
          stage,
          scenario: effectiveScenario,
          style: targetVarInit.styles?.direction || campaign.steps.styles.direction,
        });
        html = await runModelHtml({
          mode: 'codex', billing: sel.billing, model: sel.model, effort: sel.effort,
          dir: assets, system, user, task: stage,
          media: (media.images || media.video) ? media : null,
          controller, log, onText: () => {},
        });
      }

      let cleanReply = rawReply || '';
      if (sel.mode === 'codex') {
        const extracted = extractCopyPatch(html, {fromHtml: true});
        cleanReply = extracted.reply;
        html = extracted.html || html;
        if (extracted.patch && baseScenario) {
          const validPatch = validateCopyPatch(extracted.patch, baseScenario, campaign.setup.languages);
          currentCopyPatch = mergeCopyPatches(currentCopyPatch, validPatch);
          effectiveScenario = applyCopyPatch(baseScenario, currentCopyPatch);
        }
      } else {
        const extracted = extractCopyPatch(rawReply || '');
        cleanReply = extracted.reply;
        if (extracted.patch && baseScenario) {
          const validPatch = validateCopyPatch(extracted.patch, baseScenario, campaign.setup.languages);
          currentCopyPatch = mergeCopyPatches(currentCopyPatch, validPatch);
          effectiveScenario = applyCopyPatch(baseScenario, currentCopyPatch);
        }
      }

      html = checkHTML(html, sel.mode === 'codex' ? 'Codex' : 'Claude', stage);
      if (stage === 'final' && campaign.setup.kind !== 'poster' && !/window\.renderFrame\s*=/.test(html)) {
        throw conflict('Frame-by-frame animation is missing after the edit. Try again.', 502);
      }

      const revision = randomUUID();
      const rel = '/p/' + parent.project + '/' + revision + '.html';
      await fs.writeFile(path.join(dir, revision + '.src.html'), html);
      const injected = injectForEntry(html, {stage, setup: campaign.setup, scenario: effectiveScenario, libs});
      await fs.writeFile(path.join(dir, revision + '.html'), injected);
      await store.sync.up(parent.project, {dataDir});

      const newEntry = await history.record({
        id: requestId,
        type: parent.type,
        campaign: campaign.id,
        stage,
        kind: campaign.setup.kind,
        project: parent.project,
        mode: sel.mode,
        model: sel.model,
        effort: sel.effort,
        durationMs: Date.now() - job.started,
        input: {
          ...parent.input,
          variantId: targetVarInit.id,
          media,
          files,
          copyPatch: Object.keys(currentCopyPatch).length ? currentCopyPatch : undefined,
          revision: {parent: parent.id, message, attachments},
        },
        output: {
          ...parent.output,
          revision,
          path: rel,
          reply: cleanReply || 'Done.',
        },
        media: generatedMedia(job, parent.project),
        cost: job.costs,
        log: job.events,
      });
      entryId = newEntry.id;

      const variants = structuredClone(campaign.variants);
      const targetVar = findVariantForEntry(variants, parent, campaign.activeVariant);
      if (stage === 'preview') {
        targetVar.preview.entryId = newEntry.id;
        if (targetVar.final?.entryId) targetVar.final.stale = true;
      } else {
        targetVar.final.entryId = newEntry.id;
      }
      targetVar.cost = addCost(targetVar.cost, job.costs);
      const steps = syncActiveVariantSteps(campaign.steps.scenario, variants, campaign.activeVariant);

      const updated = await history.update(campaign.id, {
        steps,
        variants,
        cost: addCost(campaign.cost, job.costs),
      });

      res.json({
        url: previewURL + rel,
        formats: parent.output.formats || [parent.output.format],
        duration: parent.output.duration || 0,
        historyId: newEntry.id,
        reply: cleanReply || 'Done.',
        cost: job.costs,
        campaign: await hydrateCampaign(updated),
      });
    } catch (error) {
      runStatus = controller.signal.aborted ? 'cancelled' : 'error';
      log('Revision failed: ' + error.message, {level: 'error'});
      await history.update(campaign.id, {cost: addCost(campaign.cost, job.costs)}).catch(() => {});
      throw error;
    } finally {
      await finishCampaignRun(campaign.id, requestId, job, {status: runStatus, entryId});
      await fs.rm(work, {recursive: true, force: true}).catch(() => {});
    }
  }

  return {reviseCampaignEntry};
}
