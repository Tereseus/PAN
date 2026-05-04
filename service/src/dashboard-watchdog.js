// PAN Dashboard Watchdog — detects stuck/black loading screen and auto-recovers.
//
// Strategy: poll the Tauri screenshot every POLL_MS. If avg pixel brightness
// is below threshold for STUCK_STRIKES consecutive polls → dashboard is stuck
// → trigger Craft swap as recovery.
//
// This approach needs no WS hooks (which live in Carrier and can't be swapped).
// Target: user back in dashboard within ~20s of any stuck load.

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const POLL_MS              = 10_000;  // check every 10s
const BRIGHTNESS_THRESHOLD = 20;      // 0-255 actual pixel value; below = mostly black
const STUCK_STRIKES        = 2;       // consecutive black frames before recovery
const TAURI_PORT           = 7790;
const RECOVERY_URL         = 'http://127.0.0.1:7777/api/carrier/swap';
// Cooldown file lets a freshly-spawned Craft inherit the recovering flag so it
// doesn't immediately re-trigger a swap (doom loop prevention).
const COOLDOWN_FILE        = join(tmpdir(), 'pan-watchdog-cooldown.json');
const COOLDOWN_MS          = 60_000;  // 60s — generous enough to survive the reload cycle

let pollTimer   = null;
let strikeCount = 0;
let recovering  = false;

// ── Public API ────────────────────────────────────────────────────────────────

export function startWatchdog() {
  if (pollTimer) return;

  // Inherit cooldown from previous Craft so a fresh spawn doesn't immediately
  // re-trigger a swap (fixes the doom loop: recovering flag lives in-process and
  // resets to false when a new Craft starts).
  try {
    const data = JSON.parse(readFileSync(COOLDOWN_FILE, 'utf8'));
    const elapsed = Date.now() - (data.triggeredAt || 0);
    if (elapsed < COOLDOWN_MS) {
      recovering = true;
      const remaining = COOLDOWN_MS - elapsed;
      console.log(`[Watchdog] Inherited cooldown from previous Craft — ${Math.round(remaining / 1000)}s remaining`);
      setTimeout(() => { recovering = false; }, remaining);
    }
  } catch {} // file absent or stale — start clean

  pollTimer = setInterval(runPoll, POLL_MS);
  console.log(`[Watchdog] Started — checking every ${POLL_MS/1000}s, threshold=${BRIGHTNESS_THRESHOLD}`);
}

export function stopWatchdog() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// Called from inject-context (successful load) — resets the strike counter
export function notifyDashboardLoaded() {
  if (strikeCount > 0) console.log(`[Watchdog] Dashboard loaded — resetting strike counter`);
  strikeCount = 0;
  recovering  = false;
  // Clear cooldown file so subsequent Crafts don't inherit a stale cooldown
  try { unlinkSync(COOLDOWN_FILE); } catch {}
}

// ── Poll cycle ────────────────────────────────────────────────────────────────

async function runPoll() {
  // DISABLED: brightness-based black-screen detection is neutered until the root
  // cause of the genuine black render is understood. The watchdog process stays
  // alive for cooldown bookkeeping (notifyDashboardLoaded / cooldown file), but
  // will never trigger a swap. Re-enable by removing this early return.
  return;

  if (recovering) return; // don't pile up recovery triggers

  try {
    const base64     = await captureFrame();
    const brightness = averageBrightness(base64);

    if (brightness < BRIGHTNESS_THRESHOLD) {
      strikeCount++;
      console.warn(`[Watchdog] Black screen detected (brightness=${brightness.toFixed(1)}) — strike ${strikeCount}/${STUCK_STRIKES}`);

      if (strikeCount >= STUCK_STRIKES) {
        console.warn(`[Watchdog] Dashboard stuck — triggering recovery`);
        recovering = true;
        strikeCount = 0;
        await triggerRecovery();
      }
    } else {
      if (strikeCount > 0) console.log(`[Watchdog] Screen OK (brightness=${brightness.toFixed(1)}) — resetting`);
      strikeCount = 0;
    }
  } catch {
    // Tauri not running (browser mode) — silently skip
  }
}

// ── Capture + brightness ──────────────────────────────────────────────────────

async function captureFrame() {
  // Pass windowId so Tauri crops to the PAN window rather than sampling the full
  // desktop (which averages dark desktop/taskbar/other apps and false-trips at ~18).
  const res = await fetch(`http://127.0.0.1:${TAURI_PORT}/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ windowId: 'main' }),
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) throw new Error(`Tauri ${res.status}`);
  const json = await res.json();
  if (!json.base64) throw new Error('no base64');
  return json.base64;
}

function averageBrightness(base64) {
  // Decode the compressed image (PNG or JPEG) to actual raw pixels via ffmpeg.
  // Sampling raw compressed bytes is WRONG — deflate data averages ~128 regardless
  // of image content. We need real pixel values.
  try {
    const inputBuf = Buffer.from(base64, 'base64');
    const result = spawnSync('ffmpeg', [
      '-i', 'pipe:0',
      '-vf', 'scale=120:-2',   // downsample to 120px wide — fast, enough for brightness
      '-f', 'rawvideo',
      '-pix_fmt', 'gray',      // single luminance channel (0=black, 255=white)
      'pipe:1',
    ], { input: inputBuf, windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 });

    if (result.status === 0 && result.stdout?.length > 0) {
      const pixels = result.stdout;
      let sum = 0;
      for (let i = 0; i < pixels.length; i++) sum += pixels[i];
      return sum / pixels.length;
    }
  } catch {}
  return 128; // safe fallback — don't trigger recovery on error
}

// ── Recovery ──────────────────────────────────────────────────────────────────

async function triggerRecovery() {
  // Write cooldown file BEFORE the swap so the incoming Craft sees it immediately
  // and starts with recovering=true, breaking the doom loop.
  try { writeFileSync(COOLDOWN_FILE, JSON.stringify({ triggeredAt: Date.now() })); } catch {}
  try {
    const res  = await fetch(RECOVERY_URL, { method: 'POST', signal: AbortSignal.timeout(10_000) });
    const data = await res.json();
    console.log(`[Watchdog] Swap triggered: ${JSON.stringify(data)}`);
    // Give the swap 30s to complete before polling resumes in this Craft
    // (new Craft will also inherit the cooldown via the file above).
    setTimeout(() => { recovering = false; }, 30_000);
  } catch (e) {
    console.error(`[Watchdog] Recovery failed: ${e.message}`);
    recovering = false;
  }
}
