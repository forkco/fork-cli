import {Failure} from './errors.js';

// Keys a device released for one agent run: the app browser's master key and,
// during migration, a legacy combined key. They live only in this process'
// memory, for that run, and are zeroed when the run ends or after six hours.
const MAX_AGE = 6 * 60 * 60 * 1000;
const MAX_KEYS = 4096;
const keys = new Map();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function slot(owner, vault, run, id) {
  return [owner.user_id, owner.app_id, vault, run, id].join('|');
}
function drop(name) {
  const entry = keys.get(name);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.key.fill(0);
  keys.delete(name);
}

export function remember(owner, vault, run, id, key) {
  if (!uuid.test(run || '') || key.length !== 32) return;
  const name = slot(owner, vault, run, id);
  drop(name);
  if (keys.size >= MAX_KEYS) drop(keys.keys().next().value);
  const timer = setTimeout(() => drop(name), MAX_AGE);
  timer.unref();
  keys.set(name, {key: Buffer.from(key), user: owner.user_id, run, timer});
}

// Returns a copy the caller owns and must zero.
export function recall(owner, vault, run, id) {
  if (!uuid.test(run || '')) return undefined;
  const entry = keys.get(slot(owner, vault, run, id));
  return entry ? Buffer.from(entry.key) : undefined;
}

export function forgetRun(user, run) {
  if (!uuid.test(user || '') || !uuid.test(run || '')) throw new Failure(400, 'invalid_run', 'Invalid run');
  for (const [name, entry] of keys) if (entry.user === user && entry.run === run) drop(name);
}

export function rememberedKeys() { return keys.size; }
