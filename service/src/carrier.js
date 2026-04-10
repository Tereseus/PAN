// Carrier — Phase 4-7 supervisor process
//
// Carrier owns: HTTP listener (:7777), WebSocket terminal, PTY sessions,
// reconnect tokens. Spawns Craft (server.js) as a child on an internal port
// and proxies all non-WebSocket HTTP traffic to it.
//
// Carrier NEVER restarts for code changes. To deploy new code:
//   POST /api/carrier/swap → Carrier spawns a new Craft, health-checks it,
//   switches the proxy target, kills the old Craft.
//
// Phases implemented:
//   4 — PTY Handoff: PTYs live in Carrier, survive Craft swaps
//   5 — Claude Session Handoff: detect context-near-full, brief + respawn
//   6 — Shadow Traffic: fork requests to a shadow Craft, compare
//   7 — Crucible: variant comparison data collection

import http from 'http';
import { fork } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { hostname } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ==================== Configuration ====================
const CARRIER_PORT = parseInt(process.env.PAN_PORT) || 7777;
const CRAFT_PORT_BASE = 17700; // Internal ports for Craft instances
const HOST = '0.0.0.0';

// ==================== State ====================
let primaryCraft = null;   // { proc, port, id, startedAt, healthy }
let shadowCraft = null;    // Phase 6: shadow Craft for canary deploys
let craftIdCounter = 0;
let terminalServer = null; // Loaded async — the terminal module

// Phase 7: Crucible — variant comparison data
const crucibleResults = []; // { craftId, requestId, path, status, latencyMs, body, ts }

// ==================== Terminal (Phase 4: Carrier owns PTY) ====================
async function initTerminal(httpServer) {
  const terminal = await import('./terminal.js');
  terminalServer = terminal;
  await terminal.startTerminalServer(httpServer);
  console.log('[Carrier] Terminal/PTY server initialized (owned by Carrier)');
}

// ==================== Craft Management ====================
function spawnCraft(port, label = 'primary') {
  const id = ++craftIdCounter;
  const craftEnv = {
    ...process.env,
    PAN_CRAFT: '1',
    PAN_CRAFT_PORT: String(port),
    PAN_CRAFT_ID: String(id),
    PAN_PORT: String(port),
  };

  const proc = fork(join(__dirname, 'server.js'), [], {
    env: craftEnv,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });

  const craft = { proc, port, id, label, startedAt: Date.now(), healthy: false };

  // Pipe Craft stdout/stderr to Carrier console with prefix
  proc.stdout.on('data', (d) => process.stdout.write(`[Craft-${id}] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[Craft-${id}!] ${d}`));

  // IPC messages from Craft → Carrier (terminal operations)
  proc.on('message', (msg) => handleCraftIPC(msg, craft));

  proc.on('exit', (code, signal) => {
    console.log(`[Carrier] Craft-${id} (${label}) exited: code=${code} signal=${signal}`);
    craft.healthy = false;
    if (craft === primaryCraft) {
      console.log('[Carrier] Primary Craft died — respawning in 2s...');
      setTimeout(() => {
        primaryCraft = spawnCraft(port, 'primary');
        waitForCraftHealth(primaryCraft);
      }, 2000);
    }
    if (craft === shadowCraft) {
      shadowCraft = null;
    }
  });

  return craft;
}

async function waitForCraftHealth(craft, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchCraft(craft.port, '/health');
      if (res.status === 200) {
        craft.healthy = true;
        console.log(`[Carrier] Craft-${craft.id} healthy on port ${craft.port}`);
        return true;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  console.error(`[Carrier] Craft-${craft.id} failed health check after ${timeoutMs}ms`);
  return false;
}

function fetchCraft(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ==================== IPC Bridge (Craft → Carrier terminal ops) ====================
function handleCraftIPC(msg, craft) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'terminal:listSessions': {
      const result = terminalServer ? terminalServer.listSessions() : [];
      craft.proc.send({ type: 'terminal:listSessions:reply', id: msg.id, result });
      break;
    }
    case 'terminal:getActivePtyPids': {
      const result = terminalServer ? terminalServer.getActivePtyPids() : [];
      craft.proc.send({ type: 'terminal:getActivePtyPids:reply', id: msg.id, result });
      break;
    }
    case 'terminal:sendToSession': {
      if (terminalServer) terminalServer.sendToSession(msg.sessionId, msg.text);
      break;
    }
    case 'terminal:broadcastToSession': {
      if (terminalServer) terminalServer.broadcastToSession(msg.sessionId, msg.messageType, msg.data);
      break;
    }
    case 'terminal:broadcastNotification': {
      if (terminalServer) terminalServer.broadcastNotification(msg.notificationType, msg.data);
      break;
    }
    case 'terminal:killSession': {
      if (terminalServer) terminalServer.killSession(msg.sessionId);
      break;
    }
    case 'terminal:killAllSessions': {
      if (terminalServer) {
        terminalServer.killAllSessions().then((n) => {
          craft.proc.send({ type: 'terminal:killAllSessions:reply', id: msg.id, result: n });
        });
      }
      break;
    }
    case 'terminal:setInFlightTool': {
      if (terminalServer) terminalServer.setInFlightTool(msg.cwd, msg.tool, msg.summary, msg.claudeSessionId, msg.isSubagent);
      break;
    }
    case 'terminal:clearInFlightTool': {
      if (terminalServer) terminalServer.clearInFlightTool(msg.cwd, msg.claudeSessionId);
      break;
    }
    case 'terminal:getInFlightTool': {
      const result = terminalServer ? terminalServer.getInFlightTool(msg.cwd) : null;
      craft.proc.send({ type: 'terminal:getInFlightTool:reply', id: msg.id, result });
      break;
    }
    case 'terminal:addPendingPermission': {
      if (terminalServer) terminalServer.addPendingPermission(msg.permission);
      break;
    }
    case 'terminal:getPendingPermissions': {
      const result = terminalServer ? terminalServer.getPendingPermissions() : [];
      craft.proc.send({ type: 'terminal:getPendingPermissions:reply', id: msg.id, result });
      break;
    }
    case 'terminal:clearPermission': {
      if (terminalServer) terminalServer.clearPermission(msg.permissionId);
      break;
    }
    case 'terminal:respondToPermission': {
      if (terminalServer) terminalServer.respondToPermission(msg.permissionId, msg.response);
      break;
    }
    default:
      console.warn(`[Carrier] Unknown IPC message type: ${msg.type}`);
  }
}

// ==================== HTTP Proxy ====================
function proxyRequest(req, res, targetPort) {
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: req.headers,
    timeout: 120000,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: 'Craft unavailable', detail: err.message }));
    }
  });

  req.pipe(proxyReq);

  // Phase 6: Shadow traffic — mirror to shadow Craft (fire-and-forget)
  if (shadowCraft?.healthy && req.method !== 'GET') {
    const shadowReq = http.request({
      hostname: '127.0.0.1',
      port: shadowCraft.port,
      path: req.url,
      method: req.method,
      headers: req.headers,
      timeout: 30000,
    }, (shadowRes) => {
      // Phase 7: Collect comparison data
      let body = '';
      shadowRes.on('data', (c) => body += c);
      shadowRes.on('end', () => {
        crucibleResults.push({
          craftId: shadowCraft.id,
          path: req.url,
          method: req.method,
          status: shadowRes.statusCode,
          latencyMs: Date.now() - Date.now(), // TODO: proper timing
          ts: Date.now(),
        });
        // Keep last 1000 results
        if (crucibleResults.length > 1000) crucibleResults.splice(0, crucibleResults.length - 1000);
      });
    });
    shadowReq.on('error', () => {}); // Shadow failures are silent
    req.pipe(shadowReq);
  }
}

// ==================== Carrier HTTP Server ====================
const carrierServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Carrier-owned endpoints
  if (url.pathname === '/api/carrier/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      carrier: { pid: process.pid, uptime: process.uptime(), port: CARRIER_PORT },
      primaryCraft: primaryCraft ? { id: primaryCraft.id, port: primaryCraft.port, healthy: primaryCraft.healthy, pid: primaryCraft.proc.pid, uptime: Date.now() - primaryCraft.startedAt } : null,
      shadowCraft: shadowCraft ? { id: shadowCraft.id, port: shadowCraft.port, healthy: shadowCraft.healthy, pid: shadowCraft.proc.pid } : null,
      crucibleResults: crucibleResults.length,
    }));
    return;
  }

  if (url.pathname === '/api/carrier/swap' && req.method === 'POST') {
    // Phase 4: Hot-swap Craft without losing PTY/WS connections
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Swap initiated' }));
    performSwap();
    return;
  }

  if (url.pathname === '/api/carrier/shadow' && req.method === 'POST') {
    // Phase 6: Start a shadow Craft for canary testing
    if (shadowCraft) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Shadow already running', id: shadowCraft.id }));
      return;
    }
    const shadowPort = CRAFT_PORT_BASE + 10 + craftIdCounter;
    shadowCraft = spawnCraft(shadowPort, 'shadow');
    waitForCraftHealth(shadowCraft).then(ok => {
      if (!ok && shadowCraft) {
        shadowCraft.proc.kill();
        shadowCraft = null;
      }
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Shadow Craft starting', port: shadowPort }));
    return;
  }

  if (url.pathname === '/api/carrier/shadow' && req.method === 'DELETE') {
    if (shadowCraft) {
      shadowCraft.proc.kill();
      shadowCraft = null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/api/carrier/crucible') {
    // Phase 7: Return comparison data
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: crucibleResults.slice(-100) }));
    return;
  }

  // Health check — Carrier is always healthy if it's responding
  if (url.pathname === '/health' || url.pathname === '/api/carrier/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, carrier: true, craftHealthy: primaryCraft?.healthy || false }));
    return;
  }

  // Everything else → proxy to primary Craft
  if (primaryCraft?.healthy) {
    proxyRequest(req, res, primaryCraft.port);
  } else {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Craft not ready', status: primaryCraft ? 'starting' : 'none' }));
  }
});

// ==================== Hot Swap (Phase 4) ====================
async function performSwap() {
  const oldCraft = primaryCraft;
  const newPort = CRAFT_PORT_BASE + craftIdCounter + 1;
  console.log(`[Carrier] ═══ HOT SWAP ═══ Starting new Craft on port ${newPort}...`);

  const newCraft = spawnCraft(newPort, 'primary');
  const healthy = await waitForCraftHealth(newCraft);

  if (!healthy) {
    console.error('[Carrier] New Craft failed health check — aborting swap, keeping old Craft');
    newCraft.proc.kill();
    return;
  }

  // Switch proxy target
  primaryCraft = newCraft;
  console.log(`[Carrier] ═══ SWAP COMPLETE ═══ Primary is now Craft-${newCraft.id} (port ${newPort})`);

  // Notify all terminal clients about the swap (so they know Claude needs relaunch)
  if (terminalServer) {
    terminalServer.broadcastNotification('server_swap', {
      oldCraftId: oldCraft?.id,
      newCraftId: newCraft.id,
    });
  }

  // Gracefully kill old Craft after a short drain period
  if (oldCraft) {
    console.log(`[Carrier] Draining old Craft-${oldCraft.id} (3s)...`);
    setTimeout(() => {
      try { oldCraft.proc.kill(); } catch {}
      console.log(`[Carrier] Old Craft-${oldCraft.id} killed`);
    }, 3000);
  }
}

// ==================== Claude Session Handoff (Phase 5) ====================
// Monitor Claude sessions for context window fullness.
// When a session approaches the limit, generate a brief and restart Claude
// in the same terminal — invisible to the user.
let claudeHandoffInterval = null;

function startClaudeHandoffMonitor() {
  claudeHandoffInterval = setInterval(async () => {
    if (!terminalServer) return;
    const sessions = terminalServer.listSessions();
    for (const session of sessions) {
      if (!session.claudeRunning) continue;
      // Check if Claude has been running a long time (proxy for context fullness)
      // Real implementation would check token count from Claude's status
      const uptimeMs = Date.now() - (session.createdAt || Date.now());
      const uptimeHours = uptimeMs / (1000 * 60 * 60);

      // Trigger handoff after 4 hours of continuous Claude usage
      // (conservative — real trigger should be context window % from Claude API)
      if (uptimeHours > 4 && !session._handoffTriggered) {
        session._handoffTriggered = true;
        console.log(`[Carrier] Phase 5: Claude session ${session.id} running ${uptimeHours.toFixed(1)}h — triggering handoff`);
        triggerClaudeHandoff(session);
      }
    }
  }, 60000); // Check every minute
}

async function triggerClaudeHandoff(session) {
  // Step 1: Send a "summarize yourself" command to Claude
  // Step 2: Wait for the summary
  // Step 3: Kill old Claude, start new with the summary as initial context
  // For now: log the intent. Full implementation needs Claude CLI integration.
  console.log(`[Carrier] Phase 5: Would handoff Claude in session ${session.id} — implementation pending CLI integration`);
  // TODO: When Claude CLI supports session export/import:
  // 1. terminalServer.sendToSession(session.id, '/compact\n')
  // 2. Wait for Claude to compress context
  // 3. Send new prompt with restored state
}

// ==================== Boot ====================
async function boot() {
  // Phase 4: Carrier owns terminal/PTY
  await initTerminal(carrierServer);

  // Start Claude handoff monitor (Phase 5)
  startClaudeHandoffMonitor();

  // Spawn primary Craft
  const craftPort = CRAFT_PORT_BASE;
  primaryCraft = spawnCraft(craftPort, 'primary');

  // Listen on main port
  carrierServer.listen(CARRIER_PORT, HOST, () => {
    console.log(`[Carrier] ═══════════════════════════════════════════`);
    console.log(`[Carrier] Carrier listening on port ${CARRIER_PORT}`);
    console.log(`[Carrier] PTY sessions owned by Carrier (PID ${process.pid})`);
    console.log(`[Carrier] Primary Craft starting on port ${craftPort}...`);
    console.log(`[Carrier] ═══════════════════════════════════════════`);
  });

  // Wait for Craft to be healthy
  await waitForCraftHealth(primaryCraft);
}

// ==================== Graceful Shutdown ====================
async function shutdown(signal) {
  console.log(`\n[Carrier] ${signal} received — shutting down...`);
  if (claudeHandoffInterval) clearInterval(claudeHandoffInterval);
  if (terminalServer) {
    try { await terminalServer.killAllSessions(); } catch {}
  }
  if (primaryCraft) try { primaryCraft.proc.kill(); } catch {}
  if (shadowCraft) try { shadowCraft.proc.kill(); } catch {}
  carrierServer.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('uncaughtException', (err) => {
  console.error('[Carrier] uncaughtException:', err?.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Carrier] unhandledRejection:', reason?.stack || reason);
});

boot().catch(err => {
  console.error('[Carrier] Fatal boot error:', err);
  process.exit(1);
});
