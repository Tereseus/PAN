// Render PAN's memory as browsable markdown.
//
// WHY: PAN captures a lot and shows almost none of it. Everything lives in
// SQLite behind similarity search, so the only way to find out what PAN knows
// is to ask it a question and hope recall surfaces the right row. This writes
// the same data out as files you can open, scroll, and grep.
//
// DERIVED, NOT AUTHORITATIVE. Every file here is regenerated from the database
// on each run. Nothing reads it back, nothing edits it by hand. The moment a
// wiki like this becomes writable you have two sources of truth that drift, and
// the drift is silent. Delete the folder any time; it rebuilds.
//
// DELIBERATELY NO LLM. The Karpathy-style approach has a model rewrite raw
// material into polished articles. That is the expensive half, and the Gemini
// free tier caps at 500 requests/day — which it hit on 2026-08-10 and took
// voice down with it. A structural render costs nothing and answers the
// question "what is in here" just as well. The prose layer can come later if
// it earns its cost.

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { all, get, DB_PATH } from '../db.js';

/** Default output: a `wiki/` folder next to pan.db, so it travels with the data. */
export function defaultWikiDir() {
  return join(dirname(DB_PATH), 'wiki');
}

const MAX_ROWS = 400;   // per section — enough to browse, small enough to open

function esc(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').trim();
}

function trunc(s, n) {
  const t = esc(s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function safeAll(sql, params = {}) {
  try { return all(sql, params) || []; } catch { return []; }
}

function safeCount(table) {
  try { return get(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0; } catch { return null; }
}

function section(title, rows, header, toRow) {
  const out = [`# ${title}`, ''];
  if (!rows.length) {
    out.push('_Nothing recorded yet._', '');
    return out.join('\n');
  }
  out.push(`${rows.length} entries.`, '');
  out.push('| ' + header.join(' | ') + ' |');
  out.push('|' + header.map(() => '---').join('|') + '|');
  for (const r of rows) out.push('| ' + toRow(r).join(' | ') + ' |');
  out.push('');
  return out.join('\n');
}

/**
 * Regenerate the whole wiki.
 * @param {string} dir target directory (created if missing)
 * @returns {{dir: string, files: string[], counts: object}}
 */
export function generateWiki(dir = defaultWikiDir()) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  const write = (name, body) => { writeFileSync(join(dir, name), body, 'utf8'); files.push(name); };

  const counts = {
    events: safeCount('events'),
    semantic_facts: safeCount('semantic_facts'),
    episodic_memories: safeCount('episodic_memories'),
    procedural_memories: safeCount('procedural_memories'),
    event_embeddings: safeCount('event_embeddings'),
    project_tasks: safeCount('project_tasks'),
  };

  // ── facts ────────────────────────────────────────────────────────────────
  const facts = safeAll(
    `SELECT subject, predicate, object, confidence, updated_at
       FROM semantic_facts
      ORDER BY COALESCE(updated_at, created_at) DESC LIMIT :n`, { ':n': MAX_ROWS });
  write('facts.md', section(
    'Semantic facts', facts,
    ['Subject', 'Predicate', 'Object', 'Conf', 'Updated'],
    (r) => [trunc(r.subject, 40), trunc(r.predicate, 30), trunc(r.object, 60),
            r.confidence != null ? Number(r.confidence).toFixed(2) : '', esc(r.updated_at)]));

  // ── episodes ─────────────────────────────────────────────────────────────
  const eps = safeAll(
    `SELECT summary, outcome, importance, created_at
       FROM episodic_memories
      ORDER BY importance DESC, created_at DESC LIMIT :n`, { ':n': MAX_ROWS });
  write('episodes.md', section(
    'Episodic memories', eps,
    ['Importance', 'Summary', 'Outcome', 'When'],
    (r) => [r.importance != null ? Number(r.importance).toFixed(2) : '',
            trunc(r.summary, 90), trunc(r.outcome, 50), esc(r.created_at)]));

  // ── procedures ───────────────────────────────────────────────────────────
  const procs = safeAll(
    `SELECT * FROM procedural_memories ORDER BY rowid DESC LIMIT :n`, { ':n': MAX_ROWS });
  write('procedures.md', section(
    'Procedural memories', procs,
    ['Entry', 'When'],
    (r) => [trunc(r.name || r.title || r.summary || r.content || JSON.stringify(r), 110),
            esc(r.updated_at || r.created_at || '')]));

  // ── decisions ────────────────────────────────────────────────────────────
  // Decisions are logged as events of type 'Decision' (db.js logDecision), not
  // their own table. Worth surfacing separately: a decision plus its rationale
  // is the highest-signal thing PAN records.
  const decisions = safeAll(
    `SELECT data, created_at FROM events
      WHERE event_type = 'Decision' ORDER BY id DESC LIMIT :n`, { ':n': MAX_ROWS });
  write('decisions.md', section(
    'Decisions', decisions,
    ['Decision', 'Rationale', 'When'],
    (r) => {
      let d = {};
      try { d = JSON.parse(r.data || '{}'); } catch {}
      return [trunc(d.decision, 70), trunc(d.rationale, 70), esc(r.created_at)];
    }));

  // ── what PAN is actually capturing ───────────────────────────────────────
  const byType = safeAll(
    `SELECT event_type, COUNT(*) AS n, MAX(created_at) AS last_seen
       FROM events GROUP BY event_type ORDER BY n DESC LIMIT 60`);
  write('capture.md', section(
    'What PAN is capturing', byType,
    ['Event type', 'Count', 'Last seen'],
    (r) => [esc(r.event_type), String(r.n), esc(r.last_seen)]));

  // ── index ────────────────────────────────────────────────────────────────
  const idx = [
    '# PAN memory',
    '',
    `Generated ${new Date().toISOString()}. Derived from the database — regenerate any time, never edit by hand.`,
    '',
    '| Layer | Rows | File |',
    '|---|---|---|',
    `| Raw events | ${counts.events ?? '?'} | [capture.md](capture.md) |`,
    `| Embedded events | ${counts.event_embeddings ?? '?'} | (vector index) |`,
    `| Semantic facts | ${counts.semantic_facts ?? '?'} | [facts.md](facts.md) |`,
    `| Episodic memories | ${counts.episodic_memories ?? '?'} | [episodes.md](episodes.md) |`,
    `| Procedural memories | ${counts.procedural_memories ?? '?'} | [procedures.md](procedures.md) |`,
    `| Decisions | ${decisions.length} shown | [decisions.md](decisions.md) |`,
    `| Project tasks | ${counts.project_tasks ?? '?'} | — |`,
    '',
    '## Coverage',
    '',
  ];
  // Embedding coverage is the number that tells you whether semantic recall can
  // actually work. It quietly degrades to FTS-only when this falls behind.
  if (counts.events && counts.event_embeddings != null) {
    const pct = counts.events ? (counts.event_embeddings / counts.events * 100) : 0;
    idx.push(`Embedding coverage: **${pct.toFixed(1)}%** (${counts.event_embeddings} of ${counts.events}).`);
    if (pct < 90) idx.push('', '> Below 90%. Semantic search silently falls back to full-text for anything unembedded.');
  }
  idx.push('');
  write('index.md', idx.join('\n'));

  return { dir, files, counts };
}
