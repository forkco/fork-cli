"""One daemon, two native processes blocked on a barrier, isolated app previews."""
import http.server, json, os, pathlib, socket, subprocess, sys, tempfile, threading, time, uuid

binary = str(pathlib.Path(sys.argv[1]).resolve())
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    cfg = root / 'config'
    cfg.mkdir(mode=0o700)
    ids = [str(uuid.uuid4()) for _ in range(2)]
    sessions = [str(uuid.uuid4()) for _ in ids]
    apps = [str(uuid.uuid4()) for _ in ids]
    previews, completed, streams = {}, {}, []
    lock = threading.Lock()
    release = threading.Event()
    cli = root / 'claude'
    cli.write_text('#!' + sys.executable + '\n' + """
import os, time, json, sys, pathlib
if sys.argv[1:3] == ['auth','status']: sys.exit(0)
if '--input-format' in sys.argv:
 print(json.dumps({'type':'control_response','response':{'request_id':'fork-models','response':{'models':[]}}}),flush=True)
 sys.exit(0)
sys.stdin.read()
e=os.environ
cwd=pathlib.Path.cwd(); ctrl=pathlib.Path(e['FORK_CONFIG_DIR'])
assert cwd==pathlib.Path(e['FORK_WORKSPACE_ROOT']).resolve()
app=e['FORK_APP_ID']; task=e['FORK_TASK_ID']
assert (cwd/'index.html').read_text()==app
(ctrl/(task+'.started')).write_text(e['FORK_SESSION_ID'])
for i in range(400):
 if (ctrl/'continue').exists(): break
 time.sleep(.05)
else: raise RuntimeError('No concurrent worker')
(cwd/'index.html').write_text(app+'/'+task)
print(json.dumps({'type':'result','result':task,'is_error':False,'usage':{'input_tokens':1,'output_tokens':1}}))
""")
    cli.chmod(0o700)
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def respond(self, data):
            self.send_response(200); self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        def do_GET(self):
            if self.path.endswith('/snapshot'):
                return self.respond({'files':{'index.html':self.path.split('/')[-2]}, 'revision':'initial'})
            if not self.path.startswith('/api/cli/events'):
                return self.respond({})
            with lock:
                n=len(streams); streams.append(self.path)
            assert n<2, 'Worker reconnected unexpectedly'
            self.send_response(200); self.end_headers()
            for event,data in [('ready',{'session_id':sessions[n]}), ('task',{'id':ids[n],'topic_id':'app.'+apps[n],'active_app_id':apps[n],'payload':{'execution_kind':'build'}})]:
                self.wfile.write(('event: '+event+'\ndata: '+json.dumps(data)+'\n\n').encode()); self.wfile.flush()
            release.wait(30)
        def do_POST(self):
            body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))) or '{}')
            key=self.path.split('/')[-2]
            if self.path.endswith('/previews'):
                previews[key]=body['files']; return self.respond({'preview_url':'https://example.invalid','token':key})
            if self.path.endswith('/complete'): completed[key]=body
            self.respond({})
        do_PUT=do_POST
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    (cfg/'config.json').write_text(json.dumps({'origin':'http://127.0.0.1:'+str(server.server_port),'agent':'claude','token':'fixture'}))
    process=subprocess.Popen([binary,'run'],env=dict(os.environ,FORK_CONFIG_DIR=str(cfg),TMPDIR=tmp,PATH=str(root)+os.pathsep+os.environ['PATH']))
    def wait_for(check):
        end=time.monotonic()+15
        while not check():
            assert process.poll() is None and time.monotonic()<end, 'Concurrent worker timed out'
            time.sleep(.02)
    try:
        wait_for(lambda:all((cfg/(task+'.started')).exists() for task in ids))
        with socket.socket(socket.AF_UNIX) as sock:
            sock.connect(str(cfg/'control.sock')); sock.sendall(b'prepare-update')
            assert not json.load(sock.makefile('rb'))['ready']
        (cfg/'continue').touch()
        wait_for(lambda:len(completed)==2)
        for task,app,session in zip(ids,apps,sessions):
            assert (cfg/(task+'.started')).read_text()==session
            assert completed[task]['summary'].splitlines()[0]==task and completed[task]['preview_token']==app and not completed[task]['failure']
            assert previews[app]=={'index.html':app+'/'+task}
        print('Two simultaneous native edits, independent previews, update deferred.')
    finally:
        process.terminate(); release.set()
        try: process.wait(10)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
        server.shutdown(); server.server_close()
