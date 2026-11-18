// own-tail.js — the end of PAN's own voice at the head of the next line it hears.
//
// A speaker with no echo cancelling (a car unit, a TV) is still playing PAN's last words a moment
// after the device thinks it has stopped, and the mic takes them as the start of his next line.
// PAN says it has stopped interpreting; his next line arrives opening with those same two words,
// and what followed them no longer read as a request (the car, 2026-11-18: five lines in one talk
// began with the last one to three words of PAN's reply, each closed by a full stop).
//
// The device's own filter (stripEcho in the app) wants most of PAN's sentence back before it takes
// anything out, and a tail is one to three words. The hub knows the last thing it said to each
// device, and its transcript has the full stop the pause leaves, so the tail comes off here.

const WINDOW_MS = 3 * 60_000;   // a reply older than this is not what the mic is still hearing
const BEGAN_WITHIN_MS = 1500;   // his line began this soon after PAN stopped, or before it did
const WORD = /[\p{L}\p{N}'’]+/gu;

// "I've" is heard as "I", "can't" as "can": the ending after an apostrophe is the first thing a
// clipped echo loses, so it does not count either way.
const norm = (w) => String(w).toLowerCase().replace(/’/g, "'").replace(/'[a-z]*$/, '').replace(/[^\p{L}\p{N}]/gu, '');

// One word alone that he may well say himself right after PAN: never taken for an echo.
const HIS_OWN = new Set(['yes', 'yeah', 'yep', 'no', 'nope', 'okay', 'ok', 'sure', 'right', 'correct',
  'please', 'thanks', 'stop', 'wait', 'what', 'why', 'pan']);

const last = new Map();   // device key -> { words, at }

/** PAN's reply to this device, as it was sent to be spoken. */
export function noteSaid(key, text, now = Date.now()) {
  const words = (String(text || '').match(WORD) || []).map(norm).filter(Boolean);
  if (key && words.length) last.set(key, { words: words.slice(-12), at: now });
}

/**
 * The heard line without PAN's own tail at its head, or the line as it came.
 * began_ms: how long after PAN stopped his line began (negative: while PAN was still talking),
 * when the device sent enough to know; undefined otherwise.
 */
export function dropOwnTail(key, heard, { now = Date.now(), began_ms } = {}) {
  const text = String(heard || '');
  const mine = last.get(key);
  if (!mine || now - mine.at > WINDOW_MS) return text;
  const timed = Number.isFinite(began_ms);
  if (timed && began_ms > BEGAN_WITHIN_MS) return text;

  const head = [];
  let total = 0, m;
  WORD.lastIndex = 0;
  while ((m = WORD.exec(text))) { total++; if (head.length < 6) head.push({ w: norm(m[0]), end: m.index + m[0].length }); }
  const punctuated = /[.!?]/.test(text);

  for (let k = Math.min(head.length, mine.words.length); k >= 1; k--) {
    if (total - k < 2) continue;                 // he repeated PAN's words and little else: that is his answer
    const tail = mine.words.slice(-k);
    if (!head.slice(0, k).every((h, i) => h.w && h.w === tail[i])) continue;
    const after = text.slice(head[k - 1].end);
    // The pause between PAN's voice and his own leaves a full stop in a punctuated transcript.
    if (punctuated && !/^\s*[.!?]/.test(after)) continue;
    // One word is thin: only with the timing known, never a word he would say himself.
    if (k === 1 && (!timed || !punctuated || HIS_OWN.has(head[0].w) || head[0].w.length < 3)) continue;
    const rest = after.replace(/^[\s.!?,]+/, '');
    return rest ? rest[0].toUpperCase() + rest.slice(1) : text;
  }
  return text;
}
