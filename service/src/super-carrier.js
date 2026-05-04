/**
 * super-carrier.js — The permanent outer layer. Never restarts.
 *
 * Owns port 7777 and all browser connections (HTTP + WebSocket).
 * Spawns Carrier on an internal port and proxies everything to it.
 * When Carrier restarts, browser connections are held open — WebSocket frames
 * are buffered for up to ~5s, then drained once the new Carrier is ready.
 * The browser never sees a disconnect.
 *
 * Architecture:
 *   [Browser] ←─ WS/HTTP ─→ [SuperCarrier :7777] ←─ proxy ─→ [Carrier :17760]
 *                                                                    ↕ IPC
 *                                                             [Craft :17700+]
 */

import { createServer } from 'http';
import { fork }         from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { request as httpRequest } from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SC_PORT      = parseInt(process.env.PAN_PORT) || 7777;
const CARRIER_PORT = parseInt(process.env.PAN_CARRIER_INTERNAL_PORT) || 17760;
const HOST         = '0.0.0.0';

// ── Carrier readiness gate ───────────────────────────────────────────────────
// Requests that arrive while Carrier is restarting wait here instead of failing.

let _carrierReady   = false;
let _carrierWaiters = [];

function markCarrierReady() {
  _carrierReady = true;
  const w = _carrierWaiters.splice(0);
  for (const resolve of w) resolve();
}

function markCarrierDown() {
  _carrierReady = false;
}

function waitForCarrier() {
  if (_carrierReady) return Promise.resolve();
  return new Promise(r => _carrierWaiters.push(r));
}

// ── Carrier process management ───────────────────────────────────────────────

let carrierProc   = null;
let _shuttingDown = false;

async function pollCarrierHealth(maxMs = 20_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CARRIER_PORT}/health`,
        { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function launchCarrier() {
  if (_shuttingDown) return;
  markCarrierDown();

  console.log('[SuperCarrier] Spawning Carrier...');

  carrierProc = fork(join(__dirname, 'carrier.js'), [], {
    env: {
      ...process.env,
      PAN_PORT:                    String(SC_PORT),         // carrier knows public port for logging
      PAN_CARRIER_INTERNAL_PORT:   String(CARRIER_PORT),    // carrier listens here
      PAN_UNDER_SUPER_CARRIER:     '1',                     // carrier adjusts its behavior
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],  // ipc required by fork(); not actively used
    windowsHide: true,
  });

  carrierProc.stdout?.on('data', d => process.stdout.write(`[Carrier] ${d}`));
  carrierProc.stderr?.on('data', d => process.stderr.write(`[Carrier!] ${d}`));

  carrierProc.on('exit', (code, signal) => {
    console.log(`[SuperCarrier] Carrier exited (code=${code} signal=${signal})`);
    markCarrierDown();
    if (_shuttingDown) return;
    // code 0 = zombie self-exit or intentional clean stop — don't respawn
    const shouldRespawn = code !== 0 || signal != null;
    if (shouldRespawn) {
      console.log('[SuperCarrier] Respawning Carrier in 1s...');
      setTimeout(launchCarrier, 1000);
    }
  });

  const healthy = await pollCarrierHealth();
  if (healthy) {
    markCarrierReady();
    console.log(`[SuperCarrier] ✓ Carrier ready on :${CARRIER_PORT}`);
  } else {
    console.error('[SuperCarrier] Carrier failed health check — force-killing to ensure clean respawn');
    // Don't just "wait" — if Carrier is alive-but-unhealthy, _carrierReady stays false
    // forever and every HTTP request queues indefinitely. Kill it so exit handler fires.
    try { carrierProc?.kill('SIGKILL'); } catch {}
    // Exit handler will respawn
  }
}

// ── HTTP reverse proxy ───────────────────────────────────────────────────────

function proxyHttp(req, res) {
  const options = {
    hostname: '127.0.0.1',
    port:     CARRIER_PORT,
    path:     req.url,
    method:   req.method,
    headers:  { ...req.headers, host: `127.0.0.1:${CARRIER_PORT}`, 'x-forwarded-host': req.headers.host || '' },
  };

  const proxy = httpRequest(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxy.on('error', err => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Carrier unavailable', detail: err.message }));
    }
  });

  req.pipe(proxy, { end: true });
}

// ── WebSocket proxy with buffering ───────────────────────────────────────────
// Each browser WS gets a managed proxy that survives Carrier restarts.

function proxyWs(browserWs, url) {
  const outBuffer = []; // browser→carrier frames buffered during restart (max 200)
  let   internal  = null;
  let   dead      = false;   // true once browser disconnects

  // Pan-clients (/ws/client) must re-register after Carrier restarts — their state
  // (clients Map entry) is lost. We track whether internal has connected before so
  // that on reconnect we close the browser WS, forcing pan-client to reconnect fresh
  // and re-send its register message to the new Carrier.
  // Browser dashboard connections (/ws/terminal etc.) keep the buffering behavior.
  const isPanClient = url.startsWith('/ws/client');
  let   hasConnectedBefore = false;

  function connectInternal() {
    if (dead) return;

    internal = new WebSocket(`ws://127.0.0.1:${CARRIER_PORT}${url}`);

    internal.on('open', () => {
      // Pan-client reconnecting after Carrier restart: close so it re-registers fresh.
      if (isPanClient && hasConnectedBefore) {
        dead = true;
        try { internal.close(); } catch {}
        try { browserWs.close(1001, 'Carrier restarted — reconnect to re-register'); } catch {}
        return;
      }
      hasConnectedBefore = true;

      // Drain any frames that arrived while Carrier was restarting
      const pending = outBuffer.splice(0);
      for (const { data, isBinary } of pending) {
        if (internal.readyState === WebSocket.OPEN) internal.send(data, { binary: isBinary });
      }
    });

    // Carrier → browser
    internal.on('message', (data, isBinary) => {
      if (browserWs.readyState === WebSocket.OPEN) browserWs.send(data, { binary: isBinary });
    });

    internal.on('ping', data => {
      if (browserWs.readyState === WebSocket.OPEN) browserWs.ping(data);
    });

    // Carrier disconnected (restart / crash) — hold the browser open, wait, reconnect
    internal.on('close', async () => {
      if (dead) return;
      console.log(`[SuperCarrier] Carrier WS closed — holding browser open, waiting for restart`);
      await waitForCarrier();
      if (!dead) setTimeout(connectInternal, 100);
    });

    internal.on('error', () => {}); // handled by 'close'
  }

  // Browser → carrier (buffer if carrier is mid-restart)
  browserWs.on('message', (data, isBinary) => {
    if (internal?.readyState === WebSocket.OPEN) {
      internal.send(data, { binary: isBinary });
    } else {
      if (outBuffer.length < 200) outBuffer.push({ data, isBinary });
    }
  });

  browserWs.on('pong', data => {
    if (internal?.readyState === WebSocket.OPEN) internal.pong(data);
  });

  browserWs.on('close', () => {
    dead = true;
    try { internal?.close(); } catch {}
  });

  browserWs.on('error', () => {}); // handled by 'close'

  connectInternal();
}

// ── Main HTTP server ─────────────────────────────────────────────────────────

const CARRIER_RESTART_WATCHDOG_MS = 5_000; // force-kill if Carrier hasn't exited in 5s

const server = createServer((req, res) => {
  // Super-Carrier answers /health directly — instant, never blocked by Carrier state
  if (req.url === '/health' || req.url === '/api/carrier/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok:              true,
      carrier:         _carrierReady,  // dashboard checks this field
      superCarrier:    true,
      superCarrierPid: process.pid,
      carrierPid:      carrierProc?.pid ?? null,
      craftHealthy:    _carrierReady,  // optimistic — carrier will report accurately
    }));
    return;
  }

  // Restart request: proxy to Carrier for the 200, then arm a watchdog to force-kill
  // if Carrier hasn't exited on its own within CARRIER_RESTART_WATCHDOG_MS.
  // This prevents the indefinite hang where Carrier's process.exit(1) never fires
  // (blocked event loop, zombie child, etc.) and _carrierReady stays false forever.
  if (req.url.startsWith('/api/carrier/restart') && req.method === 'POST') {
    const procAtStart = carrierProc;
    waitForCarrier()
      .then(() => proxyHttp(req, res))
      .catch(() => {
        if (!res.headersSent) { res.writeHead(503); res.end('Carrier starting'); }
      })
      .finally(() => {
        // Arm watchdog: if the same Carrier process is still alive after the deadline,
        // force-kill it so Super-Carrier's exit handler fires and respawns cleanly.
        const watchdog = setTimeout(() => {
          if (carrierProc && carrierProc === procAtStart && carrierProc.exitCode === null) {
            console.warn('[SuperCarrier] ⚠ Carrier restart watchdog fired — force-killing hung Carrier');
            try { carrierProc.kill('SIGKILL'); } catch {}
          }
        }, CARRIER_RESTART_WATCHDOG_MS);
        watchdog.unref(); // don't keep Super-Carrier alive just for this timer
      });
    return;
  }

  // All other requests: wait for Carrier, then proxy
  waitForCarrier()
    .then(() => proxyHttp(req, res))
    .catch(() => {
      if (!res.headersSent) { res.writeHead(503); res.end('Carrier starting'); }
    });
});

// WebSocket upgrades: wait for Carrier, then proxy
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  try {
    await waitForCarrier();
    wss.handleUpgrade(req, socket, head, ws => proxyWs(ws, req.url));
  } catch {
    socket.destroy();
  }
});

server.on('error', err => {
  console.error(`[SuperCarrier] Server error: ${err.message}`);
  if (err.code === 'EADDRINUSE') {
    console.error(`[SuperCarrier] Port ${SC_PORT} in use — cannot start`);
    process.exit(1);
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────

server.listen(SC_PORT, HOST, () => {
  console.log(`[SuperCarrier] ══════════════════════════════════════════`);
  console.log(`[SuperCarrier] Listening on :${SC_PORT}  (PID ${process.pid})`);
  console.log(`[SuperCarrier] Carrier internal port: :${CARRIER_PORT}`);
  console.log(`[SuperCarrier] ══════════════════════════════════════════`);
  launchCarrier();
});

// ── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(sig) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[SuperCarrier] ${sig} — shutting down`);
  try { carrierProc?.kill('SIGTERM'); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000); // force exit after 5s
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
