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
  import('./memory-search.js').then(m => m.indexEventForSearch('main', eventId)).catch(() => {});
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

// ── Ollama URL ─────────────────────────────────────────────────────────────
// Single source of truth for where Ollama lives. Defaults to localhost but
// can be pointed at a remote machine (e.g. mini PC over Tailscale) via the
// 'ollama_url' setting in the DB or the PAN_OLLAMA_URL env var.
export function getOllamaUrl() {
  const envUrl = process.env.PAN_OLLAMA_URL;
  if (envUrl) return envUrl.replace(/\/$/, '');
  try {
    const row = get("SELECT value FROM settings WHERE key = 'ollama_url'");
    if (row?.value) return row.value.replace(/\/$/, '');
  } catch {}
  return 'http://localhost:11434';
}

export { db, run, get, all, insert, detectProject, syncProjects, save, DB_PATH, indexEventFTS, logEvent, logDecision, anonymize, anonymizeEventData, _extractEventText, allScoped, getScoped, runScoped, insertScoped };
