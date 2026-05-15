// Nourishment — the first wired Life Need.
//
// This is the "adapter" layer: it watches the world for evidence that the user
// ate/drank, and translates those signals into `needs.satisfy()` /
// `needs.observe()` calls on the generic engine.
//
// Producers (callers):
//   • screen-watcher.js  → noteFoodInScreenDescription(text)
//       Scans vision-AI screen description for food/drink mentions. Weak
//       evidence (food on screen ≠ user is eating) → observe(+10).
//   • router.js          → noteMealMention(utterance)
//       Strong evidence — user explicitly said "I just ate" / "had lunch".
//       → satisfy() with delta based on phrase strength.
//
// Identity:
//   • Resolved via face-id lock from webcam-watcher. Falls back to 'owner'
//     (the single-person default) until multi-user identity fusion lands.

import { observe, satisfy } from './needs.js';
import { writeThought } from './mind.js';
import { getWebcamContext } from '../webcam-watcher.js';

// ── Identity resolution (placeholder) ─────────────────────────────────────────
// TODO(identity-fusion): replace with cluster lookup once intuition/identity.js
// is built. For now, single-user system → face-id lock or 'owner'.
export function currentUserId() {
  try {
    const ctx = getWebcamContext && getWebcamContext();
    if (ctx?.identity && ctx.identity !== 'unknown') return ctx.identity;
  } catch { /* fall through */ }
  return 'owner';
}

// ── Keyword tables ────────────────────────────────────────────────────────────
// Food/drink terms that, if seen in a vision-AI screen description, are weak
// evidence the user is eating/drinking AT their desk. (A picture of a pizza on
// a webpage doesn't mean they're eating — hence observe, not satisfy.)
const FOOD_TERMS = [
  'pizza', 'sandwich', 'burger', 'salad', 'pasta', 'noodles', 'sushi', 'taco',
  'burrito', 'rice', 'soup', 'bowl of', 'plate of', 'meal', 'breakfast',
  'lunch', 'dinner', 'snack', 'fruit', 'apple', 'banana', 'cereal', 'eggs',
  'bread', 'toast', 'chicken', 'steak', 'fish', 'sandwich', 'wrap',
];
const DRINK_TERMS = [
  'coffee', 'tea', 'mug', 'cup of', 'glass of water', 'water bottle',
  'soda', 'juice', 'beer', 'wine', 'smoothie', 'latte', 'espresso',
];

// Strong meal-mention phrases — user explicitly states eating happened.
// Pattern: regex → satisfy delta (or null for full reset to 100).
// Order matters: most specific first (full reset cases), then partial bumps.
const MEAL_PATTERNS = [
  { re: /\b(?:i )?(?:just |finished )?(?:ate|had) (?:breakfast|lunch|dinner|a meal)\b/i, delta: null, note: 'meal' },
  { re: /\bjust (?:ate|had) (?:breakfast|lunch|dinner)\b/i,                              delta: null, note: 'meal' },
  { re: /\b(?:eating|having) (?:breakfast|lunch|dinner|a meal)\b/i,                      delta: 80,   note: 'eating now' },
  { re: /\bi (?:just )?ate (?:a|some|the|my)?\s?\w+/i,                                    delta: 70,  note: 'ate something' },
  { re: /\b(?:i'?m|im) (?:eating|having) (?:a |some |my )?\w+/i,                          delta: 60,  note: 'eating' },
  { re: /\b(?:eating|having) (?:a |some |my )(?:sandwich|pizza|burger|salad|soup|snack|meal|breakfast|lunch|dinner|food|coffee|tea)/i, delta: 60, note: 'eating named food' },
  { re: /\b(?:had|grabbing) a snack\b/i,                                                  delta: 25,  note: 'snack' },
  { re: /\b(?:grabbing|making) (?:breakfast|lunch|dinner|food)\b/i,                       delta: 15,  note: 'planning meal' },
];

// Hunger expressions — user says they're hungry. Pull the level DOWN (or
// confirm low). For now we don't override low levels upward; instead we mark
// urgency by writing a thought and using `manualSet` to floor the level.
const HUNGER_PATTERNS = [
  /\b(?:i'?m|im|i am) (?:so |really |very |kind of |kinda )?hungry\b/i,
  /\b(?:starving|famished)\b/i,
  /\b(?:need|want) (?:some )?food\b/i,
];

function lc(s) { return (s || '').toLowerCase(); }

// ── Producers ─────────────────────────────────────────────────────────────────

/**
 * Called from screen-watcher after each vision description.
 * Weak signal: if food/drink terms appear, +10 to Nourishment (capped at 80
 * via observe → satisfy semantics).
 * @param {string} description  Vision-AI sentence (e.g. "a coffee mug next to a code editor")
 * @param {object} [refs]       Optional cross-refs for audit log
 * @returns {{ matched: string[], applied: boolean }}
 */
export function noteFoodInScreenDescription(description, refs = null) {
  if (!description || typeof description !== 'string') return { matched: [], applied: false };
  const d = lc(description);
  const matched = [];
  for (const term of FOOD_TERMS) if (d.includes(term)) matched.push(term);
  for (const term of DRINK_TERMS) if (d.includes(term)) matched.push(term);
  if (matched.length === 0) return { matched: [], applied: false };
  const userId = currentUserId();
  // Drink-only sightings (mug/coffee) give a smaller hydration-style bump than
  // food on a plate. Keep simple: any match → small nourishment observation.
  const delta = matched.some(m => FOOD_TERMS.includes(m)) ? 12 : 6;
  observe(userId, 'nourishment', {
    delta,
    source: 'screen-watcher',
    refs,
    note: `saw: ${matched.slice(0, 3).join(', ')}`,
  });
  return { matched, applied: true };
}

/**
 * Called from router.js (and any transcript ingestor) when the user speaks.
 * Strong signal: explicit meal mention → satisfy(). Hunger mention → write a
 * mind thought + floor the level so the scorer surfaces a candidate.
 *
 * @param {string} utterance
 * @param {object} [refs]
 * @returns {{ kind: 'meal'|'hunger'|null, applied: boolean }}
 */
export function noteMealMention(utterance, refs = null) {
  if (!utterance || typeof utterance !== 'string') return { kind: null, applied: false };
  const userId = currentUserId();

  for (const { re, delta, note } of MEAL_PATTERNS) {
    if (re.test(utterance)) {
      satisfy(userId, 'nourishment', {
        delta,
        source: 'router',
        refs,
        note,
      });
      try { writeThought('intuition', `Commander mentioned eating ("${utterance.slice(0, 60)}") — bumping Nourishment.`, refs, 0.4); } catch {}
      return { kind: 'meal', applied: true };
    }
  }
  for (const re of HUNGER_PATTERNS) {
    if (re.test(utterance)) {
      // Don't override stored level upward — instead let it stand low and write
      // a thought so the scorer picks Nourishment as the top candidate next tick.
      try { writeThought('intuition', `Commander said they're hungry — Nourishment is the priority.`, refs, 0.6); } catch {}
      return { kind: 'hunger', applied: true };
    }
  }
  return { kind: null, applied: false };
}
