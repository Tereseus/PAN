// recall-gate.js: which voice lines search memory, and when the talk itself answers. Lines are the
// Long conversation test's made-up scenes (2026-11-26), none of them real.
// Usage: node service/src/__tests__/recall-gate.test.js

import { asksAboutPast, questionForm, talkCovers, noRecordAnswer } from '../recall-gate.js';

// router.js RECALL_RE, copied so the test needs no router import (it pulls the whole hub).
const RECALL_RE = /\b(remember|recall|forgot|what (did|was|were|happened)|when (did|was|were)|where (did|was|were)|who (did|was|were|said)|find.*about|look.*up|tell me about)\b/i;

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m); };

console.log('recall gate');

t('story lines with recall words do not search memory', () => {
  for (const line of [
    "Hey there, PAN. You won't believe what happened at the gardening class today.",
    "Damn, you're right. I'm being lazy. I can't even remember the last time I actually cooked something.",
    'Ugh, tell me about it. Speaking of, I tried that new hiking app everyone is talking about.',
    "Ugh, don't even get me started. I've got to remember to pack the solar charger this time.",
    "Yeah, you know, I'm not great at the whole quiet hovering thing. Remember, I tried fake roaches before, but he didn't even blink.",
    'Tell me about it. We spent most of the time reminiscing about the weirdest classes we took.',
  ]) ok(!asksAboutPast(line, RECALL_RE), `searched: ${line}`);
});

t('questions about the past still search', () => {
  for (const line of [
    'What was the title of the song I wrote last night about taking risks?',
    'Hey, what was that snack I pack to stay calm?',
    'Who was upset about my not being present that night?',
    'what did we decide about the pendant',
    'PAN, do you remember when I mentioned how long I have been trying to fly?',
    "It's so funny. Remember that time we got caught in that storm and ended up soaked?",
  ]) ok(asksAboutPast(line, RECALL_RE), `not searched: ${line}`);
});

t('question form: a question mark or a question word first, after a greeting or the name', () => {
  ok(questionForm('Hey PAN, where did I put it'), 'name then where');
  ok(questionForm('so what was the deal'), 'filler then what');
  ok(!questionForm("You won't believe what happened."), 'a telling sentence');
  ok(!questionForm('I wonder what happened to him.'), 'a wondering sentence');
});

t('the talk answers a question that names a day, when it holds what is asked', () => {
  const talk = 'User: My song is called Skyward Steps. It is about moving past fear.\nPAN: I like it.\nUser: I have been letting that voice stop me from taking risks.';
  ok(talkCovers(['title', 'song', 'wrote', 'taking', 'risks'], talk), 'song, taking, risks are in the talk');
  ok(!talkCovers(['snack', 'pack', 'stay', 'calm'], 'User: I bring a banana to work so I do not get hangry.'), 'nothing of it is in the talk');
  ok(!talkCovers([], talk), 'no subject words');
  ok(!talkCovers(['song'], ''), 'no talk');
});

t('no coded "nothing saved" mid-talk, and never one word of the line as its subject', () => {
  ok(noRecordAnswer({ when: { label: 'today' }, history: 'User: hi' }) === null, 'a talk is going on: the model answers');
  ok(noRecordAnswer({ when: { label: 'yesterday' }, history: '' }) === "I don't have anything recorded from yesterday.", 'day, no talk');
  ok(noRecordAnswer({ when: null, history: '  ' }) === "I don't have anything saved about that.", 'no day, no talk');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
