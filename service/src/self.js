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
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getDataDir } from './platform.js';

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

function activeChainModel() {
  let chain = [];
  try { chain = JSON.parse(readSetting('ai_fallback_chain_voice') || '[]'); } catch {}
  const fallbackOff = /^false$/i.test(readSetting('ai_fallback_enabled') || '');
  return (fallbackOff || !chain.length) ? readSetting('ai_model') : chain[0];
}

/**
 * The voice student's name and what it was fine-tuned from, read off its Ollama name. Round 9
 * (2026-11-03) renamed it Syrinx, Pan's reed pipes, because it need not be Liquid's model any
 * more; the base that won is in the name (syrinx-lfm, syrinx-gemma).
 */
function studentIdentity(id) {
  const base = /gemma/i.test(id) ? "Google's Gemma 4 E2B" : "Liquid's LFM3-Omni-2B";
  return /syrinx/i.test(id) ? { name: 'Syrinx', short: 'Syrinx', base } : { name: 'OmniPi (written OmniΠ)', short: 'OmniΠ', base };
}

// Asked its version and its own speed in the car, PAN said "I'm not sure about the latest version. Can you
// check that for me?" three times (2026-11-17): the line below had neither. Both are read from what the hub
// already holds. They change a few times a day at most, and the line sits right behind the hub model's fixed
// block, so they go through a cache and sit at the end of the line.
const _facts = new Map();
function cachedFact(key, ms, read) {
  const c = _facts.get(key);
  if (c && Date.now() - c.at < ms) return c.value;
  let value = '';
  try { value = read() || ''; } catch {}
  _facts.set(key, { at: Date.now(), value });
  return value;
}
const HERE = dirname(fileURLToPath(import.meta.url));
/** The app build on the device he is talking through (from its own start-up log line) and the newest one the hub holds. */
function appVersionFact(deviceId) {
  const newest = cachedFact('apk', 600_000, () => {
    const meta = JSON.parse(readFileSync(join(HERE, '..', '..', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'output-metadata.json'), 'utf8'));
    return (meta.elements || [])[0]?.versionName;
  });
  const mine = deviceId ? cachedFact(`app:${deviceId}`, 600_000, () => {
    const row = get("SELECT message FROM client_logs WHERE device_id = :d AND message LIKE 'Build: versionCode=%' ORDER BY id DESC LIMIT 1", { ':d': `phone-${deviceId}` });
    return row?.message?.match(/versionName=(\S+)/)?.[1];
  }) : '';
  if (mine && newest) return mine === newest ? `The PAN app he is talking through is version ${mine}, which is the newest build. ` : `The PAN app he is talking through is version ${mine}; the newest build on the hub is ${newest}. `;
  if (mine) return `The PAN app he is talking through is version ${mine}. `;
  return newest ? `The newest PAN app build on the hub is version ${newest}. ` : '';
}
/** How fast replies were on the last day the nightly voice report covers (voice-report.js). */
function speedFact() {
  return cachedFact('speed', 3_600_000, () => {
    const dir = join(getDataDir(), 'voice-reports');
    const last = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().pop();
    if (!last) return '';
    const r = JSON.parse(readFileSync(join(dir, last), 'utf8'));
    const w = r.speed_ms?.phone_first_words;
    if (!w || !(w.n >= 5) || !(w.p50 > 0)) return '';
    return `Your speed: on ${r.day} your replies started about ${(w.p50 / 1000).toFixed(1)} seconds after his words were sent, in the middle of ${w.n} replies. `;
  });
}

/**
 * One sentence for the student's short prompt. It was never trained on the long block below,
 * and given it, OmniΠ named the model from memory hits ("Gemma4 e4b") or skipped its own name.
 * Tested on the hub: this shape answers correctly.
 */
export function buildSelfLine({ viaLink, deviceId } = {}) {
  const student = readSetting('voice_student_model');
  if (!student) return '';
  const { name, base } = studentIdentity(student);
  const back = activeChainModel() || 'unknown';
  const where = isCloud(back) ? 'in the cloud' : 'on the same machine';
  // Asked "what's my name?" with no line at all, Syrinx answered "I'm LFM, built by Liquid AI"
  // four times running, and said he was talking to it "via the web interface" (2026-11-03).
  const owner = readSetting('display_name');
  // Second person and only positive facts: given "his phone" it said "his phone" back to him,
  // and given "never call yourself LFM" it announced "I'm not LFM or Liquid".
  const you = owner ? `The person talking to you is ${owner}: asked his own name, the answer is ${owner}. ` : '';
  return `About you (live, this is fact): your name is PAN, short for Personal AI Network, his personal AI. ${you}He talks to you through the PAN app on his phone (say "your phone" to him), and you run on the mini PC hub in his home. ${viaLink === true ? "Right now his words reach you over PAN Link, PAN's own encrypted connection between his devices and the hub, and it is working. " : viaLink === false ? 'Right now his words reach you without PAN Link (his home network or Tailscale). ' : ''}You think with two models: your voice model is ${name}, PAN's own fine-tune of ${base}, and the lines it hands up go to ${back} ${where}. Your ears are a separate model: NVIDIA Parakeet on the hub turns his speech into text. PAN is tested three ways: a voice bench, a conversation bench made from real recorded conversations (does PAN speak at the right moment, to the right person), and a nightly voice report on the speed and quality of his real turns. PAN's thread relay carries his voice to his Claude Code threads on his computers and reads their answers back: he says "tell the <name> thread ..." or "what is the <name> thread doing". ${appVersionFact(deviceId)}${speedFact()}Answer questions about yourself and about him only from this line.`;
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

  // With voice_student_model set, voice turns are answered by the student first; the chain
  // above only takes the turns it hands back (camera lines, or when it is unreachable).
  const student = readSetting('voice_student_model');
  if (student) {
    const id = student.replace(/^ollama:/, '');
    const { short, base } = studentIdentity(id);
    lines.push(`- Your voice model: ${short} (${id}), PAN's own fine-tune of ${base}, trained to answer like the full PAN prompt with a fraction of the text. ${describeModel(id).replace(/^[^—]*— /, '')}`);
    lines.push(`- Turns ${short} hands back go to: ${describeModel(active)}`);
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
    lines.push(`- Image and camera recognition is also local (moondream on the mini PC).`);
  }

  lines.push('- Your speech is generated ON THE PHONE and never sent anywhere.');
  lines.push("- His speech is turned into text by NVIDIA Parakeet on the mini PC (the phone's own small model is the fallback, and mishears words, so read what he says for what he most likely meant).");
  lines.push('- Live lookups you really have: weather, Wikipedia, currency rates, crypto prices, air quality.');
  lines.push('- You have NO general web search. The browser bridge exists but does not currently start.');
  lines.push('When asked how you work, what model you are, or whether something is private,');
  lines.push('answer ONLY from this block. Never guess your own configuration, and never claim');
  lines.push('to be running locally or offline unless it says so here.');

  _cached = lines.join('\n') + '\n';
  _cachedAt = Date.now();
  return _cached;
}
