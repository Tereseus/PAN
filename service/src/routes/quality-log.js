// Paean Records — Quality Log scoring service.
//
// Implements the multi-criteria decision analysis (MCDA) scoring from
// `%USERPROFILE%\Desktop\Me stuff\Paean\song-creation-mathematics.md`.
// The MCP server `quality-log-mcp.js` is a thin HTTP proxy over these routes,
// so the math is defined here in exactly one place.
//
// Three aggregations are computed at insert (section 2 of the spec):
//   q_avg = Σ wᵢxᵢ / Σ wᵢ              (compensatory — average flatters)
//   q_geo = (Π xᵢ^wᵢ)^(1/Σ wᵢ)         (Cobb-Douglas — collapses on a low dim)
//   q_min = min(xᵢ)                    (weakest link — strictest gate)
//
// The recommended gate is q_geo ≥ 8.5 (section 4: stop a round when a take
// crosses the threshold; that take becomes the seed for the next round).

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { all, get, run } from '../db.js';

const router = Router();

// ───────────────────── math ─────────────────────

const QUALITY_THRESHOLD_DEFAULT = 8.5;
const MIN_ROWS_FOR_WEIGHT_FIT   = 30;

// Ratings are 1..10. Clamp inside that range before scoring so a typo (0 or 11)
// can't produce a non-finite q_geo (0^w = 0; log(0) = -Infinity).
function clampRating(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  if (n < 1)  return 1;
  if (n > 10) return 10;
  return n;
}

// If weights aren't supplied, use equal weights across whichever dimensions the
// caller rated. We renormalise at compute time so the caller never has to.
function equalWeightsFor(dims) {
  const w = {};
  for (const d of dims) w[d] = 1;
  return w;
}

export function computeQ(ratings, weights) {
  if (!ratings || typeof ratings !== 'object') {
    throw new Error('ratings must be an object of { dimension: 1..10 }');
  }
  const dims = Object.keys(ratings);
  if (dims.length === 0) {
    throw new Error('ratings is empty — provide at least one dimension');
  }
  const w = weights && typeof weights === 'object' && Object.keys(weights).length
    ? weights
    : equalWeightsFor(dims);

  let wSum = 0;
  let avgNum = 0;
  let geoLogNum = 0;       // accumulate Σ wᵢ·ln(xᵢ) → exp at the end
  let minR = Infinity;

  for (const d of dims) {
    const x = clampRating(ratings[d]);
    if (x === null) throw new Error(`rating for "${d}" must be a number`);
    const wi = Number(w[d] ?? 0);
    if (!Number.isFinite(wi) || wi < 0) {
      throw new Error(`weight for "${d}" must be a non-negative number`);
    }
    if (wi === 0) {
      // Skip — dimension is rated but doesn't count this round.
      if (x < minR) minR = x;
      continue;
    }
    wSum     += wi;
    avgNum   += wi * x;
    geoLogNum += wi * Math.log(x);
    if (x < minR) minR = x;
  }

  if (wSum === 0) {
    throw new Error('all weights are zero — at least one dimension must carry weight');
  }

  const q_avg = avgNum / wSum;
  const q_geo = Math.exp(geoLogNum / wSum);
  const q_min = Number.isFinite(minR) ? minR : 0;

  // Round to 4dp so JSON stays compact; downstream regression doesn't need more.
  const round4 = (v) => Math.round(v * 10000) / 10000;
  return { q_avg: round4(q_avg), q_geo: round4(q_geo), q_min: round4(q_min) };
}

// ───────────────────── row shape ─────────────────────

function parseRow(r) {
  if (!r) return null;
  return {
    id:          r.id,
    created_at:  r.created_at,
    domain:      r.domain,
    genre:       r.genre,
    round_id:    r.round_id,
    iteration_n: r.iteration_n,
    ratings:     safeJSON(r.ratings),
    weights:     safeJSON(r.weights),
    q_avg:       r.q_avg,
    q_geo:       r.q_geo,
    q_min:       r.q_min,
    kept:        !!r.kept,
    seed_of:     r.seed_of,
    notes:       r.notes,
  };
}

function safeJSON(s) { try { return JSON.parse(s); } catch { return null; } }

// ───────────────────── routes ─────────────────────

// POST /api/v1/quality-log/compute  { ratings, weights? }
// Pure helper — no row inserted. Lets the UI preview before committing.
router.post('/compute', (req, res) => {
  try {
    const { ratings, weights } = req.body || {};
    res.json({ ok: true, ...computeQ(ratings, weights) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// POST /api/v1/quality-log/attempts
// Body: { domain, genre, round_id, iteration_n, ratings, weights?, kept?, seed_of?, notes? }
router.post('/attempts', (req, res) => {
  try {
    const b = req.body || {};
    if (!b.domain || !b.round_id || b.iteration_n == null || !b.ratings) {
      return res.status(400).json({
        ok: false,
        error: 'domain, round_id, iteration_n, and ratings are required',
      });
    }
    const weights = b.weights && Object.keys(b.weights).length
      ? b.weights
      : equalWeightsFor(Object.keys(b.ratings));
    const scores = computeQ(b.ratings, weights);
    const id = randomUUID();
    const now = Date.now();
    run(
      `INSERT INTO quality_log
         (id, created_at, domain, genre, round_id, iteration_n,
          ratings, weights, q_avg, q_geo, q_min, kept, seed_of, notes)
       VALUES
         (:id, :ts, :dom, :genre, :rid, :it,
          :ratings, :weights, :q_avg, :q_geo, :q_min, :kept, :seed_of, :notes)`,
      {
        ':id':      id,
        ':ts':      now,
        ':dom':     b.domain,
        ':genre':   b.genre || null,
        ':rid':     b.round_id,
        ':it':      b.iteration_n | 0,
        ':ratings': JSON.stringify(b.ratings),
        ':weights': JSON.stringify(weights),
        ':q_avg':   scores.q_avg,
        ':q_geo':   scores.q_geo,
        ':q_min':   scores.q_min,
        ':kept':    b.kept ? 1 : 0,
        ':seed_of': b.seed_of || null,
        ':notes':   b.notes || null,
      },
    );
    const row = parseRow(get('SELECT * FROM quality_log WHERE id = :id', { ':id': id }));
    res.json({ ok: true, row });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// GET /api/v1/quality-log/rounds/:round_id
// Returns every attempt in the round, the running best (highest q_geo, the
// recommended gate per the math doc), and whether the threshold was crossed.
router.get('/rounds/:round_id', (req, res) => {
  try {
    const rows = all(
      `SELECT * FROM quality_log
       WHERE round_id = :rid
       ORDER BY iteration_n ASC, created_at ASC`,
      { ':rid': req.params.round_id },
    ).map(parseRow);

    let best = null;
    for (const r of rows) if (!best || r.q_geo > best.q_geo) best = r;

    const threshold = Number(req.query.threshold) || QUALITY_THRESHOLD_DEFAULT;
    res.json({
      ok: true,
      round_id: req.params.round_id,
      threshold,
      threshold_crossed: !!best && best.q_geo >= threshold,
      best,
      attempts: rows,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/v1/quality-log/best-seed?round_id=...
// If round_id provided: highest q_geo within that round (or the kept attempt
// if one's been explicitly marked). Without round_id: highest q_geo overall
// among rows flagged kept=1, falling back to the global max q_geo.
router.get('/best-seed', (req, res) => {
  try {
    const { round_id } = req.query;
    let row;
    if (round_id) {
      row = get(
        `SELECT * FROM quality_log
         WHERE round_id = :rid AND kept = 1
         ORDER BY q_geo DESC LIMIT 1`,
        { ':rid': round_id },
      );
      if (!row) {
        row = get(
          `SELECT * FROM quality_log
           WHERE round_id = :rid
           ORDER BY q_geo DESC LIMIT 1`,
          { ':rid': round_id },
        );
      }
    } else {
      row = get(
        `SELECT * FROM quality_log
         WHERE kept = 1
         ORDER BY q_geo DESC LIMIT 1`,
      );
      if (!row) {
        row = get(
          `SELECT * FROM quality_log
           ORDER BY q_geo DESC LIMIT 1`,
        );
      }
    }
    res.json({ ok: true, row: parseRow(row) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/v1/quality-log/history?domain=...&genre=...&limit=...
router.get('/history', (req, res) => {
  try {
    const { domain, genre } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);

    const where = [];
    const params = { ':lim': limit };
    if (domain) { where.push('domain = :dom');   params[':dom']   = domain; }
    if (genre)  { where.push('genre  = :genre'); params[':genre'] = genre; }
    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = all(
      `SELECT * FROM quality_log
       ${whereSQL}
       ORDER BY created_at DESC
       LIMIT :lim`,
      params,
    ).map(parseRow);
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/v1/quality-log/fit-weights  { domain, genre? }
// Stub for the advanced math (section 7). Returns insufficient_data until the
// dataset is large enough to fit; that's where the regression lives later.
router.post('/fit-weights', (req, res) => {
  try {
    const { domain, genre } = req.body || {};
    if (!domain) {
      return res.status(400).json({ ok: false, error: 'domain is required' });
    }
    const where = ['domain = :dom'];
    const params = { ':dom': domain };
    if (genre) { where.push('genre = :genre'); params[':genre'] = genre; }
    const row = get(
      `SELECT COUNT(*) AS n FROM quality_log WHERE ${where.join(' AND ')}`,
      params,
    );
    const n = row?.n || 0;
    if (n < MIN_ROWS_FOR_WEIGHT_FIT) {
      return res.json({
        ok: true,
        status: 'insufficient_data',
        rows: n,
        rows_required: MIN_ROWS_FOR_WEIGHT_FIT,
        weights: null,
        note: 'Regression learned weights will replace guessed weights once enough data exists. See song-creation-mathematics.md section 7.',
      });
    }
    // Placeholder for when the dataset crosses the threshold. The real impl
    // would regress q_geo (or kept) on the per-dimension ratings.
    res.json({
      ok: true,
      status: 'not_implemented',
      rows: n,
      rows_required: MIN_ROWS_FOR_WEIGHT_FIT,
      weights: null,
      note: 'TODO: least-squares fit of weights from ratings → kept/q_geo outcomes.',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
