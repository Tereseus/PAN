import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readerMayAnswer } from '../reader-alone.js';

test('short talk stays with the voice model', () => {
  assert.equal(readerMayAnswer('Hey, can you hear me?', 'query'), true);
  assert.equal(readerMayAnswer("I'm in the car right now.", 'query'), true);
  assert.equal(readerMayAnswer('Nice.', 'chat'), true);
});

test('longer talk goes to the hub model', () => {
  assert.equal(readerMayAnswer('Okay, you cut off when you were trying to say the last word for Super Bowls', 'query'), false);
  assert.equal(readerMayAnswer('Tell the PAN thread to look at the logs of what we just discussed.', 'query'), false);
  assert.equal(readerMayAnswer('It seems like you are speaking a little too fast for some reason', ''), false);
});

test('an action PAN runs itself stays, however long', () => {
  assert.equal(readerMayAnswer('Translate everything I say into Chinese from now on please okay', 'translate'), true);
  assert.equal(readerMayAnswer('Hey Pan, mute yourself right now because I am talking to someone', 'system'), true);
  assert.equal(readerMayAnswer('And what did we say about the genies last week at home', 'memory'), true);
});
