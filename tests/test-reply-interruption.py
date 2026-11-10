"""Real connector + native subprocess: cancel running/queued turns on one SSE."""
import http.server,json,os,pathlib,subprocess,sys,tempfile,threading,time,uuid

binary=str(pathlib.Path(sys.argv[1]).resolve())
with tempfile.TemporaryDirectory(prefix='fork-interrupt-test-') as directory:
    root=pathlib.Path(directory); config=root/'config'; config.mkdir(mode=0o700)
    first,second,latest=[str(uuid.uuid4()) for _ in range(3)]
    session=str(uuid.uuid4()); completed=[]; streams=[]; errors=[]; done=threading.Event()
    def wait_for(predicate,seconds=15):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            if predicate():return
            time.sleep(.02)
        raise AssertionError('Interruption test timed out')
    agent=root/'claude'
    agent.write_text('#!'+sys.executable+'\n'+'''
import json,os,pathlib,signal,sys,time
root=pathlib.Path(os.environ['INTERRUPT_TEST_ROOT'])
if sys.argv[1:3]==['auth','status']:sys.exit(0)
if '--input-format' in sys.argv:
 print(json.dumps({'type':'control_response','response':{'request_id':'fork-models','response':{'models':[]}}}),flush=True)
 time.sleep(30);sys.exit(0)
sys.stdin.read()
task=os.environ['FORK_TASK_ID']
(root/(task+'.started')).write_text(str(os.getpid()))
if task==os.environ['INTERRUPT_TEST_FIRST']:
 def stop(*args):
  (root/'terminated').touch();sys.exit(0)
 signal.signal(signal.SIGTERM,stop)
 time.sleep(30)
 (root/'stale-finished').touch()
print(json.dumps({'type':'result','result':'LATEST_REPLY','is_error':False,'usage':{'input_tokens':1,'output_tokens':1}}),flush=True)
''');agent.chmod(0o700)
    class API(http.server.BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def reply(self,value):
            self.send_response(200);self.end_headers();self.wfile.write(json.dumps(value).encode())
        def do_PUT(self):
            self.rfile.read(int(self.headers.get('Content-Length',0)));self.reply({})
        def do_POST(self):
            data=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))) or '{}')
            if self.path.endswith('/complete'):
                completed.append((self.path.split('/')[-2],data));done.set()
            self.reply({})
        def do_GET(self):
            if self.path.endswith('/context'):self.reply({'messages':[]});return
            if not self.path.startswith('/api/cli/events'):self.reply({});return
            streams.append(self.path)
            self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
            def send(kind,value):
                self.wfile.write(('event: '+kind+'\ndata: '+json.dumps(value)+'\n\n').encode());self.wfile.flush()
            def task(id):
                return {'id':id,'message_id':str(uuid.uuid4()),'topic_id':'chat.test','content':id,'payload':{}}
            try:
                send('ready',{'session_id':session})
                send('task',task(first))
                wait_for(lambda:(root/(first+'.started')).exists())
                send('cancel',{'task_id':first})
                send('task',task(second))
                send('cancel',{'task_id':second})
                send('task',task(latest))
                while not done.wait(.25):send('heartbeat',{'session_id':session})
                # Keep the stream alive until the parent stops the connector.
                time.sleep(2)
            except (BrokenPipeError,ConnectionResetError):pass
            except Exception as error:errors.append(str(error));done.set()
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),API)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    (config/'config.json').write_text(json.dumps({'origin':f'http://127.0.0.1:{server.server_port}','token':'test-only','agent':'claude','virtual_computer':False}))
    env=dict(os.environ,FORK_CONFIG_DIR=str(config),PATH=str(root)+os.pathsep+os.environ['PATH'],INTERRUPT_TEST_ROOT=str(root),INTERRUPT_TEST_FIRST=first)
    process=subprocess.Popen([binary,'run'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        wait_for(done.is_set)
        assert not errors,errors
        assert [id for id,_ in completed]==[latest],completed
        assert completed[0][1]['summary']=='LATEST_REPLY'
        assert (root/'terminated').exists() and not (root/'stale-finished').exists(),'Old native process continued'
        assert not (root/(second+'.started')).exists(),'Cancelled queued task started'
        assert not (config/'results'/(first+'.json')).exists(),'Cancelled receipt persisted'
        assert len(streams)==1,'Cancellation disconnected the account'
        print('Reply interruption: old process stopped; queued turn skipped; only latest reply completed on the same connection.')
    finally:
        process.terminate()
        try:process.communicate(timeout=10)
        except subprocess.TimeoutExpired:process.kill();process.communicate()
        server.shutdown();server.server_close()
