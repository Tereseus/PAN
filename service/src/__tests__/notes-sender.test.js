// Notes for a device (phone-notes.js): who sent one is what PAN Link says, one device gets only
// so many spoken notes a minute, and a note goes to the device of the person it is for.
// Runs standalone on a fresh database, no PAN server needed.
// Usage: node service/src/__tests__/notes-sender.test.js

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

process.env.PAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'pan-notes-'));
process.env.PAN_DEV = '1';

const { run } = await import('../db.js');
const notes = await import('../phone-notes.js');
const { noteSender, maySpeakNow, addNote, takeNotesFor, noteOwnerSpokeOn, resetNotes, notesWaiting } = notes;
const { enqueuePhoneNote } = await import('../routes/api.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  resetNotes();
  run(`DELETE FROM settings WHERE key = 'notes_device'`);
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
const ids = (list) => list.map((n) => n.body).join(',');

const T0 = 2_000_000_000_000;
const SEC = 1000, MIN = 60_000;
const phone = { key: 'pixel-phone', linkDevice: 'd0000000000a1', person: null };
const tablet = { key: 'test-tablet', linkDevice: 'd0000000000a2', person: null };
const car = { key: 'car-unit', linkDevice: '', person: null };
const mia = { id: 7, role: 'child', power: 5, person: true };
const sam = { id: 8, role: 'user', power: 25, person: true };
const miaPhone = { key: '', linkDevice: 'd0000000000c1', person: mia };
const miaLaptop = { key: '', linkDevice: 'd0000000000c2', person: mia };
const samPhone = { key: '', linkDevice: 'd0000000000c3', person: sam };
const gonePhone = { key: '', linkDevice: 'd0000000000c4', person: { id: 0, role: 'guest', power: 0, person: true } };
const say = (body, to = {}, now = T0) => addNote({ type: 'speak', title: 't', body }, { ...to, now });

console.log('notes');

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
  for (let i = 0; i < 6; i++) ok(maySpeakNow(a, T0 + i * SEC) === true, `note ${i + 1} refused`);
  ok(maySpeakNow(a, T0 + 7 * SEC) === false, 'the seventh was let through');
  ok(maySpeakNow(a, T0 + 30 * SEC) === false, 'still inside the minute');
  ok(maySpeakNow({ device: 'd00000000000c', name: 'B' }, T0 + 7 * SEC) === true, 'another device was held back');
  ok(maySpeakNow(null, T0 + 7 * SEC) === true, 'the hub was held back');
  ok(maySpeakNow(a, T0 + 61 * SEC) === true, 'a minute later it may speak again');
});

test('nothing says which device is his: whichever of his devices asks takes the note, once', () => {
  say('one');
  ok(ids(takeNotesFor(miaPhone, T0 + SEC)) === '', 'a person\'s device took the owner\'s note');
  ok(ids(takeNotesFor(tablet, T0 + 2 * SEC)) === 'one', 'his tablet did not get it');
  ok(ids(takeNotesFor(phone, T0 + 3 * SEC)) === '', 'the same note was given twice');
});

test('his notes follow him to the device he last talked to PAN on', () => {
  takeNotesFor(phone, T0); takeNotesFor(tablet, T0); takeNotesFor(car, T0);
  noteOwnerSpokeOn('Car-Unit', T0);
  noteOwnerSpokeOn('test-tablet-bench', T0 + SEC);       // a test turn does not move him
  say('reminder', {}, T0 + 2 * SEC);
  ok(ids(takeNotesFor(phone, T0 + 3 * SEC)) === '', 'the phone took it while he is in the car');
  ok(ids(takeNotesFor(tablet, T0 + 4 * SEC)) === '', 'the tablet took it');
  ok(ids(takeNotesFor(car, T0 + 5 * SEC)) === 'reminder', 'the car did not get it');
});

test('the device he last talked on has gone away: after a short wait another of his takes it', () => {
  takeNotesFor(car, T0);
  noteOwnerSpokeOn('car-unit', T0);
  say('reminder', {}, T0 + 5 * MIN);                       // the car has not asked for five minutes
  ok(ids(takeNotesFor(phone, T0 + 5 * MIN + 5 * SEC)) === '', 'no wait at all for the car');
  ok(ids(takeNotesFor(phone, T0 + 5 * MIN + 25 * SEC)) === 'reminder', 'the note was lost with the car away');
});

test('a pinned device gets his notes, wherever he last talked', () => {
  run(`INSERT INTO settings (key, value) VALUES ('notes_device', :v) ON CONFLICT(key) DO UPDATE SET value = :v`, { ':v': JSON.stringify('Pixel-Phone') });
  resetNotes();
  takeNotesFor(phone, T0); takeNotesFor(tablet, T0);
  noteOwnerSpokeOn('test-tablet', T0);
  say('reminder', {}, T0 + SEC);
  ok(ids(takeNotesFor(tablet, T0 + 2 * SEC)) === '', 'the tablet took it');
  ok(ids(takeNotesFor(phone, T0 + 3 * SEC)) === 'reminder', 'the pinned phone did not get it');
  // The pinned phone is off: the note waits two minutes for it, then another of his devices takes it.
  say('later', {}, T0 + 10 * MIN);
  ok(ids(takeNotesFor(tablet, T0 + 11 * MIN)) === '', 'the tablet took it after one minute');
  ok(ids(takeNotesFor(tablet, T0 + 12 * MIN + 5 * SEC)) === 'later', 'the note was lost with the phone off');
});

test('a thread\'s late answer goes to the device that asked', () => {
  takeNotesFor(phone, T0); takeNotesFor(tablet, T0);
  noteOwnerSpokeOn('pixel-phone', T0);
  say('answer', { toDevice: 'Test-Tablet' }, T0 + SEC);
  ok(ids(takeNotesFor(phone, T0 + 2 * SEC)) === '', 'the phone took the tablet\'s answer');
  ok(ids(takeNotesFor(tablet, T0 + 3 * SEC)) === 'answer', 'the tablet did not get its answer');
  // The asker is gone: it goes to his device.
  say('answer two', { toDevice: 'car-unit' }, T0 + MIN);
  ok(ids(takeNotesFor(phone, T0 + MIN + 5 * SEC)) === '', 'no wait at all for the asker');
  ok(ids(takeNotesFor(tablet, T0 + MIN + 30 * SEC)) === '', 'it went to a device that is not his');
  ok(ids(takeNotesFor(phone, T0 + MIN + 31 * SEC)) === 'answer two', 'the answer was lost');
});

test('a note for a person goes to that person\'s devices and to nobody else\'s', () => {
  say('for mia', { toUser: mia.id });
  say('for the owner');
  ok(ids(takeNotesFor(samPhone, T0 + SEC)) === '', 'another person got it');
  ok(ids(takeNotesFor(gonePhone, T0 + SEC)) === '', 'a removed person\'s device got something');
  ok(ids(takeNotesFor(phone, T0 + 2 * SEC)) === 'for the owner', `the owner's phone got ${ids(takeNotesFor(phone, T0 + 2 * SEC))}`);
  ok(notesWaiting().length === 1 && notesWaiting()[0].to_user === mia.id, 'her note is not waiting for her');
  ok(ids(takeNotesFor(miaLaptop, T0 + 3 * SEC)) === 'for mia', 'her own device did not get it');
  ok(ids(takeNotesFor(miaPhone, T0 + 4 * SEC)) === '', 'it was given twice');
});

test('a person\'s device is known by its link key: the name it sends is not believed', () => {
  say('for the owner');
  ok(ids(takeNotesFor({ key: 'pixel-phone', linkDevice: 'd0000000000c1', person: mia }, T0 + SEC)) === '', 'a child\'s device calling itself his phone got his note');
  say('for mia, on her phone', { toUser: mia.id, toDevice: 'd0000000000c1' });
  ok(ids(takeNotesFor(miaLaptop, T0 + 2 * SEC)) === '', 'her laptop took the note meant for her phone');
  ok(ids(takeNotesFor(miaPhone, T0 + 3 * SEC)) === 'for mia, on her phone', 'her phone did not get it');
});

test('a device key that names a person\'s device sends the note to that person', () => {
  const n = enqueuePhoneNote({ type: 'speak', body: 'thread answer' }, null, { device: 'person7-d0000000000c1' });
  ok(n.to_user === 7 && n.to_device === 'd0000000000c1', JSON.stringify(n));
  const b = enqueuePhoneNote({ type: 'speak', body: 'bench' }, null, { device: 'person7-d0000000000c1-bench' });
  ok(b.to_user === 7 && b.to_device === 'd0000000000c1', JSON.stringify(b));
  ok(enqueuePhoneNote({ type: 'speak', body: 'his' }, null, { device: 'pixel-phone' }).to_user === 1, 'the owner\'s device key was read as a person\'s');
});

test('a spoken note nobody picked up is dropped after ten minutes; a message is kept', () => {
  say('old reminder');
  addNote({ type: 'slack', text: 'a message', body: 'msg' }, { now: T0 });
  const got = takeNotesFor(phone, T0 + 11 * MIN);
  ok(ids(got) === 'msg', `got ${ids(got)}`);
});

test('the owner can see which of his devices ask for notes; a person\'s device is not in that list', () => {
  takeNotesFor(phone, T0); takeNotesFor(tablet, T0 - MIN); takeNotesFor(miaPhone, T0);
  noteOwnerSpokeOn('test-tablet', T0);
  const d = notes.notesDevices(T0 + SEC);
  ok(d.pinned === null && d.last_spoke === 'test-tablet', JSON.stringify(d));
  ok(JSON.stringify(d.asking) === JSON.stringify([{ key: 'pixel-phone', away: false }, { key: 'test-tablet', away: true }]), JSON.stringify(d.asking));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
