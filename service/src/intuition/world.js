// The world Intuition keeps: one place for what is going on, kept in the database
// (docs/INTUITION-STATE-ENGINE.md). Step 2 of that plan: the modes he sets by voice,
// interpreting and the other standing instructions. router.js held them only in memory, so
// every Craft swap silently ended interpreting (five swaps on the evening of 2026-11-03).
import { all, run } from '../db.js';

let _ready = false;
function ensure() {
  if (_ready) return;
  run(`CREATE TABLE IF NOT EXISTS world_modes (
    device_key TEXT PRIMARY KEY,
    mode       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  _ready = true;
}

/**
 * The saved modes, as a Map of device key -> mode ({ text, at, last?, lang? }). A mode `keep`
 * rejects (expired) is deleted, so the table only holds what is in force.
 */
export function loadModes(keep = () => true) {
  const out = new Map();
  try {
    ensure();
    for (const r of all(`SELECT device_key, mode FROM world_modes`)) {
      let mode = null;
      try { mode = JSON.parse(r.mode); } catch {}
      if (mode && keep(mode)) out.set(r.device_key, mode);
      else run(`DELETE FROM world_modes WHERE device_key = :k`, { ':k': r.device_key });
    }
  } catch (e) {
    console.warn('[world] modes not loaded:', e.message);
  }
  return out;
}

export function saveMode(key, mode) {
  if (!key) return;
  try {
    ensure();
    run(`INSERT OR REPLACE INTO world_modes (device_key, mode, updated_at) VALUES (:k, :m, :t)`,
      { ':k': key, ':m': JSON.stringify(mode), ':t': Date.now() });
  } catch (e) {
    console.warn('[world] mode not saved:', e.message);
  }
}

export function dropMode(key) {
  if (!key) return;
  try {
    ensure();
    run(`DELETE FROM world_modes WHERE device_key = :k`, { ':k': key });
  } catch (e) {
    console.warn('[world] mode not dropped:', e.message);
  }
}
