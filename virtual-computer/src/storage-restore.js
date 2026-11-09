import {playwrightStorageScript} from './vendor/playwright-storage-script.js';

const blank = {status: 200, contentType: 'text/html', body: '<!doctype html><title></title>'};

// Adds one site's saved state to a running browser: cookies directly, and
// localStorage/IndexedDB from a private helper page that loads no network
// content, before any page of that site runs. Origins already open in another
// tab may hold IndexedDB connections, so each origin has a deadline.
export async function restoreState(context, state, helperPage, timeout = 5000) {
  if (state.cookies.length) {
    await context.addCookies(state.cookies.map(({_crHasCrossSiteAncestor, ...cookie}) => cookie));
  }
  const origins = state.origins.filter(origin => origin.localStorage?.length || origin.indexedDB?.length);
  if (!origins.length) return;
  const page = await helperPage();
  try {
    await page.route('**/*', route => route.fulfill(blank));
    for (const origin of origins) {
      await page.goto(origin.origin, {waitUntil: 'domcontentloaded', timeout});
      const restore = `(() => {
        const module = {};
        ${playwrightStorageScript}
        const script = new (module.exports.StorageScript())(false);
        return script.restore(${JSON.stringify(origin)});
      })()`;
      let timer;
      try {
        await Promise.race([page.evaluate(restore), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('restore timeout')), timeout);
        })]);
      } finally { clearTimeout(timer); }
    }
  } finally {
    await page.close().catch(() => {});
  }
}
