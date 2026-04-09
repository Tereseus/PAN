// Tier 0 migration runner (REVISED 2026-04-08 against real schema).
//
// What it does, in order:
//   1. Pre-flight: verify db.js loads, refuse to run if backup already exists
//   2. Backup: copy pan.db -> pan.db.pre-tier0.bak (+ -wal + -shm)
//   3. Snapshot: capture row counts for every table that will be touched
//   4. Apply migration in a transaction:
//        - run 001_tier0_org_foundation.sql (new tables + backfill)
//        - for each ALTER target: skip if column already exists, else ADD COLUMN
//        - run users.last_active_org_id backfill
//   5. Verify: row counts unchanged, backfill rows present, columns exist
//   6. Report: print before/after counts, exit code
//
// Run with:
//   node service/src/migrations/run.js --dry     # safe, no writes
//   node service/src/migrations/run.js           # live, with backup + verify
//
// Idempotent. Safe to re-run after a successful migration.

import { db, DB_PATH } from '../db.js';
import { readFileSync, copyFileSync, existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = join(__dirname, '001_tier0_org_foundation.sql');
const BACKUP_PATH = DB_PATH + '.pre-tier0.bak';

const DRY = process.argv.includes('--dry');

// Tables that need an org_id column added.
// Each entry: [tableName, default ('org_personal' or null for nullable)]
const ALTER_TARGETS = [
  // Identity tables
  ['roles',                  null],            // nullable: NULL = global system role
  ['api_tokens',             null],            // nullable: NULL = any org
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
  // Settings
  ['settings',               null],            // nullable: NULL = global setting
];

// Special-case: users gets two new columns (display_nickname + last_active_org_id)
// rather than an org_id column.
const USERS_NEW_COLUMNS = [
  ['display_nickname', 'TEXT'],
  ['last_active_org_id', "TEXT DEFAULT 'org_personal'"],
];

const NEW_TABLES = [
  'orgs', 'memberships', 'zones', 'audit_log', 'incognito_events', 'sensor_toggles',
];

function log(...args) { console.log('[tier0]', ...args); }
function warn(...args) { console.warn('[tier0]', ...args); }
function fail(msg) { console.error('[tier0] FAILED:', msg); process.exit(1); }

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
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  } catch {
    return null;
  }
}

function backupDb() {
  if (existsSync(BACKUP_PATH)) {
    const age = Math.round((Date.now() - statSync(BACKUP_PATH).mtimeMs) / 1000);
    warn(`Backup already exists at ${BACKUP_PATH} (${age}s old). Refusing to overwrite.`);
    warn('Delete the old backup manually if you want a fresh one:');
    warn(`  del "${BACKUP_PATH}"`);
    return false;
  }
  log(`Backing up ${DB_PATH} -> ${BACKUP_PATH}`);
  if (DRY) { log('  (dry run — skipped)'); return true; }
  copyFileSync(DB_PATH, BACKUP_PATH);
  if (existsSync(DB_PATH + '-wal')) copyFileSync(DB_PATH + '-wal', BACKUP_PATH + '-wal');
  if (existsSync(DB_PATH + '-shm')) copyFileSync(DB_PATH + '-shm', BACKUP_PATH + '-shm');
  log('  ✔ backup complete');
  return true;
}

function alreadyMigrated() {
  // Heuristic: if `orgs` and `memberships` exist AND `events.org_id` exists,
  // we've already run the full migration.
  return tableExists('orgs')
      && tableExists('memberships')
      && columnExists('events', 'org_id');
}

function main() {
  log(`DB path: ${DB_PATH}`);
  log(`SQL path: ${SQL_PATH}`);
  log(`Mode: ${DRY ? 'DRY RUN (no writes)' : 'LIVE'}`);

  if (alreadyMigrated()) {
    log('Already migrated (orgs + memberships + events.org_id all present).');
    log('Nothing to do. Exiting.');
    return;
  }

  // 1. Backup (DRY mode skips the actual file copy)
  if (!backupDb()) fail('Backup step failed.');

  // 2. Pre-migration row counts
  log('Pre-migration row counts:');
  const preCounts = {};
  for (const [t] of ALTER_TARGETS) {
    preCounts[t] = rowCount(t);
    log(`  ${t.padEnd(28)} ${preCounts[t] === null ? '(not present)' : preCounts[t]}`);
  }
  preCounts.users = rowCount('users');
  log(`  ${'users'.padEnd(28)} ${preCounts.users}`);

  // 3. Run the SQL inside a transaction
  const sql = readFileSync(SQL_PATH, 'utf-8');
  log('Running 001_tier0_org_foundation.sql + ALTERs ...');

  if (DRY) {
    log('  (dry run — would create new tables: ' + NEW_TABLES.join(', ') + ')');
    log('  (dry run — would ALTER:)');
    for (const [t, def] of ALTER_TARGETS) {
      if (!tableExists(t)) {
        log(`    ↷ ${t}: not present, would skip`);
        continue;
      }
      if (columnExists(t, 'org_id')) {
        log(`    ↷ ${t}.org_id: already exists, would skip`);
        continue;
      }
      const defaultClause = def === null ? '' : ` DEFAULT '${def}'`;
      const notNullClause = def === null ? '' : ' NOT NULL';
      log(`    + ALTER TABLE ${t} ADD COLUMN org_id TEXT${notNullClause}${defaultClause}`);
    }
    if (tableExists('users')) {
      for (const [col, type] of USERS_NEW_COLUMNS) {
        if (columnExists('users', col)) {
          log(`    ↷ users.${col}: already exists, would skip`);
        } else {
          log(`    + ALTER TABLE users ADD COLUMN ${col} ${type}`);
        }
      }
    }
  } else {
    const tx = db.transaction(() => {
      // Create new tables + run backfill SQL
      db.exec(sql);

      // ALTER TABLE for org-scoped tables
      for (const [t, def] of ALTER_TARGETS) {
        if (!tableExists(t)) {
          log(`  ↷ ${t}: not present, skipping`);
          continue;
        }
        if (columnExists(t, 'org_id')) {
          log(`  ↷ ${t}.org_id: already exists, skipping`);
          continue;
        }
        const defaultClause = def === null ? '' : ` DEFAULT '${def}'`;
        const notNullClause = def === null ? '' : ' NOT NULL';
        log(`  + ${t}.org_id`);
        db.exec(`ALTER TABLE ${t} ADD COLUMN org_id TEXT${notNullClause}${defaultClause}`);
      }

      // Special-case: users gets new columns (not org_id)
      if (tableExists('users')) {
        for (const [col, type] of USERS_NEW_COLUMNS) {
          if (columnExists('users', col)) {
            log(`  ↷ users.${col}: already exists, skipping`);
            continue;
          }
          log(`  + users.${col}`);
          db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
        }
        // Backfill last_active_org_id for any rows where it's NULL
        db.exec(`UPDATE users SET last_active_org_id = 'org_personal' WHERE last_active_org_id IS NULL`);
      }
    });
    tx();
    log('  ✔ migration applied');
  }

  // 4. Verify row counts unchanged
  if (!DRY) {
    log('Verifying row counts unchanged:');
    let mismatch = false;
    for (const [t] of ALTER_TARGETS) {
      const before = preCounts[t];
      const after = rowCount(t);
      if (before === null) continue;
      const ok = before === after;
      log(`  ${t.padEnd(28)} ${before} → ${after} ${ok ? '✔' : '✗'}`);
      if (!ok) mismatch = true;
    }
    const usersAfter = rowCount('users');
    log(`  ${'users'.padEnd(28)} ${preCounts.users} → ${usersAfter} ${preCounts.users === usersAfter ? '✔' : '✗'}`);
    if (preCounts.users !== usersAfter) mismatch = true;
    if (mismatch) fail('Row count mismatch — manual investigation required. Backup at ' + BACKUP_PATH);
  }

  // 5. Verify backfill rows
  if (!DRY) {
    log('Verifying backfill:');
    const org = db.prepare(`SELECT * FROM orgs WHERE id='org_personal'`).get();
    const memCount = db.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE org_id='org_personal'`).get().n;
    const userCount = db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
    log(`  org_personal exists:           ${org ? '✔' : '✗'}`);
    log(`  membership rows:               ${memCount}`);
    log(`  user count:                    ${userCount}`);
    log(`  every user has membership:     ${memCount === userCount ? '✔' : '✗'}`);
    if (!org) fail('orgs.org_personal missing.');
    if (memCount !== userCount) fail(`Membership count (${memCount}) != user count (${userCount}).`);
  }

  // 6. Verify sample org_id values
  if (!DRY) {
    log('Sample org_id verification on key tables:');
    for (const t of ['events', 'memory_items', 'sessions', 'projects']) {
      if (!tableExists(t)) continue;
      const r = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE org_id = 'org_personal'`).get();
      const total = rowCount(t);
      log(`  ${t.padEnd(28)} ${r.n}/${total} = org_personal`);
      if (r.n !== total) fail(`${t} has ${total - r.n} rows without org_id='org_personal'`);
    }
  }

  log('DONE.');
  if (!DRY) log(`Backup retained at ${BACKUP_PATH} — delete it once you're confident.`);
}

main();
