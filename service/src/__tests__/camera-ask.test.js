// Which heard lines ask for the phone's camera (camera-ask.js). Runs standalone, no server needed.
// Usage: node service/src/__tests__/camera-ask.test.js

import { asksForCamera, normalizeHeard } from '../camera-ask.js';

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
function eq(a, b, what) {
  if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

console.log('camera-ask');

// What the hub and the phone heard on 2026-11-08 while the owner pointed the camera.
test('the lines from 2026-11-08 ask for a look', () => {
  for (const s of [
    'What am I looking at?',
    'what am i lookin at',
    'Okay, so then tell me what I\'m looking at.',
    'Alright, look through the camera of my phone and tell me what I\'m looking at.',
    'i looked at the camera of my phone and told me what i\'m looking at',
  ]) eq(asksForCamera(s), true, s);
});

test('the older phrases still do', () => {
  for (const s of ['take a picture', 'what do you see', 'what is this', "what's that thing over there", 'describe this please', 'use the phone\'s camera', 'tell me what I’m looking at']) {
    eq(asksForCamera(s), true, s);
  }
});

test('complaints, other cameras and names do not', () => {
  for (const s of [
    "That's not what I was pointing at with the camera.",
    'That was definitely wrong',
    "so you're not actually looking at the camera through the phone",
    'look at the garage camera',
    'what is that movie called, the one with the dreams',
    "I'm looking forward to it",
    'Hey how\'s it going?',
  ]) eq(asksForCamera(s), false, s);
});

test('normalizeHeard fixes dropped g only on whole words', () => {
  eq(normalizeHeard('What am I lookin at'), 'what am i looking at', 'lookin');
  eq(normalizeHeard("seein' it"), 'seeing it', 'seein');
  eq(normalizeHeard('looking good'), 'looking good', 'looking');
  eq(normalizeHeard('lookout'), 'lookout', 'lookout');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
