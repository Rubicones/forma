// Scenario JSON v2 schema, parser and validator (structural + reading-time).
import {z} from 'zod';
import {windowNeed, verdict} from './shared/reading.mjs';

// answer: the turn said in words, how the product resolves the hook's tension. Every cut of a spot says it (round 9:
// short cuts went hook → button, leaving the picture to explain, and lost their sense).
export const ROLES = ['hook', 'answer', 'sub', 'proof', 'number', 'label', 'offer', 'cta', 'legal'];
const NEVER_HIDE_ROLES = new Set(['hook', 'answer', 'offer', 'cta']);
const RANK = {ok:0, tight:1, fail:2};

const lineSchema = z.object({
  role: z.enum(ROLES),
  scene: z.string().min(1),
  maxChars: z.number().int().positive(),
  hideIn: z.array(z.string()).default([]),
  text: z.record(z.string(), z.string()),
});

const sceneSchema = z.object({
  id: z.string().min(1),
  beat: z.string().min(1),
  story: z.string().optional().default(''),
  lines: z.array(z.string()),
});

const windowSchema = z.object({
  id: z.string().min(1),
  start: z.number(),
  end: z.number(),
  lines: z.array(z.string()),
});

const cutSchema = z.object({
  scenes: z.array(windowSchema).min(1),
  note: z.string().optional().default(''),
});

export const scenarioSchema = z.object({
  version: z.literal(2).default(2),
  kind: z.enum(['poster', 'single', 'multi']),
  theme: z.string().min(1),
  idea: z.string().min(1),
  languages: z.array(z.string().min(1)).min(1),
  lines: z.record(z.string(), lineSchema),
  scenes: z.array(sceneSchema).min(1),
  cuts: z.record(z.string(), cutSchema).optional(),
  notes: z.string().optional(),
});

// Strips Markdown code fences, parses JSON and validates against scenarioSchema.
export function parseScenario(text) {
  const raw = String(text ?? '')
    .trim()
    .replace(/^`{3}(?:jsonc?|javascript)?\s*/i, '')
    .replace(/`{3}\s*$/, '')
    .trim();
  if (!raw) throw Error('The model returned an empty script.');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw Error('Could not parse the script JSON: ' + err.message);
  }
  const res = scenarioSchema.safeParse(parsed);
  if (!res.success) {
    const details = res.error.issues.map(i => (i.path.length ? i.path.join('.') + ': ' : '') + i.message).join('; ');
    throw Error('Invalid script format: ' + details);
  }
  return res.data;
}

export function missingLanguages(scenario, languages = []) {
  if (!scenario || typeof scenario !== 'object') return [...languages];
  const lineEntries = Object.values(scenario.lines || {});
  const declared = new Set(Array.isArray(scenario.languages) ? scenario.languages : []);
  return languages.filter(lang => {
    if (!declared.has(lang)) return true;
    if (!lineEntries.length) return true;
    return lineEntries.some(line => !String(line?.text?.[lang] ?? '').trim());
  });
}

export function missingCuts(scenario, lengths = []) {
  if (!scenario || scenario.kind !== 'multi') return [];
  const cuts = scenario.cuts || {};
  return lengths.map(Number).filter(len => !cuts[String(len)] || !Array.isArray(cuts[String(len)].scenes) || !cuts[String(len)].scenes.length);
}

// Validates scenario structure, cross-references, cut windows and reading times.
// Returns {errors:[], warnings:[], cells:{[length]:{[sceneId]:{need, have, verdict, byLang}}}}.
export function validateScenario(scenario, setup = {}) {
  const errors = [];
  const warnings = [];
  const cells = {};

  const parsed = scenarioSchema.safeParse(scenario);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`Schema error at ${issue.path.join('.') || 'root'}: ${issue.message}`);
    }
    return {errors, warnings, cells};
  }
  const sc = parsed.data;

  const expectedKind = setup.kind || sc.kind;
  if (sc.kind !== expectedKind) {
    errors.push(`Kind mismatch: scenario has "${sc.kind}", expected "${expectedKind}".`);
  }

  const langs = Array.isArray(setup.languages) && setup.languages.length ? setup.languages : sc.languages;
  const lineKeys = Object.keys(sc.lines);
  if (!lineKeys.length) {
    errors.push('Scenario has no copy lines.');
  }

  const sceneOrder = new Map(sc.scenes.map((s, idx) => [s.id, idx]));
  const sceneMap = new Map(sc.scenes.map(s => [s.id, s]));
  if (sceneMap.size !== sc.scenes.length) {
    errors.push('Duplicate scene ids in scenario.scenes.');
  }

  // Poster / single scene rules (§3.3 & §4.3)
  if (sc.kind === 'poster') {
    if (sc.scenes.length !== 1 || sc.scenes[0].id !== 'poster' || sc.scenes[0].beat !== 'POSTER') {
      errors.push('Poster scenario must have exactly one scene {id:"poster", beat:"POSTER"}.');
    }
  } else if (sc.kind === 'single') {
    if (sc.scenes.length !== 1 || sc.scenes[0].id !== 'loop' || sc.scenes[0].beat !== 'LOOP') {
      errors.push('Single-scene scenario must have exactly one scene {id:"loop", beat:"LOOP"}.');
    }
  }

  // Check lines: languages, maxChars, hideIn, scene reference
  for (const [key, line] of Object.entries(sc.lines)) {
    if (!sceneMap.has(line.scene)) {
      errors.push(`Line "${key}" references unknown scene "${line.scene}".`);
    } else if (!sceneMap.get(line.scene).lines.includes(key)) {
      errors.push(`Line "${key}" claims scene "${line.scene}", but that scene does not list "${key}" in its lines.`);
    }

    if (NEVER_HIDE_ROLES.has(line.role) && Array.isArray(line.hideIn) && line.hideIn.length > 0) {
      errors.push(`Line "${key}" has role "${line.role}" and cannot be hidden in hideIn (${line.hideIn.join(', ')}).`);
    }

    for (const lang of langs) {
      const txt = String(line.text?.[lang] ?? '').trim();
      if (!txt) {
        errors.push(`Line "${key}" is missing text for language "${lang}".`);
        continue;
      }
      const charCount = [...txt].length;
      if (charCount > line.maxChars) {
        warnings.push(`Line "${key}" (${lang}) is ${charCount}/${line.maxChars} chars (>100%).`);
      }
      if (sc.kind === 'poster' && line.role === 'hook') {
        const words = txt.split(/\s+/).filter(Boolean).length;
        if (words > 7) {
          warnings.push(`Poster hook "${key}" (${lang}) has ${words} words (>7 words).`);
        }
      }
    }
  }

  // Check scenes -> lines references
  for (const scene of sc.scenes) {
    for (const lk of scene.lines) {
      const line = sc.lines[lk];
      if (!line) {
        errors.push(`Scene "${scene.id}" references unknown line "${lk}".`);
      } else if (line.scene !== scene.id) {
        errors.push(`Scene "${scene.id}" lists line "${lk}" which belongs to scene "${line.scene}".`);
      }
    }
  }

  // Single-scene total reading time warning
  const lengths = Array.isArray(setup.lengths) && setup.lengths.length
    ? setup.lengths.map(Number)
    : sc.kind === 'multi' && sc.cuts
      ? Object.keys(sc.cuts).map(Number)
      : [];

  if (sc.kind === 'single' && lengths.length > 0) {
    const minLen = Math.min(...lengths);
    const budget = minLen - 0.5;
    for (const lang of langs) {
      const allTexts = lineKeys.map(k => sc.lines[k]?.text?.[lang] || '').filter(Boolean);
      const need = windowNeed(allTexts, lang, {closing: false});
      if (need > budget) {
        warnings.push(`Single-scene reading time in "${lang}" (${need.toFixed(2)} s) exceeds min(lengths) − 0.5 (${budget.toFixed(2)} s).`);
      }
    }
  }

  // Multi-scene cuts validation
  if (sc.kind === 'multi') {
    const lastScene = sc.scenes[sc.scenes.length - 1];
    if (lastScene && !lastScene.lines.some(lk => sc.lines[lk]?.role === 'answer')) {
      errors.push(`The closing scene "${lastScene.id}" needs an answer line (role "answer"): the turn said in words, so every cut, the shortest too, can end on it.`);
    }
    const cuts = sc.cuts || {};
    const targetLengths = lengths.length ? lengths : Object.keys(cuts).map(Number);
    if (!targetLengths.length) {
      errors.push('Multi-scene scenario requires at least one cut length.');
    }

    for (const len of targetLengths) {
      const key = String(len);
      const cut = cuts[key];
      if (!cut || !Array.isArray(cut.scenes) || !cut.scenes.length) {
        errors.push(`Missing cut for length ${len} s.`);
        continue;
      }

      cells[key] = {};
      let prevIdx = -1;
      const wins = cut.scenes;

      if (Math.abs(wins[0].start - 0) > 1e-6) {
        errors.push(`Cut ${key}s: first window "${wins[0].id}" must start at 0 (got ${wins[0].start}).`);
      }

      const lastWin = wins[wins.length - 1];
      if (Math.abs(lastWin.end - Number(len)) > 1e-6) {
        errors.push(`Cut ${key}s: last window "${lastWin.id}" must end exactly at ${len} (got ${lastWin.end}).`);
      }

      const hasCta = lastWin.lines.some(lk => sc.lines[lk]?.role === 'cta' || lk === 'cta');
      if (!hasCta) {
        errors.push(`Cut ${key}s: last window "${lastWin.id}" lacks the cta line.`);
      }
      const used = wins.flatMap(w => w.lines);
      if (!used.some(lk => sc.lines[lk]?.role === 'hook')) {
        errors.push(`Cut ${key}s: no hook line. Every cut opens on the hook.`);
      }
      // under 5 s a cut is a bumper (hook or answer with the CTA): there is no time to read a question and its answer
      if (Number(len) >= 5 && !used.some(lk => sc.lines[lk]?.role === 'answer')) {
        errors.push(`Cut ${key}s: no answer line. Every cut of 5 s or more says the answer in words; never leave the picture to explain it.`);
      }
      // One window = one composition carrying the whole idea: the closing scene may hold the hook line with its own.
      const merged = wins.length === 1;

      for (let i = 0; i < wins.length; i++) {
        const win = wins[i];
        const idx = sceneOrder.get(win.id);
        if (idx === undefined) {
          errors.push(`Cut ${key}s: window references unknown scene "${win.id}".`);
        } else {
          if (idx <= prevIdx) {
            errors.push(`Cut ${key}s: scenes are not in scenario order at "${win.id}".`);
          }
          prevIdx = idx;
        }

        if (win.end <= win.start) {
          errors.push(`Cut ${key}s: window "${win.id}" has non-positive duration (${win.start}–${win.end}).`);
        }

        if (i > 0) {
          const prevEnd = wins[i - 1].end;
          if (Math.abs(win.start - prevEnd) > 0.05) {
            errors.push(`Cut ${key}s: gap or overlap between "${wins[i - 1].id}" (ends ${prevEnd}) and "${win.id}" (starts ${win.start}).`);
          }
        }

        const sceneObj = sceneMap.get(win.id);
        for (const lk of win.lines) {
          const line = sc.lines[lk];
          if (!line) {
            errors.push(`Cut ${key}s, window "${win.id}": references unknown line "${lk}".`);
          } else if ((line.scene !== win.id || (sceneObj && !sceneObj.lines.includes(lk))) && !(merged && line.role === 'hook')) {
            errors.push(`Cut ${key}s, window "${win.id}": line "${lk}" does not belong to scene "${win.id}".`);
          }
        }

        // Reading-time evaluation per language
        const have = Math.max(0, win.end - win.start);
        const closing = i === wins.length - 1;
        const byLang = {};
        let worstVerdict = 'ok';
        let maxNeed = 0;

        for (const lang of langs) {
          const texts = win.lines.map(lk => sc.lines[lk]?.text?.[lang] || '');
          const need = windowNeed(texts, lang, {closing, picture: true});
          const v = verdict(have, need);
          byLang[lang] = {need, have, verdict: v};
          if (need > maxNeed) maxNeed = need;
          if (RANK[v] > RANK[worstVerdict]) worstVerdict = v;
        }

        cells[key][win.id] = {need: maxNeed, have, verdict: worstVerdict, byLang};

        if (worstVerdict === 'fail') {
          const failing = Object.entries(byLang)
            .filter(([, info]) => info.verdict === 'fail')
            .map(([l, info]) => `${l}: need ${info.need.toFixed(2)}s > have ${have.toFixed(2)}s`)
            .join(', ');
          errors.push(`Cut ${key}s, window "${win.id}" fails reading-time check (${failing}).`);
        } else if (worstVerdict === 'tight') {
          const tightLangs = Object.entries(byLang)
            .filter(([, info]) => info.verdict === 'tight')
            .map(([l, info]) => `${l}: need ${info.need.toFixed(2)}s vs have ${have.toFixed(2)}s`)
            .join(', ');
          warnings.push(`Cut ${key}s, window "${win.id}" is tight (${tightLangs}).`);
        }
      }
    }
  }

  return {errors, warnings, cells};
}
