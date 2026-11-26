// PAN's own last words at the head of the next heard line (own-tail.js), and the mute ask
// (mute-ask.js). Runs standalone, no server needed.
// Usage: node service/src/__tests__/own-tail.test.js

import { noteSaid, dropOwnTail } from '../own-tail.js';
import { asksToMute } from '../mute-ask.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function eq(a, b, what) {
  if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
const after = (said, heard, opts) => { noteSaid('t', said, 1000); return dropOwnTail('t', heard, { now: 2000, ...opts }); };

console.log('own-tail');

test('two words of the reply, then his line', () => {
  eq(after("Okay, I've stopped.", "I've stopped. Now put it in French."), 'Now put it in French.', 'same words');
  eq(after("Okay, I've stopped.", 'I stopped. Can you send that over?'), 'Can you send that over?', "I've heard as I");
  eq(after("I can't do that.", "Can't do that. Try it another way then."), 'Try it another way then.', 'three words');
  eq(after('It is quiet in here right now.', 'Right now. Well, not for long.'), 'Well, not for long.', 'right now');
  eq(after('Can you check that for me?', 'For me. And the other one too.'), 'And the other one too.', 'after a question');
});

test('one word only when the timing says his line began under PAN', () => {
  eq(after('I am not seeing anything back here.', 'Here. So the second one is better.', { began_ms: -300 }), 'So the second one is better.', 'timed');
  eq(after('I am not seeing anything back here.', 'Here. So the second one is better.'), 'Here. So the second one is better.', 'untimed stays');
  eq(after('Is that okay?', 'Okay. Send it to him then.', { began_ms: 100 }), 'Okay. Send it to him then.', 'his own answer word');
});

test('his line began well after PAN stopped: nothing is taken', () => {
  eq(after('Should I delete it or keep it?', 'Keep it. Then make a copy.', { began_ms: 4000 }), 'Keep it. Then make a copy.', 'late');
});

test('no full stop after the repeated words: it is one sentence of his', () => {
  eq(after('The file is in the other folder.', 'The other folder is empty though.'), 'The other folder is empty though.', 'runs on');
});

test('he repeated PAN and little else: that is his answer', () => {
  eq(after('Do you want it right now?', 'Right now.'), 'Right now.', 'only the tail');
  eq(after('Do you want it right now?', 'Right now. Yes.'), 'Right now. Yes.', 'one word left');
});

test('a phone transcript with no punctuation needs two words', () => {
  eq(after("Okay, I've stopped.", 'i stopped now put it in french'), 'Now put it in french', 'two words');
  eq(after('I am not seeing anything back here.', 'here so the second one is better', { began_ms: -200 }), 'here so the second one is better', 'one word, unpunctuated');
});

test('only PAN\'s own tail, heard while it was still talking: nothing was said', () => {
  eq(after('I could keep going all day. Do you like that?', 'Do you like that?', { began_ms: -900 }), '', 'four words, under PAN');
  eq(after('It might be the mic, I think.', 'I think.', { began_ms: -300 }), '', 'two words, under PAN');
  eq(after('It might be the mic, I think.', 'i think', { began_ms: 0 }), '', 'unpunctuated, right at the stop');
});

test('only PAN\'s tail, but after it stopped or untimed: still his answer', () => {
  eq(after('Do you want it right now?', 'Right now.', { began_ms: 400 }), 'Right now.', 'after PAN');
  eq(after('Do you want it right now?', 'Right now.'), 'Right now.', 'untimed');
  eq(after('Is that okay?', 'Okay.', { began_ms: -200 }), 'Okay.', 'one word under PAN stays');
  eq(after('It might be the mic, I think.', 'I think so too.', { began_ms: -300 }), 'I think so too.', 'more than the tail');
});

test('an old reply, another device, or no reply at all', () => {
  noteSaid('t', "Okay, I've stopped.", 1000);
  eq(dropOwnTail('t', "I've stopped. Now put it in French.", { now: 1000 + 4 * 60_000 }), "I've stopped. Now put it in French.", 'old');
  eq(dropOwnTail('other', "I've stopped. Now put it in French.", { now: 2000 }), "I've stopped. Now put it in French.", 'other device');
});

console.log('mute-ask');

test('told to mute', () => {
  for (const line of ['Mute yourself.', 'Pan, mute yourself.', 'Hey Pan, mute yourself.', 'Uh Pam, mute yourself.',
    'Pan, mute mute yourself, Pan.', 'Wait, hold on. Mute yourself.', 'Shut up.', 'Okay Pan, stop listening please.', 'mute',
    'Can you mute yourself for a bit?', 'Pan, could you please be quiet for a minute.',
    'Pan, mute yourself. The car is somehow not connecting, the whole head unit keeps saying it is not connected and the internet is slow.',
    'And I told you to mute yourself.', 'Pan, I told you to mute yourself.', 'I already told you to be quiet.',
    "That's it. Han, mute yourself. Uh version two and likely not almost certain, okay. The parts are standard and two small capacitors have to be tuned to the coil.",
    'That is here. Pan, mute yourself. Where is your hardware?']) {
    eq(asksToMute(line), true, line);
  }
});

test('not told to mute', () => {
  for (const line of ['My commute was long.', 'He told me to shut up.', 'Can you mute the television?', 'Mute yourself when the movie starts and tell me what time it is.',
    'How do I mute a tab in Firefox?', 'I had to be quiet in there.', '',
    'Mute yourself. Then tell me the time and the weather and what is on the calendar today, and read me my messages.',
    'Pan, what time is it. Mute yourself when the movie starts.', 'She said I told you to mute yourself in the meeting yesterday.',
    'Han Solo was the pilot. He told the crew to be quiet. Then the ship jumped to light speed and everyone cheered.']) {
    eq(asksToMute(line), false, line);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
