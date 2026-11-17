import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {generateCodex} from '../codex.mjs';

test('Codex final builds preapprove exactly the selected media tools', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'forma-test-media-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const cli = path.join(dir, 'mock-cli.cjs');
  const argsFile = path.join(dir, 'args.json');
  await writeFile(cli, `#!/usr/bin/env node
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
    fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], '<html><body></body></html>');
    process.stdin.resume();
  `, {mode:0o700});
  for (const [name, value] of Object.entries({CODEX_BIN:cli, OPENROUTER_API_KEY:'test'})) {
    const original = process.env[name];
    process.env[name] = value;
    t.after(() => { if (original === undefined) delete process.env[name]; else process.env[name] = original; });
  }

  for (const images of [true, false]) {
    for (const video of [true, false]) {
      await generateCodex({dir, task:'final', media:{images, video}, model:'test', effort:'low',
        billing:'chatgpt', controller:new AbortController(), prompt:{system:'test', user:'test'}});
      const args = JSON.parse(await readFile(argsFile, 'utf8'));
      assert.equal(args.includes('mcp_servers.forma_media.tools.generate_image.approval_mode="approve"'), images);
      assert.equal(args.includes('mcp_servers.forma_media.tools.generate_video.approval_mode="approve"'), video);
      assert.equal(args.some(arg => arg.startsWith('mcp_servers.forma_media.command=')), images || video);
    }
  }
});
