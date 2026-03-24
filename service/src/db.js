// PAN Database — better-sqlite3 (direct disk writes, no data loss)
//
// Every write goes directly to disk. No in-memory buffer.
// No data loss on crash or service restart.

import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync, statSync, readdirSync, realpathSync, copyFileSync, renameSync } from 'fs';
import { join, dirname, sep } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');

// Database lives OUTSIDE OneDrive to prevent SQLite WAL corruption from cloud sync.
// OneDrive can sync partial WAL files mid-write, destroying data on crash/restart.
// Source code on OneDrive is fine — only the live database needs a local path.
const DATA_DIR = join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || 'C:\\Users\\user', 'AppData', 'Local'), 'PAN', 'data');
const DB_PATH = join(DATA_DIR, 'pan.db');

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
  // Also copy WAL/SHM if they exist
  if (existsSync(LEGACY_DB_PATH + '-wal')) copyFileSync(LEGACY_DB_PATH + '-wal', DB_PATH + '-wal');
  if (existsSync(LEGACY_DB_PATH + '-shm')) copyFileSync(LEGACY_DB_PATH + '-shm', DB_PATH + '-shm');
  // Rename old DB so it doesn't get used accidentally
  try { renameSync(LEGACY_DB_PATH, LEGACY_DB_PATH + '.migrated'); } catch {}
  console.log(`[PAN DB] Migration complete. Old DB renamed to pan.db.migrated`);
}

// Open database — writes go directly to disk
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // Write-Ahead Logging for better concurrent access
db.pragma('busy_timeout = 5000'); // Wait up to 5s if locked
db.pragma('foreign_keys = OFF'); // Session IDs are free-form, not enforced FK

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

export { db, run, get, all, insert, detectProject, syncProjects, save, DB_PATH, indexEventFTS };
