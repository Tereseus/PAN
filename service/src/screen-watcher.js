// PAN Screen Watcher — periodic screenshot → vision AI → activity signal for intuition.js
//
// Uses the PAN Tauri shell (port 7790) which has xcap built-in for screen capture.
// Every 30s: POST /screenshot to Tauri → base64 PNG → analyzeImage() → 'screen_context' event.
// intuition.js reads the latest event as the highest-priority activity signal.
//
// Falls back to FFmpeg gdigrab if Tauri shell is not running.

import { spawn, execFile } from 'child_process';
import { join } from 'path';
import { unlinkSync, readFileSync, existsSync } from 'fs';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
import { tmpdir } from 'os';
import { analyzeImage } from './llm.js';
import { run, all } from './db.js';
import { writeThought, recentThoughtMatches } from './thoughts.js';
import { noteFoodInScreenDescription } from './intuition/nourishment.js';
import { noteSignalsInScreenDescription } from './intuition/signals.js';

const INTERVAL_MS  = 120_000;  // screenshot every 120s (was 60s — minicpm-v needs more headroom + Ollama keep-alive can't keep the 5.5GB model loaded perfectly between every-60s polls).
const STALE_MS     = 240_000;  // context older than 240s ignored by intuition
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
// async — previously execFileSync blocked the event loop for the full PowerShell
// cold-start (~700-1500ms), which compounded with FFmpeg/PowerShell stalls
// elsewhere in the cycle to produce multi-minute event-loop freezes that made
// the dashboard unusable. The 3-second timeout on execFileSync was a paper
// shield: when PowerShell hangs in COM init (a real Windows pathology), the
// kill never reaches it and we wait the full system timeout.
async function getIdleMs() {
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
    const { stdout } = await execFileAsync(
      'powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 3000, killSignal: 'SIGKILL' }
    );
    return parseInt(stdout.toString().trim()) || 0;
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
// async for same reason as getIdleMs() — sync PowerShell starts froze the loop.
async function getForegroundTitle() {
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
    const { stdout } = await execFileAsync(
      'powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 3000, killSignal: 'SIGKILL' }
    );
    return stdout.toString().trim();
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
// Full HD PNG → 640px JPEG cuts CPU inference from >60s to ~10-15s.
//
// **NIGHTMARE BUG ROOT CAUSE (#NEW-9):** previously this used spawnSync. When
// the FFmpeg subprocess hung (and it did, repeatedly — observed exit code
// 4294967274 / NULL pointer deref on certain PNG inputs), spawnSync blocked
// the Node event loop for the full duration of the hang. Carrier-log
// evidence: a 178-second event-loop block whose start ALWAYS coincided with
// `[ScreenWatcher] Vision failed: FFmpeg exited 4294967274`. The ScreenWatcher
// lock watchdog (CAPTURE_MAX_MS=150_000) cleared the in-app flag, but the
// underlying spawnSync had already pinned the loop for the full 178s.
//
// Now: spawn(), pipe stdin/stdout, race against a real abort-on-timeout. The
// FFmpeg child is killed AND the promise rejects within FFMPEG_TIMEOUT_MS no
// matter what state the subprocess is in. Even if FFmpeg refuses SIGTERM, the
// promise resolves on the timer and the rest of the screen-watch cycle
// continues — the event loop is never blocked beyond Promise scheduling.
const FFMPEG_TIMEOUT_MS = 8000;
function resizeForVision(base64Input) {
  return new Promise((resolve) => {
    const inputBuf = Buffer.from(base64Input, 'base64');
    let done = false;
    let proc;
    const finish = (b64) => { if (done) return; done = true; try { proc?.kill('SIGKILL'); } catch {} resolve(b64); };
    try {
      proc = spawn('ffmpeg', [
        '-i', 'pipe:0',
        '-vf', 'scale=640:-2',
        '-q:v', '5',
        '-vframes', '1',
        '-f', 'image2',
        '-vcodec', 'mjpeg',
        'pipe:1',
      ], { windowsHide: true, shell: false });
      const chunks = [];
      let bytes = 0;
      const MAX = 10 * 1024 * 1024;
      proc.stdout.on('data', (c) => {
        bytes += c.length;
        if (bytes > MAX) { finish(base64Input); return; }
        chunks.push(c);
      });
      proc.on('error', () => finish(base64Input));
      proc.on('close', (code) => {
        if (code === 0 && chunks.length) finish(Buffer.concat(chunks).toString('base64'));
        else finish(base64Input);
      });
      // Write input asynchronously, ignore EPIPE if the process already died.
      proc.stdin.on('error', () => {});
      proc.stdin.end(inputBuf);
      setTimeout(() => {
        if (!done) {
          console.warn('[ScreenWatcher] ffmpeg resize timed out — using original PNG');
          finish(base64Input);
        }
      }, FFMPEG_TIMEOUT_MS);
    } catch (e) {
      console.warn(`[ScreenWatcher] resize spawn failed: ${e.message}`);
      finish(base64Input);
    }
  });
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
  const idleMs = await getIdleMs();
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
    const windowTitle = await getForegroundTitle();

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
    base64 = await resizeForVision(base64);

    // No title hint in moondream prompt — it garbles window names (generates URN/UUID-like garbage).
    // windowTitle is stored separately in the event data.
    const description = await analyzeImage(
      'Describe what is on this computer screen in one short sentence.',
      base64,
      // 360_000ms → 120s overall vision budget (timeout / 3). Measured wall
      // times for minicpm-v:latest on the Mini-PC (5.5GB model, CPU
      // inference): 100-110s cold (~80s of which is model load), 25-30s
      // warm. Ollama's keep_alive=-1 is set in analyzeImage but in practice
      // Ollama still evicts when other models are queried, so we have to
      // budget for occasional cold-starts. Trading 60s extra wall budget
      // for accurate descriptions vs. the moondream hallucinations.
      { caller: 'screen-watcher', timeout: 360_000 },
    );

    // Moondream cold-start failure modes:
    //   1. <8 char output (treat as fail)
    //   2. URN/UUID/URL-only output — model latches onto window title hints
    //      or text on screen and emits garbage like
    //      "Urn:le/example.org/multi/light/1.3.3.0" or just a bare URL.
    //   3. Output that's mostly punctuation/identifiers and no real words.
    // Reject all of those — they pollute the activity signal in intuition
    // and surface as nonsense in the dashboard.
    function looksLikeVisionGarbage(desc) {
      if (!desc) return true;
      const trimmed = desc.trim();
      if (trimmed.length < 8) return true;
      // URN / UUID-like prefixes — case-insensitive
      if (/^(urn:|uuid:|cid:|did:|isbn:|oid:)/i.test(trimmed)) return true;
      // Bare URL with no surrounding prose
      if (/^https?:\/\/\S+$/i.test(trimmed)) return true;
      // Mostly path/identifier syntax (slashes, colons, dots, digits, no words)
      const wordChars = (trimmed.match(/[a-zA-Z]{3,}/g) || []).join('').length;
      if (wordChars < trimmed.length * 0.3) return true;
      return false;
    }
    if (description && !looksLikeVisionGarbage(description)) {
      // Success — reset failure streak (< 8 chars or URN-like = moondream cold-start garbage, treat as failure)
      visionFailStreak = 0;
      visionBackoffUntil = 0;

      const ts = Date.now();
      lastContext = { description, ts, source, windowTitle };

      run(
        `INSERT INTO events (event_type, session_id, data, created_at)
         VALUES (:type, 'system', :data, datetime('now'))`,
        { type: 'screen_context', data: JSON.stringify({ description, ts, source, windowTitle }) }
      );

      // PAN's-Mind thought — phrase the vision verdict in first person. Skip
      // near-duplicates within 90s so a static screen doesn't spam the stream.
      try {
        const thought = `I see ${description.replace(/^(this |the |a |an )?(image |screen |computer screen )?(shows |displays |is )?/i, '').replace(/\.$/, '')}.`;
        if (!recentThoughtMatches('screen', thought, 90_000)) {
          writeThought('screen', thought, { window: windowTitle || null }, 0.3);
        }
      } catch { /* non-fatal */ }

      // Life Needs — weak Nourishment signal if the vision description
      // mentions food/drink. Strong "user actually ate" signal goes through
      // router.js (explicit utterances). See intuition/nourishment.js.
      try {
        const r = noteFoodInScreenDescription(description, { source: 'screen-watcher' });
        if (r.applied) console.log(`[ScreenWatcher] 🍽 nourishment observed: ${r.matched.slice(0, 3).join(', ')}`);
      } catch { /* non-fatal */ }

      // Other Life Needs visible in vision (currently Hydration via drinkware).
      try {
        const r = noteSignalsInScreenDescription(description, { source: 'screen-watcher' });
        for (const a of r.applied || []) {
          console.log(`[ScreenWatcher] 💧 ${a.need} observed: ${a.term}`);
        }
      } catch { /* non-fatal */ }

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
