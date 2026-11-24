import {materializeBrand, latestBrand, brandNotesText, brandNotesWriting, rememberForBrand} from './brands.mjs';
// Campaign state, invalidation (§2.5), concurrency gating (§6.2), cost roll-up and HTTP routes (§6).
import fs from 'node:fs/promises';
import path from 'node:path';
import {EventEmitter} from 'node:events';
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
  stylesPrompt, styleRevisionPrompt, styleRevisionMessage, parseStyleRevision, stylesMessage, parseStyleChoices,
  previewPrompt, previewMessage,
  finalPrompt, finalMessage,
  stageRevisionPrompt, revisionMessage, output as checkHTML,
  extractCopyPatch, validateCopyPatch, mergeCopyPatches, applyCopyPatch,
  BRAND_NOTES_FILE, addClientDecision,
  reviewPrompt, reviewMessage, parseReview,
} from './creative.mjs';
import {renderSheets as defaultRenderSheets} from './render.mjs';
import {bakeScreens as defaultBakeScreens} from './screen-bake.mjs';
import {settings} from './models.mjs';
import {mediaKey} from './media.mjs';

const validId = id => /^[0-9a-f-]{36}$/.test(String(id || ''));
const knownLangCodes = new Set(LANGUAGES.map(l => l.code));
export const conflict = (msg, status = 409) => Object.assign(Error(msg), {status});
// The preview may make exactly one picture: its hero.
export const PREVIEW_MEDIA = Object.freeze({images: true, video: false, maxImages: 1});

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

// Problems from the check after a build that break the frame (not taste): fixed on their own, once.
const HARD_ERROR = /script error|securityerror|tainted|webgl|shader|did not load|never reported|failed to load|http 40[34]/i;
export function hardProblems(problems = {}) {
  const out = [];
  const errors = (problems.errors || []).filter(e => HARD_ERROR.test(e.message));
  if (errors.length) out.push(errors.length + (errors.length === 1 ? ' browser error' : ' browser errors') + ' (' + errors[0].message.slice(0, 120) + ')');
  if (problems.blank?.length) out.push('flat frames: ' + problems.blank.join(', '));
  if (problems.green?.length) out.push('chroma green left in: ' + problems.green.join(', '));
  if (problems.still?.length) out.push('the video does not move in: ' + problems.still.join(', '));
  if (problems.video?.length) out.push('no video: ' + problems.video[0].slice(0, 160));
  if (problems.screens?.length) out.push('screens in clips: ' + problems.screens[0].slice(0, 160) + (problems.screens.length > 1 ? ' (+' + (problems.screens.length - 1) + ')' : ''));
  return out;
}

// The message of the fix: what the browser and the pixels showed, causes to fix, nothing else to change.
export function fixMessage(problems = {}) {
  const lines = ['The check after the build found frames that are broken. Fix the causes and change nothing else: composition, copy, timing and pictures stay as they are.'];
  for (const e of (problems.errors || []).filter(e => HARD_ERROR.test(e.message))) lines.push(`- ${e.message} (${(e.where || []).join(', ')})`);
  if (problems.blank?.length) lines.push(`- These frames came out a single flat colour (nothing drawn, or a scene failed): ${problems.blank.join(', ')}.`);
  if (problems.green?.length) lines.push(`- Pure chroma green #00FF00 is visible in: ${problems.green.join(', ')}. The surface must be covered by the interface layer (keyed or pinned) in every frame, from the first one.`);
  if (problems.still?.length) lines.push(`- The video shows the same picture at every moment in: ${problems.still.join(', ')}. It does not play: usually renderFrame stops early (an error, or setup waiting for a clip that never loads). Make every moment drawn by renderFrame(t), and a clip that cannot load an error in the console, not a frozen frame.`);
  for (const p of problems.video || []) lines.push(`- ${p}`);
  if (problems.video?.length) lines.push('- Generate the clip again (generate_video), reading the error: shorter or simpler prompt, another keyframe, no keyframe for people. If video stays impossible, say so in your reply: never pass stills off as the video.');
  for (const p of problems.screens || []) lines.push(`- Screen in a clip: ${p}`);
  if (problems.screens?.length) lines.push('- For a screen the tracker got wrong, call track_screen with rough corners at those moments (open its contact sheet first). A clip without a usable green screen cannot carry an interface: generate it again with screen: true, or show the interface another way.');
  if ((problems.errors || []).some(e => /securityerror|tainted/i.test(e.message))) lines.push('- A tainted canvas means a picture or clip was read without CORS: keep crossorigin="anonymous" on it (the runtime sets it) and read it only after it has loaded.');
  lines.push('- Never hide an error in an empty catch; let it reach the console.');
  return lines.join('\n');
}

// Video the build needed and did not get (round 8: every clip refused, the final built from stills and called done):
// clip requests that all failed while no clip plays, and clips the code plays that are not in the materials.
const CLIP_REF = /["'(`]\s*(?:\.\/)?((?:assets\/)?[\w\-./]+\.(?:mp4|webm|mov|m4v))(?=[?#"'`)\s])/gi;
export function videoProblems({events = [], html = '', assets = []} = {}) {
  const have = new Set(assets.map(a => a.replace(/\\/g, '/')));
  const refs = [...new Set([...String(html).matchAll(CLIP_REF)].map(m => m[1].replace(/^assets\//, '')))]
    .filter(r => !/^(?:https?:)?\/\//.test(r) && !r.startsWith('screens/'));
  const missing = refs.filter(r => !have.has(r));
  const failed = events.filter(e => e.level === 'error' && /^OpenRouter ✗ video/.test(e.msg || ''));
  const made = events.some(e => e.media?.kind === 'video');
  const out = [];
  if (failed.length && !made && !refs.some(r => have.has(r))) {
    const why = String(failed.at(-1).detail || failed.at(-1).msg).replace(/\s+/g, ' ').slice(0, 200);
    out.push(`No clip was generated: ${failed.length} video request${failed.length > 1 ? 's' : ''} failed (last: ${why}). The spot shows stills where its direction needs video.`);
  }
  for (const r of missing.slice(0, 3)) out.push(`The code plays assets/${r}, which is not in the materials: that clip was never made or was renamed.`);
  return out;
}

const withoutCheck = (output = {}) => { const {check, screens, ...rest} = output; return rest; };   // both belong to the build they were made for

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
    for (const step of ['scenario', 'styles', 'preview', 'final', 'review']) {
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
    // The art director looks at every preview and final. Final notes are always applied once;
    // preview notes are applied automatically only when this is on (otherwise they wait for a click).
    review: {autoApplyPreview: raw.review?.autoApplyPreview === true},
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

// The entry a step shows is the last link of a chain: the build, then each revision of it
// (manual, copy edits, applied art-director notes, reworked directions, a rewritten script). The step costs the whole chain, not its last link.
// An entry's cost never changes, so each link's chain sum is cached.
const chainCostCache = new Map();
async function chainCost(entry) {
  if (!entry) return null;
  const links = [];
  let cur = entry, base = emptyCost();
  while (cur && links.length < 200 && !links.some(l => l.id === cur.id)) {
    if (chainCostCache.has(cur.id)) { base = chainCostCache.get(cur.id); break; }
    links.push(cur);
    // Revisions point back with revision.parent; reworked directions with parentId; a rewritten script with parentScenarioId.
    const parentId = cur.input?.revision?.parent || cur.input?.parentId || cur.input?.parentScenarioId;
    const parent = parentId ? await history.get(parentId).catch(() => null) : null;
    cur = parent && parent.type === entry.type ? parent : null;
  }
  for (const link of links.reverse()) {
    base = addCost(base, link.cost || {});
    chainCostCache.set(link.id, base);
  }
  return base;
}
const withStepCost = (light, cost) => (light ? {...light, stepCost: cost} : null);

// costs:false skips the step-cost chains (the campaign list does not show them).
export async function hydrateCampaign(rawCampaign, {costs = true} = {}) {
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
      scenario: withStepCost(lightEntry(scenario), (costs ? await chainCost(scenario) : null)),
      styles: withStepCost(lightEntry(activeStylesEntry), (costs ? await chainCost(activeStylesEntry) : null)),
      preview: withStepCost(lightEntry(activePreviewEntry), (costs ? await chainCost(activePreviewEntry) : null)),
      final: withStepCost(lightEntry(activeFinalEntry), (costs ? await chainCost(activeFinalEntry) : null)),
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

// The brand notes are live: a campaign of a saved brand always reads the brand's latest notes (so an edit or an
// answered question on the brand page reaches campaigns already running) and keeps a copy in its materials.
// A campaign without a saved brand has only its own copy.
// Times a stage that runs before the model is called and logs it when it takes noticeable time,
// so a slow start shows where it hangs (sign-in check, cloud sync, brand notes).
async function timed(log, label, fn) {
  const t0 = Date.now();
  const out = await fn();
  const ms = Date.now() - t0;
  if (ms >= 300) log(label + ' · ' + (ms / 1000).toFixed(1) + ' s', {level: ms >= 5000 ? 'warn' : 'info'});
  return out;
}

async function brandNotesFor(campaign, assets, log = () => {}) {
  return timed(log, 'Brand notes ready', () => brandNotesForInner(campaign, assets, log));
}
async function brandNotesForInner(campaign, assets, log) {
  const local = path.join(assets, BRAND_NOTES_FILE);
  const own = await fs.readFile(local, 'utf8').catch(() => '');
  if (!campaign.brandId) return own;
  if (brandNotesWriting(campaign.brandId)) {
    log('Waiting for the brand notes to finish…');
    const until = Date.now() + 180000;
    while (brandNotesWriting(campaign.brandId) && Date.now() < until) await new Promise(ok => setTimeout(ok, 2000));
  }
  const latest = await latestBrand(campaign.brandId).catch(() => null);
  const text = latest ? await brandNotesText(latest) : '';
  if (!text.trim()) return own;
  if (text !== own) {
    await fs.mkdir(assets, {recursive: true});
    await fs.writeFile(local, text);
    await store.sync.up(campaign.project, {path: 'assets/' + BRAND_NOTES_FILE, dataDir: path.dirname(path.dirname(assets))});
    log(own ? 'Brand notes updated from the brand' : 'Brand notes added to this campaign');
  }
  return text;
}

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
      const n = windowNeed(texts, lang, {closing, picture: true});
      if (n > max) max = n;
    }
    return max;
  };

  for (const rawLen of lengths) {
    const L = Number(rawLen);
    let chosenScenes;
    if (L <= 6 || scenes.length <= 2) {
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
    } else if (L <= 10) {
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
    // When even the shortest plan needs more than L, every window gets the same share of its need (all tight, none failing).
    const squeeze = sumNeed > L ? L / sumNeed : 1;
    let cursor = 0;
    const windows = chosenScenes.map((s, idx) => {
      const start = idx === 0 ? 0 : cursor;
      const share = sumNeed > 0 ? needs[idx] / sumNeed : 1 / chosenScenes.length;
      const minEnd = squeeze < 1 ? Math.round((start + needs[idx] * squeeze) * 100) / 100 : Math.ceil((start + needs[idx]) * 100) / 100;
      const propEnd = Math.round((start + needs[idx] * squeeze + extra * share) * 10) / 10;
      const end = idx === chosenScenes.length - 1 ? L : Math.min(L - 0.5, squeeze < 1 ? minEnd : Math.max(minEnd, propEnd));
      cursor = end;
      return {id: s.id, start, end, lines: s.lines};
    });

    cuts[String(L)] = {
      scenes: windows,
      note: L <= 6 ? 'Short cut: hook → offer/CTA.' : L <= 10 ? 'Medium cut: 3 scenes.' : 'Full story.',
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
  renderSheets = defaultRenderSheets,
  bakeScreens = defaultBakeScreens,
}) {
  setJobRunSink(store.runs);

  // Propagate author from x-forma-author header or FORMA_AUTHOR env across async execution
  app.use((req, _res, next) => {
    const existing = authorStorage.getStore();
    if (existing) return next();
    const author = req.headers?.['x-forma-author'] || process.env.FORMA_AUTHOR || null;
    authorStorage.run(author, next);
  });

  // What holds a campaign right now. The store's runs, plus every step this server is still running that the store
  // does not list (round 8: the check after a build answered 409 while the list was empty), each with what it is
  // doing (job.status: "Checking the frames…", "Baking the interface…"). Campaign names are cached: the list is polled.
  const campaignNames = new Map();
  const campaignName = async id => {
    const hit = campaignNames.get(id);
    if (hit && Date.now() - hit.at < 300000) return hit.name;
    const name = (await history.get(id).catch(() => null))?.name || null;
    campaignNames.set(id, {name, at: Date.now()});
    return name;
  };
  app.get('/api/runs/active', async (_req, res) => {
    const raw = await Promise.race([store.runs.active(), new Promise(r => setTimeout(() => r(null), 8000))]).catch(() => null);
    const list = raw ? [...raw] : [];
    const known = new Set(list.map(r => r.id));
    for (const [campaignId, requestId] of runningJob) {
      const job = getJob(requestId);
      if (known.has(requestId)) {
        const r = list.find(x => x.id === requestId);
        if (job?.status) r.statusText = job.status;   // fresher than the last heartbeat
        continue;
      }
      list.push({id: requestId, campaignId, projectId: job?.project || null, task: job?.task || 'step', author: null, status: 'running',
        statusText: job?.status || '', costs: job?.costs, startedAt: job ? new Date(job.started).toISOString() : null,
        elapsed: job ? Date.now() - job.started : null, local: true});
    }
    const runs = await Promise.all(list.map(async r => ({...r, campaignName: r.campaignId ? await campaignName(r.campaignId) : null})));
    res.set('Cache-Control', 'no-store').json({runs, ...(raw ? {} : {partial: 'The store did not answer within 8 s: only this server\'s own steps are listed.'})});
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

  // A campaign made for a client request (studio-campaign.mjs): the request id is the campaign id, so accepting twice
  // finds the campaign made the first time. `client` carries the request and its brief; `files` land in the project's
  // assets next to the brand's (the client's references for this campaign).
  // Two accepts at once (a double click, two tabs) share one making instead of racing to write the same id.
  const makingClientCampaign = new Map();
  function createClientCampaign(args) {
    if (makingClientCampaign.has(args.id)) return makingClientCampaign.get(args.id);
    const p = makeClientCampaign(args).finally(() => makingClientCampaign.delete(args.id));
    makingClientCampaign.set(args.id, p);
    return p;
  }
  async function makeClientCampaign({id, brandId, brandVersion, setup, name, client, files = []}) {
    const existing = await history.get(id).catch(() => null);
    if (existing?.type === 'campaign') return hydrateCampaign(existing);
    const project = randomUUID();
    const dir = folder(project);
    await fs.mkdir(path.join(dir, 'assets'), {recursive: true});
    await store.registerProject(project);
    const rec = {...createCampaignRecord({project, setup, name}), id, client, brandId, brandVersion};
    for (const file of files) {
      const dest = path.join(dir, 'assets', file.name);
      await fs.mkdir(path.dirname(dest), {recursive: true});
      await fs.writeFile(dest, file.bytes);
    }
    await materializeBrand(brandId, brandVersion, project, dir);   // also uploads the references written above
    return hydrateCampaign(await history.record(rec));
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
  // A list item is rebuilt only when its campaign changed (updatedAt/version) or a run started or ended on it.
  const listItemCache = new Map();
  app.get('/api/campaigns', async (req, res) => {
    const {before, limit, author, excludeAuthor} = req.query;
    const archived = req.query.archived === '1' ? 'only' : undefined;
    const page = await history.list({type: 'campaign', before, limit, author, excludeAuthor, archived});
    // Campaigns merged into another one by scripts/migrate-to-cloud.mjs --merge-style-forks live on as its variants.
    const items = await Promise.all(page.items.filter(c => c.status !== 'merged').map(async raw => {
      const key = [raw.updatedAt, raw.version, runningJob.get(raw.id) || ''].join('|');
      const hit = listItemCache.get(raw.id);
      if (hit && hit.key === key) return hit.item;
      const item = await listItem(raw);
      listItemCache.set(raw.id, {key, item});
      return item;
    }));
    res.set('Cache-Control', 'no-store').json({items, next: page.next, total: page.total});
  });

  // POST /api/campaigns/:id/archive {archived} — hides a campaign from the list (archived:false brings it back).
  app.post('/api/campaigns/:id/archive', async (req, res) => {
    const campaign = await requireCampaign(req.params.id);
    if (runningJob.get(campaign.id)) throw conflict('Wait for the current step to finish before archiving.', 409);
    const archived = req.body?.archived !== false;
    await history.update(campaign.id, {status: archived ? 'archived' : null});
    listItemCache.delete(campaign.id);
    res.json({id: campaign.id, archived});
  });

  async function listItem(raw) {
    {
      const hydrated = await hydrateCampaign(raw, {costs: false});
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
    }
  }

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

  // POST /api/campaigns/:id/remember {text}: a client decision that outlives this note. It goes first into this
  // campaign's brand notes (in force from the next step) and, for a saved brand, into its next version.
  app.post('/api/campaigns/:id/remember', async (req, res) => {
    const campaign = await requireCampaign(req.params.id);
    const text = typeof req.body?.text === 'string' ? req.body.text.replace(/\s+/g, ' ').trim() : '';
    if (!text || text.length > 500) throw conflict('Write the decision to remember (up to 500 characters).', 400);
    const assets = path.join(folder(campaign.project), 'assets');
    await store.sync.down(campaign.project, {dataDir});
    const current = await brandNotesFor(campaign, assets);
    const notes = addClientDecision(current || `# ${campaign.name || 'Brand'} — brand notes\n`, text);
    await fs.mkdir(assets, {recursive: true});
    await fs.writeFile(path.join(assets, BRAND_NOTES_FILE), notes);
    await store.sync.up(campaign.project, {path: 'assets/' + BRAND_NOTES_FILE, dataDir});
    const brand = campaign.brandId ? await rememberForBrand(campaign.brandId, text, notes) : null;
    res.json({notes, brandVersion: brand?.version ?? null});
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
      await timed(log, 'Sign-in checked', () => checkProvider(sel.mode, sel.billing));
      await timed(log, 'Project files ready', () => store.sync.down(campaign.project, {dataDir}));
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
        const usedIdeas = currentScenario ? [] : await usedIdeasForBrand(campaign);
        if (usedIdeas.length) log(`Ideas this brand already used: ${usedIdeas.length} earlier campaign${usedIdeas.length === 1 ? '' : 's'}`);
        const user = scenarioMessage({files, brief: campaign.client?.briefText || undefined, notes: notes || undefined, current: currentScenario, setup: campaign.setup, brandNotes: await brandNotesFor(campaign, assets, log), usedIdeas});
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
      await timed(log, 'Sign-in checked', () => checkProvider(sel.mode, sel.billing));
      await timed(log, 'Project files ready', () => store.sync.down(campaign.project, {dataDir}));
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
      await timed(log, 'Sign-in checked', () => checkProvider(sel.mode, sel.billing));
      await timed(log, 'Project files ready', () => store.sync.down(campaign.project, {dataDir}));
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

  // POST /api/campaigns/:id/styles {requestId, variant?, revise?: 'all'|0|1|2, feedback?}
  // Without `revise`: a fresh pitch of three directions. With it: a revision round over the variant's current three.
  app.post('/api/campaigns/:id/styles', async (req, res) => {
    const campaign = await requireCampaign(req.params.id);
    await ensureIdle(campaign.id);
    if (!campaign.steps.scenario.approvedAt || campaign.steps.scenario.stale || campaign.steps.scenario.needs?.length) {
      throw conflict('Approve the script first.', 409);
    }

    const targetVarCheck = findTargetVariant(campaign.variants, req.body?.variant, campaign.activeVariant);
    const rawRevise = req.body?.revise;
    const revise = rawRevise === undefined || rawRevise === null ? null
      : rawRevise === 'all' || [0, 1, 2].includes(rawRevise) ? rawRevise : undefined;
    if (revise === undefined) throw conflict('Choose which direction to revise.', 400);
    const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback.trim().slice(0, 4000) : '';
    if (revise === 'all' && !feedback) throw conflict('Describe what should change in all three directions.', 400);
    let previous = null;
    const parentEntryId = revise === null ? null : targetVarCheck.styles?.entryId || null;
    if (revise !== null) {
      previous = parentEntryId ? (await history.get(parentEntryId))?.output?.styles : null;
      if (!Array.isArray(previous) || previous.length !== 3) throw conflict('Generate three visual directions first.', 409);
    }
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
      await timed(log, 'Sign-in checked', () => checkProvider(sel.mode, sel.billing));
      await timed(log, 'Project files ready', () => store.sync.down(campaign.project, {dataDir}));
      const files = await listAssets(assets).catch(() => []);
      const scEntry = await history.get(campaign.steps.scenario.entryId);
      const scenarioObj = scEntry?.output?.scenario;
      if (!scenarioObj) throw conflict('Script not found.', 409);

      const stepTitle = revise === null ? 'Three visual directions'
        : revise === 'all' ? 'Reworking all three directions'
        : `Reworking direction ${revise + 1} · ${previous[revise].name}`;
      log(`Step 2 · ${stepTitle} · ${sel.mode}`, {level: 'step'});
      if (feedback) log('Notes: ' + (feedback.length > 240 ? feedback.slice(0, 240) + '…' : feedback));
      job.sketchTotal = typeof revise === 'number' ? 1 : 3;
      let pitch;
      if (sel.mode === 'demo') {
        await wait(350, controller.signal);
        const raw = await fs.readFile(path.join(root, 'fixtures', 'styles.json'), 'utf8');
        pitch = parseStyleChoices(raw);
        if (revise !== null) {
          const bump = name => {
            const m = /^(.*) · v(\d+)$/.exec(name);
            return m ? `${m[1]} · v${Number(m[2]) + 1}` : name + ' · v2';
          };
          pitch = {styles: previous.map((s, i) => revise === 'all' || revise === i ? {...pitch.styles[i], name: bump(s.name)} : s)};
        }
        job.sketches = typeof revise === 'number' ? [pitch.styles[revise].svg] : pitch.styles.map(s => s.svg);
        log('Demo directions ready: ' + pitch.styles.map(s => s.name).join(' · '), {level: 'done'});
      } else {
        const brandNotes = await brandNotesFor(campaign, assets, log);
        let system = stylesPrompt({kind: campaign.setup.kind, scenario: scenarioObj, setup: campaign.setup});
        let user = stylesMessage({setup: campaign.setup, scenario: scenarioObj, files, brandNotes});
        if (revise !== null) {
          system += '\n\n' + styleRevisionPrompt({previous, revise, hasFeedback: Boolean(feedback)});
          user = styleRevisionMessage({setup: campaign.setup, scenario: scenarioObj, files, previous, feedback, revise, brandNotes});
        }
        const onText = text => {
          job.text = text;
          const found = streamedSketches(text);
          if (found.length > job.sketches.length) {
            job.sketches = found;
            log('Sketch ' + found.length + ' of ' + job.sketchTotal + ' ready', {level: 'done'});
          }
        };
        const rawText = await runModelText({
          mode: sel.mode, billing: sel.billing, model: sel.model, effort: sel.effort,
          dir: assets, system, user, task: 'style', controller, log, onText,
        });
        pitch = revise === null ? parseStyleChoices(rawText) : parseStyleRevision(rawText, {previous, revise});
        log((revise === null ? 'Three directions ready: ' : 'Revised directions ready: ') + pitch.styles.map(s => s.name).join(' · '), {level: 'done'});
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
        input: {
          setup: campaign.setup, scenarioId: scEntry.id, files,
          ...(revise !== null ? {revise, feedback, parentId: parentEntryId} : {}),
        },
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
        // A revision of one direction keeps the client's choice when a different direction was chosen.
        const chosen = targetVar.styles?.chosenIndex;
        const keepChoice = typeof revise === 'number' && chosen !== null && chosen !== undefined && chosen !== revise;
        if (!keepChoice && previous?.some(s => s?.name && s.name === targetVar.label)) {
          targetVar.label = `Style ${variants.indexOf(targetVar) + 1}`;
        }
        targetVar.styles = keepChoice
          ? {...targetVar.styles, entryId: entry.id}
          : {entryId: entry.id, chosenIndex: null, direction: ''};
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
    const built = v => Boolean(v.preview?.entryId || v.final?.entryId);
    const sameSet = v => v.styles?.entryId === targetVar.styles.entryId;
    const applyChoice = v => {
      const prevStyleNames = new Set(styles.map(s => s?.name).filter(Boolean));
      const hadAutoLabel = !v.label || /^(?:Style|Стиль) \d+$/.test(v.label) || prevStyleNames.has(v.label);
      v.styles.chosenIndex = index;
      v.styles.direction = direction;
      if (customLabel) v.label = customLabel;
      else if (chosen.name && hadAutoLabel) v.label = chosen.name;
    };

    // Looking at a direction is not making a style. A style that already has a preview or final for this
    // direction is reopened as it is; otherwise the choice goes into the one draft slot (no preview yet) of
    // this set of directions. §4.2 still holds: a variant with a preview is never mutated by a style choice.
    const existing = variants.find(v => v.id !== targetVar.id && sameSet(v) && built(v) && v.styles.chosenIndex === index);
    if (existing && !customLabel && !(typeof req.body?.direction === 'string' && req.body.direction.trim())) {
      activeVariant = existing.id;
    } else if (built(targetVar)) {
      const draft = variants.find(v => v.id !== targetVar.id && sameSet(v) && !built(v));
      if (draft) {
        applyChoice(draft);
        activeVariant = draft.id;
      } else {
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
      }
    } else {
      applyChoice(targetVar);
    }

    // Drop leftover drafts of this set (no preview, no final): at most one draft per set, and only the active one.
    for (let i = variants.length - 1; i >= 0; i--) {
      const v = variants[i];
      if (v.id !== activeVariant && sameSet(v) && !built(v)) variants.splice(i, 1);
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
    let pendingFix = null;
    try {
      await timed(log, 'Sign-in checked', () => checkProvider(sel.mode, sel.billing));
      await timed(log, 'Project files ready', () => store.sync.down(campaign.project, {dataDir}));
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
        // One generated hero picture, so the preview can be judged by its light and material, not by grey boxes.
        const heroMedia = mediaKey() ? PREVIEW_MEDIA : null;
        if (!heroMedia) log('Image generation is off (no OPENROUTER_API_KEY): the preview uses placeholders only.', {level: 'warn'});
        const system = previewPrompt({kind: campaign.setup.kind, scenario: scenarioObj, style: stylePayload, setup: campaign.setup, media: heroMedia});
        const user = previewMessage({setup: campaign.setup, scenario: scenarioObj, style: stylePayload, files, brandNotes: await brandNotesFor(campaign, assets, log)});
        srcHtml = await runModelHtml({
          mode: sel.mode, billing: sel.billing, model: sel.model, effort: sel.effort,
          dir: assets, system, user, task: 'preview', media: heroMedia, controller, log, onText,
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

      pendingFix = await afterBuild({campaign, entry, stage: 'preview', sel, log, job});
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
      if (pendingFix && runStatus === 'done') startAutoFix(pendingFix);
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
    let pendingFix = null;
    try {
      if ((media.images || media.video) && sel.mode !== 'demo' && !mediaKey()) {
        throw conflict('To generate images, add OPENROUTER_API_KEY to .env and restart the server.', 503);
      }
      await timed(log, 'Sign-in checked', () => checkProvider(sel.mode, sel.billing));
      await timed(log, 'Project files ready', () => store.sync.down(campaign.project, {dataDir}));

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
          brandNotes: await brandNotesFor(campaign, assets, log),
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

      pendingFix = await afterBuild({campaign, entry, stage: 'final', sel, log, job});
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
      if (pendingFix && runStatus === 'done') startAutoFix(pendingFix);
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
  // ---- The art director's look: render the built entry, let a model look at it, keep its notes ----

  const lightReview = r => r && ({
    id: r.id, createdAt: r.createdAt, stage: r.stage, author: r.author || null,
    for: r.input?.for || null, variantId: r.input?.variantId || null,
    summary: r.output?.summary || '', notes: r.output?.notes || [], sheets: r.output?.sheets || [], problems: r.output?.problems || {errors: [], blank: []},
    applied: r.output?.applied || null, cost: r.cost || null, mode: r.mode, model: r.model,
  });

  async function entryScenario(campaign, entry) {
    const scId = entry.input?.scenarioId || campaign.steps.scenario.entryId;
    const sc = scId ? await history.get(scId) : null;
    return applyCopyPatch(sc?.output?.scenario, entry.input?.copyPatch || {});
  }

  async function chosenStyleOf(variant) {
    const st = variant?.styles?.entryId ? await history.get(variant.styles.entryId) : null;
    const chosen = st?.output?.styles?.[variant.styles.chosenIndex];
    return chosen ? {name: chosen.name, idea: chosen.idea, direction: variant.styles.direction || chosen.direction} : null;
  }

  // POST /api/campaigns/:id/review {requestId, entryId}
  app.post('/api/campaigns/:id/review', async (req, res) => {
    const campaign = await requireCampaign(req.params.id);
    const entry = validId(req.body?.entryId) ? await history.get(req.body.entryId) : null;
    if (!entry || entry.campaign !== campaign.id || !['preview', 'creative'].includes(entry.type) || !entry.output?.path) {
      throw conflict('Choose a built preview or final to look at.', 400);
    }
    const stage = entry.type === 'preview' ? 'preview' : 'final';
    const sel = stepSelection(campaign.setup, 'review');
    if (sel.mode === 'codex') throw conflict('The art director’s look works with Claude. Switch the campaign model to Claude to use it.', 409);

    const requestId = validId(req.body?.requestId) ? req.body.requestId : randomUUID();
    await startCampaignRun(campaign, requestId, 'review');
    const dir = folder(campaign.project), assets = path.join(dir, 'assets');
    const job = createJob(requestId, {task: 'review', mode: sel.mode, project: campaign.project, campaign: campaign.id});
    const log = logger(job, {mediaURL: file => assetURL(campaign.project, file)});
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });

    let runStatus = 'done';
    let entryId = null;
    try {
      await timed(log, 'Sign-in checked', () => checkProvider(sel.mode, sel.billing));
      await timed(log, 'Project files ready', () => store.sync.down(campaign.project, {dataDir}));
      const variant = findVariantForEntry(campaign.variants, entry, campaign.activeVariant);
      const scenario = await entryScenario(campaign, entry);
      log(`Art director · looking at the ${stage}${sel.model ? ' · ' + sel.model : ''}`, {level: 'step'});

      let sheets = [];
      let problems = {errors: [], blank: []};
      let result;
      if (sel.mode === 'demo') {
        await wait(300, controller.signal);
        result = {summary: 'Demo look: the frame reads well; one demo note to try the flow.', notes: [{priority: 'P2', where: 'Demo · whole frame', problem: 'A demo note: nothing was rendered or judged.', fix: 'Apply it to see the round trip.'}]};
      } else {
        const rel = 'review/' + requestId;
        const outDir = path.join(assets, rel);
        // The check after the build already rendered these frames: look at them instead of rendering again.
        const checked = entry.output?.check;
        const reuse = checked?.sheets?.length && !checked.error
          && (await Promise.all(checked.sheets.map(sh => fs.access(path.join(assets, sh.rel)).then(() => true, () => false)))).every(Boolean);
        if (reuse) {
          log('Using the frames of the check after the build');
          sheets = checked.sheets;
          problems = {errors: [], blank: [], green: [], ...checked.problems};
        } else {
          log('Rendering frames in headless Chrome…');
          const rendered = await renderSheets({
            url: previewURL + entry.output.path, stage, setup: campaign.setup, scenario,
            outDir, publicBase: assetURL(campaign.project, rel), log,
          });
          sheets = rendered.map(s => ({name: s.name, title: s.title, rel: rel + '/' + s.name + '.png', url: s.url, frames: s.frames}));
          problems = rendered.problems || {errors: [], blank: []};
        }
        let previewSheet = null;
        const approvedPreview = stage === 'final' && variant?.preview?.entryId ? await history.get(variant.preview.entryId) : null;
        if (approvedPreview?.output?.path) {
          const prevRendered = await renderSheets({
            url: previewURL + approvedPreview.output.path, stage: 'preview', setup: campaign.setup,
            scenario: await entryScenario(campaign, approvedPreview), outDir: path.join(outDir, 'approved'),
            publicBase: assetURL(campaign.project, rel + '/approved'), log: () => {},
          }).catch(err => { log('Could not render the approved preview: ' + err.message, {level: 'warn'}); return []; });
          if (prevRendered[0]) previewSheet = {title: 'Approved preview', rel: rel + '/approved/' + prevRendered[0].name + '.png'};
        }
        for (const s of sheets) log('Contact sheet · ' + s.title, {media: {kind: 'image', file: s.rel, attached: true}});
        const raw = await runModelText({
          mode: sel.mode, billing: sel.billing, model: sel.model, effort: sel.effort, dir: assets,
          system: reviewPrompt({stage, kind: campaign.setup.kind}),
          user: reviewMessage({stage, setup: campaign.setup, scenario, style: await chosenStyleOf(variant), brandNotes: await brandNotesFor(campaign, assets, log), sheets, previewSheet, problems}),
          task: 'review', controller, log, onText: text => { job.text = text; },
        });
        result = parseReview(raw);
        await store.sync.up(campaign.project, {dataDir});
      }
      log(result.notes.length ? `Art director left ${result.notes.length} note${result.notes.length === 1 ? '' : 's'}` : 'Art director found nothing serious', {level: 'done'});

      const rec = await history.record({
        id: requestId, type: 'review', status: 'ok', campaign: campaign.id, stage, kind: campaign.setup.kind,
        project: campaign.project, mode: sel.mode, model: sel.model, effort: sel.effort,
        durationMs: Date.now() - job.started,
        input: {for: entry.id, variantId: variant?.id || null},
        output: {summary: result.summary, notes: result.notes, sheets, problems, applied: null},
        cost: job.costs, log: job.events,
      });
      entryId = rec.id;
      const variants = structuredClone(campaign.variants);
      const v = variants.find(x => x.id === variant?.id);
      if (v) v.cost = addCost(v.cost, job.costs);
      const updated = await history.update(campaign.id, {variants, cost: addCost(campaign.cost, job.costs)});
      res.json({review: lightReview(rec), campaign: await hydrateCampaign(updated)});
    } catch (error) {
      runStatus = controller.signal.aborted ? 'cancelled' : 'error';
      log((controller.signal.aborted ? 'Look stopped' : 'Look failed: ' + error.message), {level: controller.signal.aborted ? 'warn' : 'error'});
      throw error;
    } finally {
      await finishCampaignRun(campaign.id, requestId, job, {status: runStatus, entryId});
    }
  });

  // GET /api/campaigns/:id/reviews — newest first
  app.get('/api/campaigns/:id/reviews', async (req, res) => {
    const campaign = await requireCampaign(req.params.id);
    const page = await history.list({type: 'review', campaign: campaign.id, limit: 20});
    const full = await Promise.all(page.items.map(r => (r.output ? r : history.get(r.id))));
    res.set('Cache-Control', 'no-store').json(full.filter(Boolean).map(lightReview));
  });

  // Ideas the brand's earlier campaigns already used, newest first: the script step is asked not to repeat them.
  async function usedIdeasForBrand(campaign, limit = 8) {
    if (!campaign.brandId) return [];
    const others = [];
    let before;
    for (let page = 0; page < 3 && others.length < limit * 2; page++) {
      const res = await history.list({type: 'campaign', before, limit: 200}).catch(() => ({items: []}));
      others.push(...res.items.filter(c => c.id !== campaign.id && c.brandId === campaign.brandId && c.status !== 'merged' && c.status !== 'archived'));
      before = res.next;
      if (!before) break;
    }
    others.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    const out = [];
    for (const c of others) {
      if (out.length >= limit) break;
      const sc = c.steps?.scenario?.entryId ? (await history.get(c.steps.scenario.entryId).catch(() => null))?.output?.scenario : null;
      if (!sc?.theme && !sc?.idea) continue;
      const pictures = [];
      for (const v of c.variants || []) {
        if (!v.preview?.entryId || !v.styles?.entryId) continue;
        const style = (await history.get(v.styles.entryId).catch(() => null))?.output?.styles?.[v.styles.chosenIndex];
        if (style?.idea && !pictures.includes(style.idea)) pictures.push(String(style.idea).slice(0, 200));
      }
      out.push({campaign: c.name, theme: String(sc.theme || '').slice(0, 200), idea: String(sc.idea || '').slice(0, 300), ...(pictures.length ? {pictures: pictures.slice(0, 4)} : {})});
    }
    return out;
  }

  // ---- The check after a build (no model): frames, browser errors, flat and green frames ----
  // Runs on the server after every preview, final and revision, whoever started it (the app, a script, the lab).
  // Hard problems are fixed once by a revision of its own; the art director's look (UI) reuses the frames.
  const checkEnabled = sel => sel.mode !== 'demo' && process.env.FORMA_CHECK !== '0';
  async function checkBuild(campaign, entry, stage, log) {
    const assets = path.join(folder(campaign.project), 'assets');
    const rel = 'review/check-' + entry.id;
    const at = new Date().toISOString();
    try {
      log('Checking the frames in headless Chrome…');
      const rendered = await renderSheets({
        url: previewURL + entry.output.path, stage, setup: campaign.setup, scenario: await entryScenario(campaign, entry),
        outDir: path.join(assets, rel), publicBase: assetURL(campaign.project, rel), log: () => {},
      });
      const sheets = rendered.map(sh => ({name: sh.name, title: sh.title, rel: rel + '/' + sh.name + '.png', url: sh.url, frames: sh.frames}));
      const problems = {errors: [], blank: [], green: [], ...(rendered.problems || {})};
      const hard = hardProblems(problems);
      await store.sync.up(campaign.project, {dataDir}).catch(() => {});
      log(hard.length ? 'The check found: ' + hard.join(' · ') : 'The check found no broken frames', {level: hard.length ? 'warn' : 'done'});
      return {at, sheets, problems, hard};
    } catch (err) {
      log('The check could not render the frames: ' + err.message, {level: 'warn'});
      return {at, error: err.message, sheets: [], problems: {errors: [], blank: [], green: []}, hard: []};
    }
  }

  async function buildVideoProblems(campaign, entry, job) {
    try {
      const dir = folder(campaign.project);
      const rev = entry.output?.revision || String(entry.output?.path || '').split('/').pop().replace(/\.html$/, '');
      const html = await fs.readFile(path.join(dir, rev + '.src.html'), 'utf8').catch(() => fs.readFile(path.join(dir, rev + '.html'), 'utf8').then(uninject));
      const assets = await listAssets(path.join(dir, 'assets')).catch(() => []);
      return videoProblems({events: job?.events || [], html, assets});
    } catch { return []; }
  }

  // Screens in clips (FORMA.screen): the interface baked into each clip per language before anything looks at the
  // build, so the check, the art director, the client and the exports all see the finished clip. FORMA_BAKE=0 turns it off.
  async function bakeBuild(campaign, entry, stage, log) {
    if (process.env.FORMA_BAKE === '0') return null;
    const rev = entry.output.revision || String(entry.output.path || '').split('/').pop().replace(/\.html$/, '');
    const langs = campaign.setup.languages?.length ? campaign.setup.languages : ['en'];
    try {
      const r = await bakeScreens({
        projectDir: folder(campaign.project), url: previewURL + entry.output.path, rev,
        langs: stage === 'preview' ? langs.slice(0, 1) : langs, formats: campaign.setup.formats, log,
      });
      if (!r.screens.length && !r.problems.length) return null;
      const made = r.screens.filter(x => !x.cached).length;
      log(r.problems.length ? 'Screens in clips: ' + r.problems.join(' · ') : 'Screens baked into ' + r.screens.length + ' clip' + (r.screens.length > 1 ? 's' : '') + (made < r.screens.length ? ' (' + (r.screens.length - made) + ' unchanged)' : ''),
        {level: r.problems.length ? 'warn' : 'done'});
      return {at: new Date().toISOString(), baked: r.screens.map(({clip, lang, file, cached}) => ({clip, lang, file, cached})), problems: r.problems};
    } catch (err) {
      log('The screens could not be baked: ' + err.message, {level: 'warn'});
      return {at: new Date().toISOString(), baked: [], problems: ['The screen bake failed: ' + err.message]};
    }
  }

  // Bakes screens, stores the check on the entry and decides on a fix: once per chain, never for a fix itself, unless turned off.
  async function afterBuild({campaign, entry, stage, sel, log, job}) {
    if (sel.mode === 'demo') return null;
    const video = await buildVideoProblems(campaign, entry, job);
    if (video.length) log('Video: ' + video.join(' · '), {level: 'warn'});
    const screens = await bakeBuild(campaign, entry, stage, log);
    if (!checkEnabled(sel)) {
      if (video.length) {
        await history.update(entry.id, {output: {...entry.output, check: {at: new Date().toISOString(), sheets: [], problems: {errors: [], blank: [], green: [], video}, hard: hardProblems({video})}, ...(screens ? {screens} : {})}}).catch(() => {});
        return null;
      }
      if (screens) {
        await store.sync.up(campaign.project, {dataDir}).catch(() => {});
        await history.update(entry.id, {output: {...entry.output, screens}}).catch(() => {});
      }
      return null;
    }
    const check = await checkBuild(campaign, entry, stage, log);
    if (screens?.problems.length) check.problems.screens = screens.problems;
    if (video.length) check.problems.video = video;
    if (screens?.problems.length || video.length) check.hard = hardProblems(check.problems);
    const fix = check.hard.length && campaign.setup.review?.autoFix !== false && !entry.input?.autoFixOf
      ? {requestId: randomUUID(), status: 'running'} : null;
    if (fix) {
      check.fix = fix;
      log('Forma fixes these on its own (one revision), then the art director looks.', {level: 'step'});
    }
    const output = {...entry.output, check, ...(screens ? {screens} : {})};
    await history.update(entry.id, {output}).catch(() => {});
    return fix ? {...fix, entry: {...entry, output}, stage, problems: check.problems, sel} : null;
  }

  // Runs the fix after the build's own run has ended, as a revision with the problems as its message.
  function startAutoFix(fix) {
    const req = {body: {
      message: fixMessage(fix.problems), requestId: fix.requestId, autoFixOf: fix.entry.id,
      mode: fix.sel.mode, billing: fix.sel.billing, model: fix.sel.model, effort: fix.sel.effort,
    }};
    const res = new EventEmitter();
    Object.assign(res, {writableFinished: false, status() { return res; }, json(body) { res.body = body; res.writableFinished = true; return res; }});
    const mark = async (status, extra = {}) => {
      const cur = await history.get(fix.entry.id).catch(() => null);
      if (cur?.output?.check) await history.update(cur.id, {output: {...cur.output, check: {...cur.output.check, fix: {...cur.output.check.fix, status, ...extra}}}}).catch(() => {});
    };
    setTimeout(() => {
      reviseCampaignEntry(req, res, fix.entry)
        .then(() => mark('done', {entryId: res.body?.historyId || fix.requestId}))
        .catch(err => { console.error('[check] the fix failed:', err.message); return mark('failed', {error: err.message}); });
    }, 0);
  }

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

    // A final keeps the media it was built with, so a revision can make a picture again; the request can add more.
    const builtMedia = stage === 'final' && (sel.mode === 'demo' || mediaKey()) ? parent.input?.media || {} : {};
    const media = stage === 'final'
      ? {
          images: req.body?.media?.images === true || builtMedia.images === true,
          video: campaign.setup.kind !== 'poster' && (req.body?.media?.video === true || builtMedia.video === true),
        }
      : sel.mode !== 'demo' && mediaKey() ? {...PREVIEW_MEDIA} : {images: false, video: false};

    if ((media.images || media.video) && sel.mode !== 'demo' && !mediaKey()) {
      throw conflict('To generate images, add OPENROUTER_API_KEY to .env and restart the server.', 503);
    }
    const startTimes = [];
    const t0 = Date.now();
    await checkProvider(sel.mode, sel.billing);
    startTimes.push(['Sign-in checked', Date.now() - t0]);

    const requestId = validId(req.body?.requestId) ? req.body.requestId : randomUUID();
    await startCampaignRun(campaign, requestId, stage);

    const dir = folder(parent.project), assets = path.join(dir, 'assets');
    const t1 = Date.now();
    await store.sync.down(parent.project, {dataDir});
    startTimes.push(['Project files ready', Date.now() - t1]);
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
    for (const [label, ms] of startTimes) if (ms >= 300) log(label + ' · ' + (ms / 1000).toFixed(1) + ' s', {level: ms >= 5000 ? 'warn' : 'info'});
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
    let pendingFix = null;
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
        // The frames the check rendered after the parent was built: the designer sees what the client sees.
        const frames = [];
        for (const sh of parent.output?.check?.sheets || []) {
          if (await fs.access(path.join(assets, sh.rel)).then(() => true, () => false)) frames.push(sh);
        }
        const prompt = revisionMessage({
          workFile,
          files,
          brandNotes: await brandNotesFor(campaign, assets, log),
          thread: chain,
          message,
          attachments,
          setup: campaign.setup,
          stage,
          scenario: effectiveScenario,
          style: targetVarInit.styles?.direction || campaign.steps.styles.direction,
          frames,
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
          brandNotes: await brandNotesFor(campaign, assets, log),
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
          autoFixOf: validId(req.body?.autoFixOf) ? req.body.autoFixOf : undefined,
        },
        output: {
          ...withoutCheck(parent.output),
          revision,
          path: rel,
          reply: cleanReply || 'Done.',
        },
        media: generatedMedia(job, parent.project),
        cost: job.costs,
        log: job.events,
      });
      entryId = newEntry.id;
      if (validId(req.body?.reviewId)) {
        const rv = await history.get(req.body.reviewId).catch(() => null);
        if (rv?.type === 'review' && rv.campaign === campaign.id) {
          await history.update(rv.id, {output: {...rv.output, applied: {entryId: newEntry.id, at: new Date().toISOString(), auto: req.body?.auto === true, notes: Array.isArray(req.body?.reviewNotes) ? req.body.reviewNotes.filter(Number.isInteger) : null}}}).catch(() => {});
        }
      }

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

      pendingFix = await afterBuild({campaign, entry: newEntry, stage, sel, log, job});
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
      if (pendingFix && runStatus === 'done') startAutoFix(pendingFix);
    }
  }

  return {reviseCampaignEntry, createClientCampaign};
}
