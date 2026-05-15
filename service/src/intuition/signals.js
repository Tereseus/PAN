// Need adapters for Hydration, Rest, Social.
//
// Same shape as nourishment.js but consolidated since the patterns are
// near-identical: keyword scan on a vision/text signal → observe (weak) or
// satisfy (strong). One file because adding a fourth Need with these patterns
// is a 10-line addition, and a 13-file directory of one-pattern adapters
// would be worse than one file with a dispatch table.
//
// Producers (callers):
//   • screen-watcher.js  → noteSignalsInScreenDescription(text)
//   • router.js          → noteSignalsInUtterance(text)
//   • activity-tracker.js (future) → noteLongWorkSession(minutes) → Rest decay
//   • webcam-watcher.js (future)   → noteFacesPresent(count) → Social satisfy
//
// All weighting/decay/persistence lives in needs.js — these are pure adapters.

import { observe, satisfy } from './needs.js';
import { writeThought } from './mind.js';
import { currentUserId } from './nourishment.js';

// Re-export the identity helper so all adapters share one source of truth.
export { currentUserId };

// ── Hydration ─────────────────────────────────────────────────────────────────
// Weak signal: drinkware visible on screen ("coffee mug", "glass of water").
// Strong signal: explicit "I'm drinking water" / "having coffee" / "had a glass".
// Caveat: coffee/tea satisfy hydration but caffeine is debated — keep it simple
// for v1 and treat any drink as a hydration bump.

const DRINK_TERMS_SCREEN = [
  'coffee', 'tea', 'mug', 'water bottle', 'glass of water', 'cup of water',
  'soda', 'juice', 'smoothie', 'latte', 'espresso', 'water glass',
];

const DRINK_PATTERNS = [
  { re: /\b(?:i )?(?:just )?(?:drank|had|finished) (?:a |some |my |the )?(?:glass of water|water|coffee|tea|drink|soda|juice)\b/i, delta: 60,  note: 'drink' },
  { re: /\b(?:i'?m|im|i am) (?:drinking|having|sipping) (?:a |some |my )?(?:water|coffee|tea|smoothie|juice|soda)\b/i,                delta: 50,  note: 'drinking now' },
  { re: /\b(?:refilled?|filling|topping up) (?:my )?water\b/i,                                                                       delta: 70,  note: 'refilled water' },
  { re: /\bchugged?\b/i,                                                                                                              delta: 80,  note: 'chugged' },
];

const THIRST_PATTERNS = [
  /\b(?:i'?m|im|i am) (?:so |really |very )?thirsty\b/i,
  /\b(?:parched|dehydrated)\b/i,
];

// ── Rest ──────────────────────────────────────────────────────────────────────
// Weak signal: long continuous work session (>2h coding without break) — drains
// Rest faster. Strong signal: "I just napped" / "slept well".
// Yawn / tired keywords from utterance → write a Mind thought (don't override
// stored level upward — like hunger handling).

const REST_PATTERNS = [
  { re: /\b(?:i )?(?:just )?(?:slept|napped|woke up) (?:for )?\w*\s?(?:well|good|fine|great|hours?|minutes?)?/i, delta: null, note: 'slept' },
  { re: /\b(?:took|had) (?:a )?(?:nap|break|rest|breather)\b/i,                                                  delta: 50,   note: 'rested' },
  { re: /\b(?:stepping|going) (?:away|afk|outside)(?:\s+for\s+a\s+bit)?\b/i,                                     delta: 30,   note: 'break' },
];

const TIRED_PATTERNS = [
  /\b(?:i'?m|im|i am) (?:so |really |very |kinda |kind of )?(?:tired|exhausted|burnt out|wiped|drained|sleepy)\b/i,
  /\b(?:can'?t|cannot) keep (?:my )?eyes open\b/i,
  /\byawning\b/i,
];

// ── Social ────────────────────────────────────────────────────────────────────
// Strong signal: "I called X" / "had a meeting" / "talked to Y" → satisfy.
// Weak signal (future): face-count > 1 on webcam → other person present.

const SOCIAL_PATTERNS = [
  { re: /\b(?:i )?(?:just )?(?:called|phoned|spoke (?:to|with)|talked (?:to|with)|met (?:with|up with)|hung out with) /i, delta: 60, note: 'spoke' },
  { re: /\b(?:on a |in a |finishing a |finished a |had a )?(?:call|meeting|chat|conversation) (?:with )?/i,               delta: 40, note: 'call/meeting' },
  { re: /\b(?:texting|messaging|chatting with) /i,                                                                          delta: 20, note: 'messaging' },
];

const LONELY_PATTERNS = [
  /\b(?:i'?m|im|i am) (?:so |really |a bit |kinda |kind of )?(?:lonely|isolated|by myself)\b/i,
  /\bnobody to (?:talk|chat) to\b/i,
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function lc(s) { return (s || '').toLowerCase(); }

function matchPatterns(text, patterns) {
  for (const p of patterns) {
    if (p.re.test(text)) return p;
  }
  return null;
}

// ── Producers ─────────────────────────────────────────────────────────────────

/**
 * Screen-watcher pass — scan a vision description for drink presence.
 * Returns { hydration: bool, ... } for caller logging. Other "screen-side"
 * needs (Rest, Social) don't have reliable visual proxies, so this only
 * touches Hydration.
 */
export function noteSignalsInScreenDescription(description, refs = null) {
  if (!description || typeof description !== 'string') return { applied: [] };
  const d = lc(description);
  const applied = [];
  const userId = currentUserId();
  // Hydration: drinkware in view
  const drinkHit = DRINK_TERMS_SCREEN.find(t => d.includes(t));
  if (drinkHit) {
    observe(userId, 'hydration', { delta: 8, source: 'screen-watcher', refs, note: `saw: ${drinkHit}` });
    applied.push({ need: 'hydration', term: drinkHit });
  }
  return { applied };
}

/**
 * Router pass — scan an utterance for ALL need-related phrases. Cheap regex,
 * fails silently on no match. Returns array of applied actions for logging.
 */
export function noteSignalsInUtterance(utterance, refs = null) {
  if (!utterance || typeof utterance !== 'string') return { applied: [] };
  const userId = currentUserId();
  const applied = [];

  // Hydration ─────────────────────────────
  const drink = matchPatterns(utterance, DRINK_PATTERNS);
  if (drink) {
    satisfy(userId, 'hydration', { delta: drink.delta, source: 'router', refs, note: drink.note });
    applied.push({ need: 'hydration', kind: 'satisfy', note: drink.note });
  } else if (matchPatterns(utterance, THIRST_PATTERNS.map(re => ({ re })))) {
    try { writeThought('intuition', `Commander said they're thirsty — Hydration is the priority.`, refs, 0.5); } catch {}
    applied.push({ need: 'hydration', kind: 'thirst-signal' });
  }

  // Rest ──────────────────────────────────
  const rest = matchPatterns(utterance, REST_PATTERNS);
  if (rest) {
    satisfy(userId, 'rest', { delta: rest.delta, source: 'router', refs, note: rest.note });
    applied.push({ need: 'rest', kind: 'satisfy', note: rest.note });
  } else if (matchPatterns(utterance, TIRED_PATTERNS.map(re => ({ re })))) {
    try { writeThought('intuition', `Commander said they're tired — Rest is the priority.`, refs, 0.6); } catch {}
    applied.push({ need: 'rest', kind: 'tired-signal' });
  }

  // Social ────────────────────────────────
  const social = matchPatterns(utterance, SOCIAL_PATTERNS);
  if (social) {
    satisfy(userId, 'social', { delta: social.delta, source: 'router', refs, note: social.note });
    applied.push({ need: 'social', kind: 'satisfy', note: social.note });
  } else if (matchPatterns(utterance, LONELY_PATTERNS.map(re => ({ re })))) {
    try { writeThought('intuition', `Commander expressed loneliness — Connection is the priority.`, refs, 0.6); } catch {}
    applied.push({ need: 'social', kind: 'lonely-signal' });
  }

  return { applied };
}

/**
 * Activity-tracker / external caller: report a continuous focus session
 * (minutes spent on the same foreground app without a break). After ~120min
 * of unbroken work, Rest takes an extra hit.
 */
export function noteLongFocusSession(minutes, refs = null) {
  if (!minutes || minutes < 120) return { applied: false };
  const userId = currentUserId();
  // Rest decay is ~6/h baseline; +12 hit for crossing the 2h mark, capped by
  // observe's natural ceiling (no level inflation, just an explicit drop via
  // negative delta on observe).
  observe(userId, 'rest', { delta: -12, source: 'activity-tracker', refs, note: `${minutes}m focus session` });
  return { applied: true };
}

/**
 * Webcam: another face present in frame → Social satisfy (mild).
 */
export function noteOtherFacePresent(refs = null) {
  const userId = currentUserId();
  observe(userId, 'social', { delta: 10, source: 'webcam', refs, note: 'another face in frame' });
  return { applied: true };
}
