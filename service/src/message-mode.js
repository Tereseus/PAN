// Message mode for threads (task 1089, the owner Nov 26): "ΠAN, message for the PAN thread" ->
// "Go." From then on nothing he says is answered and nothing is cut at a pause: every line is
// kept word for word until he says "send it" or "over", and the whole talk goes to the thread in
// one piece. The voice relay sent each piece of a long request on its own, cut at his pauses,
// and the thread got half a thought.
//
// Plain rules, no model. State is per device, in memory: a hub restart drops a message being
// taken (it was never sent, and he hears nothing back, so he can say it again).

export const QUIET_END_MS = 15 * 60_000;   // no line for this long: the taking stops...
export const KEEP_MS = 60 * 60_000;        // ...but the draft can still be sent for an hour
const REJOIN_MS = 30_000;                  // the phone joined the start line to the next piece

const PAN_NAME = String.raw`(?:(?:hey|ok(?:ay)?)\s+)?(?:pan|pam|pen|πan|παν)[,.!]?\s+`;
// "message for the PAN thread", "take a message to my mint music thread: first..."
const START_RE = new RegExp(String.raw`^(?:${PAN_NAME})?(?:(?:take|start|open|begin|leave)\s+(?:a\s+)?)?(?:message|note)(?:\s+mode)?\s+(?:for|to)\s+(?:the\s+|my\s+)?(.{1,48}?)\s+thread\b[.,!?:;]*\s*(.*)$`, 'is');
// "... send it", "that's all, send that", "Over.", "over and out"
// Only on its own (a line of its own after a pause, or after a full stop or comma): "the button
// doesn't send it" inside a bug report must not end the message.
const END_RE = /(?:^|[.!?,;:]\s*)(?:(?:ok(?:ay)?|now|so|and|that'?s (?:it|all))[,.]?\s+)?(?:send (?:it|that|this|the message)(?: now| please)?|over(?: and out)?)[.!?\s]*$/i;
const CANCEL_RE = /^(?:(?:ok(?:ay)?|no)[,.]?\s+)?(?:(?:cancel|scrap|drop|delete|forget|bin)\s+(?:the\s+|that\s+|this\s+|my\s+)?message|never ?mind the message|don'?t send (?:it|that|the message))[.!?\s]*$/i;

const states = new Map();   // device -> { thread, pieces: [{ text, at }], startedAt, lastAt }

function norm(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim(); }
export function wordCount(s) { return String(s || '').trim().split(/\s+/).filter(Boolean).length; }

/** The start line: { name, rest } or null. */
export function parseStart(text) {
  const m = START_RE.exec(String(text || '').trim());
  if (!m) return null;
  const name = m[1].trim();
  if (!name || wordCount(name) > 5) return null;
  return { name, rest: m[2].trim() };
}
/** A line that ends the message: { rest } (the words before "send it"), or null. */
export function parseEnd(text) {
  const t = String(text || '').trim();
  const m = END_RE.exec(t);
  return m ? { rest: t.slice(0, m.index).replace(/[\s,;:]+$/, '').trim() } : null;
}
export const isCancel = (text) => CANCEL_RE.test(String(text || '').trim());

export function stateOf(device, now = Date.now()) {
  const st = states.get(device || 'default');
  if (!st) return null;
  if (now - st.lastAt > KEEP_MS) { states.delete(device || 'default'); return null; }
  return st;
}
/** Taking lines right now (not stopped by 15 min of quiet). */
export function taking(device, now = Date.now()) {
  const st = stateOf(device, now);
  return !!st && now - st.lastAt <= QUIET_END_MS;
}
export function start(device, thread, rest = '', now = Date.now()) {
  const st = { thread, pieces: rest ? [{ text: rest, at: now }] : [], startedAt: now, lastAt: now };
  states.set(device || 'default', st);
  return st;
}
export function clear(device) { states.delete(device || 'default'); }

/**
 * Keeps one heard line. The phone joins a piece to the one before when he carries on (carry_on):
 * the joined line holds the piece already kept, so it replaces it instead of doubling it.
 */
export function addPiece(st, text, now = Date.now()) {
  const t = String(text || '').trim();
  st.lastAt = now;
  if (!t) return st;
  const last = st.pieces[st.pieces.length - 1];
  if (last && norm(t).startsWith(norm(last.text)) && norm(t) !== '') last.text = t;
  else st.pieces.push({ text: t, at: now });
  return st;
}
export const wholeText = (st) => st.pieces.map(p => p.text).join(' ').replace(/\s+/g, ' ').trim();

/** "340 words, about 3 minutes" for the read back. */
export function sizeSaid(st, now = Date.now()) {
  const words = wordCount(wholeText(st));
  const mins = Math.round((Math.max(st.lastAt, now) - st.startedAt) / 60_000);
  const w = words === 1 ? '1 word' : `${words} words`;
  return mins >= 1 ? `${w}, about ${mins === 1 ? 'a minute' : `${mins} minutes`}` : w;
}

/**
 * What a line does while a message is open. Returns one of:
 *  { act: 'cancel' } | { act: 'send', text } | { act: 'empty_send' } | { act: 'keep' } | null (no message open)
 * `restart` is for the phone joining the start line onto the first piece.
 */
export function step(device, text, now = Date.now()) {
  const st = stateOf(device, now);
  if (!st) return null;
  const line = String(text || '').trim();
  if (isCancel(line)) { clear(device); return { act: 'cancel', thread: st.thread }; }
  const live = now - st.lastAt <= QUIET_END_MS;
  const again = parseStart(line);
  if (again && now - st.startedAt < REJOIN_MS) {
    st.pieces = again.rest ? [{ text: again.rest, at: now }] : [];
    st.lastAt = now;
    return { act: 'keep', thread: st.thread };
  }
  const end = parseEnd(line);
  if (end) {
    // After the quiet stop only "send the message" sends the waiting draft: a plain "send it" an
    // hour later is about something else.
    if (!live && !/message/i.test(line)) return null;
    if (live) addPiece(st, end.rest, now);
    const whole = wholeText(st);
    if (!whole) { st.lastAt = now; return { act: 'empty_send', thread: st.thread }; }
    const size = sizeSaid(st, now);
    clear(device);
    return { act: 'send', thread: st.thread, text: whole, size };
  }
  // 15 minutes of quiet stopped the taking: the line is an ordinary one again. The draft waits.
  if (!live) return null;
  addPiece(st, line, now);
  return { act: 'keep', thread: st.thread };
}
