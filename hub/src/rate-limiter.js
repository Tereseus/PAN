// Per-instance rate limiting — 100 messages per minute

import { getDb } from './db.js';

const MAX_MESSAGES_PER_MINUTE = 100;

/**
 * Check if an instance is rate-limited
 * @returns {{ allowed: boolean, remaining: number }}
 */
export function checkRate(instanceId) {
  const db = getDb();
  const windowStart = Math.floor(Date.now() / 60_000) * 60_000; // current minute

  const row = db.prepare(
    'SELECT message_count FROM rate_limits WHERE instance_id = ? AND window_start = ?'
  ).get(instanceId, windowStart);

  const count = row?.message_count || 0;
  return {
    allowed: count < MAX_MESSAGES_PER_MINUTE,
    remaining: Math.max(0, MAX_MESSAGES_PER_MINUTE - count)
  };
}

/**
 * Record a message from an instance
 */
export function recordMessage(instanceId) {
  const db = getDb();
  const windowStart = Math.floor(Date.now() / 60_000) * 60_000;

  db.prepare(`
    INSERT INTO rate_limits (instance_id, window_start, message_count)
    VALUES (?, ?, 1)
    ON CONFLICT(instance_id, window_start)
    DO UPDATE SET message_count = message_count + 1
  `).run(instanceId, windowStart);
}

/**
 * Cleanup old rate limit entries (called periodically)
 */
export function cleanupRateLimits() {
  const cutoff = Date.now() - 5 * 60_000; // keep last 5 minutes
  getDb().prepare('DELETE FROM rate_limits WHERE window_start < ?').run(cutoff);
}
