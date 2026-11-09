import {Client} from 'ssh2';
import {createHash} from 'node:crypto';
import {Failure, check} from './errors.js';
import {resolvePublic} from './network.js';
import {MAX_FILE_BYTES} from './browser-files.js';
import {abortable} from './abort.js';

export const SSH_LIMITS = Object.freeze({connectTimeout: 15_000, timeout: 30_000, output: 16 * 1024 * 1024, file: MAX_FILE_BYTES});
const fingerprint = key => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
const stop = conn => { if (conn.destroy) conn.destroy(); else conn.end(); };
const aborted = () => new Failure(499, 'ssh_aborted', 'SSH operation cancelled; a remote mutation may have run. Do not retry automatically.');

async function dial(host, signal, connect = realConnect) {
  const address = await abortable(resolvePublic(host.hostname), signal);
  check(Number.isInteger(host.port) && host.port > 0 && host.port <= 65535, 'Invalid SSH port');
  signal.throwIfAborted();
  const auth = host.auth_method === 'password' ? {password: host.password}
    : {privateKey: host.private_key, ...(host.passphrase ? {passphrase: host.passphrase} : {})};
  check(host.auth_method === 'password' ? typeof host.password === 'string' : typeof host.private_key === 'string', 'Missing SSH credential');
  let seenKey = null;
  const conn = await connect({host: address.address, port: host.port, username: host.username,
    readyTimeout: SSH_LIMITS.connectTimeout, keepaliveInterval: 0, agent: undefined, agentForward: false,
    hostVerifier: key => { seenKey = fingerprint(key); return !host.fingerprint || host.fingerprint === seenKey; }, ...auth}, signal);
  return {conn, result: {authOk: true, fingerprint: seenKey || host.fingerprint || null}};
}

function realConnect(config, signal) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let ready = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); conn.destroy(); reject(signal.reason); };
    conn.on('ready', () => { ready = true; cleanup(); resolve(conn); });
    // Keep the error listener after ready: transport errors must never become
    // unhandled EventEmitter errors. The active operation has its own waiter.
    conn.on('error', err => {
      cleanup();
      if (err?.level === 'client-authentication') reject(new Failure(401, 'ssh_auth_failed', 'SSH authentication failed'));
      else if (/host key|hostVerifier|handshake/i.test(err?.message || '')) reject(new Failure(495, 'ssh_host_key', 'SSH host key verification failed'));
      else reject(new Failure(502, 'ssh_connect_failed', 'SSH transport failed'));
    });
    conn.on('close', () => { cleanup(); if (!ready) reject(signal.aborted ? signal.reason : new Failure(502, 'ssh_connect_failed', 'SSH closed before authentication')); });
    signal.addEventListener('abort', onAbort, {once: true});
    if (signal.aborted) return onAbort();
    try { conn.connect(config); } catch { cleanup(); conn.destroy(); reject(new Failure(400, 'ssh_bad_config', 'Invalid SSH connection configuration')); }
  });
}

// Cover DNS, authentication, subsystem negotiation, metadata and streaming
// with one deadline. Every pending waiter settles on cancellation or disconnect.
async function connected(host, parent, timeout, connect, task) {
  check(Number.isInteger(timeout) && timeout >= 1 && timeout <= 45000, 'Invalid SSH timeout');
  const deadline = new AbortController();
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(new Failure(504, 'ssh_timeout', 'SSH operation timed out')), timeout);
  let conn;
  const close = () => { if (conn) stop(conn); };
  try {
    signal.throwIfAborted();
    const opened = await dial(host, signal, connect);
    conn = opened.conn;
    signal.addEventListener('abort', close, {once: true});
    signal.throwIfAborted();
    // Pin and record authentication before executing any remote command or
    // opening SFTP, including when the operation later fails or is cancelled.
    await abortable(host.onAuthenticated?.(opened.result), signal);
    return await task(conn, opened.result, signal);
  } catch (error) {
    if (parent?.aborted) throw aborted();
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', close);
    if (conn) stop(conn);
  }
}

function step(conn, signal, start) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      conn.removeListener?.('close', onClose); conn.removeListener?.('error', onError);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => finish(signal.reason);
    const onClose = () => finish(signal.aborted ? signal.reason : new Failure(502, 'ssh_disconnected', 'SSH disconnected before the operation completed'));
    const onError = () => finish(new Failure(502, 'ssh_transport', 'SSH transport failed'));
    signal.addEventListener('abort', onAbort, {once: true});
    conn.once?.('close', onClose); conn.once?.('error', onError);
    if (signal.aborted) return onAbort();
    try { start(finish); } catch (error) { finish(error); }
  });
}

export async function runSsh(host, {command, stdin = '', timeout = SSH_LIMITS.timeout}, signal, connect) {
  check(typeof command === 'string' && command.length > 0 && Buffer.byteLength(command) <= 16384, 'SSH command is required (16 KiB max)');
  const stdout = [], stderr = [];
  let outBytes = 0, errBytes = 0, truncated = false, authentication = {authOk: false, fingerprint: null};
  const cap = (chunks, chunk, bytes) => {
    const room = Math.max(0, SSH_LIMITS.output - bytes);
    if (chunk.length > room) truncated = true;
    if (room) chunks.push(chunk.subarray(0, room));
    return bytes + Math.min(chunk.length, room);
  };
  try {
    return await connected(host, signal, timeout, connect, async (conn, result, current) => {
      authentication = result;
      return step(conn, current, finish => conn.exec(command, {pty: false}, (error, stream) => {
        if (current.aborted) { stream?.destroy(); return; }
        if (error) return finish(new Failure(502, 'ssh_exec_failed', 'SSH command could not be started'));
        stream.on('data', chunk => { outBytes = cap(stdout, chunk, outBytes); });
        stream.stderr.on('data', chunk => { errBytes = cap(stderr, chunk, errBytes); });
        stream.on('error', () => finish(new Failure(502, 'ssh_exec_failed', 'SSH command stream failed')));
        stream.on('close', (code, remoteSignal) => finish(null, {...result, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
          code: Number.isInteger(code) ? code : 128, signal: remoteSignal, truncated}));
        stream.end(stdin);
      }));
    });
  } catch (error) {
    if (error?.code !== 'ssh_timeout') throw error;
    return {...authentication, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: 124, truncated, timedOut: true};
  }
}

export async function runSftp(host, {direction, remotePath, data, signal, connect, timeout = SSH_LIMITS.timeout}) {
  check(typeof remotePath === 'string' && remotePath.length > 0 && remotePath.length <= 4096 && !remotePath.includes('\0'), 'remote path is required');
  check(direction === 'download' || direction === 'upload', 'direction must be download or upload');
  if (direction === 'upload') {
    check(data instanceof Uint8Array, 'Invalid SSH upload bytes');
    data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    check(data.length <= SSH_LIMITS.file, 'file exceeds 10 MiB');
  }
  return connected(host, signal, timeout, connect, async (conn, result, current) => {
    const sftp = await step(conn, current, finish => conn.sftp((error, value) => finish(error ? new Failure(502, 'ssh_sftp_failed', 'SFTP unavailable') : null, value)));
    current.throwIfAborted();
    if (direction === 'download') {
      const stat = await step(conn, current, finish => sftp.stat(remotePath, (error, value) => finish(error ? new Failure(404, 'ssh_stat_failed', 'Cannot stat remote file') : null, value)));
      current.throwIfAborted();
      check(stat.isFile(), 'Remote path is not a regular file');
      check(stat.size <= SSH_LIMITS.file, 'Remote file exceeds 10 MiB');
      const chunks = [];
      let size = 0;
      await step(conn, current, finish => {
        const stream = sftp.createReadStream(remotePath);
        const abort = () => stream.destroy();
        current.addEventListener('abort', abort, {once: true});
        const cleanup = () => current.removeEventListener('abort', abort);
        let ended = false;
        stream.on('data', chunk => { size += chunk.length; if (size > SSH_LIMITS.file) stream.destroy(new Failure(413, 'ssh_file_limit', 'Remote file exceeds 10 MiB')); else chunks.push(chunk); });
        stream.on('error', error => { cleanup(); finish(error); });
        stream.on('end', () => { ended = true; cleanup(); finish(); });
        stream.on('close', () => { cleanup(); if (!ended) finish(current.aborted ? current.reason : new Failure(502, 'ssh_read_failed', 'Remote file stream closed early')); });
      });
      return {...result, data: Buffer.concat(chunks)};
    }
    await step(conn, current, finish => {
      const stream = sftp.createWriteStream(remotePath);
      let finished = false;
      const abort = () => stream.destroy();
      current.addEventListener('abort', abort, {once: true});
      const cleanup = () => current.removeEventListener('abort', abort);
      stream.on('finish', () => { finished = true; });
      stream.on('error', () => { cleanup(); finish(new Failure(502, 'ssh_write_failed', 'Cannot write remote file')); });
      stream.on('close', () => {
        cleanup();
        // ssh2 closes the SFTP handle in _final and can acknowledge CLOSE
        // before emitting finish. bytesWritten counts acknowledged WRITEs.
        const confirmed = finished || (stream.isClosed === true && stream.bytesWritten === data.length);
        finish(confirmed ? null : current.aborted ? current.reason : new Failure(502, 'ssh_write_failed', 'Remote file stream closed early'));
      });
      stream.end(data);
    });
    return {...result, bytes: data.length};
  });
}
