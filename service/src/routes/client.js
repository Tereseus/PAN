// PAN Client Routes — hub-side API for connected PAN clients.
//
// Endpoints:
//   GET  /api/v1/client/devices          List connected clients
//   POST /api/v1/client/command          Send command to a client
//   GET  /api/v1/client/invite           Generate install token + instructions
//   POST /api/v1/client/heartbeat        Client heartbeat (HTTP fallback)
//   GET  /api/v1/client/status/:id       Single client status
//   POST /api/v1/client/shell            Shell exec with streaming response

import { Router } from 'express';
import {
  getConnectedClients,
  sendToClient,
  fireToClient,
  isClientConnected,
  createInviteToken,
  onShellOutput,
  approveDevice,
  denyDevice,
} from '../client-manager.js';
import { get, all, run } from '../db.js';
import crypto from 'crypto';
import os from 'os';
import { execSync } from 'child_process';
import { getTunnelURL } from '../cloudflare-tunnel.js';

// Returns the best IP for a NEW device to reach this hub over LAN.
// LAN IPs (192.168.x, 10.x, 172.16-31.x) are preferred because new devices
// aren't on Tailscale yet — they must be on the same local network.
// Tailscale (100.x) is a last resort; 127.0.0.1 means nothing will work.
function getServerIP() {
  const ifaces = os.networkInterfaces();
  let lanIP = null;
  let tailscaleIP = null;
  for (const iface of Object.values(ifaces)) {
    for (const addr of (iface || [])) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('100.') && !tailscaleIP) {
        tailscaleIP = addr.address; // Tailscale — new device can't reach this
      } else if (!lanIP) {
        lanIP = addr.address; // LAN — reachable on same network
      }
    }
  }
  return lanIP || tailscaleIP || '127.0.0.1';
}

// Returns the Tailscale Funnel HTTPS hostname if Funnel is active for the given port,
// otherwise null. Funnel exposes the service publicly at https://<host>.ts.net (port 443)
// so any device on the internet can reach it — no Tailscale enrollment needed.
function getTailscaleFunnelHost(port) {
  try {
    const statusRaw = execSync('tailscale status --json', { timeout: 3000, windowsHide: true }).toString();
    const status = JSON.parse(statusRaw);
    const dnsName = status?.Self?.DNSName?.replace(/\.$/, ''); // strip trailing dot
    if (!dnsName) return null;

    // Check if funnel is active. Output contains "Funnel on:" when enabled.
    // We also check for the port number in case multiple ports are funneled.
    const funnelRaw = execSync('tailscale funnel status', { timeout: 3000, windowsHide: true }).toString();
    const isActive = funnelRaw.includes('Funnel on') || funnelRaw.includes(`${port}/`);
    return isActive ? dnsName : null;
  } catch {
    return null; // tailscale not installed, not running, or funnel not enabled
  }
}

const router = Router();

// ── GET /api/v1/client/devices ────────────────────────────────────────────────
// Returns all connected clients (live WS) merged with DB records.
router.get('/devices', (req, res) => {
  const live = getConnectedClients();
  const liveIds = new Set(live.map(c => c.device_id));

  // Also include recently-seen devices from DB that may be offline
  const dbDevices = all(
    `SELECT hostname, name, device_type, capabilities, client_version, online, last_seen
     FROM devices WHERE client_version IS NOT NULL
     ORDER BY last_seen DESC LIMIT 50`
  );

  const offline = dbDevices
    .filter(d => !liveIds.has(d.hostname))
    .map(d => ({
      device_id: d.hostname,
      name: d.name,
      platform: null,
      version: d.client_version,
      capabilities: JSON.parse(d.capabilities || '[]'),
      online: false,
      last_seen: d.last_seen,
    }));

  res.json({ ok: true, devices: [...live, ...offline] });
});

// ── GET /api/v1/client/status/:id ─────────────────────────────────────────────
router.get('/status/:id', (req, res) => {
  const { id } = req.params;
  const live = getConnectedClients().find(c => c.device_id === id);
  const db = get("SELECT * FROM devices WHERE hostname = :h", { ':h': id });
  if (!live && !db) {
    return res.status(404).json({ ok: false, error: 'Device not found' });
  }
  res.json({ ok: true, device: { ...db, ...(live || {}), online: isClientConnected(id) } });
});

// ── POST /api/v1/client/command ───────────────────────────────────────────────
// Body: { device_id, type, ...params, timeout_ms? }
// Returns the command result.
router.post('/command', async (req, res) => {
  const { device_id, type, timeout_ms = 30_000, ...params } = req.body;
  if (!device_id || !type) {
    return res.status(400).json({ ok: false, error: 'device_id and type are required' });
  }
  if (!isClientConnected(device_id)) {
    return res.status(503).json({ ok: false, error: `Client '${device_id}' not connected` });
  }

  try {
    const result = await sendToClient(device_id, type, params, timeout_ms);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/v1/client/shell ─────────────────────────────────────────────────
// Like /command but streams shell output via SSE.
// Body: { device_id, command, cwd?, timeout_ms? }
router.post('/shell', async (req, res) => {
  const { device_id, command, cwd, timeout_ms = 60_000 } = req.body;
  if (!device_id || !command) {
    return res.status(400).json({ ok: false, error: 'device_id and command are required' });
  }
  if (!isClientConnected(device_id)) {
    return res.status(503).json({ ok: false, error: `Client '${device_id}' not connected` });
  }

  // SSE streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Stream output chunks as they arrive, then send final result
  let closed = false;
  const cmdId = crypto.randomUUID();

  onShellOutput(cmdId, (chunk, stream) => {
    if (!closed) res.write(`data: ${JSON.stringify({ type: 'output', chunk, stream })}\n\n`);
  });

  // Note: sendToClient generates its own ID, so shell_output won't be matched to cmdId.
  // Full streaming requires sendToClientWithId (Phase 2 enhancement).
  // For now, output is buffered and returned in the final result.
  try {
    const result = await sendToClient(device_id, 'shell_exec', { command, cwd, timeout_ms }, timeout_ms + 5000);
    if (!closed) res.write(`data: ${JSON.stringify({ type: 'result', ...result })}\n\n`);
  } catch (err) {
    if (!closed) res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
  }
  closed = true;
  res.end();
});

// ── GET /api/v1/client/invite ─────────────────────────────────────────────────
// Generates a one-time install token + install instructions.
// Query: ?name=bedroom-pc&ttl_minutes=5  (default 5 min — QR codes are short-lived by design)
router.get('/invite', (req, res) => {
  const name = req.query.name || 'new-device';
  const ttlMinutes = parseInt(req.query.ttl_minutes) || 5;
  const token = createInviteToken(name, ttlMinutes * 60 * 1000);

  const port = parseInt(process.env.PAN_PUBLIC_PORT || process.env.PAN_CARRIER_PORT || '7777');

  // Priority: Cloudflare Tunnel > Tailscale Funnel > LAN IP > Tailscale IP > loopback
  // Cloudflare and Tailscale Funnel are publicly reachable — no enrollment needed on the client.
  const cfURL = getTunnelURL(); // Set by cloudflare-tunnel.js on boot
  const funnelHost = !cfURL ? getTailscaleFunnelHost(port) : null;
  let host, proto, httpProto, via;

  if (cfURL) {
    // Cloudflare Quick Tunnel — https, no explicit port
    const u = new URL(cfURL);
    host = u.host;
    proto = 'wss';
    httpProto = 'https';
    via = 'cloudflare-tunnel';
  } else if (funnelHost) {
    // Tailscale Funnel — https on port 443, no explicit port
    host = funnelHost;
    proto = 'wss';
    httpProto = 'https';
    via = 'tailscale-funnel';
  } else {
    const serverIP = getServerIP();
    host = `${serverIP}:${port}`;
    proto = 'ws';
    httpProto = 'http';
    via = serverIP.startsWith('100.') ? 'tailscale' : serverIP === '127.0.0.1' ? 'loopback' : 'lan';
  }

  const wsUrl = `${proto}://${host}`;
  const installUrl = `${httpProto}://${host}/install/${token}`;

  // Warn if the URL won't be reachable for a truly new device
  const warning = via === 'loopback'
    ? 'No LAN IP detected — new device must be on the same network as this hub'
    : via === 'tailscale'
      ? 'Only Tailscale IP available — new device must already be on Tailscale to use this link'
      : null;

  const windowsCmd = `irm ${installUrl} | iex`;
  const linuxCmd   = `curl -s ${installUrl} | bash`;
  const nodeCmd    = `node pan-client.js --hub ${wsUrl} --token ${token} --name ${name}`;

  res.json({
    ok: true,
    token,
    name,
    expires_in: `${ttlMinutes}m`,
    via,
    ...(warning ? { warning } : {}),
    install: {
      windows: windowsCmd,
      linux: linuxCmd,
      node: nodeCmd,
      url: installUrl,
    },
  });
});

// ── POST /api/v1/client/:id/approve ──────────────────────────────────────────
router.post('/:id/approve', (req, res) => {
  const { id } = req.params;
  try {
    approveDevice(id);
    res.json({ ok: true, device_id: id, trusted: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/v1/client/:id/deny ─────────────────────────────────────────────
router.post('/:id/deny', (req, res) => {
  const { id } = req.params;
  try {
    denyDevice(id);
    res.json({ ok: true, device_id: id, trusted: false });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/v1/client/heartbeat ─────────────────────────────────────────────
// HTTP fallback heartbeat (for clients where WS heartbeat may be blocked).
router.post('/heartbeat', (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ ok: false, error: 'device_id required' });
  try {
    run("UPDATE devices SET online = 1, last_seen = datetime('now','localtime') WHERE hostname = :h", { ':h': device_id });
  } catch {}
  res.json({ ok: true, connected: isClientConnected(device_id) });
});

export default router;
