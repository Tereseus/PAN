// T1 Foundation schema — device ownership + identity binding + capabilities + aliases.
//
// Tasks unlocked by this migration: T2-T10 (capability poller, identity binding,
// mic arbitration, authority resolver, action routing, prompt routing, alias
// learning, in-flight cancel, dashboard panel).
//
// Idempotent: safe to call on every boot. SQLite ALTER TABLE has no
// IF NOT EXISTS for ADD COLUMN, so we introspect via pragma first.

function columnExists(db, table, column) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some(r => r.name === column);
  } catch {
    return false;
  }
}

function tableExists(db, table) {
  try {
    const row = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`
    ).get(table);
    return !!row;
  } catch {
    return false;
  }
}

function addColumn(db, table, column, def) {
  if (!tableExists(db, table)) return; // table not yet created — caller is wrong
  if (columnExists(db, table, column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    console.log(`[schema/ownership] +${table}.${column}`);
  } catch (e) {
    console.warn(`[schema/ownership] ALTER ${table}.${column} failed: ${e.message}`);
  }
}

export function ensureOwnershipSchema(db) {
  // 1. devices.{owner_user_id, room, display_name}
  addColumn(db, 'devices', 'owner_user_id', 'INTEGER REFERENCES users(id)');
  addColumn(db, 'devices', 'room',          'TEXT');
  addColumn(db, 'devices', 'display_name',  'TEXT');

  // 2. identity_clusters extensions (created in server.js boot block, may not
  //    exist yet on a brand-new DB — only attempt if the table is present).
  //    T3 needs:
  //      - user_id (T1, already)        — bound user id (NULL = pending)
  //      - status                       — 'pending' | 'auto' | 'manual' | 'rejected'
  //      - face_thumbnail_path          — JPEG snapshot for confirm UI
  //      - voice_sample_path            — short audio sample for confirm UI
  //      - last_face_conf, last_voice_conf — 0-1.0 latest match confidences
  //      - last_match_at                — when face+voice last agreed
  if (tableExists(db, 'identity_clusters')) {
    addColumn(db, 'identity_clusters', 'user_id',              'INTEGER REFERENCES users(id)');
    addColumn(db, 'identity_clusters', 'status',               `TEXT DEFAULT 'pending'`);
    addColumn(db, 'identity_clusters', 'face_thumbnail_path',  'TEXT');
    addColumn(db, 'identity_clusters', 'voice_sample_path',    'TEXT');
    addColumn(db, 'identity_clusters', 'last_face_conf',       'REAL');
    addColumn(db, 'identity_clusters', 'last_voice_conf',      'REAL');
    addColumn(db, 'identity_clusters', 'last_match_at',        'TEXT');
  }

  // 3. device_aliases — per-org sub-names ("projector", "the big screen").
  //
  // IMPORTANT: This table predates T1. The existing schema (used by
  // routes/preferences.js) stores device_id as the device HOSTNAME (TEXT),
  // not as a FK to devices.id. We honor that convention so existing alias
  // lookups keep working. T8 (alias learning) and T10 (dashboard panel)
  // must JOIN via `devices.hostname = device_aliases.device_id`.
  //
  // Shape if creating fresh (matches preferences.js expectations):
  //   id, org_id, alias, device_id (hostname), created_at, UNIQUE(org_id, alias)
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT NOT NULL DEFAULT 'org_personal',
      alias TEXT NOT NULL,
      device_id TEXT NOT NULL,                   -- hostname, NOT a numeric FK
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(org_id, alias)
    );
    CREATE INDEX IF NOT EXISTS idx_device_aliases_alias ON device_aliases(alias, org_id);
    CREATE INDEX IF NOT EXISTS idx_device_aliases_device ON device_aliases(device_id);
  `);

  // T8 wants to know which user taught each alias — add idempotently.
  addColumn(db, 'device_aliases', 'added_by_user_id', 'INTEGER REFERENCES users(id)');

  // NOTE: We deliberately do NOT create device_capabilities or device_preferences here.
  //   - Live capabilities go into the existing `devices.capabilities` JSON column,
  //     re-written by the pan-client capability poller (T2) and consumed by
  //     smart-router.js `scoreDevice()` which already reads from there.
  //   - Learned preferences go into the existing `action_preferences` table
  //     (see schema.sql L763), already used by smart-router `learnCorrection()`
  //     and routes/preferences.js. Adding a parallel table was a duplication
  //     mistake in an earlier draft of T1.

  // 4. Backfill: assign all existing devices to user 1 (owner, the seeded owner)
  //    where owner_user_id is NULL. One-shot — re-running is a no-op.
  try {
    const r = db.prepare(
      `UPDATE devices SET owner_user_id = 1 WHERE owner_user_id IS NULL`
    ).run();
    if (r.changes > 0) {
      console.log(`[schema/ownership] backfilled owner_user_id=1 on ${r.changes} device(s)`);
    }
  } catch (e) {
    console.warn(`[schema/ownership] backfill failed: ${e.message}`);
  }

  // 5. Backfill: display_name defaults to name (or hostname) where NULL.
  try {
    db.prepare(
      `UPDATE devices SET display_name = COALESCE(name, hostname) WHERE display_name IS NULL`
    ).run();
  } catch (e) {
    // non-fatal
  }
}
