// phone-notes.js — notes waiting to be picked up by a device, and which device gets each one.
//
// A note is something PAN wants shown or read out on a device: a Slack message, a reminder, a
// thread's answer that came after the voice turn closed. Devices have no way to be pushed to, so
// each asks for its notes every few seconds (GET /api/v1/slack/pending).
//
// Until 2026-11-18 this was one queue emptied by whichever device asked first: with a phone, a
// tablet and a car all running the app, a reminder was read out by any of them. The owner's rule
// (docs/PEOPLE-PLAN.md): a note goes to the device of the person it is for.
//
//   - A note is FOR a person (to_user; the owner unless said). A device that belongs to someone
//     else never gets it. Whose a device is comes from PAN Link's key (people.js), not from
//     anything the device says.
//   - A note can also name the one device it answers (to_device: the device that asked a thread
//     something). That device gets it; if it is not asking any more, it goes on as below.
//   - The owner's notes go to HIS device: the one pinned in the setting `notes_device`, else the
//     one he last spoke to PAN on. While that device is away (it has not asked for 30 s) nothing
//     is lost: after a short wait any of his devices takes the note.
//   - A note nobody picked up is dropped when it is stale: a reminder read out an hour late is noise.
//
// In memory on purpose, like the queue it replaces: a Craft swap empties it, and ids are seeded
// from the clock so a device's high-water mark stays valid across one.

import { get } from './db.js';

export const OWNER_ID = 1;
const MAX_NOTES = 80;
const AWAY_MS = 30_000;            // a device that has not asked for this long is taken to be away
const ASKER_WAIT_MS = 20_000;      // how long a note waits for the device that asked
const PINNED_WAIT_MS = 120_000;    // how long a note waits for the pinned device before another takes it
const LAST_SPOKE_MS = 12 * 3600_000;
const TTL_MS = { speak: 10 * 60_000 };
const TTL_DEFAULT_MS = 12 * 3600_000;
export const SPEAK_PER_MINUTE = 6;

let queue = [];
let seq = Date.now();
const lastAsked = new Map();       // device key -> when it last asked for its notes
let lastSpoke = null;              // { key, at }: the owner's device he last talked to PAN on
const spokenBy = new Map();        // sender device -> times of its recent spoken notes
let pinned = { at: 0, value: '' };

/** Who sent a note: the PAN Link device whose key carried the request, never what the note says. */
export function noteSender(req) {
  const d = req?.panLinkDevice;
  return d?.id ? { device: String(d.id), name: String(d.name || '').slice(0, 60) } : null;
}

/** One device gets SPEAK_PER_MINUTE spoken notes a minute; the hub's own notes are not held back. */
export function maySpeakNow(from, now = Date.now()) {
  if (!from) return true;
  const recent = (spokenBy.get(from.device) || []).filter((t) => now - t < 60_000);
  if (recent.length >= SPEAK_PER_MINUTE) { spokenBy.set(from.device, recent); return false; }
  recent.push(now);
  spokenBy.set(from.device, recent);
  return true;
}

function pinnedDevice(now) {
  if (now - pinned.at < 10_000) return pinned.value;
  let value = '';
  try { value = String(get("SELECT value FROM settings WHERE key = 'notes_device'")?.value || '').replace(/^"|"$/g, '').trim().toLowerCase(); } catch {}
  pinned = { at: now, value };
  return value;
}

/** The owner talked to PAN on this device (a real turn, not a test): his notes follow him there. */
export function noteOwnerSpokeOn(deviceKey, now = Date.now()) {
  const key = String(deviceKey || '').toLowerCase();
  if (key && !key.endsWith('-bench')) lastSpoke = { key, at: now };
}

/**
 * Queue a note. to_user: who it is for (the owner unless said). to_device: the one device it
 * answers, when there is one. from: noteSender(req), or null for the hub's own notes.
 */
export function addNote(fields, { from = null, toUser = OWNER_ID, toDevice = null, now = Date.now() } = {}) {
  const note = { ...fields, id: ++seq, from, to_user: Number(toUser) || OWNER_ID,
    to_device: toDevice ? String(toDevice).toLowerCase() : null, at: now };
  queue.push(note);
  if (queue.length > MAX_NOTES) queue = queue.slice(-MAX_NOTES);
  return note;
}

function isAway(key, now) {
  const t = lastAsked.get(key);
  return !t || now - t > AWAY_MS;
}

// Whether this device of the owner's is the one his notes go to right now.
function ownerDeviceTakes(note, dev, now) {
  const age = now - note.at;
  if (note.to_device) {
    if (dev.keys.includes(note.to_device)) return true;
    if (age < ASKER_WAIT_MS || !isAway(note.to_device, now)) return false;
  }
  const pin = pinnedDevice(now);
  if (pin) return dev.keys.includes(pin) || (isAway(pin, now) && age > PINNED_WAIT_MS);
  if (lastSpoke && now - lastSpoke.at < LAST_SPOKE_MS) return dev.keys.includes(lastSpoke.key) || (isAway(lastSpoke.key, now) && age > ASKER_WAIT_MS);
  return true;   // nothing says which device is his: whichever asks, as before
}

/**
 * The notes for the device that is asking, taken off the queue.
 * dev: { key, linkDevice, person } — key is what the device calls itself (trusted only for the
 * owner's devices), linkDevice its PAN Link id, person the person it belongs to (null: the owner).
 */
export function takeNotesFor({ key = '', linkDevice = '', person = null } = {}, now = Date.now()) {
  const keys = [String(key || '').toLowerCase(), String(linkDevice || '').toLowerCase()].filter(Boolean);
  for (const k of keys) lastAsked.set(k, now);
  queue = queue.filter((n) => now - n.at < (TTL_MS[n.type] ?? TTL_DEFAULT_MS));
  const dev = { keys };
  const mine = (n) => {
    if (person) {
      // A person's device: only what is for that person, and it is named by its link id alone.
      if (n.to_user !== Number(person.id) || !person.id) return false;
      return !n.to_device || n.to_device === String(linkDevice).toLowerCase() || now - n.at > ASKER_WAIT_MS;
    }
    return n.to_user === OWNER_ID && ownerDeviceTakes(n, dev, now);
  };
  const out = queue.filter(mine);
  if (out.length) queue = queue.filter((n) => !out.includes(n));
  return out.map(({ at, to_user, to_device, ...rest }) => rest);
}

/**
 * For the owner's "notes come to this device" control: the devices of his that have asked for
 * notes lately (by the name each sends), which one is pinned, and which he last talked on.
 */
export function notesDevices(now = Date.now()) {
  const asking = [...lastAsked].filter(([k, t]) => now - t < 10 * 60_000 && !/^d[0-9a-f]{12}$/.test(k))
    .map(([key, t]) => ({ key, away: now - t > AWAY_MS })).sort((a, b) => a.key.localeCompare(b.key));
  return { pinned: pinnedDevice(now) || null, last_spoke: lastSpoke && now - lastSpoke.at < LAST_SPOKE_MS ? lastSpoke.key : null, asking };
}

/** For the tests and the log: how many notes wait, and for whom. */
export function notesWaiting() {
  return queue.map((n) => ({ id: n.id, type: n.type, to_user: n.to_user, to_device: n.to_device }));
}

export function resetNotes() {
  queue = []; lastAsked.clear(); lastSpoke = null; spokenBy.clear(); pinned = { at: 0, value: '' };
}
