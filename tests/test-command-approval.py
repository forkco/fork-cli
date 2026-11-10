"""Exercise the real compact MCP binary: deny, failed transport, and approve."""
import http.server,json,os,pathlib,subprocess,sys,tempfile,threading,uuid
binary=str(pathlib.Path(sys.argv[1]).resolve())
class Approval(http.server.BaseHTTPRequestHandler):
    allowed=False
    def log_message(self,*args):pass
    def do_POST(self):
        req=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert self.path.endswith('/command-approval')
        assert req['session_id']==session and req['cwd']==str(root)
        self.send_response(200);self.end_headers()
        self.wfile.write(b'\n\n'+json.dumps({'approved':self.allowed,'scope':'once'}).encode())
with tempfile.TemporaryDirectory(prefix='fork-command-test-') as directory:
    root=pathlib.Path(directory).resolve(); config=root/'config';config.mkdir(mode=0o700)
    session=str(uuid.uuid4());task=str(uuid.uuid4())
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Approval)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    cfg={'origin':f'http://127.0.0.1:{server.server_port}','token':'test-only','agent':'claude','virtual_computer':False}
    (config/'config.json').write_text(json.dumps(cfg))
    environment=dict(os.environ,FORK_CONFIG_DIR=str(config),FORK_TASK_ID=task,FORK_SESSION_ID=session,FORK_WORKSPACE_ROOT=str(root))
    def call():
        request={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'run_command','arguments':{'command':'printf approved > sentinel','cwd':str(root)}}}
        output=subprocess.run([binary,'agent-tools'],input=json.dumps(request)+'\n',env=environment,text=True,capture_output=True,timeout=20,check=True)
        return json.loads(output.stdout)['result']
    assert call()['isError'] and not (root/'sentinel').exists(),'Denied command executed'
    Approval.allowed=True
    assert not call()['isError'] and (root/'sentinel').read_text()=='approved','Approved command failed'
    (root/'sentinel').unlink();server.shutdown();server.server_close()
    assert call()['isError'] and not (root/'sentinel').exists(),'Failed approval transport executed a command'
    print('MCP execution gate: denial, whitespace response, approved execution and failed-transport denial passed.')

class WorkspaceAPI(http.server.BaseHTTPRequestHandler):
    approvals=0
    previews=0
    def log_message(self,*args):pass
    def do_POST(self):
        req=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.send_response(200);self.end_headers()
        if self.path.endswith('/command-approval'):
            type(self).approvals+=1
            self.wfile.write(json.dumps({'approved':False}).encode())
        elif self.path.endswith('/previews'):
            type(self).previews+=1
            assert req['files']=={'index.html':'<h1>Own app</h1>'}
            self.wfile.write(json.dumps({'token':'a'*32,'preview_url':'https://example.invalid/preview'}).encode())
        else:
            raise AssertionError(self.path)
with tempfile.TemporaryDirectory(prefix='fork-workspace-test-') as directory:
    root=pathlib.Path(directory).resolve();config=root/'config';config.mkdir(mode=0o700)
    (root/'.fork').mkdir();app=str(uuid.uuid4())
    (root/'.fork/workspace.json').write_text(json.dumps({'app_id':app,'revision':'test'}))
    (root/'index.html').write_text('<h1>Own app</h1>')
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),WorkspaceAPI)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    (config/'config.json').write_text(json.dumps({'origin':f'http://127.0.0.1:{server.server_port}','token':'test-only','agent':'claude','virtual_computer':False}))
    environment=dict(os.environ,FORK_CONFIG_DIR=str(config),FORK_TASK_ID=str(uuid.uuid4()),FORK_SESSION_ID=str(uuid.uuid4()),FORK_WORKSPACE_ROOT=str(root),FORK_APP_ID=app,FORK_TASK_KIND='build')
    def workspace_call(tool,args,extra=None):
        request={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':tool,'arguments':args}}
        result=subprocess.run([binary,'agent-tools'],input=json.dumps(request)+'\n',env={**environment,**(extra or {})},text=True,capture_output=True,timeout=20,check=True)
        return json.loads(result.stdout)['result']
    assert not workspace_call('workspace',{'action':'push'})['isError']
    assert not workspace_call('run_command',{'command':f"'{binary}' push"})['isError']
    assert WorkspaceAPI.previews==2 and WorkspaceAPI.approvals==0,'Fork push asked for shell approval'
    assert not workspace_call('workspace',{'action':'save'})['isError'],'Managed save should explain automatic commit'
    assert WorkspaceAPI.approvals==0
    for command in [f"'{binary}' push; touch sentinel",f"'{binary}' push && touch sentinel",'/tmp/not-the-cli/fork push']:
        assert workspace_call('run_command',{'command':command})['isError']
    assert WorkspaceAPI.approvals==3 and WorkspaceAPI.previews==2 and not (root/'sentinel').exists()
    assert workspace_call('workspace',{'action':'push'},{'FORK_TASK_KIND':'app_manager'})['isError']
    assert workspace_call('workspace',{'action':'push'},{'FORK_APP_ID':str(uuid.uuid4())})['isError']
    server.shutdown();server.server_close()
    print('Fork workspace: native/legacy push without approval; managed save; compound-command and app/role boundaries passed.')
