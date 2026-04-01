import { Router } from 'express';
import { run, get, all, insert, detectProject, logEvent } from '../db.js';
import { broadcastNotification, addPendingPermission, getPendingPermissions, clearPermission } from '../terminal.js';
import { consolidate as consolidateMemory } from '../memory/consolidation.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
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
    logEvent(sessionId, 'PermissionRequest', payload, req.user?.id || null);

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
function injectSessionContext(cwd) {
  try {
    const claudeMdPath = join(cwd, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) return;

    const content = readFileSync(claudeMdPath, 'utf8');
    const startMarker = '<!-- PAN-CONTEXT-START -->';
    const endMarker = '<!-- PAN-CONTEXT-END -->';
    const startIdx = content.indexOf(startMarker);
    const endIdx = content.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1) return;

    // Build readable context from multiple sources

    // 0. Feature registry — so every Claude session knows all PAN capabilities
    const featuresPath = join(cwd, 'FEATURES.md');
    let featuresContent = '';
    if (existsSync(featuresPath)) {
      featuresContent = readFileSync(featuresPath, 'utf8');
    }

    // 1. Recent conversation — last 15 exchanges for this project, within 48h
    // Use project→sessions join instead of fragile LIKE on data (backslash escaping broke matching)
    const fwd = cwd.replace(/\\/g, '/');
    const project = get("SELECT id, name FROM projects WHERE path = :p", { ':p': fwd });
    let recentEvents = [];
    if (project) {
      recentEvents = all(
        `SELECT e.event_type, e.data, e.created_at FROM events e
         JOIN sessions s ON e.session_id = s.id
         WHERE s.project_id = :pid
         AND (e.event_type = 'UserPromptSubmit' OR e.event_type = 'Stop')
         AND e.created_at > datetime('now', '-48 hours', 'localtime')
         ORDER BY e.created_at DESC LIMIT 15`,
        { ':pid': project.id }
      );
    }

    // NOTE: Claude Code already reads .claude/projects/.../memory/ natively.
    // No need to inject them here — that was causing everything to appear twice.

    // 3. Open tasks for this project (project already fetched above for events query)
    let tasks = [];
    if (project) {
      tasks = all(
        `SELECT title, status, priority FROM project_tasks
         WHERE project_id = :pid AND status != 'done'
         ORDER BY priority DESC LIMIT 10`,
        { ':pid': project.id }
      );
    }

    // Build the briefing
    let briefing = `## PAN Session Context\n\n`;
    briefing += `This is a fresh session for the "${project?.name || 'PAN'}" project.\n`;
    briefing += `IMPORTANT: The project documentation is at the TOP of this CLAUDE.md file — read it first.\n\n`;
    briefing += `**CRITICAL INSTRUCTION:** Your FIRST message to the user MUST be a brief summary of what was discussed recently (from the "Recent Conversation" section below). Start with something like "Last time we were working on..." and list the key topics/issues. The user should never have to ask what they were working on — you tell them immediately.\n\n`;

    // Feature registry — canonical list of PAN capabilities
    if (featuresContent) {
      briefing += `### PAN Features (Auto-Injected)\n\n`;
      briefing += `The complete feature registry is in FEATURES.md. Reference it when the user mentions any PAN feature.\n`;
      briefing += `Key: You ARE PAN. These are YOUR features. When the user says "remember your features" or "you can do X" — this is what they mean.\n\n`;
    }

    // Open tasks
    if (tasks.length > 0) {
      briefing += `### Open Tasks\n`;
      for (const t of tasks) {
        briefing += `- [${t.status}${t.priority > 0 ? ' P' + t.priority : ''}] ${t.title}\n`;
      }
      briefing += '\n';
    }

    // Recent conversation summary
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

      // Include last few messages at full length for context (trimmed to reduce CLAUDE.md bloat)
      const lastMessages = chatItems.slice(-4); // last 4 messages (2 exchanges)
      if (lastMessages.length > 0) {
        briefing += `### Last Messages (Full)\n`;
        for (const e of lastMessages) {
          try {
            const d = JSON.parse(e.data);
            if (e.event_type === 'UserPromptSubmit' && d.prompt) {
              briefing += `**User** (${e.created_at}):\n${d.prompt.substring(0, 3000)}\n\n`;
            } else if (e.event_type === 'Stop' && d.last_assistant_message) {
              briefing += `**Claude** (${e.created_at}):\n${d.last_assistant_message.substring(0, 3000)}\n\n`;
            }
          } catch {}
        }
      }
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
      // Inject readable context into CLAUDE.md for this project
      if (cwd) {
        injectSessionContext(cwd);
      }
    }

    // Also inject context on first UserPromptSubmit for a session
    // SessionStart hooks often don't fire (server not up yet, timing issues)
    // so we use the first prompt as a reliable fallback
    if (eventType === 'UserPromptSubmit' && !existingSession && cwd) {
      injectSessionContext(cwd);
    }

    if (eventType === 'SessionEnd') {
      run(`UPDATE sessions SET ended_at = datetime('now','localtime'), transcript_path = :tp WHERE id = :id`, {
        ':id': sessionId,
        ':tp': payload.transcript_path || null
      });

      // Trigger memory consolidation in background (don't block the response)
      consolidateMemory({ useLLM: false }).catch(err =>
        console.error('[PAN Hook] Memory consolidation error:', err.message)
      );
    }

    // Store every event (logEvent handles insert + FTS indexing)
    logEvent(sessionId, eventType, payload, req.user?.id || null);

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
            logEvent(sessionId, 'AssistantMessage', { text: assistantTexts[i], cwd: cwd }, req.user?.id || null);
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
