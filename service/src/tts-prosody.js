// TTS prosody planner — Batch 4 of voice router epic #986.
//
// The router emits an `importance` score (0..1) per response in the JSON
// envelope. This module maps importance (plus a few cheap text signals) into
// a per-utterance prosody plan that TTS consumers (server F5-TTS, phone Piper,
// phone Android TTS) apply.
//
// Spec from prior session (transcript 59a5a699, line 1205):
//   importance < 0.3 → pitch=0.95, rate=0.92  (casual / conversational)
//   importance >= 0.3 → default (1.0 / 1.0)
//
// Extensions (cheap, deterministic, no LLM):
//   • all-caps span    → emph: bump rate +0.05, pitch +0.05 on that span
//   • trailing "?"     → final-rise pitch +0.05 on last token
//   • exclamation "!"  → rate +0.05, pitch +0.05 globally
//   • >25 words        → rate +0.03 (so long replies don't drag)
//
// Output schema (additive, never breaks consumers that ignore it):
//   {
//     rate:    Number,   // global speech rate multiplier (~0.85 – 1.15)
//     pitch:   Number,   // global pitch multiplier (~0.85 – 1.15)
//     segments: [        // optional per-word emphasis hints
//       { start: <char idx>, end: <char idx>, rate?: Number, pitch?: Number }
//     ],
//     importance: Number, // echoed for debugging
//     source: 'router'   // who built this plan
//   }
//
// Consumers:
//   • routeStream `done` event → result.prosody
//   • handleUnified response   → result.prosody
//   • client-manager `speak` payload → prosody field forwarded to phone

const DEFAULT_RATE  = 1.00;
const DEFAULT_PITCH = 1.00;

// Clamp to a sane prosody range — Piper accepts speed 0.5–2.0, Android TTS
// accepts rate 0.5–2.0 and pitch 0.5–2.0, F5-TTS is fine in 0.85–1.15.
function clamp(v, lo = 0.80, hi = 1.20) {
  if (typeof v !== 'number' || !isFinite(v)) return 1.0;
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Build a prosody plan from a normalized importance score and the response text.
 * Pure function — safe to call from any code path, including hot streaming loops.
 *
 * @param {number} importance  0..1 (null/undefined → assumed 0.5)
 * @param {string} text        the user-visible response string (may be empty)
 * @returns {{rate:number, pitch:number, segments:Array, importance:number, source:string}}
 */
export function planFromImportance(importance, text = '') {
  // Normalize importance — accept 0..1 or 0..100, coerce strings, fall back to 0.5
  let imp = importance;
  if (typeof imp === 'string') imp = parseFloat(imp);
  if (typeof imp !== 'number' || !isFinite(imp)) imp = 0.5;
  if (imp > 1) imp = imp / 100;                  // accept 0..100 from sloppy LLMs
  imp = Math.max(0, Math.min(1, imp));

  // Base: spec mapping
  let rate  = imp < 0.3 ? 0.92 : DEFAULT_RATE;
  let pitch = imp < 0.3 ? 0.95 : DEFAULT_PITCH;

  const segments = [];

  // Text-derived nudges (cheap heuristics)
  const s = (text || '').toString();
  if (s) {
    // Exclamation → slightly faster + brighter (excited / urgent affect)
    if (/!\s*$/.test(s) || s.split('!').length >= 3) {
      rate  += 0.05;
      pitch += 0.05;
    }
    // Length penalty — long replies otherwise drag in TTS
    const wordCount = s.split(/\s+/).filter(Boolean).length;
    if (wordCount > 25) rate += 0.03;

    // Trailing question → final-rise on the last word (segment marker)
    if (/\?\s*$/.test(s)) {
      const lastSpace = s.lastIndexOf(' ');
      if (lastSpace >= 0) {
        segments.push({ start: lastSpace + 1, end: s.length, pitch: 1.05 });
      }
    }

    // ALL-CAPS spans of 2+ chars → emphasized (skip if entire string is caps)
    const upper = s.match(/[A-Z]{2,}/g) || [];
    const allCaps = s.replace(/[^A-Za-z]/g, '').length > 0 &&
                    s.replace(/[^A-Za-z]/g, '') === s.replace(/[^A-Za-z]/g, '').toUpperCase();
    if (!allCaps) {
      for (const word of upper) {
        if (word.length < 2) continue;
        const idx = s.indexOf(word);
        if (idx < 0) continue;
        segments.push({ start: idx, end: idx + word.length, rate: 1.05, pitch: 1.05 });
      }
    }
  }

  return {
    rate:  clamp(rate),
    pitch: clamp(pitch),
    segments,
    importance: imp,
    source: 'router',
  };
}

/**
 * Build prosody from a router result object — convenience wrapper that pulls
 * importance + response from the parsed JSON envelope. Returns a default plan
 * for missing/null inputs so callers can blindly attach `prosody` to every
 * `done` event without null-checks.
 */
export function planFromResult(result) {
  if (!result || typeof result !== 'object') {
    return { rate: DEFAULT_RATE, pitch: DEFAULT_PITCH, segments: [], importance: 0.5, source: 'router-default' };
  }
  return planFromImportance(result.importance, result.response || '');
}

export default { planFromImportance, planFromResult };
