// Event-type filters — pure machine telemetry that has no value as searchable
// memory. Introduced 2026-07-14 after a prune found ~257k telemetry rows (heartbeats,
// tool hooks, session/swap markers, process bookkeeping) bloating the DB and wasting
// hours of embedding time.
//
// NEVER_STORE: dropped at the logEvent chokepoint — never written to `events` at all.
//   ONLY types that nothing in the codebase reads (verified by grep) go here, so
//   dropping them can't break any feature.
//
// NEVER_EMBED: superset — never vectorized. Includes NEVER_STORE plus (a) telemetry
//   that IS read by a feature (so it must still be stored, just not embedded) and
//   (b) watcher/hook events that bypass logEvent and are only ever picked up by the
//   backfill. screen_context is intentionally NOT here — the user keeps it searchable.

export const NEVER_STORE = new Set([
  'PtyExit', 'craft_swap', 'craft_swap_live', 'WrapHeartbeat',
  'PermissionRequest', 'ai_fallback_attempt', 'SmartStewardAction',
]);

export const NEVER_EMBED = new Set([
  ...NEVER_STORE,
  'StewardHeartbeat', 'webcam_context', 'PreToolUse', 'PostToolUse',
  'StewardAction', 'Stop', 'SessionEnd', 'ClientRestartAttempt',
  'EvolutionCycle', 'ConsolidationRun',
]);

// SQL fragment for the backfill fetch query: a comma-separated quoted list.
export const NEVER_EMBED_SQL = [...NEVER_EMBED].map(t => `'${t}'`).join(',');
