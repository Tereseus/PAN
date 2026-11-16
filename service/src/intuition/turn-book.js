// The situational state program's turn book (2026-11-13; docs/INTUITION-STATE.md section 16).
//
// Every real voice turn is kept with what the program saw and what PAN did, and the next turn
// labels the one before it from what he did next. Nothing for him to do, no model:
//   missed     PAN stayed quiet and he said it again, or "hello? / are you there?", soon after
//   intruded   PAN spoke and he said "not now", "shh", "I wasn't talking to you" soon after
//   spoke_ok   PAN spoke and he went on with a follow-up to it
//   quiet_ok   PAN stayed quiet and the talk went on without anyone asking again (a weak label)
// The nightly learner (situation-learn.js) retunes the program on these labels, and they are the
// dataset for the next voice model round. Kept in his own encrypted database, his PAN only.
// Bench turns never come here.
import { run, all, get, insert } from '../db.js';
import { followUpOf } from './conversation.js';

const KEEP_DAYS = 180;
const REPEAT_MS = 25_000;     // he asks again within this: PAN missed it
const STOP_MS = 15_000;       // "not now" within this after PAN spoke: PAN intruded
const FOLLOW_MS = 45_000;     // a follow-up within this: PAN was right to answer

// "Not now" in the languages the test covers. A miss costs one unlabeled turn, nothing else.
const STOP = new RegExp([
  "^(?:shh+|sh+|hush|stop|quiet|be quiet|not now|not you|enough|never ?mind|forget it)\\b",
  "\\bi (?:wasn'?t|was not) (?:talking|asking|speaking) (?:to|for) you\\b", "\\bnot talking to you\\b", "\\bnobody asked you\\b",
  "^(?:σ+ς+|σώπα|όχι τώρα|δεν μιλάω σε σένα)", "^(?:cállate|ahora no|no te hablaba)", "^(?:chut|pas maintenant|tais-toi)",
  "^(?:psst|nicht jetzt|ruhe)", "^(?:zitto|non ora|non adesso)", "^(?:agora não|cala-te|cala a boca)", "^(?:sus|şimdi değil)",
  "^(?:тихо|не сейчас|замолчи)", "^(?:静か|今じゃない|黙って)", "^(?:安静|不是现在|别说了|不是跟你说)", "^(?:조용|지금 말고|너한테 한 말 아니야)",
].join('|'), 'iu');
const AGAIN = /^(?:hello\??|hey\??|pan\??|are you there\??|did you hear(?: me)?\??|answer me|well\??|ε+ ?\??|γεια\??|μ' ακούς;?|oye\??|allô\??|hallo\??|алло\??|もしもし|喂)$/iu;

let _ready = false;
function ensure() {
  if (_ready) return;
  run(`CREATE TABLE IF NOT EXISTS situation_turns (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         INTEGER NOT NULL,
    org_id     TEXT,
    text       TEXT NOT NULL,
    history    TEXT,
    lang       TEXT,
    seen       TEXT,
    did        TEXT,
    label      TEXT,
    label_why  TEXT,
    labeled_at INTEGER
  )`);
  run('CREATE INDEX IF NOT EXISTS situation_turns_at ON situation_turns(at)');
  _ready = true;
}

function wordsOf(t) {
  return new Set(String(t || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
}

function overlap(a, b) {
  const A = wordsOf(a), B = wordsOf(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

function spoke(did) {
  return !!did?.spoke;
}

/** The label the new turn gives the one before it, or null. */
export function labelFrom(prev, now) {
  if (!prev || !now) return null;
  const gap = now.at - prev.at;
  const t = String(now.text || '').trim();
  const pd = JSON.parse(prev.did || '{}');
  const notHim = JSON.parse(now.seen || '{}').voice === 'other';
  if (notHim) return null;    // only his reaction labels PAN
  if (!spoke(pd)) {
    if (gap <= REPEAT_MS && (AGAIN.test(t) || overlap(prev.text, t) >= 0.6)) return ['missed', AGAIN.test(t) ? 'he called again' : 'he said it again'];
    if (gap <= REPEAT_MS) return ['quiet_ok', 'the talk went on'];
    return null;
  }
  if (gap <= STOP_MS && STOP.test(t)) return ['intruded', 'he stopped PAN'];
  if (gap <= FOLLOW_MS) {
    const hist = `${prev.history || ''}\nUser: ${prev.text}\nPAN: ${pd.response || ''}`;
    if (followUpOf(hist, t)) return ['spoke_ok', 'he followed up'];
  }
  return null;
}

/**
 * Keep a real turn and label the one before it. seen = what the program saw (place, voice,
 * named_other, since_pan_ms, p_pan); did = what PAN did ({ spoke, reason, response }).
 */
export function noteTurn({ orgId = 'org_personal', text, history = '', lang = null, seen = {}, did = {} }) {
  try {
    ensure();
    const now = { at: Date.now(), text: String(text || ''), seen: JSON.stringify(seen), did: JSON.stringify(did) };
    if (!now.text.trim()) return;
    const tail = String(history || '').split('\n').filter((l) => l.trim()).slice(-6).join('\n');
    const prev = get('SELECT * FROM situation_turns WHERE org_id = :o ORDER BY id DESC LIMIT 1', { ':o': orgId });
    const lab = prev && !prev.label ? labelFrom(prev, now) : null;
    if (lab) {
      run('UPDATE situation_turns SET label = :l, label_why = :w, labeled_at = :t WHERE id = :id',
        { ':l': lab[0], ':w': lab[1], ':t': now.at, ':id': prev.id });
      console.log(`[turn-book] last turn: ${lab[0]} (${lab[1]})`);
    }
    insert(`INSERT INTO situation_turns (at, org_id, text, history, lang, seen, did) VALUES (:at, :o, :x, :h, :l, :s, :d)`,
      { ':at': now.at, ':o': orgId, ':x': now.text.slice(0, 2000), ':h': tail.slice(0, 4000), ':l': lang, ':s': now.seen, ':d': now.did });
  } catch (e) { console.warn('[turn-book] skipped:', e.message); }
}

/** The labeled turns, oldest first, for the learner and the dataset. */
export function labeledTurns(sinceDays = KEEP_DAYS) {
  ensure();
  return all('SELECT * FROM situation_turns WHERE label IS NOT NULL AND at >= :t ORDER BY id', { ':t': Date.now() - sinceDays * 86_400_000 });
}

export function bookStats() {
  ensure();
  const rows = all('SELECT label, COUNT(*) AS n FROM situation_turns GROUP BY label');
  return Object.fromEntries(rows.map((r) => [r.label || 'unlabeled', r.n]));
}

export function trimBook() {
  ensure();
  run('DELETE FROM situation_turns WHERE at < :t', { ':t': Date.now() - KEEP_DAYS * 86_400_000 });
}
