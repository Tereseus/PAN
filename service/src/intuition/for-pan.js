// p_for_pan, in SHADOW: the probability that a heard line was meant for PAN, from the voice model's
// own odds, the time since PAN spoke and the line's surprise (CONVERSATION-ODDS-PLAN.md, step 2).
// Logged in the turn book with each turn; nothing acts on it yet.
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
