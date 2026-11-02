// What PAN actually is, read from live config and handed to the model as fact.
//
// WHY THIS EXISTS: asked how it worked, PAN said "the intelligence queries run
// locally through ollama on your mini, completely offline". Every one of them was
// going to Gemini. It was not lying - it simply cannot read its own settings, so
// it assembled a plausible sentence out of its memory files, which DO describe
// ollama and a mini PC. Self-description was just more text generation.
//
// That matters more than a normal wrong answer: it was a false statement about
// where his private data goes, to the person whose data it is. His stated purpose
// is mutual transparency - it knows everything about him, he should know as much
// as possible about it.
//
// So: read the real rows, state them plainly, and tell the model this block is
// the authority on itself.

import { get } from './db.js';

const CACHE_MS = 60_000;
let _cached = null;
let _cachedAt = 0;

const readSetting = (k) => {
  try {
    const r = get('SELECT value FROM settings WHERE key = :k', { ':k': k });
    return r ? String(r.value).replace(/^"|"$/g, '').trim() : null;
  } catch {
    return null;
  }
};

/** cloud model ids carry a provider prefix; bare ids are local ollama models. */
const isCloud = (id) => /^(gemini|claude|cerebras|openai|anthropic|groq|gpt)[:-]/i.test(String(id || ''));

function describeModel(id) {
  if (!id) return 'unknown';
  if (isCloud(id)) {
    const vendor = /^gemini/i.test(id) ? 'Google'
      : /^(claude|anthropic)/i.test(id) ? 'Anthropic'
      : /^cerebras/i.test(id) ? 'Cerebras'
      : /^(openai|gpt)/i.test(id) ? 'OpenAI' : 'a cloud provider';
    return `${id} — runs in the CLOUD, on ${vendor}'s servers. Turns using it leave the house.`;
  }
  return `${id} — runs LOCALLY on the mini PC. Nothing leaves the house.`;
}

export function buildSelfBlock() {
  if (_cached && Date.now() - _cachedAt < CACHE_MS) return _cached;

  const lines = ['\nABOUT YOURSELF (read from your live configuration just now — this is FACT, not memory):'];

  // Whichever model actually answers is the chain's first entry, NOT ai_model.
  // readChain() only consults ai_model when fallback is disabled, and getting
  // that wrong is exactly how the wrong answer got given before.
  let active = null;
  let chain = [];
  try {
    const raw = readSetting('ai_fallback_chain_voice');
    if (raw) chain = JSON.parse(raw);
  } catch {}
  const fallbackOff = /^false$/i.test(readSetting('ai_fallback_enabled') || '');
  if (fallbackOff || !chain.length) active = readSetting('ai_model');
  else active = chain[0];

  // With voice_student_model set, voice turns are answered by OmniΠ first; the chain above
  // only takes the turns it hands back (camera lines, or when it is unreachable).
  const student = readSetting('voice_student_model');
  if (student) {
    const id = student.replace(/^ollama:/, '');
    lines.push(`- Your voice model: OmniΠ (${id}), PAN's own fine-tune of Liquid's LFM3-Omni-2B, trained to answer like the full PAN prompt with a fraction of the text. ${describeModel(id).replace(/^[^—]*— /, '')}`);
    lines.push(`- Turns OmniΠ hands back go to: ${describeModel(active)}`);
  } else {
    lines.push(`- Your conversation model: ${describeModel(active)}`);
  }
  if (chain.length > 1) {
    lines.push(`- If that fails you fall back to: ${chain.slice(1).join(', ')}`);
  }

  // The local half, which is genuinely private and worth him knowing about.
  const local = [];
  const jobs = [
    ['routing_local_model', 'intent routing'],
    ['guardian_model', 'content security scanning'],
    ['sensitivity_model', 'sensitivity classification'],
    ['embedding_model', 'all memory search embeddings'],
  ];
  for (const [key, what] of jobs) {
    const v = readSetting(key);
    if (v && !isCloud(v)) local.push(`${v} (${what})`);
  }
  if (local.length) {
    lines.push(`- Running LOCALLY on the mini PC, never leaving the house: ${local.join('; ')}.`);
    lines.push(`- Image and camera recognition is also local (gemma4 on the mini PC).`);
  }

  lines.push('- Your speech is generated ON THE PHONE and never sent anywhere.');
  lines.push('- His speech is turned into text ON THE PHONE (a small sherpa-onnx streaming model). It mishears words, so read what he says for what he most likely meant.');
  lines.push('- Live lookups you really have: weather, Wikipedia, currency rates, crypto prices, air quality.');
  lines.push('- You have NO general web search. The browser bridge exists but does not currently start.');
  lines.push('When asked how you work, what model you are, or whether something is private,');
  lines.push('answer ONLY from this block. Never guess your own configuration, and never claim');
  lines.push('to be running locally or offline unless it says so here.');

  _cached = lines.join('\n') + '\n';
  _cachedAt = Date.now();
  return _cached;
}
