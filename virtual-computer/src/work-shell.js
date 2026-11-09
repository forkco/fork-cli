import {Worker} from 'node:worker_threads';
import {Failure, check} from './errors.js';
import {workPath} from './browser-files.js';
import {downloadWorkFile} from './work-download.js';
import {runWorkTool, runInspectTool} from './work-tools.js';
import {abortable} from './abort.js';

export const SHELL_LIMITS = Object.freeze({workers: 4, calls: 5000, bytes: 128 * 1024 * 1024, stdin: 1024 * 1024, downloads: 10});
// Request headers a download may set; identity, cookies and auth stay fixed.
const DOWNLOAD_HEADERS = new Set(['accept', 'accept-language']);
let running = 0;

const logical = path => path === '' ? '' : workPath(path);

export function validateShell(c) {
  check(typeof c.command === 'string' && c.command.trim() && Buffer.byteLength(c.command) <= 16384, 'command is required (16 KiB maximum)');
  check(c.stdin === undefined || (typeof c.stdin === 'string' && Buffer.byteLength(c.stdin) <= SHELL_LIMITS.stdin), 'stdin must be a string up to 1 MiB');
  check(c.cwd === undefined || (typeof c.cwd === 'string' && /^\/work(\/|$)/.test(c.cwd) && c.cwd.length <= 1024), 'cwd must be /work or a folder under it');
  if (c.cwd && c.cwd !== '/work' && c.cwd !== '/work/') workPath(c.cwd.replace(/\/+$/, ''));
}

// The only file operations a shell can perform: the session's BrowserFiles,
// with its quotas, logical paths and generated physical names.
export function filesBackend(files, signal, budget = {calls: 0, bytes: 0, downloads: 0}, download = downloadWorkFile, browser = null, ssh = null) {
  signal ??= new AbortController().signal;
  const spend = bytes => {
    signal.throwIfAborted();
    check(++budget.calls <= SHELL_LIMITS.calls, 'shell file-operation limit reached');
    budget.bytes += bytes;
    check(budget.bytes <= SHELL_LIMITS.bytes, 'shell file-transfer budget (128 MiB) exceeded');
  };
  return {
    list: () => { spend(0); return files.entries(); },
    read: async path => { const {data} = await files.bytes(logical(path)); spend(data.length); return data; },
    write: async (path, data, overwrite) => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      spend(bytes.length);
      return files.write(logical(path), bytes, overwrite === true, 'shell', signal);
    },
    remove: async path => { spend(0); return files.remove(logical(path)); },
    rename: async (from, to, overwrite) => { spend(0); return files.rename(logical(from), logical(to), overwrite === true); },
    mkdir: async path => { spend(0); return files.mkdir(logical(path)); },
    rmdir: async path => { spend(0); return files.rmdir(logical(path)); },
    // Public GET only, through the same checked-IP downloader as download_file:
    // no browser cookies, no private networks, 10 MiB, 5 redirects.
    download: async (url, headers = {}, path, overwrite) => {
      check(++budget.downloads <= SHELL_LIMITS.downloads, `at most ${SHELL_LIMITS.downloads} downloads per shell call`);
      check(headers && typeof headers === 'object' && Object.entries(headers).every(([name, value]) => DOWNLOAD_HEADERS.has(name) && typeof value === 'string' && value.length <= 256 && !/[\r\n]/.test(value)),
        'only Accept and Accept-Language headers can be set');
      if (path !== undefined) logical(path);
      const data = await download(url, signal, 0, headers);
      spend(data.length);
      if (path === undefined) return data;
      return files.write(logical(path), data, overwrite === true, 'download', signal);
    },
    // Native jobs (ImageMagick, FFmpeg, Poppler) in the existing bwrap sandbox.
    tool: async request => { spend(0); return runWorkTool(files, request, signal); },
    inspect: async request => { spend(0); return runInspectTool(files, request, signal); },
    // SSH to one of the user's registered hosts (gate + credential on the backend).
    ssh: async (op, args) => {
      spend(0);
      check(ssh && ssh.enabled, 'ssh is unavailable: add a host in Settings and start the task from a device that holds your key');
      if (op === 'upload') {
        check(args.data instanceof Uint8Array, 'Invalid SSH upload bytes');
        args = {...args, data: Buffer.from(args.data.buffer, args.data.byteOffset, args.data.byteLength)};
        spend(args.data.length);
      }
      const value = await ssh.run(op, args, signal);
      if (value?.data) spend(value.data.length);
      return value;
    },
    // The session's open page; the parent holds the session for this command.
    page: async (op, arg) => {
      spend(0);
      check(browser && typeof browser[op] === 'function', 'unknown page operation');
      const value = await abortable(browser[op](arg), signal);
      if (Buffer.isBuffer(value)) spend(value.length);
      return value;
    },
  };
}

export async function runShell(files, c, signal, browser = null, ssh = null) {
  validateShell(c);
  check(!files.closed && !signal?.aborted, 'Session is closed');
  if (running >= SHELL_LIMITS.workers) throw new Failure(429, 'shell_busy', 'Computer shell capacity reached; retry shortly');
  running++;
  const timeout = c.timeout_ms || 10000;
  const controller = new AbortController();
  const workSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const backend = filesBackend(files, workSignal, undefined, undefined, browser, ssh);
  const inflight = new Set();
  let worker;
  try {
    worker = new Worker(new URL('./shell/worker.js', import.meta.url), {
      workerData: {command: c.command, cwd: c.cwd || '/work', stdin: c.stdin || ''},
      env: {}, execArgv: [], argv: [], stdout: true, stderr: true, trackUnmanagedFds: true,
      resourceLimits: {maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, codeRangeSizeMb: 16, stackSizeMb: 4},
    });
    worker.stdout.resume(); worker.stderr.resume();
    const result = await new Promise(resolve => {
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        controller.abort(new Failure(499, 'shell_cancelled', 'Shell command finished or was cancelled'));
        void worker.terminate();
        resolve(value);
      };
      const killed = (code, text) => ({stdout: '', stderr: `sh: ${text}\n`, exit_code: code, cwd: c.cwd || '/work', truncated: false});
      const timer = setTimeout(() => finish(killed(124, `deadline (${timeout} ms) reached; local work cancelled. Completed writes remain; remote commands may have run. Do not retry mutations automatically.`)), timeout);
      const abort = () => finish(killed(130, 'session closed'));
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) abort();
      worker.on('message', message => {
        if (done) return;
        if (message?.kind === 'done') return finish(message.result);
        if (message?.kind === 'failed') return finish(killed(70, 'internal error: ' + message.message));
        if (message?.kind !== 'rpc' || typeof backend[message.op] !== 'function') return finish(killed(70, 'invalid request'));
        const args = message.op === 'rename' ? [message.from, message.to, message.overwrite] : message.op === 'write' ? [message.path, message.data, message.overwrite]
          : message.op === 'download' ? [message.url, message.headers, message.path, message.overwrite]
          : message.op === 'tool' || message.op === 'inspect' ? [message.request] : message.op === 'page' ? [message.name, message.arg]
          : message.op === 'ssh' ? [message.sshOp, message.args] : [message.path];
        const call = (async () => backend[message.op](...args))();
        inflight.add(call);
        call.then(value => { if (!done) worker.postMessage({kind: 'reply', id: message.id, value: Buffer.isBuffer(value) ? {data: value} : value}); },
          error => { if (!done) worker.postMessage({kind: 'reply', id: message.id, error: String(error?.message || error).slice(0, 2048), code: typeof error?.code === 'string' ? error.code.slice(0, 64) : undefined}); })
          .finally(() => inflight.delete(call));
      });
      worker.on('error', error => finish(error?.code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? killed(137, 'memory limit reached; process smaller files or fewer lines at a time')
        : killed(70, 'internal error')));
      worker.on('exit', () => finish(killed(70, 'shell worker exited')));
    });
    // A write that started before the deadline completes before the session is released.
    await Promise.allSettled([...inflight]);
    return {...result, files: files.list().files};
  } finally {
    controller.abort();
    running--;
    await worker?.terminate().catch(() => {});
  }
}
