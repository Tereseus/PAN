// PAN Benchmark API
//
// POST /api/v1/ai/benchmark   — run a benchmark suite, store results, return scores
// GET  /dashboard/api/benchmarks — last 10 runs per suite

import { Router } from 'express';
import { all } from '../db.js';
import { runIntuitionBenchmark } from '../benchmark.js';

export const benchmarkApiRouter = Router();
export const benchmarkDashRouter = Router();

// POST /api/v1/ai/benchmark
// Body: { suite: 'intuition', model: 'cerebras:qwen-3-235b' }
benchmarkApiRouter.post('/benchmark', async (req, res) => {
  const { suite = 'intuition', model = 'cerebras:qwen-3-235b' } = req.body || {};

  if (suite !== 'intuition') {
    return res.status(400).json({ ok: false, error: `Unknown suite: ${suite}. Supported: intuition` });
  }

  try {
    console.log(`[PAN Benchmark] /api/v1/ai/benchmark called — suite=${suite} model=${model}`);
    const result = await runIntuitionBenchmark(model);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[PAN Benchmark] Run failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /dashboard/api/benchmarks
// Returns last 10 runs per suite
benchmarkDashRouter.get('/benchmarks', (req, res) => {
  try {
    const runs = all(
      `SELECT id, suite, model, scores, passed, details, ran_at
       FROM ai_benchmark
       ORDER BY ran_at DESC
       LIMIT 50`
    );
    // Parse JSON columns
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
