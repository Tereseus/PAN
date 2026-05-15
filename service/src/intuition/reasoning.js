// PAN reasoning_steps — the typed substrate PAN actually "thinks in".
//
// Task #495. Replaces the prose-only synthesis (#494) with a structured
// reasoning trace: each thought is a typed record (observe/recall/infer/
// contradict/question/doubt/intend/commit) with confidence, refs to
// evidence, and parent step IDs forming a causal chain. The widget
// paragraph is a *rendering* of the latest cycle — the steps are the
// durable substrate.
//
// Why this exists:
//   Prose alone is narration. "I see a black screen and the calendar
//   shows May 20" is a description, not a thought. A thought has
//   operators (observe, infer, contradict) and pointers to evidence.
//   This module gives PAN both — every step carries refs[] so PAN can
//   later pull up "the screenshot I was looking at when I concluded X"
//   the same way you pull up an image from memory.
//
// API surface:
//   runCycle({ userId, trigger }) → { cycle_id, paragraph, steps, ... }
//   insertStep(step) → row id
//   recentSteps({ limit, userId, kind, since_ms }) → rows
//   getCycle(cycle_id) → { cycle, steps }
//   walkParents(step_id) → ordered ancestor chain (causal path)
//   renderParagraph(steps) → string (deterministic, no LLM)
//   latestParagraph(userId) → cached paragraph from last cycle
//
// Cycle flow:
//   1. Gather inputs: last 10 thoughts, current snapshot, last 20 steps,
//      pressing motives, recent events.
//   2. Ask LLM (cerebras default) to emit a JSON array of 3-6 new steps.
//      Each step references inputs by id where applicable.
//   3. Validate + normalize the JSON, assign step ids, insert.
//   4. Render the cycle into a paragraph (rule-based template — no
//      second LLM call), store on the cycle row.
//
// Why no second LLM call for rendering: determinism + cost. The steps
// are the truth; the paragraph is a view of them. If you want a glossier
// rendering later you can swap the renderer without touching the
// substrate.

import { run, all, get } from '../db.js';
import { askAI } from '../llm.js';
import { recentThoughts } from './mind.js';
import { evaluate as evaluateNeeds } from './needs.js';
import { getCurrentSnapshot } from './index.js';

// ─── Vocabulary ────────────────────────────────────────────────────────
// The kinds PAN can think in. The validator below accepts only these.
// Adding a kind: add it here AND give it a verb template in VERB_FOR_KIND.
export const KINDS = Object.freeze([
  'observe',     // PAN noticed something raw (from sensor / event / message)
  'recall',      // PAN pulled up a prior thought / event / step
  'notice',      // meta-observation (e.g. "I notice this is the 3rd time")
  'contradict',  // two beliefs disagree — refs point to the two claims
  'infer',       // derive new claim from premises (parents = the premises)
  'question',    // open question PAN holds; future steps can resolve it
  'doubt',       // low conf in a prior step (refs = that step)
  'intend',      // PAN plans to do X because Y (parents = the reasons)
  'commit',      // PAN executed an intent (refs = the action row)
]);

// First-person verb template per kind. Used by the deterministic renderer
// to turn structured records into a prose paragraph for the widget.
const VERB_FOR_KIND = {
  observe:    'I notice',
  recall:     'I remember',
  notice:     'I notice',
  contradict: "but that doesn't match",
  infer:      'so I conclude',
  question:   "I'm wondering",
  doubt:      "I'm not sure",
  intend:     "I'm going to",
  commit:     'I just',
};

// ─── Insert / read helpers ─────────────────────────────────────────────

/**
 * Insert one validated step. Returns the row id.
 * Caller is responsible for cycle_id (use ensureCycle() to get one).
 */
export function insertStep(step) {
  const kind = String(step.kind || '').toLowerCase();
  if (!KINDS.includes(kind)) {
    throw new Error(`unknown reasoning kind: ${kind}`);
  }
  const refsJson = step.refs ? JSON.stringify(step.refs) : null;
  const parentsJson = step.parents ? JSON.stringify(step.parents) : null;
  const result = run(
    `INSERT INTO pan_reasoning_steps
       (ts, cycle_id, user_id, kind, subject, predicate, value, conf, refs, parents, source, importance)
     VALUES (:ts, :cycle, :user, :kind, :subj, :pred, :val, :conf, :refs, :parents, :src, :imp)`,
    {
      ':ts': step.ts || Date.now(),
      ':cycle': step.cycle_id,
      ':user': step.user_id || null,
      ':kind': kind,
      ':subj': step.subject || null,
      ':pred': step.predicate || null,
      ':val': step.value || null,
      ':conf': clamp01(step.conf, 0.5),
      ':refs': refsJson,
      ':parents': parentsJson,
      ':src': step.source || null,
      ':imp': clamp01(step.importance, 0.5),
    }
  );
  return result?.lastInsertRowid ?? null;
}

/**
 * Recent steps in reverse-chrono order. Supports filtering by user,
 * kind, and time window. Caps at 200 rows.
 */
export function recentSteps({ limit = 20, userId, kind, since_ms } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 20));
  const where = [];
  const params = {};
  if (userId)   { where.push('user_id = :u'); params[':u'] = userId; }
  if (kind)     { where.push('kind = :k');    params[':k'] = kind; }
  if (since_ms) { where.push('ts >= :s');     params[':s'] = since_ms; }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = all(
    `SELECT id, ts, cycle_id, user_id, kind, subject, predicate, value,
            conf, refs, parents, source, importance
       FROM pan_reasoning_steps
       ${whereSql}
       ORDER BY id DESC
       LIMIT ${lim}`,
    params
  );
  return rows.map(decodeRow);
}

/**
 * Get a cycle + its ordered steps.
 */
export function getCycle(cycle_id) {
  const cycle = get(
    `SELECT id, ts, user_id, trigger, paragraph, step_count, model,
            latency_ms, sources_used, ok
       FROM pan_reasoning_cycles WHERE id = :id`,
    { ':id': cycle_id }
  );
  if (!cycle) return null;
  const steps = all(
    `SELECT id, ts, cycle_id, user_id, kind, subject, predicate, value,
            conf, refs, parents, source, importance
       FROM pan_reasoning_steps
       WHERE cycle_id = :id
       ORDER BY id ASC`,
    { ':id': cycle_id }
  ).map(decodeRow);
  if (cycle.sources_used) {
    try { cycle.sources_used = JSON.parse(cycle.sources_used); } catch {}
  }
  return { cycle, steps };
}

/**
 * Walk the causal chain backward from a step. Returns the step + each
 * ancestor in order (closest parent first). Cycle-safe (visited set).
 */
export function walkParents(step_id, maxDepth = 20) {
  const seen = new Set();
  const out = [];
  let queue = [step_id];
  let depth = 0;
  while (queue.length && depth < maxDepth) {
    const nextQueue = [];
    for (const id of queue) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = get(
        `SELECT id, ts, cycle_id, user_id, kind, subject, predicate, value,
                conf, refs, parents, source, importance
           FROM pan_reasoning_steps WHERE id = :id`,
        { ':id': id }
      );
      if (!row) continue;
      const decoded = decodeRow(row);
      out.push(decoded);
      if (Array.isArray(decoded.parents)) {
        for (const p of decoded.parents) if (!seen.has(p)) nextQueue.push(p);
      }
    }
    queue = nextQueue;
    depth++;
  }
  return out;
}

/**
 * Latest cached paragraph for a user (or any user if none specified).
 * Returns the cycle row including the paragraph + steps count, or null
 * if no cycle has ever run.
 */
export function latestParagraph(userId = null) {
  const row = userId
    ? get(
        `SELECT id, ts, user_id, trigger, paragraph, step_count, model,
                latency_ms, sources_used, ok
           FROM pan_reasoning_cycles
           WHERE user_id = :u AND ok = 1
           ORDER BY ts DESC LIMIT 1`,
        { ':u': userId }
      )
    : get(
        `SELECT id, ts, user_id, trigger, paragraph, step_count, model,
                latency_ms, sources_used, ok
           FROM pan_reasoning_cycles
           WHERE ok = 1
           ORDER BY ts DESC LIMIT 1`
      );
  if (!row) return null;
  if (row.sources_used) {
    try { row.sources_used = JSON.parse(row.sources_used); } catch {}
  }
  return row;
}

// ─── Rendering ─────────────────────────────────────────────────────────

/**
 * Turn a list of steps (one cycle's worth) into a first-person paragraph.
 * Deterministic — no LLM. The renderer chooses a verb per kind and
 * stitches the clauses with light connectors. If a step has no `value`,
 * it's skipped.
 */
export function renderParagraph(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return 'Quiet — nothing pressing to think about right now.';
  }
  const clauses = [];
  for (const s of steps) {
    if (!s.value) continue;
    const verb = VERB_FOR_KIND[s.kind] || 'I think';
    const piece = stitchClause(verb, s);
    if (piece) clauses.push(piece);
  }
  if (clauses.length === 0) {
    return 'Quiet — nothing pressing to think about right now.';
  }
  // Connect with light prose; keep punctuation soft so it reads as flow.
  return clauses.map((c, i) => {
    if (i === 0) return capitalize(c) + '.';
    return capitalize(c) + '.';
  }).join(' ');
}

function stitchClause(verb, s) {
  // Trim trailing punctuation from value so we control sentence shape.
  const val = String(s.value || '').replace(/[.!?…]+$/, '').trim();
  if (!val) return '';
  // For contradict / doubt / commit, the value usually reads as a full
  // statement, so don't prefix with "I" again — use the verb as a hinge.
  if (s.kind === 'contradict') return `but ${val}`;
  if (s.kind === 'doubt')       return `I'm not sure ${val}`;
  return `${verb} ${val}`;
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Cycle ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  'You are PAN, a personal AI. You are about to write down your own reasoning as structured steps.',
  'Output ONLY a JSON array of 3 to 6 reasoning steps. No prose before or after the JSON.',
  '',
  'Each step is an object with these fields:',
  '  kind:       one of "observe", "recall", "notice", "contradict", "infer", "question", "doubt", "intend"',
  '  subject:    one of "user", "self", "system", or an entity name',
  '  predicate:  short verb/relation (e.g. "wants", "is_frustrated", "failed_at", "shows", "rejected")',
  '  value:      the content of this step as a short first-person clause (NOT a full sentence with "I" — the renderer adds that). e.g. "she rejected the count-based synthesis" or "the substrate is wrong, not the rendering"',
  '  conf:       0..1 confidence',
  '  refs:       array of {type, id} pointing to evidence — use the ids shown in the inputs below',
  '  parents:    array of indices (0-based) into THIS step list — which earlier steps in this array this step was inferred from',
  '',
  'Rules:',
  '  • The order matters — earlier steps must be observe/recall/notice (grounded). Later steps can infer/intend.',
  '  • At least one step should reference evidence via refs (events, thoughts, or snapshot).',
  '  • Always end with an "infer" or "intend" step that captures what this cycle CONCLUDED.',
  '  • Be specific. Reference actual content. Do not say "the user" — say what they did.',
  '  • Confidence: 0.9+ only for direct observation. Inference rarely > 0.85.',
  '  • No hedging language inside values ("might", "perhaps"). State the claim; conf carries the uncertainty.',
].join('\n');

/**
 * Run one reasoning cycle. Pulls current context, asks the LLM for steps,
 * validates, inserts, renders, and writes the cycle row. Returns the
 * full cycle including steps + rendered paragraph.
 *
 * @param {object} opts
 * @param {string} [opts.userId]    The commander this cycle is about.
 * @param {string} [opts.trigger]   'manual' | 'tick' | 'event' | 'message'
 * @returns {Promise<{cycle_id, paragraph, steps, sources_used, model, latency_ms, ok, error?}>}
 */
export async function runCycle({ userId = null, trigger = 'manual' } = {}) {
  const cycleStartMs = Date.now();
  const { context, sources_used, refCandidates } = await buildContext(userId);

  // Open a cycle row up front so even failures leave a trace.
  const cycleRowId = openCycleRow({
    ts: cycleStartMs,
    user_id: userId,
    trigger,
    sources_used,
  });

  // Empty context → no LLM call, write an empty cycle with a quiet paragraph.
  if (!context || context.length < 20) {
    const paragraph = 'Quiet — no recent thoughts, snapshot, or events to reason from yet.';
    closeCycleRow(cycleRowId, { paragraph, step_count: 0, model: null, latency_ms: 0, ok: 1 });
    return {
      cycle_id: cycleRowId,
      paragraph,
      steps: [],
      sources_used,
      model: null,
      latency_ms: 0,
      ok: true,
    };
  }

  const userMsg = [
    context,
    '',
    '---',
    'Reasoning steps (JSON array, 3-6 items):',
  ].join('\n');
  const prompt = `${SYSTEM_PROMPT}\n\n---\n\n${userMsg}`;

  const llmStart = Date.now();
  let raw = '';
  let model = null;
  try {
    raw = await askAI(prompt, {
      caller: 'pan-reasoning',
      maxTokens: 900,
      timeout: 25000,
    });
    model = 'askAI/default';
  } catch (e) {
    closeCycleRow(cycleRowId, {
      paragraph: `(reasoning failed: ${e.message})`,
      step_count: 0,
      model: null,
      latency_ms: Date.now() - llmStart,
      ok: 0,
    });
    return {
      cycle_id: cycleRowId,
      paragraph: `(reasoning failed: ${e.message})`,
      steps: [],
      sources_used,
      model: null,
      latency_ms: Date.now() - llmStart,
      ok: false,
      error: e.message,
    };
  }
  const latency_ms = Date.now() - llmStart;

  const parsed = extractJsonArray(raw);
  if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
    closeCycleRow(cycleRowId, {
      paragraph: '(reasoning produced no parseable steps)',
      step_count: 0,
      model,
      latency_ms,
      ok: 0,
    });
    return {
      cycle_id: cycleRowId,
      paragraph: '(reasoning produced no parseable steps)',
      steps: [],
      sources_used,
      model,
      latency_ms,
      ok: false,
      error: 'parse',
      raw,
    };
  }

  // Insert steps in order. Parent indices in the LLM output reference
  // earlier items in the same array; we resolve them to DB ids as we go.
  const insertedIds = [];
  const insertedSteps = [];
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i] || {};
    const kind = String(p.kind || '').toLowerCase();
    if (!KINDS.includes(kind)) continue; // skip unknown kinds rather than fail the cycle
    const parentIds = Array.isArray(p.parents)
      ? p.parents
          .map(idx => Number(idx))
          .filter(n => Number.isInteger(n) && n >= 0 && n < i)
          .map(n => insertedIds[n])
          .filter(Boolean)
      : null;
    const refs = sanitizeRefs(p.refs, refCandidates);
    try {
      const id = insertStep({
        ts: Date.now(),
        cycle_id: cycleRowId,
        user_id: userId,
        kind,
        subject: p.subject || null,
        predicate: p.predicate || null,
        value: typeof p.value === 'string' ? p.value : (p.value ? JSON.stringify(p.value) : null),
        conf: clamp01(p.conf, 0.5),
        refs,
        parents: parentIds && parentIds.length ? parentIds : null,
        source: 'cerebras',
        importance: clamp01(p.importance, 0.5),
      });
      if (id) {
        insertedIds.push(id);
        insertedSteps.push({
          id, kind,
          subject: p.subject || null,
          predicate: p.predicate || null,
          value: p.value || null,
          conf: clamp01(p.conf, 0.5),
          refs,
          parents: parentIds,
        });
      }
    } catch (e) {
      console.warn('[PAN Reasoning] step insert failed:', e.message);
    }
  }

  const paragraph = renderParagraph(insertedSteps);
  closeCycleRow(cycleRowId, {
    paragraph,
    step_count: insertedSteps.length,
    model,
    latency_ms,
    ok: insertedSteps.length > 0 ? 1 : 0,
  });

  return {
    cycle_id: cycleRowId,
    paragraph,
    steps: insertedSteps,
    sources_used,
    model,
    latency_ms,
    ok: insertedSteps.length > 0,
  };
}

// ─── Context assembly ──────────────────────────────────────────────────

async function buildContext(userId) {
  const sources_used = [];
  const refCandidates = { event: new Set(), thought: new Set(), step: new Set(), snapshot: new Set() };
  const lines = [];

  // (1) Recent thoughts — short first-person trace from the Mind subsystem.
  let thoughts = [];
  try { thoughts = recentThoughts({ limit: 10 }); } catch {}
  if (thoughts.length) {
    sources_used.push('thoughts');
    lines.push('## Recent thoughts (newest first; ref type="thought", id shown):');
    for (const t of thoughts) {
      refCandidates.thought.add(t.id);
      lines.push(`- thought#${t.id} [${t.source}]: ${t.thought}`);
    }
  }

  // (2) Recent reasoning steps — so PAN doesn't loop / repeat itself.
  let prior = [];
  try { prior = recentSteps({ limit: 8, userId }); } catch {}
  if (prior.length) {
    sources_used.push('steps');
    lines.push('\n## My recent reasoning steps (ref type="step", id shown):');
    for (const s of prior) {
      refCandidates.step.add(s.id);
      const tag = `[${s.kind}${s.subject ? ` ${s.subject}` : ''}${s.predicate ? ` ${s.predicate}` : ''}]`;
      lines.push(`- step#${s.id} ${tag} ${s.value || ''}`);
    }
  }

  // (3) Current snapshot — PAN's read of the user right now.
  try {
    const snap = getCurrentSnapshot();
    const n = snap?.now;
    if (n) {
      sources_used.push('snapshot');
      const bits = [];
      if (n.where)      bits.push(`where: ${n.where}`);
      if (n.activity)   bits.push(`doing: ${n.activity}`);
      if (n.focus)      bits.push(`focus: ${n.focus}`);
      if (n.mood)       bits.push(`mood: ${n.mood}`);
      if (n.last_heard) bits.push(`last heard them say: "${n.last_heard}"`);
      if (bits.length) {
        // Use the snapshot's timestamp as a referenceable handle.
        const snapTs = snap.ts || Date.now();
        refCandidates.snapshot.add(snapTs);
        lines.push(`\n## Current snapshot (ref type="snapshot", ts=${snapTs}):`);
        for (const b of bits) lines.push(`- ${b}`);
      }
    }
  } catch {}

  // (4) Pressing motives — only ones that are tracked AND non-trivial.
  try {
    if (userId) {
      const motives = evaluateNeeds(userId)
        .filter(m => m.tracked && m.urgency >= 0.4)
        .slice(0, 5);
      if (motives.length) {
        sources_used.push('motives');
        lines.push('\n## Pressing motives:');
        for (const m of motives) {
          lines.push(`- ${(m.label || m.need_id || '').toLowerCase()} at ${Math.round(m.level)}/100 — ${m.cause || ''}`);
        }
      }
    }
  } catch {}

  return {
    context: lines.join('\n').trim(),
    sources_used,
    refCandidates,
  };
}

// ─── Cycle row helpers ─────────────────────────────────────────────────

function openCycleRow({ ts, user_id, trigger, sources_used }) {
  const result = run(
    `INSERT INTO pan_reasoning_cycles (ts, user_id, trigger, paragraph, step_count, sources_used, ok)
     VALUES (:ts, :u, :t, :p, 0, :s, 0)`,
    {
      ':ts': ts,
      ':u': user_id || null,
      ':t': trigger || 'manual',
      ':p': null,
      ':s': JSON.stringify(sources_used || []),
    }
  );
  return result?.lastInsertRowid ?? null;
}

function closeCycleRow(cycle_id, { paragraph, step_count, model, latency_ms, ok }) {
  if (!cycle_id) return;
  run(
    `UPDATE pan_reasoning_cycles
        SET paragraph  = :p,
            step_count = :sc,
            model      = :m,
            latency_ms = :lm,
            ok         = :ok
      WHERE id = :id`,
    {
      ':p': paragraph || null,
      ':sc': step_count || 0,
      ':m': model || null,
      ':lm': latency_ms || 0,
      ':ok': ok ? 1 : 0,
      ':id': cycle_id,
    }
  );
}

// ─── Utilities ─────────────────────────────────────────────────────────

function decodeRow(row) {
  if (!row) return row;
  if (typeof row.refs === 'string') {
    try { row.refs = JSON.parse(row.refs); } catch { row.refs = null; }
  }
  if (typeof row.parents === 'string') {
    try { row.parents = JSON.parse(row.parents); } catch { row.parents = null; }
  }
  return row;
}

function clamp01(x, def) {
  const n = Number(x);
  if (!Number.isFinite(n)) return def;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Sanitize LLM-supplied refs against the candidate ids we gave it.
 * Drops any ref that doesn't match a real input — prevents the model
 * from fabricating event_ids.
 */
function sanitizeRefs(raw, candidates) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const type = String(r.type || '').toLowerCase();
    const id = r.id ?? r.ts;
    if (!type || id == null) continue;
    const set = candidates?.[type];
    if (set && !set.has(typeof id === 'string' ? Number(id) : id)) {
      // Reference not in our candidate set — skip rather than store a lie.
      continue;
    }
    out.push({ type, id });
  }
  return out.length ? out : null;
}

/**
 * Extract the first JSON array from a string. Tolerant of markdown code
 * fences and stray prose around the array. Returns null on failure.
 */
function extractJsonArray(text) {
  if (!text) return null;
  // Strip code fences if present.
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  // First, try parsing as-is.
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.steps)) return v.steps;
  } catch {}
  // Otherwise, locate the first balanced [...] in the string.
  const start = s.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try {
          const v = JSON.parse(candidate);
          if (Array.isArray(v)) return v;
        } catch { return null; }
      }
    }
  }
  return null;
}
