// session-summary.js
//
// Builds a deterministic per-session recap row in `session_summaries` at
// SessionEnd. Replaces the prior approach where injectSessionContext pulled
// raw UserPromptSubmit/Stop events and re-injected whatever Claude last said —
// which fed back as "ΠΑΝ Remembers" on the next session and created a
// regurgitation loop (designed 2026-05-21, implemented 2026-05-22).
//
// Signals (all from DB — no LLM required for the core row):
//   - completed_todos: last TodoWrite snapshot's `completed` items
//   - commits: git commits during session window
//   - files_touched: paths from PreToolUse Edit/Write events
//   - tasks_closed: project_tasks moved to done/in_test in session window
//
// Optional polish: a single Cerebras qwen-3-235b call composes a natural-
// language paragraph from the structured data. Default ON, can be disabled per
// session via `recap_use_llm = '0'` setting or env CEREBRAS down.

import { run, get, all, insert } from './db.js';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { askAI } from './llm.js';

const RECAP_MODEL = 'cerebras:qwen-3-235b';

// ── DB migration: signal_hash column for #976 (skip re-polish when signals
// unchanged). Idempotent — duplicate-column error is swallowed. Same pattern
// used in service/src/client-manager.js.
(function runMigrations() {
  const migrations = [
    "ALTER TABLE session_summaries ADD COLUMN signal_hash TEXT",
  ];
  for (const sql of migrations) {
    try { run(sql); } catch {} // Ignore duplicate column errors
  }
})();

// Pull the last TodoWrite snapshot for this session and extract completed items.
function getCompletedTodos(sessionId) {
  try {
    const row = get(
      `SELECT data FROM events
       WHERE session_id = :sid AND event_type = 'PreToolUse'
         AND json_extract(data, '$.tool_name') = 'TodoWrite'
       ORDER BY created_at DESC LIMIT 1`,
      { ':sid': sessionId }
    );
    if (!row) return [];
    const d = JSON.parse(row.data);
    const todos = d?.tool_input?.todos || [];
    return todos
      .filter(t => t.status === 'completed')
      .map(t => t.content)
      .slice(0, 20);
  } catch {
    return [];
  }
}

// Git commits inside the session's time window for this cwd.
function getCommits(cwd, startedAt, endedAt) {
  if (!cwd) return [];
  try {
    const since = startedAt ? `--since="${startedAt}"` : '--since="6 hours ago"';
    const until = endedAt ? `--until="${endedAt}"` : '';
    const out = execSync(
      `git log ${since} ${until} --pretty=format:"%h|%s" -20`,
      { cwd, encoding: 'utf8', windowsHide: true, timeout: 5000 }
    );
    return out.split('\n').filter(Boolean).slice(0, 20).map(l => {
      const [sha, ...rest] = l.split('|');
      return { sha, subject: rest.join('|') };
    });
  } catch {
    return [];
  }
}

// Files touched (Edit, Write, NotebookEdit) in this session.
function getFilesTouched(sessionId) {
  try {
    const rows = all(
      `SELECT data FROM events
       WHERE session_id = :sid AND event_type = 'PreToolUse'
         AND json_extract(data, '$.tool_name') IN ('Edit','Write','NotebookEdit','MultiEdit')
       ORDER BY created_at ASC`,
      { ':sid': sessionId }
    );
    const seen = new Set();
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data);
        const fp = d?.tool_input?.file_path;
        if (fp && !seen.has(fp)) seen.add(fp);
      } catch {}
      if (seen.size >= 20) break;
    }
    return Array.from(seen);
  } catch {
    return [];
  }
}

// Tasks closed during the session window (project_tasks moved to done/in_test).
// Best-effort heuristic: tasks whose status was updated between startedAt and endedAt.
function getTasksClosed(projectId, startedAt, endedAt) {
  if (!projectId) return [];
  try {
    const rows = all(
      `SELECT id, title, status FROM project_tasks
       WHERE project_id = :pid
         AND status IN ('done','in_test')
         AND updated_at BETWEEN :s AND :e`,
      { ':pid': projectId, ':s': startedAt || '1970-01-01', ':e': endedAt || '2099-01-01' }
    );
    return rows.slice(0, 20).map(r => ({ id: r.id, title: r.title, new_status: r.status }));
  } catch {
    return [];
  }
}

// Deterministic text fallback when the LLM polish is unavailable.
export function renderDeterministic(s) {
  const parts = [];
  if (s.completed_todos?.length) {
    parts.push(`Completed: ${s.completed_todos.slice(0, 5).map(t => `“${t.substring(0, 80)}”`).join('; ')}`);
  }
  if (s.commits?.length) {
    parts.push(`Commits: ${s.commits.slice(0, 5).map(c => `${c.sha} ${c.subject.substring(0, 60)}`).join('; ')}`);
  }
  if (s.tasks_closed?.length) {
    parts.push(`Tasks closed: ${s.tasks_closed.slice(0, 5).map(t => `#${t.id} (${t.new_status})`).join(', ')}`);
  }
  if (s.files_touched?.length) {
    const top = s.files_touched.slice(0, 5).map(f => f.split(/[\\/]/).pop()).join(', ');
    parts.push(`Files: ${top}${s.files_touched.length > 5 ? ` (+${s.files_touched.length - 5} more)` : ''}`);
  }
  return parts.join('. ') || 'No notable activity recorded.';
}

// One Cerebras call to compose a natural-language paragraph from the
// structured data. Returns null if disabled or unavailable.
async function polishWithCerebras(structured) {
  try {
    const setting = get(`SELECT value FROM settings WHERE key = 'recap_use_llm'`);
    if (setting && String(setting.value) === '0') return null;
  } catch {}

  const prompt = `You are summarizing a coding session for a memory recap that will be shown to the user at the start of their NEXT session. Be concrete and short — one paragraph, max ~70 words. Lead with what shipped, then what's open. Do NOT use bullet points. Do NOT start with "In this session" or "We". Just state what happened.

Data:
- Completed todos: ${JSON.stringify(structured.completed_todos || [])}
- Git commits: ${JSON.stringify((structured.commits || []).map(c => c.subject))}
- Files touched: ${JSON.stringify(structured.files_touched || [])}
- Tasks closed: ${JSON.stringify((structured.tasks_closed || []).map(t => `#${t.id} ${t.title} → ${t.new_status}`))}

One paragraph, no lists, no preamble. Just the recap text.`;

  try {
    const text = await askAI(prompt, {
      model: RECAP_MODEL,
      timeout: 10000,
      maxTokens: 300,
      caller: 'session-recap',
      _skipAnonymize: true,
    });
    if (typeof text === 'string' && text.trim().length > 10) {
      return text.trim().substring(0, 800);
    }
    return null;
  } catch (err) {
    console.error('[session-summary] Cerebras polish failed:', err?.message);
    return null;
  }
}

// Main entry. Idempotent — re-running for the same session_id replaces the row.
export async function buildSessionSummary(sessionId, cwd, orgId = 'org_personal', opts = {}) {
  if (!sessionId) return null;

  try {
    // Session window
    const session = get(
      `SELECT id, started_at, ended_at FROM sessions WHERE id = :id`,
      { ':id': sessionId }
    );
    const startedAt = session?.started_at || null;
    const endedAt = session?.ended_at || null;

    // Project lookup (cwd → project_id)
    let projectId = null;
    if (cwd) {
      const fwd = cwd.replace(/\\/g, '/');
      const proj = get(
        `SELECT id FROM projects WHERE path = :p AND org_id = :org_id`,
        { ':p': fwd, ':org_id': orgId }
      );
      projectId = proj?.id || null;
    }

    // Collect signals
    const completed_todos = getCompletedTodos(sessionId);
    const commits = getCommits(cwd, startedAt, endedAt);
    const files_touched = getFilesTouched(sessionId);
    const tasks_closed = getTasksClosed(projectId, startedAt, endedAt);

    const structured = { completed_todos, commits, files_touched, tasks_closed };

    // #975 + #976: gate the Cerebras polish.
    //   #975 — skip when ALL 4 signal arrays are empty (no content to summarize,
    //          LLM would just write boilerplate "no tasks were completed").
    //   #976 — skip when the signal hash matches the existing row (the watermark
    //          fires every 5 min on long sessions; without this gate it re-polishes
    //          unchanged data every cycle).
    const hasAnySignal =
      completed_todos.length || commits.length || files_touched.length || tasks_closed.length;
    const signalHash = createHash('sha1')
      .update(JSON.stringify(structured))
      .digest('hex');

    const existing = get(
      `SELECT signal_hash, llm_text, model_used FROM session_summaries WHERE session_id = :sid`,
      { ':sid': sessionId }
    );

    // Default: carry forward whatever the prior row had (if any), so an unchanged
    // hash preserves prior llm_text instead of nulling it out.
    let llm_text = existing?.llm_text ?? null;
    let model_used = existing?.model_used ?? 'deterministic';
    let llmFired = false;

    if (opts.useLLM !== false && hasAnySignal && existing?.signal_hash !== signalHash) {
      const polished = await polishWithCerebras(structured);
      llmFired = true;
      if (polished) {
        llm_text = polished;
        model_used = RECAP_MODEL;
      } else {
        // polish failed/returned null — keep model_used as 'deterministic' for this attempt
        // but don't clobber any prior successful llm_text we may have inherited from existing
        if (!existing?.llm_text) {
          llm_text = null;
          model_used = 'deterministic';
        }
      }
    }

    // Upsert (ON CONFLICT replace) — re-running backfill should overwrite
    run(
      `INSERT INTO session_summaries
         (session_id, project_id, cwd, started_at, ended_at,
          completed_todos, commits, files_touched, tasks_closed,
          llm_text, model_used, signal_hash)
       VALUES (:sid, :pid, :cwd, :s, :e, :ct, :co, :ft, :tc, :lt, :mu, :sh)
       ON CONFLICT(session_id) DO UPDATE SET
         project_id    = excluded.project_id,
         cwd           = excluded.cwd,
         started_at    = excluded.started_at,
         ended_at      = excluded.ended_at,
         completed_todos = excluded.completed_todos,
         commits       = excluded.commits,
         files_touched = excluded.files_touched,
         tasks_closed  = excluded.tasks_closed,
         llm_text      = excluded.llm_text,
         model_used    = excluded.model_used,
         signal_hash   = excluded.signal_hash`,
      {
        ':sid': sessionId,
        ':pid': projectId,
        ':cwd': cwd || null,
        ':s': startedAt,
        ':e': endedAt,
        ':ct': JSON.stringify(completed_todos),
        ':co': JSON.stringify(commits),
        ':ft': JSON.stringify(files_touched),
        ':tc': JSON.stringify(tasks_closed),
        ':lt': llm_text,
        ':mu': model_used,
        ':sh': signalHash,
      }
    );

    console.log(`[session-summary] built recap for ${sessionId.slice(0, 8)} ` +
      `(${completed_todos.length} todos, ${commits.length} commits, ${files_touched.length} files, ${tasks_closed.length} tasks, ` +
      `model=${model_used}, llm_fired=${llmFired}, hash=${signalHash.slice(0,8)})`);

    return { ...structured, llm_text, model_used };
  } catch (err) {
    console.error('[session-summary] buildSessionSummary failed:', err?.message);
    return null;
  }
}

// Read the rendered recap text for a session — prefers llm_text, falls back
// to deterministic rendering of the structured fields.
export function getSessionRecapText(sessionId) {
  try {
    const row = get(
      `SELECT completed_todos, commits, files_touched, tasks_closed, llm_text
       FROM session_summaries WHERE session_id = :sid`,
      { ':sid': sessionId }
    );
    if (!row) return null;
    if (row.llm_text && row.llm_text.length > 10) return row.llm_text;
    return renderDeterministic({
      completed_todos: JSON.parse(row.completed_todos || '[]'),
      commits: JSON.parse(row.commits || '[]'),
      files_touched: JSON.parse(row.files_touched || '[]'),
      tasks_closed: JSON.parse(row.tasks_closed || '[]'),
    });
  } catch {
    return null;
  }
}

// Read the most recent session recap for a project (used for "Recent Project Work").
export function getRecentProjectRecap(projectId, excludeSessionIds = []) {
  try {
    const placeholders = excludeSessionIds.map((_, i) => `:x${i}`).join(',');
    const exclude = excludeSessionIds.length ? `AND session_id NOT IN (${placeholders})` : '';
    const params = { ':pid': projectId };
    excludeSessionIds.forEach((id, i) => { params[`:x${i}`] = id; });
    const row = get(
      `SELECT session_id, llm_text, completed_todos, commits, files_touched, tasks_closed, created_at
       FROM session_summaries
       WHERE project_id = :pid ${exclude}
       ORDER BY created_at DESC LIMIT 1`,
      params
    );
    if (!row) return null;
    const text = row.llm_text && row.llm_text.length > 10
      ? row.llm_text
      : renderDeterministic({
          completed_todos: JSON.parse(row.completed_todos || '[]'),
          commits: JSON.parse(row.commits || '[]'),
          files_touched: JSON.parse(row.files_touched || '[]'),
          tasks_closed: JSON.parse(row.tasks_closed || '[]'),
        });
    return { session_id: row.session_id, text, created_at: row.created_at };
  } catch {
    return null;
  }
}
