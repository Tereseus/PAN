// The gaps between spoken pieces and their cause (voice-timing.js speechGaps, task 1107).
// Usage: node service/src/__tests__/speech-gaps.test.js
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import assert from 'assert/strict';

process.env.PAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'pan-speechgaps-'));
process.env.PAN_DEV = '1';
const { speechGaps } = await import('../voice-timing.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('no gap when the next piece was ready and played straight on', () => {
  const g = speechGaps([{ queued: 0, built: 400, play: 450, end: 2450 }, { queued: 300, built: 1200, play: 2460, end: 4000 }]);
  assert.deepEqual(g, [{ ms: 10, text_late: 0, build_late: 0 }]);
});
t('a slow build shows as build_late', () => {
  const g = speechGaps([{ queued: 0, built: 400, play: 450, end: 1450 }, { queued: 300, built: 3000, play: 3100, end: 5000 }]);
  assert.equal(g[0].ms, 1650); assert.equal(g[0].build_late, 1550); assert.equal(g[0].text_late, 0);
});
t('words arriving late from the hub show as text_late', () => {
  const g = speechGaps([{ queued: 0, built: 400, play: 450, end: 1450 }, { queued: 2450, built: 2900, play: 2950, end: 4000 }]);
  assert.equal(g[0].text_late, 1000); assert.equal(g[0].build_late, 450);
});
t('pieces with no times are skipped', () => {
  assert.deepEqual(speechGaps([{ end: 100 }, { queued: 5 }]), []);
  assert.deepEqual(speechGaps([]), []);
});
console.log(`${n} passed`);
