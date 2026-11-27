// Where a look came from, said and remembered (looks.js). Runs standalone, no server needed.
// Usage: node service/src/__tests__/looks.test.js
//
// The lines are the hub's own words from 2026-11-08, when "what am I looking at?" was answered
// from a window title and the follow-ups denied it.

import { withSource, sourceAnswer, asksAboutSource, screenLookFrom, asksWhatHeSees } from '../looks.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
const DENIAL = /\bi didn'?t\.|just reading your voice|no record|don'?t have any record/i;

const NOW = 1_800_000_000_000;
const pendantLook = { source: 'pendant', said: "You're looking at a laptop on a desk.", description: 'a laptop on a desk', at: NOW - 40_000 };
const phoneLook = { source: 'phone_back', said: "You're looking at a white mug.", description: 'a white mug on a table', at: NOW - 120_000 };
const screenLook = { source: 'screen', device: 'desktop', title: 'MovieWriter: Frame 455 (time: 00:00:07:3', said: "You're looking at MovieWriter." , at: NOW - 30_000 };
const screens = [{ device: 'desktop', title: 'MovieWriter: Frame 455 (time: 00:00:07:3' }];

console.log('\nwithSource');
test('pendant answer opens with the pendant and its age', () => {
  const s = withSource("You're looking at a laptop.", 'pendant', 4_000);
  ok(s === "From your pendant camera a few seconds ago: You're looking at a laptop.", s);
});
test('phone answer opens with the back camera', () => {
  const s = withSource("You're looking at a mug.", 'phone_back');
  ok(s === "From your phone's back camera: You're looking at a mug.", s);
});
test('not said twice', () => {
  const s = withSource("From your phone's back camera: a mug.", 'phone_back');
  ok(s === "From your phone's back camera: a mug.", s);
});
test('empty stays empty', () => ok(withSource('', 'pendant') === '', 'not empty'));

console.log('\nasksAboutSource');
for (const line of [
  'Did you use the front-facing camera or the backwards camera?',
  'but you use the rogi did you use the front facing crammer or the backwards camer',
  'which camera did you use',
  'And how did you know about Movie Rider?',
  'how did you know that',
  'did you take a picture',
  'where did you see that',
]) test(`asks: ${line}`, () => ok(asksAboutSource(line), 'missed'));
for (const line of ['what am I looking at', 'how do you know so much about horses', 'take a photo', 'did you use the back door', "How's it going?"]) {
  // "how do you know so much about horses" asks how, but about nothing PAN looked at: the model's.
  test(`left to the model: ${line}`, () => {
    const said = sourceAnswer(line, { look: phoneLook, screens: [], now: NOW });
    ok(said === '', `answered by code: ${said}`);
  });
}

console.log('\nsourceAnswer');
test('front or back, after a pendant look: the pendant, no denial', () => {
  const s = sourceAnswer('Did you use the front-facing camera or the backwards camera?', { look: pendantLook, now: NOW });
  ok(/pendant camera/i.test(s) && /not the front/i.test(s) && !DENIAL.test(s), s);
});
test('front or back, after a phone look: the back camera', () => {
  const s = sourceAnswer('did you use the front camera', { look: phoneLook, now: NOW });
  ok(/phone's back camera, not the front one/i.test(s) && /2 minutes ago/.test(s), s);
});
test('which camera, after a window-title answer: no camera, the window named', () => {
  const s = sourceAnswer('Did you use the front-facing camera or the backwards camera?', { look: screenLook, now: NOW });
  ok(/didn't use a camera/i.test(s) && /desktop's window title/i.test(s) && /MovieWriter/.test(s), s);
});
test('how did you know about Movie Rider (misheard): the window title', () => {
  const s = sourceAnswer('And how did you know about Movie Rider?', { look: screenLook, now: NOW });
  ok(/window title/i.test(s) && /MovieWriter/.test(s) && !DENIAL.test(s), s);
});
test('how did you know about MovieWriter, no look kept but the window is up', () => {
  const s = sourceAnswer('how did you know about MovieWriter', { look: null, screens, now: NOW });
  ok(/desktop's window title/i.test(s), s);
});
test('how did you know about horses, nothing matches: left to the model', () => {
  const s = sourceAnswer('how did you know about horses', { look: phoneLook, screens, now: NOW });
  ok(s === '', s);
});
test('which camera, nothing looked at: says so', () => {
  const s = sourceAnswer('which camera did you use', { look: null, now: NOW });
  ok(/didn't use a camera/i.test(s), s);
});
test('after a hub restart the source is read from the history', () => {
  const history = "User: [photo] what am I looking at\nPAN: From your pendant camera a few seconds ago: You're looking at a laptop.";
  const s = sourceAnswer('was that the front camera or the back camera', { look: null, history, now: NOW });
  ok(/pendant camera/i.test(s), s);
});

console.log('\nscreenLookFrom');
test('reply naming a window word is a screen look', () => {
  const hit = screenLookFrom("You're looking at MovieWriter. It looks like you've got a frame from the movie.", screens);
  ok(hit && hit.source === 'screen' && hit.device === 'desktop', JSON.stringify(hit));
});
test('common words do not count', () => {
  const hit = screenLookFrom('That frame of time was fun.', screens);
  ok(!hit, JSON.stringify(hit));
});
test('which camera WE use on a product is not about PAN\'s look: left to the rest', () => {
  ok(sourceAnswer('Which camera are we using on the Medallion?', { look: null, now: NOW }) === '', 'answered');
  ok(/didn't use a camera/i.test(sourceAnswer('which camera are you using', { look: null, now: NOW })), 'lost the you case');
});
test('asksWhatHeSees', () => ok(asksWhatHeSees('Uh what am I looking at?') && !asksWhatHeSees('how is it going'), 'wrong'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
