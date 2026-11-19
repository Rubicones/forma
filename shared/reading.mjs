import {language} from './languages.mjs';
// Seconds a viewer needs to read one line once, plus orientation time.
export function readingSeconds(text = '', lang = 'en') {
  const t = String(text).trim();
  if (!t) return 0;
  const units = language(lang).cjk ? [...t.replace(/\s/g, '')].length / 6 : t.split(/\s+/).length / 2.6;
  return 0.4 + units;
}
// Seconds a viewer needs to take in a new picture before reading its words (a scene of a multi-scene spot).
export const PICTURE_SECONDS = 0.6;
// Time a window needs for the given lines: reading times + 0.25 s eye travel per extra line
// (+0.6 s to take in a new scene's picture, except the closing window, which gets a 1.0 s hold instead).
export function windowNeed(lines, lang, {closing = false, picture = false} = {}) {
  const parts = lines.map(text => readingSeconds(text, lang)).filter(Boolean);
  return parts.reduce((a, b) => a + b, 0) + Math.max(0, parts.length - 1) * 0.25 + (picture && !closing ? PICTURE_SECONDS : 0) + (closing ? 1.0 : 0);
}
// 'ok' | 'tight' | 'fail' for a window of `have` seconds.
export const verdict = (have, need) => have >= need ? 'ok' : have >= need * 0.85 ? 'tight' : 'fail';
