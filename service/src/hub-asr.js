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

/**
 * Transcribe 16kHz mono PCM16 (base64). Returns the text, or null when the hub cannot do it
 * (caller keeps the phone's text). Clips over 30s are not worth the wait on a voice turn.
 */
export async function transcribePcm16(b64, sampleRate = 16000) {
  // A turn that lands while the model is still loading keeps the phone's words rather than
  // waiting out the load: a second of latency costs more than one turn of the phone's ASR.
  if (!recognizer) { load(); return null; }
  const rec = recognizer;
  if (!b64) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    const n = buf.length >> 1;
    if (n < sampleRate * 0.3 || n > sampleRate * 30) return null;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(i * 2) / 32768;
    const stream = rec.createStream();
    stream.acceptWaveform({ samples, sampleRate });
    await rec.decodeAsync(stream);
    const text = String(rec.getResult(stream)?.text || '').trim();
    return text || null;
  } catch (e) {
    console.warn(`[hub-asr] decode failed: ${e.message}`);
    return null;
  }
}

/** Load at boot so the first voice turn does not pay the ~2s model load. */
export function warmHubAsr() {
  setTimeout(() => { load().catch(() => {}); }, 5000).unref?.();
}
