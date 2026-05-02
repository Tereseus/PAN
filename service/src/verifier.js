// PAN Benchmark Verifier — Atlas v2, Step 7
//
// Acts as the independent Verifier agent in the Executor + Verifier two-agent framework.
// Receives executor results and independently judges pass/fail in an isolated context
// (separate Claude call, fresh prompt with no executor bias).
//
// Usage:
//   import { verify } from './verifier.js';
//   const verdict = await verify('intuition', executorResult);
//   // → { verified: bool, reason: string, confidence: 0-10, agree: bool }

import { claude } from './llm.js';
import { get } from './db.js';

// ── Suite descriptions (what each suite is testing) ──────────────────────────
const SUITE_DESCRIPTIONS = {
  intuition:     'Routes voice commands correctly, fast response, clear and natural replies',
  dream:         'Memory consolidation quality — coherent, novel, accurate',
  memory:        'Stores and recalls 10 facts accurately',
  scout:         'Research quality — relevant findings, sufficient count',
  augur:         'Event classification accuracy',
  identity:      'Session isolation — no cross-session data leakage',
  sensor:        'Uses sensor context in responses',
  pipeline:      'End-to-end latency within model-tier floors',
  orchestration: 'Handles multi-step tasks successfully',
  evolution:     'Memory decay correct, relevance improving over time',
  privacy:       'Zero cross-incognito data leakage (HARD GATE)',
  context:       'Session context relevance and coverage',
};

// ── Verifier model — same judge model as benchmark, configurable ──────────────
function getVerifierModel() {
  try {
    const row = get("SELECT value FROM settings WHERE key = 'job_models'");
    if (row) {
      const jobModels = JSON.parse(row.value);
      if (jobModels['benchmark_verifier']) return jobModels['benchmark_verifier'];
      if (jobModels['benchmark_judge'])    return jobModels['benchmark_judge'];
    }
  } catch {}
  return 'claude-sonnet-4-5-20250514';
}

// ── Build a clean, bias-free verifier prompt ─────────────────────────────────
function buildVerifierPrompt(suite, executorResult) {
  const desc = SUITE_DESCRIPTIONS[suite] || `Tests the "${suite}" capability`;
  const { scores = {}, passed, details = {} } = executorResult;

  // Summarise scores as key: value pairs — keep it compact
  const scoreLines = Object.entries(scores)
    .map(([k, v]) => `  ${k}: ${typeof v === 'number' ? v.toFixed(2) : v}`)
    .join('\n');

  // Summarise details — only include the first 10 keys to stay under token budget
  const detailKeys = Object.keys(details).slice(0, 10);
  const detailLines = detailKeys.length > 0
    ? detailKeys.map(k => `  ${k}: ${JSON.stringify(details[k])}`).join('\n')
    : '  (none)';

  return `You are an independent benchmark auditor. Your job is to verify whether a benchmark result is credible and whether the pass/fail verdict is correct.

SUITE: ${suite}
DESCRIPTION: ${desc}

EXECUTOR VERDICT: ${passed ? 'PASSED' : 'FAILED'}

SCORES:
${scoreLines || '  (none)'}

DETAILS (sample):
${detailLines}

Based solely on the scores and details above — without assuming the executor was correct — give your independent verdict.

Respond ONLY with a JSON object in this exact format (no extra text):
{"verified": true|false, "reason": "one sentence", "confidence": 0-10, "agree": true|false}

- "verified": true if the result looks legitimate and the scores support the verdict
- "reason": brief explanation of your assessment
- "confidence": 0-10 how confident you are in your own verdict
- "agree": true if you agree with the executor's pass/fail verdict, false if you disagree`;
}

// ── Parse the model's response for a JSON verdict ────────────────────────────
function parseVerdict(raw) {
  try {
    // Strip thinking tags if present
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const m = cleaned.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    return {
      verified:   typeof j.verified   === 'boolean' ? j.verified   : false,
      reason:     typeof j.reason     === 'string'  ? j.reason     : 'no reason given',
      confidence: typeof j.confidence === 'number'  ? Math.max(0, Math.min(10, j.confidence)) : 5,
      agree:      typeof j.agree      === 'boolean' ? j.agree      : true,
    };
  } catch {
    return null;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Independently verifies a benchmark result.
 *
 * @param {string} suite          - Suite name (e.g. 'intuition')
 * @param {object} executorResult - Result from runBenchmark() — { scores, passed, details, ... }
 * @returns {Promise<{verified: boolean, reason: string, confidence: number, agree: boolean}>}
 */
export async function verify(suite, executorResult) {
  const fallback = { verified: false, reason: 'verifier error', confidence: 0, agree: false };
  try {
    const prompt = buildVerifierPrompt(suite, executorResult);
    const raw = await claude(prompt, {
      caller:    'benchmark-verifier',
      model:     getVerifierModel(),
      maxTokens: 300,
      timeout:   30000,
    });
    const verdict = parseVerdict(raw);
    if (!verdict) {
      console.warn('[PAN Verifier] Could not parse verdict from model response');
      return fallback;
    }
    return verdict;
  } catch (e) {
    console.error('[PAN Verifier] verify() error:', e.message);
    return fallback;
  }
}
