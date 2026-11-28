// Voice ID keeps one profile per device (voice-id.js, Nov 28, task 1104). Made-up prints stand in
// for the speaker model: his voice through each mic is its own direction (alike, not the same),
// other people are other directions, a line is the direction plus a little noise.
// Usage: node service/src/__tests__/voice-id-devices.test.js

import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const dir = mkdtempSync(join(tmpdir(), 'pan-voice-id-'));
process.env.PAN_DATA_DIR = dir;
process.env.PAN_DEV = '1';
process.env.PAN_VOICE_PROFILE = join(dir, 'voice-profile.json');
process.env.PAN_SPK_MODEL = join(dir, 'no-model.onnx');   // no speaker model: only the profiles are tested

const DIM = 192;   // the real print size, so PAN's own voice prints (pan-voice-print.json) apply
let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
const unit = (v) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return v.map((x) => x / n); };
const axis = (i) => Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));
const mix = (a, b, wa) => unit(a.map((x, i) => wa * x + (1 - wa) * b[i]));
const line = (v, noise = 0.12) => unit(v.map((x) => x + rnd() * noise));

const v = await import('../voice-id.js');

// His voice through the car's mic and through the Pixel's: alike (about 0.5), not the same.
const HIM = axis(3);
const CAR = mix(HIM, axis(40), 0.5);
const PIXEL = mix(HIM, axis(80), 0.5);
const OTHER = axis(120);

let passed = 0;
let failed = 0;
function test(name, fn) {
  v.resetProfile();
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }

console.log('voice-id: one profile per device');

test('the two mics are alike but not the same (the made-up voices)', () => {
  const d = CAR.reduce((s, x, i) => s + x * PIXEL[i], 0);
  ok(d > 0.4 && d < 0.75, `car against pixel ${d.toFixed(2)}`);
});

test('a device that talks a lot no longer takes the other device over', () => {
  for (let i = 0; i < 150; i++) v.learnWearer(line(CAR), 'car');
  for (let i = 0; i < 25; i++) v.learnWearer(line(PIXEL), 'pixel');
  const st = v.profileState();
  ok(st.devices.find((x) => x.device === 'car')?.ready, 'car profile ready');
  ok(st.devices.find((x) => x.device === 'pixel')?.ready, 'pixel profile ready');
  let pixelHis = 0;
  for (let i = 0; i < 20; i++) if (v.whoseVoice(line(PIXEL), 'pixel').verdict === true) pixelHis++;
  ok(pixelHis >= 18, `pixel lines counted as him: ${pixelHis} of 20`);
  const w = v.whoseVoice(line(PIXEL), 'pixel');
  ok(w.from === 'pixel', `answered by ${w.from}`);
});

test('each device pool keeps at most 100 lines', () => {
  for (let i = 0; i < 140; i++) v.learnWearer(line(CAR), 'car');
  ok(v.profileState('car').turns === 100, `car turns ${v.profileState('car').turns}`);
});

test('a new device uses the best match among his other devices', () => {
  for (let i = 0; i < 40; i++) v.learnWearer(line(CAR), 'car');
  for (let i = 0; i < 40; i++) v.learnWearer(line(PIXEL), 'pixel');
  for (let i = 0; i < 3; i++) v.learnWearer(line(PIXEL), 'new-phone');   // under 10 lines: no profile of its own
  ok(!v.profileState('new-phone').ready, 'new phone has no profile yet');
  const w = v.whoseVoice(line(PIXEL), 'new-phone');
  ok(w.from === 'pixel' && w.verdict === true, `from ${w.from}, verdict ${w.verdict}`);
  const o = v.whoseVoice(line(OTHER), 'new-phone');
  ok(o.verdict === false, `someone else on a new device: ${o.verdict} (${o.likeness?.toFixed(2)})`);
});

test('no device given (a person\'s device asking about the owner): the best of his profiles', () => {
  for (let i = 0; i < 40; i++) v.learnWearer(line(CAR), 'car');
  for (let i = 0; i < 40; i++) v.learnWearer(line(PIXEL), 'pixel');
  ok(v.whoseVoice(line(PIXEL)).verdict === true, 'pixel line, no device');
  ok(v.whoseVoice(line(CAR)).verdict === true, 'car line, no device');
  ok(v.whoseVoice(line(OTHER)).verdict === false, 'someone else, no device');
});

test('someone else on a device with its own profile is not him', () => {
  for (let i = 0; i < 40; i++) v.learnWearer(line(PIXEL), 'pixel');
  ok(v.whoseVoice(line(OTHER), 'pixel').verdict === false, 'other voice on the pixel');
});

test('PAN\'s own voice never goes into a pool', () => {
  const panPrints = JSON.parse(readFileSync(new URL('../pan-voice-print.json', import.meta.url), 'utf8')).voices;
  const pan = unit(panPrints[0].centre);
  for (let i = 0; i < 30; i++) v.learnWearer(line(pan, 0.02), 'pixel');
  ok(v.profileState('pixel').turns === 0, `pixel pool holds ${v.profileState('pixel').turns} of PAN's lines`);
});

test('the old shared file becomes the frozen unlabelled profile, with a backup', () => {
  const pool = Array.from({ length: 60 }, () => line(CAR).map((x) => Math.round(x * 1e4) / 1e4));
  writeFileSync(process.env.PAN_VOICE_PROFILE, JSON.stringify({ pool, centre: null, group: 0, added: 600 }));
  const st = v.profileState();   // reads the file again after the reset
  const u = st.devices.find((x) => x.device === v.UNLABELLED);
  ok(u && u.frozen && u.turns === 60 && u.ready, `unlabelled: ${JSON.stringify(u)}`);
  const backup = process.env.PAN_VOICE_PROFILE.replace(/\.json$/, '') + '.v1-backup.json';
  ok(existsSync(backup), 'backup written');
  ok(Array.isArray(JSON.parse(readFileSync(backup, 'utf8')).pool), 'backup holds the old pool');
  const saved = JSON.parse(readFileSync(process.env.PAN_VOICE_PROFILE, 'utf8'));
  ok(saved.version === 2 && saved.devices[v.UNLABELLED], 'file saved in the new format');
  // A car line on a car with no profile yet is checked against the unlabelled one.
  ok(v.whoseVoice(line(CAR), 'car').verdict === true, 'car line against unlabelled');
  // The unlabelled profile never learns.
  v.learnWearer(line(CAR), v.UNLABELLED);
  ok(v.profileState(v.UNLABELLED).turns === 60, 'unlabelled did not learn');
});

test('reset one device keeps the others', () => {
  for (let i = 0; i < 20; i++) v.learnWearer(line(CAR), 'car');
  for (let i = 0; i < 20; i++) v.learnWearer(line(PIXEL), 'pixel');
  v.resetProfile('pixel');
  const st = v.profileState();
  ok(!st.devices.find((x) => x.device === 'pixel'), 'pixel gone');
  ok(st.devices.find((x) => x.device === 'car')?.turns === 20, 'car kept');
});

test('past 12 devices the one heard least recently is forgotten', () => {
  for (let d = 0; d < 13; d++) for (let i = 0; i < 2; i++) v.learnWearer(line(PIXEL), `dev${d}`);
  const names = v.profileState().devices.map((x) => x.device);
  ok(names.length === 12 && !names.includes('dev0') && names.includes('dev12'), names.join(','));
});

console.log('voice-id: short lines that are not surely him');

test('noise the phone barely heard is dropped', () => {
  ok(v.shortNoise({ phoneText: '…', likeness: 0.47 }), 'placeholder, 0.47');
  ok(v.shortNoise({ phoneText: 'no', likeness: 0.41 }), 'one word, 0.41');
  ok(v.shortNoise({ phoneText: 'just like that', likeness: 0.56 }), 'three words, 0.56 (an echo)');
});

test('his short lines and named lines are kept', () => {
  ok(!v.shortNoise({ phoneText: 'good morning', likeness: 0.62 }), 'two words, 0.62');
  ok(!v.shortNoise({ phoneText: '…', likeness: 0.33, named: true }), 'named on the hub');
  ok(!v.shortNoise({ phoneText: 'what is the time now', likeness: 0.3 }), 'five words');
  ok(!v.shortNoise({ phoneText: 'no', likeness: null }), 'no profile yet');
});

test('words are counted by letters and digits, any script', () => {
  ok(v.wordsIn('… …') === 0 && v.wordsIn('.') === 0, 'punctuation');
  ok(v.wordsIn('καλημέρα πώς είσαι') === 3, 'Greek');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
