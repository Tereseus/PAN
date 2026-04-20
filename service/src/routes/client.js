// PAN Client Routes — hub-side API for connected PAN clients.
//
// Endpoints:
//   GET  /api/v1/client/devices          List connected clients
//   POST /api/v1/client/command          Send command to a client (WS or HTTP queue)
//   GET  /api/v1/client/poll             Device polls for queued commands (HTTP fallback)
//   POST /api/v1/client/result           Device submits command result
//   GET  /api/v1/client/invite           Generate install token + instructions
//   POST /api/v1/client/heartbeat        Client heartbeat (HTTP fallback)
//   GET  /api/v1/client/status/:id       Single client status
//   POST /api/v1/client/shell            Shell exec with streaming response

import express, { Router } from 'express';
import {
  getConnectedClients,
  sendToClient,
  fireToClient,
  isClientConnected,
  createInviteToken,
  checkInviteToken,
  onShellOutput,
  approveDevice,
  denyDevice,
} from '../client-manager.js';
import { get, all, run } from '../db.js';
import { broadcastNotification } from '../terminal-bridge.js';
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
  // trusted: 0 = pending, 1 = approved, -1 = denied, NULL = legacy (pre-pan-client)
  const dbDevices = all(
    `SELECT hostname, name, device_type, capabilities, client_version, online, trusted, last_seen
     FROM devices WHERE client_version IS NOT NULL
     ORDER BY last_seen DESC LIMIT 50`
  );

  // getConnectedClients() is always empty in Craft (live WS map lives in Carrier).
  // Use DB online column as source of truth — Carrier updates it via setDeviceOnline().
  const dbMapped = dbDevices.map(d => ({
    device_id: d.hostname,
    name: d.name,
    platform: null,
    version: d.client_version,
    capabilities: JSON.parse(d.capabilities || '[]'),
    online: d.online === 1,
    trusted: d.trusted === 1 ? true : d.trusted === -1 ? -1 : false,
    last_seen: d.last_seen,
  }));

  res.json({ ok: true, devices: dbMapped });
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
// Tries WS first; if device is offline (HTTP-only via Cloudflare), queues to DB.
router.post('/command', async (req, res) => {
  const { device_id, type, timeout_ms = 30_000, ...params } = req.body;
  if (!device_id || !type) {
    return res.status(400).json({ ok: false, error: 'device_id and type are required' });
  }

  // Check device exists and is approved
  const device = get("SELECT trusted, online FROM devices WHERE hostname = :h", { ':h': device_id });
  if (!device || device.trusted !== 1) {
    return res.status(404).json({ ok: false, error: `Device '${device_id}' not found or not approved` });
  }

  // Try WS first (works when on same network)
  if (isClientConnected(device_id)) {
    try {
      const result = await sendToClient(device_id, type, params, timeout_ms);
      return res.json({ ok: true, result, via: 'websocket' });
    } catch (err) {
      // WS failed — fall through to HTTP queue
    }
  }

  // Queue via DB for HTTP-polling clients (Cloudflare tunnel scenario)
  const cmdId = crypto.randomUUID();
  run(`INSERT INTO client_command_queue (id, device_id, type, params, queued_at)
       VALUES (:id, :d, :t, :p, :ts)`,
    { ':id': cmdId, ':d': device_id, ':t': type, ':p': JSON.stringify(params), ':ts': Date.now() });

  // Wait for result (device polls every 3s, so max ~6s before first result)
  const deadline = Date.now() + Math.min(timeout_ms, 120_000);
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    const row = get("SELECT result, error, completed_at FROM client_command_queue WHERE id = :id", { ':id': cmdId });
    if (row?.completed_at) {
      if (row.error) return res.status(500).json({ ok: false, error: row.error, via: 'http-queue' });
      return res.json({ ok: true, result: JSON.parse(row.result || 'null'), via: 'http-queue' });
    }
  }
  res.status(408).json({ ok: false, error: 'Command timed out — device did not respond', via: 'http-queue' });
});

// ── GET /api/v1/client/poll ───────────────────────────────────────────────────
// Called by pan-client.js every 3s to receive queued commands (HTTP tunnel fallback).
// Auth: device must be approved (trusted=1) in DB — invite token is only for initial registration.
router.get('/poll', (req, res) => {
  const { device_id } = req.query;
  if (!device_id) return res.status(400).json({ ok: false, error: 'device_id required' });
  const device = get("SELECT trusted FROM devices WHERE hostname = :h", { ':h': device_id });
  if (!device || device.trusted !== 1) return res.status(403).json({ ok: false, error: 'Device not approved' });

  // Mark online on every poll
  run("UPDATE devices SET online = 1, last_seen = datetime('now','localtime') WHERE hostname = :h", { ':h': device_id });

  const row = get(`SELECT id, type, params FROM client_command_queue
    WHERE device_id = :d AND picked_up_at IS NULL ORDER BY queued_at ASC LIMIT 1`,
    { ':d': device_id });

  if (row) {
    run(`UPDATE client_command_queue SET picked_up_at = :t WHERE id = :id`,
      { ':t': Date.now(), ':id': row.id });
    const cmd = { id: row.id, type: row.type, ...JSON.parse(row.params || '{}') };
    return res.json({ ok: true, command: cmd });
  }

  res.json({ ok: true, command: null });
});

// ── POST /api/v1/client/result ────────────────────────────────────────────────
// Device submits command result after executing a polled command.
// Auth: device must be approved (trusted=1) — same as /poll.
router.post('/result', (req, res) => {
  const { device_id, id, ok: cmdOk, result, error } = req.body || {};
  if (!device_id) return res.status(400).json({ ok: false, error: 'device_id required' });
  const device = get("SELECT trusted FROM devices WHERE hostname = :h", { ':h': device_id });
  if (!device || device.trusted !== 1) return res.status(403).json({ ok: false, error: 'Device not approved' });
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });

  run(`UPDATE client_command_queue SET result = :r, error = :e, completed_at = :t
       WHERE id = :id AND device_id = :d`,
    { ':r': JSON.stringify(result ?? null), ':e': error || null, ':t': Date.now(), ':id': id, ':d': device_id });

  res.json({ ok: true });
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
// Query: ?name=bedroom-pc&ttl_minutes=30  (default 30 min — enough time to download + run installer)
router.get('/invite', (req, res) => {
  const name = req.query.name || 'new-device';
  const ttlMinutes = parseInt(req.query.ttl_minutes) || 30;
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

// ── DELETE /api/v1/client/:id ────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  try {
    run("DELETE FROM devices WHERE hostname = :h", { ':h': id });
    res.json({ ok: true, device_id: id, deleted: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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

// ── POST /api/v1/client/register ─────────────────────────────────────────────
// Called by pan-client.js on first connect. Works through Cloudflare (no WebSocket needed).
// Creates a pending device record and broadcasts approval request to dashboard.
router.post('/register', (req, res) => {
  const { token, device_id, name, platform, arch, version, capabilities, hostname: dHostname } = req.body || {};
  if (!checkInviteToken(token)) return res.status(401).json({ ok: false, error: 'Invalid or expired token' });

  const deviceId = device_id || dHostname || 'unknown';
  const deviceName = name || deviceId;

  try {
    const existing = get("SELECT id, trusted FROM devices WHERE hostname = :h", { ':h': deviceId });
    if (existing?.trusted === -1) return res.status(403).json({ ok: false, error: 'Device was denied' });

    if (existing) {
      const newTrust = existing.trusted !== null ? existing.trusted : 0;
      run(`UPDATE devices SET name = :n, capabilities = :c, client_version = :v, online = 1, trusted = :t,
           last_seen = datetime('now','localtime') WHERE hostname = :h`,
        { ':n': deviceName, ':c': JSON.stringify(capabilities || []), ':v': version || null, ':t': newTrust, ':h': deviceId });
    } else {
      run(`INSERT INTO devices (hostname, name, device_type, capabilities, client_version, online, trusted)
           VALUES (:h, :n, 'pc', :c, :v, 1, 0)`,
        { ':h': deviceId, ':n': deviceName, ':c': JSON.stringify(capabilities || []), ':v': version || null });
    }

    broadcastNotification('device_pending', {
      device_id: deviceId, name: deviceName, platform: platform || 'unknown',
      message: `New device wants to join: ${deviceName}`
    }).catch(() => {});

    console.log(`[PAN Clients] HTTP registration: ${deviceName} (${deviceId}) — pending approval`);
    res.json({ ok: true, status: 'pending', device_id: deviceId });
  } catch (e) {
    console.error('[PAN Clients] HTTP register error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/v1/client/status ─────────────────────────────────────────────────
// Polled by pan-client.js to check if hub owner has approved/denied the device.
// Query params: device_id, token
// Auth: invite token (during the registration/approval window — before approval).
// Token may expire if polling takes too long; that's OK, device just retries registration.
router.get('/status', (req, res) => {
  const { device_id, token } = req.query;
  if (!device_id) return res.status(400).json({ ok: false, error: 'device_id required' });
  // Allow token-less status check if device is already in DB (idempotent re-registration)
  if (token && !checkInviteToken(token)) return res.status(401).json({ ok: false, error: 'Invalid token' });
  const device = get("SELECT trusted, name FROM devices WHERE hostname = :h", { ':h': device_id });
  if (!device) return res.json({ ok: true, status: 'unknown' });
  const status = device.trusted === 1 ? 'approved' : device.trusted === -1 ? 'denied' : 'pending';
  res.json({ ok: true, status, name: device.name });
});

export default router;
