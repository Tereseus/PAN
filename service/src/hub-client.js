// Hub client — connects PAN instance to the Hub relay server
// Maintains persistent WebSocket, handles auth, routes incoming messages.

import WebSocket from 'ws';
import { initHubIdentity, getInstanceId, getPublicKeyBase64, signChallenge } from './hub-crypto.js';

let ws = null;
let hubUrl = null;
let reconnectTimer = null;
let reconnectDelay = 1000; // exponential backoff: 1s → 2s → 4s → ... → 60s max
let connected = false;
let authenticated = false;

// Callbacks for incoming messages
const messageHandlers = new Map(); // type → handler(envelope)

/**
 * Start the Hub client
 * @param {string} url - Hub WebSocket URL (e.g., wss://hub.example.com/ws)
 * @param {string} dataDir - PAN data directory for keypair storage
 * @param {object} db - PAN database handle (for settings)
 */
export function startHubClient(url, dataDir, db) {
  hubUrl = url;

  // Initialize or load identity
  const { instanceId, publicKeyBase64 } = initHubIdentity(dataDir);
  console.log(`[hub-client] Instance ID: ${instanceId}`);
  console.log(`[hub-client] Connecting to Hub: ${url}`);

  connect();
}

/**
 * Stop the Hub client
 */
export function stopHubClient() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) {
    ws.removeAllListeners();
    ws.close(1000, 'Shutting down');
    ws = null;
  }
  connected = false;
  authenticated = false;
  console.log('[hub-client] Stopped');
}

/**
 * Register a handler for incoming messages
 * @param {string} type - Message type (e.g., 'direct', 'org', 'federation')
 * @param {function} handler - async (envelope) => void
 */
export function onHubMessage(type, handler) {
  messageHandlers.set(type, handler);
}

/**
 * Send a message through the Hub
 * @param {object} envelope - { to, type, payload }
 */
export function sendHubMessage(envelope) {
  if (!authenticated) {
    console.warn('[hub-client] Not authenticated — message queued locally');
    // TODO: local queue for messages when disconnected
    return false;
  }

  envelope.from = getInstanceId();
  ws.send(JSON.stringify({ type: 'message', envelope }));
  return true;
}

/**
 * Send a raw command to the Hub
 */
export function sendHubCommand(msg) {
  if (!authenticated) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

/**
 * Get connection status
 */
export function getHubStatus() {
  return {
    connected,
    authenticated,
    instanceId: getInstanceId(),
    hubUrl
  };
}

// ─── Internal ───

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return; // already connected/connecting
  }

  try {
    ws = new WebSocket(hubUrl);
  } catch (err) {
    console.error('[hub-client] Connection failed:', err.message);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    connected = true;
    reconnectDelay = 1000; // reset backoff
    console.log('[hub-client] WebSocket connected, awaiting challenge...');
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.error('[hub-client] Invalid JSON from Hub');
      return;
    }

    switch (msg.type) {
      case 'challenge':
        handleChallenge(msg);
        break;

      case 'auth_ok':
        authenticated = true;
        console.log(`[hub-client] Authenticated as ${msg.instanceId}${msg.registered ? ' (newly registered)' : ''}`);
        break;

      case 'auth_failed':
        console.error(`[hub-client] Auth failed: ${msg.error}`);
        ws.close();
        break;

      case 'message':
        handleIncomingMessage(msg.envelope);
        break;

      case 'message_ack':
        // Message delivery confirmation
        if (!msg.ok) {
          console.warn(`[hub-client] Message ${msg.id} failed: ${msg.error}`);
        }
        break;

      case 'pong':
        break; // keep-alive response

      case 'error':
        console.error(`[hub-client] Hub error: ${msg.error}`);
        break;

      default:
        // Federation and other responses
        handleResponse(msg);
    }
  });

  ws.on('close', (code, reason) => {
    connected = false;
    authenticated = false;
    console.log(`[hub-client] Disconnected (${code}: ${reason || 'no reason'})`);
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[hub-client] WebSocket error:', err.message);
    // close event will fire after this, triggering reconnect
  });

  // Keepalive ping every 25s
  ws.on('open', () => {
    const pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      } else {
        clearInterval(pingInterval);
      }
    }, 25_000);
  });
}

function handleChallenge(msg) {
  const timestamp = new Date().toISOString();
  const signature = signChallenge(msg.nonce, timestamp);

  ws.send(JSON.stringify({
    type: 'auth',
    instanceId: getInstanceId(),
    publicKey: getPublicKeyBase64(),
    nonce: msg.nonce,
    timestamp,
    signature
  }));
}

function handleIncomingMessage(envelope) {
  if (!envelope) return;

  console.log(`[hub-client] Incoming ${envelope.type} from ${envelope.from}${envelope.queued ? ' (queued)' : ''}`);

  const handler = messageHandlers.get(envelope.type);
  if (handler) {
    try {
      handler(envelope);
    } catch (err) {
      console.error(`[hub-client] Handler error for ${envelope.type}:`, err.message);
    }
  } else {
    console.warn(`[hub-client] No handler for message type: ${envelope.type}`);
  }
}

function handleResponse(msg) {
  // Log federation and other responses
  if (msg.type?.endsWith('_result')) {
    const op = msg.type.replace('_result', '');
    if (msg.ok) {
      console.log(`[hub-client] ${op}: ok`);
    } else {
      console.warn(`[hub-client] ${op}: ${msg.error}`);
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  console.log(`[hub-client] Reconnecting in ${reconnectDelay / 1000}s...`);
  reconnectTimer = setTimeout(() => {
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 60_000); // max 60s
}
