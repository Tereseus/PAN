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
import { listSessions } from './terminal.js';
import { hostname } from 'os';
import http from 'http';

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
    name: 'Ollama',
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
    name: 'Embeddings',
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
    description: 'Voice-to-text transcription server (WebM → WAV → text)',
    modelTier: 'local',
    modelMinSize: '~1.5B (whisper-medium)',
    modelCurrent: 'whisper-medium',
    port: 7782,
    healthCheck: 'port',
    bootOrder: 3,
    dependsOn: [],
    interval: null, // always-on
    startFn: null,
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
    bootOrder: 4,
    dependsOn: ['whisper'],
    interval: null,
    startFn: null,
    stopFn: null,
    _status: 'unknown',
    _lastCheck: null,
    _lastError: null,
    _lastRun: null,
  },
  {
    id: 'classifier',
    name: 'Classifier',
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
    name: 'Stack Scanner',
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
    modelCurrent: 'cerebras:gpt-oss-120b',
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
    name: 'Memory Consolidation',
    description: 'Extracts episodes, facts, procedures from events into vector memory',
    modelTier: 'reasoning',
    modelMinSize: '30B+',
    modelCurrent: 'cerebras:gpt-oss-120b',
    port: null,
    healthCheck: 'interval',
    bootOrder: 8,
    dependsOn: ['embeddings', 'dream'],
    interval: 'per-session',
    startFn: null, // triggered by dream/classifier, not on a timer
    stopFn: null,
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
    modelCurrent: 'cerebras:gpt-oss-120b',
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
    modelCurrent: 'cerebras:gpt-oss-120b',
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
    modelCurrent: 'cerebras:gpt-oss-120b',
    port: null,
    healthCheck: 'interval',
    bootOrder: 11,
    dependsOn: ['dream', 'consolidation'],
    interval: '6h',
    startFn: null, // triggered after dream, not standalone timer
    stopFn: null,
    toggle: 'evolution',
    _status: 'stopped',
    _lastCheck: null,
    _lastError: null,
    _lastRun: null,
  },
  {
    id: 'autodev',
    name: 'AutoDev',
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
    name: 'Tailscale',
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
    name: 'PAN Server',
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

async function checkProcessRunning(processName) {
  try {
    const { execSync } = await import('child_process');
    const result = execSync(`tasklist /FI "IMAGENAME eq ${processName}" /NH`, {
      encoding: 'utf8', timeout: 5000
    });
    return result.includes(processName);
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
        const running = await checkProcessRunning(svc.processName);
        svc._status = running ? 'running' : 'down';
        break;
      }
      case 'interval': {
        // For interval-based services, check if they've been started
        // The actual service modules track their own timer state
        if (svc._status === 'stopped' && svc.startFn) {
          svc._status = 'stopped';
        }
        // If running, verify last run wasn't too long ago
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

  // Check external services first (ollama, whisper, ahk, tailscale)
  const externals = services.filter(s => !s.startFn && s.healthCheck !== 'self');
  for (const svc of externals) {
    await checkServiceHealth(svc);
    const icon = svc._status === 'running' ? '✓' : svc._status === 'down' ? '✗' : '?';
    console.log(`[Steward] ${icon} ${svc.name}: ${svc._status}`);
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

async function healthCheck() {
  for (const svc of services) {
    await checkServiceHealth(svc);
  }

  // Clean zombie PTY sessions (connected but no activity for 2 hours)
  cleanZombieSessions();

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

// ==================== ATLAS DATA ====================
// Returns the full service registry with live status for Atlas rendering

function getAtlasData() {
  return {
    modelTiers: MODEL_TIERS,
    services: services.map(svc => ({
      id: svc.id,
      name: svc.name,
      description: svc.description,
      // Model requirements — what Atlas shows as badges
      modelTier: svc.modelTier,
      modelTierLabel: MODEL_TIERS[svc.modelTier]?.label || svc.modelTier,
      modelTierColor: MODEL_TIERS[svc.modelTier]?.color || '#6c7086',
      modelMinSize: svc.modelMinSize,
      modelCurrent: svc.modelCurrent,
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
