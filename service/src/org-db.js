// Phase 4 — Per-Org Databases & Cross-Org Data Sharing
//
// Bridges the org context system (org_id on every request) to the
// db-registry scope system (lazy SQLCipher sibling files).
//
// org_personal  → scope 'main'   (backward compatible, pan.db)
// org_acme      → scope 'org-acme' (pan.org-acme.db)
//
// Exports:
//   getOrgScope(orgId)                — returns the scope tag string
//   getOrgDb(orgId)                   — returns the database handle for this org
//   migrateOrgToSeparateDb(orgId)     — moves an org's data from main to its own DB
//   crossOrgQuery(orgIds, sql, params)— runs a query across multiple org databases and merges results

import { getDb, handles } from './db-registry.js';
import { db as mainDb, all, get } from './db.js';
import { existsSync, statSync } from 'fs';

const PERSONAL_ORG_ID = 'org_personal';

// Tables that contain per-org data and should be migrated when isolating.
// Each entry: { table, orgColumn } — orgColumn is the column that holds org_id,
// or null if the table is scoped by session_id (which itself belongs to an org).
const MULTI_TENANT_TABLES = [
  { table: 'events',            orgColumn: null,      sessionScoped: true },
  { table: 'sessions',          orgColumn: 'org_id',  sessionScoped: false },
  { table: 'projects',          orgColumn: 'org_id',  sessionScoped: false },
  { table: 'memory_items',      orgColumn: null,      sessionScoped: true },
  { table: 'episodic_memories', orgColumn: null,      sessionScoped: true },
  { table: 'sensor_data',       orgColumn: 'org_id',  sessionScoped: false },
];

/**
 * Map an org_id to a db-registry scope tag.
 * org_personal → 'main' (backward compatible)
 * org_acme     → 'org-acme'
 */
function getOrgScope(orgId) {
  if (!orgId || orgId === PERSONAL_ORG_ID) return 'main';
  const slug = orgId.replace(/^org_/, '');
  return `org-${slug}`;
}

/**
 * Get the SQLCipher database handle for an org.
 * Lazily creates the scoped DB file on first access via db-registry.
 */
function getOrgDb(orgId) {
  return getDb(getOrgScope(orgId));
}

/**
 * Migrate all of an org's data from the main DB to its own isolated DB.
 * This is a destructive operation on main — rows are copied then deleted.
 *
 * Only works for non-personal orgs (personal always stays in main).
 *
 * @param {string} orgId - e.g. 'org_acme'
 * @returns {{ migrated: boolean, rowsMoved: number, scope: string }}
 */
function migrateOrgToSeparateDb(orgId) {
  if (!orgId || orgId === PERSONAL_ORG_ID) {
    throw new Error('Cannot migrate personal org — it always uses the main database');
  }

  const scope = getOrgScope(orgId);
  const targetDb = getDb(scope); // lazily creates the scope DB
  let totalMoved = 0;

  // Look up org to confirm it exists
  const org = get(`SELECT * FROM orgs WHERE id = :id`, { ':id': orgId });
  if (!org) throw new Error(`Org not found: ${orgId}`);

  // Collect session IDs that belong to this org (for session-scoped tables)
  const orgSessions = all(
    `SELECT id FROM sessions WHERE org_id = :oid`,
    { ':oid': orgId }
  ).map(r => r.id);

  // Run migration inside a transaction on main (source).
  // We insert into target outside the main transaction since it's a different DB.
  const mainTransaction = mainDb.transaction(() => {
    for (const spec of MULTI_TENANT_TABLES) {
      const { table, orgColumn, sessionScoped } = spec;

      // Check if the table exists in main
      const tableExists = mainDb.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
      ).get(table);
      if (!tableExists) continue;

      // Check if the table exists in target
      const targetTableExists = targetDb.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
      ).get(table);
      if (!targetTableExists) continue;

      let rows;
      if (orgColumn) {
        // Direct org_id column
        rows = mainDb.prepare(`SELECT * FROM ${table} WHERE ${orgColumn} = ?`).all(orgId);
      } else if (sessionScoped && orgSessions.length > 0) {
        // Scoped by session_id — only migrate if we have sessions for this org
        const placeholders = orgSessions.map(() => '?').join(',');
        rows = mainDb.prepare(`SELECT * FROM ${table} WHERE session_id IN (${placeholders})`).all(...orgSessions);
      } else {
        continue; // no rows to migrate
      }

      if (rows.length === 0) continue;

      // Get column names from the first row
      const columns = Object.keys(rows[0]);
      const placeholders = columns.map(() => '?').join(',');
      const insertStmt = targetDb.prepare(
        `INSERT OR IGNORE INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`
      );

      // Batch insert into target DB
      const insertAll = targetDb.transaction((rowBatch) => {
        for (const row of rowBatch) {
          insertStmt.run(...columns.map(c => row[c]));
        }
      });
      insertAll(rows);

      // Delete from main
      if (orgColumn) {
        mainDb.prepare(`DELETE FROM ${table} WHERE ${orgColumn} = ?`).run(orgId);
      } else if (sessionScoped && orgSessions.length > 0) {
        const ph = orgSessions.map(() => '?').join(',');
        mainDb.prepare(`DELETE FROM ${table} WHERE session_id IN (${ph})`).run(...orgSessions);
      }

      totalMoved += rows.length;
    }
  });

  mainTransaction();

  console.log(`[org-db] migrated ${totalMoved} rows for ${orgId} → scope "${scope}"`);
  return { migrated: true, rowsMoved: totalMoved, scope };
}

/**
 * Run a SQL query across multiple org databases and merge results.
 * Useful for cross-org reporting, search, and admin dashboards.
 *
 * @param {string[]} orgIds - list of org IDs to query
 * @param {string} sql - SQL query to run on each org's DB
 * @param {object} params - named parameters for the query (unprefixed keys)
 * @returns {Array<object>} merged results with _org_id attached to each row
 */
function crossOrgQuery(orgIds, sql, params = {}) {
  const results = [];

  for (const orgId of orgIds) {
    try {
      const db = getOrgDb(orgId);
      const rows = db.prepare(sql).all(params);
      for (const row of rows) {
        row._org_id = orgId;
        results.push(row);
      }
    } catch (err) {
      console.warn(`[org-db] crossOrgQuery failed for ${orgId}:`, err.message);
      // Skip this org, continue with others
    }
  }

  return results;
}

/**
 * Get storage info for an org's database (file size, scope, path).
 *
 * @param {string} orgId
 * @returns {{ scope: string, path: string|null, sizeBytes: number, exists: boolean }}
 */
function getOrgStorageInfo(orgId) {
  const scope = getOrgScope(orgId);
  const entry = handles.get(scope);

  if (scope === 'main') {
    // Main DB always exists
    const path = entry?.path;
    let sizeBytes = 0;
    if (path && existsSync(path)) {
      sizeBytes = statSync(path).size;
    }
    return { scope, path, sizeBytes, exists: true, isMainDb: true };
  }

  if (entry) {
    let sizeBytes = 0;
    if (existsSync(entry.path)) {
      sizeBytes = statSync(entry.path).size;
    }
    return { scope, path: entry.path, sizeBytes, exists: true, isMainDb: false };
  }

  // Not yet opened — file may or may not exist on disk
  return { scope, path: null, sizeBytes: 0, exists: false, isMainDb: false };
}

export {
  getOrgScope,
  getOrgDb,
  migrateOrgToSeparateDb,
  crossOrgQuery,
  getOrgStorageInfo,
};
