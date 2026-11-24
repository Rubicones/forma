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
  if (error.code==='ENOENT' && error.syscall?.startsWith('spawn')) return 'Codex CLI not found. Check CODEX_BIN.';
  if (error.killed) return 'Generation timed out.';
  if (error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'Codex output exceeded the local limit.';
  const events=[];
  for(const line of (error.stdout || '').split('\n')) {
    try {
      const event=JSON.parse(line);
      if(event.type==='error') events.push(event.message);
      if(event.type==='turn.failed') events.push(event.error?.message);
    } catch {}
  }
  const lines=(error.stderr || '').split('\n').filter(line=>/^(?:error|fatal)(?:\b|:)/i.test(line.trim()));
  const detail=events.filter(Boolean).at(-1) || lines.at(-1) || 'Exit code '+(error.code || error.signal || 'unknown');
  if (/quota exceeded|insufficient_quota|exceeded your current quota/i.test(detail)) {
    if(billing==='chatgpt') return 'Your ChatGPT Codex limit has been reached. Check when it resets.';
    return 'OpenAI API quota exceeded. Check the balance and spending limit for the organization that owns the key.';
  }
  let safe=String(detail);
  const key=codexKey();
  if(key) safe=safe.replaceAll(key,'[redacted]');
  safe=safe.replace(/sk-[\w-]+/g,'[redacted]').replace(/Bearer\s+[^\s",]+/gi,'Bearer [redacted]');
  return 'Codex ('+model+'): '+safe.slice(0,900);
}
const short=(text,n=200)=>{const s=String(text??'').replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n-1)+'…':s};
// Translates `codex exec --json` events into journal lines.
function describe(event, log, onText, model) {
  const item=event.item || {};
  switch(event.type){
    case 'thread.started': return log('Codex session started',{level:'step'});
    case 'turn.started': return log('Codex is working');
    case 'turn.completed': { const u=event.usage||{}, cost=codexCost(model,u); return log('Codex finished · tokens: input '+(u.input_tokens??'?')+(u.cached_input_tokens?' (cached '+u.cached_input_tokens+')':'')+', output '+(u.output_tokens??'?')+' · estimated API cost ≈ '+(cost===null?'insufficient usage data':usd(cost)),{level:'done',cost:{kind:'llm',usd:cost,usage:u}}); }
    case 'turn.failed': return log('Codex turn failed',{level:'error',detail:event.error?.message});
    case 'error': return log('Codex error',{level:'error',detail:event.message});
  }
  if(event.type==='item.started'){
    if(item.type==='command_execution') return log('Codex is running: '+short(item.command,160),{level:'step'});
    if(item.type==='mcp_tool_call') return log('Codex is calling '+(item.tool||'tool')+(item.server?' ('+item.server+')':''),{level:'step',detail:item.arguments?JSON.stringify(item.arguments):undefined});
    if(item.type==='web_search') return log('Codex is searching: '+short(item.query,120));
    return;
  }
  if(event.type==='item.completed'){
    if(item.type==='reasoning') return log('Codex is thinking: '+short(item.text,160),{level:'think',detail:item.text});
    if(item.type==='agent_message'){ onText(item.text||''); return log('Codex replied · '+((item.text||'').length/1000).toFixed(1)+'k characters',{level:'step'}); }
    if(item.type==='command_execution') return log('Command finished'+(item.exit_code!==undefined?' · exit code '+item.exit_code:''),{level:item.exit_code?'warn':'info',quiet:true,detail:short(item.aggregated_output,800)});
    if(item.type==='mcp_tool_call') return log('Tool '+(item.tool||'')+' · '+(item.status||'done'),{level:item.status==='failed'||item.error?'warn':'info',quiet:true,detail:item.error?.message});
    if(item.type==='todo_list') return log('Codex plan',{detail:(item.items||[]).map(i=>(i.completed?'✓ ':'· ')+i.text).join('\n')});
    if(item.type==='file_change') return log('Codex modified files',{level:'warn'});
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
  const useMedia = (task==='creative' || task==='final' || task==='preview') && Boolean(mediaKey() && (media?.images || media?.video));
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
      // A build has no interactive approval channel. Authorize only the media the designer enabled.
      ...(media.images ? ['-c','mcp_servers.forma_media.tools.generate_image.approval_mode="approve"'] : []),
      ...(media.video ? ['-c','mcp_servers.forma_media.tools.generate_video.approval_mode="approve"'] : []),
      '-c','mcp_servers.forma_media.tools.track_screen.approval_mode="approve"',
      '-c','mcp_servers.forma_media.tool_timeout_sec=900'] : []),
    '--model',model,'-c','model_reasoning_effort="'+effort+'"','--output-last-message',resultFile,'-'];
  const stopTail = useMedia ? tailFile(mediaLog, log) : async()=>{};
  log('Starting Codex CLI · '+model+' · effort '+effort+(useMedia?' · media tools connected':''),{level:'step'});
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
