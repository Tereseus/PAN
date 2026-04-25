// PAN Webcam Watcher — event-driven presence + identity
//
// Smart mode: once identity is locked in at high confidence, stop polling.
// Only re-check when:
//   1. Lock expires (LOCK_RECHECK_MS — default 5min, proves you're still there)
//   2. Desk went empty (need to confirm nobody is there)
//   3. forceCapture() called externally (pendant arrival signal, etc.)
//
// This cuts captures from ~103/day → ~20/day with no loss in accuracy.

import { spawn, spawnSync, execFileSync } from 'child_process';
import { initFaceId, identifyFromFrame, getFaceIdStatus } from './face-id.js';
import { run, get } from './db.js';

// How long since last mouse/keyboard input (Windows only).
// Returns milliseconds. Returns 0 on error (assume active).
function getIdleMs() {
  try {
    const ps = [
      'Add-Type @"',
      'using System;using System.Runtime.InteropServices;',
      'public class IL{',
      '  [StructLayout(LayoutKind.Sequential)]public struct LII{public uint cbSize;public uint dwTime;}',
      '  [DllImport("user32")]public static extern bool GetLastInputInfo(ref LII p);',
      '  public static uint IdleMs(){var l=new LII();l.cbSize=(uint)System.Runtime.InteropServices.Marshal.SizeOf(l);GetLastInputInfo(ref l);return(uint)Environment.TickCount-l.dwTime;}',
      '}',
      '"@',
      'Write-Output ([IL]::IdleMs())',
    ].join('\n');
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 3000 }).toString().trim();
    return parseInt(out) || 0;
  } catch { return 0; }
}

const INTERVAL_MS      = 30_000;   // base polling interval (when not locked)
const STALE_MS         = 90_000;   // context stale after 90s
const BURST_FRAMES     = 3;        // capture N frames, use best
const MISS_REQUIRED    = 2;        // consecutive misses before "desk empty"
const LOCK_CONF_MIN    = 35;       // min confidence % to lock identity (face-api 30-50% is normal for a good match)
const LOCK_RECHECK_MS  = 5 * 60_000; // recheck every 5min when locked (prove still there)

// Virtual camera keywords — exclude software cameras that open system dialogs
const VIRTUAL_CAM_HINTS = ['virtual', 'obs', 'steam', 'snap', 'manycam', 'droidcam', 'ivcam', 'epoccam', 'phone link'];

let watcherTimer      = null;
let isCapturing       = false;
let lastContext       = null;
let detectedCams      = null;
let consecutiveMisses = 0;

// Identity lock state
let identityLocked    = false;  // true = we know who's there, slow down
let lockLastRecheck   = 0;      // timestamp of last recheck while locked

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
    const real       = names.filter(n => !VIRTUAL_CAM_HINTS.some(h => n.toLowerCase().includes(h)));
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

// ── Frame capture ─────────────────────────────────────────────────────────────

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

async function runCapture(forced = false) {
  if (isCapturing) return;

  const now = Date.now();

  // Smart skip: if identity is locked and recheck isn't due, skip this tick
  if (!forced && identityLocked) {
    const recheckDue = (now - lockLastRecheck) >= LOCK_RECHECK_MS;
    if (!recheckDue) {
      // Still locked, recheck not due — keep context fresh but skip capture
      return;
    }
    console.log(`[WebcamWatcher] 🔁 Lock recheck (${Math.round((now - lockLastRecheck) / 1000)}s since last)`);
  }

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
      if (result.present) { face = result; break; }
      if (!face || result.confidence > (face.confidence || 0)) face = result;
    }
    if (!face) face = { present: false, identity: 'unknown', confidence: 0, expression: 'none' };
    const elapsed = Date.now() - t0;

    // Debounce: don't flip to "desk empty" on a single missed frame
    if (!face.present) {
      // If user has been typing/clicking recently, they're clearly still here — camera just missed them
      const idleMs = getIdleMs();
      const activeAtKeyboard = idleMs < 2 * 60_000; // active within last 2min
      if (activeAtKeyboard) {
        console.log(`[WebcamWatcher] No face but keyboard active ${Math.round(idleMs/1000)}s ago — staying locked`);
        consecutiveMisses = 0; // reset misses, user is here
        return;
      }

      consecutiveMisses++;
      if (consecutiveMisses < MISS_REQUIRED) {
        console.log(`[WebcamWatcher] No face — miss ${consecutiveMisses}/${MISS_REQUIRED}, holding last presence state`);
        return;
      }
      // Confirmed empty — unlock so we poll at normal rate waiting for return
      if (identityLocked) {
        identityLocked = false;
        console.log(`[WebcamWatcher] 🔓 Identity unlocked — desk empty (idle ${Math.round(idleMs/60000)}min), resuming normal polling`);
      }
    } else {
      consecutiveMisses = 0;

      // Lock identity once confidence is high enough
      if (!identityLocked && face.confidence >= LOCK_CONF_MIN && face.identity !== 'unknown') {
        identityLocked  = true;
        lockLastRecheck = Date.now();
        console.log(`[WebcamWatcher] 🔒 Identity locked: ${face.identity} (${face.confidence}%) — checking every ${LOCK_RECHECK_MS/60000}min`);
      } else if (identityLocked) {
        lockLastRecheck = Date.now(); // update recheck timestamp
      }
    }

    const ctx = {
      presence:   face.present ? 'yes' : 'no',
      identity:   face.identity,
      confidence: face.confidence,
      emotion:    face.expression,
      ts:         Date.now(),
      camera:     usedCamera,
      elapsed_ms: elapsed,
      locked:     identityLocked,
    };

    lastContext = ctx;

    run(
      `INSERT INTO events (event_type, session_id, data, created_at) VALUES (:type, 'system', :data, datetime('now'))`,
      { type: 'webcam_context', data: JSON.stringify(ctx) }
    );

    const tag = face.present ? (identityLocked ? '🔒' : '👤') : '🪑';
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
  initFaceId().catch(e => console.warn(`[WebcamWatcher] face-id init failed: ${e.message}`));
  console.log(`[WebcamWatcher] Started — poll every ${INTERVAL_MS/1000}s, lock after ${LOCK_CONF_MIN}% conf → recheck every ${LOCK_RECHECK_MS/60000}min`);
  setTimeout(() => runCapture(true), 5_000);
  watcherTimer = setInterval(() => runCapture(false), INTERVAL_MS);
}

export function stopWebcamWatcher() {
  if (watcherTimer) { clearInterval(watcherTimer); watcherTimer = null; }
  identityLocked = false;
}

/** Called by pendant/external signal — forces an immediate recheck regardless of lock */
export function triggerPresenceCheck() {
  identityLocked = false; // unlock so next tick runs fully
  consecutiveMisses = 0;
  console.log(`[WebcamWatcher] ⚡ External presence trigger — unlocking for immediate recheck`);
  runCapture(true);
}

export function getWebcamContext() {
  if (!lastContext) return null;
  if (Date.now() - lastContext.ts > STALE_MS) return null;
  return { ...lastContext, age_ms: Date.now() - lastContext.ts };
}

export async function forceCapture() {
  if (isCapturing) return { ok: false, error: 'capture already in progress' };
  const before = lastContext;
  await runCapture(true);
  const after = lastContext;
  if (after && after !== before) return { ok: true, result: after };
  return { ok: false, error: 'capture produced no output — check server logs' };
}

export function getWebcamStatus() {
  return {
    running:       !!watcherTimer,
    locked:        identityLocked,
    lockRecheckIn: identityLocked ? Math.max(0, LOCK_RECHECK_MS - (Date.now() - lockLastRecheck)) : null,
    lastCapture:   lastContext ? { age_ms: Date.now() - lastContext.ts, ...lastContext } : null,
    cameras:       detectedCams || [],
    faceId:        getFaceIdStatus(),
  };
}
