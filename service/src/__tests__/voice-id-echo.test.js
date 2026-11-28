// ΠAN's echo per device (voice-id.js learnEcho, Nov 28). Made-up prints: a device's mic and speaker
// colour every voice the same way (the channel), so his car lines and ΠAN's echo in the car share
// part of their direction, the way the car's echo scored like his lines against ΠAN's clean voice.
// Usage: node service/src/__tests__/voice-id-echo.test.js

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const dir = mkdtempSync(join(tmpdir(), 'pan-voice-echo-'));
process.env.PAN_DATA_DIR = dir;
process.env.PAN_DEV = '1';
process.env.PAN_VOICE_PROFILE = join(dir, 'voice-profile.json');
process.env.PAN_SPK_MODEL = join(dir, 'no-model.onnx');   // no speaker model: only the profiles are tested

const DIM = 192;
let seed = 29;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
const unit = (v) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return v.map((x) => x / n); };
const axis = (i) => Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));
const mix = (a, b, wa) => unit(a.map((x, i) => wa * x + (1 - wa) * b[i]));
const line = (v, noise = 0.12) => unit(v.map((x) => x + rnd() * noise));
const dotp = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

const v = await import('../voice-id.js');

const HIM = axis(3);
const PAN_VOICE = axis(150);
const CAR_CH = axis(40);
const PIXEL_CH = axis(80);
const CAR = mix(HIM, CAR_CH, 0.6);            // his voice through the car
const PIXEL = mix(HIM, PIXEL_CH, 0.6);
const CAR_ECHO = mix(PAN_VOICE, CAR_CH, 0.6); // ΠAN through the car's speaker and mic

let passed = 0;
let failed = 0;
function test(name, fn) {
  v.resetProfile();
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
const teach = () => {
  for (let i = 0; i < 40; i++) v.learnWearer(line(CAR), 'car');
  for (let i = 0; i < 8; i++) v.learnEcho(line(CAR_ECHO), 'car');
};

console.log("voice-id: ΠAN's echo per device");

test('the made-up car echo and his car voice share the car channel', () => {
  const d = dotp(CAR, CAR_ECHO);
  ok(d > 0.2 && d < 0.6, `car voice against car echo ${d.toFixed(2)}`);
});

test('no echo print until the device has five echoes', () => {
  for (let i = 0; i < 4; i++) v.learnEcho(line(CAR_ECHO), 'car');
  ok(v.echoLikeness(line(CAR_ECHO), 'car') === null, 'four echoes: no print yet');
  v.learnEcho(line(CAR_ECHO), 'car');
  ok(v.echoLikeness(line(CAR_ECHO), 'car')?.echoes === 5, 'five echoes: a print');
});

test('an echo line scores close to the echo, his car line does not', () => {
  teach();
  const e = v.echoLikeness(line(CAR_ECHO), 'car');
  const h = v.echoLikeness(line(CAR), 'car');
  ok(e.likeness >= v.ECHO_SAME, `echo line ${e.likeness.toFixed(2)}`);
  ok(h.likeness < v.ECHO_SAME, `his line ${h.likeness.toFixed(2)}`);
});

test('the drop takes the echo and keeps his line, a named line and a clear one', () => {
  teach();
  const echoLine = line(CAR_ECHO);
  const his = v.whoseVoice(echoLine, 'car').likeness;
  ok(v.soundsLikeEcho({ echo: v.echoLikeness(echoLine, 'car'), his }), 'echo line dropped');
  const hisLine = line(CAR);
  ok(!v.soundsLikeEcho({ echo: v.echoLikeness(hisLine, 'car'), his: v.whoseVoice(hisLine, 'car').likeness }), 'his line kept');
  ok(!v.soundsLikeEcho({ echo: v.echoLikeness(echoLine, 'car'), his, named: true }), 'named line kept');
  ok(!v.soundsLikeEcho({ echo: { likeness: 0.9, echoes: 8 }, his: 0.55 }), 'clearly his (0.55) kept');
  ok(!v.soundsLikeEcho({ echo: null, his: 0.1 }), 'no echo print: nothing dropped');
});

test("one device's echo says nothing about another device", () => {
  teach();
  ok(v.echoLikeness(line(CAR_ECHO), 'pixel') === null, 'pixel has no echo print');
});

test('his pool never learns a line that sounds like the echo', () => {
  teach();
  const before = v.profileState('car').turns;
  for (let i = 0; i < 10; i++) v.learnWearer(line(CAR_ECHO), 'car');
  ok(v.profileState('car').turns === before, `car turns ${before} -> ${v.profileState('car').turns}`);
  v.learnWearer(line(CAR), 'car');
  ok(v.profileState('car').turns === before + 1, 'his own line is still learned');
});

test('learning the echo takes echo lines already in his pool out', () => {
  for (let i = 0; i < 40; i++) v.learnWearer(line(CAR), 'car');
  for (let i = 0; i < 6; i++) v.learnWearer(line(CAR_ECHO), 'car');   // learned before any echo print
  ok(v.profileState('car').turns === 46, `pool ${v.profileState('car').turns}`);
  for (let i = 0; i < 6; i++) v.learnEcho(line(CAR_ECHO), 'car');
  ok(v.profileState('car').turns === 40, `pool after the echo print ${v.profileState('car').turns}`);
  ok(v.whoseVoice(line(CAR), 'car').verdict === true, 'his car line still his');
});

test('the echo pool keeps at most 40 lines; a device reset clears its echo', () => {
  for (let i = 0; i < 55; i++) v.learnEcho(line(CAR_ECHO), 'car');
  ok(v.profileState().echo.find((x) => x.device === 'car')?.lines === 40, 'capped at 40');
  v.resetProfile('car');
  ok(v.echoLikeness(line(CAR_ECHO), 'car') === null, 'car echo gone after reset');
});

test('the echo drop is off unless pan_echo_gate = on', () => {
  ok(v.panEchoGateOn() === false, 'off by default');
  ok(v.profileState().echo_gate === 'off', 'profile state says off');
});

test('his Pixel lines are unaffected by the car echo', () => {
  teach();
  for (let i = 0; i < 40; i++) v.learnWearer(line(PIXEL), 'pixel');
  let his = 0;
  for (let i = 0; i < 20; i++) if (v.whoseVoice(line(PIXEL), 'pixel').verdict === true) his++;
  ok(his >= 18, `pixel lines his: ${his} of 20`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
