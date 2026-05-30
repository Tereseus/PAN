// PAN Embeddings — local Ollama embeddings with graceful fallback
//
// Uses qwen3-embedding (1024 dimensions) via Ollama.
// 0.6B params, 100+ languages, ~0.5 GB download.
// Falls back to simple TF-IDF-like keyword vectors when Ollama is down.

import { getOllamaUrl, getModelForPurpose } from '../db.js';

// The embedding model is part of the data contract — every event_embeddings
// row in the DB is wedded to its dim. We do NOT silently substitute another
// embedding tag (the 4B/8B variants have different dimensions; swapping
// would corrupt search ranking).
//
// Reading from the model_selections table (purpose='embedding') so the
// user can re-point to a different model via the dashboard without code
// changes. If the table read fails (cold boot before db.js initializes),
// we fall back to the canonical defaults below — same values the table
// is seeded with.
//
// Decision history: 1024-dim is the deliberate choice from an earlier
// design session. Diminishing returns past ~1024-dim on PAN's recall
// workload (short events, conversational text). Do not change EMBED_DIM
// without rebuilding event_embeddings from scratch.
const EMBED_FALLBACK_MODEL = 'qwen3-embedding:0.6b';
const EMBED_FALLBACK_DIM   = 1024;

function _getEmbedSelection() {
  const sel = getModelForPurpose('embedding');
  return {
    model: sel?.model || EMBED_FALLBACK_MODEL,
    dim:   sel?.dim   || EMBED_FALLBACK_DIM,
  };
}

// Backwards-compat exports — other files still import these names. Both
// now resolve via the registry on every call so the user updating the
// table is picked up without a Craft restart.
const EMBED_MODEL = _getEmbedSelection().model;
const EMBED_DIM   = _getEmbedSelection().dim;

let ollamaAvailable = null; // null = unknown, true/false = cached
let ollamaLastCheck = 0;    // ms timestamp of last availability check
const OLLAMA_RECHECK_MS = 60_000; // re-probe Ollama every 60s when it's down

// Resolve which Ollama URL actually has EMBED_MODEL installed.
//
// Order:
//   1. Scout's device_models registry — if a connected device reports
//      that specific model name, use its URL. This is the new source of
//      truth (table-driven, populated from /api/tags on each enrolled
//      device).
//   2. Fall back to getOllamaUrl() — covers cold-boot before Scout has
//      run, and the operator-set PAN_OLLAMA_URL env var path.
//
// Returns { url, model, viaRegistry: bool } so callers can log whether
// the device_models table is doing its job.
async function _resolveEmbedTarget() {
  try {
    // Lazy import so we don't pull all of scout.js into the embedding hot
    // path before Craft has finished booting. After the first call Node
    // caches the module, so subsequent calls are a single property lookup.
    const scout = await import('../scout.js').catch(() => null);
    if (scout?.findDeviceWithModel) {
      const hit = scout.findDeviceWithModel(EMBED_MODEL);
      if (hit) return { url: hit.url, model: hit.model, viaRegistry: true };
    }
  } catch {}
  return { url: getOllamaUrl(), model: EMBED_MODEL, viaRegistry: false };
}

let _loggedMissing = false; // throttle the "model not installed" hint to once per process

// Check if Ollama is running and has the EXACT embedding model installed.
// Strict match — see EMBED_MODEL comment above for why we don't accept
// "any qwen3-embedding:*" tag.
async function checkOllama() {
  try {
    const { url } = await _resolveEmbedTarget();
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json();
    const hasExact = data.models?.some(m => m.name === EMBED_MODEL);
    if (!hasExact) {
      if (!_loggedMissing) {
        const installed = data.models?.map(m => m.name).join(', ') || '(none)';
        console.log(`[PAN Memory] Ollama at ${url} reachable but ${EMBED_MODEL} not installed. Currently has: ${installed}. Run on that device: ollama pull ${EMBED_MODEL}`);
        _loggedMissing = true;
      }
      return false;
    }
    _loggedMissing = false; // reset so a future uninstall re-logs once
    return true;
  } catch {
    return false;
  }
}

// Get embedding from Ollama. EXACT model match required.
// timeout: 3s default keeps query-time searches snappy; write path passes 30s.
async function embedOllama(text, timeout = 3000) {
  const { url, model } = await _resolveEmbedTarget();
  const res = await fetch(`${url}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text.slice(0, 8000) }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  return data.embedding; // float64 array, EMBED_DIM length
}

// Simple fallback: hash-based pseudo-embedding (deterministic, fast, no ML)
// Not semantic but enables exact/near-exact match and basic dedup
function embedFallback(text) {
  const tokens = text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);

  const vec = new Float32Array(EMBED_DIM);
  for (const token of tokens) {
    // Hash each token to a position and accumulate
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
    }
    const pos = Math.abs(hash) % EMBED_DIM;
    vec[pos] += 1;
    // Also set neighboring positions for some spread
    vec[(pos + 1) % EMBED_DIM] += 0.5;
    vec[(pos + 2) % EMBED_DIM] += 0.25;
  }

  // Normalize to unit vector
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;

  return Array.from(vec);
}

// Public API — get embedding for text
async function embed(text) {
  const now = Date.now();

  // Initial check or periodic recheck when Ollama is down
  if (ollamaAvailable === null || (!ollamaAvailable && now - ollamaLastCheck > OLLAMA_RECHECK_MS)) {
    ollamaLastCheck = now;
    ollamaAvailable = await checkOllama();
    if (ollamaAvailable) {
      console.log('[PAN Memory] Ollama connected — using neural embeddings');
    } else {
      console.log('[PAN Memory] Ollama unavailable — using keyword embeddings (run `ollama serve` for neural embeddings)');
    }
  }

  if (ollamaAvailable) {
    try {
      return await embedOllama(text);
    } catch (err) {
      console.error('[PAN Memory] Ollama embed failed, falling back:', err.message);
      ollamaAvailable = false;
      ollamaLastCheck = Date.now();
    }
  }

  return embedFallback(text);
}

// Cosine similarity between two vectors
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// Serialize embedding to SQLite BLOB
function toBlob(embedding) {
  const arr = new Float32Array(embedding);
  return Buffer.from(arr.buffer);
}

// Deserialize BLOB to float array
function fromBlob(blob) {
  if (!blob) return null;
  const arr = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(arr);
}

// Reset Ollama status (call after `ollama serve` starts)
function resetOllamaStatus() {
  ollamaAvailable = null;
}

// ── Write-path probe gate ─────────────────────────────────────────────────
// Used by embedEvent / backfill. Returns the embedding vector or null.
// NEVER falls back to embedFallback — null means "skip this row".
// After 5 consecutive probe/embed failures, backs off 30s before retrying.
let _wConsecFails = 0;
let _wBackoffUntil = 0;
let _wProbeOk = null;  // null = unknown; true/false = last known state
let _wProbeTs = 0;
let _wProbePromise = null;  // shared in-flight probe — concurrent workers join instead of duplicate-probing
const _W_PROBE_TTL_MS = 5_000;    // reuse a healthy probe result for 5s before re-probing
const _W_BACKOFF_MS   = 30_000;
const _W_FAIL_LIMIT   = 5;

// Single probe execution. Writes result to _wProbeOk/_wProbeTs and clears
// _wProbePromise on completion. Stored in _wProbePromise so concurrent
// workers can await it without launching duplicate HTTP requests.
async function _doWriteProbe(prevOk) {
  try {
    const res = await fetch(`${getOllamaUrl()}/api/tags`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      _wProbeOk = false;
    } else {
      const data = await res.json();
      _wProbeOk = data.models?.some(m => m.name.startsWith(EMBED_MODEL)) ?? false;
    }
  } catch {
    _wProbeOk = false;
  }
  _wProbeTs = Date.now();
  _wProbePromise = null;
  if (!_wProbeOk && prevOk !== false) {
    console.warn('[PAN Embeddings] write-path: Ollama probe failed — skipping writes until it recovers');
  } else if (_wProbeOk && prevOk === false) {
    console.log('[PAN Embeddings] write-path: Ollama recovered — resuming writes');
    _wConsecFails = 0;
  }
  return _wProbeOk;
}

async function embedForWrite(text) {
  const now = Date.now();
  if (now < _wBackoffUntil) return null;

  // Shared probe: if a probe is already in-flight, all concurrent callers await
  // the same promise instead of each independently seeing stale _wProbeOk=false
  // and racing _wConsecFails to the backoff limit.
  if (!_wProbePromise) {
    const cacheExpired = now - _wProbeTs > _W_PROBE_TTL_MS;
    if (_wProbeOk === null || !_wProbeOk || cacheExpired) {
      _wProbePromise = _doWriteProbe(_wProbeOk);
    }
  }
  if (_wProbePromise) await _wProbePromise;

  if (!_wProbeOk) {
    _wConsecFails++;
    if (_wConsecFails >= _W_FAIL_LIMIT) {
      _wBackoffUntil = Date.now() + _W_BACKOFF_MS;
      console.warn(`[PAN Embeddings] write-path: ${_W_FAIL_LIMIT} consecutive failures — backing off 30s`);
      _wConsecFails = 0;
    }
    return null;
  }

  try {
    const vec = await embedOllama(text, 30000);
    _wConsecFails = 0;
    return vec;
  } catch (err) {
    console.error('[PAN Embeddings] write-path embed failed:', err.message);
    _wProbeOk = false;
    _wProbeTs = Date.now();
    _wConsecFails++;
    if (_wConsecFails >= _W_FAIL_LIMIT) {
      _wBackoffUntil = Date.now() + _W_BACKOFF_MS;
      console.warn(`[PAN Embeddings] write-path: ${_W_FAIL_LIMIT} consecutive failures — backing off 30s`);
      _wConsecFails = 0;
    }
    return null;
  }
}

export { embed, embedForWrite, cosineSimilarity, toBlob, fromBlob, resetOllamaStatus, EMBED_DIM, EMBED_MODEL };
