// PAN Screen Watcher — periodic screenshot → vision AI → activity signal for intuition.js
//
// Uses the PAN Tauri shell (port 7790) which has xcap built-in for screen capture.
// Every 30s: POST /screenshot to Tauri → base64 PNG → analyzeImage() → 'screen_context' event.
// intuition.js reads the latest event as the highest-priority activity signal.
//
// Falls back to FFmpeg gdigrab if Tauri shell is not running.

import { spawn, execFileSync } from 'child_process';
import { join } from 'path';
import { unlinkSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { analyzeImage } from './llm.js';
import { run, all } from './db.js';

const INTERVAL_MS  = 30_000;   // screenshot every 30s when active
const STALE_MS     = 90_000;   // context older than 90s ignored by intuition
const IDLE_THRESH  = 5 * 60_000; // user is "away" after 5 min no input
const TAURI_PORT   = 7790;
const SNAP_PATH    = join(tmpdir(), 'pan-screen-snap.jpg');

let watcherTimer  = null;
let isCapturing   = false;
let lastContext   = null; // { description, ts, source }
let lastIdleLog   = 0;

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

// ── Screenshot via FFmpeg gdigrab (fallback) ──────────────────────────────────
function captureViaFFmpeg() {
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'gdigrab', '-i', 'desktop',
      '-vframes', '1',
      '-vf', 'scale=1280:-1',
      '-q:v', '4',
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
  if (isCapturing) return;

  // Skip if user has been idle too long — pendant takes over when away
  const idleMs = getIdleMs();
  if (idleMs > IDLE_THRESH) {
    const now = Date.now();
    if (now - lastIdleLog > 5 * 60_000) {
      console.log(`[ScreenWatcher] User idle ${Math.round(idleMs/60000)}m — skipping capture (pendant context takes priority)`);
      lastIdleLog = now;
    }
    // Clear stale in-memory context so intuition falls back to pendant/other signals
    if (lastContext && (now - lastContext.ts) > STALE_MS) lastContext = null;
    return;
  }

  isCapturing = true;
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

    const titleHint = windowTitle ? `Active window: "${windowTitle}"\n\n` : '';
    const description = await analyzeImage(
      `${titleHint}What is the user currently doing on their computer? ` +
      'Reply in 1 concise sentence (max 15 words). Be specific — name the app, game, or site. ' +
      'Examples: "Playing League of Legends", "Writing code in VS Code", ' +
      '"Watching YouTube", "Browsing Discord in the vibecoding server", ' +
      '"Idle at desktop". If you can see a game/project/video title, include it.',
      base64,
      { caller: 'screen-watcher', timeout: 20_000 },
    );

    if (description) {
      const ts = Date.now();
      lastContext = { description, ts, source, windowTitle };

      run(
        `INSERT INTO events (event_type, session_id, data, created_at)
         VALUES (:type, NULL, :data, datetime('now'))`,
        { type: 'screen_context', data: JSON.stringify({ description, ts, source, windowTitle }) }
      );

      console.log(`[ScreenWatcher] (${source}) ${windowTitle ? `[${windowTitle.slice(0,30)}] ` : ''}${description}`);
    }
  } catch (e) {
    console.warn(`[ScreenWatcher] capture skipped: ${e.message}`);
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
  return {
    running,
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

export function startBurst(durationMs = 60_000, burstMs = 5_000) {
  // Stop any existing burst
  if (burstInterval) { clearInterval(burstInterval); burstInterval = null; }
  if (burstTimeout)  { clearTimeout(burstTimeout);  burstTimeout  = null; }

  console.log(`[ScreenWatcher] 🔵 Burst mode: every ${burstMs/1000}s for ${durationMs/1000}s`);
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
