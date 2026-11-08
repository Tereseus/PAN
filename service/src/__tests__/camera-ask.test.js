// Which heard lines ask for the phone's camera (camera-ask.js). Runs standalone, no server needed.
// Usage: node service/src/__tests__/camera-ask.test.js

import { asksForCamera, normalizeHeard, plainLook, spokenLook } from '../camera-ask.js';

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

test('plain looks need no second model, questions about the thing do', () => {
  for (const s of ['he what am i looking at', 'What am I looking at?', 'Alright, look through the camera of my phone and tell me what I\'m looking at.',
    'what do you see', 'take a picture', 'what is this', '']) eq(plainLook(s), true, s);
  for (const s of ['what kind of dog is that', 'How many fingers am I holding up?', 'what brand is it', 'can you read this label',
    'is this ripe', 'what colour is my shirt']) eq(plainLook(s), false, s);
});

test('a description becomes one spoken answer', () => {
  eq(spokenLook('The image shows a black computer game console with 16 colorful buttons arranged in a 4x4 grid. The buttons include options for game mode, paste, paste mode, paste all.'),
    "You're looking at a black computer game console with 16 colorful buttons arranged in a 4x4 grid.", 'first sentence');
  eq(spokenLook('In the image, there is a white unicorn on a hill. The sky is blue. The word "SHADHAVAR" is written across the top.'),
    'You\'re looking at a white unicorn on a hill. The word "SHADHAVAR" is written across the top.', 'writing kept');
  eq(spokenLook('A red kettle on a counter'), 'A red kettle on a counter', 'no opening');
  eq(spokenLook(''), '', 'empty');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
