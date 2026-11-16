#!/usr/bin/env node
// Uploads local data/ (projects, files, history incl. every run) to Supabase + Cloudflare R2.
// Usage: node --env-file=.env scripts/migrate-to-cloud.mjs [--apply] [--merge-style-forks] [--concurrency 4] [--data-dir ./data]
// Dry run by default. Idempotent and resumable. Never deletes or changes local files (only writes migration-report.json on --apply).
import path from 'node:path';
import {parseArgs} from 'node:util';
import {createSupabaseStore, authorStorage} from '../store/supabase.mjs';
import {scanLocal, summarize, planForkMerges, prepareEntries, preflight, migrate, writeReport, mb} from './lib/cloud-migrate.mjs';

const {values:args} = parseArgs({options:{
  apply:{type:'boolean', default:false},
  'merge-style-forks':{type:'boolean', default:false},
  concurrency:{type:'string', default:'4'},
  'data-dir':{type:'string'},
  help:{type:'boolean', short:'h', default:false},
}});
if (args.help) {
  console.log('node --env-file=.env scripts/migrate-to-cloud.mjs [--apply] [--merge-style-forks] [--concurrency 4] [--data-dir ./data]');
  process.exit(0);
}
const say = (...m) => console.log(...m);
const fail = message => { console.error('\n✗ ' + message); process.exit(1); };

const dataDir = path.resolve(args['data-dir'] || process.env.DATA_DIR || 'data');
const author = process.env.FORMA_AUTHOR;
const concurrency = Math.max(1, Math.min(16, Number(args.concurrency) || 4));
const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'FORMA_AUTHOR'].filter(k => !process.env[k]);
if (missing.length) fail('В .env не заданы: ' + missing.join(', ') + '. См. docs/cloud-runbook.md.');

say(`Forma → облако · ${args.apply ? 'ВЫГРУЗКА' : 'пробный прогон (ничего не меняется)'}`);
say(`Папка данных: ${dataDir} · автор: ${author} · R2: ${process.env.R2_BUCKET || 'forma'}\n`);

const cloud = createSupabaseStore({dataDir});
await authorStorage.run(author, async () => {
  // 1. Preflight
  try { await preflight(cloud); } catch (error) { fail(error.message); }
  const scan = await scanLocal(dataDir);
  if (!scan.projects.length && !scan.entries.length) fail('В папке данных нет проектов и истории — нечего выгружать.');
  const s = summarize(scan);
  say('Локально:');
  say(`  проекты: ${s.projects}`);
  say(`  файлы: ${s.files} · ${mb(s.bytes)}`);
  for (const [kind, v] of Object.entries(s.byKind)) say(`    ${kind.padEnd(10)} ${String(v.count).padStart(4)} · ${mb(v.bytes)}`);
  say(`  записи истории: ${s.entries} ${JSON.stringify(s.byType)}`);
  if (s.orphans) say(`  файлы без ссылок из истории: ${s.orphans} (тоже будут выгружены)`);
  if (s.broken) say(`  повреждённые записи (пропускаются): ${s.broken} → ${scan.broken.map(b => b.file).join(', ')}`);

  if (args['merge-style-forks']) {
    const {merges} = prepareEntries(scan.entries, {author, mergeForks:true});
    say('\nСклейка стилевых копий кампаний:');
    if (!merges.length) say('  копий не найдено');
    for (const m of merges) say(`  «${m.base.name}» ← ${m.forks.map(f => `«${f.name}»`).join(', ')}`);
  } else {
    const forks = planForkMerges(scan.entries.filter(e => e.type === 'campaign'));
    if (forks.length) say(`\nНайдены стилевые копии кампаний: ${forks.length} групп(ы). Чтобы склеить их в варианты, добавьте --merge-style-forks.`);
  }

  // 2–6. Projects, files, entries, verify
  say('');
  const report = await migrate({cloud, dataDir, apply:args.apply, mergeForks:args['merge-style-forks'], concurrency, author, log:say});

  say('\nИтог:');
  say(`  файлы: ${args.apply ? 'загружено' : 'будет загружено'} ${report.files.uploaded} (${mb(report.files.bytes)}), уже в R2 ${report.files.skipped}, строк индекса ${report.files.indexed}`);
  say(`  записи: ${args.apply ? 'записано' : 'будет записано'} ${report.entries.written}, без изменений ${report.entries.skipped}`);
  const failures = [...report.files.failed, ...report.entries.failed];
  if (failures.length) {
    say(`  ошибок: ${failures.length}`);
    for (const f of failures.slice(0, 15)) say(`    · ${f.key || f.id}: ${f.error}`);
  }
  if (report.verify) {
    say(report.verify.ok ? '  проверка: ✓ всё на месте' : `  проверка: ✗ проблем ${report.verify.problems.length}`);
    for (const p of report.verify.problems.slice(0, 15)) say('    · ' + p);
  }

  if (!args.apply) {
    say('\nЭто был пробный прогон. Для выгрузки запустите с --apply' + (args['merge-style-forks'] ? ' --merge-style-forks' : '') + '.');
    return;
  }
  const file = await writeReport(dataDir, report);
  say(`\nОтчёт: ${file}`);
  if (failures.length || report.verify?.ok === false) {
    say('Выгрузка завершилась с ошибками. Запустите команду ещё раз — уже загруженное будет пропущено.');
    process.exitCode = 2;
    return;
  }
  say('\nГотово. Дальше:');
  say('  1. В .env поставьте FORMA_STORE=supabase');
  say('  2. Перезапустите сервер: npm start');
  say('  3. Проверьте историю и откройте пару креативов (см. docs/cloud-runbook.md, раздел «Переключение»).');
  say('Локальная папка data/ не изменена — это резервная копия.');
});
