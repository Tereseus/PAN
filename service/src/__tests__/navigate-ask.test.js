// Which spoken lines start Google Maps navigation (navigate-ask.js, task 1106): asks like the car's of
// Nov 28 (made-up places) and lines that must stay talk. Runs standalone on a fresh database, no PAN server needed.
// Usage: node service/src/__tests__/navigate-ask.test.js

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

process.env.PAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'pan-navigate-'));
process.env.PAN_DEV = '1';

const { navigationAsk, navigationTurn } = await import('../navigate-ask.js');

const cases = [
  ['Take me to Blue Harbor Cafe.', 'Blue Harbor Cafe'],
  ["Okay, so let's try the GPS. Put a GPS to blue harbor cafe. Let's see it.", 'blue harbor cafe'],
  ['Hey Pan, navigate to the airport please', 'the airport'],
  ['Can you give me directions to Springfield?', 'Springfield'],
  ['Take me home.', 'Home'],
  ['Drive me to the nearest gas station', 'the nearest gas station'],
  ['Navigate to Blue Harbor Cafe on Google Maps', 'Blue Harbor Cafe'],
  ['He took me to the market yesterday.', null],
  ["They'll take me to the airport tomorrow.", null],
  ['Can you control the maps on my car unit or not?', null],
  ['I need you to take me to it', null],
  ['The GPS in this car is on.', null],
  ['What is the meaning of life?', null],
];

let bad = 0;
for (const [line, want] of cases) {
  const got = navigationAsk(line);
  if (got !== want) { bad++; console.log(`FAIL ${JSON.stringify(line)} -> ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

// A bench turn on a phone gets the action; the dashboard never does.
const t = navigationTurn('Take me to Blue Harbor Cafe.', { source: 'phone-x-bench', device_id: 'x-bench' });
if (t?.actions?.[0]?.type !== 'navigate' || t.actions[0].args.destination !== 'Blue Harbor Cafe') { bad++; console.log('FAIL bench turn has no navigate action', JSON.stringify(t)); }
if (navigationTurn('Take me to Blue Harbor Cafe.', { source: 'dashboard' }) !== null) { bad++; console.log('FAIL dashboard got a navigate turn'); }

console.log(bad ? `${bad} failed of ${cases.length + 2}` : `all ${cases.length + 2} passed`);
process.exit(bad ? 1 : 0);
