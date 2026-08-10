import { Router } from 'express';
import { run, get, all, insert, detectProject, indexEventFTS, allScoped, getScoped, runScoped, insertScoped } from '../db.js';
import { broadcastNotification, broadcastChatUpdate, addPendingPermission, getPendingPermissions, clearPermission, setInFlightTool, clearInFlightTool, findSessionByClaudeId } from '../terminal-bridge.js';
import { nudgeTranscript } from '../transcript-watcher.js';
import { buildContext as buildMemoryContext } from '../memory/index.js';
import { reconcileTasks } from '../memory/consolidation.js';
import { buildSessionSummary, getSessionRecapText, getRecentProjectRecap } from '../session-summary.js';
import { createAlert } from './dashboard.js';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// Context size thresholds (in chars)
const CLAUDE_MD_WARN_SIZE = 15000;  // ~3,750 tokens — alert if CLAUDE.md exceeds this
const INJECTED_CONTEXT_WARN = 6000; // ~1,500 tokens — #700 fix: raised threshold to match new cap

const router = Router();

// PermissionRequest is handled separately — it's BLOCKING (Claude Code waits for the response)
router.post('/PermissionRequest', async (req, res) => {
  const payload = req.body;

  try {
    const sessionId = payload.session_id || 'unknown';
    const cwd = payload.cwd || '';

    // Build a readable description of what's being requested
    const toolName = payload.tool_name || 'unknown tool';
    const toolInput = payload.tool_input || {};
    let description = toolName;
    if (toolInput.command) {
      description = `${toolName}: ${toolInput.command}`;
    } else if (toolInput.file_path) {
      description = `${toolName}: ${toolInput.file_path}`;
    } else if (Object.keys(toolInput).length > 0) {
      description = `${toolName}: ${JSON.stringify(toolInput).substring(0, 150)}`;
    }

    // Store as pending permission with a unique ID
    const permId = Date.now();
    const permData = {
      id: permId,
      session_id: sessionId,
      project: cwd,
      prompt: description.substring(0, 300),
      tool_name: toolName,
      tool_input: toolInput,
      timestamp: new Date().toISOString(),
      response: null, // will be set by mobile user
    };
    addPendingPermission(permData);

    // Notify dashboard clients
    broadcastNotification('permission_prompt', permData);

    console.log(`[PAN Hook] PermissionRequest: ${description.substring(0, 100)} — waiting for mobile response...`);

    // Store the event
    const dataStr = JSON.stringify(payload);
    const eventId = insertScoped(req, `INSERT INTO events (session_id, event_type, data, user_id, org_id) VALUES (:sid, :type, :data, :uid, :org_id)`, {
      ':sid': sessionId,
      ':type': 'PermissionRequest',
      ':data': dataStr,
      ':uid': req.user?.id || null
    });
    indexEventFTS(eventId, 'PermissionRequest', dataStr);

    // Poll for mobile user's response — check every 1 second for up to 115 seconds
    const MAX_WAIT = 115000;
    const POLL_INTERVAL = 1000;
    const startTime = Date.now();

    const result = await new Promise((resolve) => {
      let isPolling = false; // prevent concurrent IPC calls from piling up
      let resolved = false;  // guard: Promise.resolve is a no-op after first call but clearInterval isn't
      function settle(value) {
        if (resolved) return;
        resolved = true;
        clearInterval(timer);
        resolve(value);
      }

      // The setInterval callback is async — its returned Promise is discarded by setInterval.
      // Attach an explicit .catch() so any unexpected throw becomes a logged deny, not an
      // unhandled rejection that can escape to the process-level handler and (on Node <18) crash.
      const timer = setInterval(() => {
        if (isPolling || resolved) return;
        isPolling = true;
        (async () => {
          try {
            // getPendingPermissions() may return a Promise (Craft IPC mode) or an array
            const pendingRaw = getPendingPermissions();
            const pending = Array.isArray(pendingRaw)
              ? pendingRaw
              : await Promise.resolve(pendingRaw).catch(() => []);
            const perm = Array.isArray(pending) ? pending.find(p => p.id === permId) : undefined;

            if (perm && perm.response) {
              // User responded!
              console.log(`[PAN Hook] PermissionRequest response: ${perm.response} (${Date.now() - startTime}ms)`);
              try { clearPermission(permId); } catch {}
              settle(perm.response); // 'allow' or 'deny'
            } else if (!perm) {
              // Permission was removed (e.g. 30s auto-expiry in getPendingPermissions) — deny
              console.log(`[PAN Hook] PermissionRequest expired (removed from queue)`);
              settle('deny');
            } else if (Date.now() - startTime > MAX_WAIT) {
              // 115s hard timeout — deny
              console.log(`[PAN Hook] PermissionRequest timed out after ${MAX_WAIT}ms — denying`);
              try { clearPermission(permId); } catch {}
              settle('deny');
            }
          } catch (pollErr) {
            console.error(`[PAN Hook] PermissionRequest poll error (denying):`, pollErr?.message);
            settle('deny');
          } finally {
            isPolling = false;
          }
        })().catch(escapeErr => {
          // Belt-and-suspenders: if the async IIFE itself rejects past the inner catch,
          // log it and deny rather than creating an unhandled rejection.
          console.error(`[PAN Hook] PermissionRequest IIFE escaped catch:`, escapeErr?.message);
          settle('deny');
        });
      }, POLL_INTERVAL);
    });

    res.status(200).json({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: result }
      }
    });
  } catch (err) {
    console.error(`[PAN Hook] Error handling PermissionRequest:`, err.message);
    res.status(200).json({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny' }
      }
    });
  }
});

// Inject readable session context into CLAUDE.md between PAN-CONTEXT markers
// tabClaudeSessionIds: array of Claude session IDs that have run in this specific PTY tab.
// When provided, Part 1 of the injection is scoped to THIS TAB's history.
// Part 2 always shows the most recent OTHER session for the project (cross-tab context).
async function injectSessionContext(cwd, orgId = 'org_personal', tabClaudeSessionIds = []) {
  try {
    const claudeMdPath = join(cwd, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) return;

    const content = readFileSync(claudeMdPath, 'utf8');
    const startMarker = '<!-- PAN-CONTEXT-START -->';
    const endMarker = '<!-- PAN-CONTEXT-END -->';
    const startIdx = content.indexOf(startMarker);
    const endIdx = content.lastIndexOf(endMarker);
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return;

    // JSON.stringify escapes backslashes, so the DB stores C:\\Users\\ not C:\Users\
    const fwd = cwd.replace(/\\/g, '/');
    const jsonEscaped = cwd.replace(/\\/g, '\\\\');

    // Filter out system/meta prompts — never inject these back into context
    const isNoise = (prompt) => {
      if (typeof prompt !== 'string') return true;
      const p = prompt.trimStart();
      return p.startsWith('<task-')
          || p.startsWith('<tool-use-id>')
          || p.startsWith('You are PAN')
          || p.startsWith('CURRENT STATE')
          || /^Π Remembers:/i.test(p)       // break the self-injection loop
          || p.toLowerCase().startsWith('pan remembers:')
          || p.length < 2;
    };

    // Render a list of events into chat lines (up to maxChars)
    // #700 fix: increased message length from 250 → 800 to avoid truncating important context
    function renderEvents(events, maxChars) {
      const chatItems = [...events].reverse();
      const lines = [];
      let chars = 0;
      for (const e of chatItems) {
        try {
          const d = JSON.parse(e.data);
          let line = null;
          if (e.event_type === 'UserPromptSubmit' && d.prompt && !isNoise(d.prompt)) {
            line = `**User** (${e.created_at}): ${d.prompt.substring(0, 800)}`;
          } else if (e.event_type === 'Stop' && d.last_assistant_message) {
            line = `**Claude** (${e.created_at}): ${d.last_assistant_message.substring(0, 800)}`;
          }
          if (line) {
            chars += line.length;
            if (chars > maxChars) break;
            lines.push(line);
          }
        } catch {}
      }
      return lines;
    }

    // ── PART 1: This tab ──────────────────────────────────────────────────────
    // Pull events from this specific PTY tab's Claude session IDs.
    let tabEvents = [];
    let tabSessionId = null;
    if (tabClaudeSessionIds.length > 0) {
      const placeholders = tabClaudeSessionIds.map((_, i) => `:sid${i}`).join(',');
      const params = Object.fromEntries(tabClaudeSessionIds.map((id, i) => [`:sid${i}`, id]));
      tabEvents = all(
        `SELECT event_type, data, created_at, session_id FROM events
         WHERE (event_type = 'UserPromptSubmit' OR event_type = 'Stop')
         AND session_id IN (${placeholders})
         AND context_safe = 1
         ORDER BY created_at DESC LIMIT 12`,
        params
      );
      tabSessionId = tabClaudeSessionIds[tabClaudeSessionIds.length - 1];
    }

    // ── PART 2: Recent project work ───────────────────────────────────────────
    // Most recent session for this project that is NOT this tab's sessions.
    // UserPromptSubmit events embed cwd; Stop events do NOT — use UPS to find session.
    const excludeIds = tabClaudeSessionIds.length > 0
      ? `AND session_id NOT IN (${tabClaudeSessionIds.map((_, i) => `:xsid${i}`).join(',')})` : '';
    const excludeParams = Object.fromEntries(tabClaudeSessionIds.map((id, i) => [`:xsid${i}`, id]));

    const projectSession = get(
      `SELECT session_id FROM events
       WHERE event_type = 'UserPromptSubmit'
       AND (data LIKE :pp1 OR data LIKE :pp2)
       AND org_id = :org_id
       AND context_safe = 1
       AND session_id IN (SELECT DISTINCT session_id FROM events WHERE event_type = 'Stop')
       ${excludeIds}
       ORDER BY created_at DESC LIMIT 1`,
      { ':pp1': '%' + jsonEscaped + '%', ':pp2': '%' + fwd + '%', ':org_id': orgId, ...excludeParams }
    );

    let projectEvents = [];
    if (projectSession?.session_id) {
      projectEvents = all(
        `SELECT event_type, data, created_at, session_id FROM events
         WHERE (event_type = 'UserPromptSubmit' OR event_type = 'Stop')
         AND session_id = :sid
         AND context_safe = 1
         ORDER BY created_at DESC LIMIT 10`,
        { ':sid': projectSession.session_id }
      );
    }

    // ── TASKS ─────────────────────────────────────────────────────────────────
    const project = get("SELECT id, name FROM projects WHERE path = :p AND org_id = :org_id", { ':p': fwd, ':org_id': orgId });
    let tasks = [];
    if (project) {
      tasks = all(
        `SELECT id, title, status, priority FROM project_tasks
         WHERE project_id = :pid AND status != 'done'
         AND org_id = :org_id
         ORDER BY priority DESC LIMIT 10`,
        { ':pid': project.id, ':org_id': orgId }
      );
    }

    // ── BUILD BRIEFING ────────────────────────────────────────────────────────
    let briefing = `## PAN Session Context\n\n`;
    briefing += `This is a fresh session for the "${project?.name || 'PAN'}" project.\n`;
    briefing += `IMPORTANT: The project documentation is at the TOP of this CLAUDE.md file — read it first.\n\n`;
    briefing += `**Session context** (for the first message of a fresh session only — see Session Continuity Rule above):\n\n`;

    // Part 1 — This tab
    // PREFER recap from session_summaries (the deterministic + Cerebras-polished
    // row written at SessionEnd). Falls back to raw event rendering only if no
    // summary row exists yet (e.g. session hasn't ended, or it's pre-recap-pipeline).
    let usedRecapTab = false;
    if (tabSessionId) {
      const recap = getSessionRecapText(tabSessionId);
      if (recap) {
        briefing += `### This Tab *(session: ${tabSessionId.substring(0, 12)}, recap)*\n${recap}\n\n`;
        usedRecapTab = true;
      }
    }
    if (!usedRecapTab) {
      const tabLines = renderEvents(tabEvents, 3500);
      if (tabLines.length > 0) {
        briefing += `### This Tab`;
        if (tabSessionId) briefing += ` *(session: ${tabSessionId.substring(0, 12)})*`;
        briefing += `\n${tabLines.join('\n')}\n\n`;
      } else if (tabClaudeSessionIds.length > 0) {
        briefing += `### This Tab\nNew tab — no prior conversation yet.\n\n`;
      }
    }

    // Part 2 — Recent project work (most recent OTHER session)
    // PREFER recap; fall back to raw events.
    let usedRecapProject = false;
    if (project?.id) {
      const recap = getRecentProjectRecap(project.id, tabClaudeSessionIds);
      if (recap) {
        briefing += `### Recent Project Work *(session: ${recap.session_id.substring(0, 12)}, recap)*\n${recap.text}\n\n`;
        usedRecapProject = true;
      }
    }
    if (!usedRecapProject) {
      const projectLines = renderEvents(projectEvents, 2500);
      if (projectLines.length > 0) {
        briefing += `### Recent Project Work`;
        if (projectSession?.session_id) briefing += ` *(session: ${projectSession.session_id.substring(0, 12)})*`;
        briefing += `\n${projectLines.join('\n')}\n\n`;
      } else if (!tabClaudeSessionIds.length) {
        // No tab context AND no project context — fresh install
        briefing += `### Recent Conversation\nFresh session — no previous conversation on record.\n\n`;
      }
    }

    // Tasks (with IDs for auto-closer)
    if (tasks.length > 0) {
      briefing += `### Open Tasks\n`;
      for (const t of tasks) {
        briefing += `- [#${t.id} ${t.status}${t.priority > 0 ? ' P' + t.priority : ''}] ${t.title}\n`;
      }
      briefing += '\n';
    }

    // Sanitize — strip any literal PAN-CONTEXT markers from injected content
    briefing = briefing.replace(/<!-- PAN-CONTEXT-(START|END) -->/g, '');

    // Hard cap at 6500 chars (#700 fix: raised from 4100 to show fuller recent context without truncation)
    if (briefing.length > 6500) {
      briefing = briefing.substring(0, 6500) + '\n\n[... context trimmed ...]\n';
    }

    // Write to CLAUDE.md
    const newContent = content.substring(0, startIdx + startMarker.length) + '\n' +
      briefing +
      content.substring(endIdx);
    writeFileSync(claudeMdPath, newContent, 'utf8');
    console.log(`[PAN Hook] Injected session context into ${claudeMdPath} (${newContent.length} chars, injection: ${briefing.length} chars)`);

    // Alert if context is bloated
    if (briefing.length > INJECTED_CONTEXT_WARN) {
      createAlert({
        alert_type: 'context_bloat',
        severity: 'warning',
        title: `Injected context too large: ${briefing.length} chars (limit: ${INJECTED_CONTEXT_WARN})`,
        detail: `Session injection for ${cwd} is ${briefing.length} chars (~${Math.round(briefing.length / 4)} tokens). This adds cost to every message. Tasks: ${tasks.length}.`,
      });
    }
    if (newContent.length > CLAUDE_MD_WARN_SIZE) {
      createAlert({
        alert_type: 'context_bloat',
        severity: newContent.length > 20000 ? 'critical' : 'warning',
        title: `CLAUDE.md is ${newContent.length} chars (~${Math.round(newContent.length / 4)} tokens)`,
        detail: `${claudeMdPath} total size: ${newContent.length} chars. Static docs: ${startIdx} chars, injected: ${briefing.length} chars. Every message pays this cost. Target: <${CLAUDE_MD_WARN_SIZE} chars.`,
      });
    }
  } catch (err) {
    console.error(`[PAN Hook] Failed to inject session context:`, err.message);
  }
}

// ───────────────────────── Internal: session nudges (bug #769) ─────────────────────────
// Local-only endpoint hit by service/src/hooks/behavioral-lock-breaker.js to enqueue
// a system-level nudge that the next UserPromptSubmit will inject as
// additionalContext. Cooldown-guarded so we don't spam the same session.
/**
 * POST /hooks/internal/session-report
 *
 * Receives one turn-boundary report from service/src/hooks/session-reporter.js,
 * summarises it in one TTS-sized line, and delivers it as an interjection.
 *
 * This is the "let PAN narrate my Claude sessions" loop. Deliberately narrow:
 *
 *  - The HOOK decides which sessions report at all (cwd allowlist). Nothing
 *    arrives here from a session you did not opt in.
 *  - dispatchAction() dedupes on `act:<id>` for 30 minutes, and the id is keyed
 *    to the session, so a chatty session yields at most one spoken line per
 *    half hour no matter how many turns it takes. That cap is the whole reason
 *    this is safe to run: pan_interjections still records #564..#581 firing in
 *    ~1.5h on 2026-05-27 when a dedupe silently failed to match.
 *  - `blocked` (the session asked you something and is now idle) speaks.
 *    `progress` and `completed` are stored and shown, but only speak when
 *    session_report_speak_all is on. Being told about work you did not ask to
 *    be told about is how the last notification system became noise.
 */
router.post('/internal/session-report', async (req, res) => {
  try {
    const { session_id, cwd, project, kind, assistant_text, last_user_text, used_tools } = req.body || {};
    if (!session_id || !assistant_text) {
      return res.status(400).json({ ok: false, error: 'missing session_id or assistant_text' });
    }

    // One short spoken line. Local/cloud per the normal chain — a summary is a
    // background job, not a voice turn, so it must never block a real one.
    let line = '';
    try {
      const { askAIWithFallback } = await import('../llm-fallback.js');
      line = await askAIWithFallback(
        `Summarise what an AI coding session just did, for a spoken one-line notification.
Project: ${project || 'unknown'}
The user had asked: ${(last_user_text || '(nothing recorded)').slice(0, 200)}
The assistant replied: ${String(assistant_text).slice(0, 900)}

Reply with ONE sentence, under 20 words, plain speech, no markdown, no preamble.
If the assistant is waiting on the user, say what it needs.`,
        { caller: 'session-report', callerClass: 'background', maxTokens: 120, timeout: 20_000 }
      );
    } catch { /* summary is best effort — fall through to the raw first line */ }

    line = String(line || '').trim().split('\n')[0].slice(0, 180);
    if (!line) line = String(assistant_text).trim().split('\n')[0].slice(0, 180);

    const label = project || 'a session';
    const speak = kind === 'blocked'
      ? `${label} needs you. ${line}`
      : `${label}: ${line}`;

    const shouldSpeak = kind === 'blocked' || /^(1|true|yes)$/i.test(
      (get(`SELECT value FROM settings WHERE key = 'session_report_speak_all'`)?.value || '')
        .replace(/^"|"$/g, '')
    );

    let dispatched = { dispatched: false, reason: 'not spoken (kind=' + kind + ')' };
    if (shouldSpeak) {
      const { dispatchAction } = await import('../intuition/action.js');
      dispatched = await dispatchAction(
        { id: `session-report:${session_id}`, reason: `${label} ${kind}` },
        { userId: 'owner', phraseOverride: { subject: `${label} ${kind}`, body: speak, speak } }
      );
    }

    broadcastNotification('pan_session_report', {
      session_id, project: label, kind, used_tools: !!used_tools, line, cwd,
    });

    res.json({ ok: true, kind, line, spoke: shouldSpeak, dispatch: dispatched });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/internal/session-nudges', (req, res) => {
  try {
    const { session_id, kind, body, detector_meta, cooldown_s } = req.body || {};
    if (!session_id || !kind || !body) {
      return res.status(400).json({ ok: false, error: 'missing session_id, kind, or body' });
    }
    // Cooldown check — don't insert if we already nudged the same (session, kind)
    // within the cooldown window. Uses raw `run`/`get` (not scoped) because the
    // hook script doesn't carry an org context; session_id is globally unique.
    const cooldownSec = Math.max(60, Number(cooldown_s) || 600);
    const recent = get(
      `SELECT id, created_at FROM session_nudges
       WHERE session_id = :sid AND kind = :kind
         AND created_at > datetime('now', 'localtime', :delta)
       ORDER BY id DESC LIMIT 1`,
      { ':sid': session_id, ':kind': kind, ':delta': `-${cooldownSec} seconds` }
    );
    if (recent) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'cooldown', last_id: recent.id });
    }
    const newId = insert(
      `INSERT INTO session_nudges (session_id, kind, body, detector_meta)
       VALUES (:sid, :kind, :body, :meta)`,
      { ':sid': session_id, ':kind': kind, ':body': body, ':meta': detector_meta || null }
    );
    // Surface as a high-urgency pan_alert so the dashboard can show "PAN
    // detected a loop and nudged itself" without waiting on the next turn.
    try {
      broadcastNotification('pan_alert', {
        category: 'behavioral_lock',
        urgency: 'high',
        session_id,
        body,
      });
    } catch {}
    // better-sqlite3 lastInsertRowid is a BigInt; coerce for JSON.
    const idNum = typeof newId === 'bigint' ? Number(newId) : newId;
    console.log(`[PAN #769] session_nudge enqueued kind=${kind} session=${session_id.slice(0, 8)} id=${idNum}`);
    res.status(200).json({ ok: true, id: idNum });
  } catch (err) {
    console.error('[PAN #769] internal/session-nudges failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Inspect recent recaps — local debugging only.
router.get('/internal/recap-inspect', (req, res) => {
  try {
    const limit = Math.min(20, Number(req.query.limit) || 5);
    const rows = all(
      `SELECT session_id, model_used, completed_todos, commits, files_touched, tasks_closed, llm_text, created_at
       FROM session_summaries ORDER BY id DESC LIMIT :lim`,
      { ':lim': limit }
    );
    const out = rows.map(r => ({
      session_id: r.session_id,
      model_used: r.model_used,
      created_at: r.created_at,
      completed_todos: JSON.parse(r.completed_todos || '[]').slice(0, 5),
      commits: JSON.parse(r.commits || '[]').slice(0, 5),
      files_touched: JSON.parse(r.files_touched || '[]').slice(0, 8),
      tasks_closed: JSON.parse(r.tasks_closed || '[]').slice(0, 5),
      llm_text: r.llm_text,
    }));
    res.status(200).json({ ok: true, rows: out });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// One-shot backfill — walks recent sessions in this project and builds
// session_summaries rows for any that don't have one. Idempotent. Local-only.
router.post('/internal/recap-backfill', async (req, res) => {
  try {
    const { cwd, limit = 10, useLLM = true } = req.body || {};
    if (!cwd) return res.status(400).json({ ok: false, error: 'missing cwd' });
    const fwd = cwd.replace(/\\/g, '/');
    const jsonEscaped = cwd.replace(/\\/g, '\\\\');
    const orgId = 'org_personal';

    // Pull recent distinct session_ids that have a Stop event (i.e. are real sessions)
    // touching this cwd. Skip ones that already have a summary.
    const sessions = all(
      `SELECT DISTINCT e.session_id, MIN(e.created_at) AS first_seen
       FROM events e
       WHERE e.event_type = 'UserPromptSubmit'
         AND (e.data LIKE :pp1 OR e.data LIKE :pp2)
         AND e.org_id = :org_id
         AND e.session_id NOT IN (SELECT session_id FROM session_summaries)
         AND e.session_id IN (SELECT DISTINCT session_id FROM events WHERE event_type = 'Stop')
       GROUP BY e.session_id
       ORDER BY first_seen DESC
       LIMIT :lim`,
      { ':pp1': '%' + jsonEscaped + '%', ':pp2': '%' + fwd + '%', ':org_id': orgId, ':lim': Number(limit) }
    );

    const results = [];
    for (const s of sessions) {
      try {
        const r = await buildSessionSummary(s.session_id, cwd, orgId, { useLLM });
        results.push({ session_id: s.session_id, ok: !!r, model: r?.model_used });
      } catch (err) {
        results.push({ session_id: s.session_id, ok: false, error: err.message });
      }
    }
    res.status(200).json({ ok: true, processed: results.length, results });
  } catch (err) {
    console.error('[recap-backfill] failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/:eventType', (req, res) => {
  const eventType = req.params.eventType;
  const payload = req.body;

  try {
    const sessionId = payload.session_id;
    const cwd = payload.cwd || '';

    if (!sessionId) {
      return res.status(400).json({ error: 'missing session_id' });
    }

    // Ensure session exists — upsert on every event so we never miss a session
    // (SessionStart hook often fails because PAN server isn't running yet when Claude starts)
    const existingSession = getScoped(req, "SELECT id FROM sessions WHERE id = :id AND org_id = :org_id", { ':id': sessionId });
    if (!existingSession) {
      runScoped(req, `INSERT INTO sessions (id, cwd, model, source, transcript_path, user_id, org_id)
        VALUES (:id, :cwd, :model, :source, :tp, :uid, :org_id)`, {
        ':id': sessionId,
        ':cwd': cwd,
        ':model': payload.model || null,
        ':source': payload.source || null,
        ':tp': payload.transcript_path || null,
        ':uid': req.user?.id || null
      });
      // Auto-detect project
      if (cwd) {
        const project = detectProject(cwd);
        runScoped(req, "UPDATE sessions SET project_id = :pid WHERE id = :id AND org_id = :org_id", {
          ':pid': project.id,
          ':id': sessionId
        });
      }
    }

    if (eventType === 'SessionStart') {
      if (existingSession) {
        // Update existing session with fresh metadata
        runScoped(req, `UPDATE sessions SET
          model = COALESCE(:model, model),
          source = COALESCE(:source, source),
          transcript_path = COALESCE(:tp, transcript_path)
          WHERE id = :id AND org_id = :org_id`, {
          ':id': sessionId,
          ':model': payload.model || null,
          ':source': payload.source || null,
          ':tp': payload.transcript_path || null
        });
      }

      // Resume-aware preamble. When Claude Code resumes an existing session
      // (source='resume'), the CLAUDE.md "Π Remembers" preamble is suppressed
      // by the anti-repetition rule — but the user just hit carrier_restart and
      // legitimately wants to see "I'm back, last topic was X". Push a WS
      // notification so the terminal UI can render a one-line resume banner in
      // scrollback without making Claude re-emit the full briefing.
      // (source='startup' = fresh process, handled by the normal first-message
      // Π Remembers path; 'compact'/'clear' are user-intentional and don't
      // need a banner.)
      if (payload.source === 'resume') {
        try {
          const lastPrompt = getScoped(req,
            `SELECT data, created_at FROM events
             WHERE session_id = :sid
             AND event_type = 'UserPromptSubmit'
             AND org_id = :org_id
             ORDER BY created_at DESC LIMIT 1`,
            { ':sid': sessionId }
          );
          let lastTopic = '';
          if (lastPrompt?.data) {
            try {
              const parsed = JSON.parse(lastPrompt.data);
              lastTopic = (parsed.prompt || parsed.user_prompt || '').toString().trim().slice(0, 80);
            } catch {}
          }
          broadcastNotification('pan_resumed', {
            session_id: sessionId,
            cwd,
            last_topic: lastTopic,
            last_topic_at: lastPrompt?.created_at || null,
          });
          console.log(`[PAN Hook] SessionStart resume → pan_resumed broadcast (session=${sessionId.slice(0,8)}, last_topic="${lastTopic.slice(0,40)}")`);
        } catch (err) {
          console.warn('[PAN Hook] resume preamble failed:', err.message);
        }
      }
    }

    if (eventType === 'SessionEnd') {
      runScoped(req, `UPDATE sessions SET ended_at = datetime('now','localtime'), transcript_path = :tp WHERE id = :id AND org_id = :org_id`, {
        ':id': sessionId,
        ':tp': payload.transcript_path || null
      });

      // Build the session recap row FIRST (deterministic + optional Cerebras
      // polish), then inject context. This breaks the regurgitation loop where
      // the previous approach pulled raw last-Stop text and re-injected
      // whatever Claude last said. The recap is built from real signals:
      // completed todos, git commits, files touched, tasks closed.
      const orgIdForRecap = req.org_id || 'org_personal';
      (async () => {
        try {
          await buildSessionSummary(sessionId, cwd, orgIdForRecap);
        } catch (err) {
          console.error('[PAN Hook] SessionEnd buildSessionSummary failed:', err.message);
        }
        // Inject context into CLAUDE.md NOW so the NEXT session opens with fresh context
        // (Claude Code reads CLAUDE.md before SessionStart hooks run, so this must happen on SessionEnd)
        // Pass sessionId as a single-item tab array so Part 1 is scoped to the ending session.
        if (cwd) {
          injectSessionContext(cwd, orgIdForRecap, sessionId ? [sessionId] : []).catch(err => {
            console.error('[PAN Hook] SessionEnd context injection failed:', err.message);
          });
        }
      })();

      // Task reconciliation — check if this session completed any open tasks
      // Runs async in background, non-blocking
      (async () => {
        try {
          const recentEvents = allScoped(req,
            `SELECT id, session_id, event_type, data, created_at FROM events
             WHERE session_id = :sid
             AND event_type IN ('UserPromptSubmit', 'Stop')
             AND org_id = :org_id
             ORDER BY created_at ASC LIMIT 100`,
            { ':sid': sessionId }
          );
          if (recentEvents.length >= 2) {
            const result = await reconcileTasks(recentEvents);
            if (result.updated > 0) {
              console.log(`[PAN Hook] SessionEnd: auto-updated ${result.updated} tasks`);
            }
          }
        } catch (err) {
          console.error('[PAN Hook] SessionEnd task reconciliation failed:', err.message);
        }
      })();
    }

    // Track in-flight tools so the dashboard status bar can show what
    // Claude is actually doing right now (Bash, Read, Explore subagent...)
    // instead of a dead-looking spinner. Keyed by cwd because the Claude
    // session id is different from the PAN PTY session id, but cwd matches.
    try {
      if (eventType === 'PreToolUse') {
        const toolName = payload.tool_name || 'tool';
        const ti = payload.tool_input || {};
        let summary = '';
        if (ti.command) summary = String(ti.command).substring(0, 80);
        else if (ti.file_path) summary = String(ti.file_path).split(/[\\/]/).pop();
        else if (ti.pattern) summary = String(ti.pattern).substring(0, 60);
        else if (ti.description) summary = String(ti.description).substring(0, 80);
        else if (ti.subagent_type) summary = String(ti.subagent_type) + ' agent';
        setInFlightTool(cwd, {
          tool: toolName,
          summary,
          claudeSessionId: sessionId,
          isSubagent: toolName === 'Agent' || toolName === 'Task',
        });
      } else if (eventType === 'PostToolUse') {
        clearInFlightTool(cwd, sessionId);
      } else if (eventType === 'Stop' || eventType === 'SessionEnd') {
        clearInFlightTool(cwd, sessionId);
      }
    } catch (e) {
      console.error('[PAN Hook] in-flight tracker failed:', e.message);
    }

    // Store every event
    const dataStr = JSON.stringify(payload);
    const eventId = insertScoped(req, `INSERT INTO events (session_id, event_type, data, user_id, org_id) VALUES (:sid, :type, :data, :uid, :org_id)`, {
      ':sid': sessionId,
      ':type': eventType,
      ':data': dataStr,
      ':uid': req.user?.id || null
    });

    // Index into FTS for instant search
    indexEventFTS(eventId, eventType, dataStr);

    // On Stop: extract ALL assistant text messages from the transcript for this turn
    // so the chat shows every "white dot" response, not just the last one
    if (eventType === 'Stop' && payload.transcript_path && existsSync(payload.transcript_path)) {
      try {
        const raw = readFileSync(payload.transcript_path, 'utf-8').trim();
        const lines = raw.split('\n');

        // Walk backwards from end to find all assistant text messages since last user prompt
        const assistantTexts = [];
        for (let i = lines.length - 1; i >= 0; i--) {
          let obj;
          try { obj = JSON.parse(lines[i]); } catch { continue; }

          // Stop at the last user prompt — we only want messages from this turn
          if (obj.type === 'queue-operation' && obj.operation === 'enqueue') break;

          if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
            for (const block of obj.message.content) {
              if (block.type === 'text' && block.text?.trim()) {
                assistantTexts.unshift(block.text);
              }
            }
          }
        }

        // If there are multiple text blocks, store all except the last one
        // (the last one is already in the Stop event as last_assistant_message)
        if (assistantTexts.length > 1) {
          for (let i = 0; i < assistantTexts.length - 1; i++) {
            const msgData = JSON.stringify({ text: assistantTexts[i], cwd: cwd });
            const msgId = insertScoped(req, `INSERT INTO events (session_id, event_type, data, org_id) VALUES (:sid, 'AssistantMessage', :data, :org_id)`, {
              ':sid': sessionId,
              ':data': msgData,
              ':uid': req.user?.id || null
            });
            indexEventFTS(msgId, 'AssistantMessage', msgData);
          }
        }
      } catch (err) {
        console.error('[PAN] Error extracting assistant messages:', err.message);
      }
    }

    // Auto-recap watermark — fire buildSessionSummary periodically during long
    // sessions so ΠΑΝ Remembers stays fresh even if SessionEnd never fires
    // (user leaves session open for days). Triggers if:
    //   - no summary row for this session yet, OR
    //   - >recap_watermark_minutes since last summary (default 30), OR
    //   - >=recap_watermark_turns Stop events since last summary (default 10)
    // ON CONFLICT UPDATE in buildSessionSummary handles overwriting cleanly.
    if (eventType === 'Stop') {
      try {
        const watermarkMin = Number(get(`SELECT value FROM settings WHERE key = 'recap_watermark_minutes'`)?.value) || 30;
        const watermarkTurns = Number(get(`SELECT value FROM settings WHERE key = 'recap_watermark_turns'`)?.value) || 10;
        const existing = get(
          `SELECT created_at FROM session_summaries WHERE session_id = :sid`,
          { ':sid': sessionId }
        );
        let shouldWrite = false;
        if (!existing) {
          shouldWrite = true;
        } else {
          const ageMin = get(
            `SELECT (julianday('now','localtime') - julianday(:c)) * 1440 AS m`,
            { ':c': existing.created_at }
          )?.m || 0;
          if (ageMin >= watermarkMin) {
            shouldWrite = true;
          } else {
            const stopsSince = get(
              `SELECT COUNT(*) AS n FROM events
               WHERE session_id = :sid AND event_type = 'Stop' AND created_at > :c`,
              { ':sid': sessionId, ':c': existing.created_at }
            )?.n || 0;
            if (stopsSince >= watermarkTurns) shouldWrite = true;
          }
        }
        if (shouldWrite) {
          const orgIdForRecap = req.org_id || 'org_personal';
          // Fire and forget — never block the Stop response on Cerebras latency
          buildSessionSummary(sessionId, cwd, orgIdForRecap).catch(err => {
            console.error('[PAN] watermark buildSessionSummary failed:', err.message);
          });
        }
      } catch (err) {
        console.error('[PAN] watermark check failed:', err.message);
      }
    }

    // Burn rate alert — check on Stop events if this session is consuming too much per message
    if (eventType === 'Stop' && payload.transcript_path && existsSync(payload.transcript_path)) {
      try {
        const stat = statSync(payload.transcript_path);
        const raw = readFileSync(payload.transcript_path, 'utf-8');
        let totalInput = 0, totalOutput = 0, msgCount = 0;
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.message?.usage) {
              totalInput += obj.message.usage.input_tokens || 0;
              totalOutput += obj.message.usage.output_tokens || 0;
              msgCount++;
            }
          } catch {}
        }
        if (msgCount > 2) {
          const perMsg = Math.round((totalInput + totalOutput) / msgCount);
          // Alert if burning >15K tokens per message (aggressive threshold)
          if (perMsg > 15000) {
            createAlert({
              alert_type: 'high_burn_rate',
              severity: perMsg > 30000 ? 'critical' : 'warning',
              title: `Burn rate: ${Math.round(perMsg / 1000)}K tokens/msg (${msgCount} msgs)`,
              detail: `Session ${sessionId}: ${Math.round(totalInput / 1000)}K input + ${Math.round(totalOutput / 1000)}K output across ${msgCount} messages = ${Math.round(perMsg / 1000)}K per message. JSONL: ${payload.transcript_path} (${Math.round(stat.size / 1024)}KB).`,
            });
          }
        }
      } catch (err) {
        // Non-fatal — don't block the hook for burn rate checking
      }
    }

    // Notify dashboard clients of new events so chat updates instantly.
    if (eventType === 'UserPromptSubmit' || eventType === 'Stop' || eventType === 'AssistantMessage') {
      try {
        broadcastChatUpdate({
          event_type: eventType,
          session_id: sessionId,
          cwd,
          timestamp: new Date().toISOString(),
        });
      } catch {}
    }

    // Bug #769: on UserPromptSubmit, claim-and-consume any pending session_nudges
    // for this session and return them as additionalContext so Claude sees them
    // prepended to the user's prompt. This is how behavioral-lock-breaker.js
    // breaks Claude out of stock-reply loops on turn N+1.
    if (eventType === 'UserPromptSubmit') {
      try {
        const pending = get(
          `SELECT id, body FROM session_nudges
           WHERE session_id = :sid AND consumed_at IS NULL
           ORDER BY id ASC LIMIT 1`,
          { ':sid': sessionId }
        );
        if (pending) {
          run(
            `UPDATE session_nudges SET consumed_at = datetime('now','localtime') WHERE id = :id`,
            { ':id': pending.id }
          );
          console.log(`[PAN #769] UPS injecting nudge id=${pending.id} session=${sessionId.slice(0, 8)}`);
          return res.status(200).json({
            ok: true,
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: pending.body,
            },
          });
        }
      } catch (err) {
        console.error('[PAN #769] UPS nudge claim failed:', err.message);
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`[PAN] Error handling ${eventType}:`, err.message);
    res.status(200).json({ ok: false, error: err.message });
  }
});

export default router;
export { injectSessionContext };
