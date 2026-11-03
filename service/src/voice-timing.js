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

export function recordTiming(fields) {
  const line = JSON.stringify({ at: Date.now(), bench: isBench() || undefined, ...fields }) + '\n';
  appendFile(FILE, line, () => {});
  // Roll over now and then rather than stat-ing on every turn.
  if (++writes % 200 === 0) {
    stat(FILE, (err, s) => {
      if (!err && s.size > MAX_BYTES) rename(FILE, FILE + '.1', () => {});
    });
  }
}
