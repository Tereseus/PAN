-- Tier 0 — Org Foundation migration (REVISED 2026-04-08 against real schema)
-- See ~/.claude/projects/C--Users-tzuri-Desktop-PAN/memory/project_tier0_org_foundation.md
--
-- This file contains ONLY:
--   - CREATE TABLE IF NOT EXISTS for the new tables
--   - INSERT OR IGNORE backfill rows
--
-- ALTER TABLE statements live in run.js because they need PRAGMA-guarded
-- existence checks (better-sqlite3 has no IF NOT EXISTS on ALTER COLUMN).
-- Keeping ALTERs in JS keeps this SQL file fully idempotent on its own.

-- ============================================================
-- New tables
-- ============================================================

CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  logo_url TEXT,
  color_primary TEXT,
  color_secondary TEXT,
  policy_blackout_allowed INTEGER DEFAULT 1,
  policy_incognito_allowed INTEGER DEFAULT 1,
  policy_sensor_rules TEXT,            -- JSON
  policy_export_rules TEXT,            -- JSON
  policy_data_retention_days INTEGER,  -- NULL = forever
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,            -- FK to existing users.id (INTEGER)
  org_id TEXT NOT NULL,                -- FK to orgs.id
  role_id INTEGER,                     -- FK to existing roles.id (nullable)
  joined_at INTEGER NOT NULL,
  left_at INTEGER,                     -- NULL = active
  permissions_json TEXT,
  UNIQUE(user_id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org ON memberships(org_id);

CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  polygon_geojson TEXT NOT NULL,
  sensor_rules_json TEXT,
  tool_rules_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_zones_org ON zones(org_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  metadata_json TEXT,
  ts INTEGER NOT NULL,
  signature TEXT,
  prev_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_org_ts ON audit_log(org_id, ts);

CREATE TABLE IF NOT EXISTS incognito_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incognito_expires ON incognito_events(expires_at);

CREATE TABLE IF NOT EXISTS sensor_toggles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  org_id TEXT NOT NULL,
  sensor TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  cadence_seconds INTEGER,
  forced_by_org INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, device_id, org_id, sensor)
);

-- ============================================================
-- Backfill
-- ============================================================

INSERT OR IGNORE INTO orgs (id, slug, name, color_primary, created_at)
VALUES ('org_personal', 'personal', 'Personal', '#f5c2e7',
        CAST(strftime('%s','now') AS INTEGER) * 1000);

-- Link every existing user to the personal org.
-- (Both Owner and Tzuridis right now.)
INSERT OR IGNORE INTO memberships (user_id, org_id, joined_at)
SELECT id, 'org_personal', CAST(strftime('%s','now') AS INTEGER) * 1000
FROM users;
