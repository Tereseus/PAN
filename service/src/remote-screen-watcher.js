// PAN Remote Screen Watcher
// Every 60s: for each trusted connected PC client → request screenshot → vision AI → upsertDevicePresence
// Mirrors what screen-watcher.js does for the hub, but for remote pan-client devices.

import { getConnectedClients, sendToClient } from './client-manager.js';
import { analyzeImage } from './llm.js';
import { upsertDevicePresence } from './intuition.js';
import { isDeviceCaptureOn } from './capture-consent.js';
import { spawn } from 'child_process';

const INTERVAL_MS   = 60_000;
const TIMEOUT_MS    = 25_000;  // screenshot + vision must complete within this
const FFMPEG_TIMEOUT_MS = 8000;
let   timer         = null;
const inFlight      = new Set(); // device_ids currently being captured

// Resize base64 image to 640px wide JPEG (same as screen-watcher.js)
// async — see screen-watcher.js for the loop-blocking explanation.
function resizeForVision(base64Input) {
  return new Promise((resolve) => {
    let done = false;
    let proc;
    const finish = (b64) => { if (done) return; done = true; try { proc?.kill('SIGKILL'); } catch {} resolve(b64); };
    try {
      const inputBuf = Buffer.from(base64Input, 'base64');
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
        finish(code === 0 && chunks.length ? Buffer.concat(chunks).toString('base64') : base64Input);
      });
      proc.stdin.on('error', () => {});
      proc.stdin.end(inputBuf);
      setTimeout(() => finish(base64Input), FFMPEG_TIMEOUT_MS);
    } catch {
      finish(base64Input);
    }
  });
}

async function captureDevice(client) {
  const { device_id, name, platform } = client;
  if (inFlight.has(device_id)) return; // previous capture still running
  inFlight.add(device_id);
  try {
    const result = await sendToClient(device_id, 'screenshot', {}, TIMEOUT_MS);
    if (!result?.data) return;

    const resized = await resizeForVision(result.data);
    const description = await analyzeImage(
      'Describe what is on this computer screen in one short sentence.',
      resized,
      // 180s timeout → 60s vision budget. Same reasoning as screen-watcher.js:
      // minicpm-v needs more CPU inference time than the old moondream default.
      { caller: `remote-screen-watcher:${device_id}`, timeout: 180_000 },
    );

    if (description) {
      upsertDevicePresence({
        device_id,
        activity:      description,
        screen_title:  null,
        confidence:    85,
        platform:      platform || null,
      });
      console.log(`[RemoteScreen] ${name || device_id}: ${description}`);
    }
  } catch (e) {
    // sendToClient throws on timeout — normal if machine is idle/locked
    if (!e.message?.includes('timeout') && !e.message?.includes('Timeout')) {
      console.warn(`[RemoteScreen] ${name || device_id}: ${e.message}`);
    }
  } finally {
    inFlight.delete(device_id);
  }
}

async function tick() {
  const clients = getConnectedClients().filter(c =>
    c.trusted &&
    c.online &&
    Array.isArray(c.capabilities) && c.capabilities.includes('screenshot') &&
    // Per-device capture consent — user can turn a device off to save its
    // battery. Defaults ON, so this only excludes devices explicitly opted out.
    isDeviceCaptureOn(c.device_id, 'screen')
  );

  // Fire captures in parallel — each is independently guarded by inFlight
  await Promise.allSettled(clients.map(captureDevice));
}

export function startRemoteScreenWatcher() {
  if (timer) return;
  console.log('[RemoteScreen] Started — polling connected clients every 60s');
  // Stagger first run by 15s so it doesn't compete with hub screen-watcher on boot
  setTimeout(() => {
    tick();
    timer = setInterval(tick, INTERVAL_MS);
  }, 15_000);
}

export function stopRemoteScreenWatcher() {
  if (timer) { clearInterval(timer); timer = null; }
}
