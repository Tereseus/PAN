// The situational state program learns from his own turns, every night (2026-11-13;
// docs/INTUITION-STATE.md section 16). Local, no model, a few milliseconds of arithmetic.
//
// 1. Reads the turn book's labeled turns (turn-book.js: missed, intruded, spoke_ok, quiet_ok).
// 2. Tries the program's settings (participation.js DEFAULT_PARAMS) over a grid, scoring each on
//    the older 70% of the turns and checking the winner on the newest 30%. A new setting is kept
//    only when it beats the current one on the newest turns by MIN_GAIN with at least MIN_HELD of
//    them; every try is written to situation_learn_runs, kept or not.
// 3. Writes the labeled turns out as a dataset (data dir, situation-dataset/), the material for
//    the next voice model round.
// The rules these settings drive are shadowed until `situation_rules` = 'on': the learner scores
// what they WOULD have done against what he did next, so they earn their way in.
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { run, get } from '../db.js';
import { getDataDir } from '../platform.js';
import { labeledTurns, bookStats, trimBook } from './turn-book.js';
import { DEFAULT_PARAMS, shapeOf, panAskedLast, othersIn } from './participation.js';

const MIN_HELD = 20;
const MIN_GAIN = 0.02;
const TALK_MS = 45_000;
const GRID = { shortQuestionWords: [3, 4, 5, 6, 7, 8, 10], longLineWords: [8, 10, 12, 15, 20, 25, 1000] };
const SHOULD_SPEAK = { missed: true, spoke_ok: true, intruded: false, quiet_ok: false };

export function currentParams() {
  try {
    const v = get("SELECT value FROM settings WHERE key = 'situation_params'")?.value;
    return { ...DEFAULT_PARAMS, ...(v ? JSON.parse(String(v).replace(/^"|"$/g, '').replace(/\\"/g, '"')) : {}) };
  } catch { return { ...DEFAULT_PARAMS }; }
}

/**
 * What the program decides for a turn with these settings: true (speak), false (quiet), or the
 * logged decision when its rules have nothing to say. Right after PAN answered him, in a voice
 * not known to be someone else's: a short question is for PAN, a long line is for the room, a
 * bare "yeah" / "はいはい" needs no answer unless PAN just asked him something.
 */
export function programSays(turn, params) {
  const seen = JSON.parse(turn.seen || '{}');
  const did = JSON.parse(turn.did || '{}');
  if (seen.named_other) return false;
  const inTalk = Number.isFinite(seen.since_pan_ms) && seen.since_pan_ms < TALK_MS;
  if (inTalk && seen.voice !== 'other') {
    const sh = shapeOf(turn.text, params);
    if (sh.backchannel && !panAskedLast(turn.history)) return false;
    if (sh.short_question) return true;
    if (sh.long && othersIn(turn.history) > 0) return false;   // alone, a long line is for PAN (Nov 14)
  }
  return !!did.spoke;
}

function score(turns, params) {
  if (!turns.length) return null;
  let ok = 0;
  for (const t of turns) ok += programSays(t, params) === SHOULD_SPEAK[t.label];
  return ok / turns.length;
}

function ensure() {
  run(`CREATE TABLE IF NOT EXISTS situation_learn_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, labeled INTEGER, held INTEGER,
    current TEXT, best TEXT, current_score REAL, best_score REAL, logged_score REAL, kept INTEGER, note TEXT)`);
}

/** One learning pass. Returns a report (also logged and stored). */
export function learnOnce() {
  ensure();
  trimBook();
  const turns = labeledTurns().filter((t) => t.label in SHOULD_SPEAK);
  const cut = Math.floor(turns.length * 0.7);
  const train = turns.slice(0, cut), held = turns.slice(cut);
  const cur = currentParams();
  let best = cur, bestTrain = score(train, cur) ?? 0;
  for (const s of GRID.shortQuestionWords) {
    for (const l of GRID.longLineWords) {
      const p = { ...cur, shortQuestionWords: s, longLineWords: l };
      const sc = score(train, p) ?? 0;
      if (sc > bestTrain + 1e-9) { best = p; bestTrain = sc; }
    }
  }
  const curHeld = score(held, cur), bestHeld = score(held, best);
  const logged = held.length ? held.filter((t) => !!JSON.parse(t.did || '{}').spoke === SHOULD_SPEAK[t.label]).length / held.length : null;
  const changed = JSON.stringify(best) !== JSON.stringify(cur);
  const keep = changed && held.length >= MIN_HELD && bestHeld !== null && curHeld !== null && bestHeld >= curHeld + MIN_GAIN;
  const note = !turns.length ? 'no labeled turns yet' : held.length < MIN_HELD ? `only ${held.length} newest turns to check, need ${MIN_HELD}`
    : !changed ? 'current settings already best on the older turns' : keep ? 'kept: better on the newest turns' : 'not kept: no better on the newest turns';
  if (keep) run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('situation_params', :v)`, { ':v': JSON.stringify(best) });
  run(`INSERT INTO situation_learn_runs (at, labeled, held, current, best, current_score, best_score, logged_score, kept, note)
       VALUES (:at, :n, :h, :c, :b, :cs, :bs, :ls, :k, :note)`,
  { ':at': Date.now(), ':n': turns.length, ':h': held.length, ':c': JSON.stringify(cur), ':b': JSON.stringify(best),
    ':cs': curHeld, ':bs': bestHeld, ':ls': logged, ':k': keep ? 1 : 0, ':note': note });
  // The dataset: every labeled turn with what the program saw, what PAN did, and the label.
  try {
    const dir = join(getDataDir(), 'situation-dataset');
    mkdirSync(dir, { recursive: true });
    const lines = labeledTurns().map((t) => JSON.stringify({ at: t.at, text: t.text, history: t.history, lang: t.lang,
      seen: JSON.parse(t.seen || '{}'), did: JSON.parse(t.did || '{}'), label: t.label, why: t.label_why }));
    writeFileSync(join(dir, 'labeled.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''));
  } catch (e) { console.warn('[situation-learn] dataset write failed:', e.message); }
  const report = { labeled: turns.length, held: held.length, book: bookStats(), current: cur, best, current_score: curHeld,
    best_score: bestHeld, pan_as_logged: logged, kept: keep, note };
  console.log(`[situation-learn] ${note}; ${turns.length} labeled turns${curHeld !== null ? `, newest ${held.length}: settings ${(curHeld * 100).toFixed(0)}% -> best ${(bestHeld * 100).toFixed(0)}% (PAN as it was ${(logged * 100).toFixed(0)}%)` : ''}`);
  return report;
}
