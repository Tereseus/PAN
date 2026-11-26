// Message mode for threads (message-mode.js). Runs standalone, no server needed.
// Usage: node service/src/__tests__/message-mode.test.js

import { parseStart, parseEnd, isCancel, start, step, taking, stateOf, clear, QUIET_END_MS, KEEP_MS } from '../message-mode.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
const TH = { title: 'PAN', host: 'g16' };

console.log('message-mode');

test('start lines', () => {
  eq(parseStart('Pan, message for the PAN thread'), { name: 'PAN', rest: '' }, 'plain');
  eq(parseStart('take a message to my mint music thread: first the drums'), { name: 'mint music', rest: 'first the drums' }, 'with rest');
  eq(parseStart('message mode for the WoE thread.'), { name: 'WoE', rest: '' }, 'mode');
  eq(parseStart('send a message to the PAN thread saying hi'), null, 'a normal send is not message mode');
  eq(parseStart('message for Maria'), null, 'a person, no thread word');
  eq(parseStart('I left a note for the guy about the thread count'), null, 'mid-sentence');
});

test('end lines only on their own', () => {
  eq(parseEnd('send it'), { rest: '' }, 'alone');
  eq(parseEnd('Okay, send it.'), { rest: '' }, 'okay');
  eq(parseEnd("and that's the last thing. Send it."), { rest: "and that's the last thing" }, 'after a full stop');
  eq(parseEnd('Over.'), { rest: '' }, 'over');
  eq(parseEnd('over and out'), { rest: '' }, 'over and out');
  eq(parseEnd("when I press it the app doesn't send it"), null, 'inside a sentence');
  eq(parseEnd('then we start over'), null, 'start over');
});

test('cancel', () => {
  eq(isCancel('cancel the message'), true, 'cancel');
  eq(isCancel("don't send it"), true, "don't send");
  eq(isCancel('cancel the build when it fails'), false, 'other cancel');
});

test('pieces kept word for word, sent whole', () => {
  const t0 = 1_000_000;
  start('d1', TH, '', t0);
  eq(step('d1', 'first the voice is slow', t0 + 5_000).act, 'keep', 'piece 1');
  eq(step('d1', 'and second the pendant drops out', t0 + 20_000).act, 'keep', 'piece 2');
  const r = step('d1', 'send it', t0 + 130_000);
  eq(r.act, 'send', 'sent');
  eq(r.text, 'first the voice is slow and second the pendant drops out', 'whole text');
  eq(r.size, '11 words, about 2 minutes', 'size');
  eq(stateOf('d1', t0 + 131_000), null, 'cleared');
});

test("the phone's joined line replaces the piece it holds", () => {
  const t0 = 2_000_000;
  start('d2', TH, '', t0);
  step('d2', 'the popcorn burns', t0 + 1_000);
  step('d2', 'the popcorn burns at the end', t0 + 4_000);
  eq(step('d2', 'send it', t0 + 9_000).text, 'the popcorn burns at the end', 'no doubling');
});

test('the start line joined onto the first piece', () => {
  const t0 = 3_000_000;
  start('d3', TH, '', t0);
  step('d3', 'message for the PAN thread the hub is slow', t0 + 3_000);
  eq(step('d3', 'send it', t0 + 8_000).text, 'the hub is slow', 'start words dropped');
});

test('empty send and cancel', () => {
  const t0 = 4_000_000;
  start('d4', TH, '', t0);
  eq(step('d4', 'send it', t0 + 1_000).act, 'empty_send', 'nothing said yet');
  eq(step('d4', 'cancel the message', t0 + 2_000).act, 'cancel', 'cancel');
  eq(stateOf('d4', t0 + 3_000), null, 'gone');
});

test('15 minutes of quiet stops the taking; the draft waits an hour for "send the message"', () => {
  const t0 = 5_000_000;
  start('d5', TH, 'the first part', t0);
  const later = t0 + QUIET_END_MS + 1_000;
  eq(taking('d5', later), false, 'stopped');
  eq(step('d5', 'what time is it', later), null, 'an ordinary line again');
  eq(step('d5', 'send it', later + 1_000), null, 'a plain send it is about something else');
  eq(step('d5', 'send the message', later + 2_000).text, 'the first part', 'sent');
  start('d6', TH, 'old', t0);
  eq(stateOf('d6', t0 + KEEP_MS + 1), null, 'dropped after an hour');
  clear('d6');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
