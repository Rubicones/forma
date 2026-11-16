import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pubDir = path.join(root, 'public');

describe('public/ UI verification (§8, §13.4)', () => {
  it('every $("#id") selector in public/*.js exists in public/index.html', async () => {
    const html = await fs.readFile(path.join(pubDir, 'index.html'), 'utf8');
    const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

    const entries = await fs.readdir(pubDir);
    const jsFiles = entries.filter(f => f.endsWith('.js'));
    assert.ok(jsFiles.length >= 5, 'Expected ES modules in public/');

    const missing = [];
    let count = 0;
    for (const file of jsFiles) {
      const src = await fs.readFile(path.join(pubDir, file), 'utf8');
      for (const m of src.matchAll(/\$\(\s*['"]#([A-Za-z0-9_-]+)['"]\s*\)/g)) {
        count++;
        if (!htmlIds.has(m[1])) {
          missing.push(`${file}: #${m[1]}`);
        }
      }
    }

    assert.ok(count > 50, `Expected to check >50 #id selectors, checked ${count}`);
    assert.deepEqual(missing, [], `Missing #id elements in index.html:\n${missing.join('\n')}`);
  });

  it('defines responsive breakpoints at 980px and 560px and respects prefers-reduced-motion in public/style.css', async () => {
    const css = await fs.readFile(path.join(pubDir, 'style.css'), 'utf8');
    assert.match(css, /@media\s*\(max-width:\s*980px\)/);
    assert.match(css, /@media\s*\(max-width:\s*560px\)/);
    assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it('includes required English microcopy and accessibility attributes in public/', async () => {
    const html = await fs.readFile(path.join(pubDir, 'index.html'), 'utf8');
    const appJs = await fs.readFile(path.join(pubDir, 'app.js'), 'utf8');
    const stepperJs = await fs.readFile(path.join(pubDir, 'stepper.js'), 'utf8');

    assert.match(html, /<html lang="en">/);
    assert.doesNotMatch(html.replace(/<!--[^]*?-->/g, ''), /[А-Яа-яЁё]/);

    // Stepper & radiogroup accessibility
    assert.match(html, /<nav[^>]*id="stepper"[^>]*aria-label="Steps"/);
    assert.match(html, /role="radiogroup"/);

    // Key microcopy from §8.2–§8.8
    assert.ok(html.includes('A static layout with a hook and a call to action'));
    assert.ok(html.includes('One composition with seamless looping motion'));
    assert.ok(html.includes('A sequence of scenes that introduces the hook, shows proof and presents the offer'));
    assert.ok(html.includes('Each line is translated into every selected language. The preview uses the primary language.'));
    assert.ok(html.includes('The script determines which hooks fit each length.'));
    assert.ok(html.includes('The final build is the most demanding step. Consider using Opus.'));
    assert.ok(html.includes('Your preview will appear here after the script step.'));
    assert.ok(appJs.includes('The script has changed since this preview was built. Rebuild the preview to continue.'));
    assert.ok(stepperJs.includes('Approve the script first'));
    assert.ok(stepperJs.includes('Approve the preview first'));
  });
});
