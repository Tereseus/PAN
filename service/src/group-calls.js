// group-calls.js — a call with a whole group on this ΠAN ("PAN, call the Kids").
//
// The owner, 2026-11-18: a call with a whole group, as there is a call between two people
// (person-messages.js). It works the same way: what each person says is heard by their own
// device, written down, and read out by the devices of the others who are on. The voice
// itself is not sent.
//
// The rules:
//   - What can be called: a group inside the organization (people-groups.js), or everyone on
//     this hub ("PAN, call everyone", or by the organization's name).
//   - Who may start one: someone in that group. The owner may call any group, in it or not.
//     Calling everyone is open to everyone here. It needs the `group_calls` limit (people.js).
//   - Starting it rings the others. Nothing a person says is passed on until they come on by
//     their own act ("PAN, answer", "PAN, join the Kids", or Answer in the app). Someone who
//     takes no calls from the one who started it (people_call_block) is not rung.
//   - While a person is on, every line they say that does not name ΠAN goes to the others who
//     are on as their words, exactly as heard: never through the part of ΠAN that acts on what
//     it hears, never rewritten by a model. With three or more on, each line comes with who
//     said it. ΠAN says nothing back.
//   - A line is heard by those on at that moment, and only they (and the one who said it) can
//     read it afterwards. Coming on later does not show what was said before.
//   - Anyone leaves with "PAN, hang up" or Leave. The call is over when the last one leaves,
//     when one person is left with nobody still being rung, or after five quiet minutes.
//   - A person is in one call at a time: coming on here ends their call with one person, and
//     calling one person leaves this.
//   - The voice itself goes through call-voice.js, as in a call between two. Someone the voice
//     is reaching is only shown the written line; the others have it read out.
//   - Calls are kept in memory: a restart ends them. The lines are kept in the hub's own
//     database (group_lines).

import { all, get, run } from './db.js';
import { addNote, userAsking } from './phone-notes.js';
import { may } from './people.js';
import { groupsHere } from './people-groups.js';
import { peopleHere, talkOf, endTalk, callsBlocked, saysHangUp, messageMode } from './person-messages.js';
import { voiceLive } from './call-voice.js';

const OWNER_ID = 1;
const IDLE_MS = 5 * 60_000;
const PER_MINUTE = 40;
const MAX_BODY = 500;
const PAGE = 60;
const PAN_NAMED = /\b(?:pan|pam|pann)\b/i;
const letters = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const wordKey = (w) => String(w || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// room key ('all' or 'g<group id>') -> { key, name, by, since, last, on: Map<user id, { since, heard, sent }>, ringing: Set<user id> }
const rooms = new Map();
const lineTimes = new Map();

let schemaReady = false;
export function ensureGroupCallsSchema() {
  if (schemaReady) return;
  run(`CREATE TABLE IF NOT EXISTS group_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    room_name TEXT NOT NULL,
    from_user INTEGER NOT NULL,
    body TEXT NOT NULL,
    how TEXT NOT NULL DEFAULT 'talk',
    heard_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  run(`CREATE INDEX IF NOT EXISTS idx_group_lines_room ON group_lines (room, id)`);
  schemaReady = true;
}

/** What the owner calls the people on this hub ("Family"), or '' until it is named. */
function orgName() {
  try { return String(get("SELECT value FROM settings WHERE key = 'people_group_name'")?.value || '').replace(/^"|"$/g, '').trim().slice(0, 30); } catch { return ''; }
}

/**
 * What can be called, for one person: [{ key, name, members: [user id], mine }]. mine: this
 * person may start or join it. Everyone first, then the groups.
 */
export function callable(userId) {
  const me = Number(userId) || OWNER_ID;
  const here = peopleHere().map((p) => p.id);
  const out = [{ key: 'all', name: orgName() || 'Everyone', members: here, mine: here.includes(me) }];
  for (const g of groupsHere()) out.push({ key: `g${g.id}`, name: g.name, members: g.members, mine: me === OWNER_ID || g.members.includes(me) });
  return out;
}

const firstOf = (id) => peopleHere().find((p) => p.id === Number(id))?.first || 'Someone';
const noteTo = (userId, fields, now, keepMs = 60_000) => addNote(fields, { toUser: userId, keepMs, now });

// A call nobody has spoken in for five minutes is over; whoever was still being rung is told.
function sweep(now) {
  for (const [key, r] of rooms) {
    if (now - r.last <= IDLE_MS) continue;
    rooms.delete(key);
    for (const id of r.ringing) noteTo(id, { type: 'message', title: r.name, body: `Missed call from ${r.name}.`, data: { kind: 'talk', room: key, room_name: r.name, from_user: r.by, call: 'gone' } }, now, 30_000);
    console.log(`[group-call] ${key} ended: quiet for five minutes`);
  }
}

/** The call this person is on, or null. */
export function roomOf(userId, now = Date.now()) {
  sweep(now);
  const me = Number(userId);
  for (const r of rooms.values()) if (r.on.has(me)) return r;
  return null;
}

/** Whether this person's device should ask for its notes every second: on a group call, or being rung by one. */
export function roomFast(userId, now = Date.now()) {
  sweep(now);
  const me = Number(userId);
  for (const r of rooms.values()) if (r.on.has(me) || r.ringing.has(me)) return true;
  return false;
}

const shape = (r) => ({ key: r.key, name: r.name, by: r.by, since: r.since,
  on: [...r.on.keys()].map((id) => ({ id, first: firstOf(id) })), ringing: [...r.ringing] });

/**
 * For the app. on: the call this person is on. ringing: the calls ringing them, newest first.
 * open: the calls going on that they could join. can: what they may start a call with
 * (start false: this person may not start one, so nothing).
 */
export function roomState(userId, now = Date.now(), { start = true } = {}) {
  sweep(now);
  const me = Number(userId) || OWNER_ID;
  const mine = new Set(callable(me).filter((c) => c.mine && c.members.some((id) => id !== me)).map((c) => c.key));
  const on = [...rooms.values()].find((r) => r.on.has(me)) || null;
  return {
    on: on ? shape(on) : null,
    ringing: [...rooms.values()].filter((r) => r.ringing.has(me)).sort((a, b) => b.since - a.since).map(shape),
    open: [...rooms.values()].filter((r) => !r.on.has(me) && mine.has(r.key)).map(shape),
    can: start ? [...mine] : [],
  };
}

// One call at a time: whatever else this person is in closes first.
function leaveEverythingElse(person, key, now) {
  const me = person ? Number(person.id) : OWNER_ID;
  if (talkOf(me, now)) endTalk(person, now);
  const other = roomOf(me, now);
  if (other && other.key !== key) leaveRoom(person, now);
}

/**
 * Start a call with a group, or come on to the one that is going. key: 'all' | 'g<id>'.
 * -> { ok, started, room } | { ok: false, reason: 'limit' | 'group' | 'not_in' | 'alone' | 'not_taking', name? }
 */
export function startRoom(person, key, now = Date.now()) {
  sweep(now);
  const me = person ? Number(person.id) : OWNER_ID;
  if (person && !may(person, 'messages')) return { ok: false, reason: 'limit' };
  const what = callable(me).find((c) => c.key === String(key));
  if (!what) return { ok: false, reason: 'group' };
  if (!what.mine) return { ok: false, reason: 'not_in', name: what.name };
  const others = what.members.filter((id) => id !== me);
  if (!others.length) return { ok: false, reason: 'alone', name: what.name };
  const mine = firstOf(me);
  const open = rooms.get(what.key);
  if (open) {
    if (open.on.has(me)) return { ok: true, started: false, room: shape(open) };
    leaveEverythingElse(person, what.key, now);
    open.ringing.delete(me);
    for (const id of open.on.keys()) noteTo(id, { type: 'speak', title: mine, body: `${mine} is on.`, data: { kind: 'talk', room: open.key, room_name: open.name, from_user: me, call: 'on' } }, now);
    open.on.set(me, { since: now, heard: [], sent: null });
    open.last = now;
    console.log(`[group-call] person ${me} came on to ${open.key} (${open.on.size} on)`);
    return { ok: true, started: false, room: shape(open) };
  }
  // Starting one is its own limit; coming on to one that is going (above) is not.
  if (person && !may(person, 'group_calls')) return { ok: false, reason: 'limit' };
  const ring = others.filter((id) => !callsBlocked(id, me));
  if (!ring.length) return { ok: false, reason: 'not_taking', name: what.name };
  leaveEverythingElse(person, what.key, now);
  const r = { key: what.key, name: what.name, by: me, since: now, last: now, on: new Map([[me, { since: now, heard: [], sent: null }]]), ringing: new Set(ring) };
  rooms.set(r.key, r);
  for (const id of ring) {
    noteTo(id, { type: 'speak', title: mine, body: `${mine} is calling ${r.name}. Say: PAN, answer.`,
      data: { kind: 'talk', room: r.key, room_name: r.name, from_user: me, call: 'ring' } }, now);
  }
  console.log(`[group-call] person ${me} called ${r.key}, ringing ${ring.length}`);
  return { ok: true, started: true, room: shape(r), reachable: ring.filter((id) => userAsking(id, now)).length };
}

function close(r, now, { tell = null } = {}) {
  rooms.delete(r.key);
  for (const id of r.ringing) noteTo(id, { type: 'message', title: r.name, body: `Missed call from ${r.name}.`, data: { kind: 'talk', room: r.key, room_name: r.name, from_user: r.by, call: 'gone' } }, now, 30_000);
  for (const id of r.on.keys()) if (tell) noteTo(id, { type: 'speak', title: r.name, body: tell, data: { kind: 'talk', room: r.key, room_name: r.name, from_user: r.by, call: 'ended' } }, now);
  console.log(`[group-call] ${r.key} ended`);
}

/** This person leaves the call they are on. -> the call's name, or null (they were on none) */
export function leaveRoom(person, now = Date.now()) {
  const me = person ? Number(person.id) : OWNER_ID;
  const r = roomOf(me, now);
  if (!r) return null;
  r.on.delete(me);
  const mine = firstOf(me);
  console.log(`[group-call] person ${me} left ${r.key} (${r.on.size} on)`);
  if (!r.on.size) close(r, now);
  else if (r.on.size === 1 && !r.ringing.size) close(r, now, { tell: `${mine} left. The call with ${r.name} is over.` });
  else for (const id of r.on.keys()) noteTo(id, { type: 'speak', title: mine, body: `${mine} left the call.`, data: { kind: 'talk', room: r.key, room_name: r.name, from_user: me, call: 'left' } }, now);
  return r.name;
}

/**
 * Someone being rung says no. Nothing of theirs was ever passed on. When nobody is left to
 * come on, the one waiting is told and the call is over. -> the call's name, or null
 */
export function declineRoom(person, key, now = Date.now()) {
  sweep(now);
  const me = person ? Number(person.id) : OWNER_ID;
  const r = rooms.get(String(key));
  if (!r || !r.ringing.has(me)) return null;
  r.ringing.delete(me);
  console.log(`[group-call] person ${me} declined ${r.key}`);
  if (!r.ringing.size && r.on.size === 1) close(r, now, { tell: `Nobody in ${r.name} can talk right now.` });
  return r.name;
}

function mayLineNow(senderId, now) {
  const recent = (lineTimes.get(senderId) || []).filter((t) => now - t < 60_000);
  if (recent.length >= PER_MINUTE) { lineTimes.set(senderId, recent); return false; }
  recent.push(now);
  lineTimes.set(senderId, recent);
  return true;
}

// The words go to everyone else who is on, and are kept for those who heard them.
function pass(r, me, body, how, now) {
  const text = String(body || '').trim().replace(/\s+/g, ' ').slice(0, MAX_BODY);
  if (!letters(text)) return { ok: false, reason: 'empty' };
  if (!mayLineNow(me, now)) return { ok: false, reason: 'too_many' };
  ensureGroupCallsSchema();
  const others = [...r.on.keys()].filter((id) => id !== me);
  const id = Number(run(`INSERT INTO group_lines (room, room_name, from_user, body, how, heard_by, created_at) VALUES (:r, :n, :f, :b, :h, :by, :at)`,
    { ':r': r.key, ':n': r.name, ':f': me, ':b': text, ':h': how === 'typed' ? 'typed' : 'talk', ':by': `,${others.join(',')},`, ':at': now }).lastInsertRowid);
  const mine = firstOf(me);
  const stop = /[.!?]$/.test(text) ? '' : '.';
  for (const to of others) {
    // Their own loudspeaker will say these words: heard again by their microphone, they are not theirs.
    const e = r.on.get(to);
    e.heard = [...e.heard.filter((h) => now - h.at < 20_000), { k: letters(text), at: now }].slice(-8);
    // With two on it is as a call between two: the words alone. With more, who said them comes first.
    // Their voice itself is reaching this one (call-voice.js): the line is only shown.
    const live = how === 'talk' && voiceLive(me, to, now);
    noteTo(to, { type: live || messageMode(to).mode === 'show' ? 'message' : 'speak', title: mine,
      body: others.length > 1 ? `${mine}: ${text}${stop}` : `${text}${stop}`,
      data: { kind: 'message', room: r.key, room_name: r.name, from_user: me, line_id: id, talk: true, live: live || undefined } }, now);
  }
  r.last = now;
  return { ok: true, id, to: others };
}

/**
 * A line heard on the device of someone on a group call. -> null (on no call, or the line is
 * ΠAN's to handle) | { room, sent, reason?, ended?, name? } (handled: ΠAN answers nothing).
 * wearer false: the hub is sure it was someone else's voice.
 */
export function roomLine(text, { person = null, wearer } = {}, now = Date.now()) {
  const me = person ? Number(person.id) : OWNER_ID;
  const r = roomOf(me, now);
  if (!r) return null;
  const said = String(text || '').trim();
  if (!letters(said) || wearer === false) return null;
  if (saysHangUp(said)) return { room: r.key, sent: false, ended: true, name: leaveRoom(person, now) };
  if (PAN_NAMED.test(said)) return null;
  if (person && !may(person, 'messages')) return null;
  const e = r.on.get(me);
  const k = letters(said);
  if (e.heard.some((h) => now - h.at < 20_000 && (h.k === k || (k.length > 12 && (h.k.includes(k) || k.includes(h.k)))))) return { room: r.key, sent: false, reason: 'echo' };
  // A line that grew: only the new end goes on (as in a call between two).
  const tokens = said.split(/\s+/);
  const words = tokens.map(wordKey);
  let body = said;
  if (e.sent && now - e.sent.at < 15_000 && words.length >= e.sent.words.length) {
    const n = e.sent.words.length;
    const same = e.sent.words.filter((w, i) => w === words[i]).length;
    if (same >= Math.ceil(n * 0.7)) body = tokens.slice(n).join(' ');
  }
  e.sent = { words, at: now };
  if (!letters(body)) return { room: r.key, sent: false, reason: 'again' };
  const sent = pass(r, me, body, 'talk', now);
  if (sent.ok) console.log(`[group-call] person ${me} in ${r.key}: a line passed on to ${sent.to.length}`);
  return { room: r.key, sent: !!sent.ok, reason: sent.ok ? undefined : sent.reason };
}

/** A typed line (or ΠAN's answer, shared) from someone who is on. -> { ok, id } | { ok: false, reason } */
export function sayInRoom(person, text, now = Date.now()) {
  const me = person ? Number(person.id) : OWNER_ID;
  const r = roomOf(me, now);
  if (!r) return { ok: false, reason: 'no_call' };
  if (person && !may(person, 'messages')) return { ok: false, reason: 'limit' };
  return pass(r, me, text, 'typed', now);
}

/**
 * The lines of one group's calls that this person said or heard, oldest first.
 * -> { room: { key, name }, lines: [{ id, from, name, from_me, body, how, at }], more } | null
 */
export function roomLines(userId, key, { before = 0, limit = PAGE } = {}) {
  const me = Number(userId) || OWNER_ID;
  const what = callable(me).find((c) => c.key === String(key));
  if (!what || !what.mine) return null;
  ensureGroupCallsSchema();
  const n = Math.min(Math.max(Number(limit) || PAGE, 1), 200);
  const rows = all(`SELECT id, from_user, body, how, created_at FROM group_lines
    WHERE room = :r AND (from_user = :u OR heard_by LIKE :like) AND (:before = 0 OR id < :before) ORDER BY id DESC LIMIT :n`,
    { ':r': what.key, ':u': me, ':like': `%,${me},%`, ':before': Number(before) || 0, ':n': n + 1 });
  const names = new Map(peopleHere().map((p) => [p.id, p.first]));
  return { room: { key: what.key, name: what.name }, more: rows.length > n,
    lines: rows.slice(0, n).reverse().map((x) => ({ id: Number(x.id), from: Number(x.from_user), name: names.get(Number(x.from_user)) || 'Someone',
      from_me: Number(x.from_user) === me, body: x.body, how: x.how, at: Number(x.created_at) })) };
}

/**
 * Is this line, said to ΠAN, about a group call? others: nothing. -> null
 * | { talk: 'room', room, name } ("call the Kids", "join the Kids", "call everyone")
 * | { talk: 'join' } ("join the call", "join")
 * lead, tail: the regex pieces person-messages.js uses for its own call lines.
 */
export function parseRoom(said, userId, { lead, tail }) {
  if (new RegExp(`${lead}join(?:\\s+(?:in|the\\s+call|the\\s+group\\s+call|them))?${tail}`, 'iu').test(said)) return { talk: 'join' };
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = new Map();   // how it may be said -> key
  for (const c of callable(userId)) {
    names.set(c.name.trim().split(/\s+/).map(esc).join('\\s+'), c.key);
    if (c.key === 'all') for (const w of ['everyone', 'everybody', 'every\\s+one', 'all\\s+of\\s+them']) names.set(w, 'all');
  }
  const alt = [...names.keys()].sort((a, b) => b.length - a.length).join('|');
  const m = new RegExp(`${lead}(?:(?:talk|speak)\\s+(?:to|with)|call(?:ed)?|join|answer|(?:start|open)\\s+a\\s+(?:group\\s+)?(?:call|talk)\\s+with)\\s+(?:the\\s+|my\\s+|our\\s+)?(?:whole\\s+|entire\\s+)?(${alt})(?:\\s+(?:group|team|call))?${tail}`, 'iu').exec(said);
  if (!m) return null;
  const hit = [...names].find(([re]) => new RegExp(`^${re}$`, 'iu').test(m[1]));
  if (!hit) return null;
  const c = callable(userId).find((x) => x.key === hit[1]);
  return { talk: 'room', room: c.key, name: c.name };
}

/** For the tests: no group calls. */
export function resetRooms() { rooms.clear(); lineTimes.clear(); }
