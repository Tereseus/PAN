// Cloud-Claude capture write-back (SHIP-PLAN Phase 2).
//
// The biggest gap vs. the "PAN remembers everything" pitch: the Claude Code
// CLI auto-captures every session via hooks, but the desktop app, Claude.ai,
// and Cowork have NO write-back — their conversations never reach the DB.
//
// This endpoint closes it. The `pan_log_exchange` MCP tool POSTs each
// meaningful exchange here, and we write it into `events` as a CloudExchange
// row — FTS-indexed and embedded just like CLI events, so pan_search finds it
// exactly the same way.

import { Router } from 'express';
import { logEvent } from '../db.js';

const router = Router();

// POST /api/v1/exchange
// Body: { user_message, assistant_message, topic?, client?, session_id?, metadata? }
router.post('/', (req, res) => {
  try {
    const b = req.body || {};
    const userMsg = String(b.user_message || b.user || '').trim();
    const asstMsg = String(b.assistant_message || b.assistant || b.response || '').trim();
    if (!userMsg && !asstMsg) {
      return res.status(400).json({ ok: false, error: 'user_message or assistant_message required' });
    }
    const client = String(b.client || 'cloud-claude').slice(0, 60);
    // Stable per-conversation id so a whole conversation groups together.
    // Caller should reuse one session_id across its turns; we fall back to a
    // per-write id when absent.
    const sessionId = String(b.session_id || `${client}-${Date.now()}`).slice(0, 120);

    logEvent(sessionId, 'CloudExchange', {
      client,
      topic: b.topic ? String(b.topic).slice(0, 200) : null,
      user_message: userMsg.slice(0, 8000),
      assistant_message: asstMsg.slice(0, 16000),
      metadata: b.metadata && typeof b.metadata === 'object' ? b.metadata : null,
      logged_at: Date.now(),
    });

    res.json({ ok: true, session_id: sessionId, client, stored: 'events' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
