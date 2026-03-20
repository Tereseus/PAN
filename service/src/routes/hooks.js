import { Router } from 'express';
import { run, get, insert, detectProject } from '../db.js';

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

    if (eventType === 'SessionStart') {
      // Check if session exists
      const existing = get("SELECT id FROM sessions WHERE id = :id", { ':id': sessionId });

      if (existing) {
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
      } else {
        run(`INSERT INTO sessions (id, cwd, model, source, transcript_path)
          VALUES (:id, :cwd, :model, :source, :tp)`, {
          ':id': sessionId,
          ':cwd': cwd,
          ':model': payload.model || null,
          ':source': payload.source || null,
          ':tp': payload.transcript_path || null
        });
      }

      // Auto-detect project
      if (cwd) {
        const project = detectProject(cwd);
        run("UPDATE sessions SET project_id = :pid WHERE id = :id", {
          ':pid': project.id,
          ':id': sessionId
        });
      }
    }

    if (eventType === 'SessionEnd') {
      run(`UPDATE sessions SET ended_at = datetime('now'), transcript_path = :tp WHERE id = :id`, {
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

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`[PAN] Error handling ${eventType}:`, err.message);
    res.status(200).json({ ok: false, error: err.message });
  }
});

export default router;
