// PAN Database — SQLCipher encrypted (better-sqlite3-multiple-ciphers)
//
// Every write goes directly to disk. No in-memory buffer.
// No data loss on crash or service restart.
// Database is encrypted at rest using SQLCipher (AES-256-CBC).

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3-multiple-ciphers');
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, realpathSync, copyFileSync, renameSync, unlinkSync, openSync, readSync, closeSync } from 'fs';
import { join, dirname, sep } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');

// Database lives OUTSIDE OneDrive to prevent SQLite WAL corruption from cloud sync.
// Dev server sets PAN_DATA_DIR to a separate directory for full isolation.
import { getDataDir } from './platform.js';
const DATA_DIR = getDataDir();
const DB_PATH = join(DATA_DIR, 'pan.db');
const KEY_PATH = join(DATA_DIR, 'pan.key');

// Legacy path — migrate if old DB exists and new one doesn't
const LEGACY_DATA_DIR = join(__dirname, '..', 'data');
const LEGACY_DB_PATH = join(LEGACY_DATA_DIR, 'pan.db');

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// Auto-migrate from legacy OneDrive path to local path
if (existsSync(LEGACY_DB_PATH) && !existsSync(DB_PATH)) {
  console.log(`[PAN DB] Migrating database from OneDrive to local: ${DB_PATH}`);
  copyFileSync(LEGACY_DB_PATH, DB_PATH);
  if (existsSync(LEGACY_DB_PATH + '-wal')) copyFileSync(LEGACY_DB_PATH + '-wal', DB_PATH + '-wal');
  if (existsSync(LEGACY_DB_PATH + '-shm')) copyFileSync(LEGACY_DB_PATH + '-shm', DB_PATH + '-shm');
  try { renameSync(LEGACY_DB_PATH, LEGACY_DB_PATH + '.migrated'); } catch {}
  console.log(`[PAN DB] Migration complete. Old DB renamed to pan.db.migrated`);
}

// --- Encryption key management ---
function getOrCreateKey() {
  if (existsSync(KEY_PATH)) {
    return readFileSync(KEY_PATH, 'utf-8').trim();
  }
  const key = randomBytes(32).toString('hex');
  writeFileSync(KEY_PATH, key, { mode: 0o600 });
  console.log(`[PAN DB] Generated new encryption key: ${KEY_PATH}`);
  return key;
}

const DB_KEY = getOrCreateKey();

// --- Detect if existing DB is plaintext (needs encryption migration) ---
function isPlaintextSqlite(dbPath) {
  if (!existsSync(dbPath)) return false;
  try {
    const header = Buffer.alloc(16);
    const fd = openSync(dbPath, 'r');
    readSync(fd, header, 0, 16, 0);
    closeSync(fd);
    return header.toString('utf-8', 0, 15) === 'SQLite format 3';
  } catch { return false; }
}

// --- Migrate plaintext DB to encrypted ---
function migrateToEncrypted() {
  const BACKUP_PATH = DB_PATH + '.plaintext.bak';
  console.log(`[PAN DB] Encrypting existing plaintext database...`);
  console.log(`[PAN DB] Backup saved to: ${BACKUP_PATH}`);
  copyFileSync(DB_PATH, BACKUP_PATH);
  // Also backup WAL/SHM
  if (existsSync(DB_PATH + '-wal')) copyFileSync(DB_PATH + '-wal', BACKUP_PATH + '-wal');
  if (existsSync(DB_PATH + '-shm')) copyFileSync(DB_PATH + '-shm', BACKUP_PATH + '-shm');

  const ENCRYPTED_PATH = DB_PATH + '.encrypted';

  // Open plaintext DB, export to encrypted
  const plainDb = new Database(DB_PATH);
  plainDb.pragma('journal_mode = DELETE'); // Checkpoint WAL before export

  // Create encrypted DB using sqlcipher_export
  const encDb = new Database(ENCRYPTED_PATH);
  encDb.pragma("cipher = 'sqlcipher'");
  encDb.pragma(`key = '${DB_KEY}'`);
  encDb.pragma('foreign_keys = OFF');

  // Dump all data from plain → encrypted
  const tables = plainDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL").all();
  const indexes = plainDb.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all();
  const triggers = plainDb.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL").all();
  const views = plainDb.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND sql IS NOT NULL").all();

  // Create schema in encrypted DB
  for (const { sql } of tables) {
    try { encDb.exec(sql); } catch {}
  }
  for (const { sql } of indexes) {
    try { encDb.exec(sql); } catch {}
  }
  for (const { sql } of triggers) {
    try { encDb.exec(sql); } catch {}
  }
  for (const { sql } of views) {
    try { encDb.exec(sql); } catch {}
  }

  // Copy data table by table (skip FTS shadow tables — they auto-populate)
  const ftsSkip = new Set();
  const tableNames = plainDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tableNames) {
    if (name.match(/_data$|_idx$|_docsize$|_config$/) && tableNames.some(t => t.name === name.replace(/_(data|idx|docsize|config)$/, ''))) {
      ftsSkip.add(name);
    }
  }
  for (const { name } of tableNames) {
    if (ftsSkip.has(name)) { console.log(`[PAN DB] Skipped FTS shadow table "${name}"`); continue; }
    const rows = plainDb.prepare(`SELECT * FROM "${name}"`).all();
    if (rows.length === 0) continue;
    const cols = Object.keys(rows[0]);
    const placeholders = cols.map(() => '?').join(', ');
    const insertStmt = encDb.prepare(`INSERT OR IGNORE INTO "${name}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`);
    const insertMany = encDb.transaction((rows) => {
      for (const row of rows) {
        insertStmt.run(...cols.map(c => row[c]));
      }
    });
    insertMany(rows);
    console.log(`[PAN DB] Migrated table "${name}": ${rows.length} rows`);
  }

  plainDb.close();
  encDb.close();

  // Swap files
  renameSync(DB_PATH, DB_PATH + '.pre-encrypt');
  renameSync(ENCRYPTED_PATH, DB_PATH);
  // Clean up WAL/SHM from old plaintext DB
  try { unlinkSync(DB_PATH + '.pre-encrypt-wal'); } catch {}
  try { unlinkSync(DB_PATH + '.pre-encrypt-shm'); } catch {}
  try { unlinkSync(DB_PATH + '-wal'); } catch {}
  try { unlinkSync(DB_PATH + '-shm'); } catch {}

  console.log(`[PAN DB] Encryption migration complete!`);
  console.log(`[PAN DB] Plaintext backup: ${BACKUP_PATH}`);
}

// Run migration if DB exists and is plaintext
if (isPlaintextSqlite(DB_PATH)) {
  migrateToEncrypted();
}

// Open encrypted database
const db = new Database(DB_PATH);
db.pragma("cipher = 'sqlcipher'");
db.pragma(`key = '${DB_KEY}'`);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = OFF');

// WAL TUNING (attempted 2026-05-29, reverted same day).
//
// First attempt: set wal_autocheckpoint=0 + journal_size_limit=16MB + one-shot
// TRUNCATE checkpoint at boot. Result: things got WORSE — Craft event loop
// fully wedged after the swap. wal_autocheckpoint=0 means the WAL can grow
// indefinitely, and a one-shot TRUNCATE at boot can stall if any concurrent
// reader is active (schema migrations run reads immediately on connect).
//
// Reverted to default SQLite WAL behavior. The 72MB WAL + recurring 200s
// blocks remain open issues for a future, more careful pass. The right fix
// is likely to (a) move heavy reads to a SQLite worker thread, or (b) split
// the events table into a separate database that can be checkpointed
// independently. Both are multi-day refactors; left for #61 / future.

// Pre-schema migrations: add columns that the schema now references but old DBs lack.
// Must run BEFORE db.exec(schema) so index creation doesn't fail on missing columns.
{
  const preMig = [
    // #465: source + device_id added to ai_usage; schema now creates an index on source
    ['ai_usage',        'source',    "TEXT DEFAULT 'internal'"],
    ['ai_usage',        'device_id', 'TEXT'],
    // #471: per-call latency_ms — powers the "PAN's Mind" panel's response-time
    // badges (mirrors the phone PanThinkingCard's "↳ X.Xs" display).
    ['ai_usage',        'latency_ms', 'INTEGER'],
    // source column added to sessions, device_logs, activity_events
    ['sessions',        'source',    'TEXT'],
    ['device_logs',     'source',    "TEXT NOT NULL DEFAULT 'console'"],
    ['activity_events', 'source',    "TEXT DEFAULT 'desktop'"],
  ];
  for (const [table, col, def] of preMig) {
    const cols = db.pragma(`table_info(${table})`).map(c => c.name);
    if (cols.length > 0 && !cols.includes(col)) {
      db.exec(`ALTER TABLE "${table}" ADD COLUMN ${col} ${def}`);
      console.log(`[PAN DB] Pre-schema migration: added ${table}.${col}`);
    }
  }
}

// Run schema (CREATE IF NOT EXISTS — safe to run every startup)
const schema = readFileSync(SCHEMA_PATH, 'utf-8');
db.exec(schema);

// Migration: fix settings table if it was created by old dashboard.js (missing id, updated_at)
const settingsCols = db.pragma('table_info(settings)').map(c => c.name);
if (!settingsCols.includes('id')) {
  console.log('[PAN DB] Migrating settings table to full schema...');
  db.exec(`
    ALTER TABLE settings RENAME TO _settings_old;
    CREATE TABLE settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    INSERT INTO settings (key, value) SELECT key, value FROM _settings_old;
    DROP TABLE _settings_old;
  `);
  console.log('[PAN DB] Settings table migrated.');
}

// Migration: add policy columns to device_sensors if missing
const dsCols = db.pragma('table_info(device_sensors)').map(c => c.name);
if (dsCols.length > 0 && !dsCols.includes('policy')) {
  console.log('[PAN DB] Adding policy columns to device_sensors...');
  db.exec(`ALTER TABLE device_sensors ADD COLUMN policy TEXT`);
  db.exec(`ALTER TABLE device_sensors ADD COLUMN policy_reason TEXT`);
  console.log('[PAN DB] device_sensors policy columns added.');
}

// Migration: add tailscale_hostname to devices if missing
const devCols = db.pragma('table_info(devices)').map(c => c.name);
if (devCols.length > 0 && !devCols.includes('tailscale_hostname')) {
  console.log('[PAN DB] Adding tailscale_hostname to devices...');
  db.exec(`ALTER TABLE devices ADD COLUMN tailscale_hostname TEXT`);
}

// Migration: Tier 0 org foundation — add org_id columns to existing tables
// This runs the same logic as migrations/tier0-org-foundation.js but inline on startup,
// so the migration is automatic (no manual CLI step required).
const ORG_ID_TARGETS = [
  ['roles', null], ['api_tokens', null], ['devices', 'org_personal'],
  ['events', 'org_personal'], ['memory_items', 'org_personal'], ['sessions', 'org_personal'],
  ['command_queue', 'org_personal'], ['command_logs', 'org_personal'], ['ai_usage', 'org_personal'],
  ['client_logs', 'org_personal'], ['device_sensors', 'org_personal'], ['sensor_attachments', 'org_personal'],
  ['episodic_memories', 'org_personal'], ['procedural_memories', 'org_personal'],
  ['semantic_facts', 'org_personal'], ['evolution_versions', 'org_personal'],
  ['projects', 'org_personal'], ['project_milestones', 'org_personal'],
  ['project_sections', 'org_personal'], ['project_tasks', 'org_personal'],
  ['section_items', 'org_personal'], ['open_tabs', 'org_personal'],
  ['settings', null],
];
{
  let orgMigrated = 0;
  for (const [table, defaultVal] of ORG_ID_TARGETS) {
    const cols = db.pragma(`table_info(${table})`).map(c => c.name);
    if (cols.length > 0 && !cols.includes('org_id')) {
      const notNull = defaultVal ? ' NOT NULL' : '';
      const defClause = defaultVal ? ` DEFAULT '${defaultVal}'` : '';
      db.exec(`ALTER TABLE "${table}" ADD COLUMN org_id TEXT${notNull}${defClause}`);
      orgMigrated++;
    }
  }
  // Also add users columns if missing
  const userCols = db.pragma('table_info(users)').map(c => c.name);
  if (userCols.length > 0 && !userCols.includes('power_lvl')) {
    // Migration: rename trust_level → power_lvl (or add fresh if neither exists)
    if (userCols.includes('trust_level')) {
      console.log('[PAN DB] Renaming trust_level → power_lvl on users...');
      db.exec(`ALTER TABLE users RENAME COLUMN trust_level TO power_lvl`);
    } else {
      console.log('[PAN DB] Adding power_lvl column to users...');
      db.exec(`ALTER TABLE users ADD COLUMN power_lvl INTEGER`);
    }
    db.exec(`UPDATE users SET power_lvl = 100 WHERE role = 'owner' AND power_lvl IS NULL`);
  }
  if (userCols.length > 0 && !userCols.includes('display_nickname')) {
    db.exec(`ALTER TABLE users ADD COLUMN display_nickname TEXT`);
  }
  if (userCols.length > 0 && !userCols.includes('last_active_org_id')) {
    db.exec(`ALTER TABLE users ADD COLUMN last_active_org_id TEXT DEFAULT 'org_personal'`);
    db.exec(`UPDATE users SET last_active_org_id = 'org_personal' WHERE last_active_org_id IS NULL`);
  }
  // Ensure default user has a membership in org_personal
  const hasOrgs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='orgs'").get();
  if (hasOrgs) {
    const ownerRole = db.prepare(`SELECT id FROM roles WHERE name = 'owner'`).get();
    const membership = db.prepare(`SELECT id, role_id FROM memberships WHERE user_id = 1 AND org_id = 'org_personal'`).get();
    if (!membership) {
      db.prepare(`INSERT OR IGNORE INTO memberships (user_id, org_id, role_id) VALUES (1, 'org_personal', ?)`).run(ownerRole?.id || null);
    } else if (!membership.role_id && ownerRole) {
      // Fix existing memberships that were created without a role
      db.prepare(`UPDATE memberships SET role_id = ? WHERE id = ?`).run(ownerRole.id, membership.id);
    }
  }
  if (orgMigrated > 0) console.log(`[PAN DB] Added org_id column to ${orgMigrated} tables`);

  // Migration: add org_id to alerts table (queries expect it but original schema omitted it)
  const alertCols = db.pragma('table_info(alerts)').map(c => c.name);
  if (alertCols.length > 0 && !alertCols.includes('org_id')) {
    console.log('[PAN DB] Adding org_id column to alerts...');
    db.exec(`ALTER TABLE alerts ADD COLUMN org_id TEXT DEFAULT 'org_personal'`);
    db.exec(`UPDATE alerts SET org_id = 'org_personal' WHERE org_id IS NULL`);
  }
}

// Migration: add type column to project_tasks (task, bug, feature, etc.)
{
  const taskCols = db.pragma('table_info(project_tasks)').map(c => c.name);
  if (taskCols.length > 0 && !taskCols.includes('type')) {
    db.exec(`ALTER TABLE project_tasks ADD COLUMN type TEXT NOT NULL DEFAULT 'task'`);
    console.log('[PAN DB] Added type column to project_tasks');
  }
}

// project_tasks.status — valid values:
//   todo | in_progress | in_test | done | backlog | cancelled
// SQLite has no CHECK constraint here; enforcement is in the application layer.
// in_test = task is complete but awaiting test pass before closing.

// Migration: add security/privacy columns to events table
// These 6 fields power the Guardian → Sensitivity → Routing pipeline
{
  const evCols = db.pragma('table_info(events)').map(c => c.name);
  const securityCols = [
    ['trust_origin',    "TEXT NOT NULL DEFAULT 'self'"],       // self, org_member, contact, external, public
    ['source_device',   "TEXT"],                                // phone, desktop, pendant, zrok, email, system
    ['sensitivity',     "INTEGER NOT NULL DEFAULT 0"],          // 0=public, 1=internal, 2=sensitive, 3=critical
    ['guardian_status',  "TEXT NOT NULL DEFAULT 'clean'"],      // clean, flagged, blocked
    ['sender_id',       "TEXT"],                                // user_id, contact_id, email addr, null for self
    ['context_safe',    "INTEGER NOT NULL DEFAULT 1"],          // 1=Claude can read, 0=quarantined
  ];
  let secMigrated = 0;
  for (const [col, def] of securityCols) {
    if (evCols.length > 0 && !evCols.includes(col)) {
      db.exec(`ALTER TABLE events ADD COLUMN ${col} ${def}`);
      secMigrated++;
    }
  }
  if (secMigrated > 0) {
    console.log(`[PAN DB] Added ${secMigrated} security columns to events table`);
    // Backfill: all existing events are from self/system, so defaults are correct
  }
}

// Migration: add user_id columns to existing tables for multi-user support
const tablesToAddUserId = ['devices', 'sessions', 'events', 'command_queue', 'memory_items'];
for (const table of tablesToAddUserId) {
  const cols = db.pragma(`table_info(${table})`).map(c => c.name);
  if (cols.length > 0 && !cols.includes('user_id')) {
    console.log(`[PAN DB] Adding user_id column to ${table}...`);
    db.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER REFERENCES users(id)`);
  }
}

// Auto-create default user (id=1) for backwards compatibility
// When auth_mode=none, all requests use this user
const defaultUser = db.prepare('SELECT * FROM users WHERE id = 1').get();
if (!defaultUser) {
  console.log('[PAN DB] Creating default owner user...');
  db.prepare(`INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@localhost', 'Owner', 'owner')`).run();
  // Assign all existing data to the default user
  for (const table of tablesToAddUserId) {
    db.prepare(`UPDATE ${table} SET user_id = 1 WHERE user_id IS NULL`).run();
  }
  console.log('[PAN DB] Default owner user created, existing data assigned.');
}

// Migration: merge duplicate user #2 into owner user #1 (created by OAuth testing)
{
  const user2 = db.prepare('SELECT * FROM users WHERE id = 2').get();
  if (user2) {
    console.log(`[PAN DB] Merging user #2 "${user2.display_name}" into owner...`);
    // Reassign all data from user 2 → user 1
    for (const table of tablesToAddUserId) {
      try { db.prepare(`UPDATE ${table} SET user_id = 1 WHERE user_id = 2`).run(); } catch {}
    }
    // Clean up OAuth links and memberships
    try { db.prepare('DELETE FROM user_oauth WHERE user_id = 2').run(); } catch {}
    try { db.prepare('DELETE FROM memberships WHERE user_id = 2').run(); } catch {}
    try { db.prepare('DELETE FROM api_tokens WHERE user_id = 2').run(); } catch {}
    db.prepare('DELETE FROM users WHERE id = 2').run();
    console.log('[PAN DB] User #2 merged and deleted.');
  }
}

// Migration: set default user display_name to actual OS username instead of generic "Owner"
{
  const user1 = db.prepare('SELECT display_name FROM users WHERE id = 1').get();
  if (user1 && user1.display_name === 'Owner') {
    const osUser = process.env.USERNAME || process.env.USER || 'Owner';
    // Capitalize first letter
    const displayName = osUser.charAt(0).toUpperCase() + osUser.slice(1);
    db.prepare('UPDATE users SET display_name = ?, email = ? WHERE id = 1').run(displayName, `${osUser}@localhost`);
    console.log(`[PAN DB] Updated default user to "${displayName}"`);
  }
}

// Migration: add team_id to projects and project_tasks, add assigned_to to project_tasks
{
  const projCols = db.pragma('table_info(projects)').map(c => c.name);
  if (projCols.length > 0 && !projCols.includes('team_id')) {
    console.log('[PAN DB] Adding team_id to projects...');
    db.exec(`ALTER TABLE projects ADD COLUMN team_id INTEGER`);
  }
  const taskCols = db.pragma('table_info(project_tasks)').map(c => c.name);
  if (taskCols.length > 0 && !taskCols.includes('team_id')) {
    console.log('[PAN DB] Adding team_id to project_tasks...');
    db.exec(`ALTER TABLE project_tasks ADD COLUMN team_id INTEGER`);
  }
  if (taskCols.length > 0 && !taskCols.includes('assigned_to')) {
    console.log('[PAN DB] Adding assigned_to to project_tasks...');
    db.exec(`ALTER TABLE project_tasks ADD COLUMN assigned_to INTEGER`);
  }
  // Create indexes for new columns (safe to run always)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON project_tasks(assigned_to)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_team ON project_tasks(team_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_team ON projects(team_id)`);

  // Backfill Cerebras cost_cents — previous records were logged at $0 because pricing
  // was hardcoded as free. Recalculate using current best-estimate prices.
  // Prices in cents/token: $0.30/1M input, $0.60/1M output for qwen-3-235b
  const CEREBRAS_PRICING = {
    'cerebras:qwen-3-235b':  { input: 0.000030, output: 0.000060 },
    'cerebras:gpt-oss-120b': { input: 0.000060, output: 0.000060 },
    'cerebras:llama3.1-8b':  { input: 0.000010, output: 0.000010 },
    'cerebras:zai-glm-4.7':  { input: 0.000060, output: 0.000060 },
  };
  const backfillStmt = db.prepare(`UPDATE ai_usage SET cost_cents = ? WHERE model = ? AND cost_cents = 0 AND input_tokens > 0`);
  for (const [model, pricing] of Object.entries(CEREBRAS_PRICING)) {
    // Use a single UPDATE with expression for efficiency
    try {
      const result = db.prepare(
        `UPDATE ai_usage SET cost_cents = (input_tokens * ${pricing.input} + output_tokens * ${pricing.output})
         WHERE model = '${model}' AND cost_cents = 0 AND input_tokens > 0`
      ).run();
      if (result.changes > 0) {
        console.log(`[PAN DB] Backfilled Cerebras costs: ${result.changes} rows for ${model}`);
      }
    } catch {}
  }
}

// Migration: Atlas v2 Step 7 — add verifier metadata columns to ai_benchmark
{
  const bmCols = db.pragma('table_info(ai_benchmark)').map(c => c.name);
  if (bmCols.length > 0) {
    if (!bmCols.includes('verifier_verdict')) {
      db.exec(`ALTER TABLE ai_benchmark ADD COLUMN verifier_verdict TEXT`);
    }
    if (!bmCols.includes('auto_corrected')) {
      db.exec(`ALTER TABLE ai_benchmark ADD COLUMN auto_corrected INTEGER DEFAULT 0`);
    }
    if (!bmCols.includes('correction_attempts')) {
      db.exec(`ALTER TABLE ai_benchmark ADD COLUMN correction_attempts INTEGER DEFAULT 0`);
    }
  }
}

// Migration: #465 — tag ai_usage with source + device_id so phone-vs-internal traffic
// is distinguishable. Without this we can't tell which AI calls came from the user
// vs background services like Scout, Dream, Intuition.
{
  const usageCols = db.pragma('table_info(ai_usage)').map(c => c.name);
  if (usageCols.length > 0) {
    if (!usageCols.includes('source')) {
      db.exec(`ALTER TABLE ai_usage ADD COLUMN source TEXT DEFAULT 'internal'`);
    }
    if (!usageCols.includes('device_id')) {
      db.exec(`ALTER TABLE ai_usage ADD COLUMN device_id TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_usage_source ON ai_usage(source)`);
  }
}

// Convert sql.js style params ({':key': val}) to better-sqlite3 style ({key: val})
function fixParams(params) {
  if (!params || typeof params !== 'object') return {};
  const fixed = {};
  for (const [k, v] of Object.entries(params)) {
    const key = k.startsWith(':') ? k.slice(1) : k;
    fixed[key] = v;
  }
  return fixed;
}

// Query helpers — compatible with existing sql.js style params
function run(sql, params = {}) {
  const stmt = db.prepare(sql);
  return stmt.run(fixParams(params));
}

function get(sql, params = {}) {
  const stmt = db.prepare(sql);
  return stmt.get(fixParams(params)) || null;
}

function all(sql, params = {}) {
  const stmt = db.prepare(sql);
  return stmt.all(fixParams(params));
}

function insert(sql, params = {}) {
  const stmt = db.prepare(sql);
  const result = stmt.run(fixParams(params));
  return result.lastInsertRowid;
}

// save() is now a no-op — better-sqlite3 writes directly to disk
function save() {}

// Project auto-detection (from hooks — registers a cwd as a project)
function detectProject(cwd) {
  const normalized = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  const existing = get(
    "SELECT * FROM projects WHERE path = :path",
    { ':path': normalized }
  );
  if (existing) return existing;

  const parts = normalized.split('/');
  const name = parts[parts.length - 1] || 'unknown';

  const id = insert(
    "INSERT OR IGNORE INTO projects (name, path) VALUES (:name, :path)",
    { ':name': name, ':path': normalized }
  );

  return { id, name, path: normalized };
}

// Scan disk for real projects — .pan files are the source of truth
function syncProjects() {
  const SCAN_ROOTS = [
    join(process.env.USERPROFILE || 'C:\\Users\\user', 'OneDrive', 'Desktop'),
    join(process.env.USERPROFILE || 'C:\\Users\\user', 'Desktop'),
  ];

  const seen = new Map();

  for (const root of SCAN_ROOTS) {
    if (!existsSync(root)) continue;

    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      const entryPath = join(root, entry.name);

      let isDir = false;
      let realPath = entryPath;
      try {
        const stat = statSync(entryPath);
        isDir = stat.isDirectory();
        realPath = realpathSync(entryPath);
      } catch { continue; }

      if (!isDir) continue;

      const panFile = join(entryPath, '.pan');
      if (!existsSync(panFile)) continue;

      let panData = {};
      try { panData = JSON.parse(readFileSync(panFile, 'utf-8')); } catch {}

      const normalizedReal = realPath.replace(/\\/g, '/').replace(/\/$/, '');

      if (!seen.has(normalizedReal)) {
        const name = panData.project_name || entry.name;
        seen.set(normalizedReal, { name, path: normalizedReal, panData });
      }
    }
  }

  // Sync DB
  const existing = all("SELECT * FROM projects");

  for (const p of existing) {
    const pPath = p.path.replace(/\\/g, '/');
    const pWinPath = pPath.replace(/\//g, sep);
    const pathExists = existsSync(pWinPath);
    const hasPanFile = pathExists && existsSync(join(pWinPath, '.pan'));

    if (!pathExists) {
      console.log(`[PAN Sync] Removing dead project: ${p.name} (${p.path})`);
      run("DELETE FROM projects WHERE id = :id", { ':id': p.id });
    } else if (!hasPanFile && !seen.has(pPath)) {
      console.log(`[PAN Sync] Removing non-PAN project: ${p.name} (no .pan file)`);
      run("DELETE FROM projects WHERE id = :id", { ':id': p.id });
    }
  }

  for (const [realPath, proj] of seen) {
    const existingByPath = get("SELECT * FROM projects WHERE path = :path", { ':path': realPath });
    if (existingByPath) {
      if (existingByPath.name !== proj.name) {
        run("UPDATE projects SET name = :name, updated_at = datetime('now','localtime') WHERE id = :id", {
          ':name': proj.name,
          ':id': existingByPath.id
        });
        console.log(`[PAN Sync] Renamed: ${existingByPath.name} -> ${proj.name}`);
      }
    } else {
      insert("INSERT OR IGNORE INTO projects (name, path) VALUES (:name, :path)", {
        ':name': proj.name,
        ':path': realPath
      });
      console.log(`[PAN Sync] Discovered: ${proj.name} (${realPath})`);
    }
  }

  const final = all("SELECT * FROM projects ORDER BY name");
  console.log(`[PAN Sync] ${final.length} projects after sync`);
  return final;
}

// Extract clean searchable text from an event's JSON data
function extractEventText(eventType, dataStr) {
  let data = {};
  try { data = JSON.parse(dataStr); } catch { return null; }

  if (eventType === 'RouterCommand') {
    const q = data.text || '';
    const a = data.result || data.response_text || '';
    if (q || a) return `${q} ${a}`.trim();
  }
  if (eventType === 'UserPromptSubmit') {
    const prompt = data.prompt || '';
    if (prompt.length >= 10 && !prompt.startsWith('{') && !prompt.startsWith('['))
      return prompt;
  }
  if (eventType === 'Stop') {
    const msg = data.last_assistant_message || '';
    if (msg.length >= 20) return msg;
  }
  if (eventType === 'PhoneAudio') {
    const transcript = data.transcript || '';
    const finals = transcript.match(/Final: (.+?)(?:\[|Heard|$)/g)
      ?.map(m => m.replace(/^Final: /, '').replace(/\[.*$/, '').trim())
      .filter(Boolean).join(' ');
    if (finals) return finals;
  }
  if (eventType === 'VisionAnalysis') {
    const desc = data.description || data.result || '';
    if (desc) return desc;
  }
  if (eventType === 'Decision') {
    const parts = [data.decision];
    if (data.rationale) parts.push(data.rationale);
    if (Array.isArray(data.options) && data.options.length) parts.push(`Options: ${data.options.join(', ')}`);
    if (data.domain) parts.push(`Domain: ${data.domain}`);
    return parts.filter(Boolean).join(' — ');
  }
  // Cloud-Claude write-back (Phase 2) — desktop app / Claude.ai / Cowork
  // exchanges logged via pan_log_exchange. Index the conversation text so
  // pan_search finds them exactly like CLI sessions.
  if (eventType === 'CloudExchange') {
    const parts = [];
    if (data.topic) parts.push(`[${data.topic}]`);
    if (data.user_message) parts.push(data.user_message);
    if (data.assistant_message) parts.push(data.assistant_message);
    const text = parts.filter(Boolean).join(' — ');
    if (text) return text;
  }
  return null;
}

// Index an event into FTS5 — called on every insert
function indexEventFTS(eventId, eventType, dataStr) {
  const text = extractEventText(eventType, dataStr);
  if (text) {
    try {
      db.prepare('INSERT INTO events_fts(rowid, content_text) VALUES (?, ?)').run(eventId, text.slice(0, 2000));
    } catch (err) {
      // Ignore duplicates or FTS errors
    }
  }
}

// Backfill FTS index for any events newer than the last indexed ID.
// Only scans new events (not all 67k+) so it's fast even with a large DB.
function backfillFTS() {
  const maxIndexed = db.prepare('SELECT MAX(rowid) as m FROM events_fts').get().m || 0;
  const maxEvent = db.prepare('SELECT MAX(id) as m FROM events').get().m || 0;
  if (maxIndexed >= maxEvent) return; // already up to date

  console.log(`[PAN FTS] Backfilling events after id ${maxIndexed} (up to ${maxEvent})...`);
  // Process in batches of 2000 to avoid loading the entire DB at once
  const BATCH = 2000;
  let cursor = maxIndexed;
  let indexed = 0;
  while (true) {
    const events = db.prepare(
      'SELECT id, event_type, data FROM events WHERE id > ? ORDER BY id LIMIT ?'
    ).all(cursor, BATCH);
    if (events.length === 0) break;
    for (const e of events) {
      const text = extractEventText(e.event_type, e.data);
      if (text) {
        try {
          db.prepare('INSERT OR IGNORE INTO events_fts(rowid, content_text) VALUES (?, ?)').run(e.id, text.slice(0, 2000));
          indexed++;
        } catch {}
      }
      cursor = e.id;
    }
    if (events.length < BATCH) break; // last batch
  }
  if (indexed > 0) console.log(`[PAN FTS] Indexed ${indexed} new events`);
}

// Run backfill after a 6s delay so the server is already listening and
// responding to health checks before any DB writes happen.
// setImmediate fired BEFORE I/O events, which blocked the health-check response
// and caused every Craft swap to fail (carrier timeout → rollback).
// Processing in async batches (setTimeout between each) yields the event loop
// so health checks respond normally even during large backfills.
async function backfillFTSAsync() {
  const maxIndexed = db.prepare('SELECT MAX(rowid) as m FROM events_fts').get().m || 0;
  const maxEvent   = db.prepare('SELECT MAX(id)   as m FROM events').get().m || 0;
  if (maxIndexed >= maxEvent) return;

  console.log(`[PAN FTS] Backfilling events after id ${maxIndexed} (up to ${maxEvent})...`);
  const BATCH = 500;
  let cursor = maxIndexed, indexed = 0;

  while (true) {
    const events = db.prepare(
      'SELECT id, event_type, data FROM events WHERE id > ? ORDER BY id LIMIT ?'
    ).all(cursor, BATCH);
    if (events.length === 0) break;

    for (const e of events) {
      const text = extractEventText(e.event_type, e.data);
      if (text) {
        try {
          db.prepare('INSERT OR IGNORE INTO events_fts(rowid, content_text) VALUES (?, ?)').run(e.id, text.slice(0, 2000));
          indexed++;
        } catch {}
      }
      cursor = e.id;
    }
    if (events.length < BATCH) break;
    // Yield to event loop between batches — keeps health checks responsive
    await new Promise(r => setTimeout(r, 0));
  }
  if (indexed > 0) console.log(`[PAN FTS] Indexed ${indexed} new events`);
}
setTimeout(() => {
  backfillFTSAsync().catch(err => console.error('[PAN FTS] Backfill error:', err.message));
}, 6000);

// --- Centralized event logging ---
// All event inserts should go through this function.
// Handles: insert + FTS indexing. Anonymization is available on export (raw data stays in encrypted DB).
import { anonymize, anonymizeEventData } from './anonymizer.js';
import { NEVER_STORE, NEVER_EMBED } from './event-filters.js';

// --- Incognito state check ---
// Lazy-loaded to avoid circular imports (incognito.js imports from db.js).
// Returns the incognito state object if active, null otherwise.
function _checkIncognito(userId) {
  if (!userId) return null;
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(`incognito_active_${userId}`);
    if (!row) return null;
    const state = JSON.parse(row.value);
    return state.active ? state : null;
  } catch { return null; }
}

function logEvent(sessionId, eventType, data, userId = null, orgId = 'org_personal', security = {}) {
  // Pure telemetry that nothing reads — don't persist it at all (was bloating the DB).
  if (NEVER_STORE.has(eventType)) return null;
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);

  // Security fields with safe defaults
  const trustOrigin   = security.trustOrigin   || 'self';
  const sourceDevice  = security.sourceDevice  || null;
  const sensitivity   = security.sensitivity   ?? 0;
  const guardianStatus = security.guardianStatus || 'clean';
  const senderId      = security.senderId      || null;
  const contextSafe   = security.contextSafe   ?? 1;

  // If incognito is active for this user, route to incognito_events instead
  const incognitoState = _checkIncognito(userId);
  if (incognitoState) {
    const now = Date.now();
    const ttlMs = (incognitoState.ttl_minutes || 60) * 60 * 1000;
    const expiresAt = now + ttlMs;
    const payload = JSON.stringify({ event_type: eventType, data: dataStr, session_id: sessionId });
    const incognitoId = insert(
      `INSERT INTO incognito_events (user_id, payload, created_at, expires_at) VALUES (:uid, :payload, :now, :expires)`,
      { ':uid': userId, ':payload': payload, ':now': now, ':expires': expiresAt }
    );
    // No FTS indexing, no vector embedding — incognito events are ephemeral
    return incognitoId;
  }

  let eventId;
  if (userId) {
    eventId = insert(
      `INSERT INTO events (session_id, event_type, data, user_id, org_id, trust_origin, source_device, sensitivity, guardian_status, sender_id, context_safe)
       VALUES (:sid, :type, :data, :uid, :oid, :trust, :device, :sens, :guardian, :sender, :csafe)`,
      { ':sid': sessionId, ':type': eventType, ':data': dataStr, ':uid': userId, ':oid': orgId,
        ':trust': trustOrigin, ':device': sourceDevice, ':sens': sensitivity, ':guardian': guardianStatus, ':sender': senderId, ':csafe': contextSafe }
    );
  } else {
    eventId = insert(
      `INSERT INTO events (session_id, event_type, data, org_id, trust_origin, source_device, sensitivity, guardian_status, sender_id, context_safe)
       VALUES (:sid, :type, :data, :oid, :trust, :device, :sens, :guardian, :sender, :csafe)`,
      { ':sid': sessionId, ':type': eventType, ':data': dataStr, ':oid': orgId,
        ':trust': trustOrigin, ':device': sourceDevice, ':sens': sensitivity, ':guardian': guardianStatus, ':sender': senderId, ':csafe': contextSafe }
    );
  }
  indexEventFTS(eventId, eventType, dataStr);
  // Hybrid memory search: also queue this event for vector embedding so it
  // becomes semantically searchable. Lazy import to avoid a circular ESM
  // dependency between db.js and memory-search.js (which imports db-registry,
  // which imports db.js). The dynamic import is cached after first call.
  // Skip vectorizing pure telemetry — it's noise in semantic recall and wastes embed time.
  if (!NEVER_EMBED.has(eventType)) {
    import('./memory-search.js').then(m => m.indexEventForSearch('main', eventId)).catch(() => {});
  }
  return eventId;
}

// Log a significant decision — distinct from generic events so the dream cycle
// and search can treat decisions as first-class memory items.
//
//   decision:  short summary of what was decided (required)
//   options:   array of alternatives that were considered (optional)
//   rationale: why this option was chosen (optional)
//   domain:    category string, e.g. 'architecture', 'ai', 'ux' (optional)
//   reversible: true/false — was this easily reversible? (optional)
//
// Usage:
//   logDecision(sessionId, 'Use Super-Carrier instead of bare Carrier', {
//     options: ['nginx', 'Super-Carrier', 'bare Carrier'],
//     rationale: 'Zero-downtime restarts without nginx complexity',
//     domain: 'architecture',
//     reversible: false,
//   });
function logDecision(sessionId, decision, { options = [], rationale = '', domain = 'general', reversible = null } = {}) {
  return logEvent(sessionId, 'Decision', {
    decision,
    options,
    rationale,
    domain,
    reversible,
    decided_at: new Date().toISOString(),
  });
}

// Helper used by extractEventText so scoped writes can produce the same
// FTS5 text content as main writes. Kept here so external scope-aware
// callers (events.js) can reuse it without duplication.
function _extractEventText(eventType, dataStr) {
  return extractEventText(eventType, dataStr);
}

// --- Scoped query helpers ---
// Auto-inject org_id from Express request object. SQL must use :org_id placeholder.
// Example: allScoped(req, "SELECT * FROM events WHERE org_id = :org_id", { ':type': 'foo' })
function allScoped(req, sql, params = {}) {
  return all(sql, { ...params, ':org_id': req?.org_id || 'org_personal' });
}
function getScoped(req, sql, params = {}) {
  return get(sql, { ...params, ':org_id': req?.org_id || 'org_personal' });
}
function runScoped(req, sql, params = {}) {
  return run(sql, { ...params, ':org_id': req?.org_id || 'org_personal' });
}
function insertScoped(req, sql, params = {}) {
  return insert(sql, { ...params, ':org_id': req?.org_id || 'org_personal' });
}

// ── Model Selection Registry ───────────────────────────────────────────────
//
// Single source of truth for "which model do we use for X?".
//
// Every consumer of an LLM (embeddings, intuition, vision, voice routing,
// dream/evolution cycles, etc.) used to hardcode model names as module
// constants. When a provider retired a name (Cerebras dropping
// qwen-3-235b-a22b-instruct-2507) or a device's installed tags changed
// (the the local Ollama box having qwen3-embedding:latest instead of :0.6b), every
// caller broke in a slightly different way and we had to grep + edit.
//
// New design: one table, one helper. Callers ask
//   getModelForPurpose('embedding')
//   getModelForPurpose('chat_local')
//   getModelForPurpose('vision')
//   getModelForPurpose('reasoning_cloud')
//   getModelForPurpose('chat_cloud_fallback')
// and get back { purpose, provider, model, dim, context_window }. Changing
// a model is a one-row UPDATE — no code edit, no Carrier restart.
//
// Provider naming convention is "provider[@device]":
//   'ollama@local'        — Ollama on the same machine as PAN (single-PC setup)
//   'ollama@<hostname>'   — Ollama on another device, e.g. 'ollama@my-mini-pc'
//   'cerebras'            — cloud, no device suffix needed
//   'groq', 'anthropic', 'openai' — same
//
// This naming is what scout.js's findDeviceWithModel + scanDeviceModels keys
// on, so swapping the the local Ollama box for a new machine is just changing the suffix.
try {
  run(`CREATE TABLE IF NOT EXISTS model_selections (
    purpose TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    dim INTEGER,
    context_window INTEGER,
    notes TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  // Seed with the current canonical choices. INSERT OR IGNORE so we never
  // clobber a row the user has explicitly changed via the dashboard.
  const seeds = [
    ['embedding',            'ollama@local', 'qwen3-embedding:0.6b', 1024, null,  'Vector embeddings — must match event_embeddings dim'],
    ['chat_local',           'ollama@local', 'gemma4:e4b',           null, 131072, 'Local chat / intuition / classifier fallback'],
    // Vision + chat_local are BOTH gemma4:e4b as of 2026-08-07. History:
    // moondream (1.7GB) was the original seed and hallucinated literally every
    // screenshot — "circles" on a Godot editor capture, and "blue background
    // with white text 'For more information, click here'" across 100+
    // consecutive screen_context events. minicpm-v (5.5GB) replaced it and was
    // accurate but slow.
    // Benchmarked on the Mini-PC (Ryzen 7 5800H, CPU-only), same photo + prompt:
    //   gemma4:e4b   60s  — read the "OV3660" chip label off a ribbon cable
    //   minicpm-v   140s  — called a clear container "a bowl", missed the label
    //   qwen2.5vl   297s  — accurate, but 5x slower than gemma4
    //   llava-phi3   38s  — hallucinated batteries that aren't in the frame
    // Text-only classification, warm, same prompt:
    //   gemma4:e4b  0.53s — correct answer
    //   qwen3:4b     3.8s — EMPTY output; it spends the whole token budget on
    //                       <think> and never emits an answer at short budgets
    // One model for both purposes also stops the Mini-PC thrashing between a
    // 5.5GB and a 2.5GB model on every alternating call. gemma4 additionally
    // accepts audio (<=30s clips), which nothing in the old stack could do.
    ['vision',               'ollama@local', 'gemma4:e4b',           null, null,  'Screen + webcam + audio understanding'],
    ['reasoning_cloud',      'cerebras',          'qwen-3-235b',          null, null,  'Smart cloud reasoning (substituted by Scout if retired)'],
    ['chat_cloud_fallback',  'anthropic',         'claude-haiku-4-5-20251001', null, null, 'Universal fallback when local + reasoning_cloud both fail'],
  ];
  for (const [purpose, provider, model, dim, ctx, notes] of seeds) {
    run(`INSERT OR IGNORE INTO model_selections (purpose, provider, model, dim, context_window, notes)
         VALUES (:p, :pr, :m, :d, :c, :n)`,
      { ':p': purpose, ':pr': provider, ':m': model, ':d': dim, ':c': ctx, ':n': notes });
  }
  // ── Migration: upgrade moondream → minicpm-v ──
  // INSERT OR IGNORE above skips updating already-inserted rows, so existing
  // installs are stuck on whatever seed shipped originally. The first seed was
  // moondream (small, fast, broken). Force-upgrade any row that still points
  // at moondream and a non-customized provider — but leave anything else the
  // user might have manually selected alone.
  try {
    const cur = get(`SELECT model FROM model_selections WHERE purpose = 'vision'`);
    if (cur && /^(moondream|minicpm-v)/i.test(cur.model || '')) {
      run(`UPDATE model_selections
           SET model = 'gemma4:e4b',
               notes = 'Auto-upgraded to gemma4:e4b — 2.3x faster than minicpm-v and reads fine detail (chip labels) that minicpm-v missed',
               updated_at = datetime('now','localtime')
           WHERE purpose = 'vision'`);
      console.log('[DB] vision model auto-upgraded → gemma4:e4b');
    }
    // qwen3:4b is a reasoning model: at short num_predict budgets it spends the
    // entire budget inside <think> and returns an EMPTY string, which silently
    // breaks classifier/intuition fallback. Move it to gemma4:e4b, which answers
    // the same prompt in ~0.5s.
    const curChat = get(`SELECT model FROM model_selections WHERE purpose = 'chat_local'`);
    if (curChat && /^qwen3:4b/i.test(curChat.model || '')) {
      run(`UPDATE model_selections
           SET model = 'gemma4:e4b', context_window = 131072,
               notes = 'Auto-upgraded from qwen3:4b — qwen3 returned empty output for short classification prompts (<think> consumed the budget)',
               updated_at = datetime('now','localtime')
           WHERE purpose = 'chat_local'`);
      console.log('[DB] chat_local model auto-upgraded: qwen3:4b → gemma4:e4b');
    }
  } catch {}
} catch {}

export function getModelForPurpose(purpose) {
  try {
    const row = get(`SELECT purpose, provider, model, dim, context_window, notes
                     FROM model_selections WHERE purpose = :p`, { ':p': purpose });
    return row || null;
  } catch {
    return null;
  }
}

export function setModelForPurpose(purpose, provider, model, options = {}) {
  try {
    run(`INSERT INTO model_selections (purpose, provider, model, dim, context_window, notes, updated_at)
         VALUES (:p, :pr, :m, :d, :c, :n, datetime('now','localtime'))
         ON CONFLICT(purpose) DO UPDATE SET
           provider = :pr, model = :m, dim = :d, context_window = :c, notes = :n,
           updated_at = datetime('now','localtime')`,
      { ':p': purpose, ':pr': provider, ':m': model,
        ':d': options.dim ?? null, ':c': options.context_window ?? null, ':n': options.notes ?? null });
    return true;
  } catch (e) {
    return false;
  }
}

export function listModelSelections() {
  try { return all(`SELECT * FROM model_selections ORDER BY purpose`); }
  catch { return []; }
}

// ── Ollama URL ─────────────────────────────────────────────────────────────
// Single source of truth for where Ollama lives. We resolve in this order:
//
//   1. PAN_OLLAMA_URL env var          — operator override, highest priority
//   2. ollama_url setting in DB        — user-pinned override from the
//                                        Settings panel
//   3. CONNECTED-CLIENT AUTO-DISCOVERY — find a device that joined via the
//                                        QR-code enrollment + is currently
//                                        heartbeating + reports ollama:up.
//                                        Use its tailscale_ip:11434. IP
//                                        survives reboots because Tailscale
//                                        keeps the same node-IP, and the
//                                        client's WS heartbeat keeps the row
//                                        fresh so the dashboard's "the local Ollama box has
//                                        Ollama" knowledge is never stale.
//   4. localhost:11434 fallback        — single-machine setup
//
// Cached for 30s so the DB lookup doesn't run on every Steward probe + every
// dashboard refresh + every embeddings batch.
let _ollamaUrlCache = { url: null, ts: 0 };
const _OLLAMA_URL_TTL_MS = 30_000;
const OLLAMA_DEFAULT_PORT = 11434;

export function getOllamaUrl() {
  const envUrl = process.env.PAN_OLLAMA_URL;
  if (envUrl) return envUrl.replace(/\/$/, '');

  const now = Date.now();
  if (_ollamaUrlCache.url && (now - _ollamaUrlCache.ts) < _OLLAMA_URL_TTL_MS) {
    return _ollamaUrlCache.url;
  }

  let url = null;

  // (2) Explicit setting wins over auto-discovery — user chose to pin a URL.
  try {
    const row = get("SELECT value FROM settings WHERE key = 'ollama_url'");
    if (row?.value) {
      url = row.value.replace(/\/$/, '');
    }
  } catch {}

  // (3) Auto-discover from devices that EVER reported ollama:up. We don't
  // filter by last_seen because Tailscale node IPs are stable across reboots
  // and offline windows — if the the local Ollama box was enrolled once with Ollama, that
  // IP is the right target whenever it comes back up. Prefer most-recently-
  // seen device so the latest known good host wins. Steward + the embeddings
  // backfill back off naturally if the chosen URL doesn't actually answer.
  if (!url) {
    try {
      const candidates = all(`
        SELECT name, hostname, tailscale_ip, tailscale_hostname, reported_services, last_seen
        FROM devices
        WHERE reported_services IS NOT NULL
        ORDER BY last_seen DESC
      `);
      for (const d of candidates) {
        let svcs = null;
        try { svcs = JSON.parse(d.reported_services); } catch { continue; }
        if (!Array.isArray(svcs)) continue;
        const ollamaSvc = svcs.find(s => s.name === 'ollama' && s.status === 'up');
        if (!ollamaSvc) continue;

        // Prefer the explicit port the client reported, fall back to the default.
        const port = Number(ollamaSvc.port) || OLLAMA_DEFAULT_PORT;
        // Address-column priority:
        //   tailscale_ip       — set by pan-client on register
        //   tailscale_hostname — also populated by enrollment; for most rows
        //                        this actually contains the Tailscale IPv4
        //                        (e.g. "100.72.237.137"), not a hostname.
        //                        Confusingly-named column but it's where the
        //                        usable address lives when tailscale_ip is null.
        //   hostname           — last resort; only useful if MagicDNS resolves it.
        const host = d.tailscale_ip || d.tailscale_hostname || d.hostname;
        if (host) {
          url = `http://${host}:${port}`;
          break;
        }
      }
    } catch {}
  }

  // (4) Final fallback — same-machine Ollama.
  if (!url) url = 'http://localhost:11434';

  _ollamaUrlCache = { url, ts: now };
  return url;
}

// Force-invalidate the URL cache. Callers should fire this when a device
// reconnects (so the next probe picks up the newly-online host) or when
// the user updates the ollama_url setting.
export function invalidateOllamaUrlCache() {
  _ollamaUrlCache = { url: null, ts: 0 };
}

export { db, run, get, all, insert, detectProject, syncProjects, save, DB_PATH, indexEventFTS, logEvent, logDecision, anonymize, anonymizeEventData, _extractEventText, allScoped, getScoped, runScoped, insertScoped };
// Note: getOllamaUrl, invalidateOllamaUrlCache, and getApiKey are exported
// inline above with `export function`.
