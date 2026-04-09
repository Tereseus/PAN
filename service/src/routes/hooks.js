import { Router } from 'express';
import { run, get, all, insert, detectProject, indexEventFTS } from '../db.js';
import { broadcastNotification, addPendingPermission, getPendingPermissions, clearPermission, setInFlightTool, clearInFlightTool } from '../terminal.js';
import { buildContext as buildMemoryContext } from '../memory/index.js';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

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
    const eventId = insert(`INSERT INTO events (session_id, event_type, data, user_id) VALUES (:sid, :type, :data, :uid)`, {
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
async function injectSessionContext(cwd) {
  try {
    const claudeMdPath = join(cwd, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) return;

    const content = readFileSync(claudeMdPath, 'utf8');
    const startMarker = '<!-- PAN-CONTEXT-START -->';
    const endMarker = '<!-- PAN-CONTEXT-END -->';
    const startIdx = content.indexOf(startMarker);
    const endIdx = content.lastIndexOf(endMarker);
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return;

    // Build readable context from multiple sources

    // 1. Recent conversation — last 15 exchanges for this project
    // JSON.stringify escapes backslashes, so the DB stores C:\\Users\\ not C:\Users\
    // We need to match the JSON-escaped version (double backslashes) in the LIKE pattern
    const fwd = cwd.replace(/\\/g, '/');
    const jsonEscaped = cwd.replace(/\\/g, '\\\\');
    const recentEvents = all(
      `SELECT event_type, data, created_at FROM events
       WHERE (event_type = 'UserPromptSubmit' OR event_type = 'Stop')
       AND (data LIKE :pp1 OR data LIKE :pp2)
       ORDER BY created_at DESC LIMIT 15`,
      { ':pp1': '%' + jsonEscaped + '%', ':pp2': '%' + fwd + '%' }
    );

    // 2. Claude's auto-memory files (~/.claude/projects/*/memory/*.md) are loaded
    //    automatically by Claude Code — do NOT duplicate them here.
    //    inject-context.cjs already noted this. Duplicating wastes context tokens.

    // 3. Open tasks for this project
    const project = get("SELECT id, name FROM projects WHERE path = :p", { ':p': fwd });
    let tasks = [];
    if (project) {
      tasks = all(
        `SELECT title, status, priority FROM project_tasks
         WHERE project_id = :pid AND status != 'done'
         ORDER BY priority DESC LIMIT 10`,
        { ':pid': project.id }
      );
    }

    // Build the briefing — Recent Conversation FIRST (highest priority, drives "PAN remembers"),
    // then state dump and memory (can be truncated without breaking continuity).
    let briefing = `## PAN Session Context\n\n`;
    briefing += `This is a fresh session for the "${project?.name || 'PAN'}" project.\n`;
    briefing += `IMPORTANT: The project documentation is at the TOP of this CLAUDE.md file — read it first.\n\n`;
    briefing += `**CRITICAL INSTRUCTION:** Your FIRST message to the user MUST be a brief summary of what was discussed recently (from the "Recent Conversation" section below). Start with "\u03A0\u0391\u039D Remembers:" and list the key topics/issues. The user should never have to ask what they were working on — you tell them immediately.\n\n`;

    // PRIORITY 1: Recent conversation — this drives the "PAN remembers" briefing
    if (recentEvents.length > 0) {
      briefing += `### Recent Conversation\n`;
      const chatItems = [...recentEvents].reverse();
      for (const e of chatItems) {
        try {
          const d = JSON.parse(e.data);
          if (e.event_type === 'UserPromptSubmit' && d.prompt) {
            briefing += `**User** (${e.created_at}): ${d.prompt.substring(0, 200)}\n`;
          } else if (e.event_type === 'Stop' && d.last_assistant_message) {
            briefing += `**Claude** (${e.created_at}): ${d.last_assistant_message.substring(0, 300)}\n`;
          }
        } catch {}
      }
      briefing += '\n';
    }

    // PRIORITY 2: State dump from dream cycle
    const statePath = join(cwd, '.pan-state.md');
    if (existsSync(statePath)) {
      try {
        let stateContent = readFileSync(statePath, 'utf8').trim();
        stateContent = stateContent.replace(/<!-- PAN-CONTEXT-(START|END) -->/g, '');
        briefing += stateContent + '\n\n';
      } catch {}
    }

    // PRIORITY 3: Vector memory
    try {
      const memResult = await buildMemoryContext('session context', { tokenBudget: 2000 });
      if (memResult.context) {
        briefing += memResult.context + '\n\n';
      }
    } catch {}

    // PRIORITY 4: Open tasks
    if (tasks.length > 0) {
      briefing += `### Open Tasks\n`;
      for (const t of tasks) {
        briefing += `- [${t.status}${t.priority > 0 ? ' P' + t.priority : ''}] ${t.title}\n`;
      }
      briefing += '\n';
    }

    // Sanitize — strip any literal PAN-CONTEXT markers from injected content
    briefing = briefing.replace(/<!-- PAN-CONTEXT-(START|END) -->/g, '');

    // Cap injection to ~12000 chars (increased from 10k to accommodate conversation + state)
    if (briefing.length > 12000) {
      briefing = briefing.substring(0, 12000) + '\n\n[... context trimmed ...]\n';
    }

    // Write to CLAUDE.md
    const newContent = content.substring(0, startIdx + startMarker.length) + '\n' +
      briefing +
      content.substring(endIdx);
    writeFileSync(claudeMdPath, newContent, 'utf8');
    console.log(`[PAN Hook] Injected session context into ${claudeMdPath}`);
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
    const existingSession = get("SELECT id FROM sessions WHERE id = :id", { ':id': sessionId });
    if (!existingSession) {
      run(`INSERT INTO sessions (id, cwd, model, source, transcript_path, user_id)
        VALUES (:id, :cwd, :model, :source, :tp, :uid)`, {
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
        run("UPDATE sessions SET project_id = :pid WHERE id = :id", {
          ':pid': project.id,
          ':id': sessionId
        });
      }
    }

    if (eventType === 'SessionStart') {
      if (existingSession) {
        // Update existing session with fresh metadata
        run(`UPDATE sessions SET
          model = COALESCE(:model, model),
          source = COALESCE(:source, source),
          transcript_path = COALESCE(:tp, transcript_path)
          WHERE id = :id`, {
          ':id': sessionId,
          ':model': payload.model || null,
          ':source': payload.source || null,
          ':tp': payload.transcript_path || null
        });
      }
    }

    if (eventType === 'SessionEnd') {
      run(`UPDATE sessions SET ended_at = datetime('now','localtime'), transcript_path = :tp WHERE id = :id`, {
        ':id': sessionId,
        ':tp': payload.transcript_path || null
      });

      // Inject context into CLAUDE.md NOW so the NEXT session opens with fresh context
      // (Claude Code reads CLAUDE.md before SessionStart hooks run, so this must happen on SessionEnd)
      if (cwd) {
        injectSessionContext(cwd).catch(err => {
          console.error('[PAN Hook] SessionEnd context injection failed:', err.message);
        });
      }
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
    const eventId = insert(`INSERT INTO events (session_id, event_type, data, user_id) VALUES (:sid, :type, :data, :uid)`, {
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
            const msgId = insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, 'AssistantMessage', :data)`, {
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

    // Notify dashboard clients of new events so chat updates instantly
    if (eventType === 'UserPromptSubmit' || eventType === 'Stop' || eventType === 'AssistantMessage') {
      try {
        broadcastNotification('chat_update', {
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
