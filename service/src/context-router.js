// Context-Aware Router for PAN
//
// The final piece of the privacy pipeline. Uses sensitivity tags from
// the classifier to decide HOW to process each request:
//
//   Sensitivity 0 (public)   → Any model: Cerebras, Claude, cloud. Fast path.
//   Sensitivity 1 (internal) → Cloud OK but context is filtered. No raw events sent.
//   Sensitivity 2 (sensitive)→ Hybrid: local summarize → anonymized summary to cloud.
//   Sensitivity 3 (critical) → Local-only: Ollama. Nothing leaves the machine.
//
// This module wraps the existing router.js and llm.js calls,
// intercepting the model selection based on content sensitivity.

import { classify, classifyFast, sensitivityLabel } from './sensitivity.js';
import { queryWithPrivacy, buildSafeContext, getC2DConfig } from './compute-to-data.js';
import { scan as guardianScan } from './guardian.js';
import { db, get, run } from './db.js';

// ============================================================
// Schema
// ============================================================
function ensureRoutingSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS routing_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sensitivity INTEGER NOT NULL,
      sensitivity_label TEXT NOT NULL,
      route TEXT NOT NULL,
      model_selected TEXT,
      reason TEXT,
      guardian_decision TEXT,
      latency_ms INTEGER DEFAULT 0,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_routing_ts ON routing_decisions(ts);
  `);

  try {
    const existing = get("SELECT value FROM settings WHERE key = 'routing_enabled'");
    if (!existing) {
      run("INSERT OR IGNORE INTO settings (key, value) VALUES ('routing_enabled', '1')");
      run("INSERT OR IGNORE INTO settings (key, value) VALUES ('routing_local_model', 'qwen3:4b')");
      run("INSERT OR IGNORE INTO settings (key, value) VALUES ('routing_cloud_model', 'cerebras:qwen-3-235b')");
    }
  } catch {}
}

try { ensureRoutingSchema(); } catch (e) { console.error('[ContextRouter] Schema init error:', e.message); }

// ============================================================
// Config
// ============================================================
export function getRoutingConfig() {
  try {
    const enabled = get("SELECT value FROM settings WHERE key = 'routing_enabled'");
    const localModel = get("SELECT value FROM settings WHERE key = 'routing_local_model'");
    const cloudModel = get("SELECT value FROM settings WHERE key = 'routing_cloud_model'");
    return {
      enabled: enabled?.value !== '0',
      localModel: localModel?.value || 'qwen3:4b',
      cloudModel: cloudModel?.value || 'cerebras:qwen-3-235b',
    };
  } catch {
    return { enabled: true, localModel: 'qwen3:4b', cloudModel: 'cerebras:qwen-3-235b' };
  }
}

// ============================================================
// Route Selection — the core decision engine
// ============================================================

/**
 * Given a sensitivity level, determine routing parameters.
 */
function selectRoute(sensitivity, config) {
  switch (sensitivity) {
    case 3: // Critical — local only, no cloud, no context sharing
      return {
        route: 'local',
        model: config.localModel,
        contextMode: 'none',     // No context injection at all
        reason: 'Critical content — local-only processing',
      };
    case 2: // Sensitive — hybrid: local summarize → cloud gets anonymized summary
      return {
        route: 'hybrid',
        model: config.cloudModel,
        contextMode: 'summarized', // Local summarize before cloud
        reason: 'Sensitive content — anonymized summary to cloud',
      };
    case 1: // Internal — cloud OK but filtered context
      return {
        route: 'cloud',
        model: config.cloudModel,
        contextMode: 'filtered',   // Anonymize PII, keep structure
        reason: 'Internal content — filtered context to cloud',
      };
    case 0: // Public — any model, full context
    default:
      return {
        route: 'cloud',
        model: config.cloudModel,
        contextMode: 'full',       // No restrictions
        reason: 'Public content — full access',
      };
  }
}

// ============================================================
// Main: Route a request through the full privacy pipeline
// ============================================================

/**
 * Process a message through the complete privacy pipeline:
 * Guardian → Sensitivity → Route → C2D → Response
 *
 * @param {string} content — user message/query
 * @param {string} context — raw context (conversation history, events)
 * @param {object} opts
 * @param {string} [opts.source] — 'chat', 'voice', 'email', etc.
 * @param {string} [opts.caller] — who initiated
 * @param {boolean} [opts.fast] — skip LLM classification (pattern-only)
 * @returns {object} { response, routing, guardian, sensitivity, stats }
 */
export async function routeWithPrivacy(content, context, opts = {}) {
  const startMs = Date.now();
  const config = getRoutingConfig();

  if (!config.enabled) {
    // Routing disabled — pass through to default model
    return {
      response: null,
      routing: { route: 'passthrough', reason: 'Context routing disabled' },
      guardian: { allowed: true, decision: 'skipped' },
      sensitivity: { sensitivity: 0, method: 'skip' },
      stats: {},
    };
  }

  // Step 1: Guardian scan (blocks malicious content)
  const guardian = await guardianScan(content, {
    source: opts.source || 'router',
    caller: opts.caller || 'context-router',
  });

  if (!guardian.allowed) {
    return {
      response: null,
      routing: { route: 'blocked', reason: 'Guardian blocked content' },
      guardian,
      sensitivity: { sensitivity: 3, method: 'guardian' },
      stats: { latencyMs: Date.now() - startMs },
    };
  }

  // Step 2: Classify sensitivity
  const sensitivity = opts.fast
    ? classifyFast(content)
    : await classify(content, { fast: opts.fast });

  // Step 3: Select route based on sensitivity
  const route = selectRoute(sensitivity.sensitivity, config);

  // Step 4: Process through compute-to-data pipeline
  const result = await queryWithPrivacy(content, context, {
    cloudModel: route.model,
    caller: opts.caller || 'context-router',
  });

  const latencyMs = Date.now() - startMs;

  // Log the routing decision
  try {
    db.prepare(`
      INSERT INTO routing_decisions
        (sensitivity, sensitivity_label, route, model_selected, reason, guardian_decision, latency_ms, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sensitivity.sensitivity,
      sensitivityLabel(sensitivity.sensitivity),
      route.route,
      route.model,
      route.reason,
      guardian.decision,
      latencyMs,
      Date.now()
    );
  } catch {}

  return {
    response: result.response,
    routing: route,
    guardian,
    sensitivity,
    stats: {
      ...result.stats,
      totalLatencyMs: latencyMs,
      classifyMs: sensitivity.latencyMs || 0,
      guardianMs: guardian.latencyMs || 0,
    },
  };
}

// ============================================================
// Stats
// ============================================================
export function getRoutingStats() {
  const day = Date.now() - 86400000;
  try {
    const today = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN route = 'local' THEN 1 ELSE 0 END) as local_count,
        SUM(CASE WHEN route = 'hybrid' THEN 1 ELSE 0 END) as hybrid_count,
        SUM(CASE WHEN route = 'cloud' THEN 1 ELSE 0 END) as cloud_count,
        SUM(CASE WHEN route = 'blocked' THEN 1 ELSE 0 END) as blocked_count,
        AVG(latency_ms) as avg_latency_ms
      FROM routing_decisions WHERE ts >= ?
    `).get(day);

    const bySensitivity = db.prepare(`
      SELECT sensitivity_label, COUNT(*) as count
      FROM routing_decisions WHERE ts >= ?
      GROUP BY sensitivity_label ORDER BY count DESC
    `).all(day);

    return { today, bySensitivity, config: getRoutingConfig() };
  } catch {
    return { today: {}, bySensitivity: [], config: getRoutingConfig() };
  }
}
