"""A tool introduced by the server must work without a CLI allowlist change."""
import json, os, pathlib, subprocess, sys, tempfile, uuid
binary = pathlib.Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory() as folder:
    root = pathlib.Path(folder)
    private = root / '.fork'
    private.mkdir()
    tools = [{'name': 'new_server_action', 'description': 'fixture', 'inputSchema': {'type': 'object'}}]
    (private / 'tools.json').write_text(json.dumps(tools))
    env = dict(os.environ, FORK_TASK_KIND='model_turn', FORK_LOCAL_CONTROLS='0', FORK_WORKSPACE_ROOT=folder, FORK_TASK_ID=str(uuid.uuid4()), FORK_SESSION_ID=str(uuid.uuid4()))
    def call(proc, method, params):
        proc.stdin.write(json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params})+'\n')
        proc.stdin.flush()
        return json.loads(proc.stdout.readline())['result']
    with subprocess.Popen([binary, 'agent-tools'], env=env, text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE) as proc:
        assert call(proc, 'tools/list', {})['tools'] == tools
        assert 'isError' not in call(proc,'tools/call',{'name':'new_server_action','arguments':{'value':7}})
        for denied in ['run_command','host_run_command','publish_app_icon','not_offered']:
            assert call(proc,'tools/call',{'name':denied,'arguments':{}})['isError']
        proc.stdin.close()
    assert json.loads((private/'calls.jsonl').read_text()) == {'name':'new_server_action','input':{'value':7}}
print('New server tool discovers and dispatches. Restricted roles receive only their offered tools.')
