---
name: Tier 0 — Org Foundation (federated multi-tenant substrate)
description: REWRITTEN 2026-04-08 against real PAN schema. Adds org-scoping on top of the existing multi-user + OAuth + devices + roles infrastructure. Federated model — one PAN server per org. Must ship before Carrier.
type: project
---

# Tier 0 — Org Foundation

**Status:** designed 2026-04-08, REWRITTEN against real schema after dry-run discovery. NOT YET BUILT. Awaits explicit "go".
**Blocks:** Carrier, Forge, Crucible, Portal, Guardian, Data Dividends.
**Why first:** retrofitting multi-tenancy into a mature codebase is the most expensive refactor in SaaS. Add the substrate while the surface is small.

## Critical context — what already exists in PAN today

**This is not a greenfield migration.** PAN already has substantial identity infrastructure that the first draft of this doc missed entirely. The dry-run inspection revealed:

### Existing identity tables

| Table | Rows | Notes |
|---|---|---|
| `users` | 2 | INTEGER id. Has `email`, `display_name`, `avatar_url`, `role` (TEXT), `is_active`, `created_at`, `last_login`. Existing rows: id 1 = Owner, id 2 = tzuridis@gmail.com (Ted Tzuridis, Google OAuth). |
| `roles` | 5 | INTEGER id. Has `name`, `level`, `permissions` (JSON), `color`. Existing roles include viewer, user, admin, owner (system roles). |
| `user_oauth` | 1 | Links `user_id` to OAuth providers. Google already wired up. |
| `api_tokens` | 8 | Per-user tokens with `scopes` JSON. Used for dev access. |
| `devices` | 3 | Per-user devices via `user_id` FK. |

### Existing data tables (the 30+ that need org-scoping)

| Table | Rows | Has user_id? | Notes |
|---|---|---|---|
| `events` | 39,769 | yes | The big one. Almost everything funnels through here. |
| `memory_items` | 47,282 | yes | Classifier output. |
| `sessions` | 559 | yes | Terminal/chat sessions. |
| `command_queue` | 266 | yes | Phone commands. |
| `ai_usage` | 562 | no | Per-call cost tracking. |
| `client_logs` | 51 | no | Has device_id, derive via devices. |
| `command_logs` | 1,321 | no | Links to command_queue. |
| `device_sensors` | 38 | no | Links to devices. |
| `episodic_memories` | 39 | no | Has session_id, project_id. |
| `evolution_versions` | 13 | no | Per-config versioning. |
| `open_tabs` | 8 | no | Has session_id, project_id. |
| `orchestrator_actions` | 107 | no | Auto-generated tasks. |
| `procedural_memories` | 23 | no | Learned procedures. |
| `project_milestones` | 27 | no | Has project_id. |
| `project_sections` | 0 | no | Has project_id. |
| `project_tasks` | 295 | no | Has project_id. (Was called `tasks` in v1 doc — wrong.) |
| `projects` | 6 | no | Top-level project table. |
| `resistance_log` | 4 | no | UI automation logs. |
| `resistance_paths` | 18 | no | UI automation paths. |
| `resistance_preferences` | 0 | no | UI automation prefs. |
| `scheduled_jobs` | 1 | no | Per-project cron. |
| `scout_findings` | 194 | no | Tool discoveries. |
| `section_items` | 0 | no | Project section items. |
| `semantic_facts` | 497 | no | Extracted facts. |
| `sensor_attachments` | 0 | no | Links sensors to devices. |
| `settings` | 29 | no | Global key/value config. |

### Tables that stay system-global (no org_id)

| Table | Why |
|---|---|
| `users` | People exist across orgs. Memberships link them. |
| `user_oauth` | OAuth is per-person, not per-org. |
| `sensor_definitions` | Universal sensor types (camera, mic, gps). |
| `events_fts*`, `event_embeddings*` | Internal index tables. |

### Tables on the fence

| Table | Decision |
|---|---|
| `roles` | **Add nullable `org_id`.** NULL = global system role (owner, admin). Non-null = org-defined role (pilot, mechanic). |
| `settings` | **Add nullable `org_id`.** NULL = global server setting. Non-null = per-org override. |
| `api_tokens` | **Add nullable `org_id`.** NULL = token works for any org the user belongs to. Non-null = scoped to one org. |

## Core decisions (locked, unchanged from v1)

### 1. Federated model
One PAN server per org. Different orgs run different PAN instances on different tailnets. Cross-org leak is physically impossible.

### 2. Personal is an org
Every user has an automatic `personal` org. Joining a company adds a second membership. There's no special-case code for "no org" — you always have ≥1.

### 3. Pre-build the big-org case
Replication, failover, audit log signing, 30+ tables ready for sharding.

### 4. Identity is what already exists
**No new users table. No new roles table.** We extend the existing ones.
- `users.email` is the canonical identity (already true)
- `users.display_name` is what the org sees
- A new `users.display_nickname` column is what *you* see in personal mode (org never reads it)
- `users.role` (TEXT) stays for backwards compatibility — it's the system role
- `memberships.role_id` (FK to existing `roles.id`) is the org-scoped role

### 5. Devices = user-owned
Already true. `devices.user_id` exists. We add `devices.org_id` as a *primary affiliation* — which org the device is currently acting for. A device can switch orgs (the active org context).

### 6. Data on org exit
Org keeps everything created during membership. User gets a one-time export. Org policy controls what's exportable. User's personal device retains local copies of sensor data about them.

### 7. Phone top bar
```
nickname@orgname    [⬤ green]
[org logo + colors]   [role: pilot]
```
**No IP shown.** IP is in diagnostics screen only.

### 8. Sensor privacy model — NO blackout mode
Per-sensor toggles (use existing `device_sensors` table — already has `muted`, `policy`, `policy_reason`!). Bulk on/off shortcut. Org-forced sensors via geofence rules. Hard Off button on main page in personal mode only, hidden in org mode.

### 9. Incognito mode
New `incognito_events` table with TTL. PAN reads from `events ∪ incognito_events`. Sync paused for incognito events. Exit review screen.

## Schema migration (REVISED — based on real schema)

### Part A — New tables (no conflicts)

```sql
-- Org identity. This server represents one org (federated).
-- Slug-based TEXT id for readability and URL friendliness.
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,                  -- 'org_personal', 'org_acme'
  slug TEXT UNIQUE NOT NULL,             -- 'personal', 'acme'
  name TEXT NOT NULL,                    -- 'Personal', 'Acme Corporation'
  logo_url TEXT,
  color_primary TEXT,
  color_secondary TEXT,
  policy_blackout_allowed INTEGER DEFAULT 1,
  policy_incognito_allowed INTEGER DEFAULT 1,
  policy_sensor_rules TEXT,              -- JSON
  policy_export_rules TEXT,              -- JSON
  policy_data_retention_days INTEGER,    -- NULL = forever
  created_at INTEGER NOT NULL
);

-- User ↔ org join. user_id is INTEGER (matches existing users.id).
-- role_id references existing roles table.
CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,              -- FK to users.id
  org_id TEXT NOT NULL,                  -- FK to orgs.id
  role_id INTEGER,                       -- FK to existing roles.id (nullable)
  joined_at INTEGER NOT NULL,
  left_at INTEGER,                       -- NULL = active
  permissions_json TEXT,                 -- JSON, per-membership overrides
  UNIQUE(user_id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org ON memberships(org_id);

-- Geofences for org policy enforcement
CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  polygon_geojson TEXT NOT NULL,
  sensor_rules_json TEXT,                -- {camera: 'forced_off'}
  tool_rules_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_zones_org ON zones(org_id);

-- HMAC-chained audit log
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

-- Incognito events with TTL
CREATE TABLE IF NOT EXISTS incognito_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incognito_expires ON incognito_events(expires_at);

-- Per-(user, device, org, sensor) toggle state with cadence
-- Note: device_sensors already exists for per-device-sensor state, but it
-- doesn't carry user_id or org_id. sensor_toggles is the user-facing layer
-- that overrides device_sensors.
CREATE TABLE IF NOT EXISTS sensor_toggles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  org_id TEXT NOT NULL,
  sensor TEXT NOT NULL,                  -- references sensor_definitions.id
  enabled INTEGER NOT NULL,
  cadence_seconds INTEGER,               -- NULL = continuous
  forced_by_org INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, device_id, org_id, sensor)
);
```

### Part B — ALTER existing tables (add columns, never replace)

Add `org_id` (TEXT, default `'org_personal'`) to every org-scoped table. The runner is guarded — checks `PRAGMA table_info` before each ALTER and skips if the column already exists.

```sql
-- Identity tables: extend, don't replace
ALTER TABLE users ADD COLUMN display_nickname TEXT;
ALTER TABLE users ADD COLUMN last_active_org_id TEXT DEFAULT 'org_personal';

ALTER TABLE roles ADD COLUMN org_id TEXT;  -- nullable: NULL = global system role
ALTER TABLE api_tokens ADD COLUMN org_id TEXT;  -- nullable: NULL = any org
ALTER TABLE devices ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';

-- The core data tables — all scoped to org
ALTER TABLE events                ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE memory_items          ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE sessions              ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE command_queue         ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE command_logs          ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE ai_usage              ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE client_logs           ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE device_sensors        ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE sensor_attachments    ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';

-- Memory + intelligence tables
ALTER TABLE episodic_memories     ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE procedural_memories   ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE semantic_facts        ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE evolution_versions    ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';

-- Project tables
ALTER TABLE projects              ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE project_milestones    ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE project_sections      ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE project_tasks         ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE section_items         ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE scheduled_jobs        ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE open_tabs             ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';

-- Automation / discovery tables
ALTER TABLE orchestrator_actions  ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE scout_findings        ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE resistance_log        ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE resistance_paths      ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';
ALTER TABLE resistance_preferences ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_personal';

ALTER TABLE settings              ADD COLUMN org_id TEXT;  -- nullable: NULL = global
```

**Tables intentionally NOT modified** (system-global):
- `users` (extended with new columns, but no org_id — users are people)
- `user_oauth` (OAuth is per-person)
- `sensor_definitions` (universal sensor catalog)
- `events_fts*`, `event_embeddings*` (internal index tables)

### Part C — Backfill

```sql
-- 1. Create the personal org
INSERT OR IGNORE INTO orgs (id, slug, name, color_primary, created_at)
VALUES ('org_personal', 'personal', 'Personal', '#f5c2e7',
        CAST(strftime('%s','now') AS INTEGER) * 1000);

-- 2. Link both existing users to the personal org
INSERT OR IGNORE INTO memberships (user_id, org_id, joined_at)
SELECT id, 'org_personal', CAST(strftime('%s','now') AS INTEGER) * 1000
FROM users;

-- 3. Set last_active_org_id on existing users
UPDATE users SET last_active_org_id = 'org_personal' WHERE last_active_org_id IS NULL;

-- 4. All ALTER TABLE ADD COLUMN ... DEFAULT 'org_personal' statements
--    automatically populate the org_id of every existing row.
```

## Middleware (REVISED — uses real INTEGER user IDs)

```js
// service/src/middleware/org-context.js
import { db } from '../db.js';
import { createHmac, randomBytes } from 'crypto';

// Single-user fallback: assume user_id 1 (Owner) if no auth attached.
// This makes the middleware safe to enable before refactoring every route.
const FALLBACK_USER_ID = 1;
const PERSONAL_ORG_ID = 'org_personal';

export function requireOrg(req, res, next) {
  if (!req.user) req.user = { id: FALLBACK_USER_ID };

  const orgId = req.headers['x-pan-org']
    || req.token?.org_id
    || db.prepare(`SELECT last_active_org_id FROM users WHERE id = ?`)
         .get(req.user.id)?.last_active_org_id
    || PERSONAL_ORG_ID;

  const membership = db.prepare(`
    SELECT * FROM memberships
    WHERE user_id = ? AND org_id = ? AND left_at IS NULL
  `).get(req.user.id, orgId);

  if (!membership) {
    return res.status(403).json({ error: 'not a member of this org', org_id: orgId });
  }

  req.org_id = orgId;
  req.membership = membership;
  next();
}

export function enforcePermission(action) {
  return (req, res, next) => {
    if (!req.membership) {
      return res.status(500).json({ error: 'enforcePermission requires requireOrg first' });
    }

    // Personal org: allowed by default. The user owns it.
    const isPersonal = req.org_id === PERSONAL_ORG_ID;

    let perms = {};
    if (req.membership.role_id) {
      const role = db.prepare(`SELECT permissions FROM roles WHERE id = ?`).get(req.membership.role_id);
      if (role?.permissions) {
        try { perms = JSON.parse(role.permissions); } catch {}
      }
    }
    let overrides = {};
    if (req.membership.permissions_json) {
      try { overrides = JSON.parse(req.membership.permissions_json); } catch {}
    }

    const allowed = overrides[action] ?? perms[action] ?? isPersonal;
    if (!allowed) return res.status(403).json({ error: `permission denied: ${action}` });

    auditLog(req, action, req.body?.target || null);
    next();
  };
}

export function auditLog(req, action, target, metadata = {}) {
  const prev = db.prepare(
    `SELECT signature FROM audit_log WHERE org_id = ? ORDER BY id DESC LIMIT 1`
  ).get(req.org_id);

  const row = {
    org_id: req.org_id,
    user_id: req.user?.id || null,
    action, target,
    metadata_json: JSON.stringify(metadata),
    ts: Date.now(),
    prev_hash: prev?.signature || null,
  };
  const signature = hmac(JSON.stringify(row));

  db.prepare(`
    INSERT INTO audit_log (org_id, user_id, action, target, metadata_json, ts, signature, prev_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.org_id, row.user_id, row.action, row.target, row.metadata_json, row.ts, signature, row.prev_hash);
}
```

**Important:** the middleware uses the existing `roles.permissions` column (TEXT JSON), not a new `permissions_json` column. This matches what's already there.

## Migration runner — what it actually does

Pseudocode for `service/src/migrations/run.js`:

```
1. PRE-FLIGHT
   - Resolve DB path from db.js
   - Check that pan.db exists
   - Check disk space (≥2× DB size)
   - Refuse if pan.db.pre-tier0.bak already exists (don't clobber backup)

2. BACKUP (skipped on --dry)
   - Copy pan.db -> pan.db.pre-tier0.bak
   - Copy -wal and -shm files too

3. SNAPSHOT row counts for ALL tables that will be touched
   - Both ALTER targets and the new tables list

4. APPLY MIGRATION inside a transaction
   - Run new CREATE TABLE statements (idempotent)
   - For each table in ALTER list:
       - Check tableExists() — skip if missing
       - Check columnExists() — skip if column already there
       - Run ALTER TABLE ADD COLUMN
   - Run backfill INSERTs
   - Run UPDATE for users.last_active_org_id

5. VERIFY (rollback if any check fails)
   - Row counts match snapshot exactly (no rows lost)
   - org_personal exists in orgs table
   - Every existing user has a membership row
   - Every org-scoped table now has an org_id column
   - All existing rows in scoped tables have org_id = 'org_personal'

6. REPORT
   - Print before/after row counts
   - Print path to backup
   - Exit 0 on success, exit 1 on failure
```

## Build phases

**Phase 1 — Schema + middleware** (~2 days)
- Revised migration script + runner
- `requireOrg` / `enforcePermission` / `auditLog` middleware
- Tests against the dev DB first
- **No route wiring yet** — middleware exists but isn't used
- Verification: dry-run, then live, then `node -e "..."` smoke tests

**Phase 2 — Route wiring** (~1 day)
- Insert `requireOrg` on every API route under `/api/`
- Verify dashboard still loads
- Verify phone still talks to PAN
- All existing functionality continues to work because everything resolves to `org_personal` for the existing user

**Phase 3 — Sensor toggles + Hard Off** (~1 day)
- `sensor_toggles` table CRUD
- Phone UI for per-sensor toggles + bulk shortcuts
- Hard Off button on main page (personal only) + settings page (always)
- Pendant respects toggles (forwarded from phone)

**Phase 4 — Incognito** (~1 day)
- `incognito_events` table + TTL cleanup job
- Router/Augur/Cerebras read from union
- Phone toggle + exit-review screen

**Phase 5 — Phone top bar + org switcher** (~1 day)
- Top bar component
- Org switcher (long-press)
- Diagnostics screen (where IP lives)

**Phase 6 — Replication + audit chain** (~3 days)
- Litestream or sqlite3_backup_* primary→replica streaming
- Lifeboat heartbeat + failover voting
- Audit log signing + chain verification job

**Phase 7 — Geofencing + zones** (~2 days)
- Zones table + admin UI
- Polygon-in-point resolver
- Forced sensor enforcement at zone boundaries

**Phase 8 — Personal data sync** (~1 day)
- `personal_pan_server_url` field on device config
- Background sync job for personal data slice
- Lockable to null on org-issued devices

**Total: ~12 days** for the full foundation.

## Migration safety properties

1. **Idempotent** — re-running detects existing schema and exits cleanly
2. **Transactional** — partial failures impossible
3. **Backed up** — automatic backup, refuses to overwrite existing backups
4. **Guarded ALTERs** — checks PRAGMA table_info before each ADD COLUMN
5. **Row count verified** — exits with error if any table lost a row
6. **Backfill verified** — exits with error if personal org / membership missing
7. **No route changes** — middleware exists but isn't wired in Phase 1
8. **No PAN restart needed for the migration itself** — PAN can stay running, we run the migration script standalone (but Phase 2 wiring will need a restart)

## Key differences from v1 doc

1. **Don't create new `users` / `roles` tables** — extend the existing ones
2. **30+ tables get org_id**, not 8
3. **user_id is INTEGER**, not TEXT
4. **`memberships.user_id` is INTEGER**, references existing `users.id`
5. **Existing `roles.permissions` column** is reused (was going to be `permissions_json`)
6. **`sensor_toggles` is a new layer** on top of existing `device_sensors` (which has its own `muted` and `policy` columns we should respect)
7. **Backfill links both existing users** (Owner + Tzuridis), not just one
8. **Phase 2 is new** — wiring middleware into routes is its own phase, separated from schema migration so we can verify each step

## Open questions for later (not blocking)

- **Selective Hard Off** — should fall detection / SOS still work after Hard Off? v1 = total.
- **Multi-region sharding** — when does an org need to split? `org_id` is in place if needed.
- **device_sensors vs sensor_toggles overlap** — both store sensor on/off state. Does sensor_toggles override device_sensors, or do we drop device_sensors? Decision: sensor_toggles is user intent, device_sensors is hardware capability + org policy. Both stay. UI reads sensor_toggles, falls back to device_sensors defaults.
- **`role` TEXT column on users vs role_id on memberships** — keep both. `users.role` is the system role (owner, admin) for backwards compat. `memberships.role_id` is the org-scoped role.

## What I will NOT do without explicit "go"
- Touch any existing table
- Run any migration (live; dry-run is OK)
- Restart PAN
- Modify the phone app
- Wire middleware into routes

This doc is the design. Review, request changes, then say "go" and I'll:
1. Rewrite the migration script + middleware against this spec
2. Run a dry-run
3. Show you the dry-run output
4. Wait for "run it live"
5. Run live with backup + verify + rollback safety

## Why the v1 doc was wrong

v1 was written without inspecting the actual database. It assumed PAN was a greenfield single-user system with no auth, no roles, no per-user devices, no Google OAuth. **All of those things actually exist.** The dry-run caught the mismatch before any DB damage. This is exactly why dry-runs exist — and it's the reason every future schema-touching change should start with a `node -e "..."` schema audit, not an assumption about what's there.

**Lesson learned and saved as a procedure memory.** See `feedback_audit_real_schema_first.md`.
