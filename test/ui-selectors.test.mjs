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

  it('includes required Russian microcopy and accessibility attributes in public/', async () => {
    const html = await fs.readFile(path.join(pubDir, 'index.html'), 'utf8');
    const appJs = await fs.readFile(path.join(pubDir, 'app.js'), 'utf8');
    const stepperJs = await fs.readFile(path.join(pubDir, 'stepper.js'), 'utf8');

    // Stepper & radiogroup accessibility
    assert.match(html, /<nav[^>]*id="stepper"[^>]*aria-label="Шаги"/);
    assert.match(html, /role="radiogroup"/);

    // Key microcopy from §8.2–§8.8
    assert.ok(html.includes('Статика: продуманная вёрстка, хук и CTA'));
    assert.ok(html.includes('Всё в кадре сразу, бесшовный зацикленный моушен'));
    assert.ok(html.includes('История в сценах: хук → доказательство → оффер'));
    assert.ok(html.includes('Каждая строка будет переведена на все языки. Превью — на основном'));
    assert.ok(html.includes('Сценарий распланирует, какие хуки попадут в каждую длину'));
    assert.ok(html.includes('Финал — самый тяжёлый шаг, обычно стоит Opus'));
    assert.ok(html.includes('Здесь появится превью после шага «Сценарий»'));
    assert.ok(appJs.includes('Сценарий изменился после сборки превью. Превью устарело — пересоберите его, чтобы двигаться дальше.'));
    assert.ok(stepperJs.includes('Сначала утвердите сценарий'));
    assert.ok(stepperJs.includes('Сначала утвердите превью'));
  });
});
