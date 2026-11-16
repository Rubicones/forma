import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import {subscriptionEnv} from './claude-auth.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';

import {instructions, briefMessage, output, revisionInstructions, revisionMessage} from './creative.mjs';
import {mediaSession, imageShape, videoShape, toolText, asToolResult} from './media.mjs';
import {claudeCost, usd} from './pricing.mjs';

const short = (text, n = 200) => { const s = String(text ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const toolLabel = name => ({mcp__media__generate_image:'image generation', mcp__media__generate_video:'video generation'})[name] || name;

function mediaServer({dir, media, controller, log}) {
  const mcpServers = {}, mediaTools = [];
  if (media?.images || media?.video) {
    const session = mediaSession({dir, signal:controller.signal, log, allow:media});
    const tools = [];
    if (media.images) tools.push(tool('generate_image', toolText.image, imageShape, args => asToolResult(() => session.image(args))));
    if (media.video) tools.push(tool('generate_video', toolText.video, videoShape, args => asToolResult(() => session.video(args))));
    mcpServers.media = createSdkMcpServer({name:'media', version:'1.0.0', tools});
    mediaTools.push(...tools.map(t => 'mcp__media__' + t.name));
  }
  return {mcpServers, mediaTools};
}

// Runs one Agent SDK query, turning its event stream into journal lines. Returns the final text.
async function runQuery({prompt, options, task, dir, log, onText, model, effort, label}) {
  let lastError='', turn=0, blockKind=null, thinking='', text='', lastThinkingStatus=0, textStarted=0;
  const sketchCount = () => (text.match(/"svg"\s*:/g) || []).length;
  const display = file => path.isAbsolute(String(file)) && !String(file).startsWith(dir + path.sep) ? path.basename(String(file)) : path.relative(dir, path.resolve(dir, String(file || '')));
  for await (const event of query({prompt,options})) {
    if(event.type==='system' && event.subtype==='init') {
      log('Claude connected · '+(event.model || model || 'default model')+(effort ? ' · effort '+effort : ''), {level:'step'});
      const extras=[
        ...(event.mcp_servers || []).filter(s=>s.source && s.source!=='sdk').map(s=>'MCP '+s.name+' ('+s.source+')'),
        ...(event.plugins || []).map(p=>'plugin '+p.name),
        ...(event.skills || []).map(name=>'skill '+name),
      ];
      log('Session context · tools: '+(event.tools || []).join(', ')+(extras.length ? ' · extra: '+extras.join(', ') : ' · no skills, plugins or outside MCP'), {level:extras.length ? 'warn' : 'info', quiet:!extras.length});
    }
    if(event.type==='system' && event.subtype==='api_retry') log('Claude is retrying the request ('+event.error+'), delay '+Math.ceil(event.retry_delay_ms/1000)+' s', {level:'warn'});
    if(event.type==='stream_event'){
      const part=event.event;
      if(part.type==='message_start') turn++;
      if(part.type==='content_block_start'){
        blockKind=part.content_block.type;
        if(blockKind==='thinking' || blockKind==='redacted_thinking'){ thinking=''; log('Claude is working on'+(turn>1 ? ' (step '+turn+')' : ' the task')); }
        if(blockKind==='text'){ text=''; textStarted=Date.now(); onText(''); log(label, {level:'step'}); }
      }
      if(part.type==='content_block_delta'){
        if(part.delta?.type==='thinking_delta'){
          thinking+=part.delta.thinking;
          if(Date.now()-lastThinkingStatus>1500){ lastThinkingStatus=Date.now(); log('Claude is thinking: '+short(thinking.slice(-160),160), {level:'think', quiet:true}); }
        }
        if(part.delta?.type==='text_delta'){
          const before = task==='style' ? sketchCount() : 0;
          text+=part.delta.text; onText(text);
          if(task==='style' && sketchCount()>before) log('Sketch '+sketchCount()+' of 3 · writing SVG');
        }
      }
      if(part.type==='content_block_stop'){
        if(blockKind==='thinking' && thinking.trim()) log('Reasoning · '+thinking.length+' characters', {level:'think', detail:thinking});
        if(blockKind==='text' && text) log('Text ready · '+(text.length/1000).toFixed(1)+'k characters in '+((Date.now()-textStarted)/1000).toFixed(0)+' s', {quiet:true});
        blockKind=null;
      }
    }
    if(event.type==='assistant'){
      if(event.error) lastError=event.error;
      for(const block of event.message.content){
        if(block.type!=='tool_use') continue;
        if(block.name==='Read') log('Claude is reading '+display(block.input?.file_path), {level:'step'});
        else if(block.name==='Edit') log('Claude is editing the layout', {level:'step', detail:'− '+short(block.input?.old_string, 600)+'\n+ '+short(block.input?.new_string, 600)});
        else if(block.name==='Write') log('Claude is rewriting the layout', {level:'step'});
        else if(!toolLabel(block.name).endsWith(' generation')) log('Tool '+block.name, {detail:JSON.stringify(block.input)});
      }
    }
    if(event.type==='user' && Array.isArray(event.message?.content)){
      for(const block of event.message.content){
        if(block.type==='tool_result' && block.is_error){
          const msg = Array.isArray(block.content) ? block.content.map(c=>c.text||'').join(' ') : block.content;
          log('Tool returned an error', {level:'warn', detail:msg});
        }
      }
    }
    if(event.type!=='result') continue;
    const cost = claudeCost(event, model || process.env.CLAUDE_MODEL);
    const u = event.usage || {};
    const tokens = event.usage ? ' · tokens: input '+((u.input_tokens||0)+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0))+' (cached '+(u.cache_read_input_tokens||0)+'), output '+(u.output_tokens||0) : '';
    if(event.subtype!=='success' || event.is_error){
      log('Claude failed: '+(lastError || event.subtype), {level:'error', cost:{kind:'llm', usd:cost}});
      throw Error('Claude request failed: '+(lastError || (event.is_error?'provider error':event.subtype))+'.');
    }
    log('Claude finished · turns: '+(event.num_turns ?? turn)+' · '+((event.duration_ms||0)/1000).toFixed(0)+' s'+tokens+' · estimated API cost ≈ '+usd(cost), {level:'done', cost:{kind:'llm', usd:cost}});
    return event.result;
  }
  throw Error('Session ended without a result.');
}

const baseOptions = ({dir, billing, controller, model, effort}) => ({cwd:dir,
  ...(billing==='subscription' && {env:subscriptionEnv()}), settingSources:[], persistSession:false,
  // Isolation: only our own MCP server; no claude.ai connectors, and no skills or plugins synced from claude.ai (this run only).
  strictMcpConfig:true, settings:{disableClaudeAiConnectors:true, syncClaudeAiSkills:false, syncClaudeAiPlugins:false},
  abortController:controller, includePartialMessages:true, model: model || process.env.CLAUDE_MODEL, effort});

// log(message, {level, detail, media, cost}) — journal; onText(text) — the text block being streamed right now.
export async function generate({dir, files, scenario, style, billing, task, formats, duration, media, controller, log=()=>{}, onText=()=>{}, model, effort, prompt:customPrompt, extraReadDirs=[], extraReadFiles=[]}) {
  const useMedia = (task==='creative' || task==='final') && Boolean(media?.images || media?.video);
  const {mcpServers, mediaTools} = mediaServer({dir, media:useMedia ? media : null, controller, log});
  const systemPrompt = customPrompt?.system ?? instructions(task, {formats, duration, media:useMedia ? media : null});
  const prompt = customPrompt?.user ?? briefMessage({scenario,style,files,formats,duration});
  const allowedDirs = (extraReadDirs || []).map(d => path.resolve(d));
  const allowedFiles = new Set((extraReadFiles || []).map(f => path.resolve(f)));
  log('Prompt ready · system ' + (systemPrompt.length/1000).toFixed(1) + 'k characters, brief ' + (prompt.length/1000).toFixed(1) + 'k characters' + (mediaTools.length ? ' · tools: ' + mediaTools.map(toolLabel).join(', ') : ''), {quiet:true, detail:prompt});
  const options = {...baseOptions({dir, billing, controller, model, effort}),
    tools:['Read'], allowedTools:['Read', ...mediaTools], mcpServers, maxTurns:useMedia ? 48 : 24, systemPrompt,
    ...(allowedDirs.length ? {additionalDirectories:allowedDirs} : {}),
    hooks:{PreToolUse:[{hooks:[async input=>{
      if(mediaTools.includes(input.tool_name)) return {};
      const file = path.resolve(dir,input.tool_input?.file_path || '');
      if(input.tool_name==='Read' && (file.startsWith(dir+path.sep) || allowedFiles.has(file) || allowedDirs.some(d => file===d || file.startsWith(d+path.sep)))) return {};
      log('Access denied: '+input.tool_name+' '+short(input.tool_input?.file_path || '', 80), {level:'warn'});
      return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Only uploaded files are available.'}};
    }]}]}};
  const label = task==='style'?'Claude is drawing three sketches':task==='scenario'?'Claude is writing the script':task==='translate'?'Claude is translating the script':task==='cuts'?'Claude is calculating cuts':task==='preview'?'Claude is writing the preview HTML':'Claude is writing the creative HTML';
  const result = await runQuery({prompt, options, task, dir, log, onText, model, effort, label});
  return output(result,'Claude',task);
}

// Revision: Claude edits a working copy of the current creative with the Edit tool.
// onEdit() is called after every change so the server can refresh the live draft.
export async function revise({dir, workFile, files, brief, thread, message, attachments, billing, formats, duration, media, controller, log=()=>{}, onEdit=async()=>{}, model, effort, systemPrompt:customSystem, prompt:customPrompt, stage='creative'}) {
  const {mcpServers, mediaTools} = mediaServer({dir, media, controller, log});
  const systemPrompt = customSystem || revisionInstructions({formats, duration, media:mediaTools.length ? media : null, editing:true});
  const prompt = customPrompt || revisionMessage({workFile, brief, files, thread, message, attachments, formats, duration});
  log('Revision prompt ready · chat history: '+(thread?.length || 0)+' messages'+(attachments?.length ? ' · attachments: '+attachments.length : ''), {quiet:true, detail:prompt});
  const allowed = file => path.resolve(dir, String(file || ''));
  const options = {...baseOptions({dir, billing, controller, model, effort}),
    tools:['Read','Edit','Write'], allowedTools:['Read','Edit','Write', ...mediaTools], mcpServers, maxTurns:mediaTools.length ? 48 : 32, systemPrompt,
    additionalDirectories:[path.dirname(workFile)],
    hooks:{
      PreToolUse:[{hooks:[async input=>{
        if(mediaTools.includes(input.tool_name)) return {};
        const file = allowed(input.tool_input?.file_path);
        if(input.tool_name==='Read' && (file===workFile || file.startsWith(dir+path.sep))) return {};
        if(['Edit','Write'].includes(input.tool_name) && file===workFile) return {};
        log('Access denied: '+input.tool_name+' '+short(input.tool_input?.file_path || '', 80), {level:'warn'});
        return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Only the working file can be edited; materials are read-only.'}};
      }]}],
      PostToolUse:[{hooks:[async input=>{
        if(['Edit','Write'].includes(input.tool_name)) await onEdit().catch(()=>{});
        return {};
      }]}]
    }};
  const reply = await runQuery({prompt, options, task:'revision', dir, log, onText:()=>{}, model, effort, label:'Claude is preparing a reply'});
  const html = await fs.readFile(workFile, 'utf8');
  return {html:output(html,'Claude',stage), reply:String(reply||'').trim()};
}
