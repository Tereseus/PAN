// person-messages.js — a spoken message from one person on this ΠAN to another.
//
// "PAN, tell Maria dinner is ready": Maria's own device says "Sam says: dinner is ready." and
// shows it (phone-notes.js carries it to her device and to nobody else's). It works both ways
// and between any two people on the hub, the owner included.
//
// The rules (docs/PEOPLE-PLAN.md):
//   - The words are passed on as the sender's words, exactly as heard. They never go through the
//     part of ΠAN that acts on what it hears, and no model rewrites them: a message is words,
//     never an order to the ΠAN that reads it out.
//   - It is a message only when the line is said to ΠAN (its name, or ΠAN spoke a moment ago).
//     "Tell Maria dinner is ready" said across the room to someone else sends nothing.
//   - The name is the first name of a person on this hub, or their whole name. Anyone else
//     ("tell my boss ...") is not a message of this kind and the line goes on as ordinary talk.
//     When two people here share a first name, ΠAN asks which one and the next line answers
//     it with the whole name or the rest of it ("Lopez").
//   - A call ("PAN, talk to Maria"; the owner, 2026-11-18: voice, as if it were a phone call).
//     While a person has a call open, every line they say that does not name ΠAN goes to the
//     other person as their words, and ΠAN says nothing back. Only a person's OWN act opens
//     their side: being called passes none of what the called person says until they answer
//     ("PAN, talk to Sam", or "PAN, answer"). The words are heard, written down and read out
//     by the other ΠAN: the voice itself is not sent. It ends on "PAN, hang up", when either
//     side ends it, or after five quiet minutes. Calls are kept in memory: a restart ends them.
//   - Read out or shown only (the owner, 2026-11-18): each person chooses whether what is sent
//     to them is read out loud on their device or only shown. The owner can set it for anyone
//     and lock it; a locked choice is not the person's to change.
//   - The owner can read a child's conversations (the owner's call, 2026-11-18): only a person
//     whose role is child, only the owner, and the child's own People tab says so.
//   - Names as they are heard (the owner's own test, 2026-11-18: a name came back from the
//     speech model spelled another way and nothing was sent). A name that is not anyone's but
//     sounds like exactly one person here is taken as that person, and the reply says who got
//     it. A person can also be given other names to go by (people_nicknames): the owner sets
//     them for anyone, a person for themselves.
//   - "Hang up" inside a longer line ends a call too ("Right. Hang up. PAN, end the call."), and in
//     a call it needs no name: a sentence that is only that is never words for the other person.
//   - A person needs the `messages` limit (people.js). The owner always may.
//   - One sender, six messages a minute.
//
// Kept in the hub's own database (person_messages), so a restart loses nothing. Two things
// happen to a message, and they are separate:
//   - It is handed to a device of the person it is for, which says it and shows it. A device
//     asks for what waits every few seconds; a message waits twelve hours to be said, after
//     that it is too old to read out and only sits in the conversation.
//   - It stays in the conversation between the two people (the app's People tab), marked new
//     until that person opens it. Only those two people can open it.

import { get, all, run } from './db.js';
import { maySpeakNow, userAsking, ownerTakesHere, nextNoteId, addNote } from './phone-notes.js';
import { may } from './people.js';

const OWNER_ID = 1;
const KEEP_MS = 12 * 3600_000;
const MAX_BODY = 500;
const PAGE = 60;

let schemaReady = false;
export function ensureMessagesSchema() {
  if (schemaReady) return;
  run(`CREATE TABLE IF NOT EXISTS person_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user INTEGER NOT NULL,
    to_user INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'says',
    body TEXT NOT NULL,
    how TEXT NOT NULL DEFAULT 'voice',
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    read_at INTEGER
  )`);
  run(`CREATE INDEX IF NOT EXISTS idx_person_messages_to ON person_messages (to_user, delivered_at)`);
  run(`CREATE INDEX IF NOT EXISTS idx_person_messages_pair ON person_messages (from_user, to_user, id)`);
  schemaReady = true;
}

const firstWord = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const key = (word) => String(word || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Everyone on this hub: [{ id, name, first, key, full, rest, role }]. The owner goes by the name ΠAN calls him. */
export function peopleHere() {
  let rows = [];
  try { rows = all(`SELECT id, display_name, role FROM users WHERE is_active = 1 ORDER BY id`); } catch {}
  let ownerName = '';
  try { ownerName = String(get(`SELECT value FROM settings WHERE key = 'display_name'`)?.value || '').replace(/^"|"$/g, '').trim(); } catch {}
  const nick = nicknames();
  return rows.map((r) => {
    const name = Number(r.id) === OWNER_ID && ownerName ? ownerName : String(r.display_name || '');
    const first = firstWord(name);
    const whole = name.trim().replace(/\s+/g, ' ');
    const aka = Array.isArray(nick[String(Number(r.id))]) ? nick[String(Number(r.id))].map(String) : [];
    return { id: Number(r.id), name: whole, first, key: key(first), full: key(whole), rest: key(whole.slice(first.length)), role: r.role, aka, also: aka.map(key) };
  }).filter((p) => p.key.length >= 2);
}

// ── Other names a person goes by ───────────────────────────────────────────────────────────
// The setting people_nicknames: { "<user id>": ["Mimi", ...] }. For a name the speech model
// cannot spell, or one nobody says in full.
const MAX_NICKNAMES = 4;
function nicknames() {
  try { return JSON.parse(get(`SELECT value FROM settings WHERE key = 'people_nicknames'`)?.value || '{}') || {}; } catch { return {}; }
}

/**
 * Set the other names [userId] goes by (an empty list removes them). by: who is asking (null:
 * the owner). A person sets their own; the owner sets anyone's. A name someone else here
 * already goes by is refused. -> { ok, names } | { ok: false, reason }
 */
export function setNicknames(userId, names, by = null) {
  const uid = Number(userId);
  const here = peopleHere();
  if (!here.some((p) => p.id === uid)) return { ok: false, reason: 'nobody' };
  if (by && Number(by.id) !== uid) return { ok: false, reason: 'not_yours' };
  if (!Array.isArray(names) || names.length > MAX_NICKNAMES) return { ok: false, reason: 'names' };
  const clean = [];
  for (const n of names) {
    const name = String(n ?? '').replace(/[^\p{L}\p{N}\s'’-]/gu, '').trim().replace(/\s+/g, ' ');
    const k = key(name);
    if (k.length < 2 || name.length > 24 || name.split(' ').length > 2) return { ok: false, reason: 'names' };
    if (NOT_A_NAME.has(k)) return { ok: false, reason: 'names' };
    if (here.some((p) => p.id !== uid && (p.key === k || p.full === k || p.also.includes(k)))) return { ok: false, reason: 'taken' };
    if (!clean.some((c) => key(c) === k)) clean.push(name);
  }
  const all_ = nicknames();
  if (clean.length) all_[String(uid)] = clean; else delete all_[String(uid)];
  const value = JSON.stringify(all_);
  run(`INSERT INTO settings (key, value) VALUES ('people_nicknames', :v) ON CONFLICT(key) DO UPDATE SET value = :v`, { ':v': value });
  return { ok: true, names: clean };
}

// Words that stand where a name would and are nobody's name.
const NOT_A_NAME = new Set(['me', 'him', 'her', 'them', 'us', 'you', 'everyone', 'everybody', 'someone', 'somebody', 'anyone',
  'anybody', 'nobody', 'that', 'this', 'the', 'what', 'who', 'all', 'pan', 'pam', 'claude', 'siri', 'alexa', 'google']);

function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
// The consonants of a name, in order: what is left when a speech model respells it.
const skeleton = (k) => k.replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1');
/** Two spellings of what is probably one name: a letter off, or the same consonants. */
function soundsLike(a, b) {
  if (a === b) return true;
  const short = Math.min(a.length, b.length);
  const d = distance(a, b);
  if ((short >= 4 && d <= 1) || (short >= 7 && d <= 2)) return true;
  const sa = skeleton(a);
  return a[0] === b[0] && sa.length >= 3 && sa === skeleton(b) && Math.abs(a.length - b.length) <= 2;
}

/**
 * Who a spoken name is, among [others]: the whole name, the first name, or a name they also
 * go by. loose: when it is nobody's, the one person whose name it sounds like (never a guess
 * between two).
 */
function who(word, others, { loose = false } = {}) {
  const k = key(word);
  if (!k) return [];
  const whole = others.filter((p) => p.full === k);
  if (whole.length) return whole;
  const named = others.filter((p) => p.key === k || p.also.includes(k));
  if (named.length || !loose) return named;
  if (k.length < 3 || NOT_A_NAME.has(k)) return [];
  const near = others.filter((p) => [p.key, ...p.also].some((n) => soundsLike(k, n)));
  return near.length === 1 ? near : [];
}

// "Which Maria?" asked of a sender, waiting for the answer: sender id -> { kind, body, among, at }.
const asked = new Map();
const ASKED_MS = 60_000;
function answerToWhich(said, senderId, now) {
  const q = asked.get(senderId);
  if (!q || now - q.at > ASKED_MS) return null;
  const k = key(said.replace(new RegExp(LEAD, 'iu'), ''));
  if (!k) return null;
  const hit = q.among.filter((p) => p.full === k || (p.rest && p.rest === k));
  if (hit.length !== 1) return null;
  return q.body.replace(/[^\p{L}\p{N}]/gu, '') ? { to: hit[0], kind: q.kind, body: q.body } : { to: hit[0], empty: true };
}

// ΠAN's name as the speech model writes it, and the small words a line starts with.
const WAKE = String.raw`(?:pan|pam|pann|pand|pahn|han|parent)`;
const LEAD = String.raw`^(?:(?:hey|hi|ok|okay|yo|oh|uh|um|a)[,\s]+)*(?:${WAKE}[,.!\s]+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?`;
const HANG_UP = new RegExp(String.raw`${LEAD}(?:hang\s+up|(?:end|stop|close)\s+(?:the\s+|this\s+|my\s+)?(?:call|talk)|stop\s+calling)(?:\s+(?:now|please|the\s+(?:call|phone)))?(?:[,\s]+${WAKE})?$`, 'iu');
/** One sentence of the line is "hang up" and nothing else ("Right. Hang up. PAN, end the call."). */
export function saysHangUp(text) {
  return String(text || '').split(/[.!?;]+/).map((s) => s.trim().replace(/[,\s]+$/, '')).some((s) => s && HANG_UP.test(s));
}
const NOT_A_PERSON = /^(?:thread|session|chat|computer|pc|laptop|desktop|machine)\b/i;

/**
 * Is this line a message for someone on this hub?
 * from: the person speaking (null: the owner). addressed: the line was said to ΠAN.
 * -> null | { to, kind: 'says' | 'asks', body } | { to, empty: true } | { which: [people], kind, body }
 *    | { talk: 'start', to } | { talk: 'answer' } | { talk: 'end' } | { talk: 'which', among }
 * which: two or more people here go by the name that was said. talk: a call (see talkTurn).
 */
export function parseMessage(text, { from = null, addressed = false, now = Date.now() } = {}) {
  if (!addressed) return null;
  const said = String(text || '').trim().replace(/[,\s]+(?:pan|pam)[.!?\s]*$/i, '').trim();
  if (!said) return null;
  const me = from ? Number(from.id) : OWNER_ID;
  const others = peopleHere().filter((p) => p.id !== me);
  if (!others.length) return null;
  const answered = answerToWhich(said, me, now);
  if (answered) return answered;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The name as it is written on the hub, whole or the first word of it, letters only on both
  // sides ("Mary-Ann" and "mary ann"). The longest spelling is tried first.
  const spellings = new Set();
  for (const p of others) {
    spellings.add(esc(p.first));
    for (const n of [p.name, ...p.aka]) {
      const words = n.split(/[\s-]+/).filter(Boolean);
      spellings.add(words.map(esc).join('[\\s-]+'));
    }
  }
  // Two passes: the names as they are written here, then any word where a name goes, for a
  // name the speech model spelled its own way (who() decides whose it is, or nobody's).
  const NAMES = [`(${[...spellings].sort((a, b) => b.length - a.length).join('|')})`, String.raw`([\p{L}]{3,})`];
  const after = String.raw`(?!['’]s|s['’])(?![\p{L}\p{N}])`;
  // A call: opened, answered or ended. The whole line is the command ("talk to Maria about
  // dinner" is not one), but in a call one sentence of it is enough to end it.
  const tail = String.raw`(?:\s+(?:now|please))?[\s.!?]*$`;
  if (HANG_UP.test(said.replace(/[\s.!?]+$/, '')) || (talkOf(me, now) && saysHangUp(said))) return { talk: 'end' };
  if (new RegExp(`${LEAD}stop\\s+talking\\s+(?:to|with)\\s+${NAMES[0]}${after}${tail}`, 'iu').test(said)) return { talk: 'end' };
  if (new RegExp(`${LEAD}(?:answer|pick\\s+up|answer\\s+(?:it|the\\s+call))${tail}`, 'iu').test(said)) return { talk: 'answer' };
  for (const loose of [false, true]) {
    const call = new RegExp(`${LEAD}(?:(?:talk|speak)\\s+(?:to|with)|call(?:ed)?|answer|(?:start|open)\\s+a\\s+(?:call|talk)\\s+with)\\s+${NAMES[loose ? 1 : 0]}${after}${tail}`, 'iu').exec(said);
    if (!call) continue;
    const named = who(call[1], others, { loose });
    if (named.length === 1) return { talk: 'start', to: named[0] };
    if (named.length > 1) return { talk: 'which', among: named };
  }
  // The words between the name and the message: "send Maria a message that says ...".
  const saying = String.raw`[\s,:]*(?:(?:and\s+say|saying|that\s+says|to\s+say)[\s,:]+)?(?:that\s+)?`;
  const kindOf = String.raw`(?:voice\s+|text\s+|quick\s+)?`;
  const reach = String.raw`(?:(?:talk|speak)\s+(?:to|with)|call)`;
  // [the form, what it is, the name comes second]
  const forms = (name) => [
    [`(?:tell|text|message|ping)\\s+${name}${after}[\\s,:]*(?:that\\s+)?(.*)$`, 'says'],
    [`let\\s+${name}${after}\\s+know[\\s,:]*(?:that\\s+)?(.*)$`, 'says'],
    [`send\\s+(?:a\\s+)?${kindOf}message\\s+to\\s+${name}${after}${saying}(.*)$`, 'says'],
    [`send\\s+${name}${after}\\s+a\\s+${kindOf}message(?:\\s+or\\s+(?:a\\s+)?${kindOf}message)?${saying}(.*)$`, 'says'],
    // "Talk to Maria and tell her ..." is a message, not a call: a call is opened on its own.
    [`${reach}\\s+${name}${after}[\\s,]+and\\s+(?:(?:tell|say\\s+to)\\s+(?:him|her|them)|say)[\\s,:]*(?:that\\s+)?(.*)$`, 'says'],
    [`${reach}\\s+${name}${after}[\\s,]+and\\s+ask\\s+(?:him|her|them)[\\s,:]*(.*)$`, 'asks'],
    [`ask\\s+${name}${after}[\\s,:]*(.*)$`, 'asks'],
    [`say\\s+(.+?)\\s+to\\s+${name}${after}[\\s.!?]*$`, 'says', true],
  ];
  for (const loose of [false, true]) {
    for (const [form, kind, nameSecond] of forms(NAMES[loose ? 1 : 0])) {
      const m = new RegExp(LEAD + form, 'iu').exec(said);
      if (!m) continue;
      const named = who(nameSecond ? m[2] : m[1], others, { loose });
      if (!named.length) continue;
      const to = named[0];
      const body = String((nameSecond ? m[1] : m[2]) || '').trim().replace(/\s+/g, ' ').slice(0, MAX_BODY);
      if (NOT_A_PERSON.test(body)) return null;     // "tell Maria's computer ..." is the thread relay's
      if (named.length > 1) return { which: named, kind, body };
      if (!body.replace(/[^\p{L}\p{N}]/gu, '')) return { to, empty: true };
      return { to, kind, body };
    }
  }
  return null;
}

/** What the other person's device says. The sender's words as heard, with who said them. */
export function spokenLine(senderFirst, kind, body) {
  const b = String(body || '').trim();
  const stop = /[.!?]$/.test(b) ? '' : '.';
  if (kind === 'asks') {
    if (/^to\s/i.test(b)) return `${senderFirst} asks you ${b}${stop}`;
    return `${senderFirst} asks: ${b}${/[.!?]$/.test(b) ? '' : '?'}`;
  }
  return /^to\s/i.test(b) ? `${senderFirst} says ${b}${stop}` : `${senderFirst} says: ${b}${stop}`;
}

/**
 * Keep the message for the other person. how: 'voice' (said to ΠAN) or 'typed' (the app).
 * -> { ok, id, reachable, line } | { ok: false, reason: 'nobody' | 'too_many' | 'empty' }
 */
export function sendMessage({ from = null, to, kind = 'says', body, how = 'voice' }, now = Date.now()) {
  const inCall = how === 'talk';
  const senderId = from ? Number(from.id) : OWNER_ID;
  const here = peopleHere();
  const sender = here.find((p) => p.id === senderId);
  const other = here.find((p) => p.id === Number(to?.id));
  if (!sender || !other || other.id === senderId) return { ok: false, reason: 'nobody' };
  const text = String(body || '').trim().replace(/\s+/g, ' ').slice(0, MAX_BODY);
  if (!text.replace(/[^\p{L}\p{N}]/gu, '')) return { ok: false, reason: 'empty' };
  // A call is many short lines: its own count, forty a minute. Everything else is six.
  if (inCall ? !mayTalkNow(senderId, now) : !maySpeakNow({ device: `user-${senderId}`, name: sender.first }, now)) return { ok: false, reason: 'too_many' };
  ensureMessagesSchema();
  const id = Number(run(`INSERT INTO person_messages (from_user, to_user, kind, body, how, created_at) VALUES (:f, :t, :k, :b, :h, :at)`,
    { ':f': senderId, ':t': other.id, ':k': kind === 'asks' ? 'asks' : 'says', ':b': text, ':h': how === 'typed' ? 'typed' : inCall ? 'talk' : 'voice', ':at': now }).lastInsertRowid);
  const reachable = userAsking(other.id, now);
  if (!inCall) console.log(`[message] person ${senderId} -> person ${other.id}, ${text.length} characters${reachable ? '' : ' (their device is not asking right now)'}`);
  return { ok: true, id, reachable, line: spokenLine(sender.first, kind, text) };
}

/**
 * The messages waiting to be said on the device that is asking, as notes; each is handed over
 * once. dev: as for takeNotesFor (phone-notes.js). A person's device gets that person's; the
 * owner's go to the one device his notes go to.
 */
export function takeMessagesFor({ key = '', linkDevice = '', person = null } = {}, now = Date.now()) {
  const me = person ? Number(person.id) : OWNER_ID;
  if (!me) return [];
  ensureMessagesSchema();
  const rows = all(`SELECT id, from_user, kind, body, how, created_at FROM person_messages
    WHERE to_user = :u AND delivered_at IS NULL AND created_at > :t ORDER BY id LIMIT 20`, { ':u': me, ':t': now - KEEP_MS });
  if (!rows.length) return [];
  const names = new Map(peopleHere().map((p) => [p.id, p.first]));
  const quiet = messageMode(me).mode === 'show';
  const out = [];
  for (const r of rows) {
    if (!person && !ownerTakesHere({ key, linkDevice }, r.created_at, now)) continue;
    const first = names.get(Number(r.from_user)) || 'Someone';
    run(`UPDATE person_messages SET delivered_at = :n WHERE id = :i AND delivered_at IS NULL`, { ':n': now, ':i': r.id });
    // In a call both have joined, the words alone are read out, as on a phone. Otherwise who said them comes first.
    const both = r.how === 'talk' && talkOf(me, now)?.with === Number(r.from_user);
    if (both) heardInCall(me, r.body, now);
    // 'speak' is read out and shown; 'message' is shown only (this person's choice, or the owner's for them).
    out.push({ id: nextNoteId(), type: quiet ? 'message' : 'speak', title: both ? first : `${first} ${r.kind === 'asks' ? 'asks' : 'says'}`,
      body: both ? (/[.!?]$/.test(r.body) ? r.body : `${r.body}.`) : spokenLine(first, r.kind, r.body),
      data: { kind: 'message', from_user: Number(r.from_user), message_id: Number(r.id), talk: r.how === 'talk' }, from: null });
  }
  return out;
}

// ── Read out, or shown only ────────────────────────────────────────────────────────────────
// The setting people_message_mode: { "<user id>": { mode: 'speak' | 'show', locked: boolean } }.
function modes() {
  try { return JSON.parse(get(`SELECT value FROM settings WHERE key = 'people_message_mode'`)?.value || '{}') || {}; } catch { return {}; }
}

/** How what is sent to this person reaches them, and whether the owner locked that. */
export function messageMode(userId) {
  const m = modes()[String(Number(userId))];
  return { mode: m?.mode === 'show' ? 'show' : 'speak', locked: !!m?.locked && Number(userId) !== OWNER_ID };
}

/**
 * Set it. by: who is asking (null: the owner). A person sets their own unless it is locked; the
 * owner sets anyone's and may lock it. -> { ok, mode, locked } | { ok: false, reason }
 */
export function setMessageMode(userId, { mode, locked } = {}, by = null) {
  const uid = Number(userId);
  if (mode !== 'speak' && mode !== 'show') return { ok: false, reason: 'mode' };
  if (!peopleHere().some((p) => p.id === uid)) return { ok: false, reason: 'nobody' };
  const all_ = modes();
  const was = all_[String(uid)] || {};
  if (by) {
    if (Number(by.id) !== uid) return { ok: false, reason: 'not_yours' };
    if (was.locked) return { ok: false, reason: 'locked' };
    all_[String(uid)] = { mode, locked: false };
  } else {
    all_[String(uid)] = { mode, locked: uid === OWNER_ID ? false : locked === undefined ? !!was.locked : !!locked };
  }
  const value = JSON.stringify(all_);
  run(`INSERT INTO settings (key, value) VALUES ('people_message_mode', :v) ON CONFLICT(key) DO UPDATE SET value = :v`, { ':v': value });
  return { ok: true, ...messageMode(uid) };
}

// ── Calls ──────────────────────────────────────────────────────────────────────────────────
// user id -> { with, since, last, heard: [{ k, at }] }. heard: what the other one's words were,
// so the device's own loudspeaker coming back through its microphone is not sent back to them.
const talks = new Map();
const TALK_IDLE_MS = 5 * 60_000;
const TALK_PER_MINUTE = 40;
const talkLines = new Map();
const PAN_NAMED = /\b(?:pan|pam|pann)\b/i;
const letters = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function mayTalkNow(senderId, now) {
  const recent = (talkLines.get(senderId) || []).filter((t) => now - t < 60_000);
  if (recent.length >= TALK_PER_MINUTE) { talkLines.set(senderId, recent); return false; }
  recent.push(now);
  talkLines.set(senderId, recent);
  return true;
}

/** This person's open call, or null. A call nobody has spoken in for five minutes is over. */
export function talkOf(userId, now = Date.now()) {
  const t = talks.get(Number(userId));
  if (!t) return null;
  if (now - t.last > TALK_IDLE_MS) { talks.delete(Number(userId)); return null; }
  return t;
}

function heardInCall(userId, body, now) {
  const t = talks.get(Number(userId));
  if (!t) return;
  t.last = now;
  t.heard = [...t.heard.filter((h) => now - h.at < 20_000), { k: letters(body), at: now }].slice(-6);
}

/** Whether this person's device should ask for its notes every second: in a call, or being called. */
export function talkFast(userId, now = Date.now()) {
  const me = Number(userId);
  if (talkOf(me, now)) return true;
  for (const [id, t] of talks) if (t.with === me && talkOf(id, now)) return true;
  return false;
}

/** For the app: who this person is in a call with, and whether that person has joined. */
export function talkState(userId, now = Date.now()) {
  const me = Number(userId);
  const t = talkOf(me, now);
  const caller = [...talks].filter(([id, x]) => x.with === me && talkOf(id, now)).sort((a, b) => b[1].since - a[1].since)[0];
  return { with: t ? t.with : null, joined: !!t && talkOf(t.with, now)?.with === me, calling_me: caller && (!t || t.with !== caller[0]) ? caller[0] : null };
}

/**
 * Open this person's side of a call with [otherId]. The other is told once; nothing they say is
 * passed on until they open their own side. -> { ok, joined, name } | { ok: false, reason }
 */
export function startTalk(person, otherId, now = Date.now()) {
  const me = person ? Number(person.id) : OWNER_ID;
  const here = peopleHere();
  const mine = here.find((p) => p.id === me);
  const other = here.find((p) => p.id === Number(otherId) && p.id !== me);
  if (!mine || !other) return { ok: false, reason: 'nobody' };
  const already = talkOf(me, now);
  if (already && already.with !== other.id) endTalk(person, now);
  talks.set(me, { with: other.id, since: now, last: now, heard: [] });
  const joined = talkOf(other.id, now)?.with === me;
  if (joined) talks.get(other.id).last = now;
  if (!already || already.with !== other.id) {
    addNote({ type: 'speak', title: mine.first, data: { kind: 'talk', from_user: me },
      body: joined ? `${mine.first} is on.` : `${mine.first} wants to talk. Say: PAN, talk to ${mine.first}.` }, { toUser: other.id, keepMs: 60_000, now });
  }
  console.log(`[call] person ${me} opened a call with person ${other.id}${joined ? ' (both on)' : ''}`);
  return { ok: true, joined, name: other.first, reachable: userAsking(other.id, now) };
}

/** Close this person's call, and the other side of it. -> the other's first name, or null */
export function endTalk(person, now = Date.now()) {
  const me = person ? Number(person.id) : OWNER_ID;
  const t = talks.get(me);
  if (!t) return null;
  talks.delete(me);
  const here = peopleHere();
  const other = here.find((p) => p.id === t.with);
  if (talks.get(t.with)?.with === me) {
    talks.delete(t.with);
    const mine = here.find((p) => p.id === me);
    addNote({ type: 'speak', title: mine?.first || 'ΠAN', body: `${mine?.first || 'They'} ended the call.`, data: { kind: 'talk', from_user: me } }, { toUser: t.with, keepMs: 60_000, now });
  }
  console.log(`[call] person ${me} ended the call with person ${t.with}`);
  return other?.first || null;
}

/**
 * The person being called says no: the caller's side closes and the caller is told. Nothing
 * of the called person's was ever passed on. -> the caller's first name, or null (nobody was calling)
 */
export function declineTalk(person, callerId, now = Date.now()) {
  const me = person ? Number(person.id) : OWNER_ID;
  const caller = Number(callerId);
  const t = talkOf(caller, now);
  if (!t || t.with !== me || talks.get(me)?.with === caller) return null;
  talks.delete(caller);
  const here = peopleHere();
  const mine = here.find((p) => p.id === me);
  addNote({ type: 'speak', title: mine?.first || 'ΠAN', body: `${mine?.first || 'They'} can't talk right now.`, data: { kind: 'talk', from_user: me } }, { toUser: caller, keepMs: 60_000, now });
  console.log(`[call] person ${me} declined a call from person ${caller}`);
  return here.find((p) => p.id === caller)?.first || null;
}

/**
 * A line heard on the device of someone in a call. Not said to ΠAN by name: it is their words to
 * the other person, passed on as heard. -> null (not in a call, or the line is ΠAN's to handle)
 * | { to, sent } (handled: ΠAN answers nothing). wearer false: the hub is sure it was someone
 * else's voice, so it is not passed on as this person's.
 */
export function talkLine(text, { person = null, wearer } = {}, now = Date.now()) {
  const me = person ? Number(person.id) : OWNER_ID;
  const t = talkOf(me, now);
  if (!t) return null;
  const said = String(text || '').trim();
  if (!letters(said) || wearer === false) return null;
  // "Hang up", with or without ΠAN's name, anywhere in the line: never words for the other one.
  if (saysHangUp(said)) return { to: t.with, sent: false, ended: true, name: endTalk(person, now) };
  if (PAN_NAMED.test(said)) return null;
  if (person && !may(person, 'messages')) return null;
  // Their own loudspeaker: the other one's words, heard again by this microphone.
  const k = letters(said);
  if (t.heard.some((h) => now - h.at < 20_000 && (h.k === k || (k.length > 12 && (h.k.includes(k) || k.includes(h.k)))))) return { to: t.with, sent: false, reason: 'echo' };
  // A line that grew: the device heard them go on and sent the whole line again with more at
  // the end. Only the new end goes on, not the start a second time.
  const tokens = said.split(/\s+/);
  const words = tokens.map(key);
  let body = said;
  if (t.sent && now - t.sent.at < 15_000 && words.length >= t.sent.words.length) {
    const n = t.sent.words.length;
    const same = t.sent.words.filter((w, i) => w === words[i]).length;
    if (same >= Math.ceil(n * 0.7)) body = tokens.slice(n).join(' ');
  }
  t.sent = { words, at: now };
  if (!letters(body)) return { to: t.with, sent: false, reason: 'again' };
  const sent = sendMessage({ from: person, to: { id: t.with }, kind: 'says', body, how: 'talk' }, now);
  if (sent.ok) { t.last = now; console.log(`[call] person ${me} to person ${t.with}: a line passed on`); }
  return { to: t.with, sent: !!sent.ok, reason: sent.ok ? undefined : sent.reason };
}

/** For the tests: no calls. */
export function resetTalks() { talks.clear(); talkLines.clear(); }

/** For the tests and the log: the messages not yet said on a device. */
export function messagesWaiting(now = Date.now()) {
  ensureMessagesSchema();
  return all(`SELECT id, from_user, to_user FROM person_messages WHERE delivered_at IS NULL AND created_at > :t ORDER BY id`, { ':t': now - KEEP_MS })
    .map((r) => ({ id: Number(r.id), from_user: Number(r.from_user), to_user: Number(r.to_user) }));
}

/**
 * The People tab's list for one person: everyone else on the hub, with the newest message
 * between the two and how many they have not opened. Newest talk first, then by name.
 */
export function peopleFor(meId) {
  const me = Number(meId) || OWNER_ID;
  ensureMessagesSchema();
  const last = new Map();
  for (const r of all(`SELECT m.id, m.from_user, m.to_user, m.kind, m.body, m.created_at FROM person_messages m
      JOIN (SELECT MAX(id) AS id FROM person_messages WHERE from_user = :u OR to_user = :u
            GROUP BY CASE WHEN from_user = :u THEN to_user ELSE from_user END) x ON x.id = m.id`, { ':u': me })) {
    const other = Number(r.from_user) === me ? Number(r.to_user) : Number(r.from_user);
    last.set(other, { id: Number(r.id), from_me: Number(r.from_user) === me, kind: r.kind, body: r.body, at: Number(r.created_at) });
  }
  const unread = new Map(all(`SELECT from_user, COUNT(*) AS n FROM person_messages WHERE to_user = :u AND read_at IS NULL GROUP BY from_user`, { ':u': me })
    .map((r) => [Number(r.from_user), Number(r.n)]));
  // The owner also sees how each person's messages reach them, to set it for them.
  const how = me === OWNER_ID ? (id) => ({ messages: messageMode(id) }) : () => ({});
  return peopleHere().filter((p) => p.id !== me)
    .map((p) => ({ id: p.id, name: p.name, aka: p.aka, role: p.role, last: last.get(p.id) || null, unread: unread.get(p.id) || 0, ...how(p.id) }))
    .sort((a, b) => (b.last?.at || 0) - (a.last?.at || 0) || a.name.localeCompare(b.name));
}

/** Whether the owner may read this person's conversations: only a person whose role is child. */
export function ownerMayRead(userId) {
  return peopleHere().some((p) => p.id === Number(userId) && p.id !== OWNER_ID && p.role === 'child');
}

/** For the tests: forget every "which one?" that waits for an answer. */
export function resetAsked() { asked.clear(); }

/**
 * The conversation between two people, oldest first, and it marks what the other one sent as
 * opened. before: a message id, for the page before it. -> { with, messages, more } | null
 */
export function conversation(meId, otherId, { before = 0, limit = PAGE, now = Date.now(), mark = true } = {}) {
  const me = Number(meId) || OWNER_ID;
  const other = peopleHere().find((p) => p.id === Number(otherId) && p.id !== me);
  if (!other) return null;
  ensureMessagesSchema();
  const n = Math.min(Math.max(Number(limit) || PAGE, 1), 200);
  const rows = all(`SELECT id, from_user, kind, body, how, created_at, delivered_at, read_at FROM person_messages
    WHERE ((from_user = :a AND to_user = :b) OR (from_user = :b AND to_user = :a)) AND (:before = 0 OR id < :before)
    ORDER BY id DESC LIMIT :n`, { ':a': me, ':b': other.id, ':before': Number(before) || 0, ':n': n + 1 });
  const more = rows.length > n;
  // mark false: someone other than the two is looking (the owner at a child's), so nothing is marked opened.
  if (mark) run(`UPDATE person_messages SET read_at = :t WHERE to_user = :a AND from_user = :b AND read_at IS NULL`, { ':t': now, ':a': me, ':b': other.id });
  return { with: { id: other.id, name: other.name, role: other.role }, more,
    messages: rows.slice(0, n).reverse().map((r) => ({ id: Number(r.id), from_me: Number(r.from_user) === me, kind: r.kind, body: r.body,
      how: r.how, at: Number(r.created_at), said: r.delivered_at != null, opened: r.read_at != null })) };
}

/**
 * One voice turn: null when the line is not a message, else the turn's result.
 * person: who is speaking (null: the owner). test: parse and say what would happen, send nothing.
 */
export function messageTurn(text, { person = null, addressed = false, test = false } = {}) {
  const msg = parseMessage(text, { from: person, addressed });
  if (!msg) return null;
  const base = { intent: 'message', speech_act: 'command', addressed: 1, importance: 0.5 };
  const senderId = person ? Number(person.id) : OWNER_ID;
  if (person && !may(person, 'messages')) return { ...base, response: `I can't send messages for you. Whoever set me up decides that.`, refused: 'messages' };
  if (msg.talk) {
    const call = { ...base, intent: 'talk' };
    if (msg.talk === 'which') return { ...call, response: `Which ${msg.among[0].first}? Say the whole name: ${msg.among.map((p) => p.name).join(', or ')}.` };
    if (msg.talk === 'end') {
      if (test) return { ...call, response: '[benchmark: end of call parsed, nothing ended]' };
      const who = endTalk(person);
      return { ...call, response: who ? `Call with ${who} ended.` : `You're not in a call.` };
    }
    let to = msg.to;
    if (msg.talk === 'answer') {
      const calling = talkState(senderId).calling_me;
      to = peopleHere().find((p) => p.id === calling);
      if (!to) return { ...call, response: `Nobody is calling.` };
    }
    if (test) return { ...call, response: `[benchmark: call with ${to.first} parsed, nothing started]`, talk_parse: { to: to.id } };
    const started = startTalk(person, to.id);
    if (!started.ok) return { ...call, response: `I couldn't start that.` };
    return { ...call, talk_with: to.id,
      response: started.joined ? `You're on with ${to.first}.`
        : started.reachable ? `Calling ${to.first}. Go ahead, I'll pass on what you say.`
          : `${to.first}'s device is not on right now. I'll pass on what you say when it is.` };
  }
  if (msg.which) {
    const names = msg.which.map((p) => p.name);
    const same = new Set(names).size < names.length;
    if (!test && !same) asked.set(senderId, { kind: msg.kind, body: msg.body, among: msg.which, at: Date.now() });
    return { ...base, message_which: msg.which.map((p) => p.id),
      response: same ? `There are ${names.length} people called ${names[0]} here. Give one of them a different name first.`
        : `Which ${msg.which[0].first}: ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}?` };
  }
  asked.delete(senderId);
  const whom = msg.to.first;
  if (msg.empty) return { ...base, response: `What should I tell ${whom}?` };
  if (test) {
    return { ...base, response: `[benchmark: message for ${whom} parsed (${msg.kind}), nothing sent]`,
      message_parse: { to: msg.to.id, kind: msg.kind, body: msg.body } };
  }
  const sent = sendMessage({ from: person, to: msg.to, kind: msg.kind, body: msg.body });
  if (!sent.ok) return { ...base, response: sent.reason === 'too_many' ? `That's a lot of messages at once. Give it a minute.` : `I couldn't send that.` };
  const told = msg.kind === 'asks' ? `I asked ${whom}` : `I told ${whom}`;
  return { ...base, message_to: msg.to.id,
    response: sent.reachable ? `${told}: ${msg.body.replace(/[.!?]+$/, '')}.`
      : `${whom}'s device is not on right now. I'll pass it on when it is.` };
}
