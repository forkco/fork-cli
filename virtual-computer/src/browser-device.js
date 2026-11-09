import {check} from './errors.js';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';

// The pinned Playwright installation owns the standalone downloader's version.
// Browser sessions pass their running binary's version instead.
let bundledVersion;
export function installedBrowserVersion() {
  if (!bundledVersion) {
    const require = createRequire(import.meta.url);
    const manifest = JSON.parse(readFileSync(join(dirname(require.resolve('playwright-core/package.json')), 'browsers.json'), 'utf8'));
    bundledVersion = manifest.browsers.find(browser => browser.name === 'chromium')?.browserVersion;
    check(/^\d+\.\d+\.\d+\.\d+$/.test(bundledVersion), 'Installed Chromium version is unavailable');
  }
  return bundledVersion;
}

export const androidIdentity = Object.freeze({model: 'Pixel 10 Pro', platformVersion: '16.0.0'});

export function browserDevice(command = {}) {
  const name = command.device ?? 'android';
  check(['android', 'desktop'].includes(name), 'device must be android or desktop');
  const width = command.width ?? (name === 'android' ? 412 : 1280);
  const height = command.height ?? (name === 'android' ? 839 : 800);
  check(Number.isInteger(width) && width >= 320 && width <= 1920, 'width must be between 320 and 1920');
  check(Number.isInteger(height) && height >= 240 && height <= 1920, 'height must be between 240 and 1920');
  return {name, width, height, mobile: name === 'android', touch: name === 'android'};
}

export function browserIdentity(device, version = installedBrowserVersion()) {
  const mobile = device.mobile;
  const major = version.split('.')[0];
  const brands = [{brand: 'Not_A Brand', version: '99'}, {brand: 'Chromium', version: major}, {brand: 'Google Chrome', version: major}];
  return {
    // Chrome freezes the legacy Android OS/model and minor browser versions.
    // The actual phone profile is supplied through UA Client Hints instead.
    userAgent: `Mozilla/5.0 (${mobile ? 'Linux; Android 10; K' : 'X11; Linux x86_64'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0${mobile ? ' Mobile' : ''} Safari/537.36`,
    platform: mobile ? 'Linux armv8l' : 'Linux x86_64',
    userAgentMetadata: {
      brands,
      fullVersionList: brands.map(item => ({brand: item.brand, version: item.brand === 'Not_A Brand' ? '99.0.0.0' : version})), fullVersion: version,
      platform: mobile ? 'Android' : 'Linux', platformVersion: mobile ? androidIdentity.platformVersion : '',
      architecture: mobile ? 'arm' : 'x86', model: mobile ? androidIdentity.model : '',
      mobile, bitness: '64', wow64: false, formFactors: [mobile ? 'Mobile' : 'Desktop'],
    },
  };
}

export function browserRequestHeaders(device, version, headers = {}) {
  const identity = browserIdentity(device, version), hints = identity.userAgentMetadata;
  const brands = values => values.map(item => `"${item.brand}";v="${item.version}"`).join(', ');
  const result = {...headers,
    'user-agent': identity.userAgent,
    'sec-ch-ua': brands(hints.brands),
    'sec-ch-ua-mobile': hints.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': JSON.stringify(hints.platform),
  };
  // Correct requested high-entropy hints on a popup's already-created first
  // request. Do not send additional hints to sites that did not request them.
  const high = {
    'sec-ch-ua-model': JSON.stringify(hints.model),
    'sec-ch-ua-platform-version': JSON.stringify(hints.platformVersion),
    'sec-ch-ua-arch': JSON.stringify(hints.architecture),
    'sec-ch-ua-bitness': JSON.stringify(hints.bitness),
    'sec-ch-ua-full-version': JSON.stringify(hints.fullVersion),
    'sec-ch-ua-full-version-list': brands(hints.fullVersionList),
    'sec-ch-ua-wow64': hints.wow64 ? '?1' : '?0',
    'sec-ch-ua-form-factors': hints.formFactors.map(value => JSON.stringify(value)).join(', '),
  };
  for (const [name, value] of Object.entries(high)) if (name in headers) result[name] = value;
  return result;
}

export async function setBrowserDeviceHeaders(context, device, version) {
  // Popup navigation can begin before Playwright emits its page object. Keep
  // the context's request identity current for that very first request too;
  // adoption then applies the matching DOM/metrics/touch overrides.
  await context.setExtraHTTPHeaders(browserRequestHeaders(device, version));
}

// Playwright exposes a popup after its first response has started. Pause new
// page targets before scripts run, then let the navigation route configure
// their native identity after Playwright has applied its context defaults.
export async function browserIdentityGuard(browser, identity) {
  const root = await browser.newBrowserCDPSession();
  const {targetInfo} = await root.send('Target.getTargetInfo');
  // A nested browser session transports flattened child-target commands over
  // the existing private Playwright connection; no CDP port is opened.
  const {sessionId: bridge} = await root.send('Target.attachToTarget', {targetId: targetInfo.targetId, flatten: false});
  const pages = new Map(), pending = new Map();
  let sequence = 0;
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Browser identity configuration timed out')); }, 5000);
    timer.unref(); pending.set(id, {resolve, reject, timer});
    root.send('Target.sendMessageToTarget', {sessionId: bridge, message: JSON.stringify({id, method, params, sessionId})}).catch(error => {
      pending.delete(id); clearTimeout(timer); reject(error);
    });
  });
  const prepare = target => {
    target.ready ||= (async () => {
      try {
        await send('Emulation.setUserAgentOverride', identity(), target.sessionId);
        await send('Runtime.runIfWaitingForDebugger', {}, target.sessionId);
      } catch (error) {
        await root.send('Target.closeTarget', {targetId: target.id}).catch(() => {});
        throw error;
      } finally { clearTimeout(target.timer); }
    })();
    return target.ready;
  };
  root.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== bridge) return;
    const response = JSON.parse(event.message);
    if (response.id) {
      const waiter = pending.get(response.id);
      if (!waiter) return;
      pending.delete(response.id); clearTimeout(waiter.timer);
      if (response.error) waiter.reject(new Error('Browser identity configuration failed'));
      else waiter.resolve(response.result);
    } else if (response.method === 'Target.attachedToTarget') {
      const {sessionId, targetInfo, waitingForDebugger} = response.params;
      const target = {id: targetInfo.targetId, sessionId};
      pages.set(target.id, target);
      if (!targetInfo.openerId || !waitingForDebugger) {
        // Explicit newPage/blank pages are configured by adoptPage before use.
        void send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      } else {
        // Network popups are prepared by the first navigation route; blank
        // popups are prepared when adopted. Never leave an orphan paused.
        target.timer = setTimeout(() => { void prepare(target).catch(() => {}); }, 5000);
        target.timer.unref();
      }
    } else if (response.method === 'Target.detachedFromTarget') {
      const target = pages.get(response.params.targetId);
      if (target) clearTimeout(target.timer);
      pages.delete(response.params.targetId);
    }
  });
  browser.on('disconnected', () => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Browser closed')); }
    pending.clear();
    for (const target of pages.values()) clearTimeout(target.timer);
    pages.clear();
  });
  await send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{type: 'page'}]});
  const guard = async () => {
    await Promise.all([...pages.values()].filter(target => target.timer).map(prepare));
  };
  guard.adopt = async pageSession => {
    const {targetInfo} = await pageSession.send('Target.getTargetInfo');
    const target = pages.get(targetInfo.targetId);
    if (target) await prepare(target);
  };
  return guard;
}

// Keep the existing BrowserContext, profile, tabs and downloads. CDP changes
// the actual browser emulation; no page-side navigator monkey-patching.
export async function applyBrowserDevice(context, tab, device, version) {
  tab.emulation ||= await context.newCDPSession(tab.page);
  await tab.page.setViewportSize({width: device.width, height: device.height});
  await tab.emulation.send('Emulation.setDeviceMetricsOverride', {
    width: device.width, height: device.height, screenWidth: device.width, screenHeight: device.height,
    mobile: device.mobile, deviceScaleFactor: 1,
    screenOrientation: device.width > device.height ? {angle: 90, type: 'landscapePrimary'} : {angle: 0, type: 'portraitPrimary'},
  });
  await tab.emulation.send('Emulation.setTouchEmulationEnabled', {enabled: device.touch, maxTouchPoints: device.touch ? 5 : 1});
  await tab.emulation.send('Emulation.setUserAgentOverride', browserIdentity(device, version));
}
