// PAN Hybrid Memory Search
//
// Combines SQLite FTS5 (lexical) with sqlite-vec (semantic vector search)
// over the events table, then fuses the two ranked lists with Reciprocal
// Rank Fusion (RRF). This is the same recipe production RAG systems use.
//
// FTS5 catches exact matches: names, IDs, file paths, "did I ever say X".
// Vector search catches meaning: "find conversations LIKE this one".
// Neither covers both. Both together = production hybrid retrieval.
//
// Scoping: every call accepts a `scope` parameter that's resolved through
// db-registry.js. Today only `main` exists. Tomorrow `incognito`, `org-*`,
// `phone-*`, etc. will plug in with zero changes here.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sqliteVec = require('sqlite-vec');

import { getDb } from './db-registry.js';
import { embed, toBlob, EMBED_DIM } from './memory/embeddings.js';
import { privatizeSearch } from './privacy.js';

// Track which DB handles already have the vec extension loaded + tables
// initialized. Loading the extension twice is harmless but slow; the table
// creation is idempotent. We cache the init so search calls are cheap.
const initialized = new WeakSet();

/**
 * Idempotent: load sqlite-vec into this DB handle and ensure the
 * event_embeddings vec0 virtual table exists. Safe to call repeatedly.
 */
function ensureInitialized(db) {
  if (initialized.has(db)) return;
  try {
    sqliteVec.load(db);
  } catch (err) {
    // Already loaded for this connection — extensions can throw on re-load.
    if (!/already loaded|already exists/i.test(err.message)) throw err;
  }
  // vec0 virtual table — one row per event, embedding stored as float[3072].
  // We DON'T use FOREIGN KEY here because vec0 doesn't support it; we instead
  // clean orphans on a periodic sweep (or by trigger) below.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS event_embeddings USING vec0(
    embedding float[${EMBED_DIM}]
  )`);
  initialized.add(db);
}

/**
 * Pull the searchable text out of an event row. Mirrors what `extractEventText`
 * does in db.js but kept here so memory-search can be self-contained.
 */
function eventText(row) {
  if (!row) return '';
  const data = row.data || '';
  // Most events store JSON in `data`. Try to grab a meaningful field.
  try {
    const obj = JSON.parse(data);
    if (typeof obj === 'string') return obj;
    if (obj.prompt) return String(obj.prompt);
    if (obj.text) return String(obj.text);
    if (obj.message) return String(obj.message);
    if (obj.content) return String(obj.content);
    return JSON.stringify(obj).slice(0, 2000);
  } catch {
    return String(data).slice(0, 2000);
  }
}

/**
 * Embed a single event into the vec0 table. Idempotent: replaces an existing
 * embedding for the same rowid. Called from indexEvent() below and from the
 * backfill job. Returns true if an embedding was written, false if skipped.
 */
async function embedEvent(db, eventRow) {
  ensureInitialized(db);
  const text = eventText(eventRow);
  if (!text || text.length < 4) return false;
  const vec = await embed(text);
  const blob = toBlob(vec);
  // vec0 doesn't support UPSERT — delete-then-insert is the documented pattern.
  // vec0 also rejects bound parameters for the rowid column (sqlite-vec quirk:
  // "Only integers are allowed for primary key values"), even when the JS
  // value IS an integer. Workaround: inline the rowid into the SQL. eventRow.id
  // comes from a trusted internal SELECT against our own table, so injection
  // is not a concern — but we still hard-cast to integer for safety.
  const id = parseInt(eventRow.id, 10);
  if (!Number.isInteger(id)) throw new Error('embedEvent: bad event id ' + eventRow.id);
  db.prepare(`DELETE FROM event_embeddings WHERE rowid = ${id}`).run();
  db.prepare(`INSERT INTO event_embeddings(rowid, embedding) VALUES (${id}, ?)`).run(blob);
  return true;
}

/**
 * Background-friendly backfill: walks events that don't yet have an embedding
 * and embeds them in batches. Safe to call on startup; it short-circuits when
 * everything is already indexed. Designed to NOT block server boot — caller
 * should kick this off in a setImmediate / async tick.
 */
async function backfillEmbeddings(scope = 'main', batchSize = 50) {
  const db = getDb(scope);
  ensureInitialized(db);

  const totalEvents = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
  const indexed = db.prepare('SELECT COUNT(*) as c FROM event_embeddings').get().c;
  if (indexed >= totalEvents) {
    console.log(`[PAN MemorySearch] backfill: ${indexed}/${totalEvents} — already complete`);
    return { indexed, total: totalEvents, added: 0 };
  }

  console.log(`[PAN MemorySearch] backfill starting: ${indexed}/${totalEvents}`);
  let added = 0;
  // Walk events that don't yet have an embedding row. We use a NOT IN
  // subquery against the small vec0 rowid space; for huge backlogs we
  // chunk by id range so we don't load everything into memory.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = db.prepare(`
      SELECT id, event_type, data
      FROM events
      WHERE id NOT IN (SELECT rowid FROM event_embeddings)
      ORDER BY id ASC
      LIMIT ?
    `).all(batchSize);
    if (batch.length === 0) break;
    for (const row of batch) {
      try {
        const ok = await embedEvent(db, row);
        if (ok) added++;
      } catch (err) {
        console.warn(`[PAN MemorySearch] backfill embed failed for event ${row.id}:`, err.message);
      }
    }
    // Yield to the event loop so the server stays responsive.
    await new Promise(r => setImmediate(r));
  }
  console.log(`[PAN MemorySearch] backfill complete: +${added} embeddings`);
  return { indexed: indexed + added, total: totalEvents, added };
}

/**
 * Hybrid search. Runs FTS5 and vector search in parallel, then fuses the
 * two ranked lists with reciprocal rank fusion.
 *
 *   RRF(d) = Σ 1 / (k + rank_i(d))
 *
 * RRF is parameter-free, well-studied, and beats nearly every weighted
 * combination scheme without tuning. k=60 is the standard from the original
 * Cormack et al. paper.
 *
 * @param {string} query - free-form search text
 * @param {object} opts
 * @param {string} opts.scope - DB scope tag (default 'main')
 * @param {number} opts.limit - max results returned (default 20)
 * @param {number} opts.candidates - per-method candidate pool size (default 60)
 * @returns {Promise<Array>} merged + ranked results with event metadata
 */
async function searchMemory(query, opts = {}) {
  const scope = opts.scope || 'main';
  const limit = Math.max(1, Math.min(100, opts.limit || 20));
  const candidates = Math.max(limit, opts.candidates || 60);
  const db = getDb(scope);
  ensureInitialized(db);

  if (!query || !query.trim()) return [];
  const q = query.trim();

  // ---------- FTS5 (lexical) ----------
  // Sanitize the query for FTS5: strip characters that would break the
  // MATCH grammar, fall back to a phrase query if a token starts with a
  // special character. We OR the tokens for recall.
  let ftsRows = [];
  try {
    const ftsQuery = q
      .replace(/["()*]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map(t => t.length > 1 ? `"${t}"*` : `"${t}"`)
      .join(' OR ');
    if (ftsQuery) {
      ftsRows = db.prepare(`
        SELECT events_fts.rowid AS id, bm25(events_fts) AS score
        FROM events_fts
        WHERE events_fts MATCH ?
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, candidates);
    }
  } catch (err) {
    console.warn('[PAN MemorySearch] FTS5 query failed:', err.message);
  }

  // ---------- Vector (semantic) ----------
  let vecRows = [];
  try {
    const qVec = await embed(q);
    const blob = toBlob(qVec);
    vecRows = db.prepare(`
      SELECT rowid AS id, distance
      FROM event_embeddings
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(blob, candidates);
  } catch (err) {
    console.warn('[PAN MemorySearch] vec query failed:', err.message);
  }

  // ---------- Reciprocal Rank Fusion ----------
  const RRF_K = 60;
  const fused = new Map(); // id -> { id, rrf, ftsRank, vecRank }
  ftsRows.forEach((row, i) => {
    const cur = fused.get(row.id) || { id: row.id, rrf: 0, ftsRank: null, vecRank: null };
    cur.rrf += 1 / (RRF_K + (i + 1));
    cur.ftsRank = i + 1;
    fused.set(row.id, cur);
  });
  vecRows.forEach((row, i) => {
    const cur = fused.get(row.id) || { id: row.id, rrf: 0, ftsRank: null, vecRank: null };
    cur.rrf += 1 / (RRF_K + (i + 1));
    cur.vecRank = i + 1;
    fused.set(row.id, cur);
  });

  if (fused.size === 0) return [];

  // ---------- Hydrate top-N with full event rows ----------
  const ranked = Array.from(fused.values()).sort((a, b) => b.rrf - a.rrf).slice(0, limit);
  const ids = ranked.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, session_id, event_type, data, created_at, trust_origin, context_safe
    FROM events
    WHERE id IN (${placeholders}) AND context_safe = 1
  `).all(...ids);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));

  const results = ranked.map(r => {
    const ev = byId[r.id] || null;
    return {
      id: r.id,
      score: r.rrf,
      ftsRank: r.ftsRank,
      vecRank: r.vecRank,
      hit: r.ftsRank && r.vecRank ? 'both' : r.ftsRank ? 'fts' : 'vec',
      event: ev,
      preview: ev ? eventText(ev).slice(0, 280) : '',
    };
  });

  // Apply differential privacy — noise scores and perturb ranking
  return privatizeSearch(results, opts.caller || 'search');
}

/**
 * Index a freshly inserted event for vector search. Called from db.logEvent()
 * via a hook so new events become searchable as soon as they're written.
 * Async + non-blocking: errors are logged, never thrown into the insert path.
 */
function indexEventForSearch(scope, eventId) {
  // Fire-and-forget. The caller is the synchronous insert path; we don't
  // want to block writes on Ollama embedding latency.
  setImmediate(async () => {
    try {
      const db = getDb(scope);
      const row = db.prepare('SELECT id, event_type, data FROM events WHERE id = ?').get(eventId);
      if (row) await embedEvent(db, row);
    } catch (err) {
      console.warn(`[PAN MemorySearch] indexEventForSearch failed for ${eventId}:`, err.message);
    }
  });
}

export {
  ensureInitialized,
  searchMemory,
  embedEvent,
  backfillEmbeddings,
  indexEventForSearch,
};
