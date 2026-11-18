// Notes for the phone (routes/api.js): who sent one is what PAN Link says, and one device gets
// only so many spoken notes a minute. Runs standalone on a fresh database, no PAN server needed.
// Usage: node service/src/__tests__/notes-sender.test.js

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

process.env.PAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'pan-notes-'));
process.env.PAN_DEV = '1';

const { noteSender, maySpeakNow, enqueuePhoneNote } = await import('../routes/api.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }

console.log('notes sender');

test('the sender is the PAN Link device, not what the request says about itself', () => {
  const req = { panLinkDevice: { id: 'd00000000000a', name: 'Work PC' }, headers: { 'x-device-name': 'The owner phone' }, body: { from: { device: 'hub' }, sender: 'PAN' } };
  const from = noteSender(req);
  ok(from.device === 'd00000000000a' && from.name === 'Work PC', JSON.stringify(from));
  ok(noteSender({ headers: { 'x-pan-device': 'd00000000000a' }, body: {} }) === null, 'a header alone was believed');
  ok(noteSender(undefined) === null, 'no request');
});

test('a note keeps its sender; the hub\'s own notes have none', () => {
  const n = enqueuePhoneNote({ type: 'speak', title: 'Reminder', body: 'Stand up', from: { device: 'forged' } }, { device: 'd00000000000a', name: 'Work PC' });
  ok(n.from.device === 'd00000000000a', `the body's own "from" won: ${JSON.stringify(n.from)}`);
  ok(enqueuePhoneNote({ type: 'speak', body: 'From the hub' }).from === null, 'a hub note has a sender');
  ok(enqueuePhoneNote({ type: 'speak', body: 'x'.repeat(5000) }).body.length === 2000, 'a spoken note is not capped');
});

test('six spoken notes a minute for one device, then no; another device and the hub are not held back', () => {
  const a = { device: 'd00000000000b', name: 'A' };
  const t0 = 1_000_000;
  for (let i = 0; i < 6; i++) ok(maySpeakNow(a, t0 + i * 1000) === true, `note ${i + 1} refused`);
  ok(maySpeakNow(a, t0 + 7000) === false, 'the seventh was let through');
  ok(maySpeakNow(a, t0 + 30_000) === false, 'still inside the minute');
  ok(maySpeakNow({ device: 'd00000000000c', name: 'B' }, t0 + 7000) === true, 'another device was held back');
  ok(maySpeakNow(null, t0 + 7000) === true, 'the hub was held back');
  ok(maySpeakNow(a, t0 + 61_000) === true, 'a minute later it may speak again');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
