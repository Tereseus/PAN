// PAN Hub Server — Express + WebSocket
// Zero-knowledge relay for PAN instance federation.

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import { getDb } from './db.js';
import { generateChallenge, verifyChallenge, registerDevice, deriveInstanceId } from './auth.js';
import { addConnection, removeConnection, getStatus, getOnlineInstances, getPresenceBatch, startPresence } from './presence.js';
import { routeMessage, deliverQueued } from './router.js';
import { cleanup as cleanupQueue, queueDepth } from './queue.js';
import { cleanupRateLimits } from './rate-limiter.js';
import { registerOrg, addOrgMember, removeOrgMember, listOrgMembers, listInstanceOrgs, unregisterOrg } from './federation.js';

export function createServer(port, dataDir) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  // ─── Health ───
  app.get('/health', (req, res) => {
    const db = getDb();
    const instances = db.prepare('SELECT COUNT(*) as c FROM instances').get().c;
    const online = getOnlineInstances().length;
    res.json({
      status: 'ok',
      version: '0.1.0',
      uptime: Math.floor(process.uptime()),
      instances: { total: instances, online },
    });
  });

  // ─── Status page ───
  app.get('/', (req, res) => {
    const db = getDb();
    const instances = db.prepare('SELECT COUNT(*) as c FROM instances').get().c;
    const online = getOnlineInstances().length;
    const orgs = db.prepare('SELECT COUNT(*) as c FROM hub_orgs').get().c;
    res.send(`
      <html>
      <head><title>PAN Hub</title><style>
        body { font-family: monospace; background: #1e1e2e; color: #cdd6f4; padding: 2em; }
        h1 { color: #f5c2e7; } .stat { color: #a6e3a1; }
      </style></head>
      <body>
        <h1>PAN Hub</h1>
        <p>Zero-knowledge relay for PAN instances</p>
        <p>Instances: <span class="stat">${instances}</span> registered, <span class="stat">${online}</span> online</p>
        <p>Federated orgs: <span class="stat">${orgs}</span></p>
        <p>Uptime: <span class="stat">${Math.floor(process.uptime())}s</span></p>
      </body></html>
    `);
  });

  // ─── HTTP Fallback API ───

  // Get challenge nonce (for instances that auth via HTTP before upgrading to WS)
  app.post('/api/v1/challenge', (req, res) => {
    res.json(generateChallenge());
  });

  // Register a device under an instance
  app.post('/api/v1/devices/register', (req, res) => {
    const { ownerInstanceId, devicePublicKey, deviceNameEncrypted, nonce, signature, timestamp } = req.body;
    // Verify the owner is who they say they are
    const auth = verifyChallenge(nonce, ownerInstanceId, signature, timestamp);
    if (!auth.ok) return res.status(401).json(auth);

    const result = registerDevice(ownerInstanceId, devicePublicKey, deviceNameEncrypted);
    res.json(result);
  });

  // HTTP relay endpoint (fallback when WebSocket is blocked)
  app.post('/api/v1/relay', (req, res) => {
    const { instanceId, nonce, signature, timestamp, envelope } = req.body;
    const auth = verifyChallenge(nonce, instanceId, signature, timestamp);
    if (!auth.ok) return res.status(401).json(auth);

    const result = routeMessage(envelope, instanceId);
    res.json(result);
  });

  // Instance lookup (public — just returns if ID exists)
  app.get('/api/v1/instances/:id', (req, res) => {
    const db = getDb();
    const instance = db.prepare('SELECT id, registered_at, last_seen, banned FROM instances WHERE id = ?').get(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Not found' });
    res.json({
      id: instance.id,
      status: getStatus(instance.id),
      registeredAt: instance.registered_at,
      lastSeen: instance.last_seen
    });
  });

  // ─── Create HTTP server ───
  const server = http.createServer(app);

  // ─── WebSocket server ───
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws, request) => {
    let instanceId = null;
    let authenticated = false;

    // Send challenge immediately
    const challenge = generateChallenge();
    ws.send(JSON.stringify({ type: 'challenge', ...challenge }));

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
        return;
      }

      // ─── Auth flow ───
      if (msg.type === 'auth') {
        const result = verifyChallenge(msg.nonce, msg.instanceId, msg.signature, msg.timestamp, msg.publicKey);
        if (!result.ok) {
          ws.send(JSON.stringify({ type: 'auth_failed', error: result.error }));
          ws.close(4003, result.error);
          return;
        }

        instanceId = result.instanceId;
        authenticated = true;

        addConnection(instanceId, ws);

        ws.send(JSON.stringify({
          type: 'auth_ok',
          instanceId,
          registered: result.registered || false
        }));

        // Deliver queued messages
        const queued = deliverQueued(instanceId);
        if (queued > 0) {
          console.log(`[hub-ws] ${instanceId} connected, delivered ${queued} queued messages`);
        } else {
          console.log(`[hub-ws] ${instanceId} connected`);
        }
        return;
      }

      // ─── Everything below requires auth ───
      if (!authenticated) {
        ws.send(JSON.stringify({ type: 'error', error: 'Not authenticated' }));
        return;
      }

      switch (msg.type) {
        case 'message': {
          const result = routeMessage(msg.envelope, instanceId);
          ws.send(JSON.stringify({ type: 'message_ack', id: msg.envelope?.id, ...result }));
          break;
        }

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          break;
        }

        case 'presence': {
          // Get presence of specific instances
          if (msg.instanceIds && Array.isArray(msg.instanceIds)) {
            const presence = getPresenceBatch(msg.instanceIds);
            ws.send(JSON.stringify({ type: 'presence_result', presence }));
          }
          break;
        }

        case 'queue_depth': {
          const depth = queueDepth(instanceId);
          ws.send(JSON.stringify({ type: 'queue_depth', depth }));
          break;
        }

        // ─── Federation ───
        case 'org_register': {
          const result = registerOrg(msg.orgId, instanceId, msg.nameEncrypted);
          ws.send(JSON.stringify({ type: 'org_register_result', ...result }));
          break;
        }

        case 'org_add_member': {
          const result = addOrgMember(msg.orgId, msg.memberInstanceId, instanceId);
          ws.send(JSON.stringify({ type: 'org_add_member_result', ...result }));
          break;
        }

        case 'org_remove_member': {
          const result = removeOrgMember(msg.orgId, msg.memberInstanceId, instanceId);
          ws.send(JSON.stringify({ type: 'org_remove_member_result', ...result }));
          break;
        }

        case 'org_members': {
          const result = listOrgMembers(msg.orgId, instanceId);
          ws.send(JSON.stringify({ type: 'org_members_result', ...result }));
          break;
        }

        case 'org_list': {
          const result = listInstanceOrgs(instanceId);
          ws.send(JSON.stringify({ type: 'org_list_result', ...result }));
          break;
        }

        case 'org_unregister': {
          const result = unregisterOrg(msg.orgId, instanceId);
          ws.send(JSON.stringify({ type: 'org_unregister_result', ...result }));
          break;
        }

        // ─── Device registration ───
        case 'device_register': {
          const result = registerDevice(instanceId, msg.devicePublicKey, msg.deviceNameEncrypted);
          ws.send(JSON.stringify({ type: 'device_register_result', ...result }));
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'error', error: `Unknown message type: ${msg.type}` }));
      }
    });

    ws.on('close', () => {
      if (instanceId) {
        removeConnection(instanceId);
        console.log(`[hub-ws] ${instanceId} disconnected`);
      }
    });

    ws.on('error', (err) => {
      console.error(`[hub-ws] Error for ${instanceId || 'unauthenticated'}:`, err.message);
    });
  });

  // ─── Periodic cleanup ───
  const cleanupTimer = setInterval(() => {
    cleanupQueue();
    cleanupRateLimits();
  }, 5 * 60 * 1000); // every 5 minutes
  cleanupTimer.unref();

  // Start presence pings
  startPresence();

  // ─── Start listening ───
  server.listen(port, '0.0.0.0', () => {
    console.log(`[hub] PAN Hub listening on port ${port}`);
    console.log(`[hub] WebSocket: ws://0.0.0.0:${port}/ws`);
    console.log(`[hub] Health: http://0.0.0.0:${port}/health`);
  });

  return { app, server, wss };
}
