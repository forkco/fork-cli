import {writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {virtualComputer} from './virtual-computer.js';
let input='';for await(const chunk of process.stdin)input+=chunk;
const {url,workspace}=JSON.parse(input);const root=resolve(workspace);await mkdir(join(root,'.fork'),{recursive:true,mode:0o700});
const pc=virtualComputer({workspace:join(root,'.fork/computer')});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>pc.close().finally(()=>process.exit(1)));
try{
 const opened=await pc.run({action:'open',url,device:'desktop'});
 const inspected=await pc.run({action:'inspect',session_id:opened.session_id});
 const screenshot=await pc.run({action:'screenshot',session_id:opened.session_id,format:'png'});
 await writeFile(join(root,'.fork/preview.png'),Buffer.from(screenshot.image.base64,'base64'),{mode:0o600});
 const html=await pc.run({action:'get_html',session_id:opened.session_id,limit:65536});
 await writeFile(join(root,'.fork/browser-test.json'),JSON.stringify({preview_url:url,inspection:inspected}),{mode:0o600});
 await writeFile(join(root,'.fork/preview.html'),typeof html.html==='string'?html.html:JSON.stringify(html),{mode:0o600});
 console.log(JSON.stringify({status:'loaded',inspection:inspected,screenshot:'.fork/preview.png'}));
}finally{await pc.close()}
