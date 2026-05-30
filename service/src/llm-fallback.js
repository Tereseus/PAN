// PAN AI backend fallback chain — task #996.
//
// Today every router call goes to a SINGLE backend (the `ai_model` setting,
// currently `cerebras:qwen-3-235b`). When Cerebras rate-limits, throws 5xx,
// times out, or sideways-DNSs, the user gets:
//   • streaming: empty `chunk` + "Something went wrong"
//   • non-streaming: "PAN is having trouble thinking right now. Try again."
//   • phone: same string spoken via TTS — user thinks PAN is broken
//
// This wrapper iterates a chain of backends and retries on transient errors,
// emitting telemetry so the dashboard can show "running on backup".
//
// Default chains are now BUILT FROM model_selections at runtime (see
// _buildDefaultChain below) instead of hardcoded. The user sets
// reasoning_cloud / chat_cloud_fallback / chat_local in the dashboard
// and both chains pick up the new choices on next call.
//
// Why this matters: the old hardcoded `ollama:qwen2.5:14b` was wrong for
// this user's hardware (CPU-only mini PC) — 14B params is ~3 min/query.
// The registry now picks `chat_local` which seeds to `qwen3:4b`, the
// model actually pulled on the MiniPC and realistic for CPU inference.
//
// Retriable errors (will trigger fallback):
//   • HTTP 429 (rate limit)
//   • HTTP 5xx
//   • network: ECONNREFUSED, ETIMEDOUT, ENOTFOUND, fetch failed
//   • AbortError that did NOT come from the caller's externalSignal (i.e. our
//     internal per-attempt timeout, not user cancel)
//
// Non-retriable errors (caller gets the first failure):
//   • HTTP 400  — bad prompt, won't be fixed by retry
//   • HTTP 401 / 403 — auth, won't be fixed by retry
//   • content-policy refusal text in body
//   • external abort (user said "cancel" / new utterance)
//
// Streaming policy:
//   • Fallback only fires on initial connect failure (before any chunk is yielded).
//   • Mid-stream failure after >=1 chunk → propagate as truncated (don't switch
//     mid-stream — corrupts the chunk sequence). Caller can decide.

import { insert, get, getModelForPurpose } from './db.js';
import { askAI, askAIStream, getModelForCaller } from './llm.js';

// Build a default chain by reading model_selections. Strict order:
//   voice       → reasoning_cloud → chat_cloud_fallback → chat_local
//   background  → chat_local first (free), then reasoning_cloud as backup
//                 (no chat_cloud_fallback: Augur/Scout would burn Claude budget)
// Each entry is collapsed back into the provider-prefixed name format
// the rest of the LLM dispatch path expects (e.g. "cerebras:qwen-3-235b",
// "ollama:qwen3:4b", "claude-haiku-4-5-20251001").
function _formatModelRef(sel) {
  if (!sel) return null;
  const p = String(sel.provider || '').toLowerCase();
  // Local Ollama on any device → prefix "ollama:" (the dispatcher in
  // llm.js routes via getOllamaUrl() which picks the right device URL).
  if (p === 'ollama' || p.startsWith('ollama@')) return `ollama:${sel.model}`;
  // Cloud providers — prefix is the provider name except for Anthropic
  // (claude-*) which the dispatcher recognises by model-id prefix.
  if (p === 'cerebras') return `cerebras:${sel.model}`;
  if (p === 'groq')     return `groq:${sel.model}`;
  if (p === 'openai')   return `openai:${sel.model}`;
  if (p === 'gemini')   return `gemini:${sel.model}`;
  // anthropic (and anything else): model id alone — llm.js detects via prefix
  return sel.model;
}

function _buildDefaultChain(kind) {
  const reasoning = _formatModelRef(getModelForPurpose('reasoning_cloud'));
  const fallback  = _formatModelRef(getModelForPurpose('chat_cloud_fallback'));
  const local     = _formatModelRef(getModelForPurpose('chat_local'));
  const dedupe = (arr) => [...new Set(arr.filter(Boolean))];
  if (kind === 'background') {
    return dedupe([local, reasoning]);
  }
  return dedupe([reasoning, fallback, local]);
}

// Max attempts even if chain is longer — guard against infinite loops if a user
// configures an absurd 10-entry chain.
const MAX_ATTEMPTS = 3;

// Degraded-event sliding window — fire `pan_backend_degraded` when the primary
// fails this many times in this window. Drives #468 (phone health banner).
const DEGRADED_WINDOW_MS  = 10 * 60 * 1000;
const DEGRADED_THRESHOLD  = 3;
const recentFailures = new Map(); // model -> [ts, ts, ...]

function readChain(callerClass) {
  // callerClass: 'voice' | 'background'
  // If `ai_fallback_enabled` is explicitly "false", short-circuit: chain = [current model]
  // → behaves exactly like single-backend askAI (no retries, no degradation event).
  try {
    const enabled = get(`SELECT value FROM settings WHERE key = 'ai_fallback_enabled'`);
    if (enabled && /^"?false"?$/i.test(enabled.value)) {
      const cur = get(`SELECT value FROM settings WHERE key = 'ai_model'`);
      if (cur) return [cur.value.replace(/^"|"$/g, '')];
    }
  } catch {}

  const key = callerClass === 'background' ? 'ai_fallback_chain_background' : 'ai_fallback_chain_voice';
  try {
    const row = get(`SELECT value FROM settings WHERE key = '${key}'`);
    if (row) {
      const parsed = JSON.parse(row.value);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.slice(0, MAX_ATTEMPTS);
      }
    }
  } catch {}
  return _buildDefaultChain(callerClass).slice(0, MAX_ATTEMPTS);
}

/**
 * Inspect an error and decide whether to fall back to the next backend.
 * Returns { retriable: bool, reason: string }.
 */
export function classifyError(err, externalSignal = null) {
  if (!err) return { retriable: false, reason: 'none' };

  // If the caller's signal fired, this is a user cancel — never retry.
  if (externalSignal && externalSignal.aborted) {
    return { retriable: false, reason: 'user-cancel' };
  }

  const name = (err.name || '').toLowerCase();
  const msg  = (err.message || String(err) || '').toLowerCase();

  // Network errors — almost always transient
  if (msg.includes('econnrefused') || msg.includes('etimedout') ||
      msg.includes('enotfound')     || msg.includes('fetch failed') ||
      msg.includes('socket hang up')|| msg.includes('network')) {
    return { retriable: true, reason: 'network' };
  }

  // Internal timeout abort (our AbortController, not external) — retriable
  if (name === 'aborterror' || msg.includes('aborted') || msg.includes('timeout')) {
    return { retriable: true, reason: 'timeout' };
  }

  // HTTP status parsing — providers throw strings like "Cerebras 429: ..." or "Cerebras 503: ..."
  const statusMatch = msg.match(/\b(4\d{2}|5\d{2})\b/);
  if (statusMatch) {
    const code = parseInt(statusMatch[1], 10);
    if (code === 429) return { retriable: true,  reason: 'rate-limit' };
    if (code >= 500)  return { retriable: true,  reason: `http-${code}` };
    if (code === 404) return { retriable: true,  reason: 'model-unknown' }; // bad model id → next backend may have it
    if (code === 400) return { retriable: false, reason: 'bad-request' };
    if (code === 401 || code === 403) return { retriable: false, reason: 'auth' };
    return { retriable: false, reason: `http-${code}` };
  }

  // Content-policy / refusal text — same answer from other backends likely
  if (msg.includes('content policy') || msg.includes('content_policy') || msg.includes('refused')) {
    return { retriable: false, reason: 'content-policy' };
  }

  // Missing API key — switching backends might help (next one might be local)
  if (msg.includes('no ') && msg.includes('api key')) {
    return { retriable: true, reason: 'missing-key' };
  }

  // Unknown — be conservative: retry once. Caller still gets MAX_ATTEMPTS cap.
  return { retriable: true, reason: 'unknown' };
}

function recordFailure(model) {
  const now = Date.now();
  const list = (recentFailures.get(model) || []).filter(t => now - t < DEGRADED_WINDOW_MS);
  list.push(now);
  recentFailures.set(model, list);
  if (list.length >= DEGRADED_THRESHOLD) {
    // Emit degraded event — #468's banner will pick this up.
    try {
      insert(
        `INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`,
        { ':sid': 'llm-fallback', ':type': 'pan_backend_degraded', ':data': JSON.stringify({ model, failures: list.length, window_ms: DEGRADED_WINDOW_MS, source: 'llm-fallback' }) }
      );
    } catch {}
    // Reset so we don't spam — next 3 failures fire again.
    recentFailures.set(model, []);
  }
}

function logAttempt(caller, model, attemptN, fallbackReason, ok, ms) {
  // ai_usage already gets a row from askAI/askAIStream when those succeed; this
  // is the per-attempt diagnostic row so the dashboard can show the retry chain.
  // We log to events (cheap, structured) — separate from ai_usage so we don't
  // pollute token accounting with zero-token failed attempts.
  try {
    insert(
      `INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`,
      {
        ':sid': 'llm-fallback',
        ':type': 'ai_fallback_attempt',
        ':data': JSON.stringify({ caller, model, attempt_n: attemptN, reason: fallbackReason, ok, ms, source: 'llm-fallback' }),
      }
    );
  } catch {}
}

/**
 * Non-streaming fallback wrapper. Same return type as askAI (string),
 * but iterates a chain of models on retriable errors.
 *
 * @param {string} prompt
 * @param {object} opts
 * @param {string} opts.caller          — same as askAI's caller (telemetry)
 * @param {'voice'|'background'} opts.callerClass  — which chain to use (default 'voice')
 * @param {string[]} opts.chain         — override chain explicitly
 * @param {AbortSignal} opts.signal     — external cancel (user said stop)
 * @param {number} opts.timeout         — per-attempt timeout (default 15s)
 * @param {number} opts.maxTokens
 * @param {string} opts.source
 * @param {string} opts.device_id
 * @returns {Promise<string>}  — same contract as askAI. Attempts metadata is
 *   attached to opts.outMeta if the caller passed an object to receive it.
 */
export async function askAIWithFallback(prompt, opts = {}) {
  const {
    caller = 'unknown',
    callerClass = 'voice',
    chain: chainOverride,
    signal: externalSignal = null,
    outMeta = null,
    ...passthrough
  } = opts;

  const chain = (Array.isArray(chainOverride) && chainOverride.length)
    ? chainOverride.slice(0, MAX_ATTEMPTS)
    : readChain(callerClass);

  const attempts = [];
  let lastErr = null;

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const t0 = Date.now();
    // Honor external cancel between attempts.
    if (externalSignal && externalSignal.aborted) {
      lastErr = new Error('aborted by caller');
      lastErr.name = 'AbortError';
      break;
    }
    try {
      const text = await askAI(prompt, { ...passthrough, caller, model });
      const ms = Date.now() - t0;
      attempts.push({ model, ok: true, ms });
      if (i > 0) logAttempt(caller, model, i + 1, 'recovered', true, ms);
      if (outMeta && typeof outMeta === 'object') {
        outMeta.attempts = attempts;
        outMeta.model = model;
      }
      return text;
    } catch (err) {
      const ms = Date.now() - t0;
      const { retriable, reason } = classifyError(err, externalSignal);
      attempts.push({ model, ok: false, ms, error: (err.message || String(err)).slice(0, 200), reason });
      logAttempt(caller, model, i + 1, reason, false, ms);
      recordFailure(model);
      lastErr = err;
      if (!retriable) break;
      // continue to next backend
    }
  }

  // All attempts exhausted — re-throw the last error so caller's existing
  // error path runs (router's "I didn't catch that — could you try again?" branch).
  const finalErr = lastErr || new Error('All backends failed');
  finalErr.attempts = attempts;
  if (outMeta && typeof outMeta === 'object') outMeta.attempts = attempts;
  throw finalErr;
}

/**
 * Streaming fallback wrapper. Yields chunks. Falls back to next backend ONLY
 * if the current backend fails BEFORE yielding its first chunk. Once a chunk
 * has been yielded, we never switch mid-stream (would corrupt the sequence) —
 * instead, propagate the error and let the caller handle truncation.
 *
 * Yields: strings (text chunks). On exhaustion, throws the last error.
 *
 * @returns {AsyncGenerator<string>}
 */
export async function* askAIStreamWithFallback(prompt, opts = {}) {
  const {
    caller = 'unknown',
    callerClass = 'voice',
    chain: chainOverride,
    signal: externalSignal = null,
    ...passthrough
  } = opts;

  const chain = (Array.isArray(chainOverride) && chainOverride.length)
    ? chainOverride.slice(0, MAX_ATTEMPTS)
    : readChain(callerClass);

  let lastErr = null;

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const t0 = Date.now();
    if (externalSignal && externalSignal.aborted) {
      const e = new Error('aborted by caller');
      e.name = 'AbortError';
      throw e;
    }

    // Try this backend. Buffer the first chunk before yielding so a connect-time
    // failure can fall back without the consumer seeing a half-stream.
    let yieldedAny = false;
    try {
      const gen = askAIStream(prompt, { ...passthrough, caller, model, signal: externalSignal });
      // Manual iteration so we can detect connect-time failure vs mid-stream.
      while (true) {
        let next;
        try {
          next = await gen.next();
        } catch (err) {
          // If nothing yielded yet, classify and maybe fall back.
          if (!yieldedAny) {
            const ms = Date.now() - t0;
            const { retriable, reason } = classifyError(err, externalSignal);
            logAttempt(caller, model, i + 1, reason, false, ms);
            recordFailure(model);
            lastErr = err;
            if (!retriable) throw err;
            // break inner while to advance outer for-loop
            break;
          }
          // Mid-stream failure — propagate (truncated). Don't switch backends.
          throw err;
        }
        if (next.done) {
          // Generator finished. If we yielded at least one chunk we're done.
          if (yieldedAny) {
            const ms = Date.now() - t0;
            if (i > 0) logAttempt(caller, model, i + 1, 'recovered', true, ms);
            return;
          }
          // Generator returned without yielding anything — treat as connect failure
          const ms = Date.now() - t0;
          logAttempt(caller, model, i + 1, 'empty-stream', false, ms);
          recordFailure(model);
          lastErr = new Error(`${model} returned empty stream`);
          break;
        }
        // Got a chunk — commit to this backend.
        yieldedAny = true;
        yield next.value;
      }
      // If we got here without returning, we broke out due to connect failure → try next backend
      if (yieldedAny) return; // safety; logically unreachable
    } catch (err) {
      // Either rethrown from inside or thrown by external code (e.g. non-retriable)
      throw err;
    }
  }

  const finalErr = lastErr || new Error('All streaming backends failed');
  throw finalErr;
}

export default {
  askAIWithFallback,
  askAIStreamWithFallback,
  classifyError,
};
