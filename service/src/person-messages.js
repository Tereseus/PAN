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
//   - The name is the first name of a person on this hub. Anyone else ("tell my boss ...") is
//     not a message of this kind and the line goes on as ordinary talk.
//   - A person needs the `messages` limit (people.js). The owner always may.
//   - One sender, six messages a minute.
//
// Kept in the notes queue, which is in memory: a message waits up to twelve hours for the
// other person's device, and a Craft swap in that time loses it.

import { get, all } from './db.js';
import { addNote, maySpeakNow, userAsking } from './phone-notes.js';
import { may } from './people.js';

const OWNER_ID = 1;
const KEEP_MS = 12 * 3600_000;
const MAX_BODY = 500;

const firstWord = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const key = (word) => String(word || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Everyone on this hub: [{ id, name, first, key, role }]. The owner goes by the name ΠAN calls him. */
export function peopleHere() {
  let rows = [];
  try { rows = all(`SELECT id, display_name, role FROM users WHERE is_active = 1 ORDER BY id`); } catch {}
  let ownerName = '';
  try { ownerName = String(get(`SELECT value FROM settings WHERE key = 'display_name'`)?.value || '').replace(/^"|"$/g, '').trim(); } catch {}
  return rows.map((r) => {
    const name = Number(r.id) === OWNER_ID && ownerName ? ownerName : String(r.display_name || '');
    const first = firstWord(name);
    return { id: Number(r.id), name, first, key: key(first), role: r.role };
  }).filter((p) => p.key.length >= 2);
}

const LEAD = String.raw`^(?:(?:hey|hi|ok|okay|yo)[,\s]+)?(?:(?:pan|pam)[,.!\s]+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?`;
const NOT_A_PERSON = /^(?:thread|session|chat|computer|pc|laptop|desktop|machine)\b/i;

/**
 * Is this line a message for someone on this hub?
 * from: the person speaking (null: the owner). addressed: the line was said to ΠAN.
 * -> null | { to, kind: 'says' | 'asks', body } | { to, empty: true }
 */
export function parseMessage(text, { from = null, addressed = false } = {}) {
  if (!addressed) return null;
  const said = String(text || '').trim().replace(/[,\s]+(?:pan|pam)[.!?\s]*$/i, '').trim();
  if (!said) return null;
  const me = from ? Number(from.id) : OWNER_ID;
  const others = peopleHere().filter((p) => p.id !== me);
  if (!others.length) return null;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The name as it is written on the hub, letters only on both sides ("Mary-Ann" and "mary ann").
  const name = `(${[...new Set(others.map((p) => p.first))].sort((a, b) => b.length - a.length).map(esc).join('|')})`;
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
    const to = others.find((p) => p.key === key(m[1]));
    if (!to) return null;
    const body = String(m[2] || '').trim().replace(/\s+/g, ' ').slice(0, MAX_BODY);
    if (NOT_A_PERSON.test(body)) return null;     // "tell Maria's computer ..." is the thread relay's
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

/** Put the message on the other person's device. -> { ok, reachable, line } | { ok: false, reason } */
export function sendMessage({ from = null, to, kind = 'says', body }, now = Date.now()) {
  const senderId = from ? Number(from.id) : OWNER_ID;
  const sender = peopleHere().find((p) => p.id === senderId);
  if (!sender || !to?.id || to.id === senderId) return { ok: false, reason: 'nobody' };
  if (!maySpeakNow({ device: `user-${senderId}`, name: sender.first }, now)) return { ok: false, reason: 'too_many' };
  const line = spokenLine(sender.first, kind, body);
  const note = addNote({ type: 'speak', title: `${sender.first} ${kind === 'asks' ? 'asks' : 'says'}`, body: line,
    data: { kind: 'message', from_user: senderId } }, { toUser: to.id, keepMs: KEEP_MS, now });
  const reachable = userAsking(to.id, now);
  console.log(`[message] person ${senderId} -> person ${to.id}, ${String(body).length} characters${reachable ? '' : ' (their device is not asking right now)'}`);
  return { ok: true, id: note.id, reachable, line };
}

/**
 * One voice turn: null when the line is not a message, else the turn's result.
 * person: who is speaking (null: the owner). test: parse and say what would happen, send nothing.
 */
export function messageTurn(text, { person = null, addressed = false, test = false } = {}) {
  const msg = parseMessage(text, { from: person, addressed });
  if (!msg) return null;
  const base = { intent: 'message', speech_act: 'command', addressed: 1, importance: 0.5 };
  const whom = msg.to.first;
  if (person && !may(person, 'messages')) return { ...base, response: `I can't send messages for you. Whoever set me up decides that.`, refused: 'messages' };
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
