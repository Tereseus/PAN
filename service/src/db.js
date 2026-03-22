// PAN Database — better-sqlite3 (direct disk writes, no data loss)
//
// Every write goes directly to disk. No in-memory buffer.
// No data loss on crash or service restart.

import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync, statSync, readdirSync, realpathSync } from 'fs';
import { join, dirname, sep } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'pan.db');
const SCHEMA_PATH = join(__dirname, 'schema.sql');

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// Open database — writes go directly to disk
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // Write-Ahead Logging for better concurrent access
db.pragma('busy_timeout = 5000'); // Wait up to 5s if locked
db.pragma('foreign_keys = OFF'); // Session IDs are free-form, not enforced FK

// Run schema (CREATE IF NOT EXISTS — safe to run every startup)
const schema = readFileSync(SCHEMA_PATH, 'utf-8');
db.exec(schema);

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
        run("UPDATE projects SET name = :name, updated_at = datetime('now') WHERE id = :id", {
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

export { db, run, get, all, insert, detectProject, syncProjects, save, DB_PATH };
