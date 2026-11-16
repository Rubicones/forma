import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, readFile, rm, open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {instructions, briefMessage, output} from './creative.mjs';
import {mediaKey} from './media.mjs';
import {codexCost, usd} from './pricing.mjs';
const mediaServer=path.join(path.dirname(fileURLToPath(import.meta.url)),'media-mcp.mjs');
const toml=value=>JSON.stringify(String(value));

export const codexKey = () => process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
const run = promisify(execFile);
const cliEnv=()=>({PATH:process.env.PATH,HOME:process.env.HOME,...(process.env.CODEX_HOME && {CODEX_HOME:process.env.CODEX_HOME})});
export async function chatLogin() {
  try {
    const {stdout,stderr}=await run(process.env.CODEX_BIN || 'codex',['login','status'],{env:cliEnv(),timeout:5000});
    return /logged in using chatgpt/i.test(stdout+stderr);
  } catch {return false}
}
function failure(error, model, billing) {
  if (error.code==='ENOENT' && error.syscall?.startsWith('spawn')) return 'Не найден Codex CLI. Проверьте CODEX_BIN.';
  if (error.killed) return 'Генерация остановлена по тайм-ауту.';
  if (error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'Вывод Codex превысил локальный лимит.';
  const events=[];
  for(const line of (error.stdout || '').split('\n')) {
    try {
      const event=JSON.parse(line);
      if(event.type==='error') events.push(event.message);
      if(event.type==='turn.failed') events.push(event.error?.message);
    } catch {}
  }
  const lines=(error.stderr || '').split('\n').filter(line=>/^(?:error|fatal)(?:\b|:)/i.test(line.trim()));
  const detail=events.filter(Boolean).at(-1) || lines.at(-1) || 'Код завершения '+(error.code || error.signal || 'неизвестен');
  if (/quota exceeded|insufficient_quota|exceeded your current quota/i.test(detail)) {
    if(billing==='chatgpt') return 'Достигнут лимит Codex в ChatGPT. Проверьте время его обновления.';
    return 'OpenAI: исчерпана квота API (Quota exceeded). Проверьте баланс и лимит расходов организации, к которой относится ключ.';
  }
  let safe=String(detail);
  const key=codexKey();
  if(key) safe=safe.replaceAll(key,'[скрыто]');
  safe=safe.replace(/sk-[\w-]+/g,'[скрыто]').replace(/Bearer\s+[^\s",]+/gi,'Bearer [скрыто]');
  return 'Codex ('+model+'): '+safe.slice(0,900);
}
const short=(text,n=200)=>{const s=String(text??'').replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n-1)+'…':s};
// Translates `codex exec --json` events into journal lines.
function describe(event, log, onText, model) {
  const item=event.item || {};
  switch(event.type){
    case 'thread.started': return log('Codex: сессия начата',{level:'step'});
    case 'turn.started': return log('Codex: модель работает');
    case 'turn.completed': { const u=event.usage||{}, cost=codexCost(model,u); return log('Codex закончил · токены: вход '+(u.input_tokens??'?')+(u.cached_input_tokens?' (кэш '+u.cached_input_tokens+')':'')+', выход '+(u.output_tokens??'?')+' · по API ≈ '+(cost===null?'недостаточно данных для расчёта':usd(cost)),{level:'done',cost:{kind:'llm',usd:cost,usage:u}}); }
    case 'turn.failed': return log('Codex: ход завершился ошибкой',{level:'error',detail:event.error?.message});
    case 'error': return log('Codex: ошибка',{level:'error',detail:event.message});
  }
  if(event.type==='item.started'){
    if(item.type==='command_execution') return log('Codex выполняет: '+short(item.command,160),{level:'step'});
    if(item.type==='mcp_tool_call') return log('Codex вызывает '+(item.tool||'инструмент')+(item.server?' ('+item.server+')':''),{level:'step',detail:item.arguments?JSON.stringify(item.arguments):undefined});
    if(item.type==='web_search') return log('Codex ищет: '+short(item.query,120));
    return;
  }
  if(event.type==='item.completed'){
    if(item.type==='reasoning') return log('Codex думает: '+short(item.text,160),{level:'think',detail:item.text});
    if(item.type==='agent_message'){ onText(item.text||''); return log('Codex ответил · '+((item.text||'').length/1000).toFixed(1)+'k симв.',{level:'step'}); }
    if(item.type==='command_execution') return log('Команда завершена'+(item.exit_code!==undefined?' · код '+item.exit_code:''),{level:item.exit_code?'warn':'info',quiet:true,detail:short(item.aggregated_output,800)});
    if(item.type==='mcp_tool_call') return log('Инструмент '+(item.tool||'')+' · '+(item.status||'готово'),{level:item.status==='failed'||item.error?'warn':'info',quiet:true,detail:item.error?.message});
    if(item.type==='todo_list') return log('План Codex',{detail:(item.items||[]).map(i=>(i.completed?'✓ ':'· ')+i.text).join('\n')});
    if(item.type==='file_change') return log('Codex изменил файлы',{level:'warn'});
  }
}
// Forwards JSON lines that media-mcp.mjs appends to its log file.
function tailFile(file, log) {
  let offset=0, busy=false;
  const step=async()=>{
    if(busy) return; busy=true;
    try{
      const fh=await open(file,'r').catch(()=>null);
      if(!fh) return;
      try{
        const {size}=await fh.stat();
        if(size>offset){
          const buf=Buffer.alloc(size-offset); await fh.read(buf,0,buf.length,offset);
          const text=buf.toString('utf8'), end=text.lastIndexOf('\n');
          if(end<0) return;
          offset+=Buffer.byteLength(text.slice(0,end+1));
          for(const line of text.slice(0,end).split('\n')){ try{const {msg,...extra}=JSON.parse(line); log(msg,extra)}catch{} }
        }
      } finally { await fh.close(); }
    } finally { busy=false; }
  };
  const timer=setInterval(step,700);
  return async()=>{clearInterval(timer); await step();};
}
// prompt: optional {system, user} override (used for revisions).
export async function generateCodex({dir, files, scenario, style, billing="api", task, formats, duration, media, model, effort, controller, log=()=>{}, onText=()=>{}, prompt}) {
  const useMedia = (task==='creative' || task==='final') && Boolean(mediaKey() && (media?.images || media?.video));
  const temp = await mkdtemp(path.join(tmpdir(), 'forma-codex-'));
  const resultFile = path.join(temp, 'creative.html'), mediaLog = path.join(temp, 'media.jsonl');
  const args = ['exec','--json','--skip-git-repo-check','--ephemeral','--ignore-user-config',
    '-c','approval_policy="never"', '-c','default_permissions="materials"',
    '-c','permissions.materials.filesystem={":minimal"="read",":workspace_roots"={ "."="read" }}',
    '-c','permissions.materials.network.enabled=false','-c','shell_environment_policy.inherit="none"',
    '-c','project_doc_max_bytes=0','--disable','multi_agent','--cd',dir,
    ...(useMedia ? ['-c','mcp_servers.forma_media.command='+toml(process.execPath),
      '-c','mcp_servers.forma_media.args=['+toml(mediaServer)+']',
      '-c','mcp_servers.forma_media.env={FORMA_ASSETS='+toml(dir)+',FORMA_MEDIA='+toml(JSON.stringify(media))+',FORMA_LOG='+toml(mediaLog)+'}',
      '-c','mcp_servers.forma_media.tool_timeout_sec=900'] : []),
    '--model',model,'-c','model_reasoning_effort="'+effort+'"','--output-last-message',resultFile,'-'];
  const stopTail = useMedia ? tailFile(mediaLog, log) : async()=>{};
  log('Запуск Codex CLI · '+model+' · effort '+effort+(useMedia?' · медиа-инструменты подключены':''),{level:'step'});
  try {
    const job = run(process.env.CODEX_BIN || 'codex',args,{
      cwd:temp, signal:controller.signal, timeout:useMedia ? 1800000 : 900000, maxBuffer:16*1024*1024,
      env:billing==='chatgpt'?cliEnv():{...cliEnv(),CODEX_API_KEY:codexKey()}
    });
    job.child.stdin.on('error',()=>{});
    let pending='';
    job.child.stdout.on('data',chunk=>{
      pending+=chunk; const lines=pending.split('\n'); pending=lines.pop();
      for(const line of lines){ try{describe(JSON.parse(line),log,onText,model)}catch{} }
    });
    job.child.stdin.end(prompt ? prompt.system+'\n\n'+prompt.user : instructions(task, {formats, duration, media:useMedia ? media : null})+'\n'+briefMessage({scenario,style,files,formats,duration}));
    await job;
    return output(await readFile(resultFile,'utf8'),'Codex',task);
  } catch(error) {
    if ('stderr' in error || 'stdout' in error) throw Error(failure(error,model,billing));
    throw error;
  } finally {
    await stopTail();
    await rm(temp,{recursive:true,force:true});
  }
}
