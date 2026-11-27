// The data dividend, the hub's side (tasks 1093 and 1095, the owner Nov 27). Off until the person
// turns it on in Settings > Privacy; installing it shares nothing. With it on, a buyer's question
// lands in Memory > Data dividend and nothing runs: the person says yes twice, each after a plain
// summary and then the exact JSON, once to let the buyer's algorithm run on this hub's data and
// once to let its answer leave. No buyer can ask yet (there is no market), so the list is empty;
// this file keeps the switch and the list the phone shows.

import { all, get, run } from './db.js';

let schemaReady = false;
function ensureSchema() {
  if (schemaReady) return;
  run(`CREATE TABLE IF NOT EXISTS dividend_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asked_at INTEGER NOT NULL,
    buyer TEXT NOT NULL,
    question TEXT NOT NULL,
    run_summary TEXT NOT NULL DEFAULT '',
    run_json TEXT NOT NULL DEFAULT '{}',
    answer_summary TEXT NOT NULL DEFAULT '',
    answer_json TEXT NOT NULL DEFAULT '',
    step TEXT NOT NULL DEFAULT 'waiting_run',
    run_yes_at INTEGER,
    send_yes_at INTEGER,
    no_at INTEGER
  )`);
  schemaReady = true;
}

/** The Privacy switch. Off unless the person turned it on. */
export function dividendOn() {
  try {
    const v = get("SELECT value FROM settings WHERE key = 'data_dividend_on'")?.value;
    return v === 'true' || v === '1' || v === '"true"';
  } catch { return false; }
}

export function setDividendOn(on) {
  run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('data_dividend_on', :v, datetime('now','localtime'))",
    { ':v': on ? 'true' : 'false' });
  return dividendOn();
}

/** Buyer questions, newest first, with the step each is at. */
export function dividendQuestions(limit = 50) {
  ensureSchema();
  return all(`SELECT id, asked_at, buyer, question, run_summary, run_json, answer_summary, answer_json, step
              FROM dividend_questions ORDER BY asked_at DESC LIMIT :n`, { ':n': Math.max(1, Math.min(200, Number(limit) || 50)) });
}
