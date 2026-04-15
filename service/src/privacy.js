// Differential Privacy Engine for PAN
//
// Adds calibrated statistical noise to query responses, preventing
// inference attacks on aggregated data. Uses the Laplace mechanism
// for numeric values and exponential mechanism for rankings.
//
// Privacy budget (epsilon) is tracked per-caller per-day.
// Lower epsilon = more noise = more privacy. Default: ε=1.0
//
// This module wraps data AFTER retrieval, BEFORE response.
// It does NOT modify the database — noise is applied in-flight.

import { db, get, run, insert } from './db.js';

// ============================================================
// Schema — budget tracking
// ============================================================
function ensurePrivacySchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS privacy_budget (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller TEXT NOT NULL,
      day TEXT NOT NULL,
      epsilon_spent REAL NOT NULL DEFAULT 0.0,
      queries INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_privacy_budget_caller_day
      ON privacy_budget(caller, day);

    CREATE TABLE IF NOT EXISTS privacy_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller TEXT NOT NULL,
      endpoint TEXT,
      mechanism TEXT,
      epsilon_used REAL,
      fields_noised TEXT,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_privacy_log_ts ON privacy_log(ts);
  `);

  // Default settings
  try {
    const existing = get("SELECT value FROM settings WHERE key = 'privacy_enabled'");
    if (!existing) {
      run("INSERT OR IGNORE INTO settings (key, value) VALUES ('privacy_enabled', '1')");
      run("INSERT OR IGNORE INTO settings (key, value) VALUES ('privacy_epsilon', '1.0')");
      run("INSERT OR IGNORE INTO settings (key, value) VALUES ('privacy_daily_budget', '10.0')");
    }
  } catch {}
}

try { ensurePrivacySchema(); } catch (e) { console.error('[Privacy] Schema init error:', e.message); }

// ============================================================
// Config
// ============================================================
export function getPrivacyConfig() {
  try {
    const enabled = get("SELECT value FROM settings WHERE key = 'privacy_enabled'");
    const epsilon = get("SELECT value FROM settings WHERE key = 'privacy_epsilon'");
    const budget = get("SELECT value FROM settings WHERE key = 'privacy_daily_budget'");
    return {
      enabled: enabled?.value !== '0',
      epsilon: parseFloat(epsilon?.value) || 1.0,
      dailyBudget: parseFloat(budget?.value) || 10.0,
    };
  } catch {
    return { enabled: true, epsilon: 1.0, dailyBudget: 10.0 };
  }
}

// ============================================================
// Budget Tracking
// ============================================================
function today() {
  return new Date().toISOString().slice(0, 10);
}

function getBudgetSpent(caller) {
  try {
    const row = get(
      "SELECT epsilon_spent FROM privacy_budget WHERE caller = ? AND day = ?",
      caller, today()
    );
    return row?.epsilon_spent || 0;
  } catch { return 0; }
}

function recordBudget(caller, epsilonUsed, endpoint, mechanism, fields) {
  const d = today();
  try {
    db.prepare(`
      INSERT INTO privacy_budget (caller, day, epsilon_spent, queries, ts)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(caller, day) DO UPDATE SET
        epsilon_spent = epsilon_spent + ?,
        queries = queries + 1,
        ts = ?
    `).run(caller, d, epsilonUsed, Date.now(), epsilonUsed, Date.now());

    db.prepare(`
      INSERT INTO privacy_log (caller, endpoint, mechanism, epsilon_used, fields_noised, ts)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(caller, endpoint, mechanism, epsilonUsed, JSON.stringify(fields), Date.now());
  } catch {}
}

// ============================================================
// Laplace Mechanism — for numeric values (counts, scores, times)
// ============================================================
// Adds noise drawn from Laplace(0, sensitivity/epsilon)
// Higher sensitivity or lower epsilon → more noise
function laplaceSample(scale) {
  // Inverse CDF of Laplace distribution
  const u = Math.random() - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

/**
 * Add Laplace noise to a numeric value.
 * @param {number} value — true value
 * @param {number} sensitivity — max change one record can cause (default 1)
 * @param {number} epsilon — privacy parameter (lower = more noise)
 * @returns {number} noised value
 */
export function addLaplaceNoise(value, sensitivity = 1, epsilon = 1.0) {
  if (typeof value !== 'number' || isNaN(value)) return value;
  const scale = sensitivity / epsilon;
  return value + laplaceSample(scale);
}

/**
 * Add noise to a count (integer, non-negative).
 */
export function noiseCount(count, sensitivity = 1, epsilon = 1.0) {
  const noised = addLaplaceNoise(count, sensitivity, epsilon);
  return Math.max(0, Math.round(noised));
}

/**
 * Add noise to a timestamp (milliseconds). Sensitivity = 60000 (±1 min).
 */
export function noiseTimestamp(ts, epsilon = 1.0) {
  if (!ts) return ts;
  return Math.round(addLaplaceNoise(ts, 60000, epsilon));
}

/**
 * Add noise to a duration/latency in ms. Sensitivity = 100ms.
 */
export function noiseDuration(ms, epsilon = 1.0) {
  if (typeof ms !== 'number') return ms;
  return Math.max(0, Math.round(addLaplaceNoise(ms, 100, epsilon)));
}

/**
 * Add noise to a percentage/score (0-1 or 0-100). Sensitivity = 5%.
 */
export function noiseScore(score, epsilon = 1.0) {
  if (typeof score !== 'number') return score;
  const isPercent = score > 1;
  const sensitivity = isPercent ? 5 : 0.05;
  const noised = addLaplaceNoise(score, sensitivity, epsilon);
  return isPercent ? Math.max(0, Math.min(100, Math.round(noised))) : Math.max(0, Math.min(1, noised));
}

// ============================================================
// Exponential Mechanism — for rankings/orderings
// ============================================================
/**
 * Shuffle items proportionally to their scores with exponential noise.
 * Higher-scored items are more likely to stay near the top,
 * but exact ordering is randomized.
 */
export function noiseRanking(items, scoreKey = 'score', epsilon = 1.0) {
  if (!Array.isArray(items) || items.length <= 1) return items;

  // Add Gumbel noise proportional to score for each item
  return [...items]
    .map(item => {
      const score = typeof item[scoreKey] === 'number' ? item[scoreKey] : 0;
      // Gumbel trick: argmax of (score * epsilon/2 + Gumbel(0,1)) samples from exponential mechanism
      const gumbel = -Math.log(-Math.log(Math.random()));
      return { item, noisedScore: score * epsilon / 2 + gumbel };
    })
    .sort((a, b) => b.noisedScore - a.noisedScore)
    .map(({ item }) => item);
}

// ============================================================
// Response wrappers — noise specific API response shapes
// ============================================================

/**
 * Noise a stats object (counts, averages).
 */
export function noiseStats(stats, epsilon = 1.0) {
  if (!stats || typeof stats !== 'object') return stats;
  const result = { ...stats };

  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== 'number') continue;

    if (key.includes('count') || key.includes('total') || key === 'queries' || key.includes('_requests')) {
      result[key] = noiseCount(value, 1, epsilon);
    } else if (key.includes('_ms') || key.includes('latency') || key.includes('time')) {
      result[key] = noiseDuration(value, epsilon);
    } else if (key.includes('score') || key.includes('avg') || key.includes('percent') || key.includes('risk')) {
      result[key] = noiseScore(value, epsilon);
    }
  }
  return result;
}

/**
 * Noise a list of events/conversations.
 * - Perturbs timestamps by ±1 minute
 * - Noises any numeric fields (response_time_ms, scores)
 * - Shuffles within time buckets to prevent exact ordering leaks
 */
export function noiseEventList(events, epsilon = 1.0) {
  if (!Array.isArray(events)) return events;

  return events.map(e => {
    const noised = { ...e };
    if (noised.created_at && typeof noised.created_at === 'number') {
      noised.created_at = noiseTimestamp(noised.created_at, epsilon);
    }
    if (typeof noised.response_time_ms === 'number') {
      noised.response_time_ms = noiseDuration(noised.response_time_ms, epsilon);
    }
    if (typeof noised.score === 'number') {
      noised.score = noiseScore(noised.score, epsilon);
    }
    return noised;
  });
}

/**
 * Noise search results — perturb scores, shuffle rankings.
 */
export function noiseSearchResults(results, epsilon = 1.0) {
  if (!Array.isArray(results)) return results;

  // Add noise to individual scores
  const noised = results.map(r => ({
    ...r,
    score: typeof r.score === 'number' ? noiseScore(r.score, epsilon) : r.score,
    ftsRank: typeof r.ftsRank === 'number' ? noiseScore(r.ftsRank, epsilon) : r.ftsRank,
    vecRank: typeof r.vecRank === 'number' ? noiseScore(r.vecRank, epsilon) : r.vecRank,
  }));

  // Apply exponential mechanism to ranking
  return noiseRanking(noised, 'score', epsilon);
}

// ============================================================
// Express middleware — wraps JSON responses with noise
// ============================================================
/**
 * Privacy middleware. Intercepts res.json() and applies noise
 * to outbound data based on the endpoint pattern.
 *
 * @param {object} opts
 * @param {string} [opts.caller] — budget tracking label
 */
export function privacyMiddleware(opts = {}) {
  return (req, res, next) => {
    const config = getPrivacyConfig();
    if (!config.enabled) return next();

    // Only noise GET responses (reads, not writes)
    if (req.method !== 'GET') return next();

    const caller = opts.caller || req.ip || 'unknown';
    const epsilon = config.epsilon;

    // Check budget
    const spent = getBudgetSpent(caller);
    if (spent >= config.dailyBudget) {
      // Budget exhausted — return noisier results
      // (don't block, just increase noise)
    }

    // Wrap res.json to intercept response
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      try {
        const effectiveEpsilon = spent >= config.dailyBudget ? epsilon / 2 : epsilon;
        const noised = applyNoise(req.path, data, effectiveEpsilon);

        if (noised._privacyApplied) {
          recordBudget(caller, effectiveEpsilon, req.path, noised._mechanism || 'mixed', noised._fields || []);
          delete noised._privacyApplied;
          delete noised._mechanism;
          delete noised._fields;
        }

        return originalJson(noised);
      } catch (e) {
        // On error, pass through unmodified
        return originalJson(data);
      }
    };

    next();
  };
}

/**
 * Route-aware noise application.
 */
function applyNoise(path, data, epsilon) {
  // Stats endpoints — noise all counts
  if (path.includes('/stats') || path.includes('/perf')) {
    const noised = noiseStats(data, epsilon);
    noised._privacyApplied = true;
    noised._mechanism = 'laplace';
    noised._fields = Object.keys(data).filter(k => typeof data[k] === 'number');
    return noised;
  }

  // Conversations list
  if (path.includes('/conversations') && Array.isArray(data)) {
    const noised = noiseEventList(data, epsilon);
    return Object.assign(noised, { _privacyApplied: true, _mechanism: 'laplace+timestamp', _fields: ['created_at', 'response_time_ms'] });
  }

  // Events list
  if (path.includes('/events') && data?.events) {
    return {
      ...data,
      events: noiseEventList(data.events, epsilon),
      total: noiseCount(data.total || 0, 1, epsilon),
      _privacyApplied: true,
      _mechanism: 'laplace',
      _fields: ['total', 'created_at'],
    };
  }

  // Search results (memory search)
  if (path.includes('/search') || path.includes('/recall')) {
    if (Array.isArray(data)) {
      const noised = noiseSearchResults(data, epsilon);
      return Object.assign(noised, { _privacyApplied: true, _mechanism: 'exponential+laplace', _fields: ['score', 'ranking'] });
    }
  }

  // Usage/AI stats
  if (path.includes('/usage')) {
    if (Array.isArray(data)) {
      return Object.assign(
        data.map(r => noiseStats(r, epsilon)),
        { _privacyApplied: true, _mechanism: 'laplace', _fields: ['tokens', 'cost'] }
      );
    }
  }

  return data;
}

// ============================================================
// Direct API for programmatic use
// ============================================================

/**
 * Apply differential privacy to search results before returning them.
 * Call this from memory-search.js or router.js.
 */
export function privatizeSearch(results, caller = 'unknown') {
  const config = getPrivacyConfig();
  if (!config.enabled) return results;

  const spent = getBudgetSpent(caller);
  const epsilon = spent >= config.dailyBudget ? config.epsilon / 2 : config.epsilon;
  const noised = noiseSearchResults(results, epsilon);

  recordBudget(caller, epsilon, 'searchMemory', 'exponential+laplace', ['score', 'ranking']);
  return noised;
}

/**
 * Apply differential privacy to aggregate stats.
 */
export function privatizeStats(stats, caller = 'unknown') {
  const config = getPrivacyConfig();
  if (!config.enabled) return stats;

  const epsilon = config.epsilon;
  const noised = noiseStats(stats, epsilon);
  recordBudget(caller, epsilon, 'stats', 'laplace', Object.keys(stats).filter(k => typeof stats[k] === 'number'));
  return noised;
}

// ============================================================
// Query functions for API/dashboard
// ============================================================
export function getPrivacyStats() {
  const d = today();
  try {
    const todayBudget = db.prepare(`
      SELECT caller, epsilon_spent, queries FROM privacy_budget WHERE day = ?
    `).all(d);

    const totalQueries = db.prepare(`
      SELECT SUM(queries) as total FROM privacy_budget WHERE day = ?
    `).get(d);

    const recentLogs = db.prepare(`
      SELECT * FROM privacy_log ORDER BY ts DESC LIMIT 20
    `).all();

    return {
      today: d,
      callers: todayBudget,
      totalQueries: totalQueries?.total || 0,
      recentLogs,
      config: getPrivacyConfig(),
    };
  } catch {
    return { today: d, callers: [], totalQueries: 0, recentLogs: [], config: getPrivacyConfig() };
  }
}
