import { Router } from 'express';
import { run, get, all, insert, detectProject, indexEventFTS, allScoped, getScoped, runScoped, insertScoped } from '../db.js';
import { broadcastNotification, broadcastChatUpdate, addPendingPermission, getPendingPermissions, clearPermission, setInFlightTool, clearInFlightTool, findSessionByClaudeId } from '../terminal-bridge.js';
import { nudgeTranscript } from '../transcript-watcher.js';
import { buildContext as buildMemoryContext } from '../memory/index.js';
import { reconcileTasks } from '../memory/consolidation.js';
import { createAlert } from './dashboard.js';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// Context size thresholds (in chars)
const CLAUDE_MD_WARN_SIZE = 15000;  // ~3,750 tokens — alert if CLAUDE.md exceeds this
const INJECTED_CONTEXT_WARN = 4000; // ~1,000 tokens — alert if injection alone exceeds this

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
      const timer = setInterval(() => {
        // Find our permission in the pending list and check if it has a response
        const pending = getPendingPermissions();
        const perm = pending.find(p => p.id === permId);

        if (perm && perm.response) {
          // User responded!
          clearInterval(timer);
          clearPermission(permId);
          console.log(`[PAN Hook] PermissionRequest response: ${perm.response} (${Date.now() - startTime}ms)`);
          resolve(perm.response); // 'allow' or 'deny'
        } else if (!perm) {
          // Permission was removed (e.g. expired) — deny
          clearInterval(timer);
          console.log(`[PAN Hook] PermissionRequest expired (removed from queue)`);
          resolve('deny');
        } else if (Date.now() - startTime > MAX_WAIT) {
          // Timeout — deny by default
          clearInterval(timer);
          clearPermission(permId);
          console.log(`[PAN Hook] PermissionRequest timed out after ${MAX_WAIT}ms — denying`);
          resolve('deny');
        }
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
          || /^ΠΑΝ Remembers:/i.test(p)       // break the self-injection loop
          || p.toLowerCase().startsWith('pan remembers:')
          || p.length < 2;
    };

    // Render a list of events into chat lines (up to maxChars)
    function renderEvents(events, maxChars) {
      const chatItems = [...events].reverse();
      const lines = [];
      let chars = 0;
      for (const e of chatItems) {
        try {
          const d = JSON.parse(e.data);
          let line = null;
          if (e.event_type === 'UserPromptSubmit' && d.prompt && !isNoise(d.prompt)) {
            line = `**User** (${e.created_at}): ${d.prompt.substring(0, 250)}`;
          } else if (e.event_type === 'Stop' && d.last_assistant_message) {
            line = `**Claude** (${e.created_at}): ${d.last_assistant_message.substring(0, 250)}`;
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
    const tabLines = renderEvents(tabEvents, 2000);
    if (tabLines.length > 0) {
      briefing += `### This Tab`;
      if (tabSessionId) briefing += ` *(session: ${tabSessionId.substring(0, 12)})*`;
      briefing += `\n${tabLines.join('\n')}\n\n`;
    } else if (tabClaudeSessionIds.length > 0) {
      briefing += `### This Tab\nNew tab — no prior conversation yet.\n\n`;
    }

    // Part 2 — Recent project work (most recent OTHER session)
    const projectLines = renderEvents(projectEvents, 1800);
    if (projectLines.length > 0) {
      briefing += `### Recent Project Work`;
      if (projectSession?.session_id) briefing += ` *(session: ${projectSession.session_id.substring(0, 12)})*`;
      briefing += `\n${projectLines.join('\n')}\n\n`;
    } else if (!tabClaudeSessionIds.length) {
      // No tab context AND no project context — fresh install
      briefing += `### Recent Conversation\nFresh session — no previous conversation on record.\n\n`;
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

    // Hard cap at 4100 chars (~1025 tokens) — raised from 3000 to fit two-part structure
    if (briefing.length > 4100) {
      briefing = briefing.substring(0, 4100) + '\n\n[... context trimmed ...]\n';
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
        detail: `Session injection for ${cwd} is ${briefing.length} chars (~${Math.round(briefing.length / 4)} tokens). This adds cost to every message. Sources: conversation=${recentEvents.length} exchanges, tasks=${tasks.length}.`,
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
    }

    if (eventType === 'SessionEnd') {
      runScoped(req, `UPDATE sessions SET ended_at = datetime('now','localtime'), transcript_path = :tp WHERE id = :id AND org_id = :org_id`, {
        ':id': sessionId,
        ':tp': payload.transcript_path || null
      });

      // Inject context into CLAUDE.md NOW so the NEXT session opens with fresh context
      // (Claude Code reads CLAUDE.md before SessionStart hooks run, so this must happen on SessionEnd)
      // Pass sessionId as a single-item tab array so Part 1 is scoped to the ending session.
      if (cwd) {
        injectSessionContext(cwd, req.org_id || 'org_personal', sessionId ? [sessionId] : []).catch(err => {
          console.error('[PAN Hook] SessionEnd context injection failed:', err.message);
        });
      }

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
          timestamp: new Date().toISOString(),
        });
      } catch {}
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`[PAN] Error handling ${eventType}:`, err.message);
    res.status(200).json({ ok: false, error: err.message });
  }
});

export default router;
export { injectSessionContext };
