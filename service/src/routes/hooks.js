import { Router } from 'express';
import { run, get, insert, detectProject } from '../db.js';
import { broadcastNotification } from '../terminal.js';

const router = Router();

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
    insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`, {
      ':sid': sessionId,
      ':type': eventType,
      ':data': JSON.stringify(payload)
    });

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
