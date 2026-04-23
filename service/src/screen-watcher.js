// PAN Screen Watcher — periodic screenshot → vision AI → activity signal for intuition.js
// Uses FFmpeg gdigrab (already used by screen-recorder.js) to grab a single JPEG frame
// every 30s, runs it through analyzeImage(), stores result as 'screen_context' event.
// intuition.js reads the latest event as the highest-priority activity signal.

import { spawn } from 'child_process';
import { join } from 'path';
import { unlinkSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { analyzeImage } from './llm.js';
import { insert, all } from './db.js';

const INTERVAL_MS  = 30_000;  // screenshot every 30s
const STALE_MS     = 90_000;  // context older than 90s is ignored by intuition
const SNAP_PATH    = join(tmpdir(), 'pan-screen-snap.jpg');

let watcherTimer  = null;
let isCapturing   = false;
let lastContext   = null; // { description, ts }

// ── Screenshot via FFmpeg gdigrab ─────────────────────────────────────────────
function captureScreen() {
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'gdigrab',
      '-i', 'desktop',
      '-vframes', '1',
      '-vf', 'scale=1280:-1',   // resize width to 1280, keep aspect ratio
      '-q:v', '4',              // JPEG quality (lower = better, 4 is fast + readable)
      '-y',
      SNAP_PATH,
    ];

    const proc = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';
    proc.stderr?.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0 && existsSync(SNAP_PATH)) {
        try {
          resolve(readFileSync(SNAP_PATH));
        } catch (e) {
          reject(new Error(`Failed to read snapshot: ${e.message}`));
        }
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
  isCapturing = true;
  try {
    const imgBuf = await captureScreen();
    const base64 = imgBuf.toString('base64');

    const description = await analyzeImage(
      'In 1-2 sentences, what is the user currently doing on their computer? ' +
      'Be specific about the application and task — e.g. "Playing Fortnite", ' +
      '"Writing Node.js code in VS Code", "Browsing Discord in the vibecoding server", ' +
      '"Watching a YouTube video". If you can see text, a project name, or a game title, include it.',
      base64,
      { caller: 'screen-watcher', timeout: 20_000 },
    );

    if (description) {
      const ts = Date.now();
      lastContext = { description, ts };

      // Persist so intuition.js can read it even after a process restart
      insert('events', {
        event_type: 'screen_context',
        session_id: null,
        data: JSON.stringify({ description, ts }),
        created_at: new Date().toISOString(),
      });

      console.log(`[ScreenWatcher] ${description}`);
    }
  } catch (e) {
    // Vision unavailable (Ollama down, no API key) — log quietly and keep trying
    console.warn(`[ScreenWatcher] capture skipped: ${e.message}`);
  } finally {
    isCapturing = false;
    try { if (existsSync(SNAP_PATH)) unlinkSync(SNAP_PATH); } catch {}
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startScreenWatcher() {
  if (watcherTimer) return;
  console.log('[ScreenWatcher] Started — capturing every 30s via FFmpeg gdigrab');
  // First capture after 15s so the server can fully boot first
  setTimeout(runCapture, 15_000);
  watcherTimer = setInterval(runCapture, INTERVAL_MS);
}

export function stopScreenWatcher() {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
    console.log('[ScreenWatcher] Stopped');
  }
}

/** Latest screen context from memory (fast, no DB hit). May be null. */
export function getLatestScreenContext() {
  if (lastContext && (Date.now() - lastContext.ts) < STALE_MS) return lastContext;
  return null;
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
    if (age < STALE_MS && d.description) return { description: d.description, ts: d.ts || 0 };
  } catch {}
  return null;
}
