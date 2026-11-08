// Which heard lines lean on the last thing he asked (intuition/conversation.js followUpOf).
// Runs standalone, no server needed. Usage: node service/src/__tests__/follow-up.test.js

import { followUpOf, followUpLine, historyLines } from '../intuition/conversation.js';

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
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// The talk from 2026-11-08: a photo, then the sun, then "get there".
const PHOTO = 'User: [photo] he what am i looking at\nPAN: You are looking at a black computer game console with sixteen colorful buttons.';
const SUN = `${PHOTO}\nUser: How far is the sun from the earth\nPAN: About 93 million miles on average.`;

console.log('follow-up');

test('"get there" after the sun leans on the sun, not the photo', () => {
  const fu = followUpOf(SUN, 'How long would it take to get there?');
  eq(fu, { asked: 'How far is the sun from the earth', about: null, photo: false }, 'focus');
  eq(followUpLine(fu), '(He is following up on the last thing he asked: How far is the sun from the earth.)', 'line');
});

test('a run of follow-ups keeps the question that started it', () => {
  const h = `${SUN}\nUser: How long would it take to get there?\nPAN: About eight minutes at the speed of light.`;
  const fu = followUpOf(h, 'And by car?');
  eq(fu, { asked: 'How long would it take to get there?', about: 'How far is the sun from the earth', photo: false }, 'focus');
  eq(followUpLine(fu), '(He is following up on the last thing he asked: How long would it take to get there, which was about: How far is the sun from the earth.)', 'line');
});

test('a question about the photo leans on the photo', () => {
  eq(followUpOf(PHOTO, 'What brand is it?')?.photo, true, 'brand');
  const h = `${PHOTO}\nUser: What brand is it?\nPAN: It looks like a Novation Launchpad.`;
  eq(followUpOf(h, 'How much does it cost?'), { asked: 'What brand is it?', about: 'he what am i looking at', photo: true }, 'chain to the photo');
});

test('follow-ups that point back or carry on', () => {
  const who = 'User: Who wrote Hamlet?\nPAN: William Shakespeare, around 1600.';
  for (const s of ['Who is he?', 'Why?', 'Why is that?', 'Is that true?', 'When did he die?', 'And Macbeth?', 'What about Othello?', 'Okay, so how old was he?', 'How long?']) {
    eq(followUpOf(who, s)?.asked, 'Who wrote Hamlet?', s);
  }
  const capital = "User: What's the capital of Australia?\nPAN: Canberra.";
  for (const s of ['Why not Sydney?', 'Why not?']) eq(followUpOf(capital, s)?.asked, "What's the capital of Australia?", s);
  const trip = 'User: I am flying to Tokyo tomorrow, what should I pack?\nPAN: Layers and a light jacket.';
  eq(followUpOf(trip, "What's the weather like there?")?.asked, 'I am flying to Tokyo tomorrow, what should I pack?', 'weather there');
});

test('questions with words of their own stand alone', () => {
  for (const s of [
    'What time is it?',
    'Is it going to rain tomorrow?',
    'How far is Mars?',
    'How old is Obama?',
    'What is the capital of France?',
    'And what is the capital of France?',
    'Why is the sky blue?',
    'How are you?',
    'Tell me a joke.',
    'Never mind.',
    "Thanks, that's all.",
    'Did you know that Paris has a pyramid?',
  ]) eq(followUpOf(SUN, s), null, s);
});

test('no history, no follow-up', () => {
  eq(followUpOf('', 'How long would it take to get there?'), null, 'empty');
  eq(followUpOf(null, 'Why?'), null, 'null');
  eq(followUpLine(null), '', 'line');
});

test('history formats: the phone, the hub fallback and the photo note', () => {
  eq(historyLines('You: How far is the sun\nPAN: About 93 million miles.\nPAN (what the photo showed): a desk'),
    [{ his: true, text: 'How far is the sun' }, { his: false, text: 'About 93 million miles.' }, { his: false, text: 'a desk' }], 'lines');
  eq(followUpOf('You: How far is the sun from the earth\nPAN: About 93 million miles.', 'How long would it take to get there?')?.asked,
    'How far is the sun from the earth', 'fallback');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
