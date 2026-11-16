import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createRequire} from 'node:module';

const run=promisify(execFile);
const require=createRequire(import.meta.url);
export function executable(){
  const platform=process.platform+'-'+process.arch;
  return require.resolve('@anthropic-ai/claude-agent-sdk-'+platform+'/'+(process.platform==='win32'?'claude.exe':'claude'));
}
export function subscriptionEnv(){
  const names=['PATH','HOME','USER','LANG','TMPDIR','CLAUDE_CONFIG_DIR','USERPROFILE','SystemRoot','LOCALAPPDATA','APPDATA'];
  // ENABLE_CLAUDEAI_MCP_SERVERS=false: no claude.ai connectors in Forma runs (also set via settings in generator.mjs).
  return {...Object.fromEntries(names.filter(name=>process.env[name]).map(name=>[name,process.env[name]])), ENABLE_CLAUDEAI_MCP_SERVERS:'false'};
}
export async function subscriptionReady(){
  try{
    const {stdout}=await run(executable(),['auth','status','--json'],{env:subscriptionEnv(),timeout:10000});
    const status=JSON.parse(stdout);
    return status.loggedIn===true && status.authMethod==='claude.ai';
  }catch{return false}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const child=spawn(executable(),['auth','login','--claudeai'],{env:subscriptionEnv(),stdio:'inherit'});
  child.on('exit',code=>{process.exitCode=code??1});
}
