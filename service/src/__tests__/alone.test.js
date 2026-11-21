import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlone } from '../alone.js';

const clock = () => { let t = 5_000_000; const f = () => t; f.add = (ms) => { t += ms; }; return f; };

test('his voice, nobody named, no other voice: alone', () => {
  const a = createAlone({ now: clock() });
  assert.equal(a.aloneWithPan({ voice_his: true, device_id: 'p10' }, { others: 0 }), true);
});

test('not known to be his voice: not alone', () => {
  const a = createAlone({ now: clock() });
  assert.equal(a.aloneWithPan({ voice_his: undefined, device_id: 'p10' }, { others: 0 }), false);
  assert.equal(a.aloneWithPan({ voice_his: false, device_id: 'p10' }, { others: 0 }), false);
});

test('someone named in the talk: not alone', () => {
  const a = createAlone({ now: clock() });
  assert.equal(a.aloneWithPan({ voice_his: true, device_id: 'p10' }, { others: 1 }), false);
  assert.equal(a.aloneWithPan({ voice_his: true, device_id: 'p10' }, null), false);
});

test('another voice on this device in the last 10 minutes: not alone, after that alone again', () => {
  const now = clock(); const a = createAlone({ now });
  a.heardOther('p10');
  now.add(9 * 60_000);
  assert.equal(a.aloneWithPan({ voice_his: true, device_id: 'p10' }, { others: 0 }), false);
  assert.equal(a.aloneWithPan({ voice_his: true, device_id: 'pad' }, { others: 0 }), true);
  now.add(2 * 60_000);
  assert.equal(a.aloneWithPan({ voice_his: true, device_id: 'p10' }, { others: 0 }), true);
});
