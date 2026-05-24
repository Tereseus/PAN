// Carrier observability — log tee + swap lifecycle history.
//
// Why this exists: pre-2026-05-17 the carrier's console output went to the
// terminal that launched PAN.bat (often nothing persistent), and
// performSwap()'s only failure signal was `console.error("failed health check")`
// with the underlying ECONNREFUSED/HTTP-status/timeout swallowed by an empty
// catch. When a swap silently aborted (e.g. `9f262bb` → kept old `3db10d4`),
// there was no way to ask "why" without rebuilding the failure.
//
// What this provides:
//   1. setupCarrierLog()        — tees stdout/stderr + console.* to a
//                                 rotating file at <dataDir>/../logs/carrier.log
//                                 (10MB → carrier.log.1 → carrier.log.2)
//   2. appendCraftStderr(craft) — per-craft ring buffer keeping the last
//                                 ~10KB / 50 lines of stderr so swap failures
//                                 can attach the actual error
//   3. recordSwapPhase(p,data)  — in-memory ring of last 50 swap-lifecycle
//                                 phases (started/aborted/live/rolled_back/
//                                 confirmed/gate_failed). Always available
//                                 even if the Craft is down — by design.
//   4. getSwapHistory()         — returns the ring for /api/carrier/swap-history
//
// Notes:
//   - File tee uses appendFileSync via a small queue so the carrier never
//     blocks on disk I/O during a swap. Failures here are non-fatal.
//   - Console patching happens once; safe to call setupCarrierLog twice.

import { existsSync, mkdirSync, statSync, renameSync, appendFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';

const MAX_LOG_BYTES   = 10 * 1024 * 1024;          // 10MB before rotation
const ROTATE_KEEP     = 2;                          // .log + .log.1 + .log.2
const STDERR_TAIL_MAX = 10 * 1024;                  // per-craft stderr ring
const SWAP_HISTORY_MAX = 50;                        // last 50 lifecycle phases

let LOG_FILE = null;
let _patched = false;
const swapHistory = [];                              // newest last

function ensureLogDir(logFile) {
  try { mkdirSync(dirname(logFile), { recursive: true }); } catch {}
}

function rotateIfNeeded() {
  if (!LOG_FILE || !existsSync(LOG_FILE)) return;
  let size = 0;
  try { size = statSync(LOG_FILE).size; } catch { return; }
  if (size < MAX_LOG_BYTES) return;
  for (let i = ROTATE_KEEP; i >= 1; i--) {
    const src = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
    const dst = `${LOG_FILE}.${i}`;
    if (existsSync(src)) {
      try { renameSync(src, dst); } catch {}
    }
  }
}

function writeLog(line) {
  if (!LOG_FILE) return;
  try {
    rotateIfNeeded();
    appendFileSync(LOG_FILE, line);
  } catch { /* never block the carrier */ }
}

/**
 * Patch console.* and process.std{out,err}.write so every byte the carrier
 * emits also lands in <logsDir>/carrier.log. Returns the log file path.
 */
export function setupCarrierLog(logsDir) {
  if (_patched) return LOG_FILE;
  LOG_FILE = join(logsDir, 'carrier.log');
  ensureLogDir(LOG_FILE);

  const ts = () => new Date().toISOString();

  // Wrap stdout/stderr.write so [Craft-N] pipe-throughs are captured too.
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk, ...rest) => {
    try { writeLog(`${ts()} OUT ${chunk}`); } catch {}
    return origStdoutWrite(chunk, ...rest);
  };
  process.stderr.write = (chunk, ...rest) => {
    try { writeLog(`${ts()} ERR ${chunk}`); } catch {}
    return origStderrWrite(chunk, ...rest);
  };

  // console.* already routes through process.std{out,err}.write so the wraps
  // above catch it. We don't need a second layer.

  _patched = true;
  writeLog(`\n${ts()} === Carrier log opened (pid=${process.pid}) ===\n`);
  return LOG_FILE;
}

export function getLogFile() { return LOG_FILE; }

/**
 * Append a chunk of stderr to a craft's ring buffer (last ~10KB).
 * Craft objects pass through spawnCraft() — call this from the stderr handler.
 */
export function appendCraftStderr(craft, chunk) {
  if (!craft) return;
  if (typeof craft.stderrTail !== 'string') craft.stderrTail = '';
  craft.stderrTail += String(chunk);
  if (craft.stderrTail.length > STDERR_TAIL_MAX) {
    craft.stderrTail = craft.stderrTail.slice(craft.stderrTail.length - STDERR_TAIL_MAX);
  }
}

/** Return last N lines of a craft's stderr ring, default 50. */
export function getCraftStderrTail(craft, maxLines = 50) {
  if (!craft || !craft.stderrTail) return '';
  const lines = craft.stderrTail.split('\n');
  return lines.slice(-maxLines).join('\n');
}

/**
 * Record a swap lifecycle phase. Phases:
 *   'started'       — performSwap entered, new Craft spawning
 *   'health_failed' — new Craft never went healthy (with reason+detail+stderr)
 *   'gate_failed'   — health OK but perf gate rejected
 *   'live'          — proxy switched, rollback window open
 *   'confirmed'     — rollback window closed, old craft killed
 *   'rolled_back'   — explicit/auto rollback, new craft killed
 */
export function recordSwapPhase(phase, data = {}) {
  const row = { ts: Date.now(), phase, ...data };
  swapHistory.push(row);
  if (swapHistory.length > SWAP_HISTORY_MAX) swapHistory.shift();
  return row;
}

export function getSwapHistory() {
  return swapHistory.slice().reverse();   // newest first
}

/** Read last N bytes of the carrier log file, for the /swap-history endpoint. */
export function readLogTail(bytes = 8192) {
  if (!LOG_FILE || !existsSync(LOG_FILE)) return '';
  try {
    const size = statSync(LOG_FILE).size;
    const start = Math.max(0, size - bytes);
    const buf = readFileSync(LOG_FILE);
    return buf.slice(start).toString('utf8');
  } catch {
    return '';
  }
}
