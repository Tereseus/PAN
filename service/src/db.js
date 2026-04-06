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
const DATA_DIR = join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || 'C:\\Users\\user', 'AppData', 'Local'), 'PAN', 'data');
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

// Backfill FTS index from existing events — run once on startup if needed
function backfillFTS() {
  const ftsCount = db.prepare('SELECT COUNT(*) as c FROM events_fts').get().c;
  const eventsCount = db.prepare('SELECT COUNT(*) as c FROM events').get().c;

  if (ftsCount >= eventsCount * 0.8) return; // already mostly indexed

  console.log(`[PAN FTS] Backfilling: ${ftsCount} indexed / ${eventsCount} events`);
  const events = db.prepare('SELECT id, event_type, data FROM events ORDER BY id').all();
  let indexed = 0;
  for (const e of events) {
    const text = extractEventText(e.event_type, e.data);
    if (text) {
      try {
        db.prepare('INSERT OR IGNORE INTO events_fts(rowid, content_text) VALUES (?, ?)').run(e.id, text.slice(0, 2000));
        indexed++;
      } catch {}
    }
  }
  console.log(`[PAN FTS] Indexed ${indexed} events`);
}

// Run backfill on startup
try { backfillFTS(); } catch (err) { console.error('[PAN FTS] Backfill error:', err.message); }

// --- Centralized event logging ---
// All event inserts should go through this function.
// Handles: insert + FTS indexing. Anonymization is available on export (raw data stays in encrypted DB).
import { anonymize, anonymizeEventData } from './anonymizer.js';

function logEvent(sessionId, eventType, data, userId = null) {
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  let eventId;
  if (userId) {
    eventId = insert(
      `INSERT INTO events (session_id, event_type, data, user_id) VALUES (:sid, :type, :data, :uid)`,
      { ':sid': sessionId, ':type': eventType, ':data': dataStr, ':uid': userId }
    );
  } else {
    eventId = insert(
      `INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`,
      { ':sid': sessionId, ':type': eventType, ':data': dataStr }
    );
  }
  indexEventFTS(eventId, eventType, dataStr);
  return eventId;
}

export { db, run, get, all, insert, detectProject, syncProjects, save, DB_PATH, indexEventFTS, logEvent, anonymize, anonymizeEventData };
