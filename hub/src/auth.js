// Hub authentication — Ed25519 challenge/response
// No passwords, no OAuth — pure cryptographic identity.

import crypto from 'crypto';
import { getDb } from './db.js';

// Active challenges (nonce → { created })
// Nonces are single-use and expire after 30 seconds
const pendingChallenges = new Map();

// Cleanup stale challenges every 60s
setInterval(() => {
  const cutoff = Date.now() - 30_000;
  for (const [nonce, data] of pendingChallenges) {
    if (data.created < cutoff) pendingChallenges.delete(nonce);
  }
}, 60_000).unref();

/**
 * Derive PAN instance ID from raw 32-byte Ed25519 public key (base64)
 * pan_ + first 16 hex chars of SHA-256(publicKey)
 */
export function deriveInstanceId(publicKeyBase64) {
  const hash = crypto.createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex');
  return 'pan_' + hash.slice(0, 16);
}

/**
 * Generate a challenge for a connecting instance
 */
export function generateChallenge() {
  const nonce = crypto.randomBytes(32).toString('base64');
  pendingChallenges.set(nonce, { created: Date.now() });
  return { nonce };
}

/**
 * Verify a challenge response
 * @param {string} nonce - The challenge nonce
 * @param {string} instanceId - Claimed pan_xxxx ID
 * @param {string} signature - Base64 Ed25519 signature of: nonce|timestamp|instanceId
 * @param {string} timestamp - ISO timestamp (must be within 30s of now)
 * @param {string} publicKey - Base64 raw Ed25519 public key (32 bytes). Required for first registration.
 * @returns {{ ok: boolean, instanceId?: string, registered?: boolean, error?: string }}
 */
export function verifyChallenge(nonce, instanceId, signature, timestamp, publicKey) {
  // Check nonce exists and hasn't been used
  if (!pendingChallenges.has(nonce)) {
    return { ok: false, error: 'Invalid or expired nonce' };
  }
  pendingChallenges.delete(nonce); // single-use

  // Check timestamp freshness (30 second window)
  const ts = new Date(timestamp).getTime();
  if (isNaN(ts) || Math.abs(Date.now() - ts) > 30_000) {
    return { ok: false, error: 'Timestamp too old or invalid' };
  }

  const db = getDb();
  let instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(instanceId);

  if (!instance && publicKey) {
    // First-time registration — verify ID matches key
    const derivedId = deriveInstanceId(publicKey);
    if (derivedId !== instanceId) {
      return { ok: false, error: 'Instance ID does not match public key' };
    }

    if (!ed25519Verify(publicKey, nonce, instanceId, timestamp, signature)) {
      return { ok: false, error: 'Invalid signature' };
    }

    db.prepare(`
      INSERT INTO instances (id, public_key, registered_at, last_seen)
      VALUES (?, ?, ?, ?)
    `).run(instanceId, publicKey, Date.now(), Date.now());

    console.log(`[hub-auth] New instance registered: ${instanceId}`);
    return { ok: true, instanceId, registered: true };
  }

  if (!instance) {
    return { ok: false, error: 'Unknown instance — include publicKey to register' };
  }

  if (instance.banned) {
    return { ok: false, error: 'Instance is banned' };
  }

  if (!ed25519Verify(instance.public_key, nonce, instanceId, timestamp, signature)) {
    return { ok: false, error: 'Invalid signature' };
  }

  db.prepare('UPDATE instances SET last_seen = ? WHERE id = ?').run(Date.now(), instanceId);
  return { ok: true, instanceId };
}

/**
 * Register a device (phone) under a PAN instance
 */
export function registerDevice(ownerInstanceId, devicePublicKey, deviceNameEncrypted) {
  const db = getDb();
  const owner = db.prepare('SELECT id FROM instances WHERE id = ?').get(ownerInstanceId);
  if (!owner) return { ok: false, error: 'Owner instance not found' };

  const deviceId = 'dev_' + crypto.createHash('sha256')
    .update(Buffer.from(devicePublicKey, 'base64')).digest('hex').slice(0, 16);

  db.prepare(`
    INSERT OR REPLACE INTO devices (id, owner_instance_id, public_key, device_name_encrypted, registered_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(deviceId, ownerInstanceId, devicePublicKey, deviceNameEncrypted || null, Date.now(), Date.now());

  console.log(`[hub-auth] Device ${deviceId} registered under ${ownerInstanceId}`);
  return { ok: true, deviceId };
}

/**
 * Verify Ed25519 signature
 * Message format: nonce|timestamp|instanceId
 */
function ed25519Verify(publicKeyBase64, nonce, instanceId, timestamp, signatureBase64) {
  try {
    const message = Buffer.from(`${nonce}|${timestamp}|${instanceId}`);
    const signature = Buffer.from(signatureBase64, 'base64');
    const rawKey = Buffer.from(publicKeyBase64, 'base64');

    // Import raw 32-byte Ed25519 public key
    const keyObj = crypto.createPublicKey({
      key: Buffer.concat([
        // DER prefix for Ed25519: SEQUENCE { SEQUENCE { OID 1.3.101.112 } BIT STRING }
        Buffer.from('302a300506032b6570032100', 'hex'),
        rawKey
      ]),
      format: 'der',
      type: 'spki'
    });

    return crypto.verify(null, message, keyObj, signature);
  } catch (e) {
    console.error(`[hub-auth] Verify failed:`, e.message);
    return false;
  }
}
