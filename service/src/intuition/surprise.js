// Surprise of a heard line: how unexpected its words are to a tiny language model, read in one pass.
// Speech said to PAN reads as ordinary language; song lyrics, TV and garbled background noise do not.
// On his 1,335 judged turns (2026-11-22, CONVERSATION-ODDS-PLAN.md), adding this to the voice
// model's odds was the first situation term that held up on days left out: log loss 0.413 to 0.388,
// and at the same misses about 10% fewer answers to lines not meant for PAN.
//
// Model: SmolLM2-135M (Hugging Face, Apache 2.0), exported to ONNX at full precision (650 MB; the 8 bit
// copy gave different numbers on different CPUs), in <models>/smollm2-135m/ (model.onnx, tokenizer.json,
// tokenizer_config.json). About 75 ms a line on the hub on two CPU threads. No model there:
// lineSurprise returns null and nothing else changes.
//
// The same pass also gives the model's own reading of the line: the hidden state after layer 15 of 30,
// averaged over the line's word pieces (`mid`, 576 numbers). p_for_pan v2 uses it (for-pan.js). It is
// there only when model.onnx has that second output (added 2026-11-23 to the same file; the logits did
// not change).
//
// It runs in a child process of its own. The hub's speech recognizer (sherpa-onnx-node, hub-asr.js and
// voice-id.js) loads its own, older onnxruntime.dll into the process, and Windows then refuses this
// package's ("The operating system cannot run %1"): in the live service every turn got no surprise
// (2026-11-23). The child is started on the first line, ends with its parent, and is started again
// after a crash. PAN_SURPRISE_INPROC=1 computes in the calling process instead.
import { createRequire } from 'module';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
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
  const midName = session.outputNames.find((n) => n !== 'logits') || null;
  return { ort, tok, session, midName };
}

function ready() {
  if (!_load) _load = load().catch((e) => { console.warn('[surprise] not available:', e.message); return null; });
  return _load;
}

const ids = (tok, text) => Array.from(tok.encode(text, { add_special_tokens: false }).ids, Number);

// The work itself (in the child process unless PAN_SURPRISE_INPROC=1); see lineSurprise.
async function computeSurprise(history, line) {
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
  let mid = null;
  const h = m.midName ? out[m.midName] : null;
  if (h) {
    const D = h.dims[2];
    mid = new Array(D).fill(0);
    for (let k = n - nb; k < n; k++) for (let d = 0; d < D; d++) mid[d] += h.data[k * D + d] / nb;
  }
  const mean = -lps.reduce((s, x) => s + x, 0) / nb;
  const first = -lps.slice(0, 6).reduce((s, x) => s + x, 0) / Math.min(6, nb);
  const floor = ranks.filter((r) => r >= 100).length / nb;
  return { mean: +mean.toFixed(3), floor: +floor.toFixed(3), first: +first.toFixed(3), n: nb, ms: Date.now() - t0, mid };
}

// ── The child process ────────────────────────────────────────────────────────
const IS_CHILD = process.env.PAN_SURPRISE_CHILD === '1';
const IN_PROC = IS_CHILD || process.env.PAN_SURPRISE_INPROC === '1';
const CALL_TIMEOUT_MS = 15_000;
const RESTART_AFTER_MS = 60_000;
let _child = null, _seq = 0, _deadUntil = 0;
const _waiting = new Map();

function child() {
  if (_child) return _child;
  if (Date.now() < _deadUntil) return null;
  const c = fork(fileURLToPath(import.meta.url), [], {
    env: { ...process.env, PAN_SURPRISE_CHILD: '1' }, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  c.on('message', (m) => {
    const w = _waiting.get(m?.id);
    if (w) { _waiting.delete(m.id); clearTimeout(w.timer); w.resolve(m.result ?? null); }
  });
  c.on('exit', (code) => {
    if (_child === c) { _child = null; _deadUntil = Date.now() + RESTART_AFTER_MS; }
    if (code) console.warn(`[surprise] child process ended (${code}); started again after ${RESTART_AFTER_MS / 1000} s`);
    for (const [id, w] of _waiting) { clearTimeout(w.timer); w.resolve(null); _waiting.delete(id); }
  });
  c.unref();
  c.channel?.unref?.();
  _child = c;
  return c;
}

/**
 * The line's surprise, as the turn book and the fit use it:
 * mean = average surprisal in nats per word piece, floor = share of pieces outside the model's top
 * 100 guesses, first = average surprisal over the first six pieces; mid = the layer 15 reading (or null).
 * Null when the model is missing or the child process does not answer.
 */
export async function lineSurprise(history, line) {
  if (IN_PROC) return computeSurprise(history, line);
  const c = child();
  if (!c) return null;
  const id = ++_seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { _waiting.delete(id); resolve(null); }, CALL_TIMEOUT_MS);
    _waiting.set(id, { resolve, timer });
    try { c.send({ id, history: String(history || ''), line: String(line || '') }); }
    catch { clearTimeout(timer); _waiting.delete(id); resolve(null); }
  });
}

if (IS_CHILD) {
  process.on('disconnect', () => process.exit(0));   // the service ended
  process.on('message', async (m) => {
    let result = null;
    try { result = await computeSurprise(m.history, m.line); } catch (e) { console.warn('[surprise] line failed:', e.message); }
    try { process.send({ id: m.id, result }); } catch {}
  });
}

