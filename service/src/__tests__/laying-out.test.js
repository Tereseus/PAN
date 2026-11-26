// Laying out a problem (intuition/laying-out.js). Runs standalone, no server needed.
// Usage: node service/src/__tests__/laying-out.test.js

import { kindOf, step, lastLineOf, OPEN_MS } from '../intuition/laying-out.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

console.log('laying-out');

test('holds', () => {
  eq(kindOf("wait, I'm not done")?.kind, 'hold', 'wait not done');
  eq(kindOf('hold on, let me finish.')?.kind, 'hold', 'hold on let me finish');
  eq(kindOf('Sorry, one sec')?.kind, 'hold', 'one sec');
  eq(kindOf('wait what time is it'), null, 'wait + a question is a question');
  eq(kindOf('wait, what?'), null, 'wait what');
});

test('pieces', () => {
  eq(kindOf("Okay so here's the situation, I have two bags"), { kind: 'piece', rest: "Okay so here's the situation, I have two bags" }, 'setup opener');
  eq(kindOf("the microwave is a thousand watts, wait I'm not done"), { kind: 'piece', rest: 'the microwave is a thousand watts' }, 'hold at the end');
  eq(kindOf('These are the numbers:')?.kind, 'piece', 'colon');
  eq(kindOf("here's the thing, why does it burn?"), null, 'a question in it');
  eq(kindOf('I have two bags of popcorn'), null, 'a plain statement is an ordinary line');
});

test('pieces kept and answered as one request', () => {
  const t0 = 1_000_000;
  eq(step('a', "here's the situation, the bag says three minutes", '', t0).hold, true, 'piece 1 held');
  eq(step('a', "my microwave is 1200 watts, wait I'm not done", '', t0 + 6_000).hold, true, 'piece 2 held');
  const r = step('a', 'how long should I run it', '', t0 + 12_000);
  eq(r.text, "here's the situation, the bag says three minutes my microwave is 1200 watts how long should I run it", 'whole');
  eq(r.joined, 2, 'two pieces in front');
  eq(step('a', 'thanks', '', t0 + 14_000), { text: 'thanks' }, 'cleared after');
});

test('"wait, I\'m not done" takes his line before it', () => {
  const t0 = 2_000_000;
  const hist = 'User: I have a 20 dollar budget for six people\nPAN: That is about three dollars each.';
  eq(lastLineOf(hist), 'I have a 20 dollar budget for six people', 'last line');
  eq(step('b', "wait, I'm not done", hist, t0).hold, true, 'held');
  eq(step('b', 'two of them are vegetarian, what should I cook', hist, t0 + 5_000).text,
    'I have a 20 dollar budget for six people two of them are vegetarian, what should I cook', 'joined');
});

test("the phone's joined line is not doubled", () => {
  const t0 = 3_000_000;
  step('c', "here's the problem, the hub is slow", '', t0);
  eq(step('c', "here's the problem, the hub is slow when the car starts, why", '', t0 + 3_000).text,
    "here's the problem, the hub is slow when the car starts, why", 'once');
});

test('30 s of quiet drops the pieces', () => {
  const t0 = 4_000_000;
  step('d', "let me explain, it's the pendant", '', t0);
  eq(step('d', 'what time is it', '', t0 + OPEN_MS + 1), { text: 'what time is it' }, 'alone');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
