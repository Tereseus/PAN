// node --test service/src/__tests__/model-set.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModelSet, pickSet, wanted, settingsForModels } from '../model-set.js';

const set = loadModelSet();
const ALL = set.models.map((m) => m.name);

test('the list is whole: every model has a role, a size, a licence and a place to come from', () => {
  assert.ok(set.ollama.installer.startsWith('https://ollama.com/'));
  for (const m of set.models) {
    assert.ok(m.role && m.name && m.what && m.licence, m.name);
    assert.ok(m.gb > 0 && m.gb < 20, m.name);
    assert.ok(['ollama', 'own'].includes(m.from), m.name);
    if (m.from === 'own') assert.ok(m.file.endsWith('.gguf'), m.name);
    assert.doesNotMatch(m.licence, /non.?commercial|research only/i, m.name);
  }
  assert.equal(new Set(set.models.map((m) => m.role)).size, set.models.length);
});

test('a 16 GB computer gets the light set, 32 GB the full one', () => {
  assert.equal(pickSet(15.8), 'light');
  assert.equal(pickSet(23.9), 'light');
  assert.equal(pickSet(24), 'full');
  assert.equal(pickSet(31.7), 'full');
  const light = wanted(set, 'light').map((m) => m.role);
  assert.deepEqual(light, ['memory', 'talk', 'questions', 'backup', 'photos']);
  assert.equal(wanted(set, 'full').at(-1).role, 'sorting');
  const gb = (s) => wanted(set, s).reduce((n, m) => n + m.gb, 0);
  assert.ok(gb('light') < 14 && gb('full') > gb('light'));
});

test('with every model here, PAN is pointed at each one', () => {
  const { set: s, missing, voice } = settingsForModels(set, ALL);
  assert.equal(voice, true);
  assert.deepEqual(missing, []);
  assert.equal(s.ollama_url, 'http://127.0.0.1:11434');
  assert.equal(s.voice_student_model, 'reader:syrinx-lfm-r15:latest');
  assert.equal(s.voice_world_model, 'ollama:pan-phi-r1:latest');
  assert.equal(s.voice_world_questions, 'cloud');
  assert.equal(s.voice_hub_paths, 'all');
  assert.equal(s.ai_model, 'ollama:gemma4:e2b');
  assert.deepEqual(JSON.parse(s.ai_fallback_chain_voice), ['ollama:gemma4:e2b']);
  assert.equal(s.routing_local_model, 'gemma4:e4b');
  assert.equal(s.guardian_model, 'gemma4:e4b');
  assert.equal(s.embedding_model, 'qwen3-embedding:0.6b');
  assert.equal(s.embedding_dim, '1024');
  assert.equal(s.photo_reader, 'moondream:latest');
});

test('the light set: the one stock model does the sorting too', () => {
  const have = wanted(set, 'light').map((m) => m.name);
  const { set: s, missing } = settingsForModels(set, have);
  assert.equal(s.routing_local_model, 'gemma4:e2b');
  assert.equal(s.sensitivity_model, 'gemma4:e2b');
  assert.deepEqual(missing, []);
});

test('nothing is pointed at a model that is not here', () => {
  const { set: s, missing, voice } = settingsForModels(set, ['qwen3-embedding:0.6b']);
  assert.equal(voice, false);
  assert.deepEqual(Object.keys(s).sort(), ['embedding_dim', 'embedding_model', 'ollama_url']);
  assert.deepEqual(missing.sort(), ['backup', 'photos', 'questions', 'sorting', 'talk']);
  assert.deepEqual(settingsForModels(set, []).set, {});
});

test('without PAN own tuned Phi, the stock Phi answers questions', () => {
  const { set: s } = settingsForModels(set, ['phi4-mini:3.8b']);
  assert.equal(s.voice_world_model, 'ollama:phi4-mini:3.8b');
});

test('what a person already chose stays', () => {
  const { set: s } = settingsForModels(set, ALL, { ai_model: 'ollama:something-else', voice_student_model: '""', embedding_model: '' });
  assert.equal('ai_model' in s, false);
  assert.equal(s.voice_student_model, 'reader:syrinx-lfm-r15:latest');
  assert.equal(s.embedding_model, 'qwen3-embedding:0.6b');
});

test('Ollama names with and without a tag match', () => {
  const { set: s } = settingsForModels(set, ['moondream', 'SYRINX-LFM-R15:latest']);
  assert.equal(s.photo_reader, 'moondream:latest');
  assert.equal(s.voice_student_model, 'reader:syrinx-lfm-r15:latest');
});

test('the stand in gives way when PAN own Phi arrives, a person own choice does not', () => {
  assert.equal(settingsForModels(set, ALL, { voice_world_model: 'ollama:phi4-mini:3.8b' }).set.voice_world_model, 'ollama:pan-phi-r1:latest');
  assert.equal('voice_world_model' in settingsForModels(set, ALL, { voice_world_model: 'ollama:their-own:1b' }).set, false);
  assert.equal('voice_world_model' in settingsForModels(set, ['phi4-mini:3.8b'], { voice_world_model: 'ollama:phi4-mini:3.8b' }).set, false);
});
