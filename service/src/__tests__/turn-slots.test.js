// Which voice turn from a device is the live one (turn-slots.js): newer cancels older, late turns
// are dropped, and a tentative no-words clip cancels nothing until it is real words for ΠAN
// (car, Nov 24 and 25). Runs standalone, no server needed.
// Usage: node service/src/__tests__/turn-slots.test.js

import { turnSlots } from '../turn-slots.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || ''} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const KEY = 'phone:car';
function fresh() {
  const streams = new Map();
  const newest = new Map();
  return { streams, newest, slots: turnSlots(streams, newest) };
}

test('a newer turn cancels the one still in flight', () => {
  const { streams, slots } = fresh();
  const a = new AbortController(), b = new AbortController();
  slots.open({ streamKey: KEY, sentAt: 1000, controller: a });
  slots.open({ streamKey: KEY, sentAt: 2000, controller: b });
  eq(a.signal.aborted, true, 'old aborted');
  eq(streams.get(KEY).controller, b, 'new owns the key');
});

test('an older turn landing late is dropped and cancels nothing', () => {
  const { slots } = fresh();
  const a = new AbortController(), b = new AbortController();
  slots.open({ streamKey: KEY, sentAt: 2000, controller: a });
  const late = slots.open({ streamKey: KEY, sentAt: 1000, controller: b });
  eq(late.late, true, 'late');
  eq(a.signal.aborted, false, 'newer untouched');
});

test('a tentative clip does not cancel the waiting question (car, Nov 25)', () => {
  const { streams, slots } = fresh();
  const q = new AbortController(), noise = new AbortController();
  slots.open({ streamKey: KEY, sentAt: 1000, controller: q });
  const t = slots.open({ streamKey: KEY, sentAt: 2000, tentative: true, controller: noise });
  eq(q.signal.aborted, false, 'question still running');
  eq(streams.get(KEY).controller, q, 'question owns the key');
  eq(t.key, `${KEY}:tentative`, 'clip under its own key');
});

test('a tentative clip is not the newest turn: the question, landing late, is still kept', () => {
  const { slots } = fresh();
  const noise = new AbortController(), q = new AbortController();
  slots.open({ streamKey: KEY, sentAt: 2000, tentative: true, controller: noise });
  const s = slots.open({ streamKey: KEY, sentAt: 1000, controller: q });
  eq(s.late, false, 'not dropped as late');
});

test('noise that gets nothing back leaves the question alone, and releases its own key', () => {
  const { streams, slots } = fresh();
  const q = new AbortController(), noise = new AbortController();
  slots.open({ streamKey: KEY, sentAt: 1000, controller: q });
  const t = slots.open({ streamKey: KEY, sentAt: 2000, tentative: true, controller: noise });
  eq(slots.realReply({ intent: 'ambient', response: '', reason: 'nothing_heard' }), false, 'nothing heard is not real');
  eq(slots.realReply({ intent: 'ambient', response: '[AMBIENT]' }), false, 'ambient is not real');
  t.release();
  eq(streams.has(`${KEY}:tentative`), false, 'clip key gone');
  eq(streams.get(KEY).controller, q, 'question still owns the key');
  eq(q.signal.aborted, false, 'question still running');
});

test('a tentative clip that was real words takes over', () => {
  const { streams, newest, slots } = fresh();
  const q = new AbortController(), clip = new AbortController();
  slots.open({ streamKey: KEY, sentAt: 1000, controller: q });
  const t = slots.open({ streamKey: KEY, sentAt: 2000, tentative: true, controller: clip });
  eq(slots.realReply({ intent: 'query', response: 'Sure, sending them.' }), true, 'a reply is real');
  eq(t.promote(), true, 'promoted');
  eq(q.signal.aborted, true, 'question superseded');
  eq(streams.get(KEY).controller, clip, 'clip owns the key');
  eq(streams.has(`${KEY}:tentative`), false, 'tentative key gone');
  eq(t.key, KEY, 'slot moved');
  eq(newest.get(KEY), 2000, 'clip is the newest now');
  eq(t.promote(), false, 'only once');
});

test('a newer real turn cancels a pending tentative clip too', () => {
  const { slots } = fresh();
  const q = new AbortController(), noise = new AbortController(), next = new AbortController();
  slots.open({ streamKey: KEY, sentAt: 1000, controller: q });
  slots.open({ streamKey: KEY, sentAt: 2000, tentative: true, controller: noise });
  slots.open({ streamKey: KEY, sentAt: 3000, controller: next });
  eq(noise.signal.aborted, true, 'clip cancelled');
  eq(q.signal.aborted, true, 'question cancelled');
});

test('a held, muted or camera reply is judged correctly', () => {
  const { slots } = fresh();
  eq(slots.realReply({ intent: 'query', response: 'Maybe.', hold_ms: 1500 }), false, 'held');
  eq(slots.realReply({ intent: 'query', response: '', mute: true }), false, 'mute');
  eq(slots.realReply({ intent: 'query', response: '', camera: true }), true, 'camera');
  eq(slots.realReply({ intent: 'cancelled', response: '' }), false, 'cancelled');
});

test('release does not unregister a newer turn', () => {
  const { streams, slots } = fresh();
  const a = new AbortController(), b = new AbortController();
  const sa = slots.open({ streamKey: KEY, sentAt: 1000, controller: a });
  slots.open({ streamKey: KEY, sentAt: 2000, controller: b });
  sa.release();
  eq(streams.get(KEY).controller, b, 'newer still registered');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
