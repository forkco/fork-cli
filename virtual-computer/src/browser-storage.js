import {Failure} from './errors.js';

// Playwright 1.62.1's IndexedDB collector leaves IDBDatabase connections open
// in its utility world. Track only those private collector handles and close
// them after serialization, so site logout/deleteDatabase/version upgrades
// aren't blocked. The website's own JS and database connections are untouched.
const install = `(() => {
  if (globalThis.__forkSnapshotDBs) return;
  const handles = globalThis.__forkSnapshotDBs = new Set();
  const open = indexedDB.open.bind(indexedDB);
  indexedDB.open = (...args) => {
    const request = open(...args);
    request.addEventListener('success', () => handles.add(request.result));
    return request;
  };
})()`;
const cleanup = `(() => {
  for (const db of globalThis.__forkSnapshotDBs || []) db.close();
  globalThis.__forkSnapshotDBs?.clear();
})()`;

export async function browserStorageState(context) {
  const guards = [];
  try {
    for (const page of context.pages?.() || []) {
      if (!/^https?:\/\//.test(page.url()) || page.isClosed()) continue;
      const cdp = await context.newCDPSession(page);
      const guard = {cdp, worlds:[]}; guards.push(guard);
      cdp.on('Runtime.executionContextCreated', ({context:world}) => {
        if (world.name.startsWith('__playwright_utility_world_') && !world.auxData?.isDefault)
          guard.worlds.push(world);
      });
      await cdp.send('Runtime.enable');
      const {frameTree} = await cdp.send('Page.getFrameTree');
      guard.worlds = guard.worlds.filter(world => world.auxData?.frameId === frameTree.frame.id);
      if (!guard.worlds.length) throw new Failure(503,'profile_snapshot_failed','Browser storage collector unavailable');
      for (const world of guard.worlds) {
        const result=await cdp.send('Runtime.evaluate',{expression:install,contextId:world.id});
        if (result.exceptionDetails) throw new Failure(503,'profile_snapshot_failed','Browser storage collector unavailable');
      }
    }
    return await context.storageState({indexedDB:true});
  } finally {
    await Promise.allSettled(guards.map(async ({cdp,worlds}) => {
      try { for (const world of worlds) await cdp.send('Runtime.evaluate',{expression:cleanup,contextId:world.id}); }
      finally { await cdp.detach(); }
    }));
  }
}
