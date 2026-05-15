// PAN's stream of consciousness — first-person reasoning trace.
//
// Modeled on Claude's extended-thinking blocks. Each reasoning event in PAN
// (intuition verdict, screen description, router decision, scout finding,
// interjection deliberation) calls `writeThought()` with ONE short first-person
// sentence describing what PAN concluded. The dashboard's "PAN's Mind" panel
// renders the stream verbatim, and PAN itself can read its own thoughts back
// via the `pan_thoughts` MCP tool.
//
// Why this exists:
//   • The old "What PAN's mind is busy with" feed showed raw `ai_usage` rows
//     (caller + system prompt). That's useless — every intuition-classifier
//     call has the SAME system prompt; the interesting bit is the conclusion.
//   • This module is the layer where verdicts get phrased in first person and
//     persisted in their own table, separate from billing telemetry.
//
// Usage:
//   import { writeThought, recentThoughts } from './thoughts.js';
//   writeThought('intuition', "Commander seems focused on Svelte — mood normal, no need to interject.", { ai_usage_id: lastId });

import { run, all } from '../db.js';

const VALID_SOURCES = new Set([
  'intuition', 'screen', 'scout', 'router', 'interjection',
  'dream', 'manual', 'evolution', 'consolidation', 'task',
]);

const MAX_THOUGHT_LEN = 240;

/**
 * Format a wall-clock millisecond timestamp as a SQLite-friendly LOCAL-time
 * string (`YYYY-MM-DD HH:MM:SS`). We use this because pan_thoughts.ts is
 * inserted with `datetime('now','localtime')` — comparing against
 * `Date.toISOString()` (UTC) would shift the cutoff by the local UTC offset
 * and break dedupe / "since" filters. Fixes nightmare-class dedupe bug where
 * 60s-apart identical thoughts slipped through a 90s window.
 */
function localIsoFromMs(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' +
    pad(d.getMonth() + 1) + '-' +
    pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' +
    pad(d.getMinutes()) + ':' +
    pad(d.getSeconds())
  );
}

/**
 * Write a single first-person thought into the stream.
 * @param {string} source  One of: intuition | screen | scout | router | interjection | dream | manual | evolution | consolidation | task
 * @param {string} thought First-person sentence (<=240 chars). Will be trimmed + truncated.
 * @param {object} [refs]  Optional cross-references: { ai_usage_id, event_id, session_id, finding_id, ... }
 * @param {number} [importance] 0..1, default 0.5
 * @returns {number|null} The inserted row id, or null on failure.
 */
export function writeThought(source, thought, refs = null, importance = 0.5) {
  try {
    if (!source || !VALID_SOURCES.has(source)) {
      console.warn(`[Thoughts] Unknown source "${source}" — accepting anyway`);
    }
    if (typeof thought !== 'string') return null;
    const trimmed = thought.trim();
    if (trimmed.length < 3) return null;
    const text = trimmed.length > MAX_THOUGHT_LEN
      ? trimmed.slice(0, MAX_THOUGHT_LEN - 1) + '…'
      : trimmed;
    const refsJson = refs && typeof refs === 'object' ? JSON.stringify(refs) : null;
    const imp = Math.max(0, Math.min(1, Number(importance) || 0.5));
    const result = run(
      `INSERT INTO pan_thoughts (source, thought, refs_json, importance)
       VALUES (:source, :thought, :refs, :imp)`,
      { ':source': source, ':thought': text, ':refs': refsJson, ':imp': imp }
    );
    return result?.lastInsertRowid ?? null;
  } catch (e) {
    console.error('[Thoughts] write failed:', e.message);
    return null;
  }
}

/**
 * Read the most recent thoughts in reverse-chronological order.
 * @param {object} [opts]
 * @param {number} [opts.limit=20]    Max rows (capped at 200).
 * @param {string} [opts.source]      Filter to one source.
 * @param {number} [opts.sinceMs]     Only thoughts newer than this many ms ago.
 * @returns {Array<{id, ts, source, thought, refs_json, importance}>}
 */
export function recentThoughts(opts = {}) {
  try {
    const limit = Math.max(1, Math.min(200, parseInt(opts.limit) || 20));
    const params = {};
    let where = '1=1';
    if (opts.source && VALID_SOURCES.has(opts.source)) {
      where += ' AND source = :src';
      params[':src'] = opts.source;
    }
    if (opts.sinceMs && Number.isFinite(opts.sinceMs) && opts.sinceMs > 0) {
      // pan_thoughts.ts is stored as localtime via SQLite default
      // (datetime('now','localtime')). toISOString() returns UTC, so we'd be
      // comparing the wrong frame and could under- or over-include. Build a
      // localtime ISO-ish string instead. Bug found: identical screen thoughts
      // 60s apart weren't being deduped despite a 90s window.
      const cutoff = localIsoFromMs(Date.now() - opts.sinceMs);
      where += ' AND ts >= :cutoff';
      params[':cutoff'] = cutoff;
    }
    return all(
      `SELECT id, ts, source, thought, refs_json, importance
       FROM pan_thoughts
       WHERE ${where}
       ORDER BY id DESC
       LIMIT ${limit}`,
      params
    );
  } catch (e) {
    console.error('[Thoughts] read failed:', e.message);
    return [];
  }
}

/**
 * Read just the most recent thought for a given source. Used by producers to
 * compute a delta ("focus shifted A → B") and to suppress consecutive
 * identical verdicts.
 */
export function lastThoughtFor(source) {
  try {
    const rows = all(
      `SELECT id, ts, source, thought, refs_json, importance
       FROM pan_thoughts WHERE source = :s
       ORDER BY id DESC LIMIT 1`,
      { ':s': source }
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

/**
 * Quick check used by dashboard to suppress duplicates: did we just write a
 * very similar thought from the same source within the last N seconds?
 * Useful for screen-watcher which can produce nearly-identical descriptions
 * frame to frame.
 */
export function recentThoughtMatches(source, thought, withinMs = 90_000) {
  try {
    // See note in recentThoughts() — DB stores localtime, so cutoff must match.
    const cutoff = localIsoFromMs(Date.now() - withinMs);
    const rows = all(
      `SELECT thought FROM pan_thoughts
       WHERE source = :src AND ts >= :cutoff
       ORDER BY id DESC LIMIT 5`,
      { ':src': source, ':cutoff': cutoff }
    );
    const candidate = (thought || '').trim().toLowerCase();
    if (candidate.length < 8) return false;
    for (const r of rows) {
      const t = (r.thought || '').trim().toLowerCase();
      if (t === candidate) return true;
      // crude similarity — if 80%+ of words overlap, treat as dup
      const a = new Set(t.split(/\s+/).filter(w => w.length > 3));
      const b = new Set(candidate.split(/\s+/).filter(w => w.length > 3));
      if (a.size === 0 || b.size === 0) continue;
      let overlap = 0;
      for (const w of b) if (a.has(w)) overlap++;
      if (overlap / b.size >= 0.8) return true;
    }
    return false;
  } catch {
    return false;
  }
}
