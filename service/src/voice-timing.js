// Per-turn hub timings, one JSON line each, for the conversation benchmark
// (evals/voicebench) and for anyone asking "where did that turn's time go".
//
// The [routeStream] timing lines only ever reached the console, which the hub
// does not keep, so no turn could be traced after the fact. Lines from api.js
// (recognition, total) and router.js (setup, model) share a turn id.
import { appendFile } from 'fs';
import { join } from 'path';
import { getDataDir } from './platform.js';
import { isBench } from './bench-context.js';

// Kept for good (owner, Nov 26: "why would we ever get rid of the turn's timing?"). Until then one
// 5 MB file rolled over into a single .1, and benchmark runs filled it, so real turns were gone
// after about a day. Now one file a month, real turns and benchmark turns apart, nothing deleted.
// A real turn is about 1 KB over its stages, so a busy month is a few MB.
export function timingFile(at = Date.now(), bench = false, dir = getDataDir()) {
  const d = new Date(at);
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return join(dir, `voice-timing-${bench ? 'bench-' : ''}${month}.jsonl`);
}

/** The files that can hold a day's real turns: that month's, the month before (a turn near
 *  midnight on the 1st), and the two old names from before Nov 26. */
export function timingFilesFor(at, dir = getDataDir()) {
  const d = new Date(at);
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 15).getTime();
  return [...new Set([join(dir, 'voice-timing.jsonl.1'), join(dir, 'voice-timing.jsonl'),
    timingFile(prev, false, dir), timingFile(at, false, dir)])];
}

// The last turns' stages by turn id, so a reply can carry its own breakdown to the phone
// (the talk on Home shows it when a line is tapped).
const recent = new Map();
export function turnTimings(turn) {
  return recent.get(turn) || {};
}

export function recordTiming(fields) {
  if (fields.turn && fields.stage) {
    let t = recent.get(fields.turn);
    if (!t) {
      t = {};
      recent.set(fields.turn, t);
      if (recent.size > 200) recent.delete(recent.keys().next().value);
    }
    if (Number.isFinite(fields.ms)) t[`${fields.stage}_ms`] = fields.ms;
    if (fields.path) t.path = fields.path;
    if (fields.model) t.model = fields.model;
  }
  const at = Date.now();
  // The caller's own bench flag counts too: api.js passes bench:true on its lines outside the bench
  // context, and 930 bench lines went to the real turns' file (Nov 26).
  const row = { at, bench: isBench() || undefined, ...fields };
  if (!row.bench) delete row.bench;
  appendFile(timingFile(at, !!row.bench), JSON.stringify(row) + '\n', () => {});
}

// Every step of one turn, in order (the owner, Nov 27: "I need to know what every step costs and
// where that is happening, in order, so we can see what else we can cut"). api.js starts the clock
// when the turn arrives; api.js and router.js mark each step as it ends; api.js writes one row
// {stage:'steps', steps:[[name, ms since the turn arrived, ms the step took], ...]} at the end.
// A step only marks; it never waits, so the clock costs nothing a turn can feel.
const clocks = new Map();
export function startSteps(turn, start = Date.now()) {
  if (!turn) return;
  clocks.set(turn, { start, last: start, steps: [] });
  if (clocks.size > 100) clocks.delete(clocks.keys().next().value);
}
export function step(turn, name) {
  const c = turn && clocks.get(turn);
  if (!c) return;
  const now = Date.now();
  c.steps.push([name, now - c.start, now - c.last]);
  c.last = now;
}
export function stepsSoFar(turn) { return clocks.get(turn)?.steps || []; }
export function endSteps(turn, fields = {}) {
  const c = turn && clocks.get(turn);
  if (!c) return;
  clocks.delete(turn);
  recordTiming({ turn, stage: 'steps', steps: c.steps, ...fields });
}

/**
 * The silences between the pieces a device spoke (task 1107), each split by cause: text_late, the
 * hub's next words reached the voice after the last piece had ended; build_late, the device was
 * still building the sound after that; the rest of the gap is the speaker starting up. Lines carry
 * ms from the first piece: queued (text reached the voice), built (sound ready), play, end.
 */
export function speechGaps(lines = []) {
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], c = lines[i];
    if (!Number.isFinite(a?.end) || !Number.isFinite(c?.play)) continue;
    const text = Number.isFinite(c.queued) ? Math.max(0, c.queued - a.end) : null;
    const build = Number.isFinite(c.built) ? Math.max(0, c.built - Math.max(a.end, Number.isFinite(c.queued) ? c.queued : a.end)) : null;
    gaps.push({ ms: c.play - a.end, text_late: text, build_late: build });
  }
  return gaps;
}
