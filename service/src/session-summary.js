// session-summary.js
//
// Builds a deterministic per-session recap row in `session_summaries` at
// SessionEnd. Replaces the prior approach where injectSessionContext pulled
// raw UserPromptSubmit/Stop events and re-injected whatever Claude last said —
// which fed back as "ΠΑΝ Remembers" on the next session and created a
// regurgitation loop (designed 2026-05-21, implemented 2026-05-22).
//
// Signals (all from the DB and git, no model):
//   - completed_todos: last TodoWrite snapshot's `completed` items
//   - commits: git commits during session window
//   - files_touched: paths from PreToolUse Edit/Write events
//   - tasks_closed: project_tasks moved to done/in_test in session window
//
// The recap is the plain list renderDeterministic() makes from those. A cloud
// model used to rewrite it as a paragraph (Cerebras qwen-3-235b). That model was
// retired, the last rewrite that worked was 2026-08-07, and every call after it
// failed while 98% of recaps were already the plain list. The reader is the next
// Claude session, which reads a list as well as a paragraph, so the step was
// removed (2026-11-18) and not moved to the hub's own model: on a hub with no
// GPU it would be about 50 calls a day sharing the CPU with voice turns.
// The llm_text, model_used and signal_hash columns stay in old databases. Nothing
// reads them, and a rebuilt row clears llm_text.

import { run, get, all } from './db.js';
import { execSync } from 'child_process';

// ── DB migration. Idempotent: the duplicate-column error is swallowed. Same
// pattern as service/src/client-manager.js.
(function runMigrations() {
  const migrations = [
    // When the row was last rebuilt. The upsert leaves created_at alone, so the
    // Stop watermark in routes/hooks.js needs this to know a recap is fresh.
    "ALTER TABLE session_summaries ADD COLUMN updated_at TEXT",
  ];
  for (const sql of migrations) {
    try { run(sql); } catch {} // Ignore duplicate column errors
  }
})();

// The last TodoWrite snapshot's completed items and the files touched (Edit, Write,
// NotebookEdit), from the session's latest RECAP_WINDOW tool calls, in one pass.
//
// `+event_type` forces idx_events_session. Without sqlite_stat1 the planner chose
// idx_events_type and ran json_extract over all ~200k PreToolUse rows: 2.4s per
// query with a warm cache, a minute or more cold on the 12 GB hub DB, on the main
// thread. That is the recurring 5s and 60s [loop-block] lines that end with
// "[session-summary] built recap".
//
// The window came after: even on the right index, reading ALL of a multi-day
// session's tool calls (25-30k rows, 40-46 MB) twice took ~1.5 s per recap, every
// 10 turns per session, on the thread that serves voice. Turns landing in it waited
// (2-4 s [loop-block] lines right after "built recap", voicebench 2026-11-02). The
// id subquery walks the session index and skips rows without reading their data:
// 6-60 ms for 2,000 calls, which is a few days of work.
const RECAP_WINDOW = 2000;

function getToolSignals(sessionId) {
  const out = { completed_todos: [], files_touched: [] };
  try {
    const rows = all(
      `SELECT data FROM events
       WHERE id IN (SELECT id FROM events WHERE session_id = :sid AND +event_type = 'PreToolUse'
                    ORDER BY id DESC LIMIT :n)
         AND json_extract(data, '$.tool_name') IN ('TodoWrite','Edit','Write','NotebookEdit','MultiEdit')
       ORDER BY id ASC`,
      { ':sid': sessionId, ':n': RECAP_WINDOW }
    );
    const seen = new Set();
    let todos = [];
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data);
        if (d?.tool_name === 'TodoWrite') { todos = d?.tool_input?.todos || []; continue; }
        const fp = d?.tool_input?.file_path;
        if (fp && seen.size < 20) seen.add(fp);
      } catch {}
    }
    out.files_touched = Array.from(seen);
    out.completed_todos = todos
      .filter(t => t.status === 'completed')
      .map(t => t.content)
      .slice(0, 20);
  } catch {}
  return out;
}

// cwds git called "not a git repository". A session from another machine carries
// that machine's cwd, and spawning git for it on every recap blocks the main thread
// for nothing.
const _notRepo = new Set();

// Git commits inside the session's time window for this cwd.
function getCommits(cwd, startedAt, endedAt) {
  if (!cwd || _notRepo.has(cwd)) return [];
  try {
    const since = startedAt ? `--since="${startedAt}"` : '--since="6 hours ago"';
    const until = endedAt ? `--until="${endedAt}"` : '';
    const out = execSync(
      `git log ${since} ${until} --pretty=format:"%h|%s" -20`,
      { cwd, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return out.split('\n').filter(Boolean).slice(0, 20).map(l => {
      const [sha, ...rest] = l.split('|');
      return { sha, subject: rest.join('|') };
    });
  } catch (e) {
    // ENOENT: the cwd does not exist on this machine at all (WoE lives on the laptop).
    if (e?.code === 'ENOENT' || /not a git repository/i.test(String(e?.stderr || ''))) _notRepo.add(cwd);
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

// The recap text: a plain list built from the signals.
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

// Main entry. Idempotent — re-running for the same session_id replaces the row.
// Async only because its callers await it or chain .catch(); nothing inside waits.
export async function buildSessionSummary(sessionId, cwd, orgId = 'org_personal') {
  if (!sessionId) return null;

  try {
    // Every step runs on the main thread, so time them: a recap that takes
    // 200 ms+ says which step it was.
    const tStart = performance.now();
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
    const tLookup = performance.now();
    const { completed_todos, files_touched } = getToolSignals(sessionId);
    const tSignals = performance.now();
    const commits = getCommits(cwd, startedAt, endedAt);
    const tGit = performance.now();
    const tasks_closed = getTasksClosed(projectId, startedAt, endedAt);
    const tTasks = performance.now();

    const structured = { completed_todos, commits, files_touched, tasks_closed };

    // Upsert (ON CONFLICT replace) — re-running backfill should overwrite.
    // llm_text goes back to NULL so a row that still held an old rewrite drops it.
    const tWrite = performance.now();
    run(
      `INSERT INTO session_summaries
         (session_id, project_id, cwd, started_at, ended_at,
          completed_todos, commits, files_touched, tasks_closed,
          llm_text, model_used, updated_at)
       VALUES (:sid, :pid, :cwd, :s, :e, :ct, :co, :ft, :tc, NULL, 'deterministic', datetime('now','localtime'))
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
         updated_at    = excluded.updated_at`,
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
      }
    );

    const tDone = performance.now();

    console.log(`[session-summary] built recap for ${sessionId.slice(0, 8)} ` +
      `(${completed_todos.length} todos, ${commits.length} commits, ${files_touched.length} files, ${tasks_closed.length} tasks)`);
    const syncMs = (tTasks - tStart) + (tDone - tWrite);
    if (syncMs >= 200) {
      console.warn(`[session-summary] slow recap for ${sessionId.slice(0, 8)}: ${Math.round(syncMs)}ms on the main thread ` +
        `(lookup=${Math.round(tLookup - tStart)} signals=${Math.round(tSignals - tLookup)} git=${Math.round(tGit - tSignals)} ` +
        `tasks=${Math.round(tTasks - tGit)} write=${Math.round(tDone - tWrite)})`);
    }

    return structured;
  } catch (err) {
    console.error('[session-summary] buildSessionSummary failed:', err?.message);
    return null;
  }
}

// Read the rendered recap text for a session.
export function getSessionRecapText(sessionId) {
  try {
    const row = get(
      `SELECT completed_todos, commits, files_touched, tasks_closed
       FROM session_summaries WHERE session_id = :sid`,
      { ':sid': sessionId }
    );
    if (!row) return null;
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
      `SELECT session_id, completed_todos, commits, files_touched, tasks_closed, created_at
       FROM session_summaries
       WHERE project_id = :pid ${exclude}
       ORDER BY created_at DESC LIMIT 1`,
      params
    );
    if (!row) return null;
    const text = renderDeterministic({
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
