import {randomBytes} from 'node:crypto';
import {Failure, check} from './errors.js';
import {Profile, filterState, siteHost, transfer} from './profiles.js';
import {browserStorageState} from './browser-storage.js';
import {restoreState} from './storage-restore.js';
import {consumeExchange, seal} from './vault-crypto.js';
import {recall, remember} from './vault-keys.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failed = (code, status = 503, message = code) => new Failure(status, code, message);
const creating = new Map();

// Persistent storage of one browser session. Every website is its own
// encrypted snapshot, opened only when the browser first navigates to it. The
// app browser's master key is released by a device once per agent run and kept
// in memory for that run (see vault-keys.js), so later sessions of the same run
// need no device; each site key is derived from it on first visit.
export class SiteStorage {
  constructor(owner, grant, config, io = transfer) {
    check(config.profileBackend && config.profileStorageHost, 'Private profile storage is not configured');
    check(grant && uuid.test(grant.vault_id) && (!grant.run_id || uuid.test(grant.run_id)), 'Invalid storage grant');
    const session = grant.session, master = grant.master;
    check(session && uuid.test(session.token) && session.user_id === owner.user_id && session.app_id === owner.app_id &&
      session.vault_id === grant.vault_id && (session.run_id || '') === (grant.run_id || ''), 'Invalid storage session');
    check(master && uuid.test(master.id) && typeof master.public_key === 'string', 'Invalid browser key');
    check(!grant.keys || (Array.isArray(grant.keys) && grant.keys.length <= 4), 'Invalid released keys');
    this.owner = owner; this.config = config; this.io = io;
    this.vault = grant.vault_id; this.run = grant.run_id || ''; this.session = session; this.master = master;
    this.released = grant.keys || []; this.initialGrant = grant.site;
    this.local = new Map(); this.sites = new Map(); this.failed = new Set(); this.hosts = new Map(); this.pending = new Map(); this.late = new Set();
    this.restoring = Promise.resolve();
    this.closed = false;
  }

  // Resolves the master key: released with this command, held for this run,
  // or (for an app browser that has none yet) generated and sealed to the vault.
  async init() {
    for (const released of this.released) {
      const key = consumeExchange(this.owner, released, this.vault, this.run);
      this.local.set(released.id, key);
      remember(this.owner, this.vault, this.run, released.id, key);
    }
    this.released = [];
    this.key = this.keyFor(this.master.id);
    if (!this.key && this.master.create) this.key = await this.createMaster();
    if (!this.key) throw failed('vault_key_unavailable', 409, 'Open the Fork app on the device that started this task to unlock saved sign-ins');
    if (this.initialGrant) {
      try { this.initial = this.profile(this.initialGrant); }
      catch (error) { this.failed.add(this.initialGrant.site); throw error; }
    }
  }

  keyFor(id) {
    const local = this.local.get(id);
    return local ? Buffer.from(local) : recall(this.owner, this.vault, this.run, id);
  }

  async createMaster() {
    const slot = [this.owner.user_id, this.owner.app_id, this.vault].join('|');
    while (creating.has(slot)) await creating.get(slot).catch(() => {});
    const existing = this.keyFor(this.master.id);
    if (existing) return existing;
    const attempt = (async () => {
      const key = randomBytes(32);
      const context = JSON.stringify(['fork-browser-key-v1', this.owner.user_id, this.vault, this.owner.app_id, this.master.id]);
      try {
        await this.call({action: 'master', session: this.session, master_id: this.master.id, wrapped_key: seal(key, this.master.public_key, context)});
      } catch (error) {
        key.fill(0);
        if (error.code === 'browser_key_conflict') return undefined;
        throw error;
      }
      this.local.set(this.master.id, Buffer.from(key));
      remember(this.owner, this.vault, this.run, this.master.id, key);
      return key;
    })();
    creating.set(slot, attempt);
    try { return await attempt; } finally { creating.delete(slot); }
  }

  profile(grant) {
    return new Profile(this.owner, grant, this.config, this.io, {master: this.key, combined: id => this.keyFor(id)});
  }

  // The state the browser context starts with: the opened URL's site only. If
  // it cannot be opened the browser starts without it and never saves it.
  async initialState() {
    if (!this.initial) return undefined;
    const profile = this.initial; this.initial = undefined;
    try {
      const state = await profile.load();
      this.sites.set(profile.grant.site, profile);
      return state;
    } catch {
      profile.release();
      this.failed.add(profile.grant.site);
      return undefined;
    }
  }

  covers(hostname) {
    for (const site of this.sites.keys()) if (siteHost(hostname, site)) return true;
    return false;
  }

  // Opens the site of a top-level navigation before the request leaves. A site
  // that cannot be opened stays unsaved for this session; navigation continues.
  async ensure(raw, context, helperPage) {
    let url;
    try { url = new URL(raw); } catch { return; }
    if (this.closed || !['http:', 'https:'].includes(url.protocol)) return;
    const hostname = url.hostname.toLowerCase();
    if (this.covers(hostname) || this.hosts.get(hostname) === null) return;
    const known = this.hosts.get(hostname);
    if (known && (this.sites.has(known) || this.failed.has(known))) return;
    if (!this.pending.has(hostname)) {
      const opening = this.open(url, hostname, context, helperPage).finally(() => this.pending.delete(hostname));
      this.pending.set(hostname, opening);
    }
    let timer, timedOut = false;
    await Promise.race([this.pending.get(hostname), new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve(); }, 10000); })]);
    clearTimeout(timer);
    // The page loads without its data now; a late result must not be mixed in.
    if (timedOut) this.late.add(hostname);
  }

  async open(url, hostname, context, helperPage) {
    let site;
    try {
      const grant = await this.call({action: 'site', session: this.session, url: url.origin});
      if (!grant.id) { this.hosts.set(hostname, null); return; }
      site = grant.site;
      this.hosts.set(hostname, site);
      if (this.closed || this.sites.has(site) || this.failed.has(site)) return;
      const profile = this.profile(grant);
      try {
        const state = await profile.load();
        if (this.late.has(hostname)) throw failed('profile_open_timeout');
        // One helper page at a time per browser.
        const restoring = this.restoring.then(() => restoreState(context, state, helperPage));
        this.restoring = restoring.catch(() => {});
        await restoring;
        if (this.closed) { profile.release(); return; }
        this.sites.set(site, profile);
      } catch (error) {
        profile.release();
        throw error;
      }
    } catch {
      if (site) this.failed.add(site); else this.hosts.set(hostname, null);
    }
  }

  // One browser snapshot, split per site. A failing site does not stop others.
  async save(context) {
    if (!this.sites.size) return;
    const snapshot = filterState(await browserStorageState(context), '*');
    let failure;
    for (const profile of this.sites.values()) {
      try { await profile.saveState(snapshot); } catch (error) { failure ||= error; }
    }
    if (failure) throw failure;
  }

  // The device that started the run must still hold the vault key.
  async check() {
    for (const profile of this.sites.values()) if (!profile.readOnly) return profile.operation('check');
  }

  summary() {
    return {mode: 'persistent', scope: 'per_site', sites: [...this.sites.keys()], ...(this.failed.size ? {unavailable: [...this.failed]} : {})};
  }

  // Forgets key material without ending the leases (the backend may retry the
  // same grant with keys a device has just released).
  discard() {
    this.closed = true;
    this.initial?.release();
    this.key?.fill(0);
    for (const key of this.local.values()) key.fill(0);
    this.local.clear();
  }

  async release() {
    if (this.closed) return;
    this.closed = true;
    const leased = [...this.sites.values()].find(profile => profile.grant.lease);
    for (const profile of this.sites.values()) profile.release();
    this.initial?.release();
    this.key?.fill(0);
    for (const key of this.local.values()) key.fill(0);
    this.local.clear();
    const id = leased?.grant.id || this.initialGrant?.id;
    if (id) await this.call({action: 'release', id, lease: this.session.token}).catch(() => {});
  }

  async call(body) {
    try {
      const response = await fetch(this.config.profileBackend, {method: 'POST', redirect: 'error',
        headers: {authorization: 'Bearer ' + this.config.secret, 'content-type': 'application/json'},
        body: JSON.stringify(body), signal: AbortSignal.timeout(12000)});
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw failed(value?.error?.code || 'profile_storage_unavailable', response.status === 409 ? 409 : 503);
      return value;
    } catch (error) {
      if (error instanceof Failure) throw error;
      throw failed('profile_storage_unavailable');
    }
  }
}

// Pauses every top-level document request of a page (including redirect hops,
// which Playwright routes skip) until the target site's data is in place.
export async function installSiteLoader(context, page, ensure) {
  const cdp = await context.newCDPSession(page);
  const {frameTree} = await cdp.send('Page.getFrameTree');
  const mainFrame = frameTree.frame.id;
  cdp.on('Fetch.requestPaused', async event => {
    try {
      if (event.frameId === mainFrame && event.resourceType === 'Document') await ensure(event.request.url);
    } catch { /* The site stays unsaved; never block the navigation. */ }
    await cdp.send('Fetch.continueRequest', {requestId: event.requestId}).catch(() => {});
  });
  await cdp.send('Fetch.enable', {patterns: [{urlPattern: '*', resourceType: 'Document', requestStage: 'Request'}]});
  return cdp;
}
