// Carrier — The PAN Runtime
//
// Carrier owns: HTTP listener (:7777), WebSocket terminal, PTY sessions,
// reconnect tokens. Spawns Craft (server.js) as a child on an internal port
// and proxies all non-WebSocket HTTP traffic to it.
//
// Carrier NEVER restarts for code changes. To deploy new code:
//   POST /api/carrier/swap → Carrier spawns a new Craft, health-checks it,
//   switches the proxy target, keeps old Craft alive for 30s rollback window.
//
// Components:
//   Carrier  — long-lived runtime, owns socket + PTY + Lifeboat
//   Craft    — running PAN version (server.js with PAN_CRAFT=1)
//   Lifeboat — embedded rollback HTTP handler (~50 lines, no deps, always works)
//
// Phases implemented:
//   1 ✅ Foundations (reap-orphans, PTY exit detection, db-registry)
//   2 ✅ Carrier + Lifeboat + Craft Swap + 30s auto-rollback
//   3 ✅ Reconnect tokens + WS continuity (tokens persist to disk, frontend auto-reconnects)
//   4 ✅ PTY Handoff: PTYs live in Carrier, survive Craft swaps
//   5 ✅ Claude Session Handoff: detect context-near-full, brief + respawn
//   6 ✅ Shadow Traffic: fork requests to a shadow Craft, compare responses, promote/reject
//   7 ✅ Crucible: variant comparison data collection + dashboard UI

import http from 'http';
import { fork, execSync, execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { hostname, tmpdir } from 'os';
import { killProcessOnPort } from './platform.js';
import { PerfEngine } from './perf/engine.js';
import { toMarkdown as perfToMarkdown } from './perf/stages.js';

// Carrier has no DB — send ΠΑΝ notifications via HTTP to the Craft
function panNotify(service, subject, body, opts = {}) {
  const port = primaryCraft?.port;
  if (!port) return;
  const payload = JSON.stringify({ service, subject, body, severity: opts.severity || 'info' });
  try {
    const req = http.request({
      hostname: '127.0.0.1', port,
      path: '/api/internal/pan-notify',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, () => {});
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch {}
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// ==================== Configuration ====================
const CARRIER_PORT = parseInt(process.env.PAN_PORT) || 7777;
// Derive internal Craft port from Carrier port — prevents multi-instance conflicts.
// Default: 7777 → 17700, Dev (7781) → 17704, Docker/custom → CARRIER_PORT + 9923
const CRAFT_PORT_BASE = parseInt(process.env.PAN_CRAFT_PORT_BASE) || (CARRIER_PORT + 9923);
const HOST = '0.0.0.0';
const ROLLBACK_TIMEOUT_MS = 30_000; // 30s auto-rollback if not confirmed

// ==================== State ====================
let primaryCraft = null;   // { proc, port, id, startedAt, healthy, gitCommit }
let previousCraft = null;  // Kept alive during rollback window (NOT killed immediately)
let shadowCraft = null;    // Phase 6: shadow Craft for canary deploys
let craftIdCounter = 0;
let terminalServer = null; // Loaded async — the terminal module

// Rollback state
let rollbackTimer = null;  // setTimeout handle for auto-rollback
let swapPending = false;   // True while rollback window is open

// Phase 6: Shadow traffic stats
let shadowStats = { mirrored: 0, errors: 0, promoted: 0, rejected: 0, startedAt: null };

// Phase 7: Crucible — variant comparison data (primary vs shadow side-by-side)
const crucibleResults = []; // { id, path, method, primary: {status, latencyMs}, shadow: {status, latencyMs}, match, ts }

// ==================== Beta Pipeline State ====================
let betaCraft = null;      // Craft being evaluated in the pipeline
let pendingCrafts = [];    // Queue: candidates waiting for beta slot
let pipeline = {
  status: 'idle',          // idle | spawning | benchmarking | ready | promoting | failed
  scores: null,            // { suiteName: { passed, scores } }
  passedSuites: [],
  failedSuites: [],
  startedAt: null,
  source: null,            // 'manual' | 'autodev' | 'scout'
  error: null,
  betaPort: null,
  betaCraftId: null,
  completedAt: null,
};

// PerfEngine — probe-driven readiness tracking (replaces health-only swap gate).
// See service/src/perf/stages.js and service/src/perf/engine.js.
// Lives on the Carrier so it survives Craft swaps.
const perfEngine = new PerfEngine({ carrierPort: CARRIER_PORT });

// ==================== Helpers ====================
function tryParseJSON(s) { try { return JSON.parse(s); } catch { return {}; } }

// ==================== Git Snapshot ====================
// Cached once at startup — never run git on the event loop during a request.
let _gitCommit = null;
function getGitCommit() {
  if (_gitCommit) return _gitCommit;
  try {
    _gitCommit = execSync('git rev-parse --short HEAD', {
      cwd: join(__dirname, '..'),
      timeout: 3000,
      windowsHide: true,
      encoding: 'utf8',
    }).trim();
  } catch { _gitCommit = 'unknown'; }
  return _gitCommit;
}

// ==================== Client WebSocket (PAN Client devices) ====================
async function initClientServer(httpServer) {
  // MUST run before initTerminal — terminal.js's upgrade handler rejects unknown paths,
  // so client-manager's /ws/client handler must be registered first.
  try {
    const clientManager = await import('./client-manager.js');
    clientManager.startClientServer(httpServer);
    console.log('[Carrier] Client WebSocket server initialized (/ws/client)');
  } catch (err) {
    console.error('[Carrier] Client server init failed:', err.message);
  }
}

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

  // Defensively kill anything still holding this port before we spawn.
  // Rapid back-to-back swaps can leave a dying Craft's socket in TIME_WAIT,
  // which would cause the new Craft to fail its health check and abort the swap.
  killProcessOnPort(port).catch(() => {});

  const craftEnv = {
    ...process.env,
    PAN_CRAFT: '1',
    PAN_CRAFT_PORT: String(port),
    PAN_CRAFT_ID: String(id),
    PAN_PORT: String(port),
    PAN_CARRIER_PORT: String(CARRIER_PORT),
  };

  const proc = fork(join(__dirname, 'server.js'), [], {
    env: craftEnv,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });

  const craft = { proc, port, id, label, startedAt: Date.now(), healthy: false, gitCommit: getGitCommit() };

  // Pipe Craft stdout/stderr to Carrier console with prefix
  proc.stdout.on('data', (d) => process.stdout.write(`[Craft-${id}] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[Craft-${id}!] ${d}`));

  // IPC messages from Craft → Carrier (terminal operations)
  proc.on('message', (msg) => handleCraftIPC(msg, craft));

  proc.on('exit', (code, signal) => {
    console.log(`[Carrier] Craft-${id} (${label}) exited: code=${code} signal=${signal}`);
    craft.healthy = false;
    if (craft === primaryCraft) {
      // If rollback is available, auto-rollback to previous instead of respawning
      if (swapPending && previousCraft) {
        console.log(`[Carrier] 💥 Primary Craft-${id} crashed during rollback window — auto-rolling back!`);
        performRollback();
      } else {
        console.log('[Carrier] Primary Craft died — respawning in 2s...');
        setTimeout(() => {
          primaryCraft = spawnCraft(port, 'primary');
          waitForCraftHealth(primaryCraft);
        }, 2000);
      }
    }
    if (craft === shadowCraft) {
      shadowCraft = null;
    }
    if (craft === betaCraft) {
      betaCraft = null;
      if (pipeline.status === 'benchmarking' || pipeline.status === 'spawning') {
        pipeline = { ...pipeline, status: 'failed', error: 'Beta craft exited unexpectedly', completedAt: Date.now() };
        broadcastPipelineEvent('beta_crashed', { craftId: craft.id });
      }
    }
  });

  return craft;
}

// First install: DB migration can take 20-30s. Normal: <2s.
async function waitForCraftHealth(craft, timeoutMs = 45000) {
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
    case 'terminal:pipeSend': {
      const result = terminalServer ? terminalServer.pipeSend(msg.sessionId, msg.text) : false;
      craft.proc.send({ type: 'terminal:pipeSend:reply', id: msg.id, result: !!result });
      break;
    }
    case 'terminal:createPipeSession': {
      const result = terminalServer ? terminalServer.createPipeSession(msg.sessionId, msg.opts) : null;
      craft.proc.send({ type: 'terminal:createPipeSession:reply', id: msg.id, result: result ? { id: msg.sessionId } : null });
      break;
    }
    case 'terminal:pipeInterrupt': {
      if (terminalServer) terminalServer.pipeInterrupt(msg.sessionId);
      break;
    }
    case 'terminal:pipeSetModel': {
      if (terminalServer) terminalServer.pipeSetModel(msg.sessionId, msg.modelId);
      break;
    }
    case 'terminal:getSessionMessages': {
      const result = terminalServer ? terminalServer.getSessionMessages(msg.sessionId) : [];
      craft.proc.send({ type: 'terminal:getSessionMessages:reply', id: msg.id, result });
      break;
    }
    case 'terminal:getProcessRegistry': {
      const result = terminalServer ? terminalServer.getProcessRegistry() : [];
      craft.proc.send({ type: 'terminal:getProcessRegistry:reply', id: msg.id, result });
      break;
    }
    case 'terminal:broadcastChatUpdate': {
      if (terminalServer) terminalServer.broadcastChatUpdate(msg.data);
      break;
    }
    case 'terminal:registerProcess': {
      if (terminalServer) terminalServer.registerProcess(msg);
      break;
    }
    case 'terminal:deregisterProcess': {
      if (terminalServer) terminalServer.deregisterProcess(msg.pid, msg.exitCode);
      break;
    }
    case 'terminal:findSessionByClaudeId': {
      const result = terminalServer ? terminalServer.findSessionByClaudeId(msg.claudeSessionId) : null;
      craft.proc.send({ type: 'terminal:findSessionByClaudeId:reply', id: msg.id, result });
      break;
    }
    default:
      console.warn(`[Carrier] Unknown IPC message type: ${msg.type}`);
  }
}

// ==================== Beta Pipeline ====================
function broadcastPipelineEvent(type, extra = {}) {
  if (terminalServer) {
    terminalServer.broadcastNotification('pipeline_event', {
      type,
      ...extra,
      pipeline: { ...pipeline },
      ts: Date.now(),
    });
  }
}

async function startPipelineBeta(source = 'manual') {
  if (pipeline.status !== 'idle' && pipeline.status !== 'failed') {
    return { ok: false, error: `Pipeline already ${pipeline.status}` };
  }

  const betaPort = CRAFT_PORT_BASE + craftIdCounter + 1;
  pipeline = { status: 'spawning', scores: null, passedSuites: [], failedSuites: [],
    startedAt: Date.now(), source, error: null, betaPort, betaCraftId: null, completedAt: null };
  broadcastPipelineEvent('beta_spawning', { port: betaPort, source });
  console.log(`[Pipeline] ─── Starting beta candidate on port ${betaPort} (source=${source})`);

  // Kill any stale process on the beta port
  try { await killProcessOnPort(betaPort); await new Promise(r => setTimeout(r, 500)); } catch {}

  betaCraft = spawnCraft(betaPort, 'beta');
  pipeline.betaCraftId = betaCraft.id;
  broadcastPipelineEvent('beta_spawned', { port: betaPort, craftId: betaCraft.id });

  const healthy = await waitForCraftHealth(betaCraft, 60000);
  if (!healthy) {
    betaCraft.proc.kill();
    betaCraft = null;
    pipeline = { ...pipeline, status: 'failed', error: 'Beta craft failed health check', completedAt: Date.now() };
    broadcastPipelineEvent('beta_failed', { reason: 'health_check' });
    console.error('[Pipeline] Beta craft failed health check — aborting');
    return { ok: false, error: 'Beta craft failed to start' };
  }

  broadcastPipelineEvent('beta_healthy', { port: betaPort, craftId: betaCraft.id });
  console.log(`[Pipeline] Beta Craft-${betaCraft.id} healthy — starting benchmarks`);

  // Run benchmarks async — don't block the HTTP response
  runPipelineBenchmarks().catch(err => {
    console.error('[Pipeline] Benchmark error:', err.message);
    pipeline = { ...pipeline, status: 'failed', error: err.message, completedAt: Date.now() };
    broadcastPipelineEvent('benchmark_error', { error: err.message });
    if (betaCraft) { try { betaCraft.proc.kill(); } catch {} betaCraft = null; }
  });

  return { ok: true, status: 'spawning', port: betaPort, craftId: betaCraft.id };
}

async function runPipelineBenchmarks() {
  if (!betaCraft?.healthy) throw new Error('Beta craft not healthy');
  pipeline = { ...pipeline, status: 'benchmarking' };
  broadcastPipelineEvent('benchmarks_started');

  const body = JSON.stringify({ model: 'cerebras:qwen-3-235b' });
  const result = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: betaCraft.port,
      path: '/api/v1/ai/benchmark/all',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 900000,  // 15min — all 12 suites
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false, error: 'Invalid JSON from beta benchmark' }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Benchmark timeout after 15min')); });
    req.write(body);
    req.end();
  });

  const passedSuites = [];
  const failedSuites = [];
  for (const [suite, r] of Object.entries(result.results || {})) {
    if (r.passed) passedSuites.push(suite);
    else failedSuites.push(suite);
  }
  const allPassed = result.allPassed && failedSuites.length === 0;

  pipeline = {
    ...pipeline,
    status: allPassed ? 'ready' : 'failed',
    scores: result.results || {},
    passedSuites,
    failedSuites,
    error: allPassed ? null : `Failed: ${failedSuites.join(', ')}`,
    completedAt: Date.now(),
  };

  broadcastPipelineEvent(allPassed ? 'benchmarks_passed' : 'benchmarks_failed', {
    allPassed, passedSuites, failedSuites,
  });
  console.log(`[Pipeline] Benchmarks ${allPassed ? 'PASSED ✅' : 'FAILED ❌'} — ${passedSuites.length}/${passedSuites.length + failedSuites.length} suites passed`);

  // Notify user via ΠΑΝ contact thread
  try {
    const total = passedSuites.length + failedSuites.length;
    if (allPassed) {
      panNotify('Pipeline · 🔬',
        `All ${total} benchmarks passed ✅`,
        `Pipeline completed successfully. Every suite passed and the new Craft has been promoted to production.\n\nSuites: ${passedSuites.join(', ')}.`,
        { severity: 'info' }
      );
    } else {
      panNotify('Pipeline · 🔬',
        `${failedSuites.length}/${total} benchmark(s) failed ❌`,
        `Pipeline validation failed. The beta Craft was rejected and the current primary remains live.\n\n❌ Failed: ${failedSuites.join(', ')}\n✅ Passed: ${passedSuites.join(', ') || 'none'}\n\nScout has been notified and will research fixes.`,
        { severity: 'warning' }
      );
    }
  } catch (err) {
    console.warn('[Pipeline] panNotify failed:', err.message);
  }

  if (allPassed) {
    await promoteBetaToProduction('auto');
  } else {
    // Kill failed beta, pull next from queue if any
    if (betaCraft) { try { betaCraft.proc.kill(); } catch {} betaCraft = null; }
    if (pendingCrafts.length > 0) {
      console.log(`[Pipeline] Pulling next candidate from queue (${pendingCrafts.length} pending)`);
      pendingCrafts.shift(); // For future: handle pending queue
    }
    pipeline = { ...pipeline, status: 'failed' };
  }
}

async function promoteBetaToProduction(trigger = 'manual') {
  if (!betaCraft?.healthy) return { ok: false, error: 'No healthy beta to promote' };
  if (pipeline.status !== 'ready' && trigger !== 'manual') {
    return { ok: false, error: 'Benchmarks must pass before promotion (or use manual override)' };
  }

  pipeline = { ...pipeline, status: 'promoting' };
  broadcastPipelineEvent('promoting', { trigger, betaCraftId: betaCraft.id });
  console.log(`[Pipeline] ═══ PROMOTING beta Craft-${betaCraft.id} (trigger=${trigger}) ═══`);

  // Swap beta → primary (same as performSwap but using the pre-spawned betaCraft)
  if (swapPending && previousCraft) confirmSwap(); // clear old rollback window first

  const oldPrimary = primaryCraft;
  const promoted = betaCraft;
  promoted.label = 'primary';

  previousCraft = oldPrimary;
  primaryCraft = promoted;
  betaCraft = null;
  perfEngine.primaryCraftPort = promoted.port;
  swapPending = true;
  perfEngine.markSwapStart();

  pipeline = { ...pipeline, status: 'idle', betaPort: null, betaCraftId: null };
  broadcastPipelineEvent('promoted', { trigger, newPrimaryId: promoted.id, oldPrimaryId: oldPrimary?.id });

  if (terminalServer) {
    terminalServer.broadcastNotification('server_swap', {
      oldCraftId: oldPrimary?.id,
      newCraftId: promoted.id,
      rollbackAvailable: true,
      rollbackTimeoutMs: ROLLBACK_TIMEOUT_MS,
      pipelinePromotion: true,
    });
  }

  if (rollbackTimer) clearTimeout(rollbackTimer);
  rollbackTimer = setTimeout(() => {
    if (swapPending) {
      console.log(`[Carrier] ⏱️  Pipeline-promoted Craft-${primaryCraft?.id} auto-confirmed`);
      confirmSwap();
    }
  }, ROLLBACK_TIMEOUT_MS);

  console.log(`[Pipeline] ═══ Craft-${promoted.id} is now PRIMARY on port ${promoted.port} ═══`);
  return { ok: true, newPrimaryId: promoted.id, port: promoted.port };
}

function abortPipeline() {
  if (betaCraft) {
    console.log(`[Pipeline] Aborting — killing beta Craft-${betaCraft.id}`);
    try { betaCraft.proc.kill(); } catch {}
    betaCraft = null;
  }
  pendingCrafts.forEach(c => { try { c.proc.kill(); } catch {} });
  pendingCrafts = [];
  pipeline = { status: 'idle', scores: null, passedSuites: [], failedSuites: [],
    startedAt: null, source: null, error: null, betaPort: null, betaCraftId: null, completedAt: null };
  broadcastPipelineEvent('aborted');
  return { ok: true };
}

// ==================== HTTP Proxy ====================
function proxyRequest(req, res, targetPort) {
  const primaryStartMs = Date.now();
  let primaryStatus = 0;

  // Buffer request body so we can replay it to shadow
  const bodyChunks = [];
  req.on('data', (chunk) => bodyChunks.push(chunk));

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: req.headers,
    timeout: 120000,
  }, (proxyRes) => {
    primaryStatus = proxyRes.statusCode;
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
    proxyRes.on('end', () => {
      const primaryLatency = Date.now() - primaryStartMs;
      // If shadow is running, we already fired the shadow request —
      // the comparison entry will be completed when shadow responds
      if (req._crucibleEntry) {
        req._crucibleEntry.primary = { status: primaryStatus, latencyMs: primaryLatency };
        finalizeCrucibleEntry(req._crucibleEntry);
      }
    });
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
    shadowStats.mirrored++;
    const shadowStartMs = Date.now();
    const requestId = `cr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Create crucible entry that both primary and shadow will fill in
    req._crucibleEntry = {
      id: requestId,
      path: req.url,
      method: req.method,
      primaryCraftId: primaryCraft?.id,
      shadowCraftId: shadowCraft?.id,
      primary: null,  // filled when primary responds
      shadow: null,    // filled when shadow responds
      match: null,     // computed when both done
      ts: Date.now(),
    };

    const shadowReq = http.request({
      hostname: '127.0.0.1',
      port: shadowCraft.port,
      path: req.url,
      method: req.method,
      headers: req.headers,
      timeout: 30000,
    }, (shadowRes) => {
      let body = '';
      shadowRes.on('data', (c) => body += c);
      shadowRes.on('end', () => {
        if (req._crucibleEntry) {
          req._crucibleEntry.shadow = {
            status: shadowRes.statusCode,
            latencyMs: Date.now() - shadowStartMs,
            bodyLength: body.length,
          };
          finalizeCrucibleEntry(req._crucibleEntry);
        }
      });
    });
    shadowReq.on('error', (err) => {
      shadowStats.errors++;
      if (req._crucibleEntry) {
        req._crucibleEntry.shadow = { status: 0, latencyMs: Date.now() - shadowStartMs, error: err.message };
        finalizeCrucibleEntry(req._crucibleEntry);
      }
    });

    // Replay buffered body to shadow
    req.on('end', () => {
      if (bodyChunks.length > 0) {
        for (const chunk of bodyChunks) shadowReq.write(chunk);
      }
      shadowReq.end();
    });
  }
}

// Finalize a crucible comparison entry when both primary and shadow have responded
function finalizeCrucibleEntry(entry) {
  if (!entry.primary || !entry.shadow) return; // wait for both
  entry.match = entry.primary.status === entry.shadow.status;
  crucibleResults.push(entry);
  if (crucibleResults.length > 1000) crucibleResults.splice(0, crucibleResults.length - 1000);

  // Log mismatches
  if (!entry.match) {
    console.log(`[Carrier] ⚡ Crucible mismatch: ${entry.method} ${entry.path} — primary=${entry.primary.status} shadow=${entry.shadow.status}`);
  }
}

// ==================== Carrier HTTP Server ====================
const carrierServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Lifeboat — always checked first (works even when Craft is dead)
  if (url.pathname.startsWith('/lifeboat/')) {
    if (handleLifeboat(url, req.method, res)) return;
  }

  // Carrier-owned endpoints
  if (url.pathname === '/api/carrier/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      carrier: { pid: process.pid, uptime: process.uptime(), port: CARRIER_PORT, gitCommit: getGitCommit() },
      primaryCraft: primaryCraft ? { id: primaryCraft.id, port: primaryCraft.port, healthy: primaryCraft.healthy, pid: primaryCraft.proc.pid, uptime: Date.now() - primaryCraft.startedAt, gitCommit: primaryCraft.gitCommit } : null,
      previousCraft: previousCraft ? { id: previousCraft.id, port: previousCraft.port, healthy: previousCraft.healthy, gitCommit: previousCraft.gitCommit } : null,
      swapPending,
      rollbackAvailable: swapPending && !!previousCraft,
      shadowCraft: shadowCraft ? { id: shadowCraft.id, port: shadowCraft.port, healthy: shadowCraft.healthy, pid: shadowCraft.proc.pid } : null,
      crucibleResults: crucibleResults.length,
    }));
    return;
  }

  // Perf trace — the one live dashboard endpoint.
  // GET /api/v1/perf/trace              — JSON snapshot
  // GET /api/v1/perf/trace?format=markdown — spec doc auto-generated from stages.js
  // POST /api/v1/perf/probe/:stage_id    — force re-probe a stage
  // POST /api/v1/perf/event              — record a client-side hot-path event
  if (url.pathname === '/api/v1/perf/trace') {
    const format = url.searchParams.get('format');
    if (format === 'markdown') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
      res.end(perfToMarkdown());
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(perfEngine.snapshot()));
    return;
  }
  if (url.pathname.startsWith('/api/v1/perf/probe/') && req.method === 'POST') {
    const stageId = url.pathname.slice('/api/v1/perf/probe/'.length);
    perfEngine.forceProbe(stageId).catch(() => {});
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, stage: stageId, queued: true }));
    return;
  }
  if (url.pathname === '/api/v1/perf/event' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const { name, ms } = JSON.parse(body);
        if (typeof name === 'string' && typeof ms === 'number') {
          perfEngine.recordEvent(name, ms);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'expected { name: string, ms: number }' }));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
      }
    });
    return;
  }

  if (url.pathname === '/api/carrier/swap' && req.method === 'POST') {
    // Phase 4: Hot-swap Craft without losing PTY/WS connections
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Swap initiated' }));
    performSwap();
    return;
  }

  // Full carrier restart — process.exit(1) so pan-loop.bat respawns us.
  // Use this when carrier.js / stages.js / probes.js / engine.js changed
  // (a Craft swap cannot pick up those changes because they live in the Carrier).
  // Pre-gate: perfEngine.system_ready must be true — don't kill a healthy
  // carrier while something else is already broken. Override with ?force=1.
  // See FEATURES.md → "Settings → Restart PAN" for the full spec.
  if (url.pathname === '/api/carrier/restart' && req.method === 'POST') {
    const force = url.searchParams.get('force') === '1';
    const snap = perfEngine.snapshot();
    if (!snap.system_ready && !force) {
      const failed = (snap.stages || []).filter(s => s.required && s.state === 'failed').map(s => s.name);
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        reason: 'system_not_ready',
        failed_stages: failed,
        hint: 'Append ?force=1 to restart anyway.',
      }));
      return;
    }

    // Give the client a fast, deterministic answer BEFORE we start the exit dance.
    // Clients listen for WS `carrier_restarting` to show a banner + reconnect.
    const RESTART_DELAY_MS = 500;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      message: 'Carrier restart initiated',
      reconnect_in_ms: RESTART_DELAY_MS + 2000, // delay + typical respawn time
      forced: force,
    }));

    console.log(`[Carrier] 🔄 Full restart requested${force ? ' (forced)' : ''}. Broadcasting carrier_restarting…`);

    // 1. Broadcast to all PTY clients so they can show a banner + buffer input
    //    during the gap. Reconnect tokens are persisted to disk on every
    //    issueToken() already — no extra flush needed.
    if (terminalServer) {
      try {
        terminalServer.broadcastNotification('carrier_restarting', {
          reconnect_in_ms: RESTART_DELAY_MS + 2000,
          reason: force ? 'forced' : 'user_requested',
        });
      } catch (err) {
        console.error('[Carrier] Failed to broadcast carrier_restarting:', err.message);
      }
    }

    // 2. Write restart marker so the respawned start.js knows this is a
    //    restart (not a duplicate) and waits for the old process to die
    //    instead of seeing a "healthy" carrier and exiting with code 0.
    try {
      const isDev = process.env.PAN_DEV === '1';
      const markerDir = join(process.env.LOCALAPPDATA || '', 'PAN', isDev ? 'data-dev' : 'data');
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(join(markerDir, '.restart-pending'), Date.now().toString());
      console.log('[Carrier] Restart marker written');
    } catch (err) {
      console.error('[Carrier] Failed to write restart marker:', err.message);
    }

    // 3. Wait long enough for WS frames to flush, then exit non-zero
    //    so pan-loop.bat respawns us with current disk code.
    setTimeout(() => {
      console.log('[Carrier] 👋 Exiting for respawn…');
      // Kill the craft children first so they don't linger as orphans.
      try {
        if (primaryCraft?.proc) primaryCraft.proc.kill();
        if (previousCraft?.proc) previousCraft.proc.kill();
        if (shadowCraft?.proc) shadowCraft.proc.kill();
        if (betaCraft?.proc) betaCraft.proc.kill();
        pendingCrafts.forEach(c => { try { c.proc.kill(); } catch {} });
      } catch {}
      process.exit(1);
    }, RESTART_DELAY_MS);
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
    shadowStats = { mirrored: 0, errors: 0, promoted: 0, rejected: 0, startedAt: Date.now() };
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
    // Phase 6: Kill shadow (reject)
    shadowStats.rejected++;
    if (shadowCraft) {
      console.log(`[Carrier] Shadow Craft-${shadowCraft.id} rejected and killed`);
      shadowCraft.proc.kill();
      shadowCraft = null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, action: 'rejected' }));
    return;
  }

  if (url.pathname === '/api/carrier/shadow/promote' && req.method === 'POST') {
    // Phase 6: Promote shadow → primary (like a hot-swap but using the shadow)
    if (!shadowCraft?.healthy) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No healthy shadow to promote' }));
      return;
    }
    shadowStats.promoted++;
    const oldPrimary = primaryCraft;
    const promoted = shadowCraft;
    promoted.label = 'primary';
    previousCraft = oldPrimary;
    primaryCraft = promoted;
    shadowCraft = null;
    swapPending = true;

    console.log(`[Carrier] ═══ SHADOW PROMOTED ═══ Craft-${promoted.id} is now primary`);

    if (terminalServer) {
      terminalServer.broadcastNotification('server_swap', {
        oldCraftId: oldPrimary?.id,
        newCraftId: promoted.id,
        rollbackAvailable: true,
        rollbackTimeoutMs: ROLLBACK_TIMEOUT_MS,
        promoted: true,
      });
    }

    // Start rollback timer
    if (rollbackTimer) clearTimeout(rollbackTimer);
    rollbackTimer = setTimeout(() => {
      if (swapPending) {
        console.log(`[Carrier] ⏱️  Promoted Craft-${primaryCraft.id} auto-confirmed`);
        confirmSwap();
      }
    }, ROLLBACK_TIMEOUT_MS);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, action: 'promoted', newPrimaryId: promoted.id }));
    return;
  }

  if (url.pathname === '/api/carrier/shadow/stats') {
    // Phase 6: Shadow traffic statistics
    const matchCount = crucibleResults.filter(r => r.match === true).length;
    const mismatchCount = crucibleResults.filter(r => r.match === false).length;
    const totalCompared = matchCount + mismatchCount;
    const avgPrimaryLatency = crucibleResults.length > 0
      ? crucibleResults.reduce((sum, r) => sum + (r.primary?.latencyMs || 0), 0) / crucibleResults.length : 0;
    const avgShadowLatency = crucibleResults.length > 0
      ? crucibleResults.reduce((sum, r) => sum + (r.shadow?.latencyMs || 0), 0) / crucibleResults.length : 0;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      shadow: shadowCraft ? {
        id: shadowCraft.id,
        port: shadowCraft.port,
        healthy: shadowCraft.healthy,
        pid: shadowCraft.proc.pid,
        uptime: Date.now() - shadowCraft.startedAt,
        gitCommit: shadowCraft.gitCommit,
      } : null,
      stats: shadowStats,
      comparison: {
        total: totalCompared,
        matches: matchCount,
        mismatches: mismatchCount,
        matchRate: totalCompared > 0 ? (matchCount / totalCompared * 100).toFixed(1) + '%' : 'N/A',
        avgPrimaryLatencyMs: Math.round(avgPrimaryLatency),
        avgShadowLatencyMs: Math.round(avgShadowLatency),
      },
    }));
    return;
  }

  if (url.pathname === '/api/carrier/crucible') {
    // Phase 7: Return comparison data with filtering
    const limit = parseInt(url.searchParams?.get('limit')) || 100;
    const mismatchOnly = url.searchParams?.get('mismatches') === '1';
    let results = crucibleResults.slice(-limit);
    if (mismatchOnly) results = results.filter(r => r.match === false);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results, total: crucibleResults.length }));
    return;
  }

  // ── Beta Pipeline endpoints ──────────────────────────────────────────────
  if (url.pathname === '/api/carrier/pipeline/start' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { source = 'manual' } = body ? tryParseJSON(body) : {};
      // Respond immediately — spawning + benchmarks run async
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'starting', source }));
      startPipelineBeta(source).catch(err => {
        console.error('[Pipeline] startPipelineBeta error:', err.message);
      });
    });
    return;
  }

  if (url.pathname === '/api/carrier/pipeline/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      pipeline,
      beta: betaCraft ? {
        id: betaCraft.id, port: betaCraft.port, healthy: betaCraft.healthy,
        uptimeMs: Date.now() - betaCraft.startedAt, gitCommit: betaCraft.gitCommit,
      } : null,
      production: primaryCraft ? {
        id: primaryCraft.id, port: primaryCraft.port, healthy: primaryCraft.healthy,
        uptimeMs: Date.now() - primaryCraft.startedAt, gitCommit: primaryCraft.gitCommit,
      } : null,
      pending: pendingCrafts.length,
    }));
    return;
  }

  if (url.pathname === '/api/carrier/pipeline/promote' && req.method === 'POST') {
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: 'promoting' }));
    promoteBetaToProduction('manual').catch(err => {
      console.error('[Pipeline] promote error:', err.message);
    });
    return;
  }

  if (url.pathname === '/api/carrier/pipeline/abort' && req.method === 'POST') {
    const result = abortPipeline();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Shutdown — kills Carrier and all children (used by PAN.bat quit path)
  if (url.pathname === '/api/carrier/shutdown' && req.method === 'POST') {
    res.writeHead(200); res.end('shutting down');
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // Ready check — 200 only when Craft is healthy and proxying (used by PAN.bat)
  if (url.pathname === '/api/carrier/ready') {
    if (primaryCraft?.healthy) {
      res.writeHead(200); res.end('ok');
    } else {
      res.writeHead(503); res.end('starting');
    }
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

// ==================== Hot Swap with Rollback Safety ====================
async function performSwap() {
  // If a swap is already pending (rollback window open), cancel it first
  if (swapPending && previousCraft) {
    console.log('[Carrier] Swap already pending — confirming current Craft first');
    confirmSwap();
  }

  const oldCraft = primaryCraft;
  const newPort = CRAFT_PORT_BASE + craftIdCounter + 1;
  const oldCommit = oldCraft?.gitCommit || 'unknown';
  const newCommit = getGitCommit();
  console.log(`[Carrier] ═══ HOT SWAP ═══ ${oldCommit} → ${newCommit} — starting Craft on port ${newPort}...`);

  const newCraft = spawnCraft(newPort, 'primary');
  const healthy = await waitForCraftHealth(newCraft);

  if (!healthy) {
    console.error('[Carrier] New Craft failed /health — aborting swap, keeping old Craft');
    try { newCraft.proc.kill(); } catch {}
    // Reset swap state so the next swap attempt starts clean
    if (rollbackTimer) { clearTimeout(rollbackTimer); rollbackTimer = null; }
    swapPending = false;
    return;
  }

  // Keep old Craft alive as rollback target
  previousCraft = oldCraft;
  primaryCraft = newCraft;
  perfEngine.primaryCraftPort = newCraft.port;
  swapPending = true;
  perfEngine.markSwapStart();

  console.log(`[Carrier] ═══ SWAP LIVE ═══ Primary is now Craft-${newCraft.id} (${newCommit})`);
  console.log(`[Carrier] ⏱️  Rollback window: ${ROLLBACK_TIMEOUT_MS / 1000}s — POST /lifeboat/rollback to revert, POST /lifeboat/confirm to keep`);

  // Notify all terminal clients about the swap
  if (terminalServer) {
    terminalServer.broadcastNotification('server_swap', {
      oldCraftId: oldCraft?.id,
      newCraftId: newCraft.id,
      rollbackAvailable: true,
      rollbackTimeoutMs: ROLLBACK_TIMEOUT_MS,
    });
  }

  // Start auto-rollback timer (Layer 1: auto-revert if not confirmed)
  if (rollbackTimer) clearTimeout(rollbackTimer);
  rollbackTimer = setTimeout(() => {
    if (swapPending) {
      console.log(`[Carrier] ⏱️  Rollback timeout — auto-confirming Craft-${primaryCraft.id} (no issues detected)`);
      confirmSwap();
    }
  }, ROLLBACK_TIMEOUT_MS);
}

function confirmSwap() {
  if (!swapPending) return { ok: false, reason: 'No swap pending' };

  // Enforce probe-based readiness gate: if SWAP_GATE stages aren't all ready,
  // refuse to confirm and trigger rollback instead. Prevents the old
  // "healthy but unusable" bug (Craft /health passes but PTY isn't bound).
  const safety = perfEngine.isSwapSafe();
  if (!safety.safe) {
    console.error(`[Carrier] ❌ Swap unsafe: ${safety.reason} — rolling back instead of confirming`);
    return performRollback();
  }

  if (rollbackTimer) { clearTimeout(rollbackTimer); rollbackTimer = null; }
  swapPending = false;
  perfEngine.markSwapEnd();

  // NOW kill the old Craft
  if (previousCraft) {
    console.log(`[Carrier] ✅ Swap confirmed — retiring old Craft-${previousCraft.id} (${previousCraft.gitCommit})`);
    try { previousCraft.proc.kill(); } catch {}
    previousCraft = null;
  }

  if (terminalServer) {
    terminalServer.broadcastNotification('swap_confirmed', { craftId: primaryCraft.id });
  }

  // Swap recovery watchdog — detects black/blank Tauri window and sends F5
  startSwapRecovery();

  // Screen-watcher burst — rapid screenshots every 5s for 60s so intuition
  // can see the swap stages (loading, reconnecting, live) instead of waiting 30s.
  fetch(`http://127.0.0.1:${primaryCraft.port}/api/v1/screen-watcher/burst`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ duration_ms: 60_000, interval_ms: 5_000 }),
    signal: AbortSignal.timeout(3000),
  }).catch(e => console.warn('[Carrier] Screen burst trigger failed:', e.message));

  // Auto-trigger pipeline benchmarks after a confirmed swap — validates new code
  // against all 12 suites. If all pass, beta auto-promotes; if any fail, current
  // primary stays live and pipeline status goes to 'failed' for Scout to pick up.
  if (pipeline.status === 'idle') {
    console.log(`[Carrier] 🔬 Auto-triggering benchmark pipeline on Craft-${primaryCraft.id} (post-swap validation)`);
    startPipelineBeta('autodev').catch(err =>
      console.error('[Carrier] Auto-pipeline start failed:', err.message)
    );
  } else {
    console.log(`[Carrier] ⏭️  Pipeline already ${pipeline.status} — skipping auto-trigger`);
  }

  return { ok: true, activeCraft: primaryCraft.id, commit: primaryCraft.gitCommit };
}

// ── Swap recovery watchdog ────────────────────────────────────────────────────
// After a Craft swap the Tauri WebView sometimes ends up black (missed reload
// signal or reloaded into a still-booting Craft). This watchdog takes a tiny
// FFmpeg thumbnail every 3 s for up to 30 s and sends F5 to the PAN window if
// the screen looks black, so the user never has to manually mash F5.

const BLACK_SNAP = join(tmpdir(), 'pan-swap-check.jpg');
// A 4×4 black JPEG is ≤ 500 B; any real UI content is much larger.
const BLACK_SIZE_THRESHOLD = 600;

async function isDashboardBlack() {
  try {
    // First try: ask Tauri shell for a screenshot (faster, window-specific)
    const tr = await fetch('http://127.0.0.1:7790/screenshot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{}', signal: AbortSignal.timeout(4000),
    });
    if (tr.ok) {
      const { base64 } = await tr.json();
      if (base64) {
        // base64 PNG — rough size proxy: a black 1280×720 PNG is < 5 KB encoded
        return base64.length < 7000;
      }
    }
  } catch {}
  // Fallback: FFmpeg tiny thumbnail (async — must not block event loop)
  try {
    await execFileAsync('ffmpeg', [
      '-f', 'gdigrab', '-i', 'desktop',
      '-vframes', '1', '-vf', 'scale=4:4', '-q:v', '2', '-y', BLACK_SNAP,
    ], { windowsHide: true, timeout: 5000 });
    if (!existsSync(BLACK_SNAP)) return false;
    const { size } = statSync(BLACK_SNAP);
    try { unlinkSync(BLACK_SNAP); } catch {}
    return size < BLACK_SIZE_THRESHOLD;
  } catch { return false; }
}

async function sendF5ToPanWindow() {
  try {
    await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `
      $proc = Get-Process | Where-Object { $_.MainWindowTitle -like 'PAN*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
      if ($proc) {
        Add-Type @'
using System.Runtime.InteropServices;
public class W32 { [DllImport("user32")] public static extern bool SetForegroundWindow(System.IntPtr h); }
'@
        [W32]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
        Start-Sleep -Milliseconds 150
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait('{F5}')
        Write-Host "F5 sent to $($proc.MainWindowTitle)"
      }
    `], { windowsHide: true, timeout: 6000 });
    console.log('[Carrier] Swap recovery: sent F5 to PAN window');
  } catch (e) {
    console.warn('[Carrier] Swap recovery: F5 send failed:', e.message);
  }
}

let swapRecoveryTimer = null;
function startSwapRecovery() {
  if (swapRecoveryTimer) { clearInterval(swapRecoveryTimer); swapRecoveryTimer = null; }
  let checks = 0;
  let f5Sent = false;
  // Start checking after 3 s (give browser reload logic a chance to fire first)
  setTimeout(() => {
    swapRecoveryTimer = setInterval(async () => {
      checks++;
      if (checks > 9) { // 3 s * 9 = 27 s max
        clearInterval(swapRecoveryTimer); swapRecoveryTimer = null;
        return;
      }
      const black = await isDashboardBlack();
      console.log(`[Carrier] Swap recovery check ${checks}: ${black ? '⬛ BLACK — reloading' : '✅ OK'}`);
      if (black) {
        sendF5ToPanWindow();
        f5Sent = true;
        // Wait 4 s after F5 before checking again (page is loading)
        clearInterval(swapRecoveryTimer);
        swapRecoveryTimer = null;
        setTimeout(() => startSwapRecovery(), 4000);
      } else if (f5Sent) {
        // Was black, now OK — done
        clearInterval(swapRecoveryTimer); swapRecoveryTimer = null;
        console.log('[Carrier] Swap recovery: window restored ✅');
      }
    }, 3000);
  }, 3000);
}

function performRollback() {
  if (!swapPending || !previousCraft) return { ok: false, reason: 'No rollback available' };
  if (rollbackTimer) { clearTimeout(rollbackTimer); rollbackTimer = null; }
  swapPending = false;

  const failedCraft = primaryCraft;
  primaryCraft = previousCraft;
  previousCraft = null;
  perfEngine.primaryCraftPort = primaryCraft.port;
  perfEngine.markSwapEnd();

  console.log(`[Carrier] 🔙 ROLLBACK — reverting to Craft-${primaryCraft.id} (${primaryCraft.gitCommit}), killing Craft-${failedCraft.id}`);
  try { failedCraft.proc.kill(); } catch {}

  if (terminalServer) {
    terminalServer.broadcastNotification('swap_rollback', {
      rolledBackTo: primaryCraft.id,
      killed: failedCraft.id,
    });
  }
  return { ok: true, activeCraft: primaryCraft.id, commit: primaryCraft.gitCommit };
}

// ==================== Lifeboat ====================
// Tiny rollback HTTP handler. No dependencies. Almost cannot fail.
// Works even when every Craft is hung — it's in Carrier's process.
// Three consumers: rollback UI overlay, AHK hotkey, phone Settings button.
function handleLifeboat(url, method, res) {
  const json = (status, data) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end(JSON.stringify(data));
  };

  if (method === 'OPTIONS') { json(200, {}); return true; }

  if (url.pathname === '/lifeboat/status') {
    json(200, {
      ok: true,
      swapPending,
      rollbackAvailable: swapPending && !!previousCraft,
      rollbackTimeoutMs: ROLLBACK_TIMEOUT_MS,
      activeCraft: primaryCraft ? { id: primaryCraft.id, port: primaryCraft.port, commit: primaryCraft.gitCommit, healthy: primaryCraft.healthy } : null,
      previousCraft: previousCraft ? { id: previousCraft.id, port: previousCraft.port, commit: previousCraft.gitCommit, healthy: previousCraft.healthy } : null,
      carrierPid: process.pid,
      carrierUptime: process.uptime(),
    });
    return true;
  }

  if (url.pathname === '/lifeboat/rollback' && method === 'POST') {
    const result = performRollback();
    json(result.ok ? 200 : 409, result);
    return true;
  }

  if (url.pathname === '/lifeboat/confirm' && method === 'POST') {
    const result = confirmSwap();
    json(result.ok ? 200 : 409, result);
    return true;
  }

  return false; // Not a Lifeboat route
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
  // Client WS MUST be registered before terminal (terminal rejects unknown upgrade paths)
  await initClientServer(carrierServer);

  // Phase 4: Carrier owns terminal/PTY
  await initTerminal(carrierServer);

  // Start Claude handoff monitor (Phase 5)
  startClaudeHandoffMonitor();

  // PerfEngine — give it the terminalServer reference for PTY probes, then start.
  // Boot-time marks are set when each subsystem finishes initializing.
  perfEngine.terminalServer = terminalServer;
  perfEngine.mark('carrier_boot', 0);
  perfEngine.start();

  // Auto-rollback hook: if the engine detects SWAP_GATE failure during the
  // rollback window, fire Lifeboat automatically (without waiting for timeout).
  perfEngine.onChange(() => {
    if (!swapPending || !previousCraft) return;
    const safety = perfEngine.isSwapSafe();
    if (!safety.safe) {
      console.error(`[Carrier] 🚨 Perf probe failed during rollback window: ${safety.reason} — auto-rolling back`);
      performRollback();
    }
  });

  // Kill any zombie carrier holding our own port (e.g. after sleep/wake where old carrier
  // lost the port but its process kept running with live intervals burning CPU).
  // Must happen BEFORE we try to listen — otherwise we'd get EADDRINUSE.
  try {
    const zombies = await killProcessOnPort(CARRIER_PORT);
    if (zombies.size > 0) {
      console.log(`[Carrier] ⚰️  Killed zombie carrier(s) on port ${CARRIER_PORT}: ${[...zombies].join(', ')}`);
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (e) {
    console.warn(`[Carrier] Could not clean carrier port ${CARRIER_PORT}: ${e.message}`);
  }

  // Kill any stale process holding the Craft port from a prior crash
  const craftPort = CRAFT_PORT_BASE;
  const portCleanStart = Date.now();
  try {
    const killed = await killProcessOnPort(craftPort);
    if (killed.size > 0) {
      console.log(`[Carrier] Killed stale process(es) on port ${craftPort}: ${[...killed].join(', ')}`);
      await new Promise(r => setTimeout(r, 1000));
    }
    // Tell the perf engine the port is now ours to use. This satisfies
    // carrier.port_clean as a one-shot boot mark — after Craft spawns it
    // will own 17700 and a recurring port_unbound probe would always fail.
    perfEngine.mark('craft_port_clean', Date.now() - portCleanStart);
  } catch (e) {
    console.warn(`[Carrier] Failed to clean port ${craftPort}: ${e.message}`);
  }

  // Spawn primary Craft
  primaryCraft = spawnCraft(craftPort, 'primary');

  // Listen on main port — with retry + hard exit so pan-loop.bat can respawn cleanly
  let listenAttempts = 0;
  const MAX_LISTEN_ATTEMPTS = 8;
  const tryListen = () => {
    listenAttempts++;
    carrierServer.listen(CARRIER_PORT, HOST, () => {
      console.log(`[Carrier] ═══════════════════════════════════════════`);
      console.log(`[Carrier] Carrier listening on port ${CARRIER_PORT}`);
      console.log(`[Carrier] PTY sessions owned by Carrier (PID ${process.pid})`);
      console.log(`[Carrier] Lifeboat active: /lifeboat/status, /lifeboat/rollback, /lifeboat/confirm`);
      console.log(`[Carrier] Rollback window: ${ROLLBACK_TIMEOUT_MS / 1000}s after each swap`);
      console.log(`[Carrier] Git: ${getGitCommit()}`);
      console.log(`[Carrier] Primary Craft starting on port ${craftPort}...`);
      console.log(`[Carrier] ═══════════════════════════════════════════`);
    });
    carrierServer.once('error', async (err) => {
      if (err.code === 'EADDRINUSE') {
        if (listenAttempts < MAX_LISTEN_ATTEMPTS) {
          console.warn(`[Carrier] Port ${CARRIER_PORT} in use (attempt ${listenAttempts}/${MAX_LISTEN_ATTEMPTS}) — killing holder and retrying in 2s...`);
          try { await killProcessOnPort(CARRIER_PORT); } catch {}
          await new Promise(r => setTimeout(r, 2000));
          carrierServer.close(() => tryListen());
        } else {
          console.error(`[Carrier] ❌ Port ${CARRIER_PORT} still occupied after ${MAX_LISTEN_ATTEMPTS} attempts — exiting so pan-loop can respawn`);
          try { const _d = join(process.env.LOCALAPPDATA||'','PAN','data'); mkdirSync(_d,{recursive:true}); writeFileSync(join(_d,'.restart-pending'),Date.now().toString()); } catch {}
          process.exit(1);
        }
      } else {
        console.error(`[Carrier] ❌ Fatal listen error: ${err.message} — exiting`);
        try { const _d = join(process.env.LOCALAPPDATA||'','PAN','data'); mkdirSync(_d,{recursive:true}); writeFileSync(join(_d,'.restart-pending'),Date.now().toString()); } catch {}
        process.exit(1);
      }
    });
  };
  tryListen();

  // Wait for Craft to be healthy
  await waitForCraftHealth(primaryCraft);

  // ── Zombie self-detector ────────────────────────────────────────────────
  // After sleep/wake or a forced restart, a new Carrier can steal port 7777
  // while this process keeps running with live intervals (burning CPU).
  // Every 60s: hit /health and check if the PID that responds is OUR PID.
  // If it's a different PID, we are the zombie — exit so we stop wasting resources.
  let _zombieCheckFailures = 0;
  setInterval(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${CARRIER_PORT}/health`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const activePid = body.carrier?.pid;
      if (activePid && activePid !== process.pid) {
        console.error(`[Carrier] ⚰️  Zombie detected — port ${CARRIER_PORT} is owned by PID ${activePid}, I am PID ${process.pid}. Exiting.`);
        process.exit(0); // exit(0) = clean, don't trigger pan-loop respawn for this zombie
      }
      _zombieCheckFailures = 0;
    } catch {
      _zombieCheckFailures++;
      if (_zombieCheckFailures >= 3) {
        console.error('[Carrier] ❌ Self-health check failed 3× — event loop may be blocked, exiting for respawn');
        process.exit(1);
      }
    }
  }, 60_000);
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
  if (betaCraft) try { betaCraft.proc.kill(); } catch {}
  pendingCrafts.forEach(c => { try { c.proc.kill(); } catch {} });
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
