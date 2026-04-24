// PAN Embeddings — local Ollama embeddings with graceful fallback
//
// Uses qwen3-embedding (1024 dimensions) via Ollama.
// 0.6B params, 100+ languages, ~0.5 GB download.
// Falls back to simple TF-IDF-like keyword vectors when Ollama is down.

import { getOllamaUrl } from '../db.js';
const EMBED_MODEL = 'qwen3-embedding';
const EMBED_DIM = 1024;

let ollamaAvailable = null; // null = unknown, true/false = cached

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
async function embedOllama(text) {
  const res = await fetch(`${getOllamaUrl()}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 8000) }),
    signal: AbortSignal.timeout(10000),
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
  if (ollamaAvailable === null) {
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

export { embed, cosineSimilarity, toBlob, fromBlob, resetOllamaStatus, EMBED_DIM };
