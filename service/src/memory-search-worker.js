// PAN Embeddings Backfill — Worker Thread
//
// Runs the embeddings backfill loop on a dedicated worker_thread so the
// vec0 vector-index INSERTs (100-500ms of sync CPU per row on a 200k-vector
// HNSW graph) don't block the main thread's HTTP / WebSocket handlers.
//
// Why this fixes the "dashboard freezes while backfill runs" problem:
//   - better-sqlite3 is synchronous by design. On the main thread, every
//     INSERT into event_embeddings froze the entire Node event loop.
//   - The MAIN thread serves HTTP. While it was frozen for 300ms doing one
//     vec0 insert, no /api/v1/* request could be answered. After 300ms it
//     unfroze just long enough to handle one or two requests before the
//     next insert refroze it.
//   - SQLite is in WAL mode (see db.js + db-registry.js). WAL allows
//     concurrent readers + one writer without lock contention at the
//     SQLite level — so the worker thread (writer) and the main thread
//     (readers serving HTTP) can both touch the DB simultaneously.
//
// Communication protocol with the main thread:
//   Worker → main:
//     { type: 'progress', stats: { rate, indexed, total, added, etaMin } }
//     { type: 'log',      tag, message }
//     { type: 'done',     result: { indexed, total, added } }
//     { type: 'error',    error: string }
//   Main → worker:
//     { type: 'abort' }   — graceful stop at next iteration boundary

import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// sqlite-vec ships native bindings that must be loaded into EACH database
// connection. The worker's connection is independent of the main thread's,
// so we re-load the extension here — otherwise `INSERT INTO event_embeddings`
// throws "no such module: vec0".
const sqliteVec = require('sqlite-vec');

// Each worker thread runs its own module graph — these imports create
// FRESH module instances scoped to this worker. The DB connection opened
// here is independent of the main thread's connection.
import { getDb } from './db-registry.js';
import { embedForWrite, toBlob, EMBED_DIM } from './memory/embeddings.js';

const scope = workerData?.scope || 'main';
const concurrency = workerData?.concurrency || 1;

let aborted = false;
parentPort.on('message', (msg) => {
  if (msg?.type === 'abort') {
    aborted = true;
    parentPort.postMessage({ type: 'log', tag: 'BackfillWorker', message: 'abort signal received' });
  }
});

function log(tag, message) {
  parentPort.postMessage({ type: 'log', tag, message });
}

// Sentinel blob for events with no embeddable text — written so the
// "WHERE id NOT IN (event_embeddings)" query never re-visits the row.
const _SENTINEL_VEC = new Float32Array(EMBED_DIM);
_SENTINEL_VEC[0] = 1.0;
const _SENTINEL_BLOB = Buffer.from(_SENTINEL_VEC.buffer);

function extractEventText(eventType, data) {
  if (typeof data !== 'string') {
    try { data = JSON.stringify(data); } catch { return ''; }
  }
  try {
    const obj = JSON.parse(data);
    // Cloud-Claude write-back (Phase 2) — embed the conversation text, not the
    // JSON envelope, so semantic recall matches the actual exchange.
    if (eventType === 'CloudExchange') {
      const parts = [obj.topic, obj.user_message, obj.assistant_message].filter(Boolean);
      if (parts.length) return parts.join(' — ').slice(0, 2000);
    }
    if (obj.prompt) return String(obj.prompt);
    if (obj.text) return String(obj.text);
    if (obj.message) return String(obj.message);
    if (obj.content) return String(obj.content);
    return JSON.stringify(obj).slice(0, 2000);
  } catch {
    return String(data).slice(0, 2000);
  }
}

async function embedOne(db, eventRow) {
  const id = parseInt(eventRow.id, 10);
  if (!Number.isInteger(id)) throw new Error('bad event id ' + eventRow.id);
  const text = extractEventText(eventRow.event_type, eventRow.data);
  if (!text || text.length < 4) {
    // No meaningful content — write sentinel so backfill never re-processes.
    db.prepare(`DELETE FROM event_embeddings WHERE rowid = ${id}`).run();
    db.prepare(`INSERT INTO event_embeddings(rowid, embedding) VALUES (${id}, ?)`).run(_SENTINEL_BLOB);
    return 'skip';
  }
  const vec = await embedForWrite(text);
  if (!vec) return false; // Ollama unavailable — skip
  const blob = toBlob(vec);
  db.prepare(`DELETE FROM event_embeddings WHERE rowid = ${id}`).run();
  db.prepare(`INSERT INTO event_embeddings(rowid, embedding) VALUES (${id}, ?)`).run(blob);
  return true;
}

(async () => {
  try {
    const db = getDb(scope);
    // Load vec0 into THIS connection. Without it, INSERT into
    // event_embeddings throws "no such module: vec0".
    try { sqliteVec.load(db); }
    catch (e) { log('BackfillWorker', `sqlite-vec load: ${e.message} (may already be loaded)`); }

    const totalEvents = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
    const indexedStart = db.prepare('SELECT COUNT(*) as c FROM event_embeddings').get().c;
    if (indexedStart >= totalEvents) {
      log('PAN MemorySearch', `backfill: ${indexedStart}/${totalEvents} — already complete`);
      parentPort.postMessage({ type: 'done', result: { indexed: indexedStart, total: totalEvents, added: 0 } });
      return;
    }

    const needed = totalEvents - indexedStart;
    log('PAN MemorySearch', `backfill starting (worker thread): ${indexedStart}/${totalEvents} indexed, ${needed} to embed (concurrency=${concurrency})`);

    let added = 0;
    let poolConsecFails = 0;
    let poolBackoffUntil = 0;
    let poolBackoffTier = 0;
    const POOL_FAIL_LIMIT = 5;
    const POOL_BACKOFF_TIERS_MS = [30_000, 120_000, 600_000, 1_800_000];

    let rateWindowStart = Date.now();
    let rateWindowAdded = 0;
    const RATE_LOG_MS = 60_000;

    function emitProgress() {
      const elapsed = (Date.now() - rateWindowStart) / 1000;
      const rate = elapsed > 0 ? rateWindowAdded / elapsed : 0;
      const remaining = needed - added;
      const etaMin = rate > 0 ? Math.round(remaining / rate / 60) : null;
      parentPort.postMessage({
        type: 'progress',
        stats: {
          indexed: indexedStart + added,
          total: totalEvents,
          added,
          rate: Number(rate.toFixed(2)),
          etaMin,
        },
      });
      if (elapsed >= RATE_LOG_MS / 1000) {
        log('PAN MemorySearch', `backfill: ${rate.toFixed(1)}/sec — ${indexedStart + added}/${totalEvents} embedded (ETA ~${etaMin ?? '∞'}min)`);
        rateWindowStart = Date.now();
        rateWindowAdded = 0;
      }
    }

    function _triggerPoolBackoff() {
      const tierIdx = Math.min(poolBackoffTier, POOL_BACKOFF_TIERS_MS.length - 1);
      const backoffMs = POOL_BACKOFF_TIERS_MS[tierIdx];
      poolBackoffUntil = Date.now() + backoffMs;
      poolBackoffTier++;
      const human = backoffMs >= 60_000 ? `${Math.round(backoffMs / 60_000)}min` : `${Math.round(backoffMs / 1000)}s`;
      log('PAN MemorySearch', `backfill: pool paused ${human} after ${POOL_FAIL_LIMIT} consecutive Ollama failures (tier ${tierIdx + 1}/${POOL_BACKOFF_TIERS_MS.length})`);
      poolConsecFails = 0;
    }

    async function processRow(row) {
      try {
        const ok = await embedOne(db, row);
        if (ok === true) {
          added++;
          rateWindowAdded++;
          poolConsecFails = 0;
          poolBackoffTier = 0;
        } else if (ok === 'skip') {
          poolConsecFails = 0;
        } else {
          poolConsecFails++;
          if (poolConsecFails >= POOL_FAIL_LIMIT) _triggerPoolBackoff();
        }
      } catch (err) {
        log('PAN MemorySearch', `backfill embed failed for event ${row.id}: ${err.message}`);
        poolConsecFails++;
        if (poolConsecFails >= POOL_FAIL_LIMIT) _triggerPoolBackoff();
      }
    }

    const DB_BATCH = concurrency * 10;
    while (true) {
      if (aborted) {
        log('PAN MemorySearch', 'backfill aborted (worker thread)');
        break;
      }

      const now = Date.now();
      if (now < poolBackoffUntil) {
        const wait = poolBackoffUntil - now;
        log('PAN MemorySearch', `backfill: pool backing off ${Math.ceil(wait / 1000)}s`);
        await new Promise(r => setTimeout(r, wait));
        poolConsecFails = 0;
        if (aborted) break;
      }

      const batch = db.prepare(`
        SELECT id, event_type, data
        FROM events
        WHERE id NOT IN (SELECT rowid FROM event_embeddings)
        ORDER BY id ASC
        LIMIT ?
      `).all(DB_BATCH);
      if (batch.length === 0) break;

      for (let i = 0; i < batch.length; i += concurrency) {
        if (aborted) break;
        if (Date.now() < poolBackoffUntil) break;
        const chunk = batch.slice(i, i + concurrency);
        await Promise.all(chunk.map(row => processRow(row)));
        emitProgress();
      }

      // Yield between DB batches — keeps the worker's own event loop healthy
      // (it still has timers, gc, etc.) and lets the abort message land.
      await new Promise(r => setImmediate(r));
    }

    emitProgress();
    log('PAN MemorySearch', `backfill complete (worker thread): +${added} embeddings (${indexedStart + added}/${totalEvents} total)`);
    parentPort.postMessage({ type: 'done', result: { indexed: indexedStart + added, total: totalEvents, added } });
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: String(err?.stack || err?.message || err) });
  }
})();
