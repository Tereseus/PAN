// Fault reports, part one (task 1092, the owner Nov 27): ΠAN notices its own breakage and keeps a
// report with nothing personal in it: which part, what went wrong, the version, how often, when.
// Memory > Reports on the phone shows them (task 1093). Nothing is sent anywhere yet: where reports
// go without ΠAN servers (a Foundation inbox, or GitHub filled in by a bot) is the owner's call, and
// when it is made every report is still shown, exactly as it would leave, before a yes.
//
// One row per part, fault and version: the same fault again only counts up, so a model that is
// down for an hour is one report, not a thousand.

import { readFileSync } from 'fs';
import { all, run } from './db.js';
import { plainDetail } from './fault-detail.js';

export { plainDetail };

const KEEP = 200;

let schemaReady = false;
function ensureSchema() {
  if (schemaReady) return;
  run(`CREATE TABLE IF NOT EXISTS fault_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    part TEXT NOT NULL,
    what TEXT NOT NULL,
    version TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    first_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    times INTEGER NOT NULL DEFAULT 1,
    sent_at INTEGER,
    UNIQUE (part, what, version)
  )`);
  schemaReady = true;
}

let version = null;
function hubVersion() {
  if (version) return version;
  try { version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || 'unknown'; }
  catch { version = 'unknown'; }
  return version;
}

/** Keep a fault. Never throws: a broken report must not break what it reports on. */
export function noteFault(part, what, detail = '', now = Date.now()) {
  try {
    ensureSchema();
    const p = String(part || 'unknown').slice(0, 40);
    const w = String(what || 'unknown').slice(0, 120);
    run(`INSERT INTO fault_reports (part, what, version, detail, first_at, last_at) VALUES (:p, :w, :v, :d, :t, :t)
         ON CONFLICT (part, what, version) DO UPDATE SET times = times + 1, last_at = :t, detail = :d`,
      { ':p': p, ':w': w, ':v': hubVersion(), ':d': plainDetail(detail), ':t': now });
    run(`DELETE FROM fault_reports WHERE id NOT IN (SELECT id FROM fault_reports ORDER BY last_at DESC LIMIT ${KEEP})`);
  } catch {}
}

/** The newest first, for Memory > Reports. */
export function faultReports(limit = 50) {
  ensureSchema();
  return all(`SELECT id, part, what, version, detail, first_at, last_at, times, sent_at FROM fault_reports
              ORDER BY last_at DESC LIMIT :n`, { ':n': Math.max(1, Math.min(KEEP, Number(limit) || 50)) });
}

/** The person removes a report from the list. */
export function dropFault(id) {
  ensureSchema();
  run('DELETE FROM fault_reports WHERE id = :id', { ':id': Number(id) });
}
