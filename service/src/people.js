// people.js — which person a paired device belongs to, and what that person may do.
//
// Until 2026-11-18 every request that reached PAN was the owner: a device paired through PAN
// Link was told apart by its key, and then treated as user 1 all the same. Roles existed and
// stopped almost nothing (docs/PEOPLE-PLAN.md). This is the one place that answers the two
// questions everything else asks: who is this, and may they do that.
//
// - A pairing code can be made FOR a person. pan-link reserves a tunnel address for the device
//   that will use the code and says which (device_ip); PAN keeps "that address is for user N"
//   here and binds the device to the person when it shows up paired. No change in pan-link.
// - A device nobody was named for belongs to the owner, as before.
// - A shared device (a TV, the car) belongs to the owner of the organization, who may say
//   "only listen to me" on it (only_user_id).
// - may(person, action) is the one check. The starting limits are below; the owner changes
//   them in the setting people_limits, as { "<action>": <least power> }.

import { get, run, all } from './db.js';

/** The least power an action needs. Owner 100, admin 75, manager 50, user 25, guest 15, child 5. */
export const LIMITS = Object.freeze({
  talk: 0,             // ask, be answered, interpret
  camera: 5,           // "what is this"
  own_memory: 5,       // recall what they themselves said
  home: 15,            // lights, heating, the TV
  messages: 15,        // send a message to a person
  computer: 25,        // run a job on a computer, the terminal
  thread: 25,          // talk to a Claude thread
  lend_device: 50,     // lend a shared device to someone
  approve_device: 75,  // let a new computer in
  others_memory: 100,  // read what someone else said
  pair_device: 100,    // make a pairing code
  set_limits: 100,     // change this list
});

// What a device that belongs to a person other than the owner may reach, as pan-link allow rules
// (pan-link/allow.go). pan-link refuses everything else before PAN sees it, WebSockets and
// pages included; PAN checks the same list again for /api. A path nobody listed is closed.
// Short on purpose: a path joins this list when what it answers is that person's own, not the
// owner's. Talking (/api/v1/query/stream) is not on it yet: the voice path still builds its
// prompt from the owner's situation, memory and name (docs/PEOPLE-PLAN.md, Progress).
export const PERSON_ALLOW = Object.freeze([
  'GET /health',
  'GET /api/v1/auth/me',
  'GET /api/v1/apk/version',
  'GET /apk/latest',
  'POST /api/v1/logs',
]);

/** The allow rules for a device of this person's: none for the owner (no limit). */
export function allowFor(person) {
  return !person || person.role === 'owner' ? [] : [...PERSON_ALLOW];
}

/** Whether a person's device may send this request (the same rules pan-link applies). */
export function personMaySend(method, path) {
  const m = String(method || '').toUpperCase();
  const p = String(path || '').split('?')[0];
  if (!p.startsWith('/') || p.includes('//') || p.includes('/.') || p.includes('%')) return false;
  return PERSON_ALLOW.some((rule) => {
    const [rm, rp] = rule.split(' ');
    if (rm !== '*' && rm !== m) return false;
    return rp.endsWith('/*') ? p.startsWith(rp.slice(0, -1)) : p === rp;
  });
}

/** The memory a person's words go to: a database of their own (db-registry.js). null: the owner's. */
export function scopeFor(person) {
  return !person || person.role === 'owner' ? null : `person-${Number(person.id) || 0}`;
}

/** The person as a request's user (req.user). */
export function asUser(person) {
  return { id: person.id, email: person.email, display_name: person.display_name, role: person.role,
    realPower: person.power, power: person.power, isImpersonating: false, impersonation: null,
    person: true, shared: !!person.shared };
}

const ROLE_POWER = Object.freeze({ owner: 100, admin: 75, manager: 50, user: 25, viewer: 0, guest: 15, child: 5 });

let schemaReady = false;
export function ensurePeopleSchema() {
  if (schemaReady) return;
  run(`CREATE TABLE IF NOT EXISTS device_people (
    link_device_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    shared INTEGER NOT NULL DEFAULT 0,
    only_user_id INTEGER,
    set_at INTEGER NOT NULL
  )`);
  run(`CREATE TABLE IF NOT EXISTS pairing_for (
    device_ip TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    shared INTEGER NOT NULL DEFAULT 0,
    expires INTEGER NOT NULL
  )`);
  schemaReady = true;
}

function userRow(id) {
  const u = get('SELECT id, email, display_name, role, power_lvl, is_active FROM users WHERE id = :id', { ':id': id });
  if (!u || !u.is_active) return null;
  const power = Number.isFinite(u.power_lvl) && u.power_lvl !== null ? u.power_lvl : (ROLE_POWER[u.role] ?? 0);
  return { id: u.id, email: u.email, display_name: u.display_name, role: u.role, power };
}

// ── Pairing codes made for a person ──────────────────────────────────────────

/** The code just made reserves [deviceIp]; the device that pairs with it is [userId]'s. */
export function notePairingFor(deviceIp, userId, { shared = false, expires = Date.now() + 10 * 60_000 } = {}) {
  ensurePeopleSchema();
  if (!deviceIp || !userRow(userId)) return false;
  run(`INSERT INTO pairing_for (device_ip, user_id, shared, expires) VALUES (:ip, :u, :s, :e)
       ON CONFLICT(device_ip) DO UPDATE SET user_id = :u, shared = :s, expires = :e`,
    { ':ip': String(deviceIp), ':u': userId, ':s': shared ? 1 : 0, ':e': expires });
  waiting = { at: 0, any: true };
  return true;
}

/** Whether any code made for a person is still waiting for its device. */
export function pairingsWaiting(now = Date.now()) {
  ensurePeopleSchema();
  // Asked on every request from a paired device, so the answer is kept for a few seconds.
  if (waiting.at && now >= waiting.at && now - waiting.at < 5000) return waiting.any;
  // A code that ran out is kept a while longer: the device may have paired in its last second
  // and not sent anything yet. Forgetting it would make that device the owner's.
  run('DELETE FROM pairing_for WHERE expires < :t', { ':t': now - 24 * 3600_000 });
  waiting = { at: now, any: (get('SELECT COUNT(*) AS n FROM pairing_for')?.n || 0) > 0 };
  return waiting.any;
}
let waiting = { at: 0, any: false };

/**
 * Binds the devices that used a code made for a person. [devices] is pan-link's list
 * ([{ id, tunnel_ip }]). Returns how many were bound.
 */
export function claimPairings(devices, now = Date.now()) {
  ensurePeopleSchema();
  let bound = 0;
  for (const d of Array.isArray(devices) ? devices : []) {
    if (typeof d?.id !== 'string' || !d.tunnel_ip) continue;
    const p = get('SELECT * FROM pairing_for WHERE device_ip = :ip', { ':ip': String(d.tunnel_ip) });
    if (!p) continue;
    run('DELETE FROM pairing_for WHERE device_ip = :ip', { ':ip': p.device_ip });
    if (get('SELECT 1 AS x FROM device_people WHERE link_device_id = :d', { ':d': d.id })) continue;
    run('INSERT INTO device_people (link_device_id, user_id, shared, set_at) VALUES (:d, :u, :s, :t)',
      { ':d': d.id, ':u': p.user_id, ':s': p.shared, ':t': now });
    bound++;
  }
  if (bound) cache.clear();
  waiting = { at: 0, any: false };
  return bound;
}

// ── Who a device is ──────────────────────────────────────────────────────────

const cache = new Map();   // link device id -> { at, value }
const CACHE_MS = 30_000;

/**
 * The person behind a paired device: { id, display_name, role, power, shared, only_user_id },
 * or null for a device nobody was named for (the caller treats that as the owner).
 * A device bound to someone who has since been removed is nobody: { id: 0, role: 'guest', power: 0 }.
 */
export function personOfDevice(linkDeviceId, now = Date.now()) {
  ensurePeopleSchema();
  const hit = cache.get(linkDeviceId);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const b = get('SELECT * FROM device_people WHERE link_device_id = :d', { ':d': String(linkDeviceId) });
  let value = null;
  if (b) {
    const u = userRow(b.user_id);
    value = u ? { ...u, shared: !!b.shared, only_user_id: b.only_user_id ?? null }
      : { id: 0, email: '', display_name: 'Nobody', role: 'guest', power: 0, shared: !!b.shared, only_user_id: null };
  }
  cache.set(linkDeviceId, { at: now, value });
  return value;
}

/** The owner hands a device to a person, or takes it back (userId null: the owner's again). */
export function setDevicePerson(linkDeviceId, userId, { shared = false } = {}) {
  ensurePeopleSchema();
  cache.delete(linkDeviceId);
  if (userId === null || userId === undefined) {
    run('DELETE FROM device_people WHERE link_device_id = :d', { ':d': String(linkDeviceId) });
    return true;
  }
  if (!userRow(userId)) return false;
  run(`INSERT INTO device_people (link_device_id, user_id, shared, set_at) VALUES (:d, :u, :s, :t)
       ON CONFLICT(link_device_id) DO UPDATE SET user_id = :u, shared = :s, only_user_id = NULL, set_at = :t`,
    { ':d': String(linkDeviceId), ':u': userId, ':s': shared ? 1 : 0, ':t': Date.now() });
  return true;
}

/** "Only listen to me" on a shared device, or null to open it again. Owner of the device only. */
export function setOnlyListenTo(linkDeviceId, userId) {
  ensurePeopleSchema();
  cache.delete(linkDeviceId);
  const r = run('UPDATE device_people SET only_user_id = :u WHERE link_device_id = :d AND shared = 1',
    { ':u': userId ?? null, ':d': String(linkDeviceId) });
  return (r?.changes || 0) > 0;
}

/** A device was removed from PAN Link: its binding goes with it. */
export function forgetDevice(linkDeviceId) {
  ensurePeopleSchema();
  cache.delete(linkDeviceId);
  run('DELETE FROM device_people WHERE link_device_id = :d', { ':d': String(linkDeviceId) });
}

export function devicePeople() {
  ensurePeopleSchema();
  return all(`SELECT dp.link_device_id, dp.user_id, dp.shared, dp.only_user_id, dp.set_at, u.display_name, u.role
              FROM device_people dp LEFT JOIN users u ON u.id = dp.user_id ORDER BY dp.set_at`);
}

// ── What a person may do ─────────────────────────────────────────────────────

let limitsCache = { at: 0, value: LIMITS };

/** The limits in force: the starting list with the owner's changes over it. */
export function limits(now = Date.now()) {
  if (now - limitsCache.at < CACHE_MS) return limitsCache.value;
  let value = LIMITS;
  try {
    const row = get("SELECT value FROM settings WHERE key = 'people_limits'");
    const set = row?.value ? JSON.parse(String(row.value)) : null;
    if (set && typeof set === 'object') {
      const merged = { ...LIMITS };
      // Only actions that exist, only whole powers from 0 to 100.
      for (const [k, v] of Object.entries(set)) if (k in LIMITS && Number.isInteger(v) && v >= 0 && v <= 100) merged[k] = v;
      value = merged;
    }
  } catch { /* an unreadable setting changes nothing */ }
  limitsCache = { at: now, value };
  return value;
}

export function resetPeopleCache() { cache.clear(); limitsCache = { at: 0, value: LIMITS }; waiting = { at: 0, any: false }; }

/** Whether [person] may do [action]. An action nobody has named is refused. No person is the owner. */
export function may(person, action) {
  const need = limits()[action];
  if (need === undefined) return false;
  const power = person ? Number(person.power) : 100;
  return Number.isFinite(power) && power >= need;
}

/** The plain sentence PAN says when it will not do something for this person. */
export function refusal(action) {
  const what = { computer: 'run things on a computer', thread: 'talk to a Claude thread', home: 'control the house',
    messages: 'send messages', camera: 'use the camera', own_memory: 'look things up in memory',
    others_memory: "look at someone else's memory", lend_device: 'lend a device', approve_device: 'let a new device in',
    pair_device: 'pair a device', set_limits: 'change what people may do' }[action] || 'do that';
  return `I can't ${what} for you. Whoever set me up decides that.`;
}
