import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {virtualComputer} from '../src/virtual-computer.js';
test('local adapter stays idle until a computer request and closes without starting Chromium',async()=>{
 const pc=virtualComputer();assert.deepEqual(pc.stats(),{sessions:0,active:0});await pc.close();await assert.rejects(pc.run({action:'open',url:'https://example.com'}),/closed/);
});
test('stdio initialization and tool discovery exit cleanly without starting the computer',{timeout:10000},async()=>{
 const child=spawn(process.execPath,['src/stdio.js'],{cwd:new URL('..',import.meta.url),stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
 child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}})+'\n'+JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})+'\n');
 const code=await new Promise(resolve=>child.on('exit',resolve));assert.equal(code,0,err);const messages=out.trim().split('\n').map(JSON.parse);assert.equal(messages[0].result.serverInfo.name,'fork-virtual-computer');assert.equal(messages[1].result.tools[0].name,'computer');
});
