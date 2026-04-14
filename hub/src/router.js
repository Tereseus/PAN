// Message router — handles routing messages between PAN instances
// The Hub routes envelopes but CANNOT read payloads (E2E encrypted).

import crypto from 'crypto';
import { getSocket, touchActivity, getStatus } from './presence.js';
import { checkRate, recordMessage } from './rate-limiter.js';
import { enqueue, dequeue } from './queue.js';
import { getDb } from './db.js';

const MAX_MESSAGE_SIZE = 64 * 1024; // 64 KB

/**
 * Route an incoming message from an authenticated instance
 * @param {object} envelope - The message envelope
 * @param {string} senderInstanceId - Verified sender ID
 * @returns {{ ok: boolean, error?: string, queued?: boolean }}
 */
export function routeMessage(envelope, senderInstanceId) {
  // Validate envelope
  if (!envelope || !envelope.to || !envelope.type || !envelope.payload) {
    return { ok: false, error: 'Invalid envelope: missing to, type, or payload' };
  }

  // Enforce sender matches authenticated identity
  if (envelope.from && envelope.from !== senderInstanceId) {
    return { ok: false, error: 'Sender mismatch — from field must match authenticated identity' };
  }
  envelope.from = senderInstanceId;

  // Size check
  const payloadSize = typeof envelope.payload === 'string' ? envelope.payload.length : 0;
  if (payloadSize > MAX_MESSAGE_SIZE) {
    return { ok: false, error: `Payload too large: ${payloadSize} > ${MAX_MESSAGE_SIZE}` };
  }

  // Rate limit
  const rate = checkRate(senderInstanceId);
  if (!rate.allowed) {
    return { ok: false, error: 'Rate limited — try again in a minute' };
  }
  recordMessage(senderInstanceId);
  touchActivity(senderInstanceId);

  // Add message ID and timestamp if missing
  if (!envelope.id) {
    envelope.id = 'msg_' + crypto.randomBytes(12).toString('hex');
  }
  if (!envelope.ts) envelope.ts = Date.now();

  // Route by type
  switch (envelope.type) {
    case 'direct':
      return routeDirect(envelope);
    case 'org':
      return routeOrg(envelope);
    case 'discovery':
      return routeDiscovery(envelope);
    case 'federation':
      return routeFederation(envelope);
    default:
      return { ok: false, error: `Unknown message type: ${envelope.type}` };
  }
}

/**
 * Direct message — one instance to another
 */
function routeDirect(envelope) {
  const ws = getSocket(envelope.to);

  if (ws) {
    ws.send(JSON.stringify({ type: 'message', envelope }));
    return { ok: true };
  } else {
    const msgId = enqueue(envelope.from, envelope.to, envelope.type, envelope.payload, envelope.ttl ? envelope.ttl * 1000 : undefined);
    return { ok: true, queued: true, msgId };
  }
}

/**
 * Org broadcast — fan out to all online members, queue for offline ones
 */
function routeOrg(envelope) {
  const orgId = envelope.to.replace(/^org:/, '');
  const db = getDb();
  const members = db.prepare(`
    SELECT instance_id FROM hub_org_members
    WHERE org_id = ? AND left_at IS NULL AND instance_id != ?
  `).all(orgId, envelope.from);

  if (members.length === 0) {
    return { ok: false, error: 'No org members found (or org not registered)' };
  }

  let delivered = 0, queued = 0;
  for (const member of members) {
    const ws = getSocket(member.instance_id);
    if (ws) {
      ws.send(JSON.stringify({ type: 'message', envelope }));
      delivered++;
    } else {
      enqueue(envelope.from, member.instance_id, envelope.type, envelope.payload, envelope.ttl ? envelope.ttl * 1000 : undefined);
      queued++;
    }
  }

  return { ok: true, delivered, queued };
}

/**
 * Discovery — check if an instance exists and its presence
 */
function routeDiscovery(envelope) {
  const db = getDb();
  const target = db.prepare('SELECT id, last_seen, banned FROM instances WHERE id = ?').get(envelope.to);

  if (!target) {
    return { ok: true, result: { found: false } };
  }

  return {
    ok: true,
    result: {
      found: true,
      status: getStatus(envelope.to),
      lastSeen: target.last_seen
    }
  };
}

/**
 * Federation — route to the org's authority instance
 */
function routeFederation(envelope) {
  const orgId = envelope.to.replace(/^org:/, '');
  const db = getDb();
  const org = db.prepare('SELECT authority_instance_id FROM hub_orgs WHERE org_id = ?').get(orgId);

  if (!org) {
    return { ok: false, error: 'Org not registered on this Hub' };
  }

  envelope.to = org.authority_instance_id;
  return routeDirect(envelope);
}

/**
 * Deliver queued messages when an instance comes online
 */
export function deliverQueued(instanceId) {
  const messages = dequeue(instanceId);
  const ws = getSocket(instanceId);

  if (ws && messages.length > 0) {
    for (const msg of messages) {
      ws.send(JSON.stringify({
        type: 'message',
        envelope: {
          id: msg.id,
          from: msg.from_instance,
          to: msg.to_instance,
          type: msg.type,
          payload: msg.payload_encrypted,
          ts: msg.created_at,
          queued: true
        }
      }));
    }
    console.log(`[hub-router] Delivered ${messages.length} queued messages to ${instanceId}`);
  }

  return messages.length;
}
