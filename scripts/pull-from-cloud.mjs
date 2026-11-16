#!/usr/bin/env node
// Downloads everything from Supabase + R2 (entries with logs, all project files) into a NEW local data folder.
// Usage: node --env-file=.env scripts/pull-from-cloud.mjs --out ./data-from-cloud [--concurrency 6]
// Then run the app on it with FORMA_STORE=file DATA_DIR=./data-from-cloud npm start
import path from 'node:path';
import {parseArgs} from 'node:util';
import {createSupabaseStore} from '../store/supabase.mjs';
import {preflight, pull, mb} from './lib/cloud-migrate.mjs';

const {values:args} = parseArgs({options:{
  out:{type:'string'},
  concurrency:{type:'string', default:'6'},
  help:{type:'boolean', short:'h', default:false},
}});
if (args.help || !args.out) {
  console.log('node --env-file=.env scripts/pull-from-cloud.mjs --out ./data-from-cloud [--concurrency 6]');
  process.exit(args.help ? 0 : 1);
}
const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].filter(k => !process.env[k]);
if (missing.length) { console.error('✗ В .env не заданы: ' + missing.join(', ')); process.exit(1); }
process.env.FORMA_AUTHOR ||= 'pull';

const outDir = path.resolve(args.out);
const cloud = createSupabaseStore({dataDir:outDir});
try {
  await preflight(cloud);
  console.log(`Облако → ${outDir}\n`);
  const report = await pull({cloud, outDir, concurrency:Math.max(1, Math.min(16, Number(args.concurrency) || 6)), log:m => console.log(m)});
  console.log(`\nГотово: записей ${report.entries}, файлов ${report.files} (${mb(report.bytes)})` + (report.failed.length ? `, ошибок ${report.failed.length}` : ''));
  for (const f of report.failed.slice(0, 15)) console.log(`  · ${f.key || f.id}: ${f.error}`);
  console.log(`\nЗапуск на этих данных: FORMA_STORE=file DATA_DIR=${args.out} npm start`);
  if (report.failed.length) process.exitCode = 2;
} catch (error) {
  console.error('✗ ' + error.message);
  process.exit(1);
}
