// PAN Face Identity — PARENT-THREAD COORDINATOR (worker-backed)
//
// History:
//   v1 (Mar 2026): ran all face-api inference inline on the main thread. Worked
//                   in isolation, but under CPU contention a single identify call
//                   spiked to 149-176 seconds, freezing the Craft event loop and
//                   making the dashboard unusable (task #58 receipts).
//   v2 (May 2026): inference moved into face-id-worker.js (task #59). This file
//                   keeps the same public API — initFaceId / identifyFromFrame /
//                   getFaceIdStatus — so callers (webcam-watcher.js) need no change.
//                   The main thread now only does base64 → postMessage → await.
//
// Failure modes preserved: if the worker can't start, identifyFromFrame returns
// the safe "no presence" object so the watcher doesn't crash. If a single
// identify message stalls past IDENTIFY_TIMEOUT_MS, the parent gives up on that
// request (worker keeps running for the next one); this used to be impossible
// because the work was sync.

import { Worker } from 'worker_threads';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { get } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REFERENCE_DIR = '%USERPROFILE%/Desktop/Me_pics';
const REFERENCE_FILES = ['portait.png', 'me_London.png', 'me_club.png', 'me_island.png'];

const MATCH_THRESHOLD = 0.60;
const AUTOENROLL_THRESHOLD = 35;
const AUTOENROLL_MAX = 20;

// Bound how long the parent will wait for any single identify response. The
// worker keeps running after a timeout — only the awaiting Promise rejects.
// 25s is generous (normal inference is sub-second; pathological is 150s+ on
// the main thread). This is a safety net, not a perf knob.
const IDENTIFY_TIMEOUT_MS = 25_000;

let _worker = null;
let _workerReadyPromise = null;
let _nextReqId = 1;
const _pending = new Map(); // id → { resolve, timer }

// Mirrored status — updated when the worker reports back. Kept in parent so
// getFaceIdStatus() can answer synchronously (callers expect that).
let _status = {
  modelsLoaded: false,
  enrolledLabel: null,
  enrolledCount: 0,
  autoEnrolledCount: 0,
  threshold: MATCH_THRESHOLD,
  autoEnrollThreshold: AUTOENROLL_THRESHOLD,
};

function _resolveEnrolledLabel() {
  try {
    const u = get("SELECT display_nickname, display_name FROM users WHERE id = 1");
    const v = u?.display_nickname || u?.display_name;
    if (v) return v;
  } catch {}
  try {
    const row = get("SELECT value FROM settings WHERE key = 'display_name'");
    if (row?.value) return String(row.value).replace(/^"|"$/g, '');
  } catch {}
  return 'Tereseus';
}

function _spawnWorker() {
  if (_worker) return;
  const workerPath = join(__dirname, 'face-id-worker.js');
  _worker = new Worker(workerPath);

  _worker.on('message', (msg) => {
    if (msg?.type === 'init_ok') {
      _status.modelsLoaded = true;
      _status.enrolledCount = msg.enrolledCount || 0;
      console.log(`[FaceID] worker ready — enrolled "${_status.enrolledLabel}" from ${_status.enrolledCount} photo(s)`);
      return;
    }
    if (msg?.type === 'init_err') {
      console.warn(`[FaceID] worker init failed: ${msg.error}`);
      return;
    }
    if (msg?.type === 'result') {
      const slot = _pending.get(msg.id);
      if (!slot) return; // already timed out
      _pending.delete(msg.id);
      clearTimeout(slot.timer);
      // Light bookkeeping: track how many auto-enrolled descriptors live in the worker
      // (we don't get the descriptor itself, but the worker tells us via status_query
      // periodically — see below).
      slot.resolve({
        present: !!msg.present,
        identity: msg.identity || 'unknown',
        confidence: msg.confidence || 0,
        expression: msg.expression || 'none',
      });
      return;
    }
    if (msg?.type === 'status') {
      _status = { ..._status, ...msg };
      delete _status.type;
      return;
    }
  });

  _worker.on('error', (err) => {
    console.error(`[FaceID] worker error: ${err.message}`);
    // Fail any pending requests so callers aren't left hanging.
    for (const { resolve, timer } of _pending.values()) {
      clearTimeout(timer);
      resolve({ present: false, identity: 'unknown', confidence: 0, expression: 'none' });
    }
    _pending.clear();
  });

  _worker.on('exit', (code) => {
    console.warn(`[FaceID] worker exited (code=${code}) — will respawn on next init`);
    _worker = null;
    _workerReadyPromise = null;
    _status.modelsLoaded = false;
  });
}

export async function initFaceId() {
  if (_workerReadyPromise) return _workerReadyPromise;
  _spawnWorker();
  _status.enrolledLabel = _resolveEnrolledLabel();
  const initMsg = {
    type: 'init',
    enrolledLabel: _status.enrolledLabel,
    referenceDir: REFERENCE_DIR,
    referenceFiles: REFERENCE_FILES.filter((f) => existsSync(`${REFERENCE_DIR}/${f}`)),
    matchThreshold: MATCH_THRESHOLD,
    autoenrollThreshold: AUTOENROLL_THRESHOLD,
    autoenrollMax: AUTOENROLL_MAX,
  };
  _workerReadyPromise = new Promise((resolve) => {
    const onMsg = (msg) => {
      if (msg?.type === 'init_ok' || msg?.type === 'init_err') {
        _worker.off('message', onMsg);
        resolve();
      }
    };
    _worker.on('message', onMsg);
    _worker.postMessage(initMsg);
  });
  // Poll status from the worker every 30s so getFaceIdStatus() stays accurate
  // (autoEnrolledCount in particular changes over time).
  if (!_statusPollTimer) {
    _statusPollTimer = setInterval(() => {
      try { _worker?.postMessage({ type: 'status_query' }); } catch {}
    }, 30_000);
  }
  return _workerReadyPromise;
}

let _statusPollTimer = null;

/**
 * Identify a person in a webcam frame.
 * Same return shape as v1, but the heavy work runs off-thread now.
 */
export async function identifyFromFrame(base64) {
  if (!_workerReadyPromise) {
    // Lazy init for callers that didn't call initFaceId() first.
    initFaceId().catch(() => {});
  }
  await _workerReadyPromise;
  if (!_worker) {
    return { present: false, identity: 'unknown', confidence: 0, expression: 'none' };
  }

  const id = _nextReqId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!_pending.has(id)) return;
      _pending.delete(id);
      console.warn(`[FaceID] identify req ${id} timed out > ${IDENTIFY_TIMEOUT_MS}ms — returning empty result`);
      resolve({ present: false, identity: 'unknown', confidence: 0, expression: 'none' });
    }, IDENTIFY_TIMEOUT_MS);
    _pending.set(id, { resolve, timer });
    try {
      _worker.postMessage({ type: 'identify', id, base64 });
    } catch (err) {
      clearTimeout(timer);
      _pending.delete(id);
      console.warn(`[FaceID] postMessage failed: ${err.message}`);
      resolve({ present: false, identity: 'unknown', confidence: 0, expression: 'none' });
    }
  });
}

export function getFaceIdStatus() {
  return { ..._status };
}
