// PAN Database — SQLite via sql.js (in-memory with periodic disk flush)
//
// Project discovery: .pan files are the source of truth for what is a "project".
// syncProjects() scans desktop directories for .pan files, resolves symlinks to
// deduplicate (e.g. Game/ -> WoE/ becomes one project), removes dead paths,
// and uses project_name from .pan as the display name.
//
// detectProject() is called passively by hooks when Claude sessions start — it
// registers new cwds. syncProjects() is the active scanner called on service
// startup, every 10 minutes, and before terminal launch.

import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync, realpathSync } from 'fs';
import { sep } from 'path';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'pan.db');
const SCHEMA_PATH = join(__dirname, 'schema.sql');

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize sql.js and load/create database
const SQL = await initSqlJs();

let db;
if (existsSync(DB_PATH)) {
  const buffer = readFileSync(DB_PATH);
  db = new SQL.Database(buffer);
} else {
  db = new SQL.Database();
}

// Run schema
const schema = readFileSync(SCHEMA_PATH, 'utf-8');
db.run(schema);
save();

// Persist to disk
function save() {
  const data = db.export();
  writeFileSync(DB_PATH, Buffer.from(data));
}

// Auto-save every 10 seconds
setInterval(save, 10000);

// Save on exit
process.on('exit', save);
process.on('SIGINT', () => { save(); process.exit(0); });
process.on('SIGTERM', () => { save(); process.exit(0); });

// Query helpers that auto-save after writes
function run(sql, params = {}) {
  db.run(sql, params);
  save();
}

function get(sql, params = {}) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const result = stmt.getAsObject();
    stmt.free();
    return result;
  }
  stmt.free();
  return null;
}

function all(sql, params = {}) {
  const results = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function insert(sql, params = {}) {
  db.run(sql, params);
  const lastId = db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0];
  save();
  return lastId;
}

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
// Resolves symlinks, removes dead paths, deduplicates by real path
function syncProjects() {
  const SCAN_ROOTS = [
    join(process.env.USERPROFILE || 'C:\\Users\\user', 'OneDrive', 'Desktop'),
    join(process.env.USERPROFILE || 'C:\\Users\\user', 'Desktop'),
  ];

  const seen = new Map(); // realPath -> { name, path, panData }

  for (const root of SCAN_ROOTS) {
    if (!existsSync(root)) continue;

    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      const entryPath = join(root, entry.name);

      // Follow symlinks to check if it's a directory
      let isDir = false;
      let realPath = entryPath;
      try {
        const stat = statSync(entryPath);
        isDir = stat.isDirectory();
        realPath = realpathSync(entryPath);
      } catch { continue; }

      if (!isDir) continue;

      // Check for .pan file — that's what makes it a PAN project
      const panFile = join(entryPath, '.pan');
      if (!existsSync(panFile)) continue;

      let panData = {};
      try { panData = JSON.parse(readFileSync(panFile, 'utf-8')); } catch {}

      const normalizedReal = realPath.replace(/\\/g, '/').replace(/\/$/, '');

      // Deduplicate by real path — symlinks collapse to the same project
      if (!seen.has(normalizedReal)) {
        const name = panData.project_name || entry.name;
        seen.set(normalizedReal, { name, path: normalizedReal, panData });
      }
    }
  }

  // Sync DB: remove projects whose paths no longer exist, add new ones
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
      // Path exists but no .pan file — not a PAN-tracked project
      console.log(`[PAN Sync] Removing non-PAN project: ${p.name} (no .pan file)`);
      run("DELETE FROM projects WHERE id = :id", { ':id': p.id });
    }
  }

  for (const [realPath, proj] of seen) {
    const existingByPath = get("SELECT * FROM projects WHERE path = :path", { ':path': realPath });
    if (existingByPath) {
      // Update name if .pan file has a different one
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
