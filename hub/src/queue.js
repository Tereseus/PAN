// Offline message queue — stores encrypted messages for offline instances
// Default TTL: 24 hours. Max 1000 messages per recipient.

import crypto from 'crypto';
import { getDb } from './db.js';

const MAX_QUEUE_PER_INSTANCE = 1000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Queue a message for offline delivery
 */
export function enqueue(fromInstance, toInstance, type, payloadEncrypted, ttlMs) {
  const db = getDb();
  const now = Date.now();
  const id = 'msg_' + crypto.randomBytes(12).toString('hex');
  const expiresAt = now + (ttlMs || DEFAULT_TTL_MS);

  // Enforce queue size limit — drop oldest if full
  const count = db.prepare(
    'SELECT COUNT(*) as c FROM message_queue WHERE to_instance = ? AND delivered_at IS NULL'
  ).get(toInstance).c;

  if (count >= MAX_QUEUE_PER_INSTANCE) {
    // Delete oldest undelivered
    db.prepare(`
      DELETE FROM message_queue WHERE id IN (
        SELECT id FROM message_queue
        WHERE to_instance = ? AND delivered_at IS NULL
        ORDER BY created_at ASC LIMIT ?
      )
    `).run(toInstance, count - MAX_QUEUE_PER_INSTANCE + 1);
  }

  db.prepare(`
    INSERT INTO message_queue (id, from_instance, to_instance, type, payload_encrypted, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, fromInstance, toInstance, type, payloadEncrypted, now, expiresAt);

  return id;
}

/**
 * Get all queued messages for an instance (on reconnect)
 * Marks them as delivered.
 */
export function dequeue(instanceId) {
  const db = getDb();
  const now = Date.now();

  const messages = db.prepare(`
    SELECT id, from_instance, to_instance, type, payload_encrypted, created_at
    FROM message_queue
    WHERE to_instance = ? AND delivered_at IS NULL AND expires_at > ?
    ORDER BY created_at ASC
  `).all(instanceId, now);

  if (messages.length > 0) {
    const ids = messages.map(m => m.id);
    // Mark delivered in batches
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE message_queue SET delivered_at = ? WHERE id IN (${placeholders})`).run(now, ...ids);
  }

  return messages;
}

/**
 * Get queue depth for an instance
 */
export function queueDepth(instanceId) {
  return getDb().prepare(
    'SELECT COUNT(*) as c FROM message_queue WHERE to_instance = ? AND delivered_at IS NULL AND expires_at > ?'
  ).get(instanceId, Date.now()).c;
}

/**
 * Cleanup expired and delivered messages
 */
export function cleanup() {
  const db = getDb();
  const now = Date.now();

  // Delete expired undelivered messages
  const expired = db.prepare('DELETE FROM message_queue WHERE expires_at < ?').run(now);

  // Delete delivered messages older than 1 hour (keep briefly for dedup)
  const cutoff = now - 60 * 60 * 1000;
  const delivered = db.prepare('DELETE FROM message_queue WHERE delivered_at IS NOT NULL AND delivered_at < ?').run(cutoff);

  if (expired.changes > 0 || delivered.changes > 0) {
    console.log(`[hub-queue] Cleaned up ${expired.changes} expired, ${delivered.changes} delivered messages`);
  }
}
