// Surprise of a heard line: how unexpected its words are to a tiny language model, read in one pass.
// Speech said to PAN reads as ordinary language; song lyrics, TV and garbled background noise do not.
// On his 1,335 judged turns (2026-11-22, CONVERSATION-ODDS-PLAN.md), adding this to the voice
// model's odds was the first situation term that held up on days left out: log loss 0.413 to 0.388,
// and at the same misses about 10% fewer answers to lines not meant for PAN.
//
// Model: SmolLM2-135M (Hugging Face, Apache 2.0), exported to ONNX and quantized to 8 bits (165 MB),
// in <models>/smollm2-135m/ (model_int8.onnx, tokenizer.json, tokenizer_config.json). About 15 ms a
// line on two CPU threads. No model there: lineSurprise returns null and nothing else changes.
import { createRequire } from 'module';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { getDataDir } from '../platform.js';

const require = createRequire(import.meta.url);
export const SURPRISE_DIR = process.env.PAN_SURPRISE_DIR || join(dirname(getDataDir()), 'models', 'smollm2-135m');
const MAX_PIECES = 40;   // the line's first 40 word pieces are scored
const CTX_LINES = 2;     // the talk's last two lines go before it, as "Name: text"

let _load = null;

async function load() {
  const onnx = join(SURPRISE_DIR, process.env.PAN_SURPRISE_FILE || 'model.onnx');
  if (!existsSync(onnx)) return null;
  const ort = require('onnxruntime-node');
  const { Tokenizer } = await import('@huggingface/tokenizers');
  const tok = new Tokenizer(JSON.parse(readFileSync(join(SURPRISE_DIR, 'tokenizer.json'), 'utf8')),
    JSON.parse(readFileSync(join(SURPRISE_DIR, 'tokenizer_config.json'), 'utf8')));
  const session = await ort.InferenceSession.create(onnx, { intraOpNumThreads: 2, interOpNumThreads: 1, executionProviders: ['cpu'] });
  return { ort, tok, session };
}

function ready() {
  if (!_load) _load = load().catch((e) => { console.warn('[surprise] not available:', e.message); return null; });
  return _load;
}

const ids = (tok, text) => Array.from(tok.encode(text, { add_special_tokens: false }).ids, Number);

/**
 * The line's surprise, as the turn book and the fit use it:
 * mean = average surprisal in nats per word piece, floor = share of pieces outside the model's top
 * 100 guesses, first = average surprisal over the first six pieces. Null when the model is missing.
 */
export async function lineSurprise(history, line) {
  const m = await ready();
  const text = String(line || '').trim();
  if (!m || !text) return null;
  const t0 = Date.now();
  const hist = String(history || '').split('\n').filter((l) => /^(User|PAN|assistant):/.test(l)).slice(-CTX_LINES);
  const a = ids(m.tok, [...hist, 'User:'].join('\n'));
  const b = ids(m.tok, ' ' + text).slice(0, MAX_PIECES);
  const all = [...a, ...b].slice(-512);
  const n = all.length, nb = b.length;
  const big = (arr) => new m.ort.Tensor('int64', BigInt64Array.from(arr.map(BigInt)), [1, arr.length]);
  const out = await m.session.run({ input_ids: big(all), attention_mask: big(all.map(() => 1)), position_ids: big([...Array(n).keys()]) });
  const logits = out.logits.data;
  const V = out.logits.dims[2];
  const lps = [], ranks = [];
  for (let k = 0; k < nb; k++) {
    const row = (n - nb - 1 + k) * V;
    let max = -Infinity;
    for (let v = 0; v < V; v++) if (logits[row + v] > max) max = logits[row + v];
    let sum = 0;
    for (let v = 0; v < V; v++) sum += Math.exp(logits[row + v] - max);
    const target = all[n - nb + k];
    const got = logits[row + target];
    let rank = 0;
    for (let v = 0; v < V && rank < 100; v++) if (logits[row + v] > got) rank++;
    lps.push(got - max - Math.log(sum));
    ranks.push(rank);
  }
  const mean = -lps.reduce((s, x) => s + x, 0) / nb;
  const first = -lps.slice(0, 6).reduce((s, x) => s + x, 0) / Math.min(6, nb);
  const floor = ranks.filter((r) => r >= 100).length / nb;
  return { mean: +mean.toFixed(3), floor: +floor.toFixed(3), first: +first.toFixed(3), n: nb, ms: Date.now() - t0 };
}
