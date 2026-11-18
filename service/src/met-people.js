// met-people.js — people with a ΠAN of their own that someone on this hub has met.
//
// Two people meet by a deliberate act of both (docs/PEOPLE-PLAN.md, Decided 4): each shows a
// code on their own ΠAN and the other scans it. A code holds a name and a public key, signed
// with that key and good for a few minutes; the phone that scans it checks that and then tells
// its own hub "I met this person". Nothing passes between the two ΠANs but the code on the
// screen, and neither hub ever hears from the other.
//
// The record is the wearer's own (the owner, 2026-11-18: "it's supposed to be recorded, that's
// why you're wearing ΠAN. You can delete it, but they would still have theirs"):
//   - It is kept per person: the owner's list and each person's list are separate, and nobody
//     sees anyone else's.
//   - The name is what the other person's ΠAN called them. It is a stranger's text: shown as
//     text and never given to a model or acted on (rule 2).
//   - The key is how the same person is known the next time, whatever name they give then, and
//     what a later talk between the two devices will be checked against.
//   - Forgetting removes this side's record only.

import { get, all, run } from './db.js';

const MAX_PER_PERSON = 500;
const MAX_NAME = 60;

let schemaReady = false;
export function ensureMetSchema() {
  if (schemaReady) return;
  run(`CREATE TABLE IF NOT EXISTS met_people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    first_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    times INTEGER NOT NULL DEFAULT 1,
    UNIQUE (user_id, key)
  )`);
  schemaReady = true;
}

/** A stranger's name as plain text: no control characters, one line, 60 characters. */
export function cleanName(name) {
  return String(name ?? '').replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

/** A public key as the phone sends it: base64url, a sensible length. */
export function validKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{40,400}$/.test(key);
}

const row = (r) => ({ id: Number(r.id), name: r.name, key: r.key, first_at: Number(r.first_at), last_at: Number(r.last_at), times: Number(r.times) });

/**
 * This person met someone: a new record, or one more meeting with a key already known (the
 * newest name is kept). -> the record | { error: 'name' | 'key' }
 */
export function recordMet(userId, { name, key } = {}, now = Date.now()) {
  const uid = Number(userId);
  const clean = cleanName(name);
  if (!uid) return { error: 'nobody' };
  if (!clean.replace(/[^\p{L}\p{N}]/gu, '')) return { error: 'name' };
  if (!validKey(key)) return { error: 'key' };
  ensureMetSchema();
  const had = get(`SELECT id FROM met_people WHERE user_id = :u AND key = :k`, { ':u': uid, ':k': key });
  if (had) {
    run(`UPDATE met_people SET name = :n, last_at = :t, times = times + 1 WHERE id = :i`, { ':n': clean, ':t': now, ':i': had.id });
  } else {
    run(`INSERT INTO met_people (user_id, key, name, first_at, last_at) VALUES (:u, :k, :n, :t, :t)`, { ':u': uid, ':k': key, ':n': clean, ':t': now });
    // Never more than MAX_PER_PERSON: the ones not seen for the longest go first.
    run(`DELETE FROM met_people WHERE user_id = :u AND id NOT IN (SELECT id FROM met_people WHERE user_id = :u ORDER BY last_at DESC, id DESC LIMIT ${MAX_PER_PERSON})`, { ':u': uid });
  }
  return row(get(`SELECT * FROM met_people WHERE user_id = :u AND key = :k`, { ':u': uid, ':k': key }));
}

/** Everyone this person has met, the latest meeting first. */
export function metFor(userId) {
  ensureMetSchema();
  return all(`SELECT * FROM met_people WHERE user_id = :u ORDER BY last_at DESC, id DESC`, { ':u': Number(userId) }).map(row);
}

/** Forget one of this person's own records. -> whether there was one */
export function forgetMet(userId, id) {
  ensureMetSchema();
  return run(`DELETE FROM met_people WHERE user_id = :u AND id = :i`, { ':u': Number(userId), ':i': Number(id) }).changes > 0;
}
