// Tier 0 — Org Foundation migration (Phase 1: Schema + Backfill)
//
// Exports a single function: migrate({ dry }) => { ok, report }
//
// What it does:
//   1. Pre-flight: verify DB exists, check disk space, refuse if backup exists
//   2. Backup: copy pan.db -> pan.db.pre-tier0.bak (+ WAL/SHM)
//   3. Snapshot: capture row counts for every table that will be touched
//   4. Apply migration inside a transaction:
//        - CREATE TABLE IF NOT EXISTS for 6 new tables
//        - Guarded ALTER TABLE ADD COLUMN for 28 existing tables
//        - Backfill: create org_personal, link users to memberships
//   5. Verify: row counts unchanged, backfill rows present, org_id columns exist
//   6. Report: return structured results
//
// Idempotent — safe to re-run. Detects already-migrated state and exits early.
//
// Design doc: ~/.claude/projects/C--Users-tzuri-Desktop-PAN/memory/project_tier0_org_foundation.md

import { db, DB_PATH } from '../db.js';
import { readFileSync, copyFileSync, existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = join(__dirname, '001_tier0_org_foundation.sql');
const BACKUP_PATH = DB_PATH + '.pre-tier0.bak';

// ============================================================
// Tables that need an org_id column added.
// [tableName, default] — null default means nullable column.
// ============================================================
const ALTER_TARGETS = [
  // Identity tables (nullable org_id)
  ['roles',                  null],
  ['api_tokens',             null],
  ['devices',                'org_personal'],
  // Core data tables
  ['events',                 'org_personal'],
  ['memory_items',           'org_personal'],
  ['sessions',               'org_personal'],
  ['command_queue',          'org_personal'],
  ['command_logs',           'org_personal'],
  ['ai_usage',               'org_personal'],
  ['client_logs',            'org_personal'],
  ['device_sensors',         'org_personal'],
  ['sensor_attachments',     'org_personal'],
  // Memory + intelligence
  ['episodic_memories',      'org_personal'],
  ['procedural_memories',    'org_personal'],
  ['semantic_facts',         'org_personal'],
  ['evolution_versions',     'org_personal'],
  // Project tables
  ['projects',               'org_personal'],
  ['project_milestones',     'org_personal'],
  ['project_sections',       'org_personal'],
  ['project_tasks',          'org_personal'],
  ['section_items',          'org_personal'],
  ['scheduled_jobs',         'org_personal'],
  ['open_tabs',              'org_personal'],
  // Automation / discovery
  ['orchestrator_actions',   'org_personal'],
  ['scout_findings',         'org_personal'],
  ['resistance_log',         'org_personal'],
  ['resistance_paths',       'org_personal'],
  ['resistance_preferences', 'org_personal'],
  // Settings (nullable)
  ['settings',               null],
];

// users gets two new columns (not org_id)
const USERS_NEW_COLUMNS = [
  ['display_nickname', 'TEXT'],
  ['last_active_org_id', "TEXT DEFAULT 'org_personal'"],
];

const NEW_TABLES = [
  'orgs', 'memberships', 'zones', 'audit_log', 'incognito_events', 'sensor_toggles',
];

// Sample tables for deep org_id verification
const SAMPLE_VERIFY_TABLES = ['events', 'memory_items', 'sessions', 'projects'];

// ============================================================
// Helpers
// ============================================================

function tableExists(name) {
  return !!db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(name);
}

function columnExists(table, column) {
  if (!tableExists(table)) return false;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === column);
}

function rowCount(table) {
  if (!tableExists(table)) return null;
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
  } catch {
    return null;
  }
}

function alreadyMigrated() {
  return tableExists('orgs')
      && tableExists('memberships')
      && columnExists('events', 'org_id');
}

// ============================================================
// Main migration function
// ============================================================
export function migrate({ dry = false } = {}) {
  const log = [];
  const push = (msg) => { log.push(msg); console.log('[tier0]', msg); };
  const warn = (msg) => { log.push('WARN: ' + msg); console.warn('[tier0]', msg); };

  push(`DB path: ${DB_PATH}`);
  push(`SQL path: ${SQL_PATH}`);
  push(`Mode: ${dry ? 'DRY RUN (no writes)' : 'LIVE'}`);

  // ── 0. Already migrated? ──
  if (alreadyMigrated()) {
    push('Already migrated (orgs + memberships + events.org_id all present).');
    push('Nothing to do.');
    return { ok: true, alreadyDone: true, log };
  }

  // ── 1. Pre-flight ──
  if (!existsSync(DB_PATH)) {
    push('FAILED: Database file not found at ' + DB_PATH);
    return { ok: false, log };
  }

  // Disk space check: need at least 2x DB size for backup + headroom
  try {
    const dbSize = statSync(DB_PATH).size;
    const walPath = DB_PATH + '-wal';
    const walSize = existsSync(walPath) ? statSync(walPath).size : 0;
    const totalDbSize = dbSize + walSize;
    push(`Database size: ${(totalDbSize / 1024 / 1024).toFixed(1)} MB`);

    // On Windows, check free space on the drive where DB lives
    // We use a simple heuristic: if the DB is > 100MB, warn about space
    if (totalDbSize > 100 * 1024 * 1024) {
      warn(`Large database (${(totalDbSize / 1024 / 1024).toFixed(0)} MB) — ensure at least ${(totalDbSize * 2 / 1024 / 1024).toFixed(0)} MB free disk space for backup`);
    }
  } catch (err) {
    warn(`Could not check database size: ${err.message}`);
  }

  // Refuse if backup already exists
  if (existsSync(BACKUP_PATH)) {
    const age = Math.round((Date.now() - statSync(BACKUP_PATH).mtimeMs) / 1000);
    push(`FAILED: Backup already exists at ${BACKUP_PATH} (${age}s old). Delete it first.`);
    return { ok: false, log };
  }

  // ── 2. Backup ──
  push(`Backing up ${DB_PATH} -> ${BACKUP_PATH}`);
  if (dry) {
    push('  (dry run — skipped)');
  } else {
    copyFileSync(DB_PATH, BACKUP_PATH);
    if (existsSync(DB_PATH + '-wal')) copyFileSync(DB_PATH + '-wal', BACKUP_PATH + '-wal');
    if (existsSync(DB_PATH + '-shm')) copyFileSync(DB_PATH + '-shm', BACKUP_PATH + '-shm');
    push('  backup complete');
  }

  // ── 3. Snapshot row counts ──
  push('Pre-migration row counts:');
  const preCounts = {};
  for (const [t] of ALTER_TARGETS) {
    preCounts[t] = rowCount(t);
    push(`  ${t.padEnd(28)} ${preCounts[t] === null ? '(not present)' : preCounts[t]}`);
  }
  preCounts.users = rowCount('users');
  push(`  ${'users'.padEnd(28)} ${preCounts.users}`);

  // ── 4. Apply migration ──
  const sql = readFileSync(SQL_PATH, 'utf-8');
  push('Applying CREATE TABLE + ALTER + backfill ...');

  if (dry) {
    // Dry run: report what would happen
    push('  (dry run — would create new tables: ' + NEW_TABLES.join(', ') + ')');
    push('  (dry run — would ALTER:)');
    for (const [t, def] of ALTER_TARGETS) {
      if (!tableExists(t)) {
        push(`    skip ${t}: table not present`);
        continue;
      }
      if (columnExists(t, 'org_id')) {
        push(`    skip ${t}.org_id: already exists`);
        continue;
      }
      const defaultClause = def === null ? '' : ` DEFAULT '${def}'`;
      const notNullClause = def === null ? '' : ' NOT NULL';
      push(`    + ALTER TABLE ${t} ADD COLUMN org_id TEXT${notNullClause}${defaultClause}`);
    }
    if (tableExists('users')) {
      for (const [col, type] of USERS_NEW_COLUMNS) {
        if (columnExists('users', col)) {
          push(`    skip users.${col}: already exists`);
        } else {
          push(`    + ALTER TABLE users ADD COLUMN ${col} ${type}`);
        }
      }
    }
  } else {
    // Live run: execute inside a transaction
    const tx = db.transaction(() => {
      // Create new tables + run backfill SQL
      db.exec(sql);

      // ALTER TABLE for org-scoped tables
      for (const [t, def] of ALTER_TARGETS) {
        if (!tableExists(t)) {
          push(`  skip ${t}: table not present`);
          continue;
        }
        if (columnExists(t, 'org_id')) {
          push(`  skip ${t}.org_id: already exists`);
          continue;
        }
        const defaultClause = def === null ? '' : ` DEFAULT '${def}'`;
        const notNullClause = def === null ? '' : ' NOT NULL';
        push(`  + ${t}.org_id`);
        db.exec(`ALTER TABLE "${t}" ADD COLUMN org_id TEXT${notNullClause}${defaultClause}`);
      }

      // users gets display_nickname + last_active_org_id
      if (tableExists('users')) {
        for (const [col, type] of USERS_NEW_COLUMNS) {
          if (columnExists('users', col)) {
            push(`  skip users.${col}: already exists`);
            continue;
          }
          push(`  + users.${col}`);
          db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
        }
        // Backfill last_active_org_id for any rows where it's NULL
        db.exec(`UPDATE users SET last_active_org_id = 'org_personal' WHERE last_active_org_id IS NULL`);
      }
    });
    tx();
    push('  migration applied');
  }

  // ── 5. Verify ──
  if (!dry) {
    // 5a. Row counts unchanged
    push('Verifying row counts unchanged:');
    let mismatch = false;
    for (const [t] of ALTER_TARGETS) {
      const before = preCounts[t];
      const after = rowCount(t);
      if (before === null) continue;
      const ok = before === after;
      push(`  ${t.padEnd(28)} ${before} -> ${after} ${ok ? 'OK' : 'MISMATCH'}`);
      if (!ok) mismatch = true;
    }
    const usersAfter = rowCount('users');
    const usersOk = preCounts.users === usersAfter;
    push(`  ${'users'.padEnd(28)} ${preCounts.users} -> ${usersAfter} ${usersOk ? 'OK' : 'MISMATCH'}`);
    if (!usersOk) mismatch = true;

    if (mismatch) {
      push('FAILED: Row count mismatch. Backup at ' + BACKUP_PATH);
      return { ok: false, log, preCounts };
    }

    // 5b. Backfill verification
    push('Verifying backfill:');
    const org = db.prepare(`SELECT * FROM orgs WHERE id='org_personal'`).get();
    const memCount = db.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE org_id='org_personal'`).get().n;
    const userCount = db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
    push(`  org_personal exists:           ${org ? 'YES' : 'NO'}`);
    push(`  membership rows:               ${memCount}`);
    push(`  user count:                    ${userCount}`);
    push(`  every user has membership:     ${memCount >= userCount ? 'YES' : 'NO'}`);

    if (!org) {
      push('FAILED: orgs.org_personal missing.');
      return { ok: false, log, preCounts };
    }
    if (memCount < userCount) {
      push(`FAILED: Membership count (${memCount}) < user count (${userCount}).`);
      return { ok: false, log, preCounts };
    }

    // 5c. Verify org_id columns exist on all scoped tables
    push('Verifying org_id columns exist:');
    let colMissing = false;
    for (const [t, def] of ALTER_TARGETS) {
      if (!tableExists(t)) continue;
      const has = columnExists(t, 'org_id');
      if (!has) {
        push(`  ${t}.org_id: MISSING`);
        colMissing = true;
      }
    }
    if (colMissing) {
      push('FAILED: Some tables missing org_id column.');
      return { ok: false, log, preCounts };
    }
    push('  all scoped tables have org_id: YES');

    // 5d. Verify users got new columns
    if (tableExists('users')) {
      for (const [col] of USERS_NEW_COLUMNS) {
        const has = columnExists('users', col);
        push(`  users.${col}: ${has ? 'YES' : 'MISSING'}`);
        if (!has) {
          push('FAILED: users missing column ' + col);
          return { ok: false, log, preCounts };
        }
      }
    }

    // 5e. Sample org_id values — all existing rows should be 'org_personal'
    push('Sample org_id verification on key tables:');
    for (const t of SAMPLE_VERIFY_TABLES) {
      if (!tableExists(t)) continue;
      const total = rowCount(t);
      if (total === 0) {
        push(`  ${t.padEnd(28)} 0 rows (empty, OK)`);
        continue;
      }
      const orgCount = db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE org_id = 'org_personal'`).get().n;
      push(`  ${t.padEnd(28)} ${orgCount}/${total} = org_personal`);
      if (orgCount !== total) {
        push(`FAILED: ${t} has ${total - orgCount} rows without org_id='org_personal'`);
        return { ok: false, log, preCounts };
      }
    }

    // 5f. New tables exist
    push('Verifying new tables created:');
    for (const t of NEW_TABLES) {
      const exists = tableExists(t);
      push(`  ${t.padEnd(28)} ${exists ? 'YES' : 'MISSING'}`);
      if (!exists) {
        push('FAILED: New table ' + t + ' not created.');
        return { ok: false, log, preCounts };
      }
    }
  }

  // ── 6. Post-migration row counts ──
  push('Post-migration row counts:');
  const postCounts = {};
  for (const [t] of ALTER_TARGETS) {
    postCounts[t] = rowCount(t);
  }
  postCounts.users = rowCount('users');
  for (const t of NEW_TABLES) {
    postCounts[t] = rowCount(t);
    push(`  ${t.padEnd(28)} ${postCounts[t]}`);
  }

  push('DONE.');
  if (!dry) push(`Backup retained at ${BACKUP_PATH}`);

  return { ok: true, alreadyDone: false, log, preCounts, postCounts, backupPath: BACKUP_PATH };
}
