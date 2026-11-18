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
//   - The owner can read a child's conversations (the owner's call, 2026-11-18): only a person
//     whose role is child, only the owner, and the child's own People tab says so.
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
import { maySpeakNow, userAsking, ownerTakesHere, nextNoteId } from './phone-notes.js';
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
  return rows.map((r) => {
    const name = Number(r.id) === OWNER_ID && ownerName ? ownerName : String(r.display_name || '');
    const first = firstWord(name);
    const whole = name.trim().replace(/\s+/g, ' ');
    return { id: Number(r.id), name: whole, first, key: key(first), full: key(whole), rest: key(whole.slice(first.length)), role: r.role };
  }).filter((p) => p.key.length >= 2);
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

const LEAD = String.raw`^(?:(?:hey|hi|ok|okay|yo)[,\s]+)?(?:(?:pan|pam)[,.!\s]+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?`;
const NOT_A_PERSON = /^(?:thread|session|chat|computer|pc|laptop|desktop|machine)\b/i;

/**
 * Is this line a message for someone on this hub?
 * from: the person speaking (null: the owner). addressed: the line was said to ΠAN.
 * -> null | { to, kind: 'says' | 'asks', body } | { to, empty: true } | { which: [people], kind, body }
 * which: two or more people here go by the name that was said.
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
    const words = p.name.split(/[\s-]+/).filter(Boolean);
    if (words.length > 1) spellings.add(words.map(esc).join('[\\s-]+'));
  }
  const name = `(${[...spellings].sort((a, b) => b.length - a.length).join('|')})`;
  const after = String.raw`(?!['’]s|s['’])(?![\p{L}\p{N}])`;
  const forms = [
    [new RegExp(`${LEAD}(?:tell|text|message|ping)\\s+${name}${after}[\\s,:]*(?:that\\s+)?(.*)$`, 'iu'), 'says'],
    [new RegExp(`${LEAD}let\\s+${name}${after}\\s+know[\\s,:]*(?:that\\s+)?(.*)$`, 'iu'), 'says'],
    [new RegExp(`${LEAD}send\\s+(?:a\\s+)?message\\s+to\\s+${name}${after}[\\s,:]*(?:saying\\s+|that\\s+)?(.*)$`, 'iu'), 'says'],
    [new RegExp(`${LEAD}send\\s+${name}${after}\\s+a\\s+message[\\s,:]*(?:saying\\s+|that\\s+)?(.*)$`, 'iu'), 'says'],
    [new RegExp(`${LEAD}ask\\s+${name}${after}[\\s,:]*(.*)$`, 'iu'), 'asks'],
  ];
  for (const [re, kind] of forms) {
    const m = re.exec(said);
    if (!m) continue;
    const k = key(m[1]);
    const whole = others.filter((p) => p.full === k);
    const named = whole.length ? whole : others.filter((p) => p.key === k);
    if (!named.length) return null;
    const to = named[0];
    const body = String(m[2] || '').trim().replace(/\s+/g, ' ').slice(0, MAX_BODY);
    if (NOT_A_PERSON.test(body)) return null;     // "tell Maria's computer ..." is the thread relay's
    if (named.length > 1) return { which: named, kind, body };
    if (!body.replace(/[^\p{L}\p{N}]/gu, '')) return { to, empty: true };
    return { to, kind, body };
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
  const senderId = from ? Number(from.id) : OWNER_ID;
  const here = peopleHere();
  const sender = here.find((p) => p.id === senderId);
  const other = here.find((p) => p.id === Number(to?.id));
  if (!sender || !other || other.id === senderId) return { ok: false, reason: 'nobody' };
  const text = String(body || '').trim().replace(/\s+/g, ' ').slice(0, MAX_BODY);
  if (!text.replace(/[^\p{L}\p{N}]/gu, '')) return { ok: false, reason: 'empty' };
  if (!maySpeakNow({ device: `user-${senderId}`, name: sender.first }, now)) return { ok: false, reason: 'too_many' };
  ensureMessagesSchema();
  const id = Number(run(`INSERT INTO person_messages (from_user, to_user, kind, body, how, created_at) VALUES (:f, :t, :k, :b, :h, :at)`,
    { ':f': senderId, ':t': other.id, ':k': kind === 'asks' ? 'asks' : 'says', ':b': text, ':h': how === 'typed' ? 'typed' : 'voice', ':at': now }).lastInsertRowid);
  const reachable = userAsking(other.id, now);
  console.log(`[message] person ${senderId} -> person ${other.id}, ${text.length} characters${reachable ? '' : ' (their device is not asking right now)'}`);
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
  const rows = all(`SELECT id, from_user, kind, body, created_at FROM person_messages
    WHERE to_user = :u AND delivered_at IS NULL AND created_at > :t ORDER BY id LIMIT 20`, { ':u': me, ':t': now - KEEP_MS });
  if (!rows.length) return [];
  const names = new Map(peopleHere().map((p) => [p.id, p.first]));
  const out = [];
  for (const r of rows) {
    if (!person && !ownerTakesHere({ key, linkDevice }, r.created_at, now)) continue;
    const first = names.get(Number(r.from_user)) || 'Someone';
    run(`UPDATE person_messages SET delivered_at = :n WHERE id = :i AND delivered_at IS NULL`, { ':n': now, ':i': r.id });
    out.push({ id: nextNoteId(), type: 'speak', title: `${first} ${r.kind === 'asks' ? 'asks' : 'says'}`, body: spokenLine(first, r.kind, r.body),
      data: { kind: 'message', from_user: Number(r.from_user), message_id: Number(r.id) }, from: null });
  }
  return out;
}

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
  return peopleHere().filter((p) => p.id !== me)
    .map((p) => ({ id: p.id, name: p.name, role: p.role, last: last.get(p.id) || null, unread: unread.get(p.id) || 0 }))
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
