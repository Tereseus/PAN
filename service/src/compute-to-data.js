// Compute-to-Data Pipeline for PAN
//
// Core principle: AI comes TO the data, data never leaves PAN.
// Instead of sending raw user data to external AI APIs, we:
//
// 1. Keep all raw data in local SQLCipher DB
// 2. Build context summaries LOCALLY (anonymized, compressed)
// 3. Send only the summary to external AI — never raw events/transcripts
// 4. External AI response comes back, gets logged locally
//
// This inverts the normal pattern where user data flows to cloud AI.
// Even when using cloud models (Cerebras, Anthropic), the raw data
// stays local — only derived/anonymized context crosses the wire.
//
// Three modes:
//   - 'local'  : All processing on local LLM (Ollama). Nothing leaves.
//   - 'hybrid' : Local summarization → cloud AI gets summary only.
//   - 'cloud'  : Anonymized data sent to cloud (current default, least private).

import { db, get, run, insert } from './db.js';
import { askAI } from './llm.js';
import { anonymizeForAI } from './anonymize.js';

// ============================================================
// Schema
// ============================================================
function ensureC2DSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS c2d_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_type TEXT NOT NULL,
      input_scope TEXT NOT NULL DEFAULT 'local',
      output_scope TEXT NOT NULL DEFAULT 'local',
      model_used TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      raw_bytes INTEGER DEFAULT 0,
      sent_bytes INTEGER DEFAULT 0,
      compression_ratio REAL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'hybrid',
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_c2d_ts ON c2d_jobs(ts);
  `);

  try {
    const existing = get("SELECT value FROM settings WHERE key = 'c2d_mode'");
    if (!existing) {
      run("INSERT OR IGNORE INTO settings (key, value) VALUES ('c2d_mode', 'hybrid')");
      run("INSERT OR IGNORE INTO settings (key, value) VALUES ('c2d_local_model', 'llama3.2:latest')");
    }
  } catch {}
}

try { ensureC2DSchema(); } catch (e) { console.error('[C2D] Schema init error:', e.message); }

// ============================================================
// Config
// ============================================================
export function getC2DConfig() {
  try {
    const mode = get("SELECT value FROM settings WHERE key = 'c2d_mode'");
    const localModel = get("SELECT value FROM settings WHERE key = 'c2d_local_model'");
    return {
      mode: mode?.value || 'hybrid',
      localModel: localModel?.value || 'llama3.2:latest',
    };
  } catch {
    return { mode: 'hybrid', localModel: 'llama3.2:latest' };
  }
}

// ============================================================
// Local Summarization — compress data before it leaves PAN
// ============================================================

const SUMMARIZE_PROMPT = `Summarize the following data concisely. Preserve key facts, decisions, and action items. Remove all personal identifiers (names, addresses, phone numbers, emails). Output ONLY the summary, no preamble.

Data:
"""
{DATA}
"""`;

/**
 * Summarize raw data locally before sending to cloud AI.
 * Returns { summary, rawBytes, sentBytes, compressionRatio }
 */
async function localSummarize(rawData, localModel) {
  const rawBytes = Buffer.byteLength(rawData, 'utf8');

  // First anonymize
  const anonymized = anonymizeForAI(rawData);

  // Then summarize with local LLM
  const prompt = SUMMARIZE_PROMPT.replace('{DATA}', anonymized.slice(0, 8000));
  const summary = await askAI(prompt, {
    model: localModel,
    timeout: 30000,
    maxTokens: 500,
    caller: 'c2d-summarize',
  });

  const sentBytes = Buffer.byteLength(summary, 'utf8');

  return {
    summary,
    rawBytes,
    sentBytes,
    compressionRatio: rawBytes > 0 ? +(sentBytes / rawBytes).toFixed(3) : 0,
  };
}

// ============================================================
// Core: Process data through compute-to-data pipeline
// ============================================================

/**
 * Send a query to AI with compute-to-data protection.
 * Instead of sending raw context, summarizes locally first.
 *
 * @param {string} query — the user's question
 * @param {string} context — raw context data (conversation history, events, etc.)
 * @param {object} opts
 * @param {string} [opts.cloudModel] — model for the cloud call
 * @param {string} [opts.caller] — who initiated this
 * @returns {object} { response, mode, stats }
 */
export async function queryWithPrivacy(query, context, opts = {}) {
  const config = getC2DConfig();
  const startMs = Date.now();

  let response, stats;

  if (config.mode === 'local') {
    // Mode: LOCAL — everything stays on-device
    const fullPrompt = context ? `Context:\n${context}\n\nQuestion: ${query}` : query;
    response = await askAI(fullPrompt, {
      model: config.localModel,
      timeout: 60000,
      maxTokens: 1000,
      caller: opts.caller || 'c2d-local',
    });
    stats = {
      rawBytes: Buffer.byteLength(context || '', 'utf8'),
      sentBytes: 0, // Nothing sent externally
      compressionRatio: 0,
      mode: 'local',
    };

  } else if (config.mode === 'hybrid') {
    // Mode: HYBRID — summarize locally, then query cloud with summary
    let safeContext;
    if (context && context.length > 200) {
      const summarized = await localSummarize(context, config.localModel);
      safeContext = summarized.summary;
      stats = {
        rawBytes: summarized.rawBytes,
        sentBytes: summarized.sentBytes,
        compressionRatio: summarized.compressionRatio,
        mode: 'hybrid',
      };
    } else {
      safeContext = anonymizeForAI(context || '');
      stats = {
        rawBytes: Buffer.byteLength(context || '', 'utf8'),
        sentBytes: Buffer.byteLength(safeContext, 'utf8'),
        compressionRatio: context ? +(Buffer.byteLength(safeContext, 'utf8') / Buffer.byteLength(context, 'utf8')).toFixed(3) : 0,
        mode: 'hybrid',
      };
    }

    const prompt = safeContext ? `Context:\n${safeContext}\n\nQuestion: ${query}` : query;
    response = await askAI(prompt, {
      model: opts.cloudModel,
      timeout: 30000,
      maxTokens: 1000,
      caller: opts.caller || 'c2d-hybrid',
    });

  } else {
    // Mode: CLOUD — anonymize and send (least private, fastest)
    const anonContext = anonymizeForAI(context || '');
    const prompt = anonContext ? `Context:\n${anonContext}\n\nQuestion: ${query}` : query;
    response = await askAI(prompt, {
      model: opts.cloudModel,
      timeout: 30000,
      maxTokens: 1000,
      caller: opts.caller || 'c2d-cloud',
    });
    stats = {
      rawBytes: Buffer.byteLength(context || '', 'utf8'),
      sentBytes: Buffer.byteLength(anonContext, 'utf8'),
      compressionRatio: context ? +(Buffer.byteLength(anonContext, 'utf8') / Buffer.byteLength(context, 'utf8')).toFixed(3) : 0,
      mode: 'cloud',
    };
  }

  const latencyMs = Date.now() - startMs;

  // Log the job
  try {
    db.prepare(`
      INSERT INTO c2d_jobs (job_type, input_scope, output_scope, model_used,
        raw_bytes, sent_bytes, compression_ratio, mode, status, ts)
      VALUES (?, 'local', ?, ?, ?, ?, ?, ?, 'complete', ?)
    `).run(
      'query',
      config.mode === 'local' ? 'local' : 'cloud',
      opts.cloudModel || config.localModel,
      stats.rawBytes,
      stats.sentBytes,
      stats.compressionRatio,
      config.mode,
      Date.now()
    );
  } catch {}

  return {
    response,
    mode: config.mode,
    stats: { ...stats, latencyMs },
  };
}

// ============================================================
// Batch summarization — for context building (router, recall)
// ============================================================

/**
 * Build a privacy-safe context string from raw events.
 * In hybrid mode: summarizes each chunk locally.
 * In cloud mode: just anonymizes.
 * In local mode: passes through (it's staying local anyway).
 */
export async function buildSafeContext(events, opts = {}) {
  const config = getC2DConfig();

  if (config.mode === 'local') {
    // Local mode — raw data stays local, no transformation needed
    return events.map(e => {
      const data = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
      return `[${e.event_type}] ${data}`;
    }).join('\n');
  }

  // Hybrid or cloud — anonymize at minimum
  const chunks = events.map(e => {
    const data = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
    return anonymizeForAI(`[${e.event_type}] ${data}`);
  });

  if (config.mode === 'hybrid' && chunks.join('\n').length > 2000) {
    // Summarize the anonymized chunks locally before cloud use
    const raw = chunks.join('\n');
    const { summary } = await localSummarize(raw, config.localModel);
    return summary;
  }

  return chunks.join('\n');
}

// ============================================================
// Stats
// ============================================================
export function getC2DStats() {
  const now = Date.now();
  const day = now - 86400000;

  try {
    const today = db.prepare(`
      SELECT
        COUNT(*) as total_jobs,
        SUM(raw_bytes) as total_raw_bytes,
        SUM(sent_bytes) as total_sent_bytes,
        AVG(compression_ratio) as avg_compression,
        SUM(CASE WHEN mode = 'local' THEN 1 ELSE 0 END) as local_jobs,
        SUM(CASE WHEN mode = 'hybrid' THEN 1 ELSE 0 END) as hybrid_jobs,
        SUM(CASE WHEN mode = 'cloud' THEN 1 ELSE 0 END) as cloud_jobs
      FROM c2d_jobs WHERE ts >= ?
    `).get(day);

    const savedBytes = (today?.total_raw_bytes || 0) - (today?.total_sent_bytes || 0);

    return {
      today: { ...today, saved_bytes: savedBytes },
      config: getC2DConfig(),
    };
  } catch {
    return { today: {}, config: getC2DConfig() };
  }
}
