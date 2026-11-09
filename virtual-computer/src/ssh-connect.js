import {createDecipheriv, createHmac} from 'node:crypto';
import {Failure, check} from './errors.js';
import {runSsh, runSftp} from './ssh.js';

// Orchestrates one shell ssh/scp call. The backend runs the anti-abuse gate and
// returns the ciphertext; the runner opens it with the user's vault master key
// — the same key the device already releases for the run, nothing SSH-specific
// and nothing new stored on the client — then connects and reports the outcome.

function endpoint(config, suffix) {
  const base = config.sshBackend;
  check(base, 'SSH is not configured on this runner');
  const url = new URL(base.replace(/\/$/, '') + suffix);
  check(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)), 'SSH backend requires TLS or loopback');
  return url;
}

async function call(config, suffix, body, signal) {
  const response = await fetch(endpoint(config, suffix), {
    method: 'POST', redirect: 'error',
    headers: {authorization: 'Bearer ' + config.secret, 'content-type': 'application/json'},
    body: JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(12000), ...(signal ? [signal] : [])]),
  });
  const text = await response.text();
  let value = {};
  try { value = text ? JSON.parse(text) : {}; } catch { /* non-JSON body */ }
  if (!response.ok) throw new Failure(response.status, 'ssh_denied', value.error || 'SSH connection was not authorized');
  return value;
}

// Open the credential the same way it was sealed in the backend: a per-host key
// derived from the vault master key, AES-256-GCM, AAD bound to user and host.
function openCredential(master, userID, hostID, scope, ciphertextB64) {
  const binding = `${userID}:${hostID}:${scope.vault_id}:${scope.app_id}:${scope.key_id}`;
  const key = createHmac('sha256', master).update(`fork-ssh-key-v2:${binding}`).digest();
  try {
    const blob = Buffer.from(ciphertextB64, 'base64');
    check(blob.length > 28, 'malformed credential');
    const nonce = blob.subarray(0, 12), tag = blob.subarray(blob.length - 16), ct = blob.subarray(12, blob.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(`ssh-credential-v2:${binding}`));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    try { return JSON.parse(plain.toString('utf8')); } finally { plain.fill(0); }
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw new Failure(403, 'ssh_key_mismatch', 'The stored credential could not be opened with this run key');
  } finally { key.fill(0); }
}

// op: 'exec' | 'download' | 'upload'. master is the run's vault key bytes; the
// caller zeroes it afterwards.
export async function sshOperation(config, session, master, op, args, signal, deps = {}) {
  check(Buffer.isBuffer(master) && master.length === 32, 'SSH is not unlocked for this run; start the task from a device that holds your key');
  const userID = session.ownerObject.user_id;
  check(['exec', 'download', 'upload'].includes(op), 'Unknown SSH operation');
  const scope = {vault_id: session.storage?.vault, app_id: session.ownerObject.app_id, key_id: session.storage?.master?.id};
  check(Object.values(scope).every(v => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)), 'SSH needs this browser vault and key scope');
  const needWrite = op !== 'download';
  const authorized = await (deps.call || call)(config, '/connect', {
    owner: session.ownerObject, run_id: session.storage.run || session.id, label: args.label, host_id: args.host_id || '', operation: op, ...scope, need_write: needWrite,
  }, signal);
  const host = authorized.host || {};
  check(Object.entries(scope).every(([k, v]) => host[k] === v), 'SSH credential belongs to a different browser key; re-register this host');
  check(!needWrite || host.writable === true, 'Read-only SSH hosts permit SFTP downloads only');
  const cred = openCredential(master, userID, host.host_id, scope, authorized.secret_ciphertext || '');
  const target = {
    hostname: host.hostname, port: host.port, username: host.username,
    auth_method: host.auth_method, fingerprint: host.fingerprint || null,
    password: host.auth_method === 'password' ? cred.secret : undefined,
    private_key: host.auth_method === 'key' ? cred.secret : undefined,
    passphrase: cred.passphrase || undefined,
  };
  const report = (ok, fingerprint) => (deps.call || call)(config, '/result', {
    attempt_id: authorized.attempt_id, host_id: host.host_id, user_id: userID, auth_ok: ok, fingerprint: fingerprint || '',
  }, AbortSignal.timeout(5000));
  let reported = false;
  target.onAuthenticated = async result => { await report(true, result.fingerprint); reported = true; };
  try {
    if (op === 'exec') {
      const result = await (deps.runSsh || runSsh)(target, {command: args.command, stdin: args.stdin || '', timeout: args.timeout || 30000}, signal, deps.connect);
      if (result.authOk && !reported) await report(true, result.fingerprint);
      return {stdout: result.stdout, stderr: result.stderr, code: result.code, truncated: result.truncated, timedOut: result.timedOut};
    }
    const result = await (deps.runSftp || runSftp)(target, {direction: op, remotePath: args.remotePath, data: args.data, signal, connect: deps.connect});
    if (result.authOk && !reported) await report(true, result.fingerprint);
    return op === 'download' ? {data: result.data} : {bytes: result.bytes};
  } catch (error) {
    if (!reported && error instanceof Failure && error.code === 'ssh_auth_failed') await report(false, null).catch(() => {});
    throw error;
  } finally {
    if (target.password) target.password = null;
    if (target.private_key) target.private_key = null;
    target.passphrase = null;
    cred.secret = cred.passphrase = null;
  }
}
