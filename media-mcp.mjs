// Minimal stdio MCP server exposing the OpenRouter media tools to Codex CLI.
// Codex starts it per build with FORMA_ASSETS (materials folder) and FORMA_MEDIA (JSON {images,video}).
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
import {z} from 'zod';
import {mediaSession, imageShape, videoShape, trackShape, toolText, asToolResult} from './media.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

const dir = path.resolve(process.env.FORMA_ASSETS || '.');
const allow = JSON.parse(process.env.FORMA_MEDIA || '{"images":true,"video":false}');
// FORMA_LOG: JSON-lines file the server tails to show these events in the build journal.
const log = (msg, extra = {}) => {
  const line = JSON.stringify({msg, ...extra}) + '\n';
  if (process.env.FORMA_LOG) appendFileSync(process.env.FORMA_LOG, line);
  else process.stderr.write(line);
};
const session = mediaSession({dir, allow, log});
const schema = shape => { const {$schema, ...rest} = z.toJSONSchema(z.object(shape), {io:'input'}); return rest; };
const tools = [];
if (allow.images) tools.push({name:'generate_image', description:toolText.image, inputSchema:schema(imageShape)});
if (allow.video) tools.push({name:'generate_video', description:toolText.video, inputSchema:schema(videoShape)});
tools.push({name:'track_screen', description:toolText.track, inputSchema:schema(trackShape)});

const send = message => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...message}) + '\n');
createInterface({input:process.stdin}).on('line', async line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notifications
  const reply = result => send({id:msg.id, result});
  switch (msg.method) {
    case 'initialize':
      return reply({protocolVersion:msg.params?.protocolVersion || '2025-06-18', capabilities:{tools:{}}, serverInfo:{name:'forma-media', version:'1.0.0'}});
    case 'ping': return reply({});
    case 'tools/list': return reply({tools});
    case 'tools/call': {
      const {name, arguments:args} = msg.params || {};
      const fn = name === 'generate_image' && allow.images ? session.image : name === 'generate_video' && allow.video ? session.video : name === 'track_screen' ? session.track : null;
      if (!fn) return reply({isError:true, content:[{type:'text', text:'Unknown tool ' + name}]});
      return reply(await asToolResult(() => fn(args || {})));
    }
    default: return send({id:msg.id, error:{code:-32601, message:'Method not found'}});
  }
});
