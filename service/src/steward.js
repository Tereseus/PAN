// PAN Steward — Service Orchestrator & Health Manager
//
// Steward is the supervisor for ALL PAN background services.
// It owns: boot order, health checks, model requirements, service lifecycle,
// zombie cleanup, and Atlas data feed.
//
// Every service declares:
//   - What model tier it needs (none, local, reasoning, interactive)
//   - Minimum model size to function correctly
//   - What it's currently configured to use
//   - Boot order and dependencies
//   - Health check method
//   - Run interval
//
// Atlas reads from Steward's registry to render the service graph.

import { get, all, run, insert, getOllamaUrl } from './db.js';
import { sendToClient, getConnectedClients } from './client-manager.js';
import { startClassifier, stopClassifier } from './classifier.js';
import { startIntuition, stopIntuition } from './intuition.js';
import { startScout, stopScout } from './scout.js';
import { startDream, stopDream } from './dream.js';
import { startAutoDev, stopAutoDev } from './autodev.js';
import { startStackScanner, stopStackScanner } from './stack-scanner.js';
import { startOrchestrator, stopOrchestrator } from './orchestrator.js';
import { consolidate as consolidateMemory } from './memory/consolidation.js';
import { evolve as runEvolution } from './evolution/engine.js';
import { listSessions, sendToSession, broadcastToSession, broadcastNotification, getProcessRegistry } from './terminal-bridge.js';
import { createAlert } from './routes/dashboard.js';
import { hostname } from 'os';
import http from 'http';
import { spawn, execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, existsSync } from 'fs';
import { IS_USER_MODE, IS_SERVICE_MODE } from './mode.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ==================== MODEL TIERS ====================
// These define what kind of AI backend a service requires.
// Atlas displays these as badges on each service node.

const MODEL_TIERS = {
  none:        { label: 'None',        color: '#6c7086', description: 'No AI model needed' },
  local:       { label: 'Local',       color: '#a6e3a1', description: 'Local Ollama (qwen3:4b / qwen3-embedding)' },
  reasoning:   { label: 'Cloud 30B+',  color: '#89b4fa', description: 'Cerebras (Qwen 3 235B / GPT-OSS 120B)' },
  interactive: { label: 'Claude CLI',  color: '#f9e2af', description: 'Claude via CLI subscription (terminal + automation)' },
};

// ==================== SERVICE REGISTRY ====================
// Every PAN service is defined here. This is the single source of truth
// that Atlas, health checks, and boot sequencing all read from.

const services = [
  {
    id: 'ollama',
    name: 'Local Intelligence',
    technicalName: 'Ollama',
    get description() { return `Ollama model server at ${getOllamaUrl()} — embeddings + inference`; },
    modelTier: 'none',
    modelMinSize: 'N/A',
    modelCurrent: 'N/A (serves models, not a consumer)',
    port: 11434,
    healthCheck: 'url',
    healthEndpoint: '/api/tags',
    bootOrder: 1,
    dependsOn: [],
    interval: null, // always-on process
    startFn: async () => {
      // AUTO-START DISABLED — Ollama consumes too much memory. Start manually if needed.
      console.log('[Steward] Ollama auto-start disabled. Run `ollama serve` manually if needed.');
    },
    stopFn: null,
    _status: 'unknown',
    _lastCheck: null,
    _lastError: null,
    _lastRun: null,
  },
  {
    id: 'embeddings',
    name: 'Resonance',
    technicalName: 'Embeddings',
    description: 'Vector text encoding for memory search (1024D)',
    modelTier: 'local',
    modelMinSize: '0.6B',
    modelCurrent: 'qwen3-embedding (Ollama)',
    port: null,
    healthCheck: 'function',
    bootOrder: 2,
    dependsOn: ['ollama'],
    interval: null, // on-demand
    startFn: null,
    stopFn: null,
    _status: 'unknown',
    _lastCheck: null,
    _lastError: null,
    _lastRun: null,
  },
  {
    id: 'whisper',
    name: 'Whisper STT',
    description: 'Voice-to-text batch transcription (faster-whisper base, GPU)',
    modelTier: 'local',
    modelMinSize: '~145MB (base)',
    modelCurrent: 'faster-whisper-base',
    port: 7782,
    healthCheck: 'port',
    bootOrder: 3,
    dependsOn: [],
    interval: null, // always-on
    startFn: () => {
      const whisperScript = join(__dirname, 'whisper-server.py');
      // Kill any pre-existing whisper-server.py instances before spawning a new
      // one. Each instance commits ~1.95GB and steward used to leak one per
      // PAN restart (detached + .unref() means they outlived the parent node).
      // We saw 11 zombies eating ~21GB committed in the wild — never again.
      try {
        execSync(
          'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'python.exe\'\\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like \'*whisper-server*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
          { stdio: 'ignore', timeout: 8000, windowsHide: true }
        );
      } catch (err) {
        console.warn('[Steward] Whisper pre-kill failed (non-fatal):', err.message);
      }
      try {
        spawn('python', [whisperScript], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }).unref();
        console.log('[Steward] Launched whisper-server.py (killed any prior instances first)');
      } catch (err) {
        console.error('[Steward] Failed to launch whisper-server.py:', err.message);
      }
    },
    stopFn: null,
    _status: 'unknown',
    _lastCheck: null,
    _lastError: null,
    _lastRun: null,
  },
  // AHK RETIRED — voice hotkeys now handled natively by Tauri shell.
  // The Tauri shell registers XButton1→Win+H and XButton2→dictate-vad.py directly.
  {
    id: 'voice-shell',
    name: 'Voice Shell',
    technicalName: 'Tauri Shell',
    description: 'Native Windows dashboard & voice hotkey listener',
    modelTier: 'none',
    modelMinSize: 'N/A',
    modelCurrent: 'N/A',
    port: null,
    healthCheck: 'process',
    processName: 'pan-shell.exe',
    userOnly: true,
    bootOrder: 4,
    dependsOn: ['whisper'],
    interval: null,
    startFn: null, // Launched by PAN.bat, not steward
    stopFn: null,
    _status: 'unknown',
    _lastCheck: null,
    _lastError: null,
    _lastRun: null,
  },
  {
    id: 'classifier',
    name: 'Augur',
    technicalName: 'Classifier',
    description: 'Event processor — marks events, triggers Dream when enough accumulate',
    modelTier: 'reasoning',
    modelMinSize: '8B',
    modelCurrent: 'cerebras:qwen-3-235b',
    port: null,
    healthCheck: 'interval',
    bootOrder: 5,
    dependsOn: [],
    interval: '5m',
    intervalMs: 5 * 60 * 1000,
    startFn: () => startClassifier(5 * 60 * 1000),
    stopFn: () => stopClassifier(),
    _status: 'stopped',
    _lastCheck: null,
    _lastError: null,
    _lastRun: null,
  },
  {
    id: 'intuition',
    name: 'Intuition',
    technicalName: 'Dimensional State Daemon',
    description: 'Live situational state — fuses events+wrap+sensors into what Commander is doing right now. Read by PAN voice layer, Forge/AutoDev, and Atlas.',
    modelTier: 'reasoning',
    modelMinSize: '8B',
    modelCurrent: 'cerebras:qwen-3-235b',
    port: null,
    healthCheck: 'interval',
    bootOrder: 5,
    dependsOn: [],
    interval: '60s',
    intervalMs: 60 * 1000,
    startFn: () => startIntuition(60 * 1000, () => reportServiceRun('intuition')),
    stopFn: () => stopIntuition(),
    _status: 'stopped',
    _lastCheck: null,
    _lastError: null,
    _lastRun: null,
  },
  {
    id: 'stack-scanner',
    name: 'Cartographer',
    technicalName: 'Stack Scanner',
    description: 'Tech stack discovery from project files (package.json, Cargo.toml, etc.)',
    modelTier: 'none',
    modelMinSize: 'N/A',
    modelCurrent: 'code analysis only · no model',
    port: null,
    healthCheck: 'interval',
    bootOrder: 6,
    dependsOn: [],
    interval: '6h',
    intervalMs: 6 * 60 * 60 * 1000,
    startFn: () => startStackScanner(6 * 60 * 60 * 1000),
    stopFn: () => stopStackScanner(),
    _status: 'stopped',
    _lastCheck: null,
    _lastError: null,
    _lastRun: null,
  },
  {
    id: 'dream',
    name: 'Dream Cycle',
    description: 'Consolidates events into living state document (.pan-state.md)',
    modelTier: 'reasoning',
    modelMinSize: '30B+',
    modelCurrent: 'cerebras:qwen-3-235b',
    port: null,
    healthCheck: 'interval',
    bootOrder: 7,
    dependsOn: ['embeddings', 'classifier'],
    interval: '6h',
    intervalMs: 6 * 60 * 60 * 1000,
    startFn: () => startDream(6 * 60 * 60 * 1000),
    stopFn: () => stopDream(),
    toggle: 'dream',
    _status: 'stopped',
    _lastCheck: null,
    _lastError: null,
    _lastRun: null,
  },
  {
    id: 'consolidation',
    name: 'Archivist',
    technicalName: 'Memory Consolidation',
    description: 'Extracts episodes, facts, procedures from events into vector memory',
    modelTier: 'reasoning',
    modelMinSize: '30B+',
    modelCurrent: 'cerebras:qwen-3-235b',
    port: null,
    healthCheck: 'interval',
    bootOrder: 8,
    dependsOn: ['embeddings', 'dream'],
    interval: '12h',
    intervalMs: 12 * 60 * 60 * 1000,
    startFn: () => {
      // Run consolidation on a 12h timer (also triggered by dream cycle)
      const run = () => consolidateMemory({ useLLM: true })
        .then(() => reportServiceRun('consolidation'))
        .catch(err => reportServiceRun('consolidation', err.message));
      setTimeout(run, 5 * 60 * 1000); // first run after 5 min
      services.find(s => s.id === 'consolidation')._timer = setInterval(run, 12 * 60 * 60 * 1000);
    },
    stopFn: () => {
      const svc = services.find(s => s.id === 'consolidation');
      if (svc._timer) { clearInterval(svc._timer); svc._timer = null; }
    },
    _status: 'unknown',
    _lastCheck: null,
    _lastError: null,
    _lastRun: null,
  },
  {
    id: 'scout',
    name: 'Scout',
    description: 'Tool discovery — GitHub trending, MCP servers, AI agents, CLI tools',
    modelTier: 'reasoning',
    modelMinSize: '8B',
    modelCurrent: 'cerebras:qwen-3-235b',
    port: null,
    healthCheck: 'interval',
    bootOrder: 9,
    dependsOn: [],
    interval: '12h',
    intervalMs: 12 * 60 * 60 * 1000,
    startFn: () => startScout(12 * 60 * 60 * 1000),
    stopFn: () => stopScout(),
    toggle: 'scout',
    _status: 'stopped',
    _lastCheck: null,
    _lastError: null,
    _lastRun: null,
  },
  {
    id: 'orchestrator',
    name: 'Orchestrator',
    description: 'Autonomous agent — processes findings, generates tasks, identifies gaps',
    modelTier: 'reasoning',
    modelMinSize: '30B+',
    modelCurrent: 'cerebras:qwen-3-235b',
    port: null,
    healthCheck: 'interval',
    bootOrder: 10,
    dependsOn: ['dream', 'scout'],
    interval: '4h',
    intervalMs: 4 * 60 * 60 * 1000,
    startFn: () => startOrchestrator(4 * 60 * 60 * 1000),
    stopFn: () => stopOrchestrator(),
    toggle: 'orchestrator',
    _status: 'stopped',
    _lastCheck: null,
    _lastError: null,
    _lastRun: null,
  },
  {
    id: 'evolution',
    name: 'Evolution Engine',
    description: 'Self-improvement — observes behavior, critiques, generates config changes',
    modelTier: 'reasoning',
    modelMinSize: '70B+',
    modelCurrent: 'cerebras:qwen-3-235b',
    port: null,
    healthCheck: 'interval',
    bootOrder: 11,
    dependsOn: ['dream', 'consolidation'],
    interval: '6h',
    intervalMs: 6 * 60 * 60 * 1000,
    startFn: () => {
      // Run evolution on a 6h timer (also triggered after dream)
      const run = () => runEvolution()
        .then(() => reportServiceRun('evolution'))
        .catch(err => reportServiceRun('evolution', err.message));
      setTimeout(run, 10 * 60 * 1000); // first run after 10 min
      services.find(s => s.id === 'evolution')._timer = setInterval(run, 6 * 60 * 60 * 1000);
    },
    stopFn: () => {
      const svc = services.find(s => s.id === 'evolution');
      if (svc._timer) { clearInterval(svc._timer); svc._timer = null; }
    },
    toggle: 'evolution',
    _status: 'stopped',
    _lastCheck: null,
    _lastError: null,
    _lastRun: null,
  },
  {
    id: 'autodev',
    name: 'Forge',
    technicalName: 'AutoDev',
    description: 'Automated development — spawns headless Claude sessions for tasks',
    modelTier: 'interactive',
    modelMinSize: '70B+',
    modelCurrent: 'Claude Haiku (CLI)',
    port: null,
    healthCheck: 'interval',
    bootOrder: 12,
    dependsOn: ['orchestrator'],
    interval: '1h',
    intervalMs: 60 * 60 * 1000,
    startFn: () => startAutoDev(60 * 60 * 1000),
    stopFn: () => stopAutoDev(),
    toggle: 'autodev',
    defaultEnabled: false,
    _status: 'stopped',
    _lastCheck: null,
    _lastError: null,
    _lastRun: null,
  },
  {
    id: 'tailscale',
    name: 'Tether',
    technicalName: 'Tailscale',
    description: 'VPN mesh for remote access (phone, laptop, server)',
    modelTier: 'none',
    modelMinSize: 'N/A',
    modelCurrent: 'N/A',
    port: null,
    healthCheck: 'process',
    processName: 'tailscaled.exe',
    bootOrder: 0, // system service, boots before PAN
    dependsOn: [],
    interval: null,
    startFn: null,
    stopFn: null,
    _status: 'unknown',
    _lastCheck: null,
    _lastError: null,
    _lastRun: null,
  },
  {
    id: 'pan-server',
    name: 'Core',
    technicalName: 'PAN Server',
    description: 'Core server — API, dashboard, hooks, terminal, database',
    modelTier: 'none',
    modelMinSize: 'N/A',
    modelCurrent: 'N/A',
    port: 7777,
    healthCheck: 'self', // we ARE this process
    bootOrder: 0,
    dependsOn: [],
    interval: null,
    startFn: null,
    stopFn: null,
    _status: 'running', // always running if steward is running
    _lastCheck: null,
    _lastError: null,
    _lastRun: null,
  },
];

// Index by ID for fast lookup
const serviceMap = new Map(services.map(s => [s.id, s]));

// ==================== HEALTH CHECKS ====================

async function checkPortHealth(port, path = '/') {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ up: res.statusCode < 500, data }));
    });
    req.on('error', () => resolve({ up: false }));
    req.on('timeout', () => { req.destroy(); resolve({ up: false }); });
  });
}

async function checkProcessRunning(processName, cmdLineMatch) {
  try {
    const { exec } = await import('child_process');
    return new Promise((resolve) => {
      // If a cmdLineMatch is given, use PowerShell to verify the process is
      // running THE EXPECTED script — not just any instance of the binary.
      // This stops Steward from being fooled by a stale AHK process running
      // an old/manually-launched script.
      if (cmdLineMatch) {
        const escaped = cmdLineMatch.replace(/'/g, "''");
        const ps = `Get-CimInstance Win32_Process -Filter "Name = '${processName}'" | Where-Object { $_.CommandLine -like '*${escaped}*' } | Select-Object -First 1 -ExpandProperty ProcessId`;
        exec(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8', timeout: 5000, windowsHide: true }, (err, stdout) => {
          if (err) return resolve(false);
          resolve(/\d+/.test(stdout.trim()));
        });
        return;
      }
      exec(`tasklist /FI "IMAGENAME eq ${processName}" /NH`, { encoding: 'utf8', timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(false);
        resolve(stdout.includes(processName));
      });
    });
  } catch {
    return false;
  }
}

async function checkServiceHealth(svc) {
  const now = Date.now();
  try {
    switch (svc.healthCheck) {
      case 'port': {
        const result = await checkPortHealth(svc.port, svc.healthEndpoint || '/');
        svc._status = result.up ? 'running' : 'down';
        break;
      }
      case 'url': {
        // Health check against a full URL — supports remote hosts (e.g. Ollama on mini PC)
        try {
          const url = getOllamaUrl() + (svc.healthEndpoint || '/');
          const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
          if (res.ok) {
            const data = await res.json().catch(() => ({}));
            const models = data.models || [];
            svc._status = 'running';
            svc._modelCount = models.length;
            svc._models = models.map(m => m.name);
            // Warn loudly if Ollama is up but has no models (e.g. upgrade wiped them)
            if (models.length === 0 && svc._lastModelCount > 0) {
              console.warn('[Steward] ⚠️ Ollama models WIPED — was ' + svc._lastModelCount + ', now 0. Client watchdog should pull minicpm-v.');
            }
            svc._lastModelCount = models.length;
          } else {
            svc._status = 'down';
          }
        } catch {
          svc._status = 'down';
        }
        break;
      }
      case 'process': {
        const running = await checkProcessRunning(svc.processName, svc.processCmdLineMatch);
        svc._status = running ? 'running' : 'down';
        break;
      }
      case 'interval': {
        if (svc._status === 'stopped' || svc._status === 'unknown') {
          // Never started or explicitly stopped — leave as-is
          break;
        }
        // Service was started — verify it's still alive by checking _lastRun
        if (svc._lastRun && svc.intervalMs) {
          const elapsed = now - svc._lastRun;
          // If 3x the interval has passed without a reportServiceRun call, it's dead
          const overdueThreshold = svc.intervalMs * 3;
          if (elapsed > overdueThreshold) {
            svc._status = 'down';
            svc._lastError = `Overdue: last run ${Math.round(elapsed / 60000)}m ago (expected every ${Math.round(svc.intervalMs / 60000)}m)`;
          }
        }
        break;
      }
      case 'self': {
        svc._status = 'running';
        break;
      }
      case 'function': {
        // Embeddings — check if Ollama is responding to embedding requests
        const ollamaSvc = serviceMap.get('ollama');
        svc._status = ollamaSvc?._status === 'running' ? 'running' : 'degraded';
        break;
      }
      default:
        svc._status = 'unknown';
    }
  } catch (err) {
    svc._status = 'error';
    svc._lastError = err.message;
  }
  svc._lastCheck = now;
}

// ==================== BOOT SEQUENCE ====================

let _healthInterval = null;
let _toggles = {};

function loadToggles() {
  try {
    const row = get("SELECT value FROM settings WHERE key = 'feature_toggles'");
    if (row) _toggles = JSON.parse(row.value);
  } catch {}
  return _toggles;
}

function isServiceEnabled(svc) {
  // Skip user-session-only services when running in service/Session 0 mode.
  // These need a desktop, console, or input simulation to function.
  if (svc.userOnly && IS_SERVICE_MODE) return false;
  if (!svc.toggle) return true; // no toggle = always enabled
  if (svc.defaultEnabled === false) return _toggles[svc.toggle] === true;
  return _toggles[svc.toggle] !== false;
}

async function bootAll() {
  console.log('[Steward] Starting boot sequence...');
  loadToggles();

  // Sort by boot order
  const bootable = services
    .filter(s => s.startFn && isServiceEnabled(s))
    .sort((a, b) => a.bootOrder - b.bootOrder);

  // Check external services first (ollama, whisper, ahk, tailscale).
  // userOnly services are skipped in service mode (no desktop to talk to).
  const externals = services.filter(s => !s.startFn && s.healthCheck !== 'self' && !(s.userOnly && IS_SERVICE_MODE));
  for (const svc of externals) {
    await checkServiceHealth(svc);
    const icon = svc._status === 'running' ? '✓' : svc._status === 'down' ? '✗' : '?';
    console.log(`[Steward] ${icon} ${svc.name}: ${svc._status}`);
  }
  if (IS_SERVICE_MODE) {
    console.log('[Steward] Service mode — userOnly services skipped (AHK, etc.)');
  }

  // Boot internal services in order
  for (const svc of bootable) {
    try {
      console.log(`[Steward] Starting ${svc.name} (${svc.interval}, model: ${svc.modelTier === 'none' ? 'none' : svc.modelCurrent})...`);
      svc.startFn();
      svc._status = 'running';
      svc._lastRun = Date.now();
    } catch (err) {
      svc._status = 'error';
      svc._lastError = err.message;
      console.error(`[Steward] ✗ ${svc.name} failed to start: ${err.message}`);
    }
  }

  // Start health monitoring (every 60 seconds)
  _healthInterval = setInterval(healthCheck, 60 * 1000);

  // Run initial health check
  await healthCheck();

  const running = services.filter(s => s._status === 'running').length;
  console.log(`[Steward] Boot complete: ${running}/${services.length} services up`);
}

async function shutdownAll() {
  console.log('[Steward] Shutting down all services...');
  if (_healthInterval) {
    clearInterval(_healthInterval);
    _healthInterval = null;
  }

  // Shutdown in reverse boot order
  const stoppable = services
    .filter(s => s.stopFn && s._status === 'running')
    .sort((a, b) => b.bootOrder - a.bootOrder);

  for (const svc of stoppable) {
    try {
      console.log(`[Steward] Stopping ${svc.name}...`);
      svc.stopFn();
      svc._status = 'stopped';
    } catch (err) {
      console.error(`[Steward] Error stopping ${svc.name}: ${err.message}`);
    }
  }
  console.log('[Steward] All services stopped.');
}

// ==================== HEALTH MONITORING ====================

function logServiceEvent(serviceId, action, details = {}) {
  try {
    insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`, {
      ':sid': 'steward',
      ':type': 'StewardAction',
      ':data': JSON.stringify({
        service: serviceId,
        action,
        ...details,
        timestamp: Date.now(),
      })
    });
  } catch {}
}

async function healthCheck() {
  for (const svc of services) {
    // Skip userOnly services entirely in service/Session 0 mode — checking
    // them just produces "down" + auto-restart loops that can never succeed.
    if (svc.userOnly && IS_SERVICE_MODE) continue;
    const prevStatus = svc._status;
    await checkServiceHealth(svc);

    // Detect status transitions and log them
    if (prevStatus !== svc._status && prevStatus !== 'unknown') {
      logServiceEvent(svc.id, 'status_change', {
        from: prevStatus,
        to: svc._status,
        error: svc._lastError,
      });
      try { broadcastNotification('widget_update', { widget: 'services' }); } catch {}
    }

    // Auto-restart services that have a startFn and are down — with backoff.
    // If a service keeps flapping (down → restart → down) we exponentially
    // delay further restarts so we don't burn CPU + spawn processes once a
    // minute forever (the AHK / Voice.ahk loop that crashed PAN on 2026-04-08).
    // #438: if a restart was just attempted, give it one health check cycle grace period
    // before treating it as 'down' again — prevents false failure increments.
    if (svc._restartPending) {
      svc._restartPending = false; // consumed — next cycle will evaluate normally
      continue;
    }
    if (svc._status === 'down' && svc.startFn && isServiceEnabled(svc)) {
      const now = Date.now();
      svc._restartFailures = svc._restartFailures || 0;
      svc._restartCooldownUntil = svc._restartCooldownUntil || 0;
      if (now < svc._restartCooldownUntil) {
        // still cooling down — skip silently
      } else if (svc._restartFailures >= 5) {
        // Give up after 5 failed restart cycles. Log once, then stay quiet.
        if (!svc._restartGaveUp) {
          console.error(`[Steward] ${svc.name} failed ${svc._restartFailures} restart cycles — giving up. Manual restart required.`);
          logServiceEvent(svc.id, 'restart_giveup', { failures: svc._restartFailures });
          createAlert({
            alert_type: 'service_crash',
            severity: 'critical',
            title: `${svc.name} failed ${svc._restartFailures} restart cycles — gave up`,
            detail: JSON.stringify({
              service: svc.id,
              name: svc.name,
              failures: svc._restartFailures,
              lastError: svc._lastError,
              hint: 'Manual restart required. Check logs for root cause.'
            })
          });
          svc._restartGaveUp = true;
        }
      } else {
        try {
          console.log(`[Steward] Auto-restarting ${svc.name}... (attempt ${svc._restartFailures + 1})`);
          svc.startFn();
          // #438: do NOT set _status = 'running' here — let the next health check confirm it.
          // Setting it immediately caused the health check to find it "still starting",
          // flip it back to 'down', and increment _restartFailures even on a good restart.
          svc._restartPending = true; // #438: grace flag — skip one 'down' detection cycle
          svc._lastRun = Date.now();
          logServiceEvent(svc.id, 'restart', { success: true });
          // Exponential backoff: 1m, 2m, 4m, 8m, 16m. Reset on a successful
          // health check (handled below in checkServiceHealth path).
          // #438: only increment failure counter in the catch block (startFn threw)
          svc._restartCooldownUntil = now + Math.min(60_000 * Math.pow(2, svc._restartFailures), 16 * 60_000);
        } catch (err) {
          svc._lastError = err.message;
          console.error(`[Steward] Failed to restart ${svc.name}: ${err.message}`);
          logServiceEvent(svc.id, 'restart', { success: false, error: err.message });
          svc._restartFailures += 1; // #438: only increment when startFn() actually threw
          svc._restartCooldownUntil = now + Math.min(60_000 * Math.pow(2, svc._restartFailures - 1), 16 * 60_000);
        }
      }
    } else if (svc._status === 'running' && svc._restartFailures) {
      // Service recovered — reset backoff counters.
      svc._restartFailures = 0;
      svc._restartCooldownUntil = 0;
      svc._restartGaveUp = false;
    }
  }

  // Clean zombie PTY sessions (connected but no activity for 2 hours)
  await cleanZombieSessions();

  // Detect orphaned AI CLI processes (parent PTY gone, still alive).
  // ALERT ONLY — never kills. User investigates and handles manually.
  await detectOrphanAiProcesses();

  // DISABLED — ensureAiInSessions() ancestor walk was broken,
  // terminal.js already auto-launches AI on new PTY sessions.
  // ensureAiInSessions();

  // ── Memory watchdog ──────────────────────────────────────────────
  // Alert when Node heap grows past threshold (likely leak).
  const MEMORY_WARN_MB = 300;
  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / 1048576);
  const heapMb = Math.round(mem.heapUsed / 1048576);
  if (rssMb > MEMORY_WARN_MB) {
    const existing = get("SELECT id FROM alerts WHERE alert_type = 'memory_high' AND status IN ('open', 'acknowledged') LIMIT 1");
    if (!existing) {
      console.warn(`[Steward] ⚠ Memory high: RSS=${rssMb}MB heap=${heapMb}MB (threshold ${MEMORY_WARN_MB}MB)`);
      createAlert({
        alert_type: 'memory_high',
        severity: 'warning',
        title: `PAN memory high: ${rssMb}MB RSS`,
        detail: `RSS=${rssMb}MB, heap=${heapMb}MB, uptime=${Math.round(process.uptime())}s. Possible memory leak — consider restarting.`,
      });
    }
  }

  // ── Remote Ollama watchdog ────────────────────────────────────────────────
  // When a remote device reports Ollama as down for 2+ consecutive heartbeats,
  // send a restart_service command to that device.
  await checkRemoteOllama();

  // Log a heartbeat event
  try {
    const summary = services.map(s => `${s.id}:${s._status}`).join(',');
    insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`, {
      ':sid': 'steward',
      ':type': 'StewardHeartbeat',
      ':data': JSON.stringify({
        timestamp: Date.now(),
        services: services.map(s => ({
          id: s.id, status: s._status, lastCheck: s._lastCheck, lastError: s._lastError,
          modelCurrent: (s.modelTier === 'reasoning' ? getConfiguredModel(s.id) : null) || s.modelCurrent,
          modelTier: s.modelTier,
        })),
        summary
      })
    });
  } catch {}
}

// ── Remote Ollama watchdog helpers ──────────────────────────────────────────
// Per-device consecutive "ollama down" counter.
// Resets to 0 when Ollama is seen as up for that device.
const _remoteOllamaDownCounts = new Map(); // deviceId → count
// Per-device last-restart timestamp to avoid re-spamming.
const _remoteOllamaLastRestart = new Map(); // deviceId → timestamp
const REMOTE_OLLAMA_RESTART_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const REMOTE_OLLAMA_DOWN_THRESHOLD = 2; // consecutive heartbeats before acting

async function checkRemoteOllama() {
  try {
    const clients = getConnectedClients();
    for (const client of clients) {
      if (!client.trusted) continue;
      const deviceId = client.device_id;
      const services = client.reported_services;
      if (!Array.isArray(services)) continue;

      const ollamaSvc = services.find(s => s.name === 'ollama');
      if (!ollamaSvc) continue;

      if (ollamaSvc.status === 'up' || ollamaSvc.status === 'running') {
        // Recovered — reset counter
        if (_remoteOllamaDownCounts.get(deviceId)) {
          console.log(`[Steward] Remote Ollama recovered on ${deviceId}`);
        }
        _remoteOllamaDownCounts.set(deviceId, 0);
        continue;
      }

      if (ollamaSvc.status === 'down') {
        const count = (_remoteOllamaDownCounts.get(deviceId) || 0) + 1;
        _remoteOllamaDownCounts.set(deviceId, count);
        console.log(`[Steward] Remote Ollama down on ${deviceId} (${count} consecutive)`);

        if (count >= REMOTE_OLLAMA_DOWN_THRESHOLD) {
          const now = Date.now();
          const lastRestart = _remoteOllamaLastRestart.get(deviceId) || 0;
          if (now - lastRestart < REMOTE_OLLAMA_RESTART_COOLDOWN_MS) continue;

          console.log(`[Steward] Sending restart_service(ollama) to ${deviceId}`);
          _remoteOllamaLastRestart.set(deviceId, now);
          // Reset count so we don't spam on the next cycle
          _remoteOllamaDownCounts.set(deviceId, 0);

          sendToClient(deviceId, 'restart_service', { service: 'ollama' }, 60_000)
            .then(result => {
              console.log(`[Steward] restart_service(ollama) result from ${deviceId}:`, result?.status || 'ok');
              logServiceEvent('remote-ollama-watchdog', 'restart_sent', { deviceId, result });
            })
            .catch(err => {
              console.error(`[Steward] restart_service(ollama) failed for ${deviceId}: ${err.message}`);
              logServiceEvent('remote-ollama-watchdog', 'restart_failed', { deviceId, error: err.message });
            });
        }
      }
    }
  } catch (err) {
    console.error(`[Steward] checkRemoteOllama error: ${err.message}`);
  }
}

async function cleanZombieSessions() {
  try {
    const sessions = await listSessions();
    const now = Date.now();
    for (const s of sessions) {
      const lastOut = s.lastOutputTs || 0;
      const idleMs = lastOut ? now - lastOut : 0;

      // Stuck-thinking: Claude running, no connected clients, no output for 20min → Ctrl+C
      if (s.clients === 0 && s.thinking && s.claudeRunning && idleMs > 20 * 60 * 1000) {
        console.log(`[Steward] ⚡ Stuck-thinking session ${s.id} (no clients, silent ${Math.round(idleMs / 60000)}min) — interrupting`);
        try { sendToSession(s.id, '\x03'); } catch {}
        continue;
      }

      // Dead zombie: no clients, no output for 2 hours → send exit
      if (s.clients === 0 && lastOut && idleMs > 2 * 60 * 60 * 1000) {
        console.log(`[Steward] 🧹 Zombie session ${s.id} (no clients, idle ${Math.round(idleMs / 60000)}min) — sending exit`);
        try { sendToSession(s.id, 'exit\r'); } catch {}
      }
    }
  } catch {}
}

// Detect AI CLI (cli.js or gemini) processes whose ancestor chain does NOT include
// any of our tracked PTY pids and is older than 30 minutes.
// ALERT ONLY — never kill. User investigates orphans manually.
async function detectOrphanAiProcesses() {
  if (process.platform !== 'win32') return;
  try {
    const sessions = await listSessions();
    const ourPtyPids = new Set(sessions.map(s => s.pid).filter(Boolean));
    ourPtyPids.add(process.pid);
    if (process.ppid) ourPtyPids.add(process.ppid);

    // Search for both Claude Code and Gemini patterns
    const ps = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate, @{N='Cmd';E={$_.CommandLine}}
$ai = $all | Where-Object { $_.Cmd -like '*@anthropic-ai/claude-code/cli.js*' -or $_.Cmd -like '*gemini*' }
$map = @{}; $all | ForEach-Object { $map[[string]$_.ProcessId] = $_.ParentProcessId }
$result = @{ ai = $ai; pidmap = $map }
$result | ConvertTo-Json -Compress -Depth 3`;
    const tmpDir = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
    const psFile = join(tmpDir, 'pan-detect-orphans.ps1');
    writeFileSync(psFile, ps);
    const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, { encoding: 'utf-8', timeout: 15000, windowsHide: true }).trim();
    if (!out) return;
    const parsed = JSON.parse(out);
    const aiProcs = parsed.ai ? (Array.isArray(parsed.ai) ? parsed.ai : [parsed.ai]) : [];
    if (!aiProcs.length) return;

    const pidMap = new Map();
    if (parsed.pidmap) {
      for (const [k, v] of Object.entries(parsed.pidmap)) {
        pidMap.set(parseInt(k, 10), parseInt(v, 10) || 0);
      }
    }

    // Check process registry for known PIDs
    const registryPids = new Set();
    try {
      const registry = await getProcessRegistry();
      for (const entry of registry) {
        if (entry.alive) registryPids.add(entry.pid);
      }
    } catch {}

    // Walk UP from pid through living ancestors
    function hasTrackedAncestor(pid) {
      let current = pid;
      for (let i = 0; i < 12; i++) {
        const parent = pidMap.get(current);
        if (!parent || parent === current) break;
        if (ourPtyPids.has(parent)) return true;
        current = parent;
      }
      return false;
    }

    const now = Date.now();
    const MIN_AGE_MS = 30 * 60 * 1000;
    const orphans = [];

    for (const p of aiProcs) {
      const pid = p.ProcessId;
      const ppid = p.ParentProcessId;
      const m = /\((\d+)\)/.exec(p.CreationDate || '');
      const startedAt = m ? parseInt(m[1], 10) : 0;
      const ageMs = startedAt ? (now - startedAt) : 0;

      if (registryPids.has(pid)) continue;
      if (ourPtyPids.has(ppid)) continue;
      if (hasTrackedAncestor(pid)) continue;
      if (ageMs < MIN_AGE_MS) continue;

      orphans.push({ pid, ppid, ageMin: Math.round(ageMs / 60000), cmd: (p.Cmd || '').slice(0, 100) });
    }

    if (orphans.length > 0) {
      const KILL_AGE_MIN = 60; // Auto-kill orphans older than 60 minutes
      const toKill = orphans.filter(o => o.ageMin >= KILL_AGE_MIN);
      const toWarn = orphans.filter(o => o.ageMin < KILL_AGE_MIN);

      // Auto-kill old orphans — these are confirmed leaks
      for (const o of toKill) {
        try {
          execSync(`taskkill /F /PID ${o.pid}`, { windowsHide: true, timeout: 5000 });
          console.log(`[Steward] ☠ Killed orphan pid=${o.pid} (${o.ageMin}min old): ${o.cmd}`);
        } catch (killErr) {
          console.warn(`[Steward] Failed to kill orphan pid=${o.pid}: ${killErr.message}`);
        }
      }

      const summary = orphans.map(o => `pid=${o.pid} (${o.ageMin}min)`).join(', ');
      console.log(`[Steward] Detected ${orphans.length} orphan(s): ${summary} — killed ${toKill.length}, warned ${toWarn.length}`);
      logServiceEvent('orphan-detection', 'orphans_reaped', { count: orphans.length, killed: toKill.length, warned: toWarn.length, orphans });

      const existingOpen = get("SELECT id FROM alerts WHERE alert_type = 'orphan_processes' AND status IN ('open', 'acknowledged') LIMIT 1");
      if (!existingOpen) {
        createAlert({
          alert_type: 'orphan_processes',
          severity: toKill.length > 0 ? 'critical' : 'warning',
          title: `${orphans.length} orphan AI process(es) — ${toKill.length} killed, ${toWarn.length} warned`,
          detail: JSON.stringify({
            orphans,
            killed: toKill.map(o => o.pid),
            tracked_pty_pids: [...ourPtyPids],
            detected_at: new Date().toISOString(),
          })
        });
      }

      for (const s of sessions) {
        broadcastToSession(s.id, 'system_message', {
          text: `☠ ${orphans.length} orphan AI process(es): ${summary}. Killed ${toKill.length}.`,
          level: toKill.length > 0 ? 'error' : 'warning'
        });
      }
    }
  } catch (err) {
    console.error(`[Steward] detectOrphanAiProcesses error: ${err.message}`);
  }
}

// Check if active terminal sessions have a live Claude process. If not,
// relaunch claude in the PTY. This catches cases where Claude exits
// (crash, user Ctrl+C, orphan cleanup kill) but the bash session stays alive.
async function ensureClaudeInSessions() {
  if (process.platform !== 'win32') return;
  try {
    // Get all Claude CLI pids AND full process tree for ancestor walking
    const ps = `$claude = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop | Where-Object { $_.CommandLine -like '*@anthropic-ai/claude-code/cli.js*' } | Select-Object ProcessId, ParentProcessId
$all = Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId
$map = @{}; $all | ForEach-Object { $map[[string]$_.ProcessId] = $_.ParentProcessId }
@{ claude = $claude; pidmap = $map } | ConvertTo-Json -Compress -Depth 3`;
    const tmpDir = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
    const psFile = join(tmpDir, 'pan-check-claude.ps1');
    writeFileSync(psFile, ps);
    const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, { encoding: 'utf-8', timeout: 10000, windowsHide: true }).trim();

    if (!out) return; // Can't enumerate — don't blindly relaunch

    const parsed = JSON.parse(out);
    const claudeProcs = parsed.claude ? (Array.isArray(parsed.claude) ? parsed.claude : [parsed.claude]) : [];

    // Build pid→ppid map for ancestor walking
    const pidMap = new Map();
    if (parsed.pidmap) {
      for (const [k, v] of Object.entries(parsed.pidmap)) {
        pidMap.set(parseInt(k, 10), parseInt(v, 10) || 0);
      }
    }

    // Walk up to 12 ancestors from a Claude process to see if ptyPid is in its chain
    function hasAncestor(pid, target) {
      let cur = pid;
      for (let i = 0; i < 12; i++) {
        const parent = pidMap.get(cur);
        if (!parent || parent === cur) return false;
        if (parent === target) return true;
        cur = parent;
      }
      return false;
    }

    // For each active session, check if its PTY pid is an ancestor of any Claude process
    const activeSessions = await listSessions();
    for (const s of activeSessions) {
      if (!s.pid) continue;

      // Walk full ancestor chain — handles conpty → bash → node (claude)
      const hasClaudeDescendant = claudeProcs.some(p =>
        p.ParentProcessId === s.pid || hasAncestor(p.ProcessId, s.pid)
      );
      if (hasClaudeDescendant) continue; // Claude is running in this session

      // No Claude found — check if we recently sent a relaunch (debounce 5 min)
      const lastRelaunch = _claudeRelaunchTimes.get(s.id) || 0;
      if (Date.now() - lastRelaunch < 300_000) continue;

      console.log(`[Steward] No Claude process in session ${s.id} (pty=${s.pid}) — relaunching`);
      try {
        sendToSession(s.id, 'claude\r');
        _claudeRelaunchTimes.set(s.id, Date.now());
        logServiceEvent('claude-relaunch', 'auto_relaunch', { session: s.id, pty_pid: s.pid });
      } catch (err) {
        console.error(`[Steward] Failed to relaunch claude in ${s.id}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[Steward] ensureClaudeInSessions error: ${err.message}`);
  }
}
const _claudeRelaunchTimes = new Map();

// ==================== ATLAS DATA ====================
// Returns the full service registry with live status for Atlas rendering

// Read the actual model configured for a service from DB settings
function getConfiguredModel(serviceId) {
  try {
    const row = get("SELECT value FROM settings WHERE key = 'job_models'");
    if (row) {
      const jobModels = JSON.parse(row.value);
      if (jobModels[serviceId]) return jobModels[serviceId];
    }
    // Fall back to the global default model
    const defaultRow = get("SELECT value FROM settings WHERE key = 'ai_model'");
    if (defaultRow) return defaultRow.value.replace(/^"|"$/g, '');
  } catch {}
  return null;
}

function getAtlasData() {
  return {
    modelTiers: MODEL_TIERS,
    services: services.map(svc => ({
      id: svc.id,
      name: svc.name,
      technicalName: svc.technicalName || svc.name,
      description: svc.description,
      // Model requirements — what Atlas shows as badges
      modelTier: svc.modelTier,
      modelTierLabel: MODEL_TIERS[svc.modelTier]?.label || svc.modelTier,
      modelTierColor: MODEL_TIERS[svc.modelTier]?.color || '#6c7086',
      modelMinSize: svc.modelMinSize,
      modelCurrent: (svc.modelTier === 'reasoning' ? getConfiguredModel(svc.id) : null) || svc.modelCurrent,
      // Runtime state
      status: svc._status,
      lastCheck: svc._lastCheck,
      lastError: svc._lastError,
      lastRun: svc._lastRun,
      // Configuration
      port: svc.port,
      healthCheck: svc.healthCheck,
      processName: svc.processName || null,
      processCmdLineMatch: svc.processCmdLineMatch || null,
      interval: svc.interval,
      bootOrder: svc.bootOrder,
      dependsOn: svc.dependsOn,
      enabled: isServiceEnabled(svc),
      hasToggle: !!svc.toggle,
      toggleKey: svc.toggle || null,
    })),
    // Summary stats
    summary: {
      total: services.length,
      running: services.filter(s => s._status === 'running').length,
      stopped: services.filter(s => s._status === 'stopped').length,
      down: services.filter(s => s._status === 'down').length,
      error: services.filter(s => s._status === 'error').length,
      unknown: services.filter(s => s._status === 'unknown').length,
    },
    timestamp: Date.now(),
  };
}

// Get a single service's status
function getServiceStatus(serviceId) {
  return serviceMap.get(serviceId) || null;
}

// Update a service's last run time (called by individual services)
function reportServiceRun(serviceId, error = null) {
  const svc = serviceMap.get(serviceId);
  if (svc) {
    svc._lastRun = Date.now();
    if (error) {
      svc._lastError = error;
      svc._status = 'error';
    } else {
      svc._lastError = null;
      svc._status = 'running';
    }
  }
}

// ==================== APP CAPABILITY SCANNER ====================
// Detects which apps are installed on this PC and updates the devices table.
// Runs once at startup (after 10s) and every 24h thereafter.

const APP_CHECKS = [
  { name: 'vlc',     paths: ['C:/Program Files/VideoLAN/VLC/vlc.exe', 'C:/Program Files (x86)/VideoLAN/VLC/vlc.exe'] },
  { name: 'chrome',  paths: ['C:/Program Files/Google/Chrome/Application/chrome.exe'] },
  { name: 'firefox', paths: ['C:/Program Files/Mozilla Firefox/firefox.exe'] },
  { name: 'spotify', paths: [`${process.env.APPDATA}/Spotify/Spotify.exe`] },
  { name: 'mpv',     paths: ['C:/Program Files/mpv/mpv.exe', 'C:/tools/mpv/mpv.exe'] },
  { name: 'discord', paths: [`${process.env.LOCALAPPDATA}/Discord/Update.exe`] },
  { name: 'obs',     paths: ['C:/Program Files/obs-studio/bin/64bit/obs64.exe'] },
  { name: 'steam',   paths: ['C:/Program Files (x86)/Steam/steam.exe'] },
  { name: 'code',    paths: [`${process.env.LOCALAPPDATA}/Programs/Microsoft VS Code/Code.exe`] },
];

async function scanInstalledApps() {
  try {
    const host = hostname();
    const detectedApps = APP_CHECKS.filter(app => app.paths.some(p => existsSync(p))).map(a => a.name);

    const device = get(`SELECT capabilities FROM devices WHERE hostname = :h`, { ':h': host });
    const existing = JSON.parse(device?.capabilities || '[]');
    const apps = detectedApps.map(a => `app:${a}`);
    const merged = [...new Set([...existing, ...apps])];

    run(`UPDATE devices SET capabilities = :c WHERE hostname = :h`, {
      ':c': JSON.stringify(merged),
      ':h': host,
    });

    console.log(`[Steward] App scan complete: ${detectedApps.length} apps detected (${detectedApps.join(', ') || 'none'})`);
  } catch (err) {
    console.error(`[Steward] App scan failed: ${err.message}`);
  }
}

// Schedule: first run 10s after boot, then every 24h
setTimeout(() => {
  scanInstalledApps();
  setInterval(scanInstalledApps, 24 * 60 * 60 * 1000);
}, 10 * 1000);

// ==================== ATLAS SUMMARY ====================
// Returns a compact plain-text snapshot of the entire PAN system.
// Used by Scout to update MEMORY.md and by the /api/v1/atlas/summary endpoint.

async function getAtlasSummary() {
  const lines = [];
  const q = (fn) => { try { return fn(); } catch { return null; } };

  // Version
  let version = '?';
  try {
    const { readFileSync } = await import('fs');
    const { join: pjoin, dirname: pdirname } = await import('path');
    const { fileURLToPath: pfu } = await import('url');
    const pkgPath = pjoin(pdirname(pfu(import.meta.url)), '../../package.json');
    version = JSON.parse(readFileSync(pkgPath, 'utf8')).version || '?';
  } catch {}

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);

  // Services summary
  const running = services.filter(s => s._status === 'running').length;
  const down = services.filter(s => ['stopped', 'down', 'error'].includes(s._status));
  const downNames = down.map(s => s.id);
  const svcLine = down.length
    ? `${running} services up, ${down.length} down: ${downNames.join(',')}`
    : `${running} services up`;

  lines.push(`PAN ${version} | ${dateStr} | ${svcLine}`);

  // AI settings
  const aiModel  = q(() => get(`SELECT value FROM settings WHERE key='ai_model'`)?.value)   || '?';
  const cerebras = q(() => get(`SELECT value FROM settings WHERE key='cerebras_api_key'`)?.value);
  const groq     = q(() => get(`SELECT value FROM settings WHERE key='groq_api_key'`)?.value);
  const ollamaUrl = q(() => get(`SELECT value FROM settings WHERE key='ollama_url'`)?.value) || 'NONE';
  lines.push(`AI       default=${aiModel} | cerebras=${cerebras ? 'YES' : 'NO_KEY'} | groq=${groq ? 'YES' : 'NO_KEY'} | ollama=${ollamaUrl}`);

  // Devices
  const devices = q(() => all(`SELECT hostname, name, device_type, online, trusted, tailscale_ip FROM devices`)) || [];
  const deviceStr = devices.length
    ? devices.map(d => `${d.name || d.hostname}=${d.online ? 'online' : 'offline'}`).join(' · ')
    : 'NONE';
  lines.push(`DEVICES  ${deviceStr}`);

  // Sensors (webcam + screen from device_sensors/sensor_definitions)
  let webcamStatus = 'off';
  let screenStatus = 'off';
  let pendantStatus = 'disconn';
  try {
    const webcamSensor = q(() => get(`
      SELECT ds.value, ds.updated_at FROM device_sensors ds
      JOIN sensor_definitions sd ON ds.sensor_id = sd.id
      WHERE sd.name LIKE '%webcam%' OR sd.name LIKE '%camera%'
      ORDER BY ds.updated_at DESC LIMIT 1`));
    if (webcamSensor?.value) webcamStatus = 'active';

    const screenSensor = q(() => get(`
      SELECT ds.value, ds.updated_at FROM device_sensors ds
      JOIN sensor_definitions sd ON ds.sensor_id = sd.id
      WHERE sd.name LIKE '%screen%' OR sd.name LIKE '%display%'
      ORDER BY ds.updated_at DESC LIMIT 1`));
    if (screenSensor?.value) screenStatus = 'active';

    const pendantDevice = q(() => get(`SELECT online FROM devices WHERE device_type='pendant' LIMIT 1`));
    if (pendantDevice?.online) pendantStatus = 'conn';
  } catch {}

  lines.push(`SENSORS  webcam=${webcamStatus} · screen=${screenStatus} · pendant=${pendantStatus}`);

  // Smart devices
  const smartDevices = q(() => all(`SELECT name, type, room, state FROM smart_devices LIMIT 20`)) || [];
  const smartStr = smartDevices.length
    ? smartDevices.map(d => `${d.name}(${d.room || '?'})=${d.state || '?'}`).join(' · ')
    : 'NONE';
  lines.push(`SMART    ${smartStr}`);

  // DB stats
  let tableCount = '?';
  let lastEventStr = '?';
  let memoryCount = '?';
  let scoutNew = '?';

  try {
    const tc = q(() => get(`SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'`));
    if (tc) tableCount = tc.c;
  } catch {}

  try {
    const lastEvt = q(() => get(`SELECT created_at FROM events ORDER BY created_at DESC LIMIT 1`));
    if (lastEvt?.created_at) {
      const diffMs = Date.now() - new Date(lastEvt.created_at).getTime();
      const diffMin = Math.round(diffMs / 60000);
      lastEventStr = diffMin < 60 ? `${diffMin}m ago` : `${Math.round(diffMin / 60)}h ago`;
    }
  } catch {}

  try {
    const mc = q(() => get(`SELECT COUNT(*) as c FROM memory_items`));
    if (mc) memoryCount = mc.c;
  } catch {}

  try {
    const sc = q(() => get(`SELECT COUNT(*) as c FROM scout_findings WHERE status='new'`));
    if (sc) scoutNew = sc.c;
  } catch {}

  lines.push(`DB       ${tableCount} tables | last_event=${lastEventStr} | memory=${memoryCount} items | scout=${scoutNew} new findings`);

  // Tasks
  let p1Open = 0, p2Open = 0, inProgress = 0, inTest = 0;
  let p1Tasks = [];
  try {
    const tasks = q(() => all(`SELECT id, title, status, priority, type FROM project_tasks WHERE status IN ('todo','in_progress','in_test') AND priority <= 2`)) || [];
    p1Open     = tasks.filter(t => t.priority === 1 && t.status === 'todo').length;
    p2Open     = tasks.filter(t => t.priority === 2 && t.status === 'todo').length;
    inProgress = tasks.filter(t => t.status === 'in_progress').length;
    inTest     = tasks.filter(t => t.status === 'in_test').length;
    p1Tasks    = tasks.filter(t => t.priority === 1).slice(0, 6);
  } catch {}

  lines.push(`TASKS    ${p1Open} P1 open · ${p2Open} P2 open · ${inProgress} in_progress · ${inTest} in_test`);

  const bugsStr = p1Tasks.length
    ? p1Tasks.map(t => `#${t.id} ${t.title}`).join(' · ')
    : 'none';
  lines.push(`BUGS     ${bugsStr}`);

  // Recent commits
  let commitsStr = '?';
  try {
    const panDir = join(__dirname, '../../');
    const gitOut = execSync('git log --oneline -5', { cwd: panDir, encoding: 'utf-8', timeout: 5000, windowsHide: true });
    const commits = gitOut.trim().split('\n').slice(0, 3).map(l => l.trim());
    commitsStr = commits.join(' · ');
  } catch {}
  lines.push(`COMMITS  ${commitsStr}`);

  // Atlas apps
  let appsStr = 'NONE';
  try {
    const atlasApps = q(() => all(`SELECT id, name FROM atlas_apps ORDER BY last_seen DESC LIMIT 10`)) || [];
    if (atlasApps.length) appsStr = atlasApps.map(a => `${a.id}(${a.name})`).join(' · ');
  } catch {}
  lines.push(`APPS     ${appsStr}`);

  // Search hint
  lines.push(`SEARCH   events(event_type,data,created_at) · memory_items(item_type,content,confidence)`);
  lines.push(`         project_tasks(status,priority,title) · settings(key,value)`);
  lines.push(`         episodic_memories(summary,importance) · device_presence(device_id,activity,as_of)`);

  return lines.join('\n');
}

export {
  bootAll,
  shutdownAll,
  healthCheck,
  getAtlasData,
  getAtlasSummary,
  getServiceStatus,
  reportServiceRun,
  scanInstalledApps,
  services,
  MODEL_TIERS,
};
