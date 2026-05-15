// Action engine — turns an "act" verdict from the intuition deliberation into
// an actual delivered interjection across PAN's channels.
//
// Channels (best-effort, all independent — one failing doesn't block the rest):
//   1. ΠΑΝ chat thread     (panNotify → chat_messages) — dashboard sees it
//   2. WebSocket broadcast (broadcastNotification 'pan_interjection') — live UI signal
//   3. Connected clients   (sendToClient → speak/notify) — phone TTS, desktop popup
//
// Dedupe lives upstream: the scorer in intuition/index.js only calls dispatch()
// when the (verdict, candidate-id) key flips. We track each dispatched action's
// key in `pan_interjections` so we can:
//   • Survey acceptance (was it acted on by user? dismissed? ignored?)
//   • Feed the weight-learning loop (dismissed 3× → drop need weight)
//
// Phrasing is candidate-specific — a Nourishment nudge sounds different from a
// Rest nudge. Templates live in `phrasings` below; richer LLM-generated copy
// can be layered in later by checking a phrasing override.

import { panNotify } from '../pan-notify.js';
import { run, get, all } from '../db.js';

// Lazy imports so we don't crash if terminal/client-manager aren't yet up.
let _broadcast = null;
let _sendToClient = null;
let _getConnectedClients = null;
async function lazyChannels() {
  if (!_broadcast) {
    try {
      const t = await import('../terminal.js');
      _broadcast = t.broadcastNotification || null;
    } catch { /* terminal may be down */ }
  }
  if (!_sendToClient) {
    try {
      const c = await import('../client-manager.js');
      _sendToClient = c.fireToClient || c.sendToClient || null;
      _getConnectedClients = c.getConnectedClients || null;
    } catch { /* client manager may be down */ }
  }
}

// ── Phrasings ─────────────────────────────────────────────────────────────────
// Each entry: (candidate) → { subject, body, speak }
//   subject: shown in chat list / preview
//   body:    full message in the ΠΑΝ thread
//   speak:   what gets spoken out loud on phone/desktop (TTS-friendly, no markup)
const phrasings = {
  'need:nourishment': (c) => ({
    subject: 'Want a meal break?',
    body: `Heads up — Nourishment is at ${Math.round(c.level)}/100${c.hours ? `, about ${c.hours}h since you last ate` : ''}. Want a meal break?`,
    speak: `You haven't eaten in a while. Want to take a meal break?`,
  }),
  'need:hydration': (c) => ({
    subject: 'Glass of water?',
    body: `Hydration is at ${Math.round(c.level)}/100${c.hours ? `, ${c.hours}h since your last drink` : ''}. Grab some water?`,
    speak: `Hydration check — want to grab a glass of water?`,
  }),
  'need:rest': (c) => ({
    subject: 'Time for a break?',
    body: `Rest is at ${Math.round(c.level)}/100. A short break would help.`,
    speak: `You've been at this a while. Want to take a quick break?`,
  }),
  'need:social': (c) => ({
    subject: 'Reach out to someone?',
    body: `Social is at ${Math.round(c.level)}/100. Worth a quick message to a friend?`,
    speak: `Social meter is low. Want me to remind you to reach out to someone?`,
  }),
  'need:focus': (c) => ({
    subject: 'Focus is dropping',
    body: `Focus is at ${Math.round(c.level)}/100. Consider a reset — short walk, water, something to refocus.`,
    speak: `Focus is dropping. Reset might help.`,
  }),
  'state:emergency': (c) => ({
    subject: 'Checking in',
    body: c.reason || 'Something looked off. Are you OK?',
    speak: 'Hey — checking in. Are you OK?',
  }),
  'state:not_ok': (c) => ({
    subject: 'Checking in',
    body: c.reason || 'Read you might not be doing great. Anything I can help with?',
    speak: 'How are you doing? Anything I can help with?',
  }),
  'state:quiet': (c) => ({
    subject: 'Still here when you need me',
    body: c.reason || 'Quiet for a while — just letting you know I\'m around.',
    speak: 'Still around if you need me.',
  }),
};

function phraseFor(candidate) {
  // candidate.id looks like "need:nourishment" or "state:not_ok"; fall back
  // to the kind: prefix, then a generic message.
  const direct = phrasings[candidate.id];
  if (direct) return direct(candidate);
  if (candidate.id.startsWith('need:')) {
    const need = candidate.id.split(':')[1] || 'something';
    return {
      subject: `${need} is low`,
      body: `${candidate.reason || `${need} is low`}.`,
      speak: `${need} is low.`,
    };
  }
  return {
    subject: candidate.reason || 'PAN is checking in',
    body: candidate.reason || 'Something to note.',
    speak: candidate.reason || 'PAN is checking in.',
  };
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * Deliver an interjection across all channels. Idempotent on (key, day) — if
 * the same key was dispatched in the last DEDUPE_MS window, skip. (Independent
 * from the scorer's in-process dedupe; this is the persistence-backed guard.)
 *
 * @param {object} candidate     { id, kind, score, reason, level?, hours?, weight? }
 * @param {object} [opts]
 * @param {string} [opts.userId]
 * @param {object} [opts.scoreCtx]  extra ctx for the audit row
 * @returns {Promise<{ dispatched: boolean, reason?: string, msgId?: string }>}
 */
export async function dispatchAction(candidate, opts = {}) {
  if (!candidate || !candidate.id) return { dispatched: false, reason: 'no candidate' };
  const userId = opts.userId || 'unknown';
  const key = `act:${candidate.id}`;

  // Persistence dedupe: same key within 30 min → skip. (Different from the
  // upstream verdict-flip dedupe, which catches re-firing within a single
  // process — this catches restart loops and parallel callers.)
  const DEDUPE_MS = 30 * 60_000;
  try {
    const recent = get(
      `SELECT id, created_at FROM pan_interjections
       WHERE user_id = :u AND action_key = :k
         AND created_at > datetime('now', '-30 minutes')
       ORDER BY id DESC LIMIT 1`,
      { ':u': userId, ':k': key }
    );
    if (recent) return { dispatched: false, reason: 'deduped (recent)' };
  } catch { /* table may not exist yet on first run */ }

  const phrase = phraseFor(candidate);
  await lazyChannels();

  // Channel 1: ΠΑΝ chat thread (always — this is the persistent visible record)
  let chatMsgId = null;
  try {
    chatMsgId = panNotify('intuition', phrase.subject, phrase.body, {
      severity: 'info',
      metadata: {
        kind: 'interjection',
        action_key: key,
        candidate_id: candidate.id,
        score: candidate.score,
        reason: candidate.reason,
        speak: phrase.speak,
      },
    });
  } catch (e) {
    console.warn('[Intuition/Action] panNotify failed:', e.message);
  }

  // Channel 2: WebSocket broadcast — dashboards can show a transient toast.
  try {
    if (_broadcast) {
      _broadcast('pan_interjection', {
        candidate_id: candidate.id,
        action_key: key,
        subject: phrase.subject,
        body: phrase.body,
        speak: phrase.speak,
        score: candidate.score,
        chat_msg_id: chatMsgId,
        user_id: userId,
      });
    }
  } catch (e) {
    console.warn('[Intuition/Action] WS broadcast failed:', e.message);
  }

  // Channel 3: connected clients — fire-and-forget speak/notify to phone +
  // desktop. Best-effort; offline devices are skipped.
  let clientFanout = 0;
  try {
    if (_sendToClient && _getConnectedClients) {
      const clients = _getConnectedClients() || [];
      for (const cl of clients) {
        if (!cl?.device_id) continue;
        try {
          _sendToClient(cl.device_id, 'speak', {
            text: phrase.speak,
            subject: phrase.subject,
            source: 'pan-interjection',
            action_key: key,
          });
          clientFanout++;
        } catch { /* per-client errors are non-fatal */ }
      }
    }
  } catch (e) {
    console.warn('[Intuition/Action] client fanout failed:', e.message);
  }

  // Record the dispatch for learning + dedupe.
  try {
    run(
      `INSERT INTO pan_interjections
        (user_id, action_key, candidate_id, score, reason, speak, subject, body, chat_msg_id, client_fanout, status)
       VALUES (:u, :k, :c, :s, :r, :sp, :sub, :b, :cm, :cf, 'delivered')`,
      {
        ':u': userId,
        ':k': key,
        ':c': candidate.id,
        ':s': candidate.score || 0,
        ':r': candidate.reason || '',
        ':sp': phrase.speak,
        ':sub': phrase.subject,
        ':b': phrase.body,
        ':cm': chatMsgId,
        ':cf': clientFanout,
      }
    );
  } catch (e) {
    console.warn('[Intuition/Action] persist failed:', e.message);
  }

  console.log(`[Intuition/Action] 🗯 dispatched ${key} → chat:${chatMsgId ? 'ok' : 'fail'} ws:${_broadcast ? 'ok' : 'skip'} clients:${clientFanout}`);
  return { dispatched: true, msgId: chatMsgId, clientFanout };
}

/**
 * Recent delivered interjections — for dashboard timeline + the learning loop.
 */
export function recentInterjections({ userId = null, limit = 20 } = {}) {
  const lim = Math.max(1, Math.min(200, parseInt(limit) || 20));
  if (userId) {
    return all(
      `SELECT * FROM pan_interjections WHERE user_id = :u ORDER BY id DESC LIMIT ${lim}`,
      { ':u': userId }
    );
  }
  return all(`SELECT * FROM pan_interjections ORDER BY id DESC LIMIT ${lim}`);
}

/**
 * Record user feedback on a delivered interjection. Updates status + feeds
 * the per-need weight learning loop:
 *   • 'accept'   → +0.1 to need weight (user wants more of these)
 *   • 'dismiss'  → -0.1 to need weight (user wants fewer)
 *   • 'snooze'   → no weight change, just bumps action_key dedupe for 2h
 *   • 'thanks'   → +0.15 (strong positive)
 */
export async function recordFeedback(interjectionId, feedback, opts = {}) {
  if (!interjectionId || !feedback) return { ok: false, error: 'id and feedback required' };
  const row = get(`SELECT * FROM pan_interjections WHERE id = :id`, { ':id': interjectionId });
  if (!row) return { ok: false, error: 'not found' };
  run(
    `UPDATE pan_interjections SET status = :s, feedback_at = datetime('now','localtime') WHERE id = :id`,
    { ':s': feedback, ':id': interjectionId }
  );
  // Weight adjustments only meaningful for need-type candidates.
  let weightDelta = 0;
  if (row.candidate_id?.startsWith('need:')) {
    const needId = row.candidate_id.split(':')[1];
    if (feedback === 'accept')     weightDelta = +0.1;
    else if (feedback === 'thanks')  weightDelta = +0.15;
    else if (feedback === 'dismiss') weightDelta = -0.1;
    else if (feedback === 'snooze')  weightDelta = 0;
    if (weightDelta !== 0) {
      const { adjustWeight } = await import('./needs.js');
      adjustWeight(row.user_id, needId, weightDelta);
    }
  }
  return { ok: true, weightDelta, status: feedback };
}
