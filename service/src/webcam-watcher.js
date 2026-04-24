// PAN Webcam Watcher — periodic webcam frame → face-api → presence + identity
//
// Identity via face embeddings (local, <1s) — NOT a vision LLM.
// Cameras are auto-detected at runtime via FFmpeg dshow listing.
// Uses pipe output to avoid FFmpeg 8+ single-frame file write bug.

import { spawn, spawnSync } from 'child_process';
import { initFaceId, identifyFromFrame, getFaceIdStatus } from './face-id.js';
import { run, get } from './db.js';

const INTERVAL_MS   = 30_000;   // capture every 30s (fast enough now)
const STALE_MS      = 90_000;   // context stale after 90s
const BURST_FRAMES  = 3;        // capture N frames, use best (most likely to catch a face)
const MISS_REQUIRED = 2;        // consecutive no-face captures before declaring "desk empty"

// Virtual camera keywords — exclude software cameras that open system dialogs
// Note: "phone/pixel" are NOT excluded — pendant images come over HTTP, not dshow
const VIRTUAL_CAM_HINTS = ['virtual', 'obs', 'steam', 'snap', 'manycam', 'droidcam', 'ivcam', 'epoccam', 'phone link'];

let watcherTimer  = null;
let isCapturing   = false;
let lastContext   = null;
let detectedCams  = null;
let consecutiveMisses = 0;   // no-face frames in a row — need MISS_REQUIRED before "desk empty"

// ── Camera detection ──────────────────────────────────────────────────────────

function detectCameras() {
  if (detectedCams) return detectedCams;
  try {
    const result = spawnSync('ffmpeg', ['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'],
      { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    const output = (result.stderr || '') + (result.stdout || '');
    const names = [];
    for (const line of output.split('\n')) {
      const m = line.match(/"([^"]+)"\s+\(video\)/);
      if (m) names.push(m[1]);
    }
    // Prefer integrated/built-in cameras first, then others, skip known virtual
    const real = names.filter(n => !VIRTUAL_CAM_HINTS.some(h => n.toLowerCase().includes(h)));
    const integrated = real.filter(n => /integrated|built.?in|internal/i.test(n));
    const others     = real.filter(n => !/integrated|built.?in|internal/i.test(n));
    detectedCams = [...integrated, ...others];
    console.log(`[WebcamWatcher] Cameras: ${detectedCams.join(', ') || '(none)'}`);
  } catch (e) {
    console.warn(`[WebcamWatcher] Camera detection failed: ${e.message}`);
    detectedCams = [];
  }
  return detectedCams;
}

// ── Frame capture (FFmpeg pipe — avoids FFmpeg 8+ file write bug) ─────────────

function captureFrame(cameraName) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-f', 'dshow', '-i', `video=${cameraName}`,
      '-vframes', '1',
      '-vf', 'scale=640:-2',
      '-q:v', '3',
      '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1',
    ], { windowsHide: true, shell: false });

    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      const buf = Buffer.concat(chunks);
      if (buf.length > 1000) resolve(buf.toString('base64'));
      else reject(new Error(`FFmpeg exit ${code}. ${stderr.slice(-120)}`));
    });
    proc.on('error', e => reject(new Error(`FFmpeg spawn: ${e.message}`)));
  });
}

// ── Capture cycle ─────────────────────────────────────────────────────────────

async function runCapture() {
  if (isCapturing) return;
  isCapturing = true;

  try {
    const cameras = detectCameras();
    if (!cameras.length) { console.warn('[WebcamWatcher] No cameras — skipping'); return; }

    let usedCamera = null;
    for (const cam of cameras) {
      try { await captureFrame(cam); usedCamera = cam; break; }
      catch (e) { console.warn(`[WebcamWatcher] "${cam}" failed: ${e.message.slice(0, 80)}`); }
    }
    if (!usedCamera) { console.warn('[WebcamWatcher] All cameras failed'); return; }

    // Burst: capture up to BURST_FRAMES, stop as soon as we get a face
    const t0 = Date.now();
    let face = null;
    for (let i = 0; i < BURST_FRAMES; i++) {
      let b64;
      try { b64 = await captureFrame(usedCamera); }
      catch (e) { console.warn(`[WebcamWatcher] burst frame ${i+1} failed: ${e.message.slice(0, 60)}`); continue; }
      const result = await identifyFromFrame(b64);
      if (result.present) { face = result; break; }  // got a face — stop bursting
      if (!face || result.confidence > (face.confidence || 0)) face = result; // keep best
    }
    if (!face) face = { present: false, identity: 'unknown', confidence: 0, expression: 'none' };
    const elapsed = Date.now() - t0;

    // Debounce: don't flip to "desk empty" on a single missed frame
    if (!face.present) {
      consecutiveMisses++;
      if (consecutiveMisses < MISS_REQUIRED) {
        console.log(`[WebcamWatcher] No face — miss ${consecutiveMisses}/${MISS_REQUIRED}, holding last presence state`);
        return;
      }
    } else {
      consecutiveMisses = 0;
    }

    const ctx = {
      presence:   face.present ? 'yes' : 'no',
      identity:   face.identity,
      confidence: face.confidence,
      emotion:    face.expression,
      ts:         Date.now(),
      camera:     usedCamera,
      elapsed_ms: elapsed,
    };

    lastContext = ctx;

    run(
      `INSERT INTO events (event_type, session_id, data, created_at) VALUES (:type, 'system', :data, datetime('now'))`,
      { type: 'webcam_context', data: JSON.stringify(ctx) }
    );

    const tag = face.present ? '👤' : '🪑';
    console.log(`[WebcamWatcher] ${tag} presence=${ctx.presence} identity=${ctx.identity}${face.confidence ? ` (${face.confidence}%)` : ''} expression=${ctx.emotion} — ${elapsed}ms`);

  } catch (e) {
    console.warn(`[WebcamWatcher] cycle error: ${e.message}`);
  } finally {
    isCapturing = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function startWebcamWatcher() {
  if (watcherTimer) return;
  detectCameras();
  // Init face-id in background — first capture waits for it automatically
  initFaceId().catch(e => console.warn(`[WebcamWatcher] face-id init failed: ${e.message}`));
  console.log(`[WebcamWatcher] Started — every ${INTERVAL_MS / 1000}s`);
  setTimeout(runCapture, 5_000);   // first capture in 5s (face-id loads fast)
  watcherTimer = setInterval(runCapture, INTERVAL_MS);
}

export function stopWebcamWatcher() {
  if (watcherTimer) { clearInterval(watcherTimer); watcherTimer = null; }
}

export function getWebcamContext() {
  if (!lastContext) return null;
  if (Date.now() - lastContext.ts > STALE_MS) return null;
  return { ...lastContext, age_ms: Date.now() - lastContext.ts };
}

export async function forceCapture() {
  if (isCapturing) return { ok: false, error: 'capture already in progress' };
  const before = lastContext;
  await runCapture();
  const after = lastContext;
  if (after && after !== before) return { ok: true, result: after };
  return { ok: false, error: 'capture produced no output — check server logs' };
}

export function getWebcamStatus() {
  return {
    running:     !!watcherTimer,
    lastCapture: lastContext ? { age_ms: Date.now() - lastContext.ts, ...lastContext } : null,
    cameras:     detectedCams || [],
    faceId:      getFaceIdStatus(),
  };
}
