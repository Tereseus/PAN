// One-off: add the missing index on events(org_id).
//
// Background: schema.sql defines indexes on events.session_id, event_type,
// and created_at — but events.org_id was added later via ALTER TABLE and
// no index was created. Every dashboard/Intuition/Steward query that filters
// by org_id (almost all of them) was doing a full table scan of a 1.6 GB
// events table. That's the source of the recurring 170-220s event-loop
// blocks that survived every other patch in the 2026-05-29 session.
//
// Safe to run while Craft is alive — WAL mode handles concurrent writers,
// and CREATE INDEX IF NOT EXISTS is idempotent.
//
// Usage (from project root):
//   cd service && node src/scripts/add-events-org-index.mjs

import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.LOCALAPPDATA
  ? `${process.env.LOCALAPPDATA}/PAN/data/pan.db`
  : join(process.env.HOME || process.env.USERPROFILE, 'AppData/Local/PAN/data/pan.db');

const DB_KEY_PATH = join(dirname(DB_PATH), '.db-key');
if (!existsSync(DB_KEY_PATH)) {
  console.error(`[add-index] DB key not found at ${DB_KEY_PATH}`);
  process.exit(1);
}
const DB_KEY = readFileSync(DB_KEY_PATH, 'utf-8').trim();

console.log(`[add-index] Opening ${DB_PATH}...`);
const db = new Database(DB_PATH);
db.pragma("cipher = 'sqlcipher'");
db.pragma(`key = '${DB_KEY}'`);
db.pragma('busy_timeout = 30000'); // 30s — give Craft time to release writes

// Show existing indexes first
const existing = db.prepare(`SELECT name, sql FROM sqlite_master
  WHERE type = 'index' AND tbl_name = 'events' AND sql IS NOT NULL`).all();
console.log(`[add-index] Existing events indexes:`);
for (const i of existing) console.log(`  ${i.name}`);

// Verify org_id column actually exists (catches typos / pre-migration DBs)
const cols = db.pragma('table_info(events)').map(c => c.name);
console.log(`[add-index] events columns: ${cols.join(', ')}`);
if (!cols.includes('org_id')) {
  console.error('[add-index] events has no org_id column — abort');
  db.close();
  process.exit(1);
}

const rowCount = db.prepare('SELECT COUNT(*) AS c FROM events').get().c;
console.log(`[add-index] events rows: ${rowCount.toLocaleString()}`);

// The big one: org_id index. Covers all `WHERE org_id = :org_id` queries.
// Composite (org_id, event_type) would help WHERE org_id=X AND event_type=Y
// queries even more — and SQLite uses leftmost-prefix, so it ALSO covers
// queries that filter on org_id alone. Building one composite index instead
// of two saves ~50% of the build time.
console.log(`[add-index] Building idx_events_org_id_type ON events(org_id, event_type)...`);
const t0 = Date.now();
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_org_id_type ON events(org_id, event_type)`);
const t1 = Date.now();
console.log(`[add-index] Built in ${((t1 - t0) / 1000).toFixed(1)}s`);

// Also a composite that supports the common dashboard pattern
//   `WHERE org_id = X ORDER BY created_at DESC`
// without falling back to a sort over a million rows.
console.log(`[add-index] Building idx_events_org_id_created ON events(org_id, created_at DESC)...`);
const t2 = Date.now();
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_org_id_created ON events(org_id, created_at DESC)`);
const t3 = Date.now();
console.log(`[add-index] Built in ${((t3 - t2) / 1000).toFixed(1)}s`);

// Show what's there now
const after = db.prepare(`SELECT name FROM sqlite_master
  WHERE type = 'index' AND tbl_name = 'events' AND sql IS NOT NULL ORDER BY name`).all();
console.log(`[add-index] events indexes after:`);
for (const i of after) console.log(`  ${i.name}`);

db.close();
console.log(`[add-index] Done in ${((Date.now() - t0) / 1000).toFixed(1)}s total.`);
