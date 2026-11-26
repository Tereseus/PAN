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
  const bench = isBench() || undefined;
  const line = JSON.stringify({ at, bench, ...fields }) + '\n';
  appendFile(timingFile(at, !!bench), line, () => {});
}
