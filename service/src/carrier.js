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
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync, createReadStream } from 'fs';
import { hostname, tmpdir } from 'os';
import { createHash } from 'crypto';
import { killProcessOnPort, getDataDir } from './platform.js';
import { PerfEngine } from './perf/engine.js';
import { toMarkdown as perfToMarkdown, SWAP_GATE } from './perf/stages.js';
import {
  setupCarrierLog,
  appendCraftStderr,
  getCraftStderrTail,
  recordSwapPhase,
  getSwapHistory,
  readLogTail,
} from './carrier-observability.js';

// Tee carrier stdout/stderr to <dataDir>/../logs/carrier.log (10MB rotation).
// Must happen before any console.log so the first lines are captured too.
try {
  setupCarrierLog(join(getDataDir(), '..', 'logs'));
} catch (e) {
  // Non-fatal — carrier still runs, just without persistent log file.
  process.stderr.write(`[Carrier] setupCarrierLog failed: ${e.message}\n`);
}

// Carrier has no DB — send Π notifications via HTTP to the Craft
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

// Carrier has no DB — record a row in the events table via the Craft.
// Used for #472: carrier_restart / craft_swap / etc. so #457 (silent swap
// killing PTYs) becomes diagnosable by joining on timestamps.
// Fire-and-forget; never blocks the swap/restart hot path.
function recordEvent(eventType, data) {
  const port = primaryCraft?.port;
  if (!port) return;
  const payload = JSON.stringify({
    session_id: 'system',
    event_type: eventType,
    data: { ...(data || {}), recorded_by: 'carrier', ts: Date.now() },
  });
  try {
    const req = http.request({
      hostname: '127.0.0.1', port,
      path: '/api/internal/event',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 1500,
    }, () => {});
    req.on('error', () => {});
    req.on('timeout', () => { try { req.destroy(); } catch {} });
    req.write(payload);
    req.end();
  } catch {}
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// ==================== Configuration ====================
// When running under Super-Carrier, Carrier listens on an internal port (17760)
// instead of the public port (7777). Super-Carrier owns 7777 and proxies to us.
const IS_UNDER_SUPER_CARRIER = !!process.env.PAN_UNDER_SUPER_CARRIER;
const CARRIER_PORT = IS_UNDER_SUPER_CARRIER
  ? (parseInt(process.env.PAN_CARRIER_INTERNAL_PORT) || 17760)
  : (parseInt(process.env.PAN_PORT) || 7777);
// Derive internal Craft port from Carrier port — prevents multi-instance conflicts.
// Default: 7777 → 17700, Dev (7781) → 17704, Docker/custom → CARRIER_PORT + 9923
const CRAFT_PORT_BASE = parseInt(process.env.PAN_CRAFT_PORT_BASE) || (IS_UNDER_SUPER_CARRIER ? 17700 : (CARRIER_PORT + 9923));
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

  const craft = { proc, port, id, label, startedAt: Date.now(), healthy: false, gitCommit: getGitCommit(), stderrTail: '' };

  // Pipe Craft stdout/stderr to Carrier console with prefix AND keep last
  // ~10KB of stderr in craft.stderrTail so swap failures can include the
  // actual error message (not just "failed health check").
  proc.stdout.on('data', (d) => process.stdout.write(`[Craft-${id}] ${d}`));
  proc.stderr.on('data', (d) => {
    process.stderr.write(`[Craft-${id}!] ${d}`);
    appendCraftStderr(craft, d);
  });

  // IPC messages from Craft → Carrier (terminal operations)
  proc.on('message', (msg) => {
    try { handleCraftIPC(msg, craft); }
    catch (e) { console.error('[Carrier] handleCraftIPC threw (IPC channel broken?):', e?.message); }
  });

  proc.on('exit', (code, signal) => {
    console.log(`[Carrier] Craft-${id} (${label}) exited: code=${code} signal=${signal}`);
    craft.healthy = false;
    if (craft === primaryCraft) {
      // If rollback is available, auto-rollback to previous instead of respawning
      if (swapPending && previousCraft) {
        console.log(`[Carrier] 💥 Primary Craft-${id} crashed during rollback window — auto-rolling back! (exit code=${code} signal=${signal})`);
        performRollback({
          triggered_by: 'craft_crash',
          reason: `primary Craft-${id} exited during rollback window`,
          detail: { exit_code: code, exit_signal: signal },
        });
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
  let lastReason = 'timeout';
  let lastDetail = null;
  let lastStatus = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetchCraft(craft.port, '/health');
      if (res.status === 200) {
        craft.healthy = true;
        craft.healthReason = 'ok';
        console.log(`[Carrier] Craft-${craft.id} healthy on port ${craft.port}`);
        return { healthy: true, reason: 'ok' };
      }
      // Non-200: capture the status and a short body slice as the reason.
      lastReason = `http_${res.status}`;
      lastStatus = res.status;
      try { lastDetail = String(res.body || '').slice(0, 500); } catch { lastDetail = null; }
    } catch (e) {
      // ECONNREFUSED / ETIMEDOUT / DNS / socket-hang-up — the most common
      // case is ECONNREFUSED because the new Craft crashed before binding.
      lastReason = e?.code || e?.errno || 'fetch_error';
      lastDetail = e?.message || String(e);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  // Craft exited before health passed? Annotate that — it's the most
  // diagnostic signal we have (exit-code + signal from the proc.on('exit')).
  if (craft.proc?.killed || craft.proc?.exitCode != null) {
    lastReason = 'craft_exited_before_healthy';
    lastDetail = `exitCode=${craft.proc.exitCode} signal=${craft.proc.signalCode || 'none'}`;
  }
  console.error(`[Carrier] Craft-${craft.id} failed health check after ${timeoutMs}ms (reason=${lastReason})`);
  // Start background recovery — craft may still be starting (e.g. post-sleep slow boot)
  scheduleHealthRecovery(craft);
  return { healthy: false, reason: lastReason, detail: lastDetail, lastStatus };
}

// Keeps polling an unhealthy craft every 10s until it responds or is replaced.
// Fixes post-sleep race where craft starts after the 45s waitForCraftHealth window.
function scheduleHealthRecovery(craft) {
  const timer = setInterval(async () => {
    if (craft !== primaryCraft || craft.healthy) { clearInterval(timer); return; }
    try {
      const res = await fetchCraft(craft.port, '/health');
      if (res.status === 200) {
        craft.healthy = true;
        clearInterval(timer);
        console.log(`[Carrier] Craft-${craft.id} recovered health (late boot)`);
      }
    } catch {}
  }, 10000);
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
      // #982 — propagate provenance tag from Craft so terminal.js can log it
      if (terminalServer) terminalServer.sendToSession(msg.sessionId, msg.text, undefined, msg.source || 'unknown');
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
    case 'terminal:pipeResetAdapter': {
      const result = terminalServer ? terminalServer.pipeResetAdapter(msg.sessionId) : false;
      craft.proc.send({ type: 'terminal:pipeResetAdapter:reply', id: msg.id, result: !!result });
      break;
    }
    case 'terminal:getSessionMessages': {
      const result = terminalServer ? terminalServer.getSessionMessages(msg.sessionId) : [];
      craft.proc.send({ type: 'terminal:getSessionMessages:reply', id: msg.id, result });
      break;
    }
    case 'terminal:getSessionBufferSize': {
      const result = terminalServer ? terminalServer.getSessionBufferSize(msg.sessionId) : null;
      craft.proc.send({ type: 'terminal:getSessionBufferSize:reply', id: msg.id, result });
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

  const healthResult = await waitForCraftHealth(betaCraft, 60000);
  if (!healthResult.healthy) {
    try { betaCraft.proc.kill(); } catch {}
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

  // Use the current reasoning_cloud model rather than the retired qwen-3-235b.
  // The benchmark suite runs against beta Craft pre-promotion — using a dead
  // model meant every Pipeline run 404'd after Cerebras retired qwen-235b on
  // 2026-05-27. Read live from settings.ai_model so benchmark target == prod
  // target.
  let _benchModel = 'cerebras:zai-glm-4.7';
  try {
    const _row = await new Promise((resolve) => {
      const r = http.request({ hostname: '127.0.0.1', port: betaCraft.port, path: '/api/v1/settings', method: 'GET', timeout: 3000 }, (res) => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)?.ai_model || null); } catch { resolve(null); } });
      });
      r.on('error', () => resolve(null));
      r.on('timeout', () => { r.destroy(); resolve(null); });
      r.end();
    });
    if (_row) _benchModel = _row;
  } catch {}
  const body = JSON.stringify({ model: _benchModel });
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

  // Notify user via Π contact thread
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
  primaryCraft.fromPipeline = true; // prevents confirmSwap() re-triggering another pipeline
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

  // Timeout handler — the 120s timeout was set above but with no listener
  // the socket would just sit there forever. With this handler, timed-out
  // upstream requests get destroyed so the connection pool can recover.
  //
  // NOTE: we intentionally do NOT add a `res.on('close')` handler that
  // destroys proxyReq on client disconnect. Earlier experiments did that
  // and discovered Craft's HTTP server doesn't react cleanly to upstream
  // half-close — sockets piled up in CLOSE_WAIT on Craft's side until it
  // hit FD limits and stopped accepting connections. The right fix for
  // client-disconnect cleanup is in Craft's HTTP handlers, not here.
  proxyReq.on('timeout', () => {
    try { proxyReq.destroy(new Error('Craft request timed out (120s)')); } catch {}
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

  // Swap history — in-memory ring of last 50 lifecycle phases. Always
  // available even when Craft is down (lives in Carrier). Use this to
  // answer "why did the swap fail?" — every aborted swap records its
  // reason + stderr_tail here.
  if (url.pathname === '/api/carrier/swap-history') {
    const wantLog = url.searchParams.get('log') === '1';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      history: getSwapHistory(),
      log_tail: wantLog ? readLogTail(8192) : null,
    }));
    return;
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

  // Bundle hash — used by the dashboard to decide whether a Craft swap requires
  // a full window.location.reload(). On `server_swap` the client compares the
  // current hash against the one captured at page mount; if unchanged, the WS
  // reconnect handles everything and the page reload is skipped (preserving
  // tabs, scrollback, Π Remembers, etc.).
  // Bug #457: prior to this, every Craft swap reloaded the page even when the
  // dashboard bundle was identical, wiping the user's visible state.
  if (url.pathname === '/api/dashboard/bundle-hash' && req.method === 'GET') {
    try {
      const indexPath = join(__dirname, '..', 'public', 'v2', 'index.html');
      let hash = 'unknown';
      if (existsSync(indexPath)) {
        // Cheap: hash mtime+size, not file contents. The SvelteKit build emits
        // hashed chunk names referenced from index.html, so any code change
        // produces a new index.html with different mtime/size.
        const st = statSync(indexPath);
        hash = createHash('sha1')
          .update(`${st.mtimeMs}:${st.size}`)
          .digest('hex')
          .slice(0, 16);
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ hash }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'hash failed' }));
    }
    return;
  }

  if (url.pathname === '/api/carrier/swap' && req.method === 'POST') {
    // Phase 4: Hot-swap Craft without losing PTY/WS connections
    // #472: log the swap so PTY exits during this window can be correlated.
    recordEvent('craft_swap', {
      trigger: 'manual_api',
      old_craft_id: primaryCraft?.id,
      old_craft_port: primaryCraft?.port,
      old_craft_pid: primaryCraft?.proc?.pid,
    });
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

    // #472: emit DB event BEFORE we kill ourselves. This is the row that will
    // sit next to any PtyExit rows that fire because of the restart, making
    // #457 (silent PTY death during swap/restart) diagnosable post-hoc.
    recordEvent('carrier_restart', {
      reason: force ? 'forced' : 'user_requested',
      forced: force,
      system_ready: snap.system_ready,
      reconnect_in_ms: RESTART_DELAY_MS + 2000,
      carrier_pid: process.pid,
      primary_craft_id: primaryCraft?.id,
      primary_craft_pid: primaryCraft?.proc?.pid,
    });

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

  // Force re-check craft health — useful after post-sleep late boot where craft started
  // after the 45s waitForCraftHealth window already timed out.
  if (url.pathname === '/api/carrier/heal' && req.method === 'POST') {
    if (!primaryCraft) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'no primary craft' }));
    }
    const craft = primaryCraft;
    fetchCraft(craft.port, '/health').then((r) => {
      if (r.status === 200) {
        craft.healthy = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, healed: true, craftId: craft.id }));
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'craft still not responding' }));
      }
    }).catch(() => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'craft still not responding' }));
    });
    return;
  }

  // Connected-clients snapshot for the Craft. The Craft has its own
  // client-manager but Carrier is where WS sessions actually terminate
  // (Craft delegates via /api/carrier/client-send) — so getConnectedClients()
  // on the Craft is always empty. The router's claude_control device picker
  // needs to know which devices have a local Claude session available; that
  // info rides on entry.claude_control here. Cheap endpoint, returns the
  // same shape as client-manager getConnectedClients().
  if (url.pathname === '/api/carrier/clients' && req.method === 'GET') {
    (async () => {
      try {
        const cm = await import('./client-manager.js');
        const list = cm.getConnectedClients() || [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, clients: list }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
    return;
  }

  // Client command relay — Carrier owns WS connections, Craft delegates here
  // POST /api/carrier/client-send  { device_id, type, timeout_ms?, ...params }
  if (url.pathname === '/api/carrier/client-send' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { device_id, type, timeout_ms = 30_000, ...params } = JSON.parse(body);
        if (!device_id || !type) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'device_id and type required' }));
        }
        const cm = await import('./client-manager.js');
        if (!cm.isClientConnected(device_id)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: `Client '${device_id}' not connected via WS` }));
        }
        const result = await cm.sendToClient(device_id, type, params, timeout_ms);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (err) {
        res.writeHead(err.message?.includes('not connected') ? 404 : 408, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // ── DASHBOARD STATIC BUNDLES — SERVED DIRECTLY BY CARRIER ──
  //
  // SvelteKit code-splits each dashboard route into its own immutable chunk
  // under /v2/_app/immutable/nodes/<N>.<hash>.js. Without this short-circuit,
  // every chunk request gets proxied to Craft, which means whenever Craft is
  // mid-block (a sync DB query, a slow handler), even tiny .js files 502 —
  // and SvelteKit's `Failed to fetch dynamically imported module` fires,
  // which silently breaks navigation (the Automation page would just not
  // load until you refreshed).
  //
  // Carrier has the same filesystem access; serving these files directly
  // from disk is sub-millisecond and never depends on Craft's loop state.
  // The bundle filenames embed content hashes, so we can mark them
  // immutable for the browser cache.
  if (req.method === 'GET' && url.pathname.startsWith('/v2/_app/')) {
    try {
      const safePath = url.pathname.replace(/\.\./g, ''); // path traversal guard
      const filePath = join(__dirname, '..', 'public', safePath);
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
        const mime = ext === '.js' ? 'application/javascript'
                   : ext === '.css' ? 'text/css'
                   : ext === '.json' ? 'application/json'
                   : ext === '.svg' ? 'image/svg+xml'
                   : ext === '.png' ? 'image/png'
                   : ext === '.woff2' ? 'font/woff2'
                   : 'application/octet-stream';
        // _app/immutable/ files carry a content hash in their name — they're
        // truly immutable, so 1y immutable cache is correct.
        // _app/version.json (and similar non-immutable bundle metadata) must
        // stay no-store so the version-check polling still works.
        const isImmutable = url.pathname.startsWith('/v2/_app/immutable/');
        const cacheControl = isImmutable
          ? 'public, max-age=31536000, immutable'
          : 'no-store, must-revalidate';
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': cacheControl,
        });
        // Use a stream to avoid loading the whole file into memory for big chunks.
        createReadStream(filePath).pipe(res);
        return;
      }
    } catch {}
    // fall through to proxy if anything went wrong (file missing / read err)
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
  recordSwapPhase('started', {
    old_craft_id: oldCraft?.id, old_commit: oldCommit,
    new_craft_id: newCraft.id, new_commit: newCommit, new_port: newPort,
  });

  const healthResult = await waitForCraftHealth(newCraft);

  if (!healthResult.healthy) {
    const stderrTail = getCraftStderrTail(newCraft, 50);
    console.error(`[Carrier] New Craft failed /health (reason=${healthResult.reason}) — aborting swap, keeping old Craft`);
    if (stderrTail) console.error(`[Carrier] Craft-${newCraft.id} stderr tail:\n${stderrTail}`);
    recordSwapPhase('health_failed', {
      new_craft_id: newCraft.id, new_commit: newCommit,
      triggered_by: 'new_craft_health_check',
      reason: healthResult.reason,
      detail: healthResult.detail,
      last_status: healthResult.lastStatus,
      stderr_tail: stderrTail,
      exit_code: newCraft.proc?.exitCode,
      exit_signal: newCraft.proc?.signalCode,
    });
    recordEvent('craft_swap_aborted', {
      phase: 'health_failed',
      old_commit: oldCommit, new_commit: newCommit,
      new_craft_id: newCraft.id,
      reason: healthResult.reason,
      detail: (healthResult.detail || '').slice(0, 500),
      stderr_tail: stderrTail.slice(-2000),
    });
    // #496-followup: surface the failure to the dashboard so users don't get
    // the false "Swap initiated" success while prod silently stays on the old Craft.
    if (terminalServer) {
      try {
        terminalServer.broadcastNotification('swap_failed', {
          phase: 'health_failed',
          reason: healthResult.reason,
          detail: (healthResult.detail || '').slice(0, 300),
          old_commit: oldCommit,
          new_commit: newCommit,
          stderr_tail: stderrTail.slice(-1500),
        });
      } catch {}
    }
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

  // Force-probe all SWAP_GATE stages against the new Craft before opening the
  // rollback window. This clears any stale 'failed' state from a previous swap
  // so isSwapSafe() only sees real failures from THIS Craft.
  console.log(`[Carrier] 🔍 Probing SWAP_GATE stages against Craft-${newCraft.id}...`);
  await Promise.all(SWAP_GATE.map(id => perfEngine.forceProbe(id).catch(() => {})));

  swapPending = true;
  perfEngine.markSwapStart();

  const gateCheck = perfEngine.isSwapSafe();
  if (!gateCheck.safe) {
    console.error(`[Carrier] ❌ New Craft-${newCraft.id} failed initial swap gate: ${gateCheck.reason} — aborting swap`);
    recordSwapPhase('gate_failed', {
      new_craft_id: newCraft.id, new_commit: newCommit,
      triggered_by: 'initial_gate_probe',
      reason: gateCheck.reason,
      failed_stages: gateCheck.failed_stages || gateCheck.failedStages,
    });
    const gateStderrTail = getCraftStderrTail(newCraft, 50);
    recordEvent('craft_swap_aborted', {
      phase: 'gate_failed',
      old_commit: oldCommit, new_commit: newCommit,
      new_craft_id: newCraft.id,
      reason: gateCheck.reason,
      failed_stages: gateCheck.failed_stages || gateCheck.failedStages,
      stderr_tail: gateStderrTail.slice(-2000),
    });
    // #496-followup: surface gate failures the same way as health failures.
    if (terminalServer) {
      try {
        terminalServer.broadcastNotification('swap_failed', {
          phase: 'gate_failed',
          reason: gateCheck.reason,
          failed_stages: gateCheck.failed_stages || gateCheck.failedStages,
          old_commit: oldCommit,
          new_commit: newCommit,
          stderr_tail: gateStderrTail.slice(-1500),
        });
      } catch {}
    }
    swapPending = false;
    primaryCraft = oldCraft;
    // Kill previousCraft before nulling — prevents orphan Craft leak
    if (previousCraft && previousCraft !== oldCraft) {
      console.log(`[Carrier] 🧹 Gate failure — killing orphaned Craft-${previousCraft.id}`);
      try { previousCraft.proc.kill(); } catch {}
    }
    previousCraft = null;
    perfEngine.primaryCraftPort = oldCraft?.port;
    perfEngine.markSwapEnd();
    try { newCraft.proc.kill(); } catch {}
    return;
  }

  recordSwapPhase('live', {
    old_craft_id: oldCraft?.id, old_commit: oldCommit,
    new_craft_id: newCraft.id, new_commit: newCommit,
    rollback_window_ms: ROLLBACK_TIMEOUT_MS,
  });
  recordEvent('craft_swap_live', {
    old_commit: oldCommit, new_commit: newCommit,
    new_craft_id: newCraft.id, new_port: newCraft.port,
  });
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
  //
  // BOOT GRACE (matches the perfEngine.onChange path): if the new primary
  // is still inside its first 60 seconds, confirm anyway — boot CPU spikes
  // are routinely 30s on this codebase's 1.6GB DB and the alternative is
  // perpetual rollback. The Lifeboat panel is still available for manual
  // intervention if Craft is actually broken.
  const craftAge = primaryCraft?.startedAt ? Date.now() - primaryCraft.startedAt : 0;
  const inBootGrace = craftAge < 60_000;
  const safety = perfEngine.isSwapSafe();
  if (!safety.safe && !inBootGrace) {
    console.error(`[Carrier] ❌ Swap unsafe: ${safety.reason} — rolling back instead of confirming`);
    // Pull the leading stage id out of `safety.reason` (format from perf/engine.js
    // isSwapSafe: "<stage_id> failed during rollback window: …" or "<stage_id> is <state>").
    const stageMatch = /^([a-z0-9_]+)\s+(failed|is)\b/i.exec(safety.reason || '');
    return performRollback({
      triggered_by: 'gate_unsafe_on_confirm',
      reason: safety.reason || 'swap unsafe at confirm time',
      failed_stage: stageMatch ? stageMatch[1] : null,
    });
  }
  if (!safety.safe && inBootGrace) {
    console.warn(`[Carrier] ⚠️  Swap gate unsafe at confirm time but Craft is still in 60s boot-grace window (age=${Math.round(craftAge/1000)}s, reason="${safety.reason}") — confirming anyway`);
  }

  if (rollbackTimer) { clearTimeout(rollbackTimer); rollbackTimer = null; }
  swapPending = false;
  perfEngine.markSwapEnd();

  recordSwapPhase('confirmed', {
    primary_craft_id: primaryCraft?.id, primary_commit: primaryCraft?.gitCommit,
    retired_craft_id: previousCraft?.id, retired_commit: previousCraft?.gitCommit,
  });
  recordEvent('craft_swap_confirmed', {
    primary_commit: primaryCraft?.gitCommit, retired_commit: previousCraft?.gitCommit,
    primary_craft_id: primaryCraft?.id,
  });

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

  // ── DISABLED: post-swap burst + regression auto-triggers ───────────────────
  // These previously fired on EVERY confirmed swap and consumed 60+ seconds
  // of heavy CPU/IO work on the new Craft right when the user is most
  // likely to be clicking around the dashboard:
  //
  //   1. Screen-watcher burst → 12 vision-model captures over 60 seconds
  //      (each capture observed at ~7s in webcam-watcher logs).
  //   2. P1 regression suite → spawns Playwright + headless Chromium,
  //      navigates to /v2/terminal, runs interactive keystroke tests.
  //      Each run can easily take 30+ seconds and ties up the event loop.
  //
  // During hot-swap development the swap cadence is high (manual swaps + sleep-
  // wake + auto-rollback recovery), so these two post-swap actions stacked
  // up into permanent background load that made the dashboard unusable.
  //
  // Re-enable conditionally (e.g. only on pipeline-promoted swaps, not manual
  // /api/carrier/swap) once the dev cycle is calmer. The Vision verifier still
  // covers the "is the dashboard rendering" case on its own 2-min cadence.
  if (process.env.PAN_CARRIER_POST_SWAP_BURST === '1') {
    fetch(`http://127.0.0.1:${primaryCraft.port}/api/v1/screen-watcher/burst`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration_ms: 60_000, interval_ms: 5_000 }),
      signal: AbortSignal.timeout(3000),
    }).catch(e => console.warn('[Carrier] Screen burst trigger failed:', e.message));
  }
  if (process.env.PAN_CARRIER_POST_SWAP_P1 === '1') {
    setTimeout(() => {
      fetch(`http://127.0.0.1:${primaryCraft.port}/api/v1/tests/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suite: 'p1-regression' }),
        signal: AbortSignal.timeout(60_000),
      }).then(r => r.json()).then(result => {
        const failed = result.results?.filter(t => t.status === 'fail') || [];
        if (failed.length) {
          console.error(`[Carrier] ⚠️  P1 regression FAILED after swap: ${failed.map(t => t.id).join(', ')}`);
        } else {
          console.log(`[Carrier] ✅ P1 regression passed after swap (${result.results?.length || 0} tests)`);
        }
      }).catch(e => console.warn('[Carrier] P1 regression trigger failed:', e.message));
    }, 5000);
  }

  // Auto-trigger pipeline benchmarks after a confirmed swap — validates new code
  // against all 12 suites. If all pass, beta auto-promotes; if any fail, current
  // primary stays live and pipeline status goes to 'failed' for Scout to pick up.
  // IMPORTANT: skip if this Craft was itself promoted from pipeline — otherwise
  // every promotion triggers another pipeline, creating an infinite spawn loop.
  // AUTO-PIPELINE TEMPORARILY DISABLED — re-enable after p1-regression tests are verified
  // if (pipeline.status === 'idle' && !primaryCraft.fromPipeline) {
  //   console.log(`[Carrier] 🔬 Auto-triggering benchmark pipeline on Craft-${primaryCraft.id} (post-swap validation)`);
  //   startPipelineBeta('autodev').catch(err =>
  //     console.error('[Carrier] Auto-pipeline start failed:', err.message)
  //   );
  // }
  if (false) {
    // disabled
  } else if (primaryCraft.fromPipeline) {
    console.log(`[Carrier] ⏭️  Craft-${primaryCraft.id} was pipeline-promoted — skipping auto-trigger to prevent loop`);
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

// #981: every rollback path must pass `reasonCtx` so swap-history captures
// WHY the rollback fired. Without this the operator sees `rolled_back` rows
// with no reason and `stderr_tail` containing unrelated boot noise, and has
// to grep carrier stdout to figure out which gate stage tripped.
//
// reasonCtx shape:
//   {
//     triggered_by: 'auto_rollback_perf_probe' | 'gate_unsafe_on_confirm'
//                 | 'craft_crash' | 'manual_lifeboat',
//     reason: <short string, e.g. 'ptys_bound failed during rollback window: …'>,
//     failed_stage: <SWAP_GATE stage id if known>,
//     detail: <optional extra context (exit_code, exit_signal, user note, …)>
//   }
function performRollback(reasonCtx = {}) {
  if (!swapPending || !previousCraft) {
    // Even no-op rollbacks deserve a breadcrumb — diagnoses the case where
    // something tried to rollback after the window already closed.
    console.warn(`[Carrier] performRollback called but no rollback available (triggered_by=${reasonCtx.triggered_by || 'unknown'}, reason=${reasonCtx.reason || 'unspecified'})`);
    return { ok: false, reason: 'No rollback available', triggered_by: reasonCtx.triggered_by };
  }
  if (rollbackTimer) { clearTimeout(rollbackTimer); rollbackTimer = null; }
  swapPending = false;

  const failedCraft = primaryCraft;
  primaryCraft = previousCraft;
  previousCraft = null;
  perfEngine.primaryCraftPort = primaryCraft.port;
  perfEngine.markSwapEnd();

  const triggeredBy = reasonCtx.triggered_by || 'unknown';
  const reason = reasonCtx.reason || 'unspecified';
  const failedStage = reasonCtx.failed_stage || null;
  const detail = reasonCtx.detail || null;
  const stderrTail = getCraftStderrTail(failedCraft, 50).slice(-2000);

  console.log(`[Carrier] 🔙 ROLLBACK — reverting to Craft-${primaryCraft.id} (${primaryCraft.gitCommit}), killing Craft-${failedCraft.id} [triggered_by=${triggeredBy}, reason=${reason}${failedStage ? `, failed_stage=${failedStage}` : ''}]`);

  recordSwapPhase('rolled_back', {
    rolled_back_to_craft_id: primaryCraft.id, rolled_back_to_commit: primaryCraft.gitCommit,
    killed_craft_id: failedCraft.id, killed_commit: failedCraft.gitCommit,
    triggered_by: triggeredBy,
    reason,
    failed_stage: failedStage,
    detail,
    stderr_tail: stderrTail,
  });
  recordEvent('craft_swap_rolled_back', {
    rolled_back_to_commit: primaryCraft.gitCommit, killed_commit: failedCraft.gitCommit,
    killed_craft_id: failedCraft.id,
    triggered_by: triggeredBy,
    reason,
    failed_stage: failedStage,
    detail: typeof detail === 'string' ? detail.slice(0, 500) : detail,
  });
  try { failedCraft.proc.kill(); } catch {}

  if (terminalServer) {
    terminalServer.broadcastNotification('swap_rollback', {
      rolledBackTo: primaryCraft.id,
      killed: failedCraft.id,
      triggered_by: triggeredBy,
      reason,
      failed_stage: failedStage,
    });
  }
  return { ok: true, activeCraft: primaryCraft.id, commit: primaryCraft.gitCommit, triggered_by: triggeredBy, reason, failed_stage: failedStage };
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
    const trackedCrafts = [primaryCraft, previousCraft, shadowCraft].filter(Boolean);
    json(200, {
      ok: true,
      swapPending,
      rollbackAvailable: swapPending && !!previousCraft,
      rollbackTimeoutMs: ROLLBACK_TIMEOUT_MS,
      activeCraft: primaryCraft ? { id: primaryCraft.id, port: primaryCraft.port, commit: primaryCraft.gitCommit, healthy: primaryCraft.healthy } : null,
      previousCraft: previousCraft ? { id: previousCraft.id, port: previousCraft.port, commit: previousCraft.gitCommit, healthy: previousCraft.healthy } : null,
      craftCount: trackedCrafts.length,
      crafts: trackedCrafts.map(c => ({ id: c.id, port: c.port, pid: c.proc?.pid, role: c === primaryCraft ? 'primary' : c === previousCraft ? 'previous' : 'shadow' })),
      carrierPid: process.pid,
      carrierUptime: process.uptime(),
    });
    return true;
  }

  if (url.pathname === '/lifeboat/rollback' && method === 'POST') {
    const result = performRollback({
      triggered_by: 'manual_lifeboat',
      reason: 'user requested rollback via /lifeboat/rollback',
    });
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

      // Trigger /compact after 2 hours of continuous Claude usage to prevent context bloat
      if (uptimeHours > 2 && !session._handoffTriggered) {
        session._handoffTriggered = true;
        console.log(`[Carrier] Phase 5: Claude session ${session.id} running ${uptimeHours.toFixed(1)}h — triggering handoff`);
        triggerClaudeHandoff(session);
      }
    }
  }, 60000); // Check every minute
}

async function triggerClaudeHandoff(session) {
  if (!terminalServer) return;
  const uptimeH = ((Date.now() - (session.createdAt || Date.now())) / 3_600_000).toFixed(1);
  // DISABLED by user request (2026-05-26) — this was injecting /compact\n into
  // PTYs once a minute (the _handoffTriggered flag wasn't sticking, so it
  // fired every interval, not once at the 2h mark). That mid-session compact
  // command also lands as a phantom prompt in the user's transcript.
  console.warn(`[Carrier] Phase 5: /compact auto-handoff DISABLED — would have compacted ${session.id} (uptime ${uptimeH}h)`);
  return;
}

// ==================== Craft Orphan Watchdog ====================
// Scans port range CRAFT_PORT_BASE..+20 every 60s.
// Any process found on those ports whose PID doesn't match a known Craft is killed.
let craftWatchdogTimer = null;

async function runCraftOrphanScan() {
  const { isWindows: _isWin } = await import('./platform.js');
  const { execSync: _exec } = await import('child_process');

  // Collect all PIDs we intentionally own
  const knownPids = new Set([process.pid]);
  if (primaryCraft?.proc?.pid)  knownPids.add(primaryCraft.proc.pid);
  if (previousCraft?.proc?.pid) knownPids.add(previousCraft.proc.pid);
  if (shadowCraft?.proc?.pid)   knownPids.add(shadowCraft.proc.pid);
  if (betaCraft?.proc?.pid)     knownPids.add(betaCraft.proc.pid);

  const SCAN_RANGE = 20;
  let killedCount = 0;

  for (let offset = 0; offset <= SCAN_RANGE; offset++) {
    const port = CRAFT_PORT_BASE + offset;
    try {
      let pids = new Set();
      if (process.platform === 'win32') {
        const result = _exec(
          `netstat -ano | findstr :${port} | findstr LISTENING`,
          { encoding: 'utf8', timeout: 5000, windowsHide: true }
        );
        for (const line of result.trim().split('\n')) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[parts.length - 1]);
          if (pid) pids.add(pid);
        }
      } else {
        const result = _exec(`lsof -ti :${port}`, { encoding: 'utf8', timeout: 5000 });
        for (const line of result.trim().split('\n')) {
          const pid = parseInt(line.trim());
          if (pid) pids.add(pid);
        }
      }

      for (const pid of pids) {
        if (!knownPids.has(pid)) {
          console.warn(`[Carrier] 🧹 Craft watchdog: orphan PID ${pid} on port ${port} — killing`);
          try { process.kill(pid); } catch {}
          killedCount++;
        }
      }
    } catch {
      // Port not in use — good
    }
  }

  if (killedCount > 0) {
    console.log(`[Carrier] 🧹 Craft watchdog: killed ${killedCount} orphaned Craft process(es)`);
  }
}

function startCraftOrphanWatchdog() {
  if (craftWatchdogTimer) return;
  craftWatchdogTimer = setInterval(() => {
    runCraftOrphanScan().catch(e => console.warn('[Carrier] Craft watchdog error:', e.message));
  }, 60_000);
  console.log('[Carrier] 🛡️  Craft orphan watchdog started (60s interval, ports 17700–17720)');
}

// ==================== Boot ====================
async function boot() {
  // Client WS MUST be registered before terminal (terminal rejects unknown upgrade paths)
  await initClientServer(carrierServer);

  // Phase 4: Carrier owns terminal/PTY — but only when the profile serves the
  // browser xterm surface (full/core). In `wearable` the WS terminal server is
  // gated off; the phone's pipe-mode voice path runs over HTTP without it, and
  // /ws/client (device mesh) has its own upgrade handler in client-manager.
  try {
    const { featureEnabled } = await import('./profiles.js');
    if (featureEnabled('terminal_server')) {
      await initTerminal(carrierServer);
    } else {
      console.log(`[Carrier] Terminal/PTY WS server SKIPPED — profile ${process.env.PAN_PROFILE || 'full'} (pipe mode still serves the phone over HTTP)`);
    }
  } catch (e) {
    // Fail-open: if the profile check itself throws, keep the terminal server
    // (protects the default `full` profile from a boot regression).
    console.warn('[Carrier] profile gate failed, starting terminal anyway:', e?.message);
    await initTerminal(carrierServer);
  }

  // Start Claude handoff monitor (Phase 5)
  startClaudeHandoffMonitor();

  // Start Craft orphan watchdog — kills stale Craft processes not tracked by Carrier
  startCraftOrphanWatchdog();

  // PerfEngine — give it the terminalServer reference for PTY probes, then start.
  // Boot-time marks are set when each subsystem finishes initializing.
  perfEngine.terminalServer = terminalServer;
  perfEngine.mark('carrier_boot', 0);
  perfEngine.start();

  // Auto-rollback hook: if the engine detects SWAP_GATE failure during the
  // rollback window, fire Lifeboat automatically (without waiting for timeout).
  //
  // **Sustained-failure gate**: prior to this change a SINGLE probe miss
  // (a transient 3s http timeout while the new Craft is still finishing
  // schema migrations) was enough to nuke the swap and revert. Symptom:
  // every deploy silently rolled back because boot-callback sync work
  // blocked the loop for 3-6s. We now require N consecutive failed
  // probes from the SAME stage within a short window before pulling
  // the trigger. Real broken Crafts fail repeatedly; transient
  // boot-window hiccups recover within one probe interval.
  // Boot-tolerant thresholds. The OLD values (3 failures in 30s) were too
  // tight: a single 6s event-loop block during Craft boot was enough to fail
  // multiple probes back-to-back, since probes fire every ~3s. The previous
  // raise to (10, 5min) didn't help in practice because the 30s rollback
  // window itself is so short — 10 probe failures in 30s is still trivial
  // when boot is blocked.
  //
  // The real fix: a BOOT-GRACE WINDOW during which auto-rollback is disabled
  // entirely. Fresh Crafts get 60 seconds of immunity from the gate. That's
  // enough for schema migrations, audit chain verification, Steward boot,
  // and the deferred-watchers stagger to all finish. After 60s, the normal
  // (10, 5min) gate kicks in to catch genuinely broken Crafts.
  //
  // Trade-off: a Craft that's busted from minute 0 won't auto-roll back
  // until 60s in. That's acceptable — the user just hits Lifeboat manually
  // if they see Craft never finish booting. The opposite failure mode (deploys
  // silently rolling back because of boot CPU spikes) was the daily-life pain.
  const ROLLBACK_FAIL_THRESHOLD = 10;
  const ROLLBACK_FAIL_WINDOW_MS = 5 * 60_000;
  const BOOT_GRACE_MS = 60_000;
  const _failStreak = new Map(); // stage_id -> { count, firstAt }
  perfEngine.onChange(() => {
    if (!swapPending || !previousCraft) return;
    // BOOT GRACE: skip the gate entirely while the new primary is still in
    // its first 60 seconds. perfEngine.onChange still fires (so the streak
    // count keeps incrementing if we counted it), but we treat the result
    // as "hold rollback" no matter what. Lifeboat is the manual escape hatch.
    const craftAge = primaryCraft?.startedAt ? Date.now() - primaryCraft.startedAt : 0;
    if (craftAge < BOOT_GRACE_MS) return;
    const safety = perfEngine.isSwapSafe();
    if (safety.safe) {
      // All gates clean — clear any in-flight streaks (one successful
      // probe should reset the counter, mirroring how circuit breakers work).
      if (_failStreak.size) _failStreak.clear();
      return;
    }
    const stageMatch = /^([a-z0-9_]+)\s+(failed|is)\b/i.exec(safety.reason || '');
    const stageId = stageMatch ? stageMatch[1] : 'unknown';
    const now = Date.now();
    let s = _failStreak.get(stageId);
    if (!s || (now - s.firstAt) > ROLLBACK_FAIL_WINDOW_MS) {
      s = { count: 0, firstAt: now };
      _failStreak.set(stageId, s);
    }
    s.count += 1;
    if (s.count < ROLLBACK_FAIL_THRESHOLD) {
      console.warn(`[Carrier] ⚠️  Perf probe failure ${s.count}/${ROLLBACK_FAIL_THRESHOLD} on ${stageId}: ${safety.reason} — holding rollback`);
      return;
    }
    console.error(`[Carrier] 🚨 Perf probe failed ${s.count}× on ${stageId}: ${safety.reason} — auto-rolling back`);
    _failStreak.clear();
    performRollback({
      triggered_by: 'auto_rollback_perf_probe',
      reason: safety.reason || 'perf probe failed during rollback window',
      failed_stage: stageId === 'unknown' ? null : stageId,
    });
  });

  // Kill any zombie carrier holding our own port — only when running standalone.
  // Under Super-Carrier, port cleanup is Super-Carrier's responsibility.
  if (!IS_UNDER_SUPER_CARRIER) {
    try {
      const zombies = await killProcessOnPort(CARRIER_PORT);
      if (zombies.size > 0) {
        console.log(`[Carrier] ⚰️  Killed zombie carrier(s) on port ${CARRIER_PORT}: ${[...zombies].join(', ')}`);
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (e) {
      console.warn(`[Carrier] Could not clean carrier port ${CARRIER_PORT}: ${e.message}`);
    }
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

  // Detect "we just respawned after a user-requested restart" so we can emit
  // a `carrier_ready` notification once Craft is healthy. Without this the UI
  // shows the blue "PAN restarting…" banner that only clears on a 30s safety
  // timer — the user can't tell whether the restart actually worked until
  // they type something. See terminal/+page.svelte 'carrier_ready' handler.
  let _restartPendingMarker = null;
  try {
    const isDev = process.env.PAN_DEV === '1';
    const markerPath = join(process.env.LOCALAPPDATA || '', 'PAN', isDev ? 'data-dev' : 'data', '.restart-pending');
    if (existsSync(markerPath)) {
      const ts = parseInt(readFileSync(markerPath, 'utf8'), 10);
      _restartPendingMarker = { path: markerPath, ts: Number.isFinite(ts) ? ts : Date.now() };
      try { unlinkSync(markerPath); } catch {}
      console.log(`[Carrier] 🔁 Restart marker detected (age=${Date.now() - _restartPendingMarker.ts}ms) — will broadcast carrier_ready once Craft is up`);
    }
  } catch (err) {
    console.warn('[Carrier] restart-pending marker read failed:', err.message);
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

  // If we just respawned from a user-requested restart, tell the dashboards
  // we're back. 1.5s grace gives WS clients time to reconnect first.
  // Persist a `carrier_ready` event row IMMEDIATELY (not delayed) so Scout/
  // Forge can pair it with the preceding `carrier_restart` event to detect
  // stuck restarts: carrier_restart with no carrier_ready within 30s = bad.
  if (_restartPendingMarker && primaryCraft?.healthy) {
    const downtimeMs = Date.now() - _restartPendingMarker.ts;
    const readyPayload = {
      craft_id: primaryCraft?.id,
      craft_commit: primaryCraft?.gitCommit || getGitCommit(),
      downtime_ms: downtimeMs,
      carrier_pid: process.pid,
      marker_ts: _restartPendingMarker.ts,
    };
    try {
      recordEvent('carrier_ready', readyPayload);
    } catch (err) {
      console.warn('[Carrier] carrier_ready event record failed:', err.message);
    }
    setTimeout(() => {
      if (!terminalServer) return;
      try {
        terminalServer.broadcastNotification('carrier_ready', readyPayload);
        console.log(`[Carrier] ✅ Broadcast carrier_ready (downtime=${downtimeMs}ms, craft=${primaryCraft?.id})`);
      } catch (err) {
        console.warn('[Carrier] carrier_ready broadcast failed:', err.message);
      }
    }, 1500);
  }

  // ── Zombie self-detector ────────────────────────────────────────────────
  // Only needed in standalone mode. Under Super-Carrier, SC owns port 7777
  // and manages our lifecycle directly — no zombie scenario is possible.
  if (IS_UNDER_SUPER_CARRIER) return;
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
