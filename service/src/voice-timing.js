// Per-turn hub timings, one JSON line each, for the conversation benchmark
// (evals/voicebench) and for anyone asking "where did that turn's time go".
//
// The [routeStream] timing lines only ever reached the console, which the hub
// does not keep, so no turn could be traced after the fact. Lines from api.js
// (recognition, total) and router.js (setup, model) share a turn id.
import { appendFile, stat, rename } from 'fs';
import { join } from 'path';
import { getDataDir } from './platform.js';
import { isBench } from './bench-context.js';

const FILE = join(getDataDir(), 'voice-timing.jsonl');
const MAX_BYTES = 5 * 1024 * 1024;
let writes = 0;

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
  const line = JSON.stringify({ at: Date.now(), bench: isBench() || undefined, ...fields }) + '\n';
  appendFile(FILE, line, () => {});
  // Roll over now and then rather than stat-ing on every turn.
  if (++writes % 200 === 0) {
    stat(FILE, (err, s) => {
      if (!err && s.size > MAX_BYTES) rename(FILE, FILE + '.1', () => {});
    });
  }
}
