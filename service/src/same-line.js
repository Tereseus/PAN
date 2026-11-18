// same-line.js — one line, heard by two ΠANs in the same room.
//
// The owner, 2026-11-18, with his own phone and another person's two metres apart, both
// listening: the other phone took what he said to his own ΠAN as its person's words and
// answered. The voice print caught most of it (routes/api.js) and missed the lines that
// arrived too quiet to score. His call: the distance is enough to tell.
//
// The rule: the same words, at the same moment, on the devices of two different people, are
// one line. It belongs to one of them:
//   - the person the voice leans to, when a voice print says so (only the owner has one), else
//   - the device that heard it louder: the one it was said next to.
// The other device's turn is dropped as room talk: nothing is answered, sent or passed on.
//
// Turns do not arrive together. A turn that comes second is compared with the first. A turn
// that comes first goes straight on unless there is a reason to expect a second: these two
// people's devices heard one line together in the last ten minutes, or the voice on it leans
// to someone else. Then it waits a moment, at most WAIT_MS. A device that is sure of its own
// person's voice never waits.
//
// What it is not: it does not tell two people apart who say different things, and a single
// word ("yes") is not compared: two people in two rooms say it at once all day.

const WINDOW_MS = 4000;          // two hearings of one line arrive within this
const WAIT_MS = 400;             // how long a first hearing waits for a second
const TOGETHER_MS = 10 * 60_000; // how long two people count as in one room after a shared line
const CLOSE = 1.2;               // louder by less than this is not louder

const recent = [];               // { user, device, words, level, at, mine, settle }
const together = new Map();      // "a:b" (a < b) -> when their devices last heard one line

const wordsOf = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
const pair = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** How loud the speech in a turn is (16 kHz PCM16, base64): the loudest third of its 20 ms frames. */
export function speechLevel(b64) {
  try {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    const n = Math.floor(buf.length / 2);
    const FRAME = 320;
    if (n < FRAME * 5) return null;
    const frames = [];
    for (let i = 0; i + FRAME <= n; i += FRAME) {
      let sum = 0;
      for (let j = 0; j < FRAME; j++) { const v = buf.readInt16LE((i + j) * 2) / 32768; sum += v * v; }
      frames.push(Math.sqrt(sum / FRAME));
    }
    frames.sort((a, b) => b - a);
    const top = frames.slice(0, Math.max(1, Math.floor(frames.length / 3)));
    return top.reduce((s, v) => s + v, 0) / top.length;
  } catch { return null; }
}

/** The same line: most of the shorter one's words are in the other. Two words at least. */
export function sameWords(a, b) {
  if (a.length < 2 || b.length < 2) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const have = new Map();
  for (const w of long) have.set(w, (have.get(w) || 0) + 1);
  let hit = 0;
  for (const w of short) { const n = have.get(w) || 0; if (n > 0) { hit++; have.set(w, n - 1); } }
  return hit >= 2 && hit / short.length >= 0.6;
}

function recentlyTogether(user, now) {
  for (const [k, at] of together) {
    if (now - at > TOGETHER_MS) { together.delete(k); continue; }
    if (k.split(':').map(Number).includes(user)) return true;
  }
  return false;
}

/** Between two hearings of one line: is it [a]'s? leans: the user a voice print points to. */
function wins(a, b) {
  const lean = a.leans ?? b.leans ?? null;
  if (lean !== null && (lean === a.user || lean === b.user)) return lean === a.user;
  if (a.level === null || b.level === null) return a.at <= b.at;       // nothing to go by: the first
  if (a.level >= b.level * CLOSE) return true;
  if (b.level >= a.level * CLOSE) return false;
  return a.at <= b.at;                                                 // as loud as each other: the first
}

/**
 * A turn was heard on [device], which is [user]'s. Is the line theirs?
 * leans: the user the voice on it leans to, when a voice print says (null: nothing to go by).
 * sure: the device is sure it is its own person's voice, so it never waits.
 * -> { mine, with?, waited } with: the other person whose device heard it too.
 */
export async function whoseLine({ user, device, text, level = null, leans = null, sure = false }, now = Date.now(), { wait = WAIT_MS } = {}) {
  const words = wordsOf(text);
  for (let i = recent.length - 1; i >= 0; i--) if (now - recent[i].at > WINDOW_MS && !recent[i].settle) recent.splice(i, 1);
  if (words.length < 2) return { mine: true, waited: 0 };
  const me = { user: Number(user), device, words, level, leans, at: now, mine: null, settle: null };
  const others = recent.filter((e) => e.user !== me.user && Math.abs(now - e.at) <= WINDOW_MS && sameWords(words, e.words));
  if (others.length) {
    // The one of them that has the best claim so far.
    const other = others.reduce((best, e) => (wins(e, best) ? e : best));
    together.set(pair(me.user, other.user), now);
    const mine = wins(me, other);
    me.mine = mine;
    recent.push(me);
    for (const e of others) {
      if (e.settle) e.settle(!mine && e === other);
      else if (mine && e.mine) console.log(`[same-line] person ${e.user}'s device went ahead with a line that was person ${me.user}'s (it came first)`);
    }
    console.log(`[same-line] one line on the devices of person ${me.user} and person ${other.user}: person ${mine ? me.user : other.user}'s (${leans !== null || other.leans !== null ? 'by voice' : `level ${level?.toFixed(3) ?? '-'} vs ${other.level?.toFixed(3) ?? '-'}`})`);
    return { mine, with: other.user, waited: 0 };
  }
  recent.push(me);
  const expect = !sure && (recentlyTogether(me.user, now) || (leans !== null && leans !== me.user));
  if (!expect || wait <= 0) { me.mine = true; return { mine: true, waited: 0 }; }
  const t0 = Date.now();
  const mine = await new Promise((resolve) => {
    const timer = setTimeout(() => { me.settle = null; resolve(true); }, wait);
    me.settle = (v) => { clearTimeout(timer); me.settle = null; resolve(v); };
  });
  me.mine = mine;
  return { mine, waited: Date.now() - t0 };
}

export function resetSameLine() { recent.length = 0; together.clear(); }
