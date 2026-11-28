// A turn's time in parts: hub, model, which model answered (turn-parts.js).
// Usage: node service/src/__tests__/turn-parts.test.js
import assert from 'assert/strict';
import { turnParts, noteAnswer, answeredBy, modelName } from '../turn-parts.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

// A voice model turn (Nov 28, Pixel, 7.9 s).
t('voice model turn', () => {
  const steps = [['turn_opened', 0, 0], ['voice_id', 175, 175], ['hub_hears_again', 1330, 1155], ['same_line_check', 1335, 5],
    ['echo_and_call_checks', 1335, 0], ['rules_before_model', 1365, 30], ['memory_recall', 1365, 0], ['tool_blocks', 1551, 186],
    ['projects_check', 3021, 1470], ['voice_prompt_built', 3021, 0], ['voice_model_first_words', 4946, 1925], ['reply_done', 7864, 2918]];
  const p = turnParts(steps, { model: 'reader:syrinx-lfm-r24:latest' });
  assert.equal(p.hub_ms, 3021);
  assert.equal(p.hear_ms, 1155);
  assert.equal(p.checks_ms, 1866);
  assert.equal(p.model_whole_ms, 7864 - 3021);
  assert.equal(p.model, 'Syrinx, the voice model');
  assert.equal(p.why, undefined);
});

// The voice model gave up, the backup answered (Nov 28, 16.8 s).
t('backup turn', () => {
  const steps = [['turn_opened', 1, 1], ['voice_id', 91, 90], ['hub_hears_again', 888, 797], ['same_line_check', 894, 6],
    ['echo_and_call_checks', 894, 0], ['rules_before_model', 920, 26], ['memory_recall', 921, 1], ['tool_blocks', 923, 2],
    ['projects_check', 925, 2], ['voice_prompt_built', 925, 0], ['voice_model_gave_up', 7453, 6528],
    ['full_prompt_built', 9308, 1855], ['first_words_sent', 16785, 7477], ['reply_done', 16785, 0]];
  const p = turnParts(steps, { model: 'reader:syrinx-lfm-r24:latest', path: 'cloud_fallback' }, 'anthropic:claude-haiku-5-5');
  assert.equal(p.hub_ms, 925 + 1855);
  assert.equal(p.first_out_ms, 16785);
  assert.equal(p.model_first_ms, 16785 - 2780);
  assert.equal(p.model, 'Claude Haiku');
  assert.match(p.why, /missed its time/);
});

t('world path names the bigger model', () => {
  const p = turnParts([['turn_opened', 0, 0], ['rules_before_model', 10, 10], ['world_lookup', 60, 50], ['first_words_sent', 1600, 1540], ['reply_done', 3000, 1400]],
    { path: 'world' }, 'ollama:pan-gemma-r4:latest');
  assert.equal(p.hub_ms, 60);
  assert.equal(p.model_first_ms, 1540);
  assert.equal(p.model, 'Gemma, tuned (on your computer)');
  assert.match(p.why, /needs knowledge/);
});

t('the last model to answer wins', () => {
  noteAnswer('tx', 'reader:syrinx-lfm-r24:latest');
  noteAnswer('tx', 'anthropic:claude-haiku-5-5');
  assert.equal(answeredBy('tx'), 'anthropic:claude-haiku-5-5');
  assert.equal(answeredBy('none'), null);
});

t('no steps, no parts', () => { assert.equal(turnParts([], {}), null); assert.equal(modelName('cli:codex'), 'Codex'); });

console.log(`${n} passed`);
