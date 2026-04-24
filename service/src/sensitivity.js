// Real-Time Sensitivity Classifier for PAN
//
// Tags every inbound message with a sensitivity level ON INGEST,
// before it enters the events table. This drives downstream routing
// decisions (which AI tier handles it, what context it gets).
//
// Sensitivity levels:
//   0 — public    : Weather, time, general knowledge. No restrictions.
//   1 — internal  : Work discussions, project context. Keep within PAN.
//   2 — sensitive : Personal info, health, finance. Anonymize for cloud.
//   3 — critical  : Passwords, keys, legal, medical records. Local-only.
//
// Classification runs in two stages:
//   Fast: Regex patterns for instant classification (~0ms)
//   LLM:  Local model classifies ambiguous content (~200-500ms)
//
// The classifier does NOT block content — that's Guardian's job.
// It TAGS content so the routing layer knows how to handle it.

import { db, get, run } from './db.js';
import { askAI } from './llm.js';

// ============================================================
// Schema
// ============================================================
function ensureSensitivitySchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sensitivity_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER,
      content_hash TEXT,
      sensitivity INTEGER NOT NULL DEFAULT 0,
      categories TEXT DEFAULT '[]',
      confidence REAL DEFAULT 1.0,
      method TEXT NOT NULL DEFAULT 'pattern',
      model_used TEXT,
      latency_ms INTEGER DEFAULT 0,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sensitivity_event ON sensitivity_tags(event_id);
    CREATE INDEX IF NOT EXISTS idx_sensitivity_level ON sensitivity_tags(sensitivity);
    CREATE INDEX IF NOT EXISTS idx_sensitivity_ts ON sensitivity_tags(ts);
  `);

  try {
    const existing = get("SELECT value FROM settings WHERE key = 'sensitivity_enabled'");
    if (!existing) {
      run("INSERT OR IGNORE INTO settings (key, value) VALUES ('sensitivity_enabled', '1')");
      run("INSERT OR IGNORE INTO settings (key, value) VALUES ('sensitivity_model', 'cerebras:qwen-3-235b')");
    }
  } catch {}
}

try { ensureSensitivitySchema(); } catch (e) { console.error('[Sensitivity] Schema init error:', e.message); }

// ============================================================
// Config
// ============================================================
export function getSensitivityConfig() {
  try {
    const enabled = get("SELECT value FROM settings WHERE key = 'sensitivity_enabled'");
    const model = get("SELECT value FROM settings WHERE key = 'sensitivity_model'");
    return {
      enabled: enabled?.value !== '0',
      model: model?.value || 'cerebras:qwen-3-235b',
    };
  } catch {
    return { enabled: true, model: 'cerebras:qwen-3-235b' };
  }
}

// ============================================================
// Pattern-based fast classification (~0ms)
// ============================================================

// Level 3 — CRITICAL: must never leave the device
const CRITICAL_PATTERNS = [
  /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/i,
  /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*\S+/i,
  /\b(?:sk-|pk-|ghp_|gho_|glpat-|xox[bps]-)\S{10,}/,
  /\b(?:BEGIN\s+(?:RSA|DSA|EC|PGP)\s+PRIVATE\s+KEY)/i,
  /\b(?:PRIVATE\s+KEY|ssh-rsa\s+AAAA)/i,
  /\b(?:ssn|social\s+security)\s*[:=]?\s*\d{3}[- ]?\d{2}[- ]?\d{4}/i,
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/,
  /\b(?:medical\s+record|diagnosis|prescription|patient\s+id)/i,
  /\b(?:court\s+order|subpoena|legal\s+hold|attorney[- ]client)/i,
];

// Level 2 — SENSITIVE: anonymize before cloud
const SENSITIVE_PATTERNS = [
  /\b(?:salary|income|bank\s+account|routing\s+number|wire\s+transfer)/i,
  /\b(?:address|zip\s+code)\s*[:=]?\s*\d/i,
  /\b(?:date\s+of\s+birth|dob|birthday)\s*[:=]/i,
  /\b(?:passport|driver'?s?\s+license|id\s+number)/i,
  /\b(?:therapist|counselor|medication|symptom|blood\s+(?:pressure|sugar|test))/i,
  /\b(?:divorce|custody|arrest|bail|conviction|probation)/i,
  /\b(?:insurance|claim|policy\s+number)/i,
  /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/,
  /\b(?:\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})\b/,
];

// Level 1 — INTERNAL: keep within PAN ecosystem
const INTERNAL_PATTERNS = [
  /\b(?:project|sprint|milestone|roadmap|deadline|standup)/i,
  /\b(?:deploy|production|staging|rollback|hotfix|merge)/i,
  /\b(?:meeting|agenda|action\s+item|follow[- ]up)/i,
  /\b(?:TODO|FIXME|HACK|WORKAROUND)\b/,
  /\b(?:config|env|\.env|docker|kubernetes|k8s)/i,
  /\b(?:database|schema|migration|backup)/i,
];

function patternClassify(content) {
  const categories = [];
  let maxLevel = 0;

  for (const pattern of CRITICAL_PATTERNS) {
    if (pattern.test(content)) {
      maxLevel = 3;
      categories.push('critical');
      break;
    }
  }

  if (maxLevel < 3) {
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(content)) {
        maxLevel = Math.max(maxLevel, 2);
        categories.push('sensitive');
        break;
      }
    }
  }

  if (maxLevel < 2) {
    for (const pattern of INTERNAL_PATTERNS) {
      if (pattern.test(content)) {
        maxLevel = Math.max(maxLevel, 1);
        categories.push('internal');
        break;
      }
    }
  }

  return {
    sensitivity: maxLevel,
    categories: [...new Set(categories)],
    confidence: maxLevel > 0 ? 0.85 : 0.7,
    method: 'pattern',
  };
}

// ============================================================
// LLM classification — for ambiguous content
// ============================================================

const CLASSIFIER_PROMPT = `Classify the sensitivity of this message for a personal AI system. Respond with ONLY a JSON object.

{"sensitivity": 0, "categories": ["category1"], "confidence": 0.9}

Levels:
0 = public (weather, time, general knowledge)
1 = internal (work, projects, meetings)
2 = sensitive (personal info, health, finance, contact details)
3 = critical (passwords, keys, legal, medical records)

Categories: public, internal, work, personal, financial, health, legal, credentials, technical

Message:
"""
{CONTENT}
"""`;

async function llmClassify(content, model) {
  const truncated = content.slice(0, 1500);
  const prompt = CLASSIFIER_PROMPT.replace('{CONTENT}', truncated);

  try {
    const result = await askAI(prompt, {
      model,
      timeout: 10000,
      maxTokens: 100,
      caller: 'sensitivity',
    });

    const parsed = JSON.parse(result);
    return {
      sensitivity: Math.max(0, Math.min(3, parseInt(parsed.sensitivity) || 0)),
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
      confidence: Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0.5)),
      method: 'llm',
    };
  } catch {
    return { sensitivity: 1, categories: ['unknown'], confidence: 0.3, method: 'llm_error' };
  }
}

// ============================================================
// Main API
// ============================================================

/**
 * Classify content sensitivity in real-time.
 *
 * @param {string} content — text to classify
 * @param {object} opts
 * @param {number} [opts.eventId] — associated event ID
 * @param {boolean} [opts.fast] — skip LLM, pattern-only
 * @returns {object} { sensitivity, categories, confidence, method, latencyMs }
 */
export async function classify(content, opts = {}) {
  const startMs = Date.now();
  const config = getSensitivityConfig();

  if (!config.enabled || !content || content.trim().length < 3) {
    return { sensitivity: 0, categories: ['public'], confidence: 1.0, method: 'skip', latencyMs: 0 };
  }

  // Stage 1: Fast pattern match
  const fast = patternClassify(content);

  // If critical/sensitive, skip LLM — pattern is enough
  if (fast.sensitivity >= 2 || opts.fast) {
    const latencyMs = Date.now() - startMs;
    logTag(fast, opts.eventId, null, latencyMs);
    return { ...fast, latencyMs };
  }

  // Stage 2: LLM for ambiguous content
  const llm = await llmClassify(content, config.model);
  const latencyMs = Date.now() - startMs;

  // Take the HIGHER sensitivity
  const final = {
    sensitivity: Math.max(fast.sensitivity, llm.sensitivity),
    categories: [...new Set([...fast.categories, ...llm.categories])].filter(Boolean),
    confidence: fast.sensitivity > llm.sensitivity ? fast.confidence : llm.confidence,
    method: fast.sensitivity > llm.sensitivity ? 'pattern' : 'llm',
    latencyMs,
  };

  logTag(final, opts.eventId, config.model, latencyMs);
  return final;
}

/**
 * Fast classification — pattern-only, no LLM. For high-throughput paths.
 */
export function classifyFast(content) {
  if (!content || content.trim().length < 3) {
    return { sensitivity: 0, categories: ['public'], confidence: 1.0, method: 'skip' };
  }
  return patternClassify(content);
}

/**
 * Get sensitivity level label.
 */
export function sensitivityLabel(level) {
  return ['public', 'internal', 'sensitive', 'critical'][level] || 'unknown';
}

// ============================================================
// Logging
// ============================================================
function logTag(result, eventId, model, latencyMs) {
  try {
    db.prepare(`
      INSERT INTO sensitivity_tags
        (event_id, sensitivity, categories, confidence, method, model_used, latency_ms, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventId || null, result.sensitivity, JSON.stringify(result.categories), result.confidence, result.method, model || null, latencyMs || 0, Date.now());
  } catch {}
}

// ============================================================
// Query
// ============================================================
export function getTag(eventId) {
  try {
    return db.prepare(`SELECT * FROM sensitivity_tags WHERE event_id = ? ORDER BY ts DESC LIMIT 1`).get(eventId);
  } catch { return null; }
}

export function getSensitivityStats() {
  const day = Date.now() - 86400000;
  try {
    const today = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN sensitivity = 0 THEN 1 ELSE 0 END) as public_count,
        SUM(CASE WHEN sensitivity = 1 THEN 1 ELSE 0 END) as internal_count,
        SUM(CASE WHEN sensitivity = 2 THEN 1 ELSE 0 END) as sensitive_count,
        SUM(CASE WHEN sensitivity = 3 THEN 1 ELSE 0 END) as critical_count,
        AVG(latency_ms) as avg_latency_ms
      FROM sensitivity_tags WHERE ts >= ?
    `).get(day);

    return { today, config: getSensitivityConfig() };
  } catch {
    return { today: {}, config: getSensitivityConfig() };
  }
}
