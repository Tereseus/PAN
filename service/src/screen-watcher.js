// PAN Screen Watcher — periodic screenshot → vision AI → activity signal for intuition.js
//
// Uses the PAN Tauri shell (port 7790) which has xcap built-in for screen capture.
// Every 30s: POST /screenshot to Tauri → base64 PNG → analyzeImage() → 'screen_context' event.
// intuition.js reads the latest event as the highest-priority activity signal.
//
// Falls back to FFmpeg gdigrab if Tauri shell is not running.

import { spawn, execFileSync, spawnSync } from 'child_process';
import { join } from 'path';
import { unlinkSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { analyzeImage } from './llm.js';
import { run, all } from './db.js';

const INTERVAL_MS  = 60_000;   // screenshot every 60s when active (was 30s)
const STALE_MS     = 120_000;  // context older than 120s ignored by intuition
// Idle check is disabled (IDLE_THRESH = Infinity) because voice-first users may not touch keyboard for hours
// but are still actively using PAN. The vision backoff mechanism handles the "truly away" case:
// if Ollama is unreachable (mini PC off when user is asleep), captures back off 2→5→10→20 minutes automatically.
const IDLE_THRESH  = Infinity;  // disabled — backoff handles offline
const PAN_ACTIVE_WINDOW_MS = 30 * 60_000; // retained for isPanRecentlyActive() reference
const TAURI_PORT   = 7790;
const SNAP_PATH    = join(tmpdir(), 'pan-screen-snap.jpg');

let watcherTimer    = null;
let isCapturing     = false;
let captureStartMs  = 0;          // when isCapturing was last set true
const CAPTURE_MAX_MS = 150_000;   // watchdog: reset lock if stuck longer than this
let lastContext     = null; // { description, ts, source }
let lastIdleLog     = 0;

// Backoff state — when vision AI (Ollama) is unreachable, skip captures
// for increasing intervals so we don't hammer a dead endpoint every 60s.
let visionFailStreak   = 0;       // consecutive vision failures
let visionBackoffUntil = 0;       // timestamp when backoff expires
const VISION_BACKOFF_STEPS = [2, 5, 10, 20]; // minutes per failure tier

// ── How long since last mouse/keyboard input (Windows only) ───────────────────
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

// ── PAN activity check — voice/router events in DB are a better "active" signal ──
// Voice-first users may not touch keyboard for hours yet be actively using PAN via phone.
function isPanRecentlyActive() {
  try {
    const windowMin = Math.ceil(PAN_ACTIVE_WINDOW_MS / 60_000);
    const rows = all(
      `SELECT COUNT(*) as cnt FROM events
       WHERE event_type IN ('VoiceCommand','RouterCommand','SessionStart','UserPromptSubmit','MobileSend','DashboardChat')
         AND created_at > datetime('now', '-${windowMin} minutes')`
    );
    return (rows[0]?.cnt || 0) > 0;
  } catch { return false; }
}

// ── Foreground window title (Windows only) ────────────────────────────────────
function getForegroundTitle() {
  try {
    const ps = [
      'Add-Type @"',
      'using System;using System.Runtime.InteropServices;using System.Text;',
      'public class FW{',
      '  [DllImport("user32")]public static extern IntPtr GetForegroundWindow();',
      '  [DllImport("user32")]public static extern int GetWindowText(IntPtr h,StringBuilder b,int n);',
      '}',
      '"@',
      '$h=[FW]::GetForegroundWindow();$b=New-Object System.Text.StringBuilder(512);',
      '[FW]::GetWindowText($h,$b,512)|Out-Null;Write-Output $b.ToString()',
    ].join('\n');
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 3000 }).toString().trim();
  } catch { return ''; }
}

// ── Screenshot via Tauri shell (primary) ──────────────────────────────────────
async function captureViaTauri() {
  const res = await fetch(`http://127.0.0.1:${TAURI_PORT}/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}), // no windowId = full primary monitor
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Tauri screenshot failed: ${res.status}`);
  const json = await res.json();
  // Tauri returns { base64: '...', path: '...' }
  if (!json.base64) throw new Error('Tauri returned no base64 data');
  return json.base64; // already base64, PNG
}

// ── Resize base64 image to 640px wide JPEG for vision inference ───────────────
// Full HD PNG → 640px JPEG cuts CPU inference from >60s to ~10-15s
function resizeForVision(base64Input) {
  try {
    const inputBuf = Buffer.from(base64Input, 'base64');
    const result = spawnSync('ffmpeg', [
      '-i', 'pipe:0',
      '-vf', 'scale=640:-2',
      '-q:v', '5',
      '-vframes', '1',
      '-f', 'image2',
      '-vcodec', 'mjpeg',
      'pipe:1',
    ], { input: inputBuf, windowsHide: true, timeout: 8000, maxBuffer: 10 * 1024 * 1024 });
    if (result.status === 0 && result.stdout?.length > 0) {
      return result.stdout.toString('base64');
    }
  } catch (e) {
    console.warn(`[ScreenWatcher] resize failed: ${e.message}`);
  }
  return base64Input; // fallback: send original
}

// ── Screenshot via FFmpeg gdigrab (fallback) ──────────────────────────────────
function captureViaFFmpeg() {
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'gdigrab', '-i', 'desktop',
      '-vframes', '1',
      '-update', '1',          // required by FFmpeg 8+ for single-frame image output
      '-vf', 'scale=640:-2',
      '-q:v', '5',
      '-y', SNAP_PATH,
    ];
    const proc = spawn('ffmpeg', args, { windowsHide: true, shell: false });
    let stderr = '';
    proc.stderr?.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0 && existsSync(SNAP_PATH)) {
        try { resolve(readFileSync(SNAP_PATH).toString('base64')); }
        catch (e) { reject(new Error(`Read snapshot failed: ${e.message}`)); }
      } else {
        reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-200)}`));
      }
    });
    proc.on('error', e => reject(new Error(`FFmpeg spawn failed: ${e.message}`)));
  });
}

// ── One capture cycle ─────────────────────────────────────────────────────────
async function runCapture() {
  // Watchdog: if lock has been held longer than CAPTURE_MAX_MS, it's a deadlock — reset it.
  if (isCapturing) {
    if (Date.now() - captureStartMs < CAPTURE_MAX_MS) return;
    console.warn(`[ScreenWatcher] ⚠️ Lock held ${Math.round((Date.now()-captureStartMs)/1000)}s — resetting (deadlock)`);
    isCapturing = false;
  }

  // Skip if user has been idle too long — pendant takes over when away.
  // Primary check: recent PAN activity (voice/router events) — more reliable than Windows keyboard idle
  // for voice-first users who never touch the keyboard.
  const idleMs = getIdleMs();
  const panRecentlyActive = isPanRecentlyActive();
  if (!panRecentlyActive && idleMs > IDLE_THRESH) {
    const now = Date.now();
    if (now - lastIdleLog > 5 * 60_000) {
      console.log(`[ScreenWatcher] User idle ${Math.round(idleMs/60000)}m, no PAN activity in ${PAN_ACTIVE_WINDOW_MS/60000}m — skipping (pendant takes priority)`);
      lastIdleLog = now;
    }
    // Clear stale in-memory context so intuition falls back to pendant/other signals
    if (lastContext && (now - lastContext.ts) > STALE_MS) lastContext = null;
    return;
  }

  // Skip if vision AI is in backoff (Ollama unreachable)
  if (Date.now() < visionBackoffUntil) {
    const remainMin = Math.ceil((visionBackoffUntil - Date.now()) / 60_000);
    if (remainMin % 5 === 0) console.log(`[ScreenWatcher] Vision backoff active — ${remainMin}m remaining (mini PC Ollama unreachable)`);
    return;
  }

  isCapturing = true;
  captureStartMs = Date.now();
  try {
    // Grab window title before screenshot (tells AI what app is open)
    const windowTitle = getForegroundTitle();

    let base64;
    let source;

    // Try Tauri shell first (no FFmpeg dependency)
    try {
      base64 = await captureViaTauri();
      source = 'tauri';
    } catch {
      base64 = await captureViaFFmpeg();
      source = 'ffmpeg';
    }

    // Resize to 640px wide JPEG — full HD is too large for CPU vision inference
    base64 = resizeForVision(base64);

    // Note: no quotes around windowTitle — moondream misinterprets double-quote characters
    const titleHint = windowTitle ? `Active window: ${windowTitle.replace(/"/g, '')}. ` : '';
    const description = await analyzeImage(
      `${titleHint}Describe what is on this computer screen in one short sentence.`,
      base64,
      { caller: 'screen-watcher', timeout: 90_000 },  // 90s — CPU inference on mini PC can be slow
    );

    if (description && description.length >= 8) {
      // Success — reset failure streak (< 8 chars = moondream cold-start garbage, treat as failure)
      visionFailStreak = 0;
      visionBackoffUntil = 0;

      const ts = Date.now();
      lastContext = { description, ts, source, windowTitle };

      run(
        `INSERT INTO events (event_type, session_id, data, created_at)
         VALUES (:type, 'system', :data, datetime('now'))`,
        { type: 'screen_context', data: JSON.stringify({ description, ts, source, windowTitle }) }
      );

      console.log(`[ScreenWatcher] (${source}) ${windowTitle ? `[${windowTitle.slice(0,30)}] ` : ''}${description}`);
    }
  } catch (e) {
    // Vision failure — apply backoff so we don't hammer dead Ollama every 60s
    visionFailStreak++;
    const tierIdx = Math.min(visionFailStreak - 1, VISION_BACKOFF_STEPS.length - 1);
    const backoffMin = VISION_BACKOFF_STEPS[tierIdx];
    visionBackoffUntil = Date.now() + backoffMin * 60_000;
    console.warn(`[ScreenWatcher] Vision failed (streak ${visionFailStreak}): ${e.message} — backing off ${backoffMin}m`);
  } finally {
    isCapturing = false;
    try { if (existsSync(SNAP_PATH)) unlinkSync(SNAP_PATH); } catch {}
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startScreenWatcher() {
  if (watcherTimer) return;
  console.log(`[ScreenWatcher] Started — every ${INTERVAL_MS/1000}s (idle skip after ${IDLE_THRESH/60000}min), Tauri→FFmpeg→vision`);
  setTimeout(runCapture, 15_000); // first capture after server fully boots
  watcherTimer = setInterval(runCapture, INTERVAL_MS);
}

export function stopScreenWatcher() {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
    console.log('[ScreenWatcher] Stopped');
  }
}

/** Service status for the dashboard services panel */
export function getScreenWatcherStatus() {
  const running = !!watcherTimer;
  const ctx = lastContext;
  const ageSec = ctx ? Math.round((Date.now() - ctx.ts) / 1000) : null;
  const backoffRemainMs = Math.max(0, visionBackoffUntil - Date.now());
  return {
    running,
    isCapturing,
    visionFailStreak,
    backoffRemainSec: backoffRemainMs > 0 ? Math.ceil(backoffRemainMs / 1000) : 0,
    lastCapture: ctx ? {
      ts: ctx.ts,
      ageSec,
      source: ctx.source,
      windowTitle: ctx.windowTitle,
      description: ctx.description?.slice(0, 80),
    } : null,
  };
}

/** Latest screen context from memory (fast, no DB hit). May be null. */
export function getLatestScreenContext() {
  if (lastContext && (Date.now() - lastContext.ts) < STALE_MS) return lastContext;
  return null;
}

// ── Burst mode — rapid captures during carrier/craft swap ─────────────────────
// Call startBurst() when a swap begins so we can see what the screen looks like
// at each stage (loading, black, reconnected, etc.) rather than waiting 30s.
let burstInterval = null;
let burstTimeout  = null;

export function resetBackoff() {
  if (visionFailStreak > 0 || visionBackoffUntil > 0) {
    console.log(`[ScreenWatcher] Backoff reset (was streak=${visionFailStreak}, backoff expired ${Math.round((visionBackoffUntil - Date.now())/1000)}s from now)`);
  }
  visionFailStreak = 0;
  visionBackoffUntil = 0;
}

export function startBurst(durationMs = 60_000, burstMs = 5_000) {
  // Stop any existing burst
  if (burstInterval) { clearInterval(burstInterval); burstInterval = null; }
  if (burstTimeout)  { clearTimeout(burstTimeout);  burstTimeout  = null; }

  // Reset any vision backoff — burst explicitly wants captures now
  resetBackoff();

  console.log(`[ScreenWatcher] Burst mode: every ${burstMs/1000}s for ${durationMs/1000}s`);
  runCapture(); // immediate first shot
  burstInterval = setInterval(runCapture, burstMs);

  burstTimeout = setTimeout(() => {
    if (burstInterval) { clearInterval(burstInterval); burstInterval = null; }
    burstTimeout = null;
    console.log('[ScreenWatcher] Burst mode ended — resuming normal interval');
  }, durationMs);
}

/** Read latest screen_context from DB — used by intuition.js on startup before
 *  the first in-memory capture has run. */
export function getLatestScreenContextFromDB() {
  try {
    const rows = all(`
      SELECT data, created_at FROM events
      WHERE event_type = 'screen_context'
      ORDER BY id DESC LIMIT 1
    `);
    if (!rows.length) return null;
    const d = JSON.parse(rows[0].data || '{}');
    const age = Date.now() - (d.ts || new Date(rows[0].created_at).getTime());
    if (age < STALE_MS && d.description) return { description: d.description, ts: d.ts || 0, source: d.source };
  } catch {}
  return null;
}
