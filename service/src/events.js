// Scope-aware event logging.
//
// db.js owns the canonical pan.db connection and `logEvent()` for it.
// db-registry.js lazily opens sibling SQLCipher files for non-main scopes
// (incognito, org-*, phone-*).
//
// This module is the bridge: it lets ingress code call one function and
// have writes routed to whichever DB the request's `scope` tag selects.
// Ingress code (api.js, terminal hooks, etc.) reads the X-PAN-Scope header
// into `req.panScope` and passes it through here.

import { logEvent as logEventMain, _extractEventText } from './db.js';
import { getDb } from './db-registry.js';

/**
 * Log an event into the named scope. 'main' delegates to the canonical
 * pan.db logger for full backwards compatibility (FTS5 hook, vector index
 * queue, etc.). Other scopes resolve through db-registry, which lazily
 * opens an isolated SQLCipher sibling file with the same schema.
 *
 * @param {string} scope - 'main' | 'incognito' | 'org-acme' | ...
 * @param {string} sessionId
 * @param {string} eventType
 * @param {object|string} data
 * @param {number|null} userId
 * @returns {number} the new event id
 */
function logEventScoped(scope, sessionId, eventType, data, userId = null) {
  const tag = scope || 'main';
  if (tag === 'main') return logEventMain(sessionId, eventType, data, userId);

  const db = getDb(tag);
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);

  // better-sqlite3 wants named-param objects WITHOUT the leading colon —
  // db.js uses fixParams() to strip it; we just bind unprefixed keys here.
  let eventId;
  if (userId) {
    const info = db.prepare(
      `INSERT INTO events (session_id, event_type, data, user_id) VALUES (:sid, :type, :data, :uid)`
    ).run({ sid: sessionId, type: eventType, data: dataStr, uid: userId });
    eventId = info.lastInsertRowid;
  } else {
    const info = db.prepare(
      `INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`
    ).run({ sid: sessionId, type: eventType, data: dataStr });
    eventId = info.lastInsertRowid;
  }

  // Mirror into the scoped events_fts (same schema, same insert pattern).
  try {
    const text = _extractEventText(eventType, dataStr);
    if (text) db.prepare('INSERT INTO events_fts(rowid, content_text) VALUES (?, ?)').run(eventId, text.slice(0, 2000));
  } catch {}

  // Queue for vector embedding on this scope. Fire-and-forget so writes
  // never block on Ollama latency.
  import('./memory-search.js').then(m => m.indexEventForSearch(tag, eventId)).catch(() => {});

  return eventId;
}

export { logEventScoped };
