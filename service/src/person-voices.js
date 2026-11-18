// person-voices.js — each person's device knows its own person's voice.
//
// The owner, 2026-11-18, with his phone and another person's side by side: the other person's
// ΠAN must not pick up what he says. The owner's own voice has had a profile since Nov 12
// (voice-id.js). This is the same thing for everyone else on the hub.
//
// How a person's voice is learned: the same way as the owner's, with nothing for them to say
// or do. Their device sits on them, so the voice that keeps coming back on it is theirs. Each
// real turn's print goes into that person's pool; the biggest group of prints that sound
// alike becomes their profile once it is big enough. Three kinds of print never go in:
//   - one that could be the owner's (not clearly someone else's against his profile),
//   - one that is clearly another person's whose voice is already known,
//   - one in ΠAN's own voice.
// So a device that mostly hears someone else never learns that someone as its person.
//
// What a person's device does with a turn (whoseOnDevice):
//   - 'other'   it is clearly the owner's voice or another known person's, or the device knows
//               its person's voice and this is clearly not it. The turn is dropped: nothing is
//               answered, sent or passed on.
//   - 'theirs'  clearly its own person's.
//   - 'unsure'  between. leans: the user it sounds more like, when it is not this person.
//               same-line.js decides with what the other devices in the room heard.
//   - 'unknown' the device has not learned its person yet and the voice is nobody's it knows.
//
// The prints are kept in the hub's data folder (person-voices.json) and sent nowhere. A person
// taken off the hub is taken out of the file.

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDataDir } from './platform.js';
import { all } from './db.js';

const FILE = process.env.PAN_PERSON_VOICES || join(getDataDir(), 'person-voices.json');   // env: tests only
const SAME = 0.5;               // at or above: that person's voice (voice-id.js uses the same marks)
const OTHER = 0.25;             // at or below: not that person's
const CLEARER = 0.1;            // one voice fits better than another by at least this
const POOL_MAX = 120;
const MIN_GROUP = Number(process.env.PAN_VOICE_MIN_GROUP || 10);       // env: tests only
const MIN_SHARE = Number(process.env.PAN_VOICE_MIN_SHARE || 0.4);      // env: tests only
const REGROUP_EVERY = 5;
const OWNER_ID = 1;

let voices = null;              // { "<user id>": { pool, centre, group, added } }

function load() {
  if (voices) return voices;
  try { voices = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) || {} : {}; } catch { voices = {}; }
  return voices;
}
function save() {
  try { writeFileSync(FILE, JSON.stringify(voices)); } catch (e) { console.warn('[person-voices] save failed:', e.message); }
}

function dot(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}
function unit(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) + 1e-9;
  return v.map((x) => x / n);
}

// The biggest group of alike prints in a pool becomes the profile (as in voice-id.js).
function regroup(p) {
  const pool = p.pool;
  let best = -1, bestN = 0;
  for (let i = 0; i < pool.length; i++) {
    let n = 0;
    for (let j = 0; j < pool.length; j++) if (dot(pool[i], pool[j]) >= SAME) n++;
    if (n > bestN) { bestN = n; best = i; }
  }
  p.group = bestN;
  if (best < 0 || bestN < MIN_GROUP || bestN < MIN_SHARE * pool.length) { p.centre = null; return; }
  const sum = new Array(pool[0].length).fill(0);
  for (const q of pool) if (dot(pool[best], q) >= SAME) q.forEach((x, i) => { sum[i] += x; });
  p.centre = unit(sum);
}

/** How much this print sounds like [userId]'s known voice, or null when it is not known yet. */
function likenessTo(userId, print) {
  const p = load()[String(Number(userId))];
  return p?.centre && print ? dot(print, p.centre) : null;
}

/** The other person on the hub (not [userId]) this print sounds most like: { user, likeness } | null. */
function nearestOther(userId, print) {
  let best = null;
  for (const [id, p] of Object.entries(load())) {
    if (Number(id) === Number(userId) || !p?.centre) continue;
    const l = dot(print, p.centre);
    if (!best || l > best.likeness) best = { user: Number(id), likeness: l };
  }
  return best;
}

/**
 * A turn on [userId]'s device, with its voice print. owner: how much it sounds like the owner
 * (voice-id.js; null when his voice is not known).
 * -> { verdict: 'other' | 'theirs' | 'unsure' | 'unknown', leans, mine, owner, by }
 *    leans: the user it sounds more like, when that is not this person. by: who 'other' is.
 */
export function whoseOnDevice(userId, print, { owner = null } = {}) {
  const me = Number(userId);
  if (!print) return { verdict: 'unknown', leans: null, mine: null, owner };
  const mine = likenessTo(me, print);
  const near = nearestOther(me, print);
  // The best fit among the voices that are not this person's.
  let rival = owner !== null && me !== OWNER_ID ? { user: OWNER_ID, likeness: owner } : null;
  if (near && (!rival || near.likeness > rival.likeness)) rival = near;
  const out = (verdict, leans = null, by = null) => ({ verdict, leans, mine, owner, by });
  if (mine === null) {
    if (rival && rival.likeness >= SAME) return out('other', rival.user, rival.user);
    if (rival && rival.likeness > OTHER) return out('unsure', rival.user);
    return out('unknown');
  }
  if (rival && rival.likeness >= SAME && rival.likeness >= mine + CLEARER) return out('other', rival.user, rival.user);
  if (mine >= SAME) return out('theirs');
  if (rival && rival.likeness > OTHER && rival.likeness >= mine + CLEARER) return out('other', rival.user, rival.user);
  if (mine <= OTHER) return out('other', rival && rival.likeness > OTHER ? rival.user : null, null);
  return out('unsure', rival && rival.likeness > mine ? rival.user : null);
}

/**
 * After a real turn on [userId]'s device that was taken as theirs: their pool learns.
 * owner: how much it sounds like the owner. pan: it is in ΠAN's own voice. -> whether it went in
 */
export function learnPersonVoice(userId, print, { owner = null, pan = false } = {}) {
  const me = Number(userId);
  if (!print || me === OWNER_ID || pan) return false;
  if (owner !== null && owner > OTHER) return false;                 // could be the owner: never theirs
  const near = nearestOther(me, print);
  if (near && near.likeness >= SAME) return false;                   // clearly another known person
  const all_ = load();
  const p = all_[String(me)] || (all_[String(me)] = { pool: [], centre: null, group: 0, added: 0 });
  p.pool.push(Array.from(print, (x) => Math.round(x * 1e4) / 1e4));
  if (p.pool.length > POOL_MAX) p.pool.shift();
  p.added = (p.added || 0) + 1;
  if (!(p.added % REGROUP_EVERY) || !p.centre) {
    const had = !!p.centre;
    regroup(p);
    if (!had && p.centre) console.log(`[person-voices] person ${me}'s voice is known now: ${p.group} of ${p.pool.length} turns`);
    if (!(p.added % 25)) prune();
  }
  save();
  return true;
}

// People who are no longer on the hub are taken out.
function prune() {
  try {
    const here = new Set(all(`SELECT id FROM users WHERE is_active = 1`).map((r) => String(Number(r.id))));
    for (const id of Object.keys(voices)) if (!here.has(id)) delete voices[id];
  } catch {}
}

/** Forget one person's voice (they were removed, or want it learned again). */
export function forgetPersonVoice(userId) {
  const had = !!load()[String(Number(userId))];
  delete voices[String(Number(userId))];
  if (had) save();
  return had;
}

/** For the app and the logs: { turns, ready } for one person. */
export function personVoiceState(userId) {
  const p = load()[String(Number(userId))];
  return { turns: p?.pool?.length || 0, ready: !!p?.centre };
}

export function resetPersonVoices() { voices = {}; save(); }
