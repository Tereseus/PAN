import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRinging, ringingWords, ringQuestion, wantsStop, stoppedWords } from '../ringing.js';

const clock = () => { let t = 1_000_000; const f = () => t; f.add = (ms) => { t += ms; }; return f; };

test('a device that says it rings is ringing, until it says it stopped', () => {
  const now = clock(); const r = createRinging({ now });
  r.report(1, 'pixel-10-pro', { ringing: true, name: 'Pixel 10 Pro' });
  assert.deepEqual(r.ringingFor(1), [{ key: 'pixel-10-pro', name: 'Pixel 10 Pro' }]);
  r.report(1, 'pixel-10-pro', { ringing: false });
  assert.deepEqual(r.ringingFor(1), []);
});

test('a device that stopped asking is not ringing after 15 s', () => {
  const now = clock(); const r = createRinging({ now });
  r.report(1, 'pad', { ringing: true, name: 'Pad' });
  now.add(16_000);
  assert.deepEqual(r.ringingFor(1), []);
});

test('only the person\'s own devices are seen or stopped', () => {
  const now = clock(); const r = createRinging({ now });
  r.report(5, 'pixel-6', { ringing: true, name: 'Pixel 6 Pro' });
  assert.deepEqual(r.ringingFor(1), []);
  assert.deepEqual(r.stopFor(1), []);
  assert.equal(r.report(5, 'pixel-6', { ringing: true }), false);
});

test('a stop reaches the ringing device once, on its next ask', () => {
  const now = clock(); const r = createRinging({ now });
  r.report(1, 'pad', { ringing: true, name: 'Pad' });
  r.report(1, 'pixel', { ringing: true, name: 'Pixel' });
  assert.equal(r.stopFor(1).length, 2);
  assert.equal(r.report(1, 'pad', { ringing: true }), true);
  assert.equal(r.report(1, 'pad', { ringing: false }), false);
  assert.equal(r.report(1, 'pixel', { ringing: false }), true);
});

test('a stop nobody picked up in 30 s is dropped', () => {
  const now = clock(); const r = createRinging({ now });
  r.report(1, 'pad', { ringing: true });
  r.stopFor(1);
  now.add(31_000);
  assert.equal(r.report(1, 'pad', { ringing: true }), false);
});

test('a device with no name is never recorded', () => {
  const r = createRinging({ now: clock() });
  assert.equal(r.report(1, '', { ringing: true }), false);
  assert.deepEqual(r.ringingFor(1), []);
});

test('the words name every ringing device', () => {
  assert.equal(ringingWords([{ name: 'Pixel 10 Pro' }]), 'his Pixel 10 Pro');
  assert.equal(ringingWords([{ name: 'Pixel 10 Pro' }, { name: 'Pad' }]), 'his Pixel 10 Pro and his Pad');
  assert.equal(ringingWords([]), '');
});

test('only a plain yes stops it', () => {
  assert.equal(wantsStop('Yes'), true);
  assert.equal(wantsStop(' yes.'), true);
  assert.equal(wantsStop('"Yes"'), true);
  assert.equal(wantsStop('No'), false);
  assert.equal(wantsStop('Yesterday it rang'), false);
  assert.equal(wantsStop(''), false);
});

test('the question names the device and his words', () => {
  const q = ringQuestion([{ name: 'Pad' }], 'turn that thing off');
  assert.match(q, /ringing right now on his Pad/);
  assert.match(q, /Mic heard: "turn that thing off"/);
  assert.match(q, /one word, Yes or No/);
});

test('the reply names where it stopped', () => {
  assert.equal(stoppedWords([{ name: 'Pixel 10 Pro' }]), 'Stopped it on your Pixel 10 Pro.');
  assert.equal(stoppedWords([{ name: 'Pad' }, { name: 'Pixel' }]), 'Stopped it on your Pad and your Pixel.');
  assert.equal(stoppedWords([{ name: '' }]), 'Stopped it.');
});
