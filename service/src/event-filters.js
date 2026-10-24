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
  // Added 2026-08-29. 68,918 rows, 24% of the whole DB, and nothing reads them:
  // grep finds only tests.js POSTing one and a comment in terminal.js. No query,
  // no feature, no panel. They were never embedded either, so this is pure loss.
  'PostToolUse',
]);

export const NEVER_EMBED = new Set([
  ...NEVER_STORE,
  'StewardHeartbeat', 'webcam_context', 'PreToolUse', 'PostToolUse',
  'StewardAction', 'Stop', 'SessionEnd', 'ClientRestartAttempt',
  'EvolutionCycle', 'ConsolidationRun',
]);

// SQL fragment for the backfill fetch query: a comma-separated quoted list.
export const NEVER_EMBED_SQL = [...NEVER_EMBED].map(t => `'${t}'`).join(',');

// PreToolUse is the other half of the tool-hook flood (70,345 rows) and it can
// NOT be dropped wholesale, because session-summary.js reads it for the two
// things "ΠΑΝ Remembers" is built from:
//   getCompletedTodos -> tool_name = 'TodoWrite'
//   getFilesTouched   -> tool_name IN (Edit, Write, NotebookEdit, MultiEdit)
// Every other PreToolUse row (Bash, Read, Grep, Task, MCP calls) is written once
// and never read again. Keep the five that matter; drop the rest.
export const PRETOOLUSE_KEEP = new Set([
  'TodoWrite', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit',
]);

// THE decision point for whether an event is worth a row.
//
// Read this before adding a caller: routes/hooks.js does NOT go through
// logEvent -- it inserts straight into `events`. That bypass is why NEVER_STORE
// sat here since 2026-07-14 while 139,263 tool-hook rows piled up anyway. Any
// write path that skips logEvent must call this itself or the filter is inert.
export function shouldStoreEvent(eventType, payload) {
  if (NEVER_STORE.has(eventType)) return false;
  if (eventType === 'PreToolUse') {
    const tool = payload?.tool_name;
    // Missing tool_name means a malformed payload, not a known-junk one; keep it
    // rather than silently widening the drop.
    return !tool || PRETOOLUSE_KEEP.has(tool);
  }
  return true;
}
