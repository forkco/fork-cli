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
