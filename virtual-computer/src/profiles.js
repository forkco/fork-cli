import {createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes} from 'node:crypto';
import https from 'node:https';
import {isIP} from 'node:net';
import {Failure, check} from './errors.js';
import {resolvePublic, webURL, publicIP} from './network.js';
import {browserStorageState} from './browser-storage.js';

const MAX_STATE = 8 << 20;
const MAX_OBJECT = 12 << 20;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const failed = (code, status = 503) => new Failure(status, code, code);

export function siteHost(host, site) {
  host = host.toLowerCase().replace(/\.$/, '');
  return host === site || host.endsWith('.' + site);
}
export function siteURL(raw, site) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && siteHost(u.hostname, site);
  } catch { return false; }
}

function storedURL(raw) {
  try {
    const u = webURL(raw), host = u.hostname.replace(/^\[|\]$/g, '');
    return isIP(host) ? publicIP(host) : host.includes('.') && !host.endsWith('.local');
  } catch { return false; }
}

// Domain cookies retain their original domain, path, expiry, SameSite and
// partition attributes. Storage is retained at exact HTTPS origin granularity.
// A partitioned (CHIPS) cookie belongs to the top-level site of its partition.
export function filterState(state, site, now = Date.now() / 1000) {
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw failed('profile_corrupt', 422);
  const result = {
    cookies: state.cookies.filter(c => typeof c.domain === 'string' &&
      storedURL('https://' + c.domain.replace(/^\./, '')) &&
      (c.expires === -1 || c.expires > now) &&
      (site === '*' ? !c.partitionKey || storedURL(c.partitionKey)
        : c.partitionKey ? siteURL(c.partitionKey, site) : siteHost(c.domain.replace(/^\./, ''), site))),
    origins: state.origins.filter(o => site === '*' ? storedURL(o.origin) : siteURL(o.origin, site)).map(o => ({
      origin: o.origin, localStorage: o.localStorage || [],
      ...(o.indexedDB ? {indexedDB: o.indexedDB} : {}),
    })),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_STATE) throw failed('profile_too_large', 413);
  return result;
}

export function mergeStates(states) {
  const cookies = new Map(), origins = new Map();
  for (const state of states) {
    for (const c of state.cookies) cookies.set(JSON.stringify([c.domain,c.path,c.name,c.partitionKey||'',c._crHasCrossSiteAncestor||false]),c);
    for (const o of state.origins) origins.set(o.origin,o);
  }
  return filterState({cookies:[...cookies.values()],origins:[...origins.values()]},'*');
}

function aad(grant, revision, object) {
  return Buffer.from(grant.aad + '\n' + revision + '\n' + object);
}
export function encryptState(state, key, grant, revision, object) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(grant, revision, object));
  const plain = Buffer.from(JSON.stringify(filterState(state, grant.site)));
  try {
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.from(JSON.stringify({format: 1, revision, nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64')}));
  } finally { plain.fill(0); }
}
export function decryptState(bytes, key, grant) {
  try {
    if (bytes.length > MAX_OBJECT) throw new Error();
    if (digest(bytes) !== grant.sha256) throw new Error();
    const envelope = JSON.parse(bytes);
    if (envelope.format !== 1 || envelope.revision !== grant.revision) throw new Error();
    const nonce = Buffer.from(envelope.nonce, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(grant, grant.revision, grant.object));
    cipher.setAuthTag(tag);
    const plaintext = Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'base64')), cipher.final()]);
    try {
      if (plaintext.length > MAX_STATE) throw new Error();
      return filterState(JSON.parse(plaintext), grant.site);
    } finally { plaintext.fill(0); }
  } catch { throw failed('profile_corrupt', 422); }
}

// S3 transfers happen only in the controller. Preserve the checked-IP network
// boundary and never log signed URLs or follow redirects with credentials.
export async function transfer(raw, method, body, allowedHost) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.host !== allowedHost || u.username || u.password) throw failed('invalid_profile_storage');
  const address = await resolvePublic(u.hostname);
  return new Promise((resolve, reject) => {
    const request = https.request({hostname: address.address, family: address.family,
      servername: u.hostname, port: 443, method, path: u.pathname + u.search,
      headers: {host: u.host, ...(body ? {'content-length': String(body.length),
        'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-amz-acl': 'private'} : {})}, agent: false,
    }, response => {
      let size = 0; const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_OBJECT) request.destroy(); else chunks.push(chunk);
      });
      response.on('error', () => reject(failed('profile_storage_unavailable')));
      response.on('aborted', () => reject(failed('profile_storage_unavailable')));
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300 || size > MAX_OBJECT)
          reject(failed('profile_storage_unavailable'));
        else resolve(Buffer.concat(chunks));
      });
    });
    const deadline = setTimeout(() => request.destroy(), 10_000);
    request.on('close', () => clearTimeout(deadline));
    request.on('error', () => reject(failed('profile_storage_unavailable')));
    request.end(body);
  });
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const host = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

// Each site of an app browser has its own key, derived from the browser master
// key, the snapshot ID and every scope it belongs to. Holding the master key
// does not decrypt anything by itself: a site is opened only when visited.
export function siteKey(master, owner, grant) {
  const info = JSON.stringify(['fork-site-key-v1', owner.user_id, grant.vault_id, owner.app_id, grant.site, grant.master_id]);
  return Buffer.from(hkdfSync('sha256', master, Buffer.from(grant.id, 'utf8'), Buffer.from(info, 'utf8'), 32));
}

// One encrypted snapshot of one website (kind "site"), or a read-only source
// it imports once: a combined snapshot from before per-site storage, or a
// pre-vault snapshot that was encrypted with the server key ("legacy").
export class Profile {
  constructor(owner, grant, config, io = transfer, keys = {}) {
    check(config.profileBackend && config.profileStorageHost, 'Private profile storage is not configured');
    const backend = new URL(config.profileBackend);
    check(backend.protocol === 'https:' || (backend.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(backend.hostname)), 'Profile backend requires TLS or loopback');
    check(grant && typeof grant.id === 'string' && uuid.test(grant.id) && typeof grant.site === 'string', 'Invalid profile');
    this.imports = [];
    if (grant.master_id) {
      check(uuid.test(grant.vault_id) && uuid.test(grant.master_id) && host.test(grant.site) && grant.site.length <= 253 && !grant.key && !grant.scope, 'Invalid site profile');
      check(grant.aad === JSON.stringify(['fork-computer-profile-v3', grant.id, owner.user_id, owner.app_id, grant.site, grant.vault_id, grant.master_id]), 'Invalid profile owner');
      check(keys.master?.length === 32, 'Browser key unavailable');
      check(!grant.imports || (Array.isArray(grant.imports) && grant.imports.length <= 4), 'Invalid profile imports');
      this.kind = 'site';
      this.key = siteKey(keys.master, owner, grant);
      this.readOnly = !grant.lease || grant.read_only === true;
      for (const source of grant.imports || []) {
        if (source?.vault_id) {
          check(source.vault_id === grant.vault_id, 'Invalid profile imports');
          const key = keys.combined?.(source.id);
          // Never replace data that could not be imported: save nothing instead.
          if (!key) { this.readOnly = true; this.importsMissing = true; continue; }
          this.imports.push(new Profile(owner, source, config, io, {key}));
        } else this.imports.push(new Profile(owner, source, config, io));
      }
    } else if (grant.vault_id) {
      check(uuid.test(grant.vault_id) && grant.site === '*' && grant.scope === 'all_sites' && !grant.key && !grant.lease && !grant.imports, 'Invalid combined profile');
      check(grant.aad === JSON.stringify(['fork-computer-profile-v2', grant.id, owner.user_id, owner.app_id, '*', grant.vault_id]), 'Invalid profile owner');
      check(keys.key?.length === 32, 'Invalid profile key');
      this.kind = 'combined';
      this.key = keys.key;
      this.readOnly = true;
    } else {
      check(!grant.lease && !grant.imports && (grant.scope === 'all_sites' ? grant.site === '*' : !grant.scope && host.test(grant.site)), 'Invalid legacy profile');
      check(grant.aad === JSON.stringify(['fork-computer-profile-v1', grant.id, owner.user_id, owner.app_id, grant.site]), 'Invalid profile owner');
      this.kind = 'legacy';
      this.key = Buffer.from(grant.key || '', 'base64');
      this.readOnly = true;
    }
    check(this.key.length === 32, 'Invalid profile key');
    this.grant = {...grant, key: undefined, imports: undefined};
    this.config = config; this.io = io; this.savedHash = ''; this.dead = false;
  }

  async operation(action, fields = {}) {
    if (this.dead && action !== 'release') throw failed('profile_lease_expired', 409);
    try {
      const response = await fetch(this.config.profileBackend, {method: 'POST', redirect: 'error',
        headers: {authorization: 'Bearer ' + this.config.secret, 'content-type': 'application/json'},
        body: JSON.stringify({action, id: this.grant.id, lease: this.grant.lease, ...fields}),
        signal: AbortSignal.timeout(8000)});
      const value = await response.json();
      if (!response.ok) throw failed(response.status === 409 ? 'profile_lease_expired' : 'profile_storage_unavailable', response.status === 409 ? 409 : 503);
      return value;
    } catch (error) {
      if (error instanceof Failure) throw error;
      throw failed('profile_storage_unavailable');
    }
  }

  // The backend checked the lease when it issued this grant.
  async load() {
    if (!this.grant.object) {
      const states = [];
      for (const source of this.imports) {
        try { states.push(filterState(await source.load(), this.grant.site)); }
        catch { this.readOnly = true; this.importsMissing = true; }
      }
      return filterState(mergeStates(states), this.grant.site);
    }
    const bytes = await this.io(this.grant.download_url, 'GET', null, this.config.profileStorageHost);
    const state = decryptState(bytes, this.key, this.grant);
    this.savedHash = digest(JSON.stringify(state));
    return state;
  }

  // Saves this site's part of a browser snapshot, only when it changed.
  async saveState(snapshot) {
    if (this.dead || this.readOnly) return;
    if (this.pending) {
      await this.operation('commit', this.pending.commit);
      this.grant.revision = this.pending.commit.revision;
      this.savedHash = this.pending.hash;
      this.pending = null;
      this.dropImports();
    }
    const state = filterState(snapshot, this.grant.site);
    const hash = digest(JSON.stringify(state));
    if (hash === this.savedHash) return;
    const upload = await this.operation('upload', {revision: this.grant.revision});
    if (this.dead) return;
    const body = encryptState(state, this.key, this.grant, upload.revision, upload.object);
    await this.io(upload.upload_url, 'PUT', body, this.config.profileStorageHost);
    this.pending = {hash, commit: {revision: upload.revision, object: upload.object, sha256: digest(body)}};
    await this.operation('commit', this.pending.commit);
    this.grant.revision = upload.revision;
    this.savedHash = hash;
    this.pending = null;
    this.dropImports();
  }

  async save(context) {
    await this.saveState(await browserStorageState(context));
  }

  dropImports() {
    for (const source of this.imports) source.release();
    this.imports = [];
  }

  // Leases are released for the whole browser session at once; this only
  // forgets the key material.
  release() {
    if (this.dead) return;
    this.dead = true;
    this.key.fill(0);
    this.dropImports();
  }
}
