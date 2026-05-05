// PAN Embeddings — local Ollama embeddings with graceful fallback
//
// Uses qwen3-embedding (1024 dimensions) via Ollama.
// 0.6B params, 100+ languages, ~0.5 GB download.
// Falls back to simple TF-IDF-like keyword vectors when Ollama is down.

import { getOllamaUrl } from '../db.js';
const EMBED_MODEL = 'qwen3-embedding:0.6b';
const EMBED_DIM = 1024;

let ollamaAvailable = null; // null = unknown, true/false = cached
let ollamaLastCheck = 0;    // ms timestamp of last availability check
const OLLAMA_RECHECK_MS = 60_000; // re-probe Ollama every 60s when it's down

// Check if Ollama is running and has the embedding model
async function checkOllama() {
  try {
    const res = await fetch(`${getOllamaUrl()}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json();
    const hasModel = data.models?.some(m => m.name.startsWith(EMBED_MODEL));
    if (!hasModel) {
      console.log(`[PAN Memory] Ollama running but ${EMBED_MODEL} not found. Run: ollama pull ${EMBED_MODEL}`);
    }
    return hasModel;
  } catch {
    return false;
  }
}

// Get embedding from Ollama
// timeout: 3s default keeps query-time searches snappy; write path passes 30s.
async function embedOllama(text, timeout = 3000) {
  const res = await fetch(`${getOllamaUrl()}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 8000) }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  return data.embedding; // float64 array
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
let _wProbeOk = null;  // null = unknown
let _wProbeTs = 0;
const _W_PROBE_TTL_MS = 5_000;    // reuse probe result for 5s in happy path
const _W_BACKOFF_MS   = 30_000;
const _W_FAIL_LIMIT   = 5;

async function embedForWrite(text) {
  const now = Date.now();
  if (now < _wBackoffUntil) return null;

  // Re-probe if state is unknown or cached result has expired
  if (_wProbeOk === null || now - _wProbeTs > _W_PROBE_TTL_MS) {
    const prevOk = _wProbeOk;
    _wProbeTs = now;
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
    if (!_wProbeOk && prevOk !== false) {
      console.warn('[PAN Embeddings] write-path: Ollama probe failed — skipping writes until it recovers');
    } else if (_wProbeOk && prevOk === false) {
      console.log('[PAN Embeddings] write-path: Ollama recovered — resuming writes');
      _wConsecFails = 0;
    }
  }

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
