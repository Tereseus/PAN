// Laying out a problem (task 1087, the owner Nov 26): when he says he is not done ("wait, I'm not
// done", "hold on", "let me finish") or opens a setup ("here's the situation", "let me explain",
// a line ending in a colon), ΠAN says nothing and keeps the pieces; the next line he says is
// answered as ONE request with every piece in front of it. He laid out a popcorn problem over
// three pauses and ΠAN answered the pieces, so the question that came last went alone.
//
// Plain rules, no model. Kept per device for 30 s. The phone joins a piece to the one before
// when he carries on (carry_on); the joined line holds the piece already kept, so it replaces it.

export const OPEN_MS = 30_000;

const LEAD = String.raw`(?:(?:no|okay|ok|um|uh|sorry|and|but)[,.]?\s+)?`;
const HOLD_WORDS = String.raw`(?:wait|hold on|hang on|one sec(?:ond)?|just a (?:sec(?:ond)?|moment|minute)|let me finish|let me think|i'?m not (?:done|finished)(?: yet)?|i haven'?t finished|not done(?: yet)?|there'?s more|i'?m still (?:going|talking|explaining))`;
// The whole line is a hold: "wait, I'm not done", "hold on, let me finish."
const HOLD_ONLY_RE = new RegExp(String.raw`^${LEAD}${HOLD_WORDS}(?:[,.!]?\s+${HOLD_WORDS})*[.!\s]*$`, 'i');
// A line that ends with one: "the microwave is a thousand watts, wait I'm not done"
const HOLD_END_RE = /[\s,.;:]+(?:wait[,.]?\s+)?(?:i'?m not (?:done|finished)(?: yet)?|let me finish|there'?s more|hold on)[.!\s]*$/i;
// A setup opener with no question in it.
const SETUP_RE = /^(?:(?:okay|ok|so|alright|right|listen)[,.]?\s+)*(?:here'?s (?:the|my|a|what) (?:situation|problem|thing|deal|question|setup|scenario|story|context|background|happening)|let me (?:explain|describe|lay (?:it|this|that) out|give you (?:the|some) (?:context|background|details))|picture this|so basically|i'?m going to (?:explain|describe|lay out|tell you (?:about|what))|i need to (?:explain|lay out|tell you about)|i'?ll explain)\b/i;
const QUESTION_RE = /\?|^(?:what|how|why|when|where|which|who|can you|could you|would you|should i|do you|is it|is there|are there)\b/i;

const states = new Map();   // device -> { pieces: [text], at }

function norm(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim(); }

/**
 * What a line is: 'hold' (only "wait, I'm not done"), 'piece' (content he is not done with: a
 * setup opener, or a line ending in a hold or a colon), or null (an ordinary line).
 * `rest` is the content to keep, without the hold words.
 */
export function kindOf(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (HOLD_ONLY_RE.test(t)) return { kind: 'hold', rest: '' };
  const end = HOLD_END_RE.exec(t);
  if (end) return { kind: 'piece', rest: t.slice(0, end.index).trim() };
  if (QUESTION_RE.test(t)) return null;
  if (SETUP_RE.test(t) || /:\s*$/.test(t)) return { kind: 'piece', rest: t };
  return null;
}

/** His last line in the talk, when it is recent enough to be the piece he is not done with. */
export function lastLineOf(history) {
  const lines = String(history || '').split('\n').map(l => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  const prev = lines[lines.length - 2] || '';
  // "User: the setup" / "PAN: a reply to the setup" / now "wait, I'm not done": the setup is his.
  for (const l of [last, prev]) {
    const m = /^(?:user|you|he|owner)\s*:\s*(.+)$/i.exec(l);
    if (m) return m[1].trim();
  }
  return '';
}

function add(st, text) {
  const t = String(text || '').trim();
  if (!t) return;
  const last = st.pieces[st.pieces.length - 1];
  if (last && norm(t).startsWith(norm(last))) st.pieces[st.pieces.length - 1] = t;
  else if (!st.pieces.some(p => norm(p) === norm(t))) st.pieces.push(t);
}

/**
 * One line through the rule. Returns { hold: true } when ΠAN should stay quiet and keep it, or
 * { text } with the line to answer (the kept pieces in front of it when there were any).
 * `history` is the talk as the hub has it, for "wait, I'm not done" right after a setup ΠAN
 * had started to answer.
 */
export function step(device, text, history = '', now = Date.now()) {
  const key = device || 'default';
  let st = states.get(key);
  if (st && now - st.at > OPEN_MS) { states.delete(key); st = null; }
  // The phone joined this line onto the last kept piece: only the new words say what it is.
  const lastKept = st?.pieces[st.pieces.length - 1];
  const fresh = lastKept && norm(text).startsWith(norm(lastKept)) && norm(text) !== norm(lastKept)
    ? String(text).trim().slice(String(lastKept).trim().length).replace(/^[\s,.;:]+/, '') : text;
  const k = kindOf(fresh);
  if (k && fresh !== text) { add(st, `${lastKept} ${k.rest}`.trim()); st.at = now; return { hold: true, pieces: st.pieces.length }; }
  if (k) {
    if (!st) {
      st = { pieces: [], at: now };
      // "wait, I'm not done" names nothing: the piece is what he said just before.
      if (k.kind === 'hold') add(st, lastLineOf(history));
      states.set(key, st);
    }
    add(st, k.rest);
    st.at = now;
    return { hold: true, pieces: st.pieces.length };
  }
  if (!st) return { text };
  states.delete(key);
  const line = String(text || '').trim();
  const last = st.pieces[st.pieces.length - 1];
  // The phone joined this line onto the last piece: it is already in front.
  const pieces = last && norm(line).startsWith(norm(last)) ? st.pieces.slice(0, -1) : st.pieces;
  return { text: [...pieces, line].join(' ').replace(/\s+/g, ' ').trim(), joined: pieces.length };
}

export function clear(device) { states.delete(device || 'default'); }
