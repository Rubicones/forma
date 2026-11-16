import {language} from './languages.mjs';
// Seconds a viewer needs to read one line once, plus orientation time.
export function readingSeconds(text = '', lang = 'en') {
  const t = String(text).trim();
  if (!t) return 0;
  const units = language(lang).cjk ? [...t.replace(/\s/g, '')].length / 6 : t.split(/\s+/).length / 2.6;
  return 0.4 + units;
}
// Time a window needs for the given lines: reading times + 0.25 s eye travel per extra line (+1.0 s hold if it is the closing window).
export function windowNeed(lines, lang, {closing = false} = {}) {
  const parts = lines.map(text => readingSeconds(text, lang)).filter(Boolean);
  return parts.reduce((a, b) => a + b, 0) + Math.max(0, parts.length - 1) * 0.25 + (closing ? 1.0 : 0);
}
// 'ok' | 'tight' | 'fail' for a window of `have` seconds.
export const verdict = (have, need) => have >= need ? 'ok' : have >= need * 0.85 ? 'tight' : 'fail';
