// PAN Ollama Boot — auto-starts Ollama and pulls embedding model
//
// Called on server startup. If Ollama is installed but not running,
// starts it. If the embedding model isn't pulled, pulls it.
// All silent — no user action required.

import { execSync, spawn } from 'child_process';
import { resetOllamaStatus } from './embeddings.js';

const EMBED_MODEL = 'qwen3-embedding';
const INFERENCE_MODEL = 'qwen3:4b';
const OLLAMA_URL = 'http://localhost:11434';

async function isOllamaRunning() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function hasModel() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const data = await res.json();
    return data.models?.some(m => m.name.startsWith(EMBED_MODEL)) || false;
  } catch {
    return false;
  }
}

function isOllamaInstalled() {
  try {
    execSync('ollama --version', { stdio: 'pipe', timeout: 3000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function startOllama() {
  console.log('[PAN Memory] Starting Ollama...');
  // Spawn detached so it survives if PAN restarts
  const child = spawn('ollama', ['serve'], {
    detached: true,
    stdio: 'ignore',
    shell: true,
    windowsHide: true,
  });
  child.unref();
}

async function pullModel() {
  console.log(`[PAN Memory] Pulling ${EMBED_MODEL} (one-time, ~500MB)...`);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: EMBED_MODEL, stream: false }),
      signal: AbortSignal.timeout(300000), // 5 min timeout for download
    });
    if (res.ok) {
      console.log(`[PAN Memory] ${EMBED_MODEL} pulled successfully`);
      return true;
    }
    console.error(`[PAN Memory] Pull failed: ${res.status}`);
    return false;
  } catch (err) {
    console.error(`[PAN Memory] Pull error: ${err.message}`);
    return false;
  }
}

// Wait for Ollama to be ready after starting
async function waitForOllama(maxWaitMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isOllamaRunning()) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

// Main entry point — called on server startup
async function ensureOllama() {
  if (!isOllamaInstalled()) {
    console.log('[PAN Memory] Ollama not installed — vector memory using keyword fallback');
    return;
  }

  const running = await isOllamaRunning();
  if (!running) {
    startOllama();
    const ready = await waitForOllama();
    if (!ready) {
      console.log('[PAN Memory] Ollama failed to start — using keyword fallback');
      return;
    }
  }

  console.log('[PAN Memory] Ollama running');

  if (!await hasModel()) {
    // Pull in background — don't block server startup
    pullModel().then(success => {
      if (success) resetOllamaStatus(); // tell embeddings.js to retry
    });
  } else {
    console.log(`[PAN Memory] ${EMBED_MODEL} ready — neural embeddings active`);
    resetOllamaStatus();
  }

  // Also ensure inference model is available (for sensitivity, routing, etc.)
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      const hasInference = data.models?.some(m => m.name.startsWith(INFERENCE_MODEL)) || false;
      if (!hasInference) {
        console.log(`[PAN Memory] Pulling ${INFERENCE_MODEL} for local inference (~3GB)...`);
        fetch(`${OLLAMA_URL}/api/pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: INFERENCE_MODEL, stream: false }),
          signal: AbortSignal.timeout(600000), // 10 min for larger model
        }).then(r => {
          if (r.ok) console.log(`[PAN Memory] ${INFERENCE_MODEL} pulled successfully`);
          else console.error(`[PAN Memory] ${INFERENCE_MODEL} pull failed: ${r.status}`);
        }).catch(err => console.error(`[PAN Memory] ${INFERENCE_MODEL} pull error: ${err.message}`));
      } else {
        console.log(`[PAN Memory] ${INFERENCE_MODEL} ready — local inference active`);
      }
    }
  } catch {}
}

export { ensureOllama };
