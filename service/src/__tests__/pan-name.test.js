// Each device's own name for ΠAN (pan-name.js). Runs standalone, no server needed.
// Usage: node service/src/__tests__/pan-name.test.js

import { cleanName, mapName, callsOwnName, nameLine } from '../pan-name.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

console.log('pan-name');

test('clean', () => {
  eq(cleanName(' Jamie '), 'Jamie', 'trim');
  eq(cleanName('Mii-chan'), 'Mii-chan', 'hyphen');
  eq(cleanName('Pan'), '', 'ΠAN itself is no name of its own');
  eq(cleanName('ΠAN'), '', 'ΠAN in Greek letters');
  eq(cleanName('one two three four'), '', 'too long');
  eq(cleanName(''), '', 'empty');
});

test('where ΠAN is called', () => {
  eq(mapName('Jamie, what time is it', 'Jamie'), 'Pan, what time is it', 'start');
  eq(mapName('hey jamie what is the weather', 'Jamie'), 'hey Pan what is the weather', 'hey');
  eq(mapName('what is the weather, Jamie?', 'Jamie'), 'what is the weather, Pan?', 'end');
  eq(mapName("That's fine. Jamie, turn it off", 'Jamie'), "That's fine. Pan, turn it off", 'after a sentence');
  eq(mapName('I saw Jamie at the shop yesterday', 'Jamie'), 'I saw Jamie at the shop yesterday', 'talking about a Jamie');
  eq(mapName('Mii-chan, where is my bag', 'Mii-chan'), 'Pan, where is my bag', 'hyphen name');
  eq(mapName('Jamieson, hi', 'Jamie'), 'Jamieson, hi', 'part of a longer word');
  eq(mapName('Pan, what time is it', ''), 'Pan, what time is it', 'no name of its own');
});

test('calls own name', () => {
  eq(callsOwnName('Jamie, lights off', 'Jamie'), true, 'yes');
  eq(callsOwnName('Pan, lights off', 'Jamie'), false, 'the old name');
  eq(callsOwnName('Pan, lights off', ''), false, 'none set');
});

test('prompt line', () => {
  eq(nameLine('Jamie'), 'On this device your name is Jamie. Call yourself Jamie, never ΠAN.', 'line');
  eq(nameLine(''), '', 'none');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
