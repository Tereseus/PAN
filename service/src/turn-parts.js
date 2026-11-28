// A turn's time in the parts he can see when he taps a reply (the owner, Nov 28: "just say phone
// time, hub time, cloud model time"). The hub's part comes from the turn's steps (voice-timing.js
// startSteps / step); the phone adds its own part (hearing him stop, sending the sound, the way
// back) and the pauses while speaking. Which model answered comes from llm-fallback.js (onModel).

// The steps that are a model working; every other step is the hub's own work.
const MODEL_STEPS = new Set(['voice_model_first_words', 'voice_model_gave_up', 'projects_answer', 'first_words_sent', 'reply_done']);

const answered = new Map();
/** The model that answered this turn: the last one that committed (a backup after the voice model). */
export function noteAnswer(turn, model) {
  if (!turn || !model) return;
  answered.set(turn, String(model));
  if (answered.size > 200) answered.delete(answered.keys().next().value);
}
export function answeredBy(turn) { return answered.get(turn) || null; }

/** A model id in plain words. */
export function modelName(id) {
  const m = String(id || '');
  if (!m) return '';
  if (/syrinx/i.test(m)) return 'Syrinx, the voice model';
  if (/haiku/i.test(m)) return 'Claude Haiku';
  if (/sonnet/i.test(m)) return 'Claude Sonnet';
  if (/opus/i.test(m)) return 'Claude Opus';
  if (/^cli:codex/.test(m)) return 'Codex';
  if (/^cli:agy/.test(m)) return 'Gemini';
  if (/pan-gemma/i.test(m)) return 'Gemma, tuned (on your computer)';
  if (/gemma/i.test(m)) return 'Gemma (on your computer)';
  if (/pan-phi|phi/i.test(m)) return 'Phi (on your computer)';
  if (/granite/i.test(m)) return 'Granite (on your computer)';
  return m.replace(/^[a-z]+:/, '').replace(/:latest$/, '');
}

const WHY = {
  world: 'a question that needs knowledge went to the bigger model',
  self: 'a question about ΠAN or you went to the bigger model',
  kind: 'handed to the bigger model',
  reread: 'the bigger model read the talk again',
  tool: 'live data, answered by the bigger model',
  think: 'the voice model handed it up',
  search: 'the bigger model helped find a word',
  project: 'a project question',
  project_list: 'a project list',
  problem: 'a laid out problem went to the smart model',
  translate: 'translation',
  cloud_fallback: 'the voice model missed its time, the backup answered',
  full: 'no voice model, the full prompt answered',
};

/**
 * { hub_ms, hear_ms, checks_ms, first_out_ms, model_first_ms, model_whole_ms, model, model_id, why }
 * from the steps [[name, ms since the turn arrived, ms the step took], ...], the turn's timing
 * (turnTimings: path, model) and the model that answered. Missing parts are left out.
 */
export function turnParts(steps = [], timing = {}, answer = null) {
  if (!Array.isArray(steps) || !steps.length) return null;
  let hubBefore = 0, hubAll = 0, hear = 0, firstOut = null, done = null, gaveUp = false;
  for (const [name, at, took] of steps) {
    if (name === 'first_words_sent' && firstOut == null) firstOut = at;
    if (name === 'reply_done') done = at;
    if (name === 'voice_model_gave_up') gaveUp = true;
    if (MODEL_STEPS.has(name)) continue;
    hubAll += took;
    if (firstOut == null) hubBefore += took;
    if (name === 'hub_hears_again') hear += took;
  }
  const out = { hub_ms: hubBefore };
  if (hear) { out.hear_ms = hear; out.checks_ms = Math.max(0, hubBefore - hear); }
  if (firstOut != null) { out.first_out_ms = firstOut; out.model_first_ms = Math.max(0, firstOut - hubBefore); }
  if (done != null) out.model_whole_ms = Math.max(0, done - hubAll);
  const id = answer || timing?.model || null;
  if (id) { out.model_id = id; out.model = modelName(id); }
  const path = timing?.path;
  const why = gaveUp ? WHY.cloud_fallback : WHY[path];
  if (why) out.why = why;
  return out;
}
