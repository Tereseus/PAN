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

import { get, all, run, insert } from './db.js';
import { startClassifier, stopClassifier } from './classifier.js';
import { startScout, stopScout } from './scout.js';
import { startDream, stopDream } from './dream.js';
import { startAutoDev, stopAutoDev } from './autodev.js';
import { startStackScanner, stopStackScanner } from './stack-scanner.js';
import { startOrchestrator, stopOrchestrator } from './orchestrator.js';
import { consolidate as consolidateMemory } from './memory/consolidation.js';
import { evolve as runEvolution } from './evolution/engine.js';
import { listSessions } from './terminal.js';
import { hostname } from 'os';
import http from 'http';
import { spawn, execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync } from 'fs';
import { IS_USER_MODE, IS_SERVICE_MODE } from './mode.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ==================== MODEL TIERS ====================
// These define what kind of AI backend a service requires.
// Atlas displays these as badges on each service node.

const MODEL_TIERS = {
  none:        { label: 'None',        color: '#6c7086', description: 'No AI model needed' },
  local:       { label: 'Local 7B',    color: '#a6e3a1', description: 'Local Ollama (embeddings, simple tasks)' },
  reasoning:   { label: 'Cloud 120B+', color: '#89b4fa', description: 'Cerebras 120B+ (summarization, extraction, analysis)' },
  interactive: { label: 'Claude',      color: '#f9e2af', description: 'Claude via CLI subscription (terminal sessions)' },
};

// ==================== SERVICE REGISTRY ====================
// Every PAN service is defined here. This is the single source of truth
// that Atlas, health checks, and boot sequencing all read from.

const services = [
  {
    id: 'ollama',
    name: 'Local Intelligence',
    technicalName: 'Ollama',
    description: 'Local model server for embeddings (llama3.2 7B, CUDA)',
    modelTier: 'none',
    modelMinSize: 'N/A',
    modelCurrent: 'N/A (serves models, not a consumer)',
    port: 11434,
    healthCheck: 'port',
    healthEndpoint: '/api/tags',
    bootOrder: 1,
    dependsOn: [],
    interval: null, // always-on process
    startFn: null,  // managed externally (ollama-boot.js)
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
    description: 'Vector text encoding for memory search (3072D)',
    modelTier: 'local',
    modelMinSize: '7B',
    modelCurrent: 'llama3.2 (Ollama)',
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
  {
    id: 'ahk',
    name: 'Voice Hotkeys (AHK)',
    description: 'AutoHotkey voice dictation trigger (mouse side button)',
    modelTier: 'none',
    modelMinSize: 'N/A',
    modelCurrent: 'N/A',
    port: null,
    healthCheck: 'process',
    processName: 'AutoHotkey64.exe',
    // Verify the running AHK process is OUR Voice.ahk, not a stale manual one
    processCmdLineMatch: 'service\\\\bin\\\\Voice.ahk',
    // AHK needs an interactive desktop session — skip in service/Session 0 mode
    userOnly: true,
    bootOrder: 4,
    dependsOn: ['whisper'],
    interval: null,
    startFn: () => {
      const ahkScript = join(__dirname, '..', 'bin', 'Voice.ahk');
      const ahkExe = 'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe';
      // PAN often runs in Windows Session 0 (SYSTEM) when launched via the
      // pan.exe daemon. Mouse/keyboard hooks in Session 0 cannot see input
      // from the user's interactive Session 1, so XButton1/XButton2 in
      // Voice.ahk never fire. Use schtasks with /IT /RU to launch AHK in
      // the user's interactive session. Avoid nested-quoting hell by writing
      // a tiny launcher .bat to %TEMP% first and pointing /TR at it.
      try {
        const tmpDir = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
        const launcherBat = join(tmpDir, 'pan-ahk-launch.bat');
        const batContent = `@echo off\r\nstart "" "${ahkExe}" /restart /script "${ahkScript}"\r\n`;
        writeFileSync(launcherBat, batContent);

        const taskName = 'PAN_AHK_Launch';
        // Quietly delete any prior task
        try { execSync(`schtasks /Delete /TN "${taskName}" /F`, { stdio: 'ignore' }); } catch {}
        // Create as interactive task running as the current user. /IT requires
        // the user to be logged on (which they are, since AHK only matters then).
        execSync(
          `schtasks /Create /TN "${taskName}" /TR "\\"${launcherBat}\\"" /SC ONCE /ST 23:59 /F /RU "${process.env.USERNAME || 'tzuri'}" /IT`,
          { stdio: 'ignore' }
        );
        execSync(`schtasks /Run /TN "${taskName}"`, { stdio: 'ignore' });
        // Clean the task entry up after launch (the AHK process keeps running)
        setTimeout(() => {
          try { execSync(`schtasks /Delete /TN "${taskName}" /F`, { stdio: 'ignore' }); } catch {}
        }, 5000);
        console.log('[Steward] Launched Voice.ahk in user session via schtasks:', ahkScript);
      } catch (err) {
        console.error('[Steward] Failed to launch Voice.ahk:', err.message);
      }
    },
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
    modelTier: 'none',
    modelMinSize: 'N/A',
    modelCurrent: 'N/A',
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
    id: 'stack-scanner',
    name: 'Cartographer',
    technicalName: 'Stack Scanner',
    description: 'Tech stack discovery from project files (package.json, Cargo.toml, etc.)',
    modelTier: 'none',
    modelMinSize: 'N/A',
    modelCurrent: 'N/A',
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
        exec(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
          if (err) return resolve(false);
          resolve(/\d+/.test(stdout.trim()));
        });
        return;
      }
      exec(`tasklist /FI "IMAGENAME eq ${processName}" /NH`, { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
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
    }

    // Auto-restart services that have a startFn and are down — with backoff.
    // If a service keeps flapping (down → restart → down) we exponentially
    // delay further restarts so we don't burn CPU + spawn processes once a
    // minute forever (the AHK / Voice.ahk loop that crashed PAN on 2026-04-08).
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
          svc._restartGaveUp = true;
        }
      } else {
        try {
          console.log(`[Steward] Auto-restarting ${svc.name}... (attempt ${svc._restartFailures + 1})`);
          svc.startFn();
          svc._status = 'running';
          svc._lastRun = Date.now();
          logServiceEvent(svc.id, 'restart', { success: true });
          // Exponential backoff: 1m, 2m, 4m, 8m, 16m. Reset on a successful
          // health check (handled below in checkServiceHealth path).
          svc._restartFailures += 1;
          svc._restartCooldownUntil = now + Math.min(60_000 * Math.pow(2, svc._restartFailures - 1), 16 * 60_000);
        } catch (err) {
          svc._lastError = err.message;
          console.error(`[Steward] Failed to restart ${svc.name}: ${err.message}`);
          logServiceEvent(svc.id, 'restart', { success: false, error: err.message });
          svc._restartFailures += 1;
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
  cleanZombieSessions();

  // Reap orphaned Claude CLI processes (parent PTY gone, still alive).
  // Catches the April-6-style zombies where the PTY died but the child
  // claude cli.js kept running, accumulating CPU forever.
  reapOrphanClaudeProcesses();

  // Log a heartbeat event
  try {
    const summary = services.map(s => `${s.id}:${s._status}`).join(',');
    insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`, {
      ':sid': 'steward',
      ':type': 'StewardHeartbeat',
      ':data': JSON.stringify({
        timestamp: Date.now(),
        services: services.map(s => ({
          id: s.id, status: s._status, lastCheck: s._lastCheck, lastError: s._lastError
        })),
        summary
      })
    });
  } catch {}
}

function cleanZombieSessions() {
  try {
    const sessions = listSessions();
    const now = Date.now();
    for (const s of sessions) {
      // Sessions with 0 clients and no activity for 2 hours are zombies
      if (s.clients === 0 && s.lastActivity && (now - s.lastActivity) > 2 * 60 * 60 * 1000) {
        console.log(`[Steward] Cleaning zombie session: ${s.id} (no clients, idle ${Math.round((now - s.lastActivity) / 60000)}min)`);
        // Don't kill — just log for now. Aggressive cleanup can lose work.
      }
    }
  } catch {}
}

// Find Claude CLI (cli.js) processes whose parent PID is NOT one of our
// tracked PTY pids and is older than 30 minutes — those are orphans left
// behind by a crashed PTY. Kill them. Windows-only via PowerShell CIM.
function reapOrphanClaudeProcesses() {
  if (process.platform !== 'win32') return;
  try {
    const ourPtyPids = new Set(listSessions().map(s => s.pid).filter(Boolean));
    // Also exempt our own pid + ppid (server.js + steward) just in case.
    ourPtyPids.add(process.pid);
    if (process.ppid) ourPtyPids.add(process.ppid);

    // Write the PS script to a temp .ps1 file to dodge cmd/powershell
    // double-quote nesting hell. The previous inline `-Command "...Name='node.exe'..."`
    // had the inner double-quotes terminate the outer string and cmd would
    // pass an invalid -Filter, making the reaper throw on every health tick.
    const ps = `$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*@anthropic-ai/claude-code/cli.js*' } | Select-Object ProcessId, ParentProcessId, CreationDate
if ($procs) { $procs | ConvertTo-Json -Compress }`;
    const tmpDir = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
    const psFile = join(tmpDir, 'pan-reap-orphans.ps1');
    writeFileSync(psFile, ps);
    const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, { encoding: 'utf-8', timeout: 10000 }).trim();
    if (!out) return;
    const parsed = JSON.parse(out);
    const procs = Array.isArray(parsed) ? parsed : [parsed];
    const now = Date.now();
    const MIN_AGE_MS = 30 * 60 * 1000; // 30 min — don't touch fresh hook callbacks

    for (const p of procs) {
      const pid = p.ProcessId;
      const ppid = p.ParentProcessId;
      // Parse Windows CIM date "/Date(1775681352482)/"
      const m = /\((\d+)\)/.exec(p.CreationDate || '');
      const startedAt = m ? parseInt(m[1], 10) : 0;
      const ageMs = startedAt ? (now - startedAt) : 0;

      if (ourPtyPids.has(ppid)) continue;       // child of a live PTY → keep
      if (ageMs < MIN_AGE_MS) continue;          // too young → probably hook callback

      try {
        process.kill(pid);
        console.log(`[Steward] Reaped orphan claude cli.js pid=${pid} ppid=${ppid} age=${Math.round(ageMs/60000)}min`);
        logServiceEvent('claude-reaper', 'orphan_killed', { pid, ppid, age_ms: ageMs });
      } catch (err) {
        console.error(`[Steward] Failed to reap pid ${pid}: ${err.message}`);
      }
    }
  } catch (err) {
    // Reaper failures are non-fatal — log and continue
    console.error(`[Steward] reapOrphanClaudeProcesses error: ${err.message}`);
  }
}

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

export {
  bootAll,
  shutdownAll,
  healthCheck,
  getAtlasData,
  getServiceStatus,
  reportServiceRun,
  services,
  MODEL_TIERS,
};
