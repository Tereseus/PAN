// A person's device: its log lines are kept without the words they carry (log-words.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withoutWords } from '../log-words.js';

test('what was heard is counted, not kept', () => {
  assert.equal(withoutWords('Heard: are you there'), 'Heard: (3 words)');
  assert.equal(withoutWords('Hub heard: Hey, are you there? How is it going?'), 'Hub heard: (8 words)');
  assert.equal(withoutWords('Heard: yes'), 'Heard: (1 word)');
  assert.equal(withoutWords('Dedup skipped: are you there'), 'Dedup skipped: (3 words)');
  assert.equal(withoutWords('Suppressed while muted: Somebody wants to talk. Say: PAN, talk t'), 'Suppressed while muted: (8 words)');
  assert.equal(withoutWords('Cooldown (ignoring post-TTS echo): the capital of'), 'Cooldown (ignoring post-TTS echo): (3 words)');
  assert.equal(withoutWords('TTS stopped by user: stop'), 'TTS stopped by user: (1 word)');
  assert.equal(withoutWords('PAN muted, the hub heard the command: mute yourself'), 'PAN muted, the hub heard the command: (2 words)');
});

test('the speech engine lines that end in the last words', () => {
  assert.equal(withoutWords('[STT] holding, sounds unfinished p=0.07: ...HOURS'), '[STT] holding, sounds unfinished p=0.07: (1 word)');
  assert.equal(withoutWords('[STT] holding, still talking p=0.98: ...WERE YOU WRONG VOICE'), '[STT] holding, still talking p=0.98: (4 words)');
  assert.equal(withoutWords('[STT] echo discarded: E'), '[STT] echo discarded: (1 word)');
});

test('a reply and a cancelled question', () => {
  assert.equal(withoutWords('Stream (first=1745ms total=3552ms) up=40KB/881ms: Got it. Calling now.'),
    'Stream (first=1745ms total=3552ms) up=40KB/881ms: (4 words)');
  assert.equal(withoutWords('Stream (first=249ms total=249ms): Paris.'), 'Stream (first=249ms total=249ms): (1 word)');
  assert.equal(withoutWords("Query cancelled for 'what is the weather'"), 'Query cancelled for (4 words)');
  assert.equal(withoutWords("FATAL onSpeech error for 'call her now': IllegalStateException boom"), 'FATAL onSpeech error for (3 words): IllegalStateException boom');
  assert.equal(withoutWords("Alert notify #1795081763108 type=speak 'Somebody' -> notification 66108"), 'Alert notify #1795081763108 type=speak (1 word) -> notification 66108');
  assert.equal(withoutWords('Camera from hub (812ms): a red mug on a desk'), 'Camera from hub (812ms): (6 words)');
});

test('lines that carry no words stay as they are', () => {
  for (const line of [
    'Voice: supertonic3 ready', 'Call voice: sending Opus', 'Build: versionCode=168 versionName=0.5.39 appId=dev.pan.app',
    'Stream (first=249ms total=249ms) up=54KB/162ms: ', 'Ambient (181ms): no-op', '[STT] smart-turn p=0.98 in 240ms (early)',
    '[STT] commit after 339ms p=0.98', 'All sensors toggled: ON', 'Muted — mic released, TTS stopped, query cancelled',
    "Call from user 1 ('Somebody') -> notification, ringing", 'PAN Link up on local port 41461', 'Heard:', '',
    'Call voice: off (sent 95 pieces (94 Opus, 32161 bytes), got 121 (45240 bytes, 23740 ms of sound))',
  ]) assert.equal(withoutWords(line), line);
});

test('nothing but a string comes back', () => {
  assert.equal(withoutWords(null), '');
  assert.equal(withoutWords(undefined), '');
  assert.equal(withoutWords(42), '42');
});
