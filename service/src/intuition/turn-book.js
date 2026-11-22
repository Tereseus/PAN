// The situational state program's turn book (2026-11-13; docs/INTUITION-STATE.md section 16).
//
// Every real voice turn is kept with what the program saw and what PAN did, and the next turn
// labels the one before it from what he did next. Nothing for him to do, no model:
//   missed     PAN stayed quiet and he called it ("hello?", "PAN?") or said it again WITH the name
//   intruded   PAN spoke and he said "not now" / "shh", went on dictating, talked over it, or the
//              line was for another assistant ("Okay Google ...")
//   wrong      PAN was right to answer, but he said the answer was wrong ("that's wrong")
//   spoke_ok   PAN spoke and he went on with a follow-up to it
//   quiet_ok   PAN stayed quiet and the talk went on without anyone asking again (a weak label)
// Labels v2 (2026-11-22, docs/CONVERSATION-CALCULUS.md section 10): on his first 1,390 turns, v1
// called 123 turns missed, but 76 were while he dictated or music played and most of the rest were
// the same words heard twice or a song; and only "shh" counted as PAN talking over him (6 turns).
// A plain repeat no longer counts (it can't be told from hearing the same words twice), turns a
// hard rule decided (music, dictating) get no quiet label, and four new signs of PAN butting in
// count. relabelAll() redoes the stored turns with the current rules.
// The nightly learner (situation-learn.js) retunes the program on these labels, and they are the
// dataset for the next voice model round. Kept in his own encrypted database, his PAN only.
// Bench turns and test devices never come here.
import { run, all, get, insert } from '../db.js';
import { followUpOf } from './conversation.js';

const KEEP_DAYS = 180;
const REPEAT_MS = 25_000;     // he asks again within this: PAN missed it
const STOP_MS = 15_000;       // "not now" within this after PAN spoke: PAN intruded
const FOLLOW_MS = 45_000;     // a follow-up within this: PAN was right to answer
const DICTATE_MS = 45_000;   // he goes on dictating within this after PAN spoke: PAN butted in
const OVER_MS = 400;          // his next line came this soon after PAN's voice stopped: he talked over it
export const LABEL_V = 2;
// Quiet turns a hard rule decided: the program's weighing never ran, so "the talk went on"
// says nothing about it.
const RULED = new Set(['music_playing', 'dictating']);

// "Not now" in the languages the test covers. A miss costs one unlabeled turn, nothing else.
const STOP = new RegExp([
  "^(?:shh+|sh+|hush|stop|quiet|be quiet|not now|not you|enough|never ?mind|forget it)\\b",
  "\\bi (?:wasn'?t|was not) (?:talking|asking|speaking) (?:to|for) you\\b", "\\bnot talking to you\\b", "\\bnobody asked you\\b",
  "^(?:σ+ς+|σώπα|όχι τώρα|δεν μιλάω σε σένα)", "^(?:cállate|ahora no|no te hablaba)", "^(?:chut|pas maintenant|tais-toi)",
  "^(?:psst|nicht jetzt|ruhe)", "^(?:zitto|non ora|non adesso)", "^(?:agora não|cala-te|cala a boca)", "^(?:sus|şimdi değil)",
  "^(?:тихо|не сейчас|замолчи)", "^(?:静か|今じゃない|黙って)", "^(?:安静|不是现在|别说了|不是跟你说)", "^(?:조용|지금 말고|너한테 한 말 아니야)",
].join('|'), 'iu');
const AGAIN = /^(?:hello\??|hey\??|pan\??|are you there\??|did you hear(?: me)?\??|answer me|well\?|ε+ ?\??|γεια\??|μ' ακούς;?|oye\??|allô\??|hallo\??|алло\??|もしもし|喂)$/iu;

// He called PAN by name (router.js saysPanName, kept in step): "hey Pan, ...", "Pan, ...", "..., Pan?".
// Not "Pan replies and I can't see it": that is him talking ABOUT PAN.
function callsPan(text) {
  const t = String(text || '').trim();
  if (/^(?:hey|hi|hello|ok|okay|yo)[,\s]+(?:pan|pam|pa+h?n+d?)\b/i.test(t)) return true;
  if (/\b(?:pan|pam|pa+h?n+d?)[\s?.!]*$/i.test(t)) return true;
  return /^(?:pan|pam)\b/i.test(t) && !/^(?:pan|pam)(?:['’]s\b|\s+(?:is|was|isn't|wasn't|replies|replied|says|said|should|does|doesn't|did|didn't|has|had|can't|could|keeps|kept|answers|answered|needs|thinks|knows|will|won't|would|seems|gets|got|just|still|always|never|app|thread|project|dashboard|hub|phone|voice)\b)/i.test(t);
}
// The line opens with another assistant's name: "Okay Google, ...", "A google, set an alarm" (the
// speech model drops the "Ok"), "Hey Siri", "Alexa, ...". Claude and ChatGPT only with hey/okay:
// he talks ABOUT Claude all the time.
const OTHER_AI = /^\W*(?:(?:ok(?:ay)?|hey|hi|a|o)[\s,.!]+)?(?:google|alexa|siri|gemini|bixby|cortana)\b|^\W*(?:ok(?:ay)?|hey|hi)[\s,.!]+(?:claude|chat ?gpt|copilot)\b/i;
export function forOtherAssistant(text) {
  return OTHER_AI.test(String(text || ''));
}
// He says PAN's answer was wrong. PAN was right to answer; the answer wasn't.
const WRONG = /^\W*(?:no[,.!\s]+)?(?:that'?s|that is|this is|you'?re|you are|it'?s)\s+(?:wrong|not right|not true|not correct|incorrect)\b|^\W*(?:wrong|incorrect|not true)\W*$|^\W*that (?:doesn'?t|does not) make (?:any )?sense\b|^\W*(?:λάθος|δεν είναι (?:έτσι|σωστό))/iu;

const LAUGH = /^\W*(?:(?:ha|he|hah|heh|lol|haha|yeah|yes|ok|okay|mm+|hm+|right|nice|cool|wow)[\s,.!]*)+$/i;

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

/** The label the new turn gives the one before it, or null. prev and now are book rows. */
export function labelFrom(prev, now) {
  if (!prev || !now) return null;
  const gap = now.at - prev.at;
  const t = String(now.text || '').trim();
  const pd = JSON.parse(prev.did || '{}');
  const nd = JSON.parse(now.did || '{}');
  const ns = JSON.parse(now.seen || '{}');
  if (ns.voice === 'other') return null;    // only his reaction labels PAN
  if (!spoke(pd)) {
    if (gap > REPEAT_MS) return null;
    if (AGAIN.test(t)) return ['missed', 'he called again'];
    if (callsPan(t) && !callsPan(prev.text) && overlap(prev.text, t) >= 0.5) return ['missed', 'he said it again with the name'];
    if (RULED.has(pd.reason)) return null;
    // Said again, or the same words heard twice, or a song's chorus: can't tell, so no label.
    if (overlap(prev.text, t) >= 0.6) return null;
    return ['quiet_ok', 'the talk went on'];
  }
  if (forOtherAssistant(prev.text)) return ['intruded', 'it was for another assistant'];
  if (gap <= STOP_MS && STOP.test(t)) return ['intruded', 'he stopped PAN'];
  if (gap <= STOP_MS && WRONG.test(t)) return ['wrong', 'he said the answer was wrong'];
  if (gap <= DICTATE_MS && nd.reason === 'dictating') return ['intruded', 'he was dictating'];
  if (gap <= FOLLOW_MS) {
    const hist = `${prev.history || ''}
User: ${prev.text}
PAN: ${pd.response || ''}`;
    if (followUpOf(hist, t)) return ['spoke_ok', 'he followed up'];
  }
  // Laughing or a bare "yeah" on top of PAN is a reaction to it, not talking over it.
  if (LAUGH.test(t)) return null;
  if (gap <= DICTATE_MS && Number.isFinite(ns.since_pan_ms) && ns.since_pan_ms < OVER_MS) return ['intruded', 'he talked over PAN'];
  return null;
}

/** Redo every stored label with the current rules, in order. Returns the counts. */
export function relabelAll(orgId = null) {
  ensure();
  const rows = all(`SELECT * FROM situation_turns ${orgId ? 'WHERE org_id = :o' : ''} ORDER BY id`, orgId ? { ':o': orgId } : {});
  const last = new Map();
  const counts = {};
  for (const row of rows) {
    const prev = last.get(row.org_id);
    if (prev) {
      const lab = labelFrom(prev, row);
      // A spoken reply to another assistant's line is wrong on its own, next turn or not.
      if (lab || prev.label) {
        run('UPDATE situation_turns SET label = :l, label_why = :w, labeled_at = :t WHERE id = :id',
          { ':l': lab ? lab[0] : null, ':w': lab ? lab[1] : null, ':t': lab ? row.at : null, ':id': prev.id });
      }
      const k = lab ? lab[0] : 'unlabeled';
      counts[k] = (counts[k] || 0) + 1;
    }
    last.set(row.org_id, row);
  }
  console.log(`[turn-book] relabeled ${rows.length} turns (labels v${LABEL_V}):`, JSON.stringify(counts));
  return counts;
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
