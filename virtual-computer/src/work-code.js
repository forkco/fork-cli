import {Failure, check} from './errors.js';
import {MAX_FILE_BYTES, workPath, fileType} from './browser-files.js';
import {runWorkTool} from './work-tools.js';

// This function is serialized into Chromium, never invoked/evaluated in Node.
function workerMain() {
  let sequence = 0; const pending = new Map();
  const rpc = (op, fields = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, {resolve, reject}); self.postMessage({kind: 'rpc', id, op, ...fields});
  });
  const encode = async value => {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value)
      : value instanceof Blob ? new Uint8Array(await value.arrayBuffer())
      : value instanceof ArrayBuffer ? new Uint8Array(value)
      : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
    if (!bytes || bytes.length > 10 * 1024 * 1024) throw Error('write accepts text, Blob, ArrayBuffer or typed array, up to 10 MiB');
    let binary = ''; for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return btoa(binary);
  };
  const decode = data => Uint8Array.from(atob(data), c => c.charCodeAt(0));
  const files = Object.freeze({
    list: () => rpc('list'),
    read: async path => decode((await rpc('read', {path})).base64),
    text: async path => new TextDecoder().decode(decode((await rpc('read', {path})).base64)),
    blob: async path => { const result = await rpc('read', {path}); return new Blob([decode(result.base64)], {type: result.mime_type}); },
    write: async (path, value, options = {}) => rpc('write', {path, base64: await encode(value), overwrite: options.overwrite === true}),
    remove: path => rpc('remove', {path}),
  });
  const tools = Object.freeze(Object.fromEntries(['archive', 'image', 'ffmpeg'].map(tool => [tool, options => rpc('tool', {request: {...options, tool}})])));
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = (...args) => {
    let text;
    try { text = args.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' ').slice(0, 2048); } catch { text = '[unprintable]'; }
    self.postMessage({kind: 'console', level, text});
  };
  self.onmessage = async event => {
    const message = event.data;
    if (message.kind === 'reply') {
      const request = pending.get(message.id); if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(Error(message.error)); else request.resolve(message.value);
      return;
    }
    if (message.kind !== 'run') return;
    try {
      const fn = new Function('files', 'tools', 'arg', 'return (async () => {\n' + message.code + '\n})();\n//# sourceURL=fork-session-code.js');
      const value = await fn(files, tools, message.arg);
      const json = JSON.stringify(value === undefined ? null : value);
      if (json.length > 65536) throw Error('Result exceeds 64 KiB; write large results with files.write');
      self.postMessage({kind: 'done', value: JSON.parse(json)});
    } catch (error) {
      self.postMessage({kind: 'failed', error: {name: String(error?.name || 'Error').slice(0, 80), message: String(error?.message || error).slice(0, 4096), stack: String(error?.stack || '').slice(0, 8192)}});
    }
  };
}

export class WorkCode {
  constructor(session) { this.session = session; this.closed = false; this.pending = new Set(); }
  async dispatch(run, request) {
    check(!this.closed && !this.session.closed && run.active && !run.controller.signal.aborted, 'Code run is closed');
    check(++run.calls <= 128 && this.pending.size < 8, 'Code file-call limit reached');
    const size = Buffer.byteLength(JSON.stringify(request));
    run.bytes += size;
    check(size <= 14 * 1024 * 1024 && run.bytes <= 128 * 1024 * 1024, 'Code file-transfer budget exceeded');
    const files = this.session.files;
    let result;
    switch (request.op) {
      case 'list': result = files.list().files; break;
      case 'read': {
        const {data} = await files.bytes(request.path);
        result = {base64: data.toString('base64'), mime_type: fileType(data)}; break;
      }
      case 'write': {
        workPath(request.path);
        check(typeof request.base64 === 'string' && request.base64.length <= Math.ceil(MAX_FILE_BYTES / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(request.base64), 'Invalid file bytes');
        const data = Buffer.from(request.base64, 'base64');
        check(data.toString('base64') === request.base64, 'Invalid file base64');
        result = await files.write(request.path, data, request.overwrite === true, 'code', run.controller.signal); break;
      }
      case 'remove': result = await files.remove(request.path); break;
      case 'tool': result = await runWorkTool(files, request.request, run.controller.signal); break;
      default: throw new Failure(400, 'invalid_file_operation', 'Unknown sandbox file operation');
    }
    run.bytes += Buffer.byteLength(JSON.stringify(result));
    check(run.bytes <= 128 * 1024 * 1024, 'Code file-transfer budget exceeded');
    return result;
  }
  async run(c) {
    check(!this.closed, 'Code workspace is closed');
    let code = c.code;
    if (c.code_file) code = (await this.session.files.bytes(c.code_file)).data.toString('utf8');
    check(typeof code === 'string' && code.length > 0 && Buffer.byteLength(code) <= 65536, 'code or code_file is required (64 KiB maximum)');
    const controller = new AbortController(), run = {active: true, controller, calls: 0, bytes: 0};
    this.current = run;
    let context;
    try {
      // No saved sign-ins, website pages or host bridge in this context.
      context = await this.session.browser.newContext({serviceWorkers: 'block', acceptDownloads: false});
      await context.route('**/*', route => route.abort());
      await context.routeWebSocket('**/*', ws => ws.close());
      const page = await context.newPage();
      await page.setContent('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-eval\' blob:; worker-src blob:; connect-src \'none\'">');
      await page.exposeBinding('__forkWorkCall', (_source, request) => {
        const promise = this.dispatch(run, request); this.pending.add(promise);
        promise.finally(() => this.pending.delete(promise)).catch(() => {});
        return promise;
      });
      const result = await page.evaluate(async ({source, code, arg, timeout}) => new Promise(resolve => {
        const url = URL.createObjectURL(new Blob(['(' + source + ')()'], {type: 'application/javascript'}));
        const worker = new Worker(url), logs = []; let logBytes = 0, finished = false, calls = 0, messages = 0;
        const finish = result => {
          if (finished) return; finished = true;
          clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); resolve({...result, console: logs});
        };
        const timer = setTimeout(() => finish({ok: false, error: {name: 'TimeoutError', message: 'Code deadline reached; worker terminated. Files already written remain available.'}}), timeout);
        worker.onerror = event => { event.preventDefault(); finish({ok: false, error: {name: 'Error', message: String(event.message).slice(0, 4096)}}); };
        worker.onmessage = async event => {
          if (finished) return;
          if (++messages > 1000) { finish({ok: false, error: {message: 'Worker message limit reached'}}); return; }
          const message = event.data;
          if (message?.kind === 'console') {
            if (logs.length < 50 && logBytes < 16384) { const text = String(message.text).slice(0, 2048); logBytes += text.length; logs.push({level: String(message.level).slice(0, 10), text}); }
          } else if (message?.kind === 'rpc') {
            if (++calls > 128) { finish({ok: false, error: {message: 'Code file-call limit reached'}}); return; }
            if (JSON.stringify(message).length > 14 * 1024 * 1024) { finish({ok: false, error: {message: 'File call exceeds limit'}}); return; }
            try { const value = await globalThis.__forkWorkCall(message); if (!finished) worker.postMessage({kind: 'reply', id: message.id, value}); }
            catch (error) { if (!finished) worker.postMessage({kind: 'reply', id: message.id, error: String(error.message).slice(0, 8192)}); }
          } else if (message?.kind === 'done') {
            if (JSON.stringify(message.value).length > 65536) finish({ok: false, error: {message: 'Result exceeds 64 KiB'}});
            else finish({ok: true, value: message.value});
          } else if (message?.kind === 'failed') {
            finish({ok: false, error: {name: String(message.error?.name).slice(0, 80), message: String(message.error?.message).slice(0, 4096), stack: String(message.error?.stack).slice(0, 8192)}});
          }
        };
        worker.postMessage({kind: 'run', code, arg});
      }), {source: workerMain.toString(), code, arg: c.arg, timeout: c.timeout_ms || 10000});
      return {...result, files: this.session.files.list().files};
    } finally {
      run.active = false; controller.abort();
      await Promise.allSettled([...this.pending]);
      await context?.close().catch(() => {});
      if (this.current === run) this.current = null;
    }
  }
  close() { this.closed = true; this.current?.controller.abort(); }
}
