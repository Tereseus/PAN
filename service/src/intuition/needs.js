// PAN's Life Needs engine — Sims-style motive bars (0..100) per user.
//
// Model:
//   • Each Need is a 0..100 level. 100 = fully satisfied, 0 = critical.
//   • Decay is linear: level -= decay_rate × hours_since_last_event (computed on
//     read; we don't run a timer — we recompute on demand from append-only
//     pan_need_events).
//   • "Satisfy" events reset / raise the level (a meal raises Nourishment to ~100,
//     a snack raises it +25, etc).
//   • Per-user weight (0..2) scales urgency. Learned over time from accept/dismiss
//     feedback on need-driven interjections. (Reject a "you should eat" nudge
//     three times → weight drops, threshold rises.)
//
// API contract for the rest of intuition/:
//   evaluate(userId)              → [{ need_id, level, weight, urgency, ... }]
//   satisfy(userId, needId, opts) → record a satisfy event, return new level
//   observe(userId, needId, opts) → record sensor evidence (smaller delta than satisfy)
//   manualSet(userId, needId, lv) → dashboard override
//   getDefinition(needId)         → static metadata (default decay, label, icon)
//
// The Action engine ("intuition/scorer.js" — pending) reads `evaluate()` output
// and turns urgency × weight × precondition into candidate interjections.

import { run, get, all } from '../db.js';

// === Static Need definitions ===
// decay_rate is points lost per hour from a "satisfied" peak.
// stale_after_hours = once it's been this long since the last event, the bar's
//   numeric value can no longer be trusted (we still show it, but flag stale).
// hint = the short prompt shown when this need has never been observed for a
//   user (task #492: "not tracked yet · upload a meal photo").
//
// Removed in #492: connection, curiosity, admin — they were vague placeholders
// that nothing in the codebase ever satisfied, so they decayed to zero on a
// timer with no real signal behind them.
//
// Defaults are intentionally rough — they'll be refined per-user via the
// learning loop. Numbers picked so a typical 16h waking day exercises the bar
// across its visible range without bottoming out instantly.
export const NEED_DEFS = Object.freeze({
  nourishment:    { label: 'Nourishment',     icon: '🍽',  decay_rate: 15, default_weight: 1.0, group: 'body',  stale_after_hours: 12, hint: 'upload a meal photo' },
  hydration:      { label: 'Hydration',       icon: '💧',  decay_rate: 25, default_weight: 1.0, group: 'body',  stale_after_hours: 6,  hint: 'log a drink' },
  rest:           { label: 'Rest',            icon: '😴',  decay_rate: 6,  default_weight: 1.0, group: 'body',  stale_after_hours: 36, hint: 'needs sleep tracking' },
  health_physical:{ label: 'Body movement',   icon: '🏃',  decay_rate: 4,  default_weight: 0.8, group: 'body',  stale_after_hours: 48, hint: 'needs step / movement data' },
  health_mental:  { label: 'Mental health',   icon: '🧘',  decay_rate: 3,  default_weight: 1.0, group: 'mind',  stale_after_hours: 48, hint: 'needs mood check-in' },
  social:         { label: 'Social',          icon: '👥',  decay_rate: 5,  default_weight: 0.8, group: 'mind',  stale_after_hours: 96, hint: 'no social events logged' },
  focus:          { label: 'Focus',           icon: '🎯',  decay_rate: 8,  default_weight: 1.0, group: 'mind',  stale_after_hours: 4,  hint: 'no active task to focus on' },
  fun:            { label: 'Fun',             icon: '🎮',  decay_rate: 5,  default_weight: 0.8, group: 'mind',  stale_after_hours: 72, hint: 'no leisure events logged' },
  environment:    { label: 'Environment',     icon: '🪴',  decay_rate: 3,  default_weight: 0.6, group: 'world', stale_after_hours: 24, hint: 'no environmental sensor data' },
  safety:         { label: 'Safety',          icon: '🛡',  decay_rate: 2,  default_weight: 1.0, group: 'world', stale_after_hours: 168, hint: 'no safety events — event-driven only' },
});

export const NEED_IDS = Object.keys(NEED_DEFS);

export function getDefinition(needId) {
  return NEED_DEFS[needId] || null;
}

// === Internal helpers ===

function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function hoursBetween(aIso, bIso) {
  if (!aIso || !bIso) return 0;
  // Treat stored timestamps as localtime (matches schema default datetime('now','localtime')).
  const a = Date.parse(aIso.replace(' ', 'T'));
  const b = Date.parse(bIso.replace(' ', 'T'));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, (b - a) / 3_600_000);
}

function clamp(n, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Ensure a pan_needs row exists for (user, need). Returns the row.
 * Creates with default weight/decay from NEED_DEFS if missing.
 */
function ensureRow(userId, needId) {
  if (!NEED_DEFS[needId]) throw new Error(`Unknown need_id: ${needId}`);
  let row = get(
    `SELECT * FROM pan_needs WHERE user_id = :u AND need_id = :n`,
    { ':u': userId, ':n': needId }
  );
  if (!row) {
    const def = NEED_DEFS[needId];
    run(
      `INSERT INTO pan_needs (user_id, need_id, level, weight, decay_rate, last_evaluated_at)
       VALUES (:u, :n, 100, :w, :d, :t)`,
      { ':u': userId, ':n': needId, ':w': def.default_weight, ':d': def.decay_rate, ':t': nowIso() }
    );
    row = get(
      `SELECT * FROM pan_needs WHERE user_id = :u AND need_id = :n`,
      { ':u': userId, ':n': needId }
    );
  }
  return row;
}

/**
 * Compute the current decayed level for a stored row without writing.
 * level = max(0, stored.level - decay_rate × hours_since_last_evaluated)
 */
function decayedLevel(row, asOfIso = nowIso()) {
  const hours = hoursBetween(row.last_evaluated_at, asOfIso);
  return clamp(row.level - row.decay_rate * hours);
}

// === Public API ===

/**
 * Format an "X ago" string from an hours-delta. `<1h` collapses to minutes.
 */
function agoString(hours) {
  if (hours == null || !Number.isFinite(hours)) return 'unknown';
  if (hours < 1) {
    const mins = Math.max(1, Math.round(hours * 60));
    return `${mins}m ago`;
  }
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Evaluate ALL needs for a user. Returns array of (per task #492 — event-first
 * model, not pure time-decay):
 *   {
 *     need_id, label, icon, group,
 *     tracked,                  // false → this need has never been observed
 *     level,                    // null when !tracked; otherwise 0..100
 *     weight, decay_rate, urgency,
 *     cause,                    // short string: "ate 2h ago", "last meal 47h ago — stale"
 *     hint,                     // when !tracked: prompt to onboard the signal
 *     stale,                    // true when last event > stale_after_hours
 *     last_satisfied_at,        // schema field, may be null
 *     hours_since_satisfied,
 *   }
 *
 * `urgency` = (100 - level) / 100 × weight  → 0..2, scored only when tracked.
 *
 * Decay is APPLIED ONLY when there is at least one pan_need_events row for
 * this user×need. A need with zero events is treated as "no signal" — no
 * decay, no level, no urgency. The user can't be hungry on a bar that never
 * saw a meal. (Task #492 — Theresa's "you can't just say zero" rule.)
 *
 * Side-effect: persists the freshly-decayed `level` + bumps `last_evaluated_at`
 * only for tracked needs.
 */
export function evaluate(userId) {
  if (!userId) return [];
  const ts = nowIso();
  const out = [];
  for (const needId of NEED_IDS) {
    const row = ensureRow(userId, needId);
    const def = NEED_DEFS[needId];

    // Most-recent event of any kind. Null = never tracked.
    // Column is `ts` (per schema.sql:368), not `created_at`.
    const lastEvent = get(
      `SELECT kind, level_after, source, note, ts
       FROM pan_need_events
       WHERE user_id = :u AND need_id = :n
       ORDER BY id DESC LIMIT 1`,
      { ':u': userId, ':n': needId }
    );

    if (!lastEvent) {
      // No signal ever. Don't decay. Don't fabricate urgency.
      out.push({
        need_id: needId,
        label: def.label,
        icon: def.icon,
        group: def.group,
        tracked: false,
        level: null,
        weight: row.weight,
        decay_rate: row.decay_rate,
        urgency: 0,
        cause: 'not tracked yet',
        hint: def.hint || null,
        stale: false,
        last_satisfied_at: null,
        hours_since_satisfied: null,
      });
      continue;
    }

    // Tracked — decay from the last event's level using the time since then.
    const hoursSinceEvent = hoursBetween(lastEvent.ts, ts);
    const startLevel = (typeof lastEvent.level_after === 'number')
      ? lastEvent.level_after
      : row.level;
    const level = clamp(startLevel - row.decay_rate * hoursSinceEvent);

    // Persist decayed value so legacy consumers reading pan_needs.level stay
    // consistent with what we return here.
    run(
      `UPDATE pan_needs SET level = :lv, last_evaluated_at = :t
       WHERE user_id = :u AND need_id = :n`,
      { ':lv': level, ':t': ts, ':u': userId, ':n': needId }
    );

    const staleAfter = def.stale_after_hours || 24;
    const stale = hoursSinceEvent > staleAfter;
    const verb = lastEvent.kind === 'satisfy' ? 'satisfied'
               : lastEvent.kind === 'observe' ? 'observed'
               : lastEvent.kind === 'manual'  ? 'set manually'
               : lastEvent.kind;
    const ago = agoString(hoursSinceEvent);
    const noteBit = lastEvent.note ? ` (${lastEvent.note})` : '';
    const cause = stale
      ? `${verb} ${ago}${noteBit} — stale, can't trust this value`
      : `${verb} ${ago}${noteBit}`;

    const urgency = ((100 - level) / 100) * row.weight;
    const hoursSat = row.last_satisfied_at ? hoursBetween(row.last_satisfied_at, ts) : null;

    out.push({
      need_id: needId,
      label: def.label,
      icon: def.icon,
      group: def.group,
      tracked: true,
      level: Math.round(level * 10) / 10,
      weight: row.weight,
      decay_rate: row.decay_rate,
      urgency: Math.round(urgency * 1000) / 1000,
      cause,
      hint: null,
      stale,
      last_satisfied_at: row.last_satisfied_at,
      hours_since_satisfied: hoursSat == null ? null : Math.round(hoursSat * 10) / 10,
    });
  }
  // Sort: tracked-and-urgent first, untracked at the bottom (they have no
  // urgency signal to compete on).
  out.sort((a, b) => {
    if (a.tracked !== b.tracked) return a.tracked ? -1 : 1;
    return b.urgency - a.urgency;
  });
  return out;
}

/**
 * Record a "satisfy" event — a meal, a nap, a social call, etc.
 * Default delta = full reset to 100. Pass `delta` for partial bumps
 * (snack = +25, short break = +20).
 *
 * @param {string} userId
 * @param {string} needId
 * @param {object} [opts]
 * @param {number} [opts.delta]   Points to add. If absent → reset to 100.
 * @param {number} [opts.toLevel] Force exact level (e.g. 100 for full meal). Wins over delta.
 * @param {string} [opts.source]  'router' | 'screen-watcher' | 'webcam' | 'manual' | 'transcript'
 * @param {object} [opts.refs]    { ai_usage_id, event_id, session_id }
 * @param {string} [opts.note]    Free-form ("ate pizza", "took 20m nap")
 * @returns {{ level: number, delta: number }}
 */
export function satisfy(userId, needId, opts = {}) {
  if (!userId || !NEED_DEFS[needId]) return null;
  const row = ensureRow(userId, needId);
  const ts = nowIso();
  const before = decayedLevel(row, ts);
  let after;
  if (typeof opts.toLevel === 'number') after = clamp(opts.toLevel);
  else if (typeof opts.delta === 'number') after = clamp(before + opts.delta);
  else after = 100;
  const delta = after - before;
  run(
    `UPDATE pan_needs
     SET level = :lv, last_satisfied_at = :t, last_evaluated_at = :t
     WHERE user_id = :u AND need_id = :n`,
    { ':lv': after, ':t': ts, ':u': userId, ':n': needId }
  );
  run(
    `INSERT INTO pan_need_events (user_id, need_id, kind, delta, level_after, source, refs_json, note)
     VALUES (:u, :n, 'satisfy', :d, :a, :s, :r, :note)`,
    {
      ':u': userId, ':n': needId,
      ':d': delta, ':a': after,
      ':s': opts.source || null,
      ':r': opts.refs ? JSON.stringify(opts.refs) : null,
      ':note': opts.note || '',
    }
  );
  return { level: after, delta };
}

/**
 * Record sensor "observe" evidence — weaker than satisfy (food seen on screen
 * but not confirmed eaten, yawn detected but not confirmed nap). Default delta
 * is small (+15) and capped, so repeated observations don't game the level.
 */
export function observe(userId, needId, opts = {}) {
  if (!userId || !NEED_DEFS[needId]) return null;
  const row = ensureRow(userId, needId);
  const ts = nowIso();
  const before = decayedLevel(row, ts);
  const delta = typeof opts.delta === 'number' ? opts.delta : 15;
  const after = clamp(before + delta);
  run(
    `UPDATE pan_needs
     SET level = :lv, last_evaluated_at = :t
     WHERE user_id = :u AND need_id = :n`,
    { ':lv': after, ':t': ts, ':u': userId, ':n': needId }
  );
  run(
    `INSERT INTO pan_need_events (user_id, need_id, kind, delta, level_after, source, refs_json, note)
     VALUES (:u, :n, 'observe', :d, :a, :s, :r, :note)`,
    {
      ':u': userId, ':n': needId,
      ':d': after - before, ':a': after,
      ':s': opts.source || null,
      ':r': opts.refs ? JSON.stringify(opts.refs) : null,
      ':note': opts.note || '',
    }
  );
  return { level: after, delta: after - before };
}

/**
 * Dashboard / API override. Sets level directly, logs as 'manual'.
 */
export function manualSet(userId, needId, level, opts = {}) {
  if (!userId || !NEED_DEFS[needId]) return null;
  const row = ensureRow(userId, needId);
  const ts = nowIso();
  const before = decayedLevel(row, ts);
  const after = clamp(level);
  run(
    `UPDATE pan_needs
     SET level = :lv, last_evaluated_at = :t
     WHERE user_id = :u AND need_id = :n`,
    { ':lv': after, ':t': ts, ':u': userId, ':n': needId }
  );
  run(
    `INSERT INTO pan_need_events (user_id, need_id, kind, delta, level_after, source, note)
     VALUES (:u, :n, 'manual', :d, :a, :s, :note)`,
    {
      ':u': userId, ':n': needId,
      ':d': after - before, ':a': after,
      ':s': opts.source || 'dashboard',
      ':note': opts.note || '',
    }
  );
  return { level: after, delta: after - before };
}

/**
 * Adjust per-user weight (called by the learning loop: dismissals raise threshold
 * implicitly by LOWERING weight; "thank you" responses RAISE weight).
 * Clamped to [0, 2].
 */
export function adjustWeight(userId, needId, deltaWeight) {
  if (!userId || !NEED_DEFS[needId]) return null;
  const row = ensureRow(userId, needId);
  const next = Math.max(0, Math.min(2, row.weight + deltaWeight));
  run(
    `UPDATE pan_needs SET weight = :w WHERE user_id = :u AND need_id = :n`,
    { ':w': next, ':u': userId, ':n': needId }
  );
  return next;
}

/**
 * Recent need events for a user (audit trail / dashboard timeline).
 */
export function recentEvents(userId, { limit = 20, needId = null } = {}) {
  const lim = Math.max(1, Math.min(200, parseInt(limit) || 20));
  if (needId) {
    return all(
      `SELECT * FROM pan_need_events
       WHERE user_id = :u AND need_id = :n
       ORDER BY id DESC LIMIT ${lim}`,
      { ':u': userId, ':n': needId }
    );
  }
  return all(
    `SELECT * FROM pan_need_events
     WHERE user_id = :u
     ORDER BY id DESC LIMIT ${lim}`,
    { ':u': userId }
  );
}
