// PAN Database Registry
//
// Holds named SQLCipher database handles. Today only `main` is registered
// (the existing pan.db). The registry is designed for many DBs from day one
// so that incognito mode, per-device isolation, per-org Hub scopes, and
// future multi-tenant features can be added without rewriting any memory
// query — they just call getDb('incognito') / getDb('org-acme') / etc.
//
// Each entry is its own SQLCipher file with its own FTS5 + sqlite-vec
// tables. Total isolation. Drop the file → that scope is gone forever.

import { db as mainDb, DB_PATH as MAIN_DB_PATH } from './db.js';
import { createRequire } from 'module';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3-multiple-ciphers');

const handles = new Map();
// Reuse the main DB's encryption key for sibling scopes — same security
// posture, same disk-protection story. Per-scope keys are a future hardening
// step (each org gets its own).
const MAIN_KEY = (() => {
  try { return readFileSync(join(dirname(MAIN_DB_PATH), 'pan.key'), 'utf-8').trim(); } catch { return null; }
})();
const SCHEMA_PATH = (() => {
  // Schema lives next to db.js — same dir as where db-registry.js sits.
  const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  return join(here, 'schema.sql');
})();

// Register the existing main DB on import. Other scopes are added lazily.
handles.set('main', {
  scope: 'main',
  db: mainDb,
  path: MAIN_DB_PATH,
  ephemeral: false,
  retention: null,
});

/**
 * Open (or create) a sibling SQLCipher database for a non-main scope.
 * The file lives next to pan.db with the scope name in it. Same encryption
 * key as main, same schema, fully isolated content.
 *
 * Returns a freshly-opened, schema-loaded database handle.
 */
function openScopeDb(scope) {
  if (!MAIN_KEY) throw new Error('db-registry: cannot open scope DB without master key');
  const dataDir = dirname(MAIN_DB_PATH);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, `pan.${scope}.db`);
  const db = new Database(path);
  db.pragma("cipher = 'sqlcipher'");
  db.pragma(`key = '${MAIN_KEY}'`);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = OFF');
  // Apply the standard schema so events / events_fts / sessions / etc. exist.
  try {
    const schema = readFileSync(SCHEMA_PATH, 'utf-8');
    db.exec(schema);
  } catch (err) {
    console.warn(`[db-registry] schema load failed for scope "${scope}":`, err.message);
  }
  console.log(`[db-registry] opened scope "${scope}" at ${path}`);
  return { db, path };
}

/**
 * Resolve a scope tag to a SQLCipher database handle, lazily creating one
 * if it doesn't exist yet. 'main' always resolves to the canonical pan.db.
 * Any other scope (incognito, org-acme, phone-foo) gets its own sibling
 * SQLCipher file created on first access.
 */
function getDb(scope = 'main') {
  const tag = scope || 'main';
  let entry = handles.get(tag);
  if (entry) return entry.db;
  if (tag === 'main') throw new Error('db-registry: main DB missing'); // can't happen
  // Lazy-create unknown scopes (incognito and friends).
  const { db, path } = openScopeDb(tag);
  entry = {
    scope: tag,
    db,
    path,
    ephemeral: tag === 'incognito' || tag.startsWith('temp-'),
    retention: null,
  };
  handles.set(tag, entry);
  return db;
}

/**
 * Wipe a scope: close its connection and delete the underlying file (and
 * WAL/SHM siblings). Used when the user toggles incognito off — a true
 * "forget everything" operation. Refuses to wipe `main`.
 */
function wipeScope(scope) {
  if (!scope || scope === 'main') throw new Error('db-registry: refusing to wipe main');
  const entry = handles.get(scope);
  if (entry) {
    try { entry.db.close(); } catch {}
    handles.delete(scope);
    for (const suffix of ['', '-wal', '-shm']) {
      const p = entry.path + suffix;
      try { if (existsSync(p)) unlinkSync(p); } catch (err) { console.warn(`[db-registry] could not unlink ${p}:`, err.message); }
    }
    return { wiped: true, path: entry.path };
  }
  // Not registered — try to delete the file directly so we still honor "wipe"
  // even if the server hasn't touched the scope this boot.
  const dataDir = dirname(MAIN_DB_PATH);
  const path = join(dataDir, `pan.${scope}.db`);
  let removed = false;
  for (const suffix of ['', '-wal', '-shm']) {
    const p = path + suffix;
    try { if (existsSync(p)) { unlinkSync(p); removed = true; } } catch {}
  }
  return { wiped: removed, path };
}

/**
 * List all currently registered scopes (for debugging / Atlas surfacing).
 */
function listScopes() {
  return Array.from(handles.values()).map(e => ({
    scope: e.scope,
    path: e.path,
    ephemeral: e.ephemeral,
    retention: e.retention,
  }));
}

export { getDb, wipeScope, listScopes, handles };
