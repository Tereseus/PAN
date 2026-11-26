// Which device he is using now (intuition/where.js). Runs standalone, no server needed.
// Usage: node service/src/__tests__/where.test.js

import { whereNow } from '../intuition/where.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };
const NOW = 10_000_000;
const pc = (idle_s, ageMs = 10_000, id = 'laptop') => ({ device_id: id, platform: 'win32', as_of: NOW - ageMs, idle_s, activity: 'coding' });
const phone = (extra = {}, ageMs = 30_000) => ({ device_id: 'phone-1', platform: 'android', as_of: NOW - ageMs, ...extra });

test('typing on the computer: at the computer', () => {
  const w = whereNow({ rows: [pc(5)], voice: { at: NOW - 20 * 60_000 }, now: NOW, names: { laptop: 'G16' } });
  eq(w.kind, 'computer', 'kind'); eq(w.label, 'at the computer (G16)', 'label');
});

test('a computer left on with a window open is not presence', () => {
  const w = whereNow({ rows: [pc(900), { ...pc(undefined), idle_s: undefined }], voice: { at: NOW - 60_000, place: 'Home' }, now: NOW });
  eq(w.kind, 'phone', 'kind'); eq(w.label, 'Home', 'label');
});

test('car mode on the phone: in the car, even with the computer recently used', () => {
  const w = whereNow({ rows: [pc(200), phone({ in_car: 1 })], voice: { at: NOW - 30_000 }, now: NOW });
  eq(w.kind, 'car', 'kind'); eq(w.label, 'in the car', 'label');
});

test('moving at 60 km/h: in the car with no car Bluetooth', () => {
  const w = whereNow({ rows: [phone({ speed_kmh: 60 })], voice: { at: NOW - 30_000 }, now: NOW });
  eq(w.kind, 'car', 'kind');
});

test('walking pace is not a car', () => {
  const w = whereNow({ rows: [phone({ speed_kmh: 5 })], voice: { at: NOW - 30_000 }, now: NOW });
  eq(w.kind, 'phone', 'kind');
});

test('home from the car: a fresh keyboard beats an old car sign', () => {
  const w = whereNow({ rows: [phone({ in_car: 1 }, 8 * 60_000), pc(10)], voice: { at: NOW - 8 * 60_000 }, now: NOW });
  eq(w.kind, 'computer', 'kind');
});

test('a phone turn said at the desk while typing: the computer wins within a minute', () => {
  const w = whereNow({ rows: [pc(20)], voice: { at: NOW - 5_000 }, now: NOW });
  eq(w.kind, 'computer', 'kind');
});

test('nothing at all: unknown', () => {
  const w = whereNow({ rows: [], voice: null, now: NOW });
  eq(w.kind, null, 'kind');
});

test('old phone turn and nothing else: mobile, as before', () => {
  const w = whereNow({ rows: [], voice: { at: NOW - 3 * 3600_000, place: 'Home' }, now: NOW });
  eq(w.label, 'mobile', 'label');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
