// The models a PAN on someone's own computer runs (../model-set.json), and the settings
// that point PAN at the ones that are really there. Pure rules: no database, no network.
// The route that uses them is routes/model-setup.js; PAN Setup calls it after it has
// downloaded the models.
//
// A setting is only ever filled in when it is empty. What a person chose stays.

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

export function loadModelSet(path = join(here, '..', 'model-set.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Which set fits this computer. Under 24 GB the two Gemma models do not fit in memory together. */
export function pickSet(ramGB) {
  return Number(ramGB) >= 24 ? 'full' : 'light';
}

/** The models of a set, in the order to download them: small and needed first. */
export function wanted(modelSet, set) {
  const order = ['memory', 'talk', 'questions', 'backup', 'photos', 'sorting'];
  return modelSet.models
    .filter((m) => m.sets.includes(set))
    .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
}

/** "gemma4:e2b" and "gemma4:e2b:latest"-style differences: Ollama lists "name:tag", a bare name means ":latest". */
function norm(name) {
  const n = String(name || '').trim().toLowerCase();
  return n.includes(':') ? n : `${n}:latest`;
}

function has(have, name) {
  const want = norm(name);
  return have.some((h) => norm(h) === want);
}

/**
 * The settings for the models that are on this computer.
 * @param {object}   modelSet  model-set.json
 * @param {string[]} have      model names Ollama lists
 * @param {object}   current   settings already saved (key -> value). A non empty one is left alone.
 * @returns {{ set: object, missing: string[], voice: boolean }}
 *   set: settings to write; missing: roles with no model here; voice: PAN can talk with these.
 */
export function settingsForModels(modelSet, have, current = {}) {
  const by = Object.fromEntries(modelSet.models.map((m) => [m.role, m]));
  const here = (role) => (by[role] && has(have, by[role].name) ? by[role].name : null);
  const want = {};
  const missing = [];

  const backup = here('backup');
  const sorting = here('sorting') || backup; // the light set: one stock model does both
  const talk = here('talk');
  const questions = here('questions') || (by.questions?.standIn && has(have, by.questions.standIn) ? by.questions.standIn : null);
  const memory = here('memory');
  const photos = here('photos');

  if (have.length) want.ollama_url = modelSet.ollama.url;
  if (backup) {
    want.ai_model = `ollama:${backup}`;
    want.ai_fallback_chain_voice = JSON.stringify([`ollama:${backup}`]);
    want.job_models = JSON.stringify({ 'smart-steward': `ollama:${backup}` });
  } else missing.push('backup');
  if (sorting) {
    for (const key of ['routing_local_model', 'guardian_model', 'sensitivity_model', 'c2d_local_model']) want[key] = sorting;
  } else missing.push('sorting');
  if (memory) {
    want.embedding_model = memory;
    want.embedding_dim = '1024';
  } else missing.push('memory');
  if (photos) want.photo_reader = photos; else missing.push('photos');
  if (talk) want.voice_student_model = `reader:${talk}`; else missing.push('talk');
  if (questions) {
    // The computer's own model answers real questions and every line the talking model
    // hands up (router.js worldQuestionsOn, hubPathsOn): no cloud and no key.
    want.voice_world_model = `ollama:${questions}`;
    want.voice_world_questions = 'cloud';
    want.voice_hub_paths = 'all';
  } else missing.push('questions');

  // A stand in that Setup itself put there gives way when the real model arrives.
  const standIn = by.questions?.standIn ? `ollama:${by.questions.standIn}` : null;
  const set = {};
  for (const [key, value] of Object.entries(want)) {
    const now = String(current[key] ?? '').replace(/^"|"$/g, '').trim();
    if (!now || (key === 'voice_world_model' && now === standIn && value !== standIn)) set[key] = value;
  }
  return { set, missing, voice: !!talk };
}
