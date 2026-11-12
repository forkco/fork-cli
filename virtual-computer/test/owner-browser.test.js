import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {ownerBrowser} from '../src/owner-browser.js';

test('browser binds published and preview SDK traffic to this task, frame and origin', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fork-owner-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const env = {FORK_CONFIG_DIR: dir, FORK_WORKSPACE_ROOT: dir, FORK_TASK_ID: randomUUID(),
    FORK_APP_ID: randomUUID(), FORK_SESSION_ID: randomUUID()};
  const token = 'a'.repeat(32);
  await writeFile(join(dir, 'config.json'), JSON.stringify({origin: 'https://fork.test', virtual_computer: true, token: 'device-key'}));
  await mkdir(join(dir, '.fork'));
  await writeFile(join(dir, '.fork', 'preview.json'), JSON.stringify({token, preview_url: 'https://foreign.test'}));

  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(url);
    assert.equal(url.origin, 'https://fork.test');
    assert.equal(url.searchParams.get('session_id'), env.FORK_SESSION_ID);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer device-key');
    return Response.json({user_id: 'owner'});
  });
  for (const target of ['published', 'preview']) {
    const bridge = await ownerBrowser(target, env);
    const hostname = target === 'preview' ? 'p-' + token : env.FORK_APP_ID;
    assert.equal(new URL(bridge.url).hostname, hostname + '.fork.test');
    let handler;
    await bridge.install({exposeBinding: async (_, fn) => {handler = fn}, addInitScript() {}});
    let url = bridge.url;
    const frame = {url: () => url}, page = {mainFrame: () => frame};
    const api = path => ({channel: 'api', action: 'call', payload: {method: 'POST', path, body: {x: 1}}});
    await handler({page, frame}, api('/api/fn/recalculate'));
    assert.equal(requests.at(-1).pathname, '/api/cli/tasks/' + env.FORK_TASK_ID + '/apps/' + env.FORK_APP_ID + '/fn/recalculate');
    assert.equal(requests.at(-1).searchParams.get('preview'), target === 'preview' ? token : null);
    const count = requests.length;
    for (const path of ['/api/admin', '/api/fn/../settings', 'https://foreign.test', '/api/fn/a/b']) {
      assert.equal((await handler({page, frame}, api(path))).status, 404);
    }
    await assert.rejects(handler({page, frame: {url: () => bridge.url}}, api('/api/fn/test')), /origin/);
    url = 'https://foreign.test/';
    await assert.rejects(handler({page, frame}, api('/api/fn/test')), /origin/);
    assert.equal(requests.length, count);
  }
});
