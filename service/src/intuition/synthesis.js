// PAN's-Mind synthesis — thin compatibility shim over the reasoning_steps
// substrate (task #495).
//
// Pre-#495 this module made a single prose LLM call and returned a
// paragraph with no structure behind it. The user (correctly) pointed
// out that prose without refs is narration, not thought. The actual
// thinking now happens in `./reasoning.js` (typed steps + refs +
// causal chains); this module just exposes a cached `generate()` /
// `peek()` API for the dashboard widget so we don't have to touch
// every caller at once.
//
// What the widget gets back (unchanged shape so the Svelte side keeps
// working):
//   {
//     synthesis,        // rendered first-person paragraph
//     generated_at,     // ISO string of cycle ts
//     generated_at_ms,  // epoch ms
//     sources_used,     // ['thoughts','snapshot','steps','motives']
//     model,            // model used for this cycle (or null)
//     cached,           // true if returned from in-process cache
//     cycle_id,         // NEW: db id of the cycle that produced this
//     steps,            // NEW: structured step records (subject/predicate/
//                       //      value/conf/refs/parents) — the substrate
//   }
//
// Caching:
//   3-minute per-user TTL with in-flight dedup, same as before.
//   `force: true` bypasses cache and forces a fresh reasoning cycle.
//
// On boot, the cache is empty; first call triggers a cycle.

import { runCycle, latestParagraph, getCycle } from './reasoning.js';

const CACHE_TTL_MS = 3 * 60 * 1000;
const _cache = new Map();
const _inflight = new Map();

/**
 * Generate (or return cached) synthesis for a user. Triggers a full
 * reasoning cycle on miss — the cycle writes typed steps to the DB and
 * returns a rendered paragraph.
 */
export async function generate(userId, { force = false, trigger = 'manual' } = {}) {
  const key = userId || '__default__';
  const now = Date.now();

  // In-memory cache hit.
  const cached = _cache.get(key);
  if (cached && !force && (now - cached.generated_at_ms) < CACHE_TTL_MS) {
    return { ...cached, cached: true };
  }

  // Also check the DB for a recent cycle — if the carrier restarted but
  // a cycle ran within the TTL, reuse that instead of paying for a new
  // LLM call. This makes synthesis survive craft swaps cheaply.
  if (!force) {
    try {
      const recent = latestParagraph(userId);
      if (recent && (now - recent.ts) < CACHE_TTL_MS) {
        const fromDb = await hydrateCycle(recent);
        _cache.set(key, fromDb);
        return { ...fromDb, cached: true };
      }
    } catch {}
  }

  // Single-flight on (user, force=false). Forced calls bypass dedup so
  // an explicit "refresh" button always re-runs.
  if (!force && _inflight.has(key)) return _inflight.get(key);

  const job = (async () => {
    const result = await runCycle({ userId, trigger });
    const payload = {
      synthesis: result.paragraph,
      generated_at: new Date(now).toISOString(),
      generated_at_ms: now,
      sources_used: result.sources_used || [],
      model: result.model || null,
      cached: false,
      cycle_id: result.cycle_id || null,
      steps: result.steps || [],
      ok: result.ok !== false,
      renderer: result.renderer || 'unknown',  // 'llm' | 'deterministic' | 'unknown'
      latency_ms: result.latency_ms || 0,
    };
    if (result.error) payload.error = result.error;
    _cache.set(key, payload);
    return payload;
  })();

  if (!force) _inflight.set(key, job);
  try {
    return await job;
  } finally {
    if (!force) _inflight.delete(key);
  }
}

/** Cheap inspector — returns the cached entry or null. */
export function peek(userId) {
  const key = userId || '__default__';
  return _cache.get(key) || null;
}

// Hydrate a cycle row from the DB into the same shape as a fresh generate().
async function hydrateCycle(cycleRow) {
  const out = {
    synthesis: cycleRow.paragraph || '',
    generated_at: new Date(cycleRow.ts).toISOString(),
    generated_at_ms: cycleRow.ts,
    sources_used: Array.isArray(cycleRow.sources_used) ? cycleRow.sources_used : [],
    model: cycleRow.model || null,
    cached: false,
    cycle_id: cycleRow.id,
    steps: [],
    ok: !!cycleRow.ok,
  };
  try {
    const full = getCycle(cycleRow.id);
    if (full && Array.isArray(full.steps)) out.steps = full.steps;
  } catch {}
  return out;
}
