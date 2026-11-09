import readline from 'node:readline';
import {resolve,join} from 'node:path';
import {virtualComputer} from './virtual-computer.js';
const computer=virtualComputer({workspace:join(resolve(process.env.FORK_WORKSPACE||process.cwd()),'.fork','computer')});
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
let chain=Promise.resolve(),closing=false;
async function close(){if(closing)return;closing=true;lines.close();await chain.catch(()=>{});await computer.close()}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{computer.close().finally(()=>process.exit(0))});
lines.on('line',line=>{chain=chain.then(async()=>{
 let message;try{message=JSON.parse(line)}catch{return}
 if(!('id' in message))return;
 let result;
 try{
  if(message.method==='ping')result={};
  else if(message.method==='initialize')result={protocolVersion:message.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fork-virtual-computer',version:'0.4.0'}};
  else if(message.method==='tools/list')result={tools:[{name:'computer',description:'Use your task-scoped virtual computer: open URLs, inspect, click, fill, press, evaluate JavaScript, screenshot, tabs, downloads and workspace tools. First open a URL, then use its session_id. Always verify the requested outcome. Call close when finished.',inputSchema:{type:'object',properties:{command:{type:'object',properties:{action:{type:'string',enum:['open','navigate','inspect','click','fill','press','scroll','wait','evaluate','screenshot','close','tabs','new_tab','switch_tab','close_tab','get_html','resources','read_resource','downloads','read_file','upload','set_device','sh','run_code','write_file','file_tool']},url:{type:'string'},html:{type:'string'},session_id:{type:'string'},selector:{type:'string'},text:{type:'string'},key:{type:'string'},code:{type:'string'},arg:{},device:{type:'string',enum:['desktop','android']},width:{type:'integer'},height:{type:'integer'},tab_id:{type:'string'},format:{type:'string',enum:['png','jpeg']},full_page:{type:'boolean'}},required:['action']}},required:['command']}}]};
  else if(message.method==='tools/call'){
   if(message.params?.name!=='computer')throw Error('Unknown tool');
   const value=await computer.run(message.params.arguments?.command);const image=value.image;delete value.image;
   result={content:[{type:'text',text:JSON.stringify(value)},...(image?[{type:'image',mimeType:image.mime_type,data:image.base64}]:[])]};
  }else throw Error('Unknown method');
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');
 }catch(error){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{isError:true,content:[{type:'text',text:error.message}]}})+'\n')}
 }).catch(error=>process.stderr.write(error.message+'\n'))});
lines.once('close',()=>{close().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1})});
