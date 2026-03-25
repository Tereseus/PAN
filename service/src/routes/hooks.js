import { Router } from 'express';
import { run, get, insert, detectProject, indexEventFTS } from '../db.js';
import { broadcastNotification, addPendingPermission, getPendingPermissions, clearPermission } from '../terminal.js';

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
    const eventId = insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`, {
      ':sid': sessionId,
      ':type': 'PermissionRequest',
      ':data': dataStr
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

    res.status(200).json({ behavior: result });
  } catch (err) {
    console.error(`[PAN Hook] Error handling PermissionRequest:`, err.message);
    res.status(200).json({ behavior: 'deny' });
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
    const existingSession = get("SELECT id FROM sessions WHERE id = :id", { ':id': sessionId });
    if (!existingSession) {
      run(`INSERT INTO sessions (id, cwd, model, source, transcript_path)
        VALUES (:id, :cwd, :model, :source, :tp)`, {
        ':id': sessionId,
        ':cwd': cwd,
        ':model': payload.model || null,
        ':source': payload.source || null,
        ':tp': payload.transcript_path || null
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

    if (eventType === 'SessionStart' && existingSession) {
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

    if (eventType === 'SessionEnd') {
      run(`UPDATE sessions SET ended_at = datetime('now','localtime'), transcript_path = :tp WHERE id = :id`, {
        ':id': sessionId,
        ':tp': payload.transcript_path || null
      });
    }

    // Store every event
    const dataStr = JSON.stringify(payload);
    const eventId = insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`, {
      ':sid': sessionId,
      ':type': eventType,
      ':data': dataStr
    });

    // Index into FTS for instant search
    indexEventFTS(eventId, eventType, dataStr);

    // Notify dashboard clients of new events so chat updates instantly
    if (eventType === 'UserPromptSubmit' || eventType === 'Stop') {
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
