// The nightly voice report says which voice each device spoke in (voice-report.js voicesFrom).
// A device on the Android voice without anyone choosing it must show up there.
// Runs standalone, no PAN server needed.
// Usage: node service/src/__tests__/voice-report-voices.test.js

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

process.env.PAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'pan-voice-report-'));
process.env.PAN_DEV = '1';

const { voicesFrom } = await import('../voice-report.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
const row = (device_id, message) => ({ device_id, message });

console.log('voice report, voices');

test('a device on its voice has no problem', () => {
  const v = voicesFrom([row('phone-a', 'Build: versionCode=166 versionName=0.5.37'), row('phone-a', 'Voice: supertonic3 ready'),
    row('phone-b', 'Voice: the Android voice, chosen in Settings'), row('phone-c', 'Piper TTS: supertonic3 voice ready')]);
  eq(v.map((x) => [x.device, x.problems.length]), [['phone-a', 0], ['phone-b', 0], ['phone-c', 0]], 'all fine');
});

test('the car\'s case: started and said nothing about its voice', () => {
  const v = voicesFrom([row('phone-car', 'Build: versionCode=163 versionName=0.5.34'), row('phone-a', 'Build: versionCode=166'), row('phone-a', 'Voice: supertonic3 ready')]);
  eq(v[0].device, 'phone-car', 'the one with a problem comes first');
  eq(v[0].problems.length, 1, 'flagged');
  eq(v[1].problems, [], 'the other is fine');
});

test('every line that is not "ready" is a problem, each once', () => {
  const lines = ["Voice: supertonic3 is on the device and the setting was 'android', moving to it", 'Voice: supertonic3 could not be loaded, the Android voice speaks',
    "Voice: the Android voice has a line in zh: PAN's voice cannot read zh", "Voice: the Android voice has a line in zh: PAN's voice cannot read zh",
    'Voice: supertonic3 download failed, the Android voice speaks until the next start tries again'];
  const v = voicesFrom([row('phone-a', 'Build: versionCode=166'), ...lines.map((l) => row('phone-a', l))]);
  eq(v[0].problems.length, 4, 'four different lines');
  eq(v[0].voice, lines[4], 'the last line is what it says now');
});

test('nothing logged, nothing reported', () => {
  eq(voicesFrom([]), [], 'empty');
  eq(voicesFrom([row('phone-a', 'Hub heard: hello')]).map((x) => x.problems), [[]], 'a device that did not start that day');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
