import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {realRoots, under} from '../generator.mjs';

test('realRoots resolves roots and under() accepts files inside them', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'forma-paths-'));
  await mkdir(path.join(dir, 'assets'));
  const roots = await realRoots([dir]);
  assert.ok(roots.length >= 1 && roots.every(r => typeof r === 'string'));
  assert.ok(under(path.join(dir, 'assets', 'a.png'), roots));
  assert.ok(!under(path.join(path.dirname(dir), 'elsewhere.png'), roots));
});
