// p_for_pan, in SHADOW: the probability that a heard line was meant for PAN, from the voice model's
// own odds, the time since PAN spoke and the line's surprise (CONVERSATION-ODDS-PLAN.md, step 2).
// Logged in the turn book with each turn; nothing acts on it yet. Two versions are logged side by side:
// p_for_pan (v1, below) and p_for_pan2 (v2, forPanV2 at the end).
//
//   L = base + w_ell * ell + w_talk * talk + w_x * ell * talk + w_m * mean + w_f * floor + w_1 * first
//   p = 1 / (1 + e^-L)
//   ell  = log P("pan") - log P("room"), the word after {"to": " in the voice model's reply
//   talk = e^(-seconds since PAN spoke / 20), 0 when PAN has not spoken
//   mean, floor, first = the line's surprise (surprise.js)
//
// Fitted 2026-11-22 on 1,335 of his judged turns (voice model round 24, surprise from SmolLM2-135M at
// full precision), logistic regression, each day left out in turn: log loss 0.385 against 0.413 for
// the voice model's odds alone. Version FOR_PAN_V goes into the log so later fits know which weights.
import { readFileSync } from 'fs';

export const FOR_PAN_V = 1;
const W = { base: -0.7003, ell: 0.2522, talk: 1.2668, ellTalk: 0.0728, mean: -0.1477, floor: -0.7423, first: -0.063 };
const TAU_S = 20;
const lp = (p) => Math.log(Math.min(Math.max(Number(p) || 0, 1e-4), 1 - 1e-4));

/** null when the voice model did not read the line (no odds) or the surprise is missing. */
export function forPan({ pPan, pRoom, sincePanMs, surprise }) {
  if (!Number.isFinite(pPan) || !surprise) return null;
  const ell = lp(pPan) - lp(Math.max(Number(pRoom) || 0, 1e-4));
  const talk = Number.isFinite(sincePanMs) ? Math.exp(-sincePanMs / 1000 / TAU_S) : 0;
  const L = W.base + W.ell * ell + W.talk * talk + W.ellTalk * ell * talk
    + W.mean * surprise.mean + W.floor * surprise.floor + W.first * surprise.first;
  return Math.round(1000 / (1 + Math.exp(-L))) / 1000;
}

// v2 (2026-11-23): v1's terms plus the tiny model's own reading of the line (surprise.js `mid`, 576
// numbers). Fitted on the same 1,335 judged turns, the reading cut to 64 main directions, then folded
// back into one weight per number, so it is a single dot product here. Each day left out: log loss
// 0.285 against v1's 0.385, AUC 0.94 against 0.89. Kept the misses at 30 of 412 and the answers to lines
// not meant for PAN fall from 362 to 165 of 923 (songs 91 to 35, garbled 61 to 21, talk to Claude 60 to
// 35, talk to other people 42 to 29). Trained on earlier days only and scored on later ones it held
// (140 to 79). Weights in for-pan-v2.json (fitting scripts and checks: CONVERSATION-ODDS-PLAN.md).
export const FOR_PAN_V2 = 2;
let _w2;
function w2() {
  if (_w2 === undefined) {
    try { _w2 = JSON.parse(readFileSync(new URL('./for-pan-v2.json', import.meta.url), 'utf8')); } catch { _w2 = null; }
  }
  return _w2;
}

/** null when the odds, the surprise or the model's reading are missing. */
export function forPanV2({ pPan, pRoom, sincePanMs, surprise }) {
  const W2 = w2();
  if (!W2 || !Number.isFinite(pPan) || !surprise || !Array.isArray(surprise.mid) || surprise.mid.length !== W2.mid.length) return null;
  const ell = lp(pPan) - lp(Math.max(Number(pRoom) || 0, 1e-4));
  const talk = Number.isFinite(sincePanMs) ? Math.exp(-sincePanMs / 1000 / W2.tau_s) : 0;
  const base = [ell, talk, ell * talk, surprise.mean, surprise.floor, surprise.first];
  let L = W2.bias;
  for (let k = 0; k < base.length; k++) L += W2.base[k] * base[k];
  for (let d = 0; d < W2.mid.length; d++) L += W2.mid[d] * surprise.mid[d];
  return Math.round(1000 / (1 + Math.exp(-L))) / 1000;
}
