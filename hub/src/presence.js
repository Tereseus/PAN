// Presence tracking — who's online, offline, away

import { getDb } from './db.js';

// In-memory connection map: instanceId → { ws, connectedAt, lastActivity }
const connections = new Map();

// Ping interval (30s)
const PING_INTERVAL = 30_000;
// Away threshold (30 minutes of no messages sent)
const AWAY_THRESHOLD = 30 * 60 * 1000;

let pingTimer;

export function startPresence() {
  pingTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, conn] of connections) {
      if (conn.ws.readyState === 1) { // OPEN
        conn.ws.ping();
      } else {
        removeConnection(id);
      }
    }
  }, PING_INTERVAL);
  pingTimer.unref();
}

export function stopPresence() {
  if (pingTimer) clearInterval(pingTimer);
}

/**
 * Register a WebSocket connection for an instance
 */
export function addConnection(instanceId, ws) {
  // Close existing connection if any (one connection per instance)
  const existing = connections.get(instanceId);
  if (existing && existing.ws !== ws && existing.ws.readyState === 1) {
    existing.ws.close(4001, 'Replaced by new connection');
  }

  connections.set(instanceId, {
    ws,
    connectedAt: Date.now(),
    lastActivity: Date.now()
  });

  getDb().prepare('UPDATE instances SET last_seen = ? WHERE id = ?').run(Date.now(), instanceId);
}

/**
 * Remove a connection (on disconnect)
 */
export function removeConnection(instanceId) {
  connections.delete(instanceId);
  getDb().prepare('UPDATE instances SET last_seen = ? WHERE id = ?').run(Date.now(), instanceId);
}

/**
 * Touch activity timestamp (on message sent)
 */
export function touchActivity(instanceId) {
  const conn = connections.get(instanceId);
  if (conn) conn.lastActivity = Date.now();
}

/**
 * Get status of an instance
 */
export function getStatus(instanceId) {
  const conn = connections.get(instanceId);
  if (!conn || conn.ws.readyState !== 1) return 'offline';
  if (Date.now() - conn.lastActivity > AWAY_THRESHOLD) return 'away';
  return 'online';
}

/**
 * Get the WebSocket for an instance (if online)
 */
export function getSocket(instanceId) {
  const conn = connections.get(instanceId);
  if (conn && conn.ws.readyState === 1) return conn.ws;
  return null;
}

/**
 * Get all online instance IDs
 */
export function getOnlineInstances() {
  const online = [];
  for (const [id, conn] of connections) {
    if (conn.ws.readyState === 1) online.push(id);
  }
  return online;
}

/**
 * Get presence for multiple instances (for org member lists)
 */
export function getPresenceBatch(instanceIds) {
  return instanceIds.map(id => ({ id, status: getStatus(id) }));
}
