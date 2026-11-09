import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {createInputExchange,openInput,dropInputExchanges} from './vault-crypto.js';
import { join } from 'node:path';
import { Failure, check } from './errors.js';
import { webURL, resolvePublic } from './network.js';
import { SiteStorage, installSiteLoader } from './site-storage.js';
import {capturePage} from './browser-capture.js';
import {BrowserFiles, readBytes, fileType, workPath, MAX_FILE_BYTES} from './browser-files.js';
import {WorkCode} from './work-code.js';
import {runWorkTool, validateWorkTool} from './work-tools.js';
import {downloadWorkFile} from './work-download.js';
import {runShell, validateShell} from './work-shell.js';
import {sshOperation} from './ssh-connect.js';
import {recall} from './vault-keys.js';
import {browserDevice, browserIdentity, applyBrowserDevice, setBrowserDeviceHeaders, browserIdentityGuard, browserRequestHeaders} from './browser-device.js';

const actions = new Set(['open', 'navigate', 'click', 'fill', 'press', 'scroll', 'wait', 'evaluate', 'inspect', 'screenshot', 'close',
  'tabs', 'new_tab', 'switch_tab', 'close_tab', 'get_html', 'resources', 'read_resource', 'downloads', 'read_file', 'import_file', 'export_file', 'upload', 'set_device', 'keepalive',
  'run_code', 'write_file', 'remove_file', 'download_file', 'save_resource', 'file_tool', 'sh']);
const workActions = new Set(['sh', 'run_code', 'write_file', 'remove_file', 'download_file', 'save_resource', 'file_tool', 'export_file']);
function text(value, name, max = 4096) { check(typeof value === 'string' && value.length > 0 && value.length <= max, `${name} is required (max ${max} characters)`); return value; }
function integer(value, fallback, min, max) { const n = value ?? fallback; check(Number.isInteger(n) && n >= min && n <= max, `Integer must be between ${min} and ${max}`); return n; }
export function validateCommand(c) {
  check(c && typeof c === 'object' && !Array.isArray(c) && actions.has(c.action), 'Unknown action');
  if (c.action !== 'open') text(c.session_id, 'session_id', 64);
  if (c.frame !== undefined) text(c.frame, 'frame', 512);
  if (c.tab_id !== undefined || ['switch_tab', 'close_tab'].includes(c.action)) text(c.tab_id, 'tab_id', 64);
  if (c.selector !== undefined || ['click', 'fill', 'press', 'wait', 'upload'].includes(c.action)) text(c.selector, 'selector', 512);
  if (c.action === 'fill') { check(c.sealed_input ? !c.text && typeof c.sealed_input==='object' && c.sensitive===true : typeof c.text === 'string' && c.text.length <= 16_384, 'text or protected input is required'); }
  for (const key of ['sensitive','password_only']) if (c[key] !== undefined) check(c.action === 'fill' && typeof c[key] === 'boolean', key + ' is a fill boolean');
  if (c.expected_origin !== undefined) check(c.action==='fill' && typeof c.expected_origin==='string' && c.expected_origin.length<=4096,'Invalid fill origin');
  if (c.action === 'press') text(c.key, 'key', 80);
  if (c.action === 'evaluate') {
    text(c.code, 'code', 65_536);
    if (c.mode !== undefined) check(['expression', 'script'].includes(c.mode), 'Invalid evaluate mode');
  }
  if (c.action === 'run_code') {
    check(Boolean(c.code) !== Boolean(c.code_file), 'Supply exactly one of code or code_file');
    if (c.code) text(c.code, 'code', 65536);
    if (c.code_file) text(c.code_file, 'code_file', 512);
    integer(c.timeout_ms, 10000, 100, 45000);
  }
  if (c.action === 'sh') { validateShell(c); integer(c.timeout_ms, 10000, 100, 45000); }
  if (['write_file', 'download_file', 'save_resource'].includes(c.action)) workPath(c.path);
  if (c.action === 'write_file') {
    check(typeof c.content === 'string' && c.content.length <= 900000, 'content is required (up to 900000 characters)');
    check(c.encoding === undefined || ['utf8', 'base64'].includes(c.encoding), 'write_file encoding must be utf8 or base64');
  }
  if (c.overwrite !== undefined) check(typeof c.overwrite === 'boolean', 'overwrite must be boolean');
  if (c.action === 'download_file') webURL(text(c.url, 'url'));
  if (c.action === 'file_tool') validateWorkTool(c);
  if (c.device !== undefined) check(['open', 'set_device'].includes(c.action), 'device is supported by open/set_device; new tabs inherit the session device');
  if (c.action === 'open' || c.action === 'set_device') browserDevice(c);
  if (c.action === 'set_device') check(['android','desktop'].includes(c.device), 'set_device requires device:android or desktop');
  if (c.reload !== undefined) check(c.action === 'set_device' && typeof c.reload === 'boolean', 'reload is a boolean for set_device only');
  if (c.action === 'open' || c.action === 'new_tab') {
    if (c.storage !== undefined) check(['ephemeral', 'persistent'].includes(c.storage), 'Invalid storage mode');
    check(c.action === 'open' ? Boolean(c.url) !== Boolean(c.html) : !(c.url && c.html), 'Supply one of url or html');
    if (c.action === 'new_tab') check(c.width === undefined && c.height === undefined, 'New tabs inherit the session viewport; use set_device to resize');
    if (c.html) text(c.html, 'html', 524_288);
  }
  if (c.action === 'navigate' || c.url) webURL(text(c.url, 'url'));
  if (c.action === 'scroll') { integer(c.x, 0, -10000, 10000); integer(c.y, 600, -10000, 10000); }
  if (c.action === 'screenshot' && c.full_page !== undefined) check(typeof c.full_page === 'boolean', 'full_page must be boolean');
  if (c.action === 'screenshot') {
    check([!!c.full_page, !!c.clip, !!c.selector].filter(Boolean).length <= 1, 'Choose full_page, clip or selector');
    check(!c.frame || c.selector, 'frame screenshots require an element selector');
    if (c.format !== undefined) check(['jpeg', 'png'].includes(c.format), 'Screenshot format must be jpeg or png');
    if (c.clip !== undefined) {
      check(c.clip && typeof c.clip === 'object' && !Array.isArray(c.clip), 'Invalid clip');
      for (const key of ['x','y','width','height']) check(Number.isFinite(c.clip[key]) && c.clip[key] >= (['x','y'].includes(key) ? 0 : 1) && c.clip[key] <= 100000, 'Invalid clip dimension');
    }
  }
  if (['get_html','read_resource','read_file'].includes(c.action)) {
    integer(c.offset, 0, 0, 1_000_000_000); integer(c.limit, 32768, 1, 65536);
    if (c.encoding !== undefined) check(['auto','text','base64'].includes(c.encoding), 'Invalid encoding');
  }
  if (['read_resource', 'save_resource'].includes(c.action)) text(c.resource_id, 'resource_id', 64);
  if (['read_file','upload','remove_file','export_file'].includes(c.action)) text(c.file_id, 'file_id', 512);
  if (c.action === 'read_file') integer(c.page, 1, 1, 100000);
}

export class Sessions {
  constructor(config, proxyURL) {
    this.config = config; this.proxyURL = proxyURL; this.items = new Map(); this.active = 0; this.stopping = false;
    this.timer = setInterval(() => this.reap(), 5000); this.timer.unref();
  }
  stats() { return {sessions: this.items.size, active: this.active, max_sessions: this.config.sessions}; }
  ownerKey(owner) { return owner.user_id + ':' + owner.app_id; }
  async createInputExchange(owner,session){
    const s=this.items.get(session);
    if(!s||s.owner!==this.ownerKey(owner)||s.closed)throw new Failure(404,'session_not_found','Session not found or expired');
    check(s.page&&/^https?:/.test(s.page.url()),'Protected input requires a website origin');
    return createInputExchange(owner,session,new URL(s.page.url()).origin);
  }
  async capturePreview(s) {
    try {
      const bytes = await s.page.screenshot({type: 'jpeg', quality: 85, timeout: 1500});
      if (bytes.length <= 2_000_000) return {mime_type: 'image/jpeg', base64: bytes.toString('base64')};
    } catch { /* Optional UI capture must never replay a completed action. */ }
  }
  async run(owner, command, storageGrant, wantPreview = false, attachment = null) {
    validateCommand(command);
    if (this.stopping) throw new Failure(503, 'stopping', 'Service is stopping');
    const key = this.ownerKey(owner);
    let s;
    if (command.action === 'open') {
      const values = [...this.items.values()];
      if (values.length >= this.config.sessions || values.filter(v => v.owner === key).length >= this.config.perOwner || values.filter(v => v.user === owner.user_id).length >= this.config.perUser)
        throw new Failure(429, 'session_limit', 'Browser session limit reached; close an idle session');
    } else {
      s = this.items.get(command.session_id);
      if (!s || s.owner !== key) throw new Failure(404, 'session_not_found', 'Session not found or expired');
      if (s.busy) throw new Failure(409, 'session_busy', 'Wait for the previous command in this session');
      if (command.action === 'close') {
        s.busy = true;
        const preview = wantPreview && s.page ? await this.capturePreview(s) : undefined;
        const tab_id = s.activeTabID, device = s.device;
        await this.destroy(s, true);
        return {closed: true, session_id: s.id, tab_id, device, ...(preview ? {preview} : {})};
      }
    }
    if (this.active >= this.config.actions) throw new Failure(429, 'action_limit', 'Browser action capacity reached; retry later');
    if (!s) {
      s = {id: randomUUID(), owner: key, user: owner.user_id, ownerObject: {user_id: owner.user_id, app_id: owner.app_id}, created: Date.now(), touched: Date.now(), logs: [], busy: true, helperPages: new WeakSet()};
      if (storageGrant) {
        check(command.url && !command.html && command.storage !== 'ephemeral', 'Persistent storage requires a URL session');
        const storage = new SiteStorage(owner, storageGrant, this.config, this.config.profileIO);
        // Nothing is launched yet: a missing run key fails cleanly and the
        // backend retries the same grant once a device released it.
        try { await storage.init(); } catch (error) { storage.discard(); throw error; }
        s.storage = storage;
      } else if (command.storage === 'persistent') throw new Failure(503, 'profiles_unavailable', 'Backend profile grant required');
      this.items.set(s.id, s);
    }
    s.busy = true; s.touched = Date.now(); this.active++;
    const timeout = workActions.has(command.action) ? (this.config.workTimeout || 60000) : this.config.timeout;
    s.workController = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          if (s.storage && command.action !== 'open') await s.storage.check();
          const result = await this.perform(s, command, attachment);
          if (s.closed) throw new Failure(404, 'session_not_found', 'Session closed');
          if (s.storage) {
            await s.storage.save(s.context);
            result.storage = s.storage.summary();
          }
          // UI-only snapshot: never fail/replay a completed mutation because
          // capturing its preview failed. Leave headroom for the action watchdog.
          if (wantPreview && !workActions.has(command.action) && !command.sensitive && !result.image && s.page && !['tabs','resources','read_resource','downloads','read_file','get_html','import_file','keepalive'].includes(command.action) && Date.now() - s.touched < this.config.timeout - 2000) {
            result.preview = await this.capturePreview(s);
          }
          return result;
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => {
          void this.destroy(s).catch(() => {});
          reject(new Failure(504, 'action_timeout', 'Browser command timed out; session closed'));
        }, timeout); }),
      ]);
    } catch (error) {
      if (s.protectedValues) error.message = this.redact(s, error.message);
      if (command.action === 'open' || error.name === 'TimeoutError' || error.code === 'profile_lease_expired') await this.destroy(s);
      throw error;
    } finally { clearTimeout(timer); s.workController.abort(); s.busy = false; s.touched = Date.now(); this.active--; }
  }
  async launch(s, c) {
    const storageState = s.storage ? await s.storage.initialState() : undefined;
    if (s.closed) throw new Error('Session closed');
    s.dir = await mkdtemp(join(this.config.workRoot || tmpdir(), 'fork-computer-'));
    if (s.closed) { await rm(s.dir, {recursive: true, force: true}); throw new Error('Session closed'); }
    s.server = await chromium.launchServer({
      executablePath: this.config.browserExecutable || undefined,headless: true, chromiumSandbox: true, host: '127.0.0.1', timeout: this.config.timeout,
      env: {PATH: process.env.PATH, HOME: s.dir, TMPDIR: s.dir, LANG: 'C.UTF-8', ...(process.env.LD_LIBRARY_PATH ? {LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH} : {})},
      proxy: {server: this.proxyURL, bypass: '<-loopback>'},
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    });
    if (s.closed) { await s.server.kill(); await rm(s.dir, {recursive: true, force: true}); throw new Error('Session closed'); }
    s.browser = await chromium.connect(s.server.wsEndpoint());
    s.device = browserDevice(c); s.browserVersion = s.browser.version();
    s.identityGuard = await browserIdentityGuard(s.browser, () => browserIdentity(s.device, s.browserVersion));
    s.context = await s.browser.newContext({viewport: {width: s.device.width, height: s.device.height},
      screen: {width: s.device.width, height: s.device.height}, deviceScaleFactor: 1,
      isMobile: s.device.mobile, hasTouch: s.device.touch, userAgent: browserIdentity(s.device, s.browserVersion).userAgent,
      serviceWorkers: 'block', acceptDownloads: true, bypassCSP: true, permissions: [], storageState});
    await setBrowserDeviceHeaders(s.context, s.device, s.browserVersion);
    s.context.setDefaultTimeout(Math.min(10000, this.config.timeout));
    s.tabs = new Map(); s.tabForPage = new WeakMap();
    s.route = async route => {
      try {
        const request = route.request();
        webURL(request.url());
        let page, topLevel = true;
        try { topLevel = !request.frame().parentFrame(); page = request.frame().page(); } catch { /* popup's first request has no exposed page yet */ }
        // A popup's first request precedes its site loader: open the site here.
        if (s.storage && topLevel && request.isNavigationRequest()) await s.storage.ensure(request.url(), s.context, () => this.helperPage(s));
        if (request.isNavigationRequest() && (!page || !s.tabForPage.has(page))) {
          await s.identityGuard();
          // Chromium initializes a popup with the context's original UA before
          // its page event. Correct the first request for the current mode.
          // Header overrides persist across redirects: never pin HTTP auth.
          const headers = browserRequestHeaders(s.device, s.browserVersion, request.headers());
          delete headers.authorization;
          await route.fallback({headers});
        } else await route.fallback();
      }
      catch { await route.abort().catch(() => {}); }
    };
    await s.context.route('**/*', s.route);
    // Keep all pages behind the same checked-IP egress policy.
    await s.context.routeWebSocket('**/*', ws => ws.close());
    s.files = new BrowserFiles(join(s.dir, 'downloads'));
    await s.files.install(s.browser);
    s.context.on('page', p => {
      const adopt = () => { if (!s.helperPages.has(p)) void this.adoptPage(s, p).catch(() => { void p.close().catch(() => {}); }); };
      // A storage helper page is not a tab; wait until it is identified.
      if (s.helperPending) void s.helperReady.then(adopt); else adopt();
    });
    const page = await s.context.newPage();
    const tab = await this.adoptPage(s, page);
    s.page = page; s.activeTabID = tab.id;
    s.browser.on('disconnected', () => { void this.destroy(s).catch(() => {}); });
    if (s.closed) { await s.server.kill(); throw new Error('Session closed'); }
    if (c.html) await s.page.setContent(c.html, {waitUntil: 'domcontentloaded'});
    else { await resolvePublic(webURL(c.url).hostname); await s.page.goto(c.url, {waitUntil: 'domcontentloaded'}); }
  }
  // A private page of the context for restoring a site's storage; never a tab.
  async helperPage(s) {
    let ready;
    s.helperReady = new Promise(resolve => { ready = resolve; });
    s.helperPending = (s.helperPending || 0) + 1;
    try {
      const page = await s.context.newPage();
      s.helperPages.add(page);
      return page;
    } finally { s.helperPending--; ready(); }
  }
  async adoptPage(s, page) {
    const existing = s.tabForPage.get(page);
    if (existing) return existing.ready;
    if (s.closed || s.tabs.size >= (this.config.tabs || 8)) {
      await page.close().catch(() => {});
      throw new Failure(429, 'tab_limit', 'Tab limit reached; close an idle tab');
    }
    const tab = {id: randomUUID(), page, resources: new Map(), guarded: false};
    s.tabs.set(tab.id, tab); s.tabForPage.set(page, tab);
    const log = (type, message) => { s.logs.push({tab_id: tab.id, type, message: this.redact(s,String(message)).slice(0, 2000)}); if (s.logs.length > 50) s.logs.shift(); };
    page.on('console', msg => log(msg.type(), msg.text()));
    page.on('pageerror', error => log('pageerror', error.message));
    page.on('requestfailed', req => log('requestfailed', req.url() + ' ' + req.failure()?.errorText));
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
    page.on('response', response => {
      if (response.status() >= 400) log('http_error', response.status() + ' ' + response.url());
      const resource = {resource_id: randomUUID(), url: response.url().slice(0, 4096), status: response.status(), type: response.request().resourceType(), mime_type: (response.headers()['content-type'] || '').slice(0, 200)};
      tab.resources.set(resource.resource_id, {response, resource});
      if (tab.resources.size > 200) tab.resources.delete(tab.resources.keys().next().value);
    });
    page.on('close', () => {
      s.tabs.delete(tab.id);
      if (s.activeTabID === tab.id) {
        const next = s.tabs.values().next().value;
        s.activeTabID = next?.id; s.page = next?.page;
      }
    });
    tab.ready = (async () => {
      if (s.storage) await installSiteLoader(s.context, page, url => s.storage.ensure(url, s.context, () => this.helperPage(s)));
      tab.emulation ||= await s.context.newCDPSession(page);
      await s.identityGuard.adopt(tab.emulation);
      await applyBrowserDevice(s.context, tab, s.device, s.browserVersion);
      tab.guarded = true;
      if (!s.page) { s.page = page; s.activeTabID = tab.id; }
      return tab;
    })();
    return tab.ready;
  }
  async tabList(s) {
    return Promise.all([...s.tabs.values()].map(async tab => ({tab_id: tab.id, active: tab.id === s.activeTabID,
      url: tab.page.url().slice(0,4096), title: (await tab.page.title().catch(() => '')).slice(0,1000)})));
  }
  async perform(s, c, attachment) {
    if (c.action === 'open') await this.launch(s, c);
    if (c.action === 'new_tab') {
      if (s.tabs.size >= (this.config.tabs || 8)) throw new Failure(429, 'tab_limit', 'Tab limit reached; close an idle tab');
      const tab = await this.adoptPage(s, await s.context.newPage());
      s.page = tab.page; s.activeTabID = tab.id;
      if (c.html) await s.page.setContent(c.html, {waitUntil: 'domcontentloaded'});
      else if (c.url) { await resolvePublic(webURL(c.url).hostname); await s.page.goto(c.url, {waitUntil: 'domcontentloaded'}); }
    } else if (c.tab_id) {
      const tab = s.tabs.get(c.tab_id);
      if (!tab) throw new Failure(404, 'tab_not_found', 'Tab not found in this session');
      await tab.ready;
      s.page = tab.page; s.activeTabID = tab.id;
    }
    if (c.action === 'close_tab') await s.page.close();
    const page = s.page;
    if (!page && !['tabs','close_tab','downloads','read_file','import_file','set_device','keepalive', ...workActions].includes(c.action)) throw new Failure(404, 'tab_not_found', 'No open tab; use new_tab');
    const target = c.frame && page ? page.frameLocator(c.frame) : page;
    const locator = c.selector && target ? target.locator(c.selector) : null;
    let result = {};
    if (workActions.has(c.action)) {
      s.workPending = this.performWork(s, c, attachment);
      result = await s.workPending;
      return {session_id: s.id, tab_id: s.activeTabID, device: s.device, url: page?.url().slice(0, 4096) || '', ...result, logs: s.logs.splice(0)};
    }
    switch (c.action) {
      case 'keepalive': result.remaining_ms = Math.max(0, (s.storage ? Math.min(this.config.lifetime,900000) : this.config.lifetime) - (Date.now()-s.created)); break;
      case 'set_device':
        s.device = browserDevice(c);
        await setBrowserDeviceHeaders(s.context, s.device, s.browserVersion);
        await Promise.all([...s.tabs.values()].map(async tab => {
          await tab.ready;
          if (!tab.page.isClosed()) await applyBrowserDevice(s.context, tab, s.device, s.browserVersion);
        }));
        result.reloaded = false;
        if (page && c.reload !== false && /^https?:/.test(page.url())) {
          await page.reload({waitUntil: 'domcontentloaded'});
          result.reloaded = true;
        }
        break;
      case 'navigate':
        await resolvePublic(webURL(c.url).hostname); await page.goto(c.url, {waitUntil: 'domcontentloaded'}); break;
      case 'click': await locator.click(); break;
      case 'fill': {
        const input=c.sensitive?await locator.elementHandle():locator;
        check(input,'Input element is no longer available');
        try{
        if(c.sealed_input){
          const origin=await input.evaluate(e=>e.ownerDocument.location.origin);
          c.text=openInput({user_id:s.user,app_id:s.owner.split(':')[1]},s.id,origin,c.sealed_input);
          check(c.text.length<=16384,'Protected input is too long');
        }
        if (c.sensitive && c.text) {
          s.protectedValues ||= new Set();
          check(s.protectedValues.has(c.text)||s.protectedValues.size<40,'Protected input limit reached; reopen the session');
          s.protectedValues.add(c.text);
        }
        if (c.expected_origin) check(await input.evaluate(e=>e.ownerDocument.location.origin)===c.expected_origin,'The browser left the site that requested this value; request new input');
        if (c.password_only) check(await input.evaluate(e=>e.tagName==='INPUT' && e.type==='password'),'Password answers can only fill a password input');
        await input.fill(c.text);
        }finally{if(c.sensitive)await input.dispose()}
        break;
      }
      case 'press': await locator.press(c.key); break;
      case 'scroll': await page.mouse.wheel(c.x ?? 0, c.y ?? 600); break;
      case 'wait': await locator.waitFor({state: 'visible'}); break;
      case 'switch_tab': await page.bringToFront(); break;
      case 'tabs': case 'new_tab': case 'close_tab': result.tabs = await this.tabList(s); break;
      case 'downloads': result = s.files.list(); break;
      case 'import_file':
        check(attachment && Buffer.isBuffer(attachment.data), 'File bytes must be supplied by the trusted backend');
        result.file = await s.files.import(attachment.name, attachment.data); break;
      case 'read_file': result = await s.files.read(c); break;
      case 'upload': {
        const {file, data} = await s.files.bytes(c.file_id);
        await locator.setInputFiles({name: file.name, mimeType: fileType(data), buffer: data});
        result.uploaded = {file_id: file.file_id, name: file.name, size: data.length}; break;
      }
      case 'resources': result.resources = [...s.tabs.get(s.activeTabID).resources.values()].map(r => r.resource); break;
      case 'read_resource': {
        const entry = s.tabs.get(s.activeTabID).resources.get(c.resource_id);
        if (!entry) throw new Failure(404, 'resource_not_found', 'Resource no longer available in this tab; list resources again');
        const failed = await entry.response.finished();
        check(!failed, 'Resource did not finish loading');
        const sizes = await entry.response.request().sizes();
        check(sizes.responseBodySize <= 2_000_000, 'Resource exceeds 2 MB; inspect it through page JavaScript');
        const data = await entry.response.body();
        check(data.length <= 2_000_000, 'Decoded resource exceeds 2 MB');
        result = {resource: entry.resource, ...readBytes(data, c, entry.resource.mime_type)}; break;
      }
      case 'get_html':
        result = await (locator || target.locator('html')).evaluate((root, {offset, limit}) => {
          const html = root.outerHTML, end = Math.min(offset + limit, html.length);
          return {html: html.slice(offset, end), offset, next_offset: end < html.length ? end : null, total_characters: html.length, truncated: end < html.length};
        }, {offset: c.offset || 0, limit: c.limit || 32768}); break;
      case 'evaluate': {
        // Only the page evaluates user code; never eval in the Node controller.
        const evaluate = async (_element, {code, arg, mode}) => {
          const fn = mode === 'script' ? new (Object.getPrototypeOf(async function(){}).constructor)('arg', code) : (0, eval)('(' + code + ')');
          const value = typeof fn === 'function' ? await fn(arg) : await fn;
          const json = JSON.stringify(value === undefined ? null : value);
          if (json.length > 65_536) throw new Error('Evaluation result exceeds 64 KiB');
          return json;
        };
        const json = await target.locator('html').evaluate(evaluate, {code: c.code, arg: c.arg, mode: c.mode});
        result.value = JSON.parse(json); break;
      }
      case 'inspect':
        result = await target.locator('html').evaluate(root => ({
          title: document.title.slice(0, 1000), text: (document.body?.innerText || '').slice(0, 16000),
          elements: Array.from(root.querySelectorAll('button,a,input,textarea,select,[role="button"]')).slice(0, 100).map(e => ({
            tag: e.tagName.toLowerCase(), id: e.id.slice(0, 200), role: e.getAttribute('role')?.slice(0, 200), text: (e.innerText || '').slice(0, 200),
            label: e.getAttribute('aria-label')?.slice(0, 200), name: e.getAttribute('name')?.slice(0, 200), type: e.getAttribute('type')?.slice(0, 200),
          })),
        })); break;
      case 'screenshot': {
        result.image = await capturePage(s.context, page, c); break;
      }
    }
    const output={session_id: s.id, tab_id: s.activeTabID, device: s.device, url: s.page?.url().slice(0, 4096) || '', ...result, logs: s.logs.splice(0)};
    if (s.protectedValues?.size) for (const key of Object.keys(output)) if (!['image','preview'].includes(key)) output[key]=this.redact(s,output[key]);
    return output;
  }
  redact(s,value) {
    if (typeof value==='string') { for (const secret of s.protectedValues||[]) value=value.replaceAll(secret,'[protected]'); return value; }
    if (Array.isArray(value)) return value.map(item=>this.redact(s,item));
    if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[this.redact(s,key),this.redact(s,item)]));
    return value;
  }
  async destroy(s, save = false) {
    if (s.destroying) return s.destroying;
    s.closed = true;
    s.workController?.abort(); s.code?.close();
    dropInputExchanges(s.id);
    s.files?.close();
    this.items.delete(s.id);
    s.destroying = (async () => {
      let failure;
      if (save && s.storage && s.context) {
        let timer;
        try {
          await Promise.race([s.storage.save(s.context), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Failure(503, 'profile_save_failed', 'Final profile save timed out; last checkpoint retained')), 8000);
          })]);
        } catch { failure = new Failure(503, 'profile_save_failed', 'Final profile save failed; last checkpoint retained'); }
        finally { clearTimeout(timer); }
      }
      // Release invalidates future commits before removing the browser. A hard
      // watchdog never asks a hung renderer for one more snapshot.
      if (s.storage) await s.storage.release();
      await s.server?.kill().catch(() => {});
      await s.workPending?.catch(() => {});
      if (s.dir) await rm(s.dir, {recursive: true, force: true}).catch(() => {});
      if (failure) throw failure;
    })();
    return s.destroying;
  }
  async performWork(s, c, attachment) {
    const signal = s.workController.signal;
    switch (c.action) {
      case 'sh': return runShell(s.files, c, signal, this.shellBrowser(s), this.shellSsh(s));
      case 'run_code': s.code ||= new WorkCode(s); return s.code.run(c);
      case 'file_tool': return runWorkTool(s.files, c, signal);
      case 'remove_file': return s.files.remove(c.file_id);
      case 'write_file': {
        const data = Buffer.from(c.content, c.encoding === 'base64' ? 'base64' : 'utf8');
        check(c.encoding !== 'base64' || data.toString('base64') === c.content, 'Invalid base64');
        return {file: await s.files.write(c.path, data, !!c.overwrite, 'code', signal)};
      }
      case 'download_file': return {file: await s.files.write(c.path, await downloadWorkFile(c.url, signal), !!c.overwrite, 'download', signal)};
      case 'save_resource': {
        const resource = s.tabs.get(s.activeTabID)?.resources.get(c.resource_id);
        check(resource && resource.response.ok(), 'A successful resource from the selected tab is required');
        check(!await resource.response.finished(), 'Resource did not finish loading');
        check((await resource.response.request().sizes()).responseBodySize <= 2_000_000, 'Resource exceeds 2 MB; use a browser download');
        const data = await resource.response.body();
        check(data.length <= 2_000_000, 'Resource exceeds 2 MB; use a browser download');
        return {file: await s.files.write(c.path, data, !!c.overwrite, 'resource', signal)};
      }
      case 'export_file': {
        check(attachment?.export === true, 'Use the trusted file export endpoint');
        const {file, data} = await s.files.bytes(c.file_id);
        check(data.length <= MAX_FILE_BYTES, 'Export exceeds 10 MiB');
        return {file, base64: data.toString('base64'), mime_type: fileType(data)};
      }
    }
  }
  // Read-only view of the session's active tab for the computer shell. The
  // session stays busy for the whole command, so no other action interleaves.
  shellBrowser(s) {
    const page = () => { check(s.page && !s.page.isClosed(), 'No open tab; use new_tab'); return s.page; };
    const root = async selector => {
      if (!selector) return page().locator('html');
      check(typeof selector === 'string' && selector.length <= 512, 'Invalid selector');
      const match = page().locator(selector);
      if (await match.count() === 0) throw new Failure(404, 'element_not_found', `No element matches ${selector}`);
      return match.first();
    };
    const redact = value => this.redact(s, value);
    return {
      url: async () => page().url(),
      title: async () => redact(await page().title()),
      text: async selector => redact(await (await root(selector)).evaluate(e => e === document.documentElement ? document.body?.innerText ?? '' : e.innerText ?? e.textContent ?? '', null, {timeout: 5000})),
      html: async selector => {
        const html = await (await root(selector)).evaluate(e => e.outerHTML, null, {timeout: 5000});
        check(html.length <= 10 * 1024 * 1024, 'HTML exceeds 10 MiB; use a selector');
        return redact(html);
      },
      links: async () => redact(await page().evaluate(() => Array.from(document.links).slice(0, 5000).map(a => ({href: a.href, text: (a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200)})))),
      tabs: async () => redact(await this.tabList(s)),
      resources: async () => [...(s.tabs.get(s.activeTabID)?.resources.values() || [])].map(r => r.resource),
      resource: async id => {
        check(typeof id === 'string' && id.length <= 64, 'resource id required');
        const entry = s.tabs.get(s.activeTabID)?.resources.get(id);
        if (!entry) throw new Failure(404, 'resource_not_found', 'Resource no longer available in this tab; run resources again');
        check(!await entry.response.finished(), 'Resource did not finish loading');
        check((await entry.response.request().sizes()).responseBodySize <= 2_000_000, 'Resource exceeds 2 MB; use a browser download');
        const data = await entry.response.body();
        check(data.length <= 2_000_000, 'Decoded resource exceeds 2 MB');
        return data;
      },
    };
  }
  // The session's SSH capability for the computer shell: each op runs the
  // backend gate, connects, and reports the outcome. The run key lives only on
  // the session for this run.
  shellSsh(s) {
    const storage = s.storage;
    const master = () => storage && storage.vault && storage.master
      ? recall(s.ownerObject, storage.vault, storage.run || '', storage.master.id)
      : undefined;
    const probe = master();
    const enabled = Boolean(this.config.sshBackend) && Boolean(probe);
    probe?.fill(0);
    return {
      enabled,
      run: async (op, args, signal) => {
        const key = master();
        if (!key) throw new Failure(409, 'ssh_locked', 'ssh needs the vault unlocked: start the task from a device that holds your key');
        try { return await sshOperation(this.config, s, key, op, args, signal || s.workController?.signal); }
        finally { key.fill(0); }
      },
    };
  }
  reap() { const now = Date.now(); for (const s of this.items.values()) {
    if (s.closed) continue;
    if (now - s.created > (s.storage ? Math.min(this.config.lifetime, 900000) : this.config.lifetime) || (!s.busy && now - s.touched > this.config.idle)) {
      void this.destroy(s, !s.busy).catch(() => console.warn(JSON.stringify({event: 'profile_save_failed'})));
    } else if (s.storage && !s.busy && now - (s.checkpointAt || s.created) > 10000) {
      s.busy = true; s.checkpointAt = now;
      void (async () => {
        let timer;
        try {
          await Promise.race([(async () => { await s.storage.check(); await s.storage.save(s.context); })(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('checkpoint timeout')), 12000); })]);
        } catch {
          await this.destroy(s).catch(() => {});
        } finally { clearTimeout(timer); s.busy = false; }
      })();
    }
  }}
  async close() {
    this.stopping = true; clearInterval(this.timer);
    await Promise.allSettled([...this.items.values()].map(s => this.destroy(s, !s.busy)));
  }
}
