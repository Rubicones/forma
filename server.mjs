import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {parseStyleChoices, revisionInstructions, revisionMessage, revisionReply, output as checkHTML} from './creative.mjs';
import {tmpdir} from 'node:os';
import {createJob, logger, finishJob, draftHTML, streamedSketches} from './jobs.mjs';
import * as history from './history.mjs';
import {store, authorStorage} from './store/index.mjs';
import {createPreviewReadThrough} from './store/supabase.mjs';
import {subscriptionReady} from './claude-auth.mjs';
import {generate, revise} from './generator.mjs';
import {generateCodex, codexKey, chatLogin} from './codex.mjs';
import {inject, uninject, formats, defaultFormats, durations, pickFormats, pickDuration} from './motion.mjs';
import {mediaKey, imageModel, videoModel, mediaLimits} from './media.mjs';
import {models, settings} from './models.mjs';
import {registerBrandRoutes} from './brands.mjs';
import {registerCampaignRoutes} from './campaigns.mjs';
import {registerStudioRoutes} from './studio.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const data=path.resolve(process.env.DATA_DIR || path.join(root,'data'));
const port=Number(process.env.PORT || 4317), host=process.env.HOST || '127.0.0.1';
const previewPort=Number(process.env.PREVIEW_PORT || 4318);
const previewURL=process.env.PREVIEW_URL || 'http://127.0.0.1:'+previewPort;
const app=express(), preview=express();
const valid=id=>/^[0-9a-f-]{36}$/.test(id);
const issue=(msg,status=400)=>Object.assign(Error(msg),{status});
const folder=id=>{if(!valid(id))throw issue('Invalid project'); return path.join(data,id)};
function assetName(name){
 if(typeof name!=='string'||name.split('/').some(s=>!s||s==='.'||s==='..'||/[\\\x00-\x1f]/.test(s))) throw issue('Invalid filename');
 return name;
}
const ready=()=>Boolean(process.env.ANTHROPIC_API_KEY);
app.use('/api',(req,res,next)=>{
 if(req.headers.host!=='127.0.0.1:'+port && req.headers.host!=='localhost:'+port && req.headers.host!==process.env.PUBLIC_HOST)return res.sendStatus(403);
 if(req.method!=='GET' && req.headers['x-forma']!=='studio') return res.sendStatus(403);
 const author = req.headers['x-forma-author'] || process.env.FORMA_AUTHOR || null;
 authorStorage.run(author, next);
});
app.use(express.json({limit:'256kb'}));
// Text-only model call shared by brand notes and the campaign steps.
const runModelText = async ({mode, billing, model, effort, dir, system, user, task, controller, log, onText}) => {
  if (mode === 'codex') {
    return generateCodex({dir, files: [], billing, task, media: null, model, effort, controller, log, onText, prompt: {system, user}});
  }
  return generate({dir, files: [], billing, task, media: null, model, effort, controller, log, onText, prompt: {system, user}});
};
registerBrandRoutes(app, {runModelText, checkProvider});
registerStudioRoutes(app, {store, deps:{runModelText, checkProvider, previewURL, createClientCampaign:(...args) => campaignRoutes.createClientCampaign(...args)}});
// Each sign-in check runs a CLI (up to 10 s) and the store check is a database round trip; the page polls /api/status,
// so their answers are kept for a while and refreshed in the background (the first call waits, later ones never do).
const cachedCheck=(fn,ms)=>{let value,at=0,pending=null;return()=>{
 const refresh=()=>pending||(pending=Promise.resolve().then(fn).then(v=>{value=v;at=Date.now();return v},()=>value).finally(()=>{pending=null}));
 if(!at)return refresh();
 if(Date.now()-at>ms)refresh();
 return Promise.resolve(value);
}};
const isLocal=['127.0.0.1','localhost','::1'].includes(host);
const localChatLogin=cachedCheck(()=>isLocal && chatLogin(),60000);
const localClaudeLogin=cachedCheck(()=>isLocal && subscriptionReady(),60000);
const storeStatus=cachedCheck(()=>store.status(),30000);
app.get('/api/status',async(req,res)=>{const [claudeSubscription,chatReady,storeState]=await Promise.all([localClaudeLogin(),localChatLogin(),storeStatus()]);res.json({ready:ready(),claudeSubscription,codexReady:Boolean(codexKey()),chatReady,models,previewURL,
 formats:Object.values(formats),defaultFormats,durations,
 store:storeState,
 media:{ready:Boolean(mediaKey()),imageModel:imageModel(),videoModel:videoModel(),limits:mediaLimits()}})});
app.post('/api/projects',async(req,res)=>{
 const id=randomUUID(); await fs.mkdir(path.join(folder(id),'assets'),{recursive:true});
 await store.registerProject(id);
 res.json({id});
});
app.put('/api/projects/:id/file',express.raw({type:'application/octet-stream',limit:'128mb'}),async(req,res)=>{
 const dir=folder(req.params.id); await fs.access(dir);
 const relAsset=assetName(req.query.name);
 const dest=path.join(dir,'assets',relAsset); await fs.mkdir(path.dirname(dest),{recursive:true});
 await fs.writeFile(dest,req.body || Buffer.alloc(0),{flag:'wx'});
 await store.sync.up(req.params.id,{path:'assets/'+relAsset,dataDir:data});
 res.sendStatus(201);
});
async function checkProvider(mode,billing){
 if(mode==='codex' && !['chatgpt','api'].includes(billing))throw issue('Unknown sign-in method.');
 if(mode==='codex' && billing==='chatgpt' && !(await localChatLogin() || (isLocal && await chatLogin())))throw issue('Run codex login and sign in with ChatGPT for local use.',503);
 if(mode==='codex'&&billing==='api'&&!codexKey())throw issue('Add CODEX_API_KEY to .env and restart the server.',503);
 if(mode==='claude' && !['api','subscription'].includes(billing))throw issue('Unknown Claude billing method.');
 if(mode==='claude' && billing==='subscription' && !(await localClaudeLogin() || (isLocal && await subscriptionReady())))throw issue('Run npm run claude:login in the project folder to sign in with your Claude subscription.',503);
 if(mode==='claude'&&billing==='api'&&!ready())throw issue('To use Claude, add ANTHROPIC_API_KEY to .env and restart the server.',503);
}
const listAssets=async assets=>(await fs.readdir(assets,{recursive:true,withFileTypes:true})).filter(e=>e.isFile()).map(e=>path.relative(assets,path.join(e.parentPath,e.name)));
const generatedMedia=(job,project)=>job.events.filter(e=>e.media&&!e.media.attached).map(e=>({kind:e.media.kind,file:e.media.file,cost:e.media.cost,path:'/p/'+project+'/assets/'+e.media.file}));
const costLine=c=>c&&c.total?' · estimated API cost ≈ $'+c.total.toFixed(3)+(c.unknown?' + unknown':''):'';
const libs='<script type="importmap">'+JSON.stringify({imports:{three:'/lib/three/build/three.module.js','three/addons/':'/lib/three/examples/jsm/'}})+'</script><script src="/lib/gsap.js"></script><script src="/lib/lottie.js"></script>';
const assetURL=(id,file)=>previewURL+'/p/'+id+'/assets/'+String(file).split('/').map(encodeURIComponent).join('/');
const describeFormats=list=>list.map(f=>f.label).join(', ');
app.post('/api/projects/:id/render',async(req,res)=>{
 const dir=folder(req.params.id), {scenario,style,mode,task='creative'}=req.body;
 if(!['demo','claude','codex'].includes(mode)||typeof scenario!=='string'||typeof style!=='string'||!['creative','scenario','style'].includes(task)||(mode==='demo'&&(task!=='creative'||!scenario.trim()||!style.trim())))throw issue('Add a script and a visual style.');
 const selection=settings(mode,req.body.model,req.body.effort);
 const billing=req.body.billing ?? 'api';
 const formatList=pickFormats(req.body.formats), duration=pickDuration(req.body.duration);
 const media={images:req.body.media?.images===true, video:req.body.media?.video===true};
 if((media.images||media.video) && mode!=='demo' && !mediaKey())throw issue('To generate images, add OPENROUTER_API_KEY to .env and restart the server.',503);
 await checkProvider(mode,billing);
 await store.sync.down(req.params.id,{dataDir:data});
 const assets=path.join(dir,'assets'); await fs.mkdir(assets,{recursive:true}); const files=await listAssets(assets);
 const controller=new AbortController();
 const requestId=typeof req.body.requestId==='string' && valid(req.body.requestId) ? req.body.requestId : randomUUID();
 const job=createJob(requestId,{task,mode,project:req.params.id});
 const source=req.body.source && valid(String(req.body.source.style)) && [0,1,2].includes(req.body.source.index) ? {style:req.body.source.style,index:req.body.source.index} : undefined;
 const entry={id:requestId,type:task,project:req.params.id,mode,model:selection.model||null,effort:selection.effort||null,
   input:{scenario,...history.splitStyle(style),formats:formatList.map(f=>f.id),duration,media,files,source}};
 const keep=async(fields)=>{
   try{
     await store.sync.up(req.params.id,{dataDir:data});
     await history.record({...entry,...fields,durationMs:Date.now()-job.started,media:generatedMedia(job,req.params.id),cost:job.costs,log:job.events});
   }catch(error){console.error('[history] save failed',error.message)}
 };
 const log=logger(job,{mediaURL:file=>assetURL(req.params.id,file)});
 res.on('close',()=>{if(!res.writableFinished){controller.abort();if(!job.done)log('Client canceled the build',{level:'warn'})}});
 const taskName={creative:'creative',scenario:'script',style:'three styles'}[task];
 log('Task: '+taskName+' · '+({demo:'demo template',claude:'Claude',codex:'Codex'})[mode]+(selection.model?' · '+selection.model:'')+(selection.effort?' · effort '+selection.effort:''),{level:'step'});
 log('Materials: '+files.length+' files'+(task==='creative'?' · formats: '+describeFormats(formatList)+' · '+duration+' s'+(media.images||media.video?' · media: '+[media.images&&'images',media.video&&'video'].filter(Boolean).join(' + '):''):''),{detail:files.join('\n')||undefined});
 // Live views of what the model is writing.
 let draftAt=0, draftLen=0, draftRev=0, writing=false;
 const onText=text=>{
   job.text=text; job.tail=text.slice(-600);
   if(task==='style'){ const found=streamedSketches(text); if(found.length>job.sketches.length){ job.sketches=found; log('Sketch '+found.length+' of 3 ready',{level:'done'}); } }
   if(task!=='creative' || writing || Date.now()-draftAt<1800 || text.length-draftLen<400) return;
   const html=draftHTML(text); if(!html) return;
   writing=true; draftAt=Date.now(); draftLen=text.length;
   fs.writeFile(path.join(dir,'draft.html'),inject(html,{formats:formatList,duration})).then(()=>{
     draftRev++; job.draft={url:previewURL+'/p/'+req.params.id+'/draft.html',rev:draftRev};
     if(draftRev===1) log('Preview draft · updates as the model writes',{quiet:true});
   }).catch(()=>{}).finally(()=>{writing=false});
 };
 let html;
 try {
   if(mode==='demo'){
     html=await fs.readFile(path.join(root,'demo.html'),'utf8');
     const image=files.find(n=>/\.(png|jpg|jpeg|webp|gif)$/i.test(n));
     html=html.replace('/*INPUT*/null',()=>JSON.stringify({scenario,style,image:image?'assets/'+image.split('/').map(encodeURIComponent).join('/'):null}).replaceAll('<','\\u003c'));
     log('Demo template populated'+(image?' · image '+image:''));
   } else {
     const generator = mode==='codex' ? generateCodex : generate;
     html = await generator({dir:assets,files,scenario,style,billing,task,formats:formatList,duration,media,controller,log,onText,...selection});
     if(task==='creative'){
       log('Checking result · '+(html.length/1024).toFixed(0)+' KB of HTML',{level:'step'});
       if(!/window\.renderFrame\s*=/.test(html) || !/<\/body\s*>/i.test(html)) throw issue('The model did not return frame-by-frame animation. Try building again.',502);
     }
   }
   if(task==='style'){ const pitch=parseStyleChoices(html); log('Three styles ready: '+pitch.styles.map(s=>s.name).join(' · '),{level:'done'}); await keep({output:pitch}); return res.json({...pitch,historyId:requestId}); }
   if(task!=='creative'){ log('Script ready · '+html.length+' characters',{level:'done'}); await keep({output:{text:html}}); return res.json({text:html,historyId:requestId}); }
   const revision=randomUUID();
   await fs.writeFile(path.join(dir,revision+'.src.html'),html);
   html=inject(html,{formats:formatList,duration,libs});
   await fs.writeFile(path.join(dir,revision+'.html'),html);
   log('Creative saved · '+describeFormats(formatList)+' · '+((Date.now()-job.started)/1000).toFixed(0)+' s total'+costLine(job.costs),{level:'done'});
   const rel='/p/'+req.params.id+'/'+revision+'.html';
   await keep({output:{revision,path:rel,formats:formatList.map(f=>f.id),duration}});
   res.json({url:previewURL+rel,formats:formatList.map(f=>f.id),duration,historyId:requestId});
 } catch(error) {
   log(controller.signal.aborted?'Build stopped':'Error: '+error.message,{level:controller.signal.aborted?'warn':'error'});
   await keep({status:controller.signal.aborted?'cancelled':'error',error:error.message,output:null});
   throw error;
 } finally {
   finishJob(job);
 }
});
const campaignRoutes = registerCampaignRoutes(app, {
  root,
  dataDir: data,
  previewURL,
  libs,
  folder,
  assetName,
  checkProvider,
  listAssets,
  generatedMedia,
  costLine,
  assetURL,
  runModelText,
  runModelHtml: async ({mode, billing, model, effort, dir, system, user, task, media, extraReadDirs, extraReadFiles, controller, log, onText}) => {
    if (mode === 'codex') {
      return generateCodex({dir, files: [], billing, task, media, model, effort, controller, log, onText, prompt: {system, user}});
    }
    return generate({dir, files: [], billing, task, media, model, effort, controller, log, onText, prompt: {system, user}, extraReadDirs, extraReadFiles});
  },
  runModelRevise: async ({dir, workFile, files, billing, model, effort, systemPrompt, prompt, media, controller, log, onEdit, stage}) => {
    return revise({dir, workFile, files, billing, model, effort, systemPrompt, prompt, media, controller, log, onEdit, stage});
  },
});
const {reviseCampaignEntry} = campaignRoutes;

app.get('/api/history',async(req,res)=>{
 const {type,project,before,limit,path:outputPath,campaign,author,excludeAuthor}=req.query;
 if(type && !['creative','style','scenario','preview','campaign'].includes(type)) throw issue('Unknown entry type.');
 res.set('Cache-Control','no-store').json(await history.list({type,project,before,limit,path:outputPath,campaign,author,excludeAuthor}));
});
app.get('/api/history/:id/thread',async(req,res)=>{
 const chain=await history.thread(req.params.id);
 if(!chain.length) throw issue('Entry not found.',404);
 res.set('Cache-Control','no-store').json({thread:chain});
});
// Chat edit of an existing creative or preview (fresh build or one opened from history). Produces a new entry chained to its parent.
app.post('/api/history/:id/revise',async(req,res)=>{
 const parent=await history.get(req.params.id);
 if(parent && parent.campaign && ['preview','creative'].includes(parent.type) && parent.output?.path) {
   return reviseCampaignEntry(req, res, parent);
 }
 if(!parent || parent.type!=='creative' || !parent.output?.path) throw issue('Only saved creatives can be revised.',404);
 const {mode,message='',requestId:rid}=req.body;
 if(!['claude','codex'].includes(mode)) throw issue('Select Claude or Codex for revisions.');
 const attachments=Array.isArray(req.body.attachments)?req.body.attachments.map(assetName):[];
 if(typeof message!=='string' || (!message.trim() && !attachments.length)) throw issue('Describe a change or attach a file.');
 if(message.length>8000 || attachments.length>12) throw issue('The message is too long or has too many attachments.');
 const selection=settings(mode,req.body.model,req.body.effort), billing=req.body.billing ?? 'api';
 await checkProvider(mode,billing);
 const media={images:req.body.media?.images===true, video:req.body.media?.video===true};
 if((media.images||media.video) && !mediaKey()) throw issue('To generate images, add OPENROUTER_API_KEY to .env and restart the server.',503);
 const project=parent.project, dir=folder(project), assets=path.join(dir,'assets');
 await fs.mkdir(assets,{recursive:true});
 await store.sync.down(project,{dataDir:data});
 const formatList=pickFormats(parent.output.formats), duration=pickDuration(parent.output.duration||8);
 const files=await listAssets(assets);
 for(const a of attachments) if(!files.includes(a)) throw issue('Attachment not found: '+a);
 const revisionFile=path.join(data,parent.output.path.replace(/^\/p\//,''));
 const source=await fs.readFile(revisionFile.replace(/\.html$/,'.src.html'),'utf8').catch(async()=>uninject(await fs.readFile(revisionFile,'utf8')));
 const requestId=typeof rid==='string' && valid(rid) ? rid : randomUUID();
 const job=createJob(requestId,{task:'creative',mode,project});
 const log=logger(job,{mediaURL:file=>assetURL(project,file)});
 const controller=new AbortController();
 res.on('close',()=>{if(!res.writableFinished){controller.abort();if(!job.done)log('Client canceled the revision',{level:'warn'})}});
 const chain=(await history.thread(parent.id)).filter(e=>e.input?.revision).map(e=>({message:e.input.revision.message,attachments:e.input.revision.attachments,reply:e.output?.reply}));
 log('Revision · '+({claude:'Claude',codex:'Codex'})[mode]+(selection.model?' · '+selection.model:'')+(selection.effort?' · effort '+selection.effort:'')+' · version from '+new Date(parent.createdAt).toLocaleString('ru-RU'),{level:'step',detail:message});
 if(attachments.length) log('Attachments: '+attachments.join(', '),{media:attachments.find(a=>/\.(png|jpe?g|webp|gif)$/i.test(a))?{kind:'image',attached:true,file:attachments.find(a=>/\.(png|jpe?g|webp|gif)$/i.test(a))}:undefined});
 const entry={id:requestId,type:'creative',project,mode,model:selection.model||null,effort:selection.effort||null,
   input:{...parent.input,media,files,revision:{parent:parent.id,message,attachments}}};
 const keep=async fields=>{try{await store.sync.up(project,{dataDir:data});await history.record({...entry,...fields,durationMs:Date.now()-job.started,media:generatedMedia(job,project),cost:job.costs,log:job.events})}catch(error){console.error('[history] save failed',error.message)}};
 const work=await fs.mkdtemp(path.join(tmpdir(),'forma-edit-')), workFile=path.join(work,'creative.html');
 let draftRev=0;
 const onEdit=async()=>{
   const html=await fs.readFile(workFile,'utf8');
   await fs.writeFile(path.join(dir,'draft.html'),inject(html,{formats:formatList,duration,libs}));
   draftRev++; job.draft={url:previewURL+'/p/'+project+'/draft.html',rev:draftRev};
 };
 try{
   await fs.writeFile(workFile,source);
   let html, reply;
   if(mode==='claude'){
     ({html,reply}=await revise({dir:assets,workFile,files,brief:parent.input,thread:chain,message,attachments,billing,formats:formatList,duration,media,controller,log,onEdit,...selection}));
   } else {
     const useMedia=Boolean(mediaKey()) && (media.images||media.video);
     const prompt={system:revisionInstructions({formats:formatList,duration,media:useMedia?media:null,editing:false}),
       user:revisionMessage({brief:parent.input,files,thread:chain,message,attachments,formats:formatList,duration,current:source})};
     html=await generateCodex({dir:assets,files,billing,task:'creative',formats:formatList,duration,media,controller,log,onText:()=>{},prompt,...selection});
     reply=revisionReply(html);
   }
   html=checkHTML(html,({claude:'Claude',codex:'Codex'})[mode],'creative');
   if(!/window\.renderFrame\s*=/.test(html) || !/<\/body\s*>/i.test(html)) throw issue('Frame-by-frame animation is missing after the edit. Try again.',502);
   const revision=randomUUID(), rel='/p/'+project+'/'+revision+'.html';
   await fs.writeFile(path.join(dir,revision+'.src.html'),html);
   await fs.writeFile(path.join(dir,revision+'.html'),inject(html,{formats:formatList,duration,libs}));
   log('New version saved · '+((Date.now()-job.started)/1000).toFixed(0)+' s'+costLine(job.costs),{level:'done'});
   await keep({output:{revision,path:rel,formats:formatList.map(f=>f.id),duration,reply:reply||'Done.'}});
   res.json({url:previewURL+rel,formats:formatList.map(f=>f.id),duration,historyId:requestId,reply:reply||'Done.',cost:job.costs});
 } catch(error) {
   log(controller.signal.aborted?'Revision stopped':'Error: '+error.message,{level:controller.signal.aborted?'warn':'error'});
   await keep({status:controller.signal.aborted?'cancelled':'error',error:error.message,output:null});
   throw error;
 } finally {
   finishJob(job);
   await fs.rm(work,{recursive:true,force:true}).catch(()=>{});
 }
});
app.get('/api/history/:id',async(req,res)=>{
 const entry=await history.get(req.params.id,{withLog:true});
 if(!entry) throw issue('Entry not found.',404);
 res.json(entry);
});
// One-time import of the brief the browser kept in localStorage before history existed.
app.post('/api/history/import-local',async(req,res)=>{
 const last=req.body?.last;
 if(!last || typeof last.url!=='string') return res.json({imported:0});
 let rel; try{rel=new URL(last.url).pathname}catch{return res.json({imported:0})}
 const text=v=>typeof v==='string'?v:'';
 const input={scenario:text(last.scenario),...history.splitStyle(text(last.style))};
 const found=await history.findBy(e=>e.type==='creative' && e.output?.path===rel);
 if(found){
   if(found.input?.scenario || found.input?.style) return res.json({imported:0});
   await history.update(found.id,{input,caption:text(last.caption)||undefined,imported:'files+browser'});
   return res.json({imported:1,id:found.id});
 }
 if(!input.scenario && !input.style) return res.json({imported:0});
 const entry=await history.record({type:'creative',status:'error',error:'Creative file not found in data/',imported:'browser',project:rel.split('/')[2]||null,
   caption:text(last.caption)||undefined,input:{...input,formats:last.formats||['1x1'],duration:last.duration||6},output:null,
   log:[{at:0,level:'info',msg:'Brief restored from browser storage'}]});
 res.json({imported:1,id:entry.id});
});
app.use('/shared',express.static(path.join(root,'shared')));
app.use(express.static(path.join(root,'public')));
// Pages of the studio are real addresses: the app answers them and routes on the client.
app.get(/^\/(?:brands|campaigns|clients)(?:\/.*)?$/,(req,res)=>res.sendFile(path.join(root,'public','index.html')));
preview.use((req,res,next)=>{
 res.set({'Access-Control-Allow-Origin':'*','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src blob:; base-uri 'none'; form-action 'none'"}); next();
});
preview.use('/lib/three',express.static(path.join(root,'node_modules/three')));
for(const [url,file] of [['gsap','gsap/dist/gsap.min.js'],['lottie','lottie-web/build/player/lottie.min.js']])preview.get('/lib/'+url+'.js',(req,res)=>res.sendFile(path.join(root,'node_modules',file)));
preview.get('/demo',(req,res)=>res.sendFile(path.join(root,'demo.html')));
preview.use('/p/history',(req,res)=>res.sendStatus(404)); // logs and prompts stay off the preview origin
preview.use('/p',createPreviewReadThrough({dataDir:data,blobs:store.blobs}));
app.use((err,req,res,next)=>{res.status(err.status||500).json({error:err.code==='EEXIST'?'A file with this name already exists.':err.message});});
if (store.driver === 'supabase') await import('@aws-sdk/client-s3').catch(err => {
 throw Error('To access R2, run npm ci in ' + root + ' and restart Forma.', {cause:err});
});
preview.use((err,req,res,next)=>{
 console.error('[preview]',err.message);
 if (res.headersSent) return next(err);
 res.status(502).type('text/plain').send('Could not load the preview file from storage.');
});
await fs.mkdir(data,{recursive:true});
const known=await history.openHistory(data), imported=await history.importExisting(data);
console.log('History: '+(known+imported)+' entries'+(imported?' (creatives imported from data/: '+imported+')':''));
function listen(service, listenPort) {
  return new Promise((resolve,reject)=>service.listen(listenPort,host,error=>error?reject(error):resolve()));
}
await listen(preview,previewPort);
await listen(app,port);
console.log('Forma Studio http://'+host+':'+port);
