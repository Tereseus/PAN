// Hub-side second pass on the phone's speech-to-text.
//
// The phone's streaming zipformer decides WHEN a turn ends, and it is good at that. Its words
// are not: it learned English from audiobooks (LibriSpeech), and on real speech through the
// phone mic it heard "what model is it using" as "what motto is it using", "mot", "modo".
// The phone now sends the turn's audio with its text (app 0.4.43+), and this re-transcribes
// it with NVIDIA Parakeet TDT 0.6B v2 - offline, trained on far more real speech, about half
// a second per sentence on the hub CPU.
//
// Optional on purpose: no sherpa-onnx-node package, no model files, or a failed decode all
// mean the phone's own text is used exactly as before.
//
// Model files (~660MB) live outside the repo, in <PAN data>/../models/parakeet-tdt-0.6b-v2-int8:
// encoder.int8.onnx, decoder.int8.onnx, joiner.int8.onnx, tokens.txt from
// huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8
import { createRequire } from 'module';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { getDataDir } from './platform.js';

const require = createRequire(import.meta.url);
const MODEL_DIR = process.env.PAN_ASR_DIR || join(dirname(getDataDir()), 'models', 'parakeet-tdt-0.6b-v2-int8');
const FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'];

let recognizer = null;
let loading = null;        // the in-flight load, so a turn during warm-up never starts a second one
let unavailable = false;   // set once; a missing package or model is not retried every turn

// Built with createAsync, which reads the weights on the libuv threadpool. The sync
// constructor did it on the main thread: a 2-3.6 s [loop-block] right after
// "[hub-asr] parakeet loaded" at every Craft boot, which on a swap-heavy day is
// several times an hour, with voice turns queued behind it.
function load() {
  if (recognizer || unavailable) return Promise.resolve(recognizer);
  if (loading) return loading;
  loading = (async () => {
    try {
      if (!FILES.every(f => existsSync(join(MODEL_DIR, f)))) {
        unavailable = true;
        console.log(`[hub-asr] no model in ${MODEL_DIR} - using the phone's text`);
        return null;
      }
      const sherpa = require('sherpa-onnx-node');
      const config = {
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: join(MODEL_DIR, 'encoder.int8.onnx'),
            decoder: join(MODEL_DIR, 'decoder.int8.onnx'),
            joiner: join(MODEL_DIR, 'joiner.int8.onnx'),
          },
          tokens: join(MODEL_DIR, 'tokens.txt'),
          modelType: 'nemo_transducer',
          numThreads: 4,
          provider: 'cpu',
          debug: 0,
        },
      };
      const t0 = Date.now();
      // createAsync arrived in sherpa-onnx-node 2.x; an older install still loads, just blocking.
      recognizer = typeof sherpa.OfflineRecognizer.createAsync === 'function'
        ? await sherpa.OfflineRecognizer.createAsync(config)
        : new sherpa.OfflineRecognizer(config);
      console.log(`[hub-asr] parakeet loaded in ${Date.now() - t0}ms`);
    } catch (e) {
      unavailable = true;
      console.warn(`[hub-asr] unavailable: ${e.message}`);
    } finally {
      loading = null;
    }
    return recognizer;
  })();
  return loading;
}

// 16kHz mono PCM16 (base64) as floats, or null for a clip too short to be words or too long
// (over 30 s) to be worth the wait on a voice turn.
function toSamples(b64, sampleRate) {
  if (!b64) return null;
  const buf = Buffer.from(b64, 'base64');
  const n = buf.length >> 1;
  if (n < sampleRate * 0.3 || n > sampleRate * 30) return null;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(i * 2) / 32768;
  return samples;
}

async function decode(rec, samples, sampleRate) {
  const stream = rec.createStream();
  stream.acceptWaveform({ samples, sampleRate });
  await rec.decodeAsync(stream);
  return rec.getResult(stream) || {};
}

/**
 * Transcribe 16kHz mono PCM16 (base64). Returns the text, or null when the hub cannot do it
 * (caller keeps the phone's text).
 */
export async function transcribePcm16(b64, sampleRate = 16000) {
  // A turn that lands while the model is still loading keeps the phone's words rather than
  // waiting out the load: a second of latency costs more than one turn of the phone's ASR.
  if (!recognizer) { load(); return null; }
  try {
    const samples = toSamples(b64, sampleRate);
    if (!samples) return null;
    const text = String((await decode(recognizer, samples, sampleRate)).text || '').trim();
    return text || null;
  } catch (e) {
    console.warn(`[hub-asr] decode failed: ${e.message}`);
    return null;
  }
}

// OTHER LANGUAGES, for interpreting (2026-11-03). Parakeet v2 only knows English, so the
// person he was translating for came out as English-sounding nonsense. One model per group of
// languages, each loaded the first time a language needs it (int8 via sherpa-onnx, all from
// huggingface.co/csukuangfj, in <PAN data>/../models/<dir>):
//   sensevoice  sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17: Japanese, Chinese,
//               Cantonese, Korean, and it names the language it heard. ~0.15 s for a 7 s line.
//   parakeet3   sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8: 25 European languages; no language
//               tag. ~0.35 s for a 7 s line.
//   whisper     sherpa-onnx-whisper-turbo: everything else (~99 languages); names the language.
//               ~1-2.6 s a line, so it only gets the languages the other two cannot hear.
// (Hub CPU, Ryzen 7 5800H, 2026-11-03; Parakeet v2 is ~0.35 s for the same English line.)
const MODELS = join(dirname(getDataDir()), 'models');
const SPEECH = {
  sensevoice: {
    dir: 'sense-voice-zh-en-ja-ko-yue-int8', files: ['model.int8.onnx', 'tokens.txt'],
    langs: ['ja', 'zh', 'yue', 'ko'],
    config: (d) => ({ senseVoice: { model: join(d, 'model.int8.onnx'), language: '', useInverseTextNormalization: 1 }, tokens: join(d, 'tokens.txt') }),
  },
  parakeet3: {
    dir: 'parakeet-tdt-0.6b-v3-int8', files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
    langs: ['bg', 'hr', 'cs', 'da', 'nl', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk'],
    config: (d) => ({
      transducer: { encoder: join(d, 'encoder.int8.onnx'), decoder: join(d, 'decoder.int8.onnx'), joiner: join(d, 'joiner.int8.onnx') },
      tokens: join(d, 'tokens.txt'), modelType: 'nemo_transducer',
    }),
  },
  whisper: {
    dir: 'whisper-turbo-int8', files: ['turbo-encoder.int8.onnx', 'turbo-decoder.int8.onnx', 'turbo-tokens.txt'],
    langs: null,   // everything the others do not hear
    threads: 8,    // 8 was 25% faster than 4; 16 no faster again
    // sherpa-onnx pads every clip with 1000 silent frames (10 s) so Whisper finds the end. 500
    // heard the same words 40% faster; 300 made it say the German test line twice.
    config: (d) => ({
      whisper: { encoder: join(d, 'turbo-encoder.int8.onnx'), decoder: join(d, 'turbo-decoder.int8.onnx'), language: '', task: 'transcribe', tailPaddings: 500 },
      tokens: join(d, 'turbo-tokens.txt'),
    }),
  },
};
const speech = {};        // model name -> recognizer
const speechLoading = {}; // model name -> the in-flight load
const speechMissing = new Set();

function speechModelFor(lang) {
  return Object.keys(SPEECH).find(k => SPEECH[k].langs?.includes(lang)) || 'whisper';
}

function loadSpeech(name) {
  if (speech[name] || speechMissing.has(name)) return Promise.resolve(speech[name] || null);
  if (speechLoading[name]) return speechLoading[name];
  const m = SPEECH[name];
  const d = join(MODELS, m.dir);
  speechLoading[name] = (async () => {
    try {
      if (!m.files.every(f => existsSync(join(d, f)))) {
        speechMissing.add(name);
        console.log(`[hub-asr] no ${name} model in ${d}`);
        return null;
      }
      const sherpa = require('sherpa-onnx-node');
      const t0 = Date.now();
      speech[name] = await sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: { ...m.config(d), numThreads: m.threads || 4, provider: 'cpu', debug: 0 },
      });
      console.log(`[hub-asr] ${name} loaded in ${Date.now() - t0}ms`);
    } catch (e) {
      speechMissing.add(name);
      console.warn(`[hub-asr] ${name} unavailable: ${e.message}`);
    } finally {
      delete speechLoading[name];
    }
    return speech[name] || null;
  })();
  return speechLoading[name];
}

/** Load the model for a language he has just asked to interpret, so his first turn does not wait. */
export function warmForLanguage(lang) {
  loadSpeech(speechModelFor(lang)).catch(() => {});
}

// Whisper on a short line says it again into the silence after it ("Stop translating. Stop
// translating. Stop translating..." for a 1.4 s clip, 2026-11-03). A sentence that only repeats
// the one before it, or a whole line that is one phrase over and over, is that, not speech.
function dropRepeats(text) {
  const out = [];
  for (const part of text.match(/[^.!?。！？]+[.!?。！？]*/g) || [text]) {
    const k = part.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (k && out.length && out[out.length - 1].k === k) continue;
    out.push({ part, k });
  }
  return out.map(o => o.part).join('').trim().replace(/^(.{2,}?)(?:[\s,、]+\1)+$/iu, '$1');
}

/**
 * Transcribe a clip in the language he is interpreting (`lang`, an ISO code such as "ja") or in
 * English: { text, lang }, lang being what the model heard ("ja", "en", or '' when the model does
 * not say, as Parakeet v3), or null when the hub cannot (no model, a bad clip). Waits out a first
 * load: the turn is in a language the phone cannot hear at all, so there is nothing to fall back to.
 */
export async function transcribeAnyLanguage(b64, lang, sampleRate = 16000) {
  const name = speechModelFor(lang);
  const rec = speech[name] || await loadSpeech(name);
  if (!rec) return null;
  try {
    const samples = toSamples(b64, sampleRate);
    if (!samples) return null;
    const r = await decode(rec, samples, sampleRate);
    const said = String(r.text || '').trim();
    const text = name === 'whisper' ? dropRepeats(said) : said;
    return text ? { text, lang: String(r.lang || '').replace(/[<|>]/g, ''), model: name } : null;
  } catch (e) {
    console.warn(`[hub-asr] ${name} decode failed: ${e.message}`);
    return null;
  }
}

// Language names he might say, to the codes above.
const LANGUAGE_CODES = {
  japanese: 'ja', chinese: 'zh', mandarin: 'zh', cantonese: 'yue', korean: 'ko', greek: 'el', spanish: 'es',
  french: 'fr', german: 'de', italian: 'it', portuguese: 'pt', brazilian: 'pt', russian: 'ru', ukrainian: 'uk',
  polish: 'pl', dutch: 'nl', swedish: 'sv', danish: 'da', finnish: 'fi', czech: 'cs', slovak: 'sk',
  hungarian: 'hu', romanian: 'ro', bulgarian: 'bg', croatian: 'hr', serbian: 'sr', slovenian: 'sl',
  estonian: 'et', latvian: 'lv', lithuanian: 'lt', maltese: 'mt', norwegian: 'no', icelandic: 'is',
  albanian: 'sq', arabic: 'ar', hebrew: 'he', turkish: 'tr', persian: 'fa', farsi: 'fa', hindi: 'hi',
  urdu: 'ur', bengali: 'bn', thai: 'th', vietnamese: 'vi', indonesian: 'id', malay: 'ms', tagalog: 'tl',
  filipino: 'tl', swahili: 'sw', georgian: 'ka', armenian: 'hy',
};
const LANGUAGE_RE = new RegExp(`\\b(${Object.keys(LANGUAGE_CODES).join('|')})\\b`, 'i');

/** The name for a code the speech models report ("es" -> "Spanish"), or null. */
export function languageName(code) {
  const w = Object.keys(LANGUAGE_CODES).find(k => LANGUAGE_CODES[k] === code);
  return w ? w[0].toUpperCase() + w.slice(1) : null;
}

/** The first language named in a line: { code: "ja", name: "Japanese" }, or null. */
export function languageNamed(text) {
  const m = String(text || '').match(LANGUAGE_RE);
  if (!m) return null;
  const w = m[1].toLowerCase();
  return { code: LANGUAGE_CODES[w], name: w[0].toUpperCase() + w.slice(1) };
}

/** Load at boot so the first voice turn does not pay the ~2s model load. */
export function warmHubAsr() {
  setTimeout(() => { load().catch(() => {}); }, 5000).unref?.();
  // The interpreter's ear too: it took 2.2 s to load on the first line of a live test (2026-11-05).
  setTimeout(() => { loadSpeech('sensevoice').catch(() => {}); }, 20_000).unref?.();
}
