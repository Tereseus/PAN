// PAN Benchmark API
//
// POST /api/v1/ai/benchmark      — run a benchmark suite, store results, return scores
// GET  /dashboard/api/benchmarks — last 50 runs across all suites
// GET  /dashboard/api/benchmarks/latest — latest result per suite (summary view)

import { Router } from 'express';
import { all, get } from '../db.js';
import { runBenchmark, runBenchmarkWithVerification, BENCHMARK_SUITES } from '../benchmark.js';
import { panNotify } from '../pan-notify.js';

export const benchmarkApiRouter = Router();
export const benchmarkDashRouter = Router();

// GET /api/v1/ai/benchmark/floors — returns current floor values (debug)
benchmarkApiRouter.get('/benchmark/floors', async (req, res) => {
  try {
    const { BENCHMARK_SUITES } = await import('../benchmark.js');
    // Import the current floors via a small eval wrapper
    const bm = await import('../benchmark.js');
    res.json({ ok: true, suites: BENCHMARK_SUITES, note: 'floors are internal, check suite code' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/v1/ai/benchmark
// Body: { suite: 'intuition', model: 'cerebras:qwen-3-235b' }
// Query: ?verify=1  — run with independent Verifier agent (Atlas v2 two-agent framework)
benchmarkApiRouter.post('/benchmark', async (req, res) => {
  const { suite = 'intuition', model = 'cerebras:qwen-3-235b' } = req.body || {};
  const withVerification = req.query.verify === '1' || req.query.verify === 'true';

  if (!BENCHMARK_SUITES.includes(suite)) {
    return res.status(400).json({
      ok: false,
      error: `Unknown suite: "${suite}". Valid suites: ${BENCHMARK_SUITES.join(', ')}`
    });
  }

  try {
    if (withVerification) {
      console.log(`[PAN Benchmark] /api/v1/ai/benchmark?verify=1 — suite=${suite} model=${model}`);
      const result = await runBenchmarkWithVerification(suite, model);
      res.json({ ok: true, ...result });
    } else {
      console.log(`[PAN Benchmark] /api/v1/ai/benchmark — suite=${suite} model=${model}`);
      const result = await runBenchmark(suite, model);
      res.json({ ok: true, ...result });
    }
  } catch (e) {
    console.error('[PAN Benchmark] Run failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/v1/ai/benchmark/all
// Runs all suites sequentially — long-running, returns when done
benchmarkApiRouter.post('/benchmark/all', async (req, res) => {
  const { model = 'cerebras:qwen-3-235b' } = req.body || {};

  try {
    console.log(`[PAN Benchmark] Running all suites — model=${model}`);
    const results = {};
    for (const suite of BENCHMARK_SUITES) {
      console.log(`[PAN Benchmark] Running suite: ${suite}`);
      try {
        results[suite] = await runBenchmark(suite, model);
      } catch (e) {
        results[suite] = { ok: false, error: e.message, suite };
      }
    }
    const allPassed = Object.values(results).every(r => r.passed);
    const passed = Object.entries(results).filter(([,r]) => r.passed).map(([s]) => s);
    const failed = Object.entries(results).filter(([,r]) => !r.passed).map(([s]) => s);

    // Notify user via ΠΑΝ thread
    try {
      if (allPassed) {
        panNotify('Benchmark · 📊',
          `All ${BENCHMARK_SUITES.length} suites passed ✅`,
          `Full benchmark run completed. All suites passed.\n\n✅ ${passed.join(', ')}\n\nModel tested: ${model}`,
          { severity: 'info' }
        );
      } else {
        const scoreLines = failed.map(s => {
          const r = results[s];
          const scores = r.scores ? Object.entries(r.scores).map(([k,v]) => `${k}: ${v}`).join(', ') : 'no scores';
          return `• ${s}: ${scores}`;
        }).join('\n');
        panNotify('Benchmark · 📊',
          `${failed.length}/${BENCHMARK_SUITES.length} suite(s) below floor ⚠️`,
          `Benchmark run complete — some suites need attention.\n\n❌ Failed:\n${scoreLines}\n\n✅ Passed: ${passed.join(', ') || 'none'}\n\nModel: ${model}`,
          { severity: 'warning' }
        );
      }
    } catch (notifyErr) {
      console.warn('[Benchmark] panNotify failed:', notifyErr.message);
    }

    res.json({ ok: true, allPassed, results, model });
  } catch (e) {
    console.error('[PAN Benchmark] All-suite run failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /dashboard/api/benchmarks
// Returns last 50 runs across all suites
benchmarkDashRouter.get('/benchmarks', (req, res) => {
  try {
    const runs = all(
      `SELECT id, suite, model, scores, passed, details, ran_at
       FROM ai_benchmark
       ORDER BY ran_at DESC
       LIMIT 50`
    );
    const parsed = runs.map(r => ({
      ...r,
      scores:  JSON.parse(r.scores  || '{}'),
      details: JSON.parse(r.details || '{}'),
      passed:  !!r.passed,
    }));
    res.json({ ok: true, runs: parsed });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /dashboard/api/autodev/report
// AutoDev report: benchmark failures + scout topics + recommendations
benchmarkDashRouter.get('/autodev/report', (req, res) => {
  try {
    // Get latest result per suite
    const rows = all(
      `SELECT suite, scores, passed, details, ran_at
       FROM ai_benchmark
       WHERE id IN (SELECT MAX(id) FROM ai_benchmark GROUP BY suite)
       ORDER BY suite`
    );

    // Floors per axis (lower-is-better axes have negative sign convention here)
    const FLOORS = {
      hearing: 8, clarity: 9, reasoning: 9, memory: 8, voice: 8, composite: 8,
      coherence: 8, novelty: 8, accuracy: 8,
      store: 8, recall: 8, associative: 8,
      relevance: 8, coverage: 8, freshness: 8,
      pattern_det: 8, inference: 8,
      auth_accuracy: 9, persona_consistency: 8,
      hit_rate: 0.9, success_rate: 8,
      decay_ok: 0.8, bump_ok: 0.8,
      policy_ok: 1, scope_ok: 1,
    };
    const LOWER_IS_BETTER = new Set(['reflex_ms', 'e2e_pass', 'p50_ms', 'pipeline_p50_ms']);

    const failing_suites = [];
    const failing_axes = {};

    for (const row of rows) {
      if (!row.passed) {
        failing_suites.push(row.suite);
        const scores = JSON.parse(row.scores || '{}');
        const axes = {};
        for (const [k, v] of Object.entries(scores)) {
          if (typeof v !== 'number' || k === 'composite' || k === 'total' || k === 'successes') continue;
          if (LOWER_IS_BETTER.has(k)) continue; // skip lower-is-better (reflex_ms=260 is passing)
          const floor = FLOORS[k];
          if (floor !== undefined && v < floor) axes[k] = v;
        }
        if (Object.keys(axes).length > 0) failing_axes[row.suite] = axes;
      }
    }

    // Get autodev_config (scout topics + last failure)
    const configRow = get("SELECT value FROM settings WHERE key = 'autodev_config'");
    const config = configRow ? JSON.parse(configRow.value || '{}') : {};
    const scout_topics = config.scout_topics || [];
    const last_benchmark_failure = config.last_benchmark_failure || null;

    // Build recommendations: each failing axis gets a recommendation
    const AXIS_ACTIONS = {
      hearing: { action: 'fix', label: 'Improve STT garbled-text intent routing' },
      reasoning: { action: 'fix', label: 'Strengthen ambient speech detection in router' },
      memory: { action: 'research', label: 'Multi-turn conversation context handling' },
      voice: { action: 'research', label: 'Personality consistency across turns' },
      reflex_ms: { action: 'research', label: 'Reduce P50 latency below 400ms' },
      success_rate: { action: 'research', label: 'Multi-step orchestration — router handles one intent at a time' },
      coherence: { action: 'research', label: 'Dream cycle coherence' },
      relevance: { action: 'research', label: 'Context injection relevance' },
      hit_rate: { action: 'fix', label: 'Sensor context usage in responses' },
    };

    const recommendations = [];
    for (const [suite, axes] of Object.entries(failing_axes)) {
      for (const [axis, score] of Object.entries(axes)) {
        const rec = AXIS_ACTIONS[axis];
        if (rec) {
          recommendations.push({
            suite, axis, score,
            action: rec.action,
            label: rec.label,
          });
        }
      }
    }

    res.json({
      ok: true,
      suites_passing: rows.filter(r => r.passed).length,
      total_suites: BENCHMARK_SUITES.length,
      failing_suites,
      failing_axes,
      scout_topics,
      last_benchmark_failure,
      recommendations,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[AutoDev Report]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /dashboard/api/benchmarks/latest
// Returns the most recent result for each suite — compact summary for dashboard widget
benchmarkDashRouter.get('/benchmarks/latest', (req, res) => {
  try {
    // Single query — get the latest run per suite using GROUP BY
    const rows = all(
      `SELECT suite, id, model, scores, passed, ran_at
       FROM ai_benchmark
       WHERE id IN (
         SELECT MAX(id) FROM ai_benchmark GROUP BY suite
       )
       ORDER BY suite`
    );

    // Build lookup by suite name
    const bySuite = {};
    for (const row of rows) {
      bySuite[row.suite] = {
        ...row,
        scores: JSON.parse(row.scores || '{}'),
        passed: !!row.passed,
      };
    }

    // Fill in null for suites never run
    const latest = {};
    for (const suite of BENCHMARK_SUITES) {
      latest[suite] = bySuite[suite] || null;
    }

    const suites_run    = rows.length;
    const suites_passed = rows.filter(r => r.passed).length;
    res.json({ ok: true, latest, suites_run, suites_passed, total_suites: BENCHMARK_SUITES.length, suites: BENCHMARK_SUITES });
  } catch (e) {
    console.error('[Benchmark /latest]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
