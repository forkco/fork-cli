// Only the SDK message listener runs in Chromium. Device credentials and the
// task-to-app binding stay in the native driver.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const appPost = /^\/api\/(?:fn\/[a-zA-Z0-9_-]+|runtime\/(?:logs|poll|result))$/;

function listenForSDK(expectedOrigin) {
  if (location.origin !== expectedOrigin || top !== window) return;
  window.addEventListener('message', async event => {
    const message = event.data;
    if (event.source !== window || event.origin !== expectedOrigin ||
        message?.proto !== 'fork/2' || message.kind !== 'request') return;
    const envelope = {proto: 'fork/2', id: message.id};
    try {
      const payload = await window.__forkAppRequest(message);
      window.postMessage({...envelope, kind: 'response', payload}, expectedOrigin);
    } catch {
      window.postMessage({...envelope, kind: 'error', payload: {message: 'App request unavailable'}}, expectedOrigin);
    }
  });
}

export async function ownerBrowser(target = 'published', env = process.env, previewURL) {
  const {FORK_APP_ID: app, FORK_TASK_ID: task, FORK_SESSION_ID: session} = env;
  if (![app, task, session].every(id => uuid.test(id))) throw Error('Open an app from its own Fork task');
  if (!['published', 'preview'].includes(target)) throw Error('Choose published or preview');

  const configPath = join(env.FORK_CONFIG_DIR, 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' || !config.virtual_computer) throw Error('Virtual computer unavailable');

  let preview = '';
  if (target === 'preview') {
    const file = join(env.FORK_WORKSPACE_ROOT, '.fork', 'preview.json');
    let metadata;
    if (previewURL) {
      const url = new URL(previewURL);
      const match = /^p-([a-f0-9]{32})\./.exec(url.hostname);
      if (!match || url.protocol !== 'https:' || url.hostname !== 'p-' + match[1] + '.' + origin.hostname) throw Error('Invalid Fork preview URL');
      metadata = {token: match[1]};
    } else { metadata = JSON.parse(await readFile(file, 'utf8')); }
    if (!/^[0-9a-f]{32}$/.test(metadata.token)) throw Error('Push an app preview before testing it');
    preview = metadata.token;
  }
  const appURL = new URL(origin.origin);
  appURL.hostname = (preview ? 'p-' + preview : app) + '.' + origin.hostname;
  appURL.pathname = preview ? '/' : '/last/';

  async function request(path, method = 'GET', body) {
    const endpoint = new URL('/api/cli/tasks/' + task + '/apps/' + app + '/' + path, origin);
    endpoint.searchParams.set('session_id', session);
    if (preview) endpoint.searchParams.set('preview', preview);
    const response = await fetch(endpoint, {
      method, redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: {Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    return {status: response.status, headers: {'content-type': contentType},
      body: contentType.includes('json') && text ? JSON.parse(text) : text};
  }

  const viewer = await request('viewer');
  if (viewer.status !== 200 || !viewer.body?.user_id) throw Error('The app is unavailable to this task');

  return {url: appURL.href, async install(context) {
    await context.exposeBinding('__forkAppRequest', async ({page, frame}, message) => {
      if (frame !== page.mainFrame() || new URL(frame.url()).origin !== appURL.origin) throw Error('Wrong app origin');
      if (message.channel === 'session' && message.action === 'hello') return {viewer: viewer.body, theme: 'light'};
      if (message.channel === 'user' && message.action === 'get') return viewer.body;
      if (message.channel === 'api' && message.action === 'call') {
        const {path, method, body} = message.payload || {};
        if (path === '/api/viewer' && method === 'GET') return request('viewer');
        if (method === 'POST' && typeof path === 'string' && appPost.test(path)) return request(path.slice(5), method, body);
        return {status: 404, headers: {}, body: {error: 'This SDK operation is unavailable in the CLI test browser'}};
      }
      throw Error('Unsupported SDK action');
    });
    await context.addInitScript(listenForSDK, appURL.origin);
  }};
}
