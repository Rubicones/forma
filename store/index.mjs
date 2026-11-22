// Store driver selector (§2).
// FORMA_STORE=file (default) uses local disk; FORMA_STORE=supabase uses Supabase Postgres + Cloudflare R2;
// FORMA_STORE=memory (test-only, §10) uses the in-memory fake cloud driver.
import {fileStore} from './file.mjs';
import {supabaseStore, authorStorage, currentAuthor} from './supabase.mjs';
import {memoryStore} from './memory.mjs';

function resolveDefaultDriver() {
  const mode = (process.env.FORMA_STORE || 'file').toLowerCase();
  if (mode === 'supabase') return supabaseStore;
  if (mode === 'memory') return memoryStore;
  return fileStore;
}

let currentDriver = resolveDefaultDriver();

export function selectStore(driver) {
  if (typeof driver === 'string') {
    const mode = driver.toLowerCase();
    if (mode === 'supabase') currentDriver = supabaseStore;
    else if (mode === 'memory') currentDriver = memoryStore;
    else currentDriver = fileStore;
  } else {
    currentDriver = driver || resolveDefaultDriver();
  }
  return currentDriver;
}

export {authorStorage, currentAuthor};

export const store = {
  get driver() {
    return currentDriver.driver;
  },
  status: (...args) => currentDriver.status(...args),
  registerProject: (...args) => currentDriver.registerProject?.(...args),
  // Supabase client of the cloud driver; null on the file driver.
  db: () => (currentDriver.db ? currentDriver.db() : null),
  history: {
    open: (...args) => currentDriver.history.open(...args),
    openHistory: (...args) => currentDriver.history.open(...args),
    record: (...args) => currentDriver.history.record(...args),
    update: (...args) => currentDriver.history.update(...args),
    get: (...args) => currentDriver.history.get(...args),
    list: (...args) => currentDriver.history.list(...args),
    thread: (...args) => currentDriver.history.thread(...args),
    findBy: (...args) => currentDriver.history.findBy(...args),
    importExisting: (...args) => currentDriver.history.importExisting(...args),
    splitStyle: (...args) => currentDriver.history.splitStyle(...args),
    creativeMeta: (...args) => currentDriver.history.creativeMeta(...args),
  },
  blobs: {
    put: (...args) => currentDriver.blobs.put(...args),
    get: (...args) => currentDriver.blobs.get(...args),
    head: (...args) => currentDriver.blobs.head(...args),
    list: (...args) => currentDriver.blobs.list(...args),
    url: (...args) => currentDriver.blobs.url?.(...args),
  },
  assets: {
    index: (...args) => currentDriver.assets.index(...args),
    upsert: (...args) => currentDriver.assets.upsert(...args),
    remove: (...args) => currentDriver.assets.remove(...args),
  },
  runs: {
    start: (...args) => currentDriver.runs.start(...args),
    heartbeat: (...args) => currentDriver.runs.heartbeat(...args),
    events: (...args) => currentDriver.runs.events(...args),
    finish: (...args) => currentDriver.runs.finish(...args),
    active: (...args) => currentDriver.runs.active(...args),
    get: (...args) => currentDriver.runs.get(...args),
  },
  sync: {
    down: (...args) => currentDriver.sync.down(...args),
    up: (...args) => currentDriver.sync.up(...args),
  },
};
