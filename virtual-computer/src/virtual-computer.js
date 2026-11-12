// Local, task-scoped adapter for the same browser engine used by the service.
// No HTTP control port, service credential, profile backend or background daemon.
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {configuration} from './config.js';
import {startProxy} from './network.js';
import {ownerBrowser} from './owner-browser.js';
import {Sessions} from './sessions.js';
export function virtualComputer({workspace,browserExecutable}={}) {
  const owner={user_id:randomUUID(),app_id:randomUUID()};
  let instance,proxy,starting,closed=false;
  let appBridge;
  // adoptPage is awaited before the first navigation, also for new tabs.
  class LocalSessions extends Sessions {
    async adoptPage(session,page) {
      if (appBridge && !session.appBridgeReady) session.appBridgeReady=appBridge.install(session.context);
      await session.appBridgeReady;
      return super.adoptPage(session,page);
    }
  }
  async function start(){
    if(closed)throw Error('Virtual computer is closed');
    if(!starting)starting=(async()=>{
      const config=configuration({...process.env,COMPUTER_SECRET:randomBytes(32).toString('hex'),COMPUTER_WORK_ROOT:workspace||'',COMPUTER_MAX_SESSIONS:'1',COMPUTER_MAX_PER_USER:'1',COMPUTER_MAX_PER_APP_USER:'1',COMPUTER_PROFILE_BACKEND:'',COMPUTER_SSH_BACKEND:'',COMPUTER_BROWSER_EXECUTABLE:browserExecutable||process.env.FORK_CHROME||''});
      if(workspace)await mkdir(workspace,{recursive:true,mode:0o700});
      proxy=await startProxy();instance=new LocalSessions(config,proxy.url);
    })();
    await starting;
  }
  return {
    async run(command) {
      await start();
      if (command?.action==='open_app') {
        if(instance.stats().sessions) throw Error('Close the current browser session first');
        appBridge=await ownerBrowser(command.target);
        return instance.run(owner,{action:'open',url:appBridge.url,device:command.device||'desktop'});
      }
      if(command?.action==='open') appBridge=undefined;
      return instance.run(owner,command);
    },
    async close(){closed=true;if(starting)await starting.catch(()=>{});await instance?.close();await proxy?.close()},
    stats(){return instance?.stats()||{sessions:0,active:0}},
  };
}
