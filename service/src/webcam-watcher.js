// PAN Webcam Watcher — periodic webcam frame → vision AI → presence + identity signal
//
// Captures from PC webcam (and optionally phone virtual camera) every 60s.
// Detects: presence (is user at desk?), identity (who is it?), emotion/state.
// Feeds into intuition.js as 'webcam_context' events — highest trust for
// "is the user here?" questions since screen activity can be automated.
//
// Cameras (auto-detected via FFmpeg dshow):
//   Primary:   Integrated Webcam
//   Secondary: Pixel 10 Pro (Windows Virtual Camera) — phone as camera source

import { spawn } from 'child_process';
import { join } from 'path';
import { unlinkSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { analyzeImage } from './llm.js';
import { run, get } from './db.js';

const INTERVAL_MS    = 60_000;   // webcam frame every 60s (less aggressive than screen)
const STALE_MS       = 120_000;  // context older than 2min is stale for intuition
const IDLE_THRESH    = 10 * 60_000; // skip if idle >10min (away from desk)
const SNAP_PATH      = join(tmpdir(), 'pan-webcam-snap.jpg');

// Cameras to try in priority order
const CAMERAS = [
  { name: 'Integrated Webcam',                    id: 'integrated' },
  { name: 'Pixel 10 Pro (Windows Virtual Camera)', id: 'pixel-phone' },
];

let watcherTimer  = null;
let isCapturing   = false;
let lastContext   = null; // { presence, identity, emotion, ts, source, camera }
let activeCameraIdx = 0;  // which camera we're currently using

// ── Capture one frame from a named DirectShow camera ─────────────────────────
function captureFrame(cameraName) {
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'dshow',
      '-i', `video=${cameraName}`,
      '-vframes', '1',
      '-vf', 'scale=640:-1',   // keep it small — just need face, not 4K
      '-q:v', '3',
      '-y', SNAP_PATH,
    ];
    const proc = spawn('ffmpeg', args, { windowsHide: true, shell: false });
    let stderr = '';
    proc.stderr?.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0 && existsSync(SNAP_PATH)) {
        try { resolve(readFileSync(SNAP_PATH).toString('base64')); }
        catch (e) { reject(new Error(`Read frame failed: ${e.message}`)); }
      } else {
        reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-200)}`));
      }
    });
    proc.on('error', e => reject(new Error(`FFmpeg spawn: ${e.message}`)));
  });
}

// ── One capture cycle ─────────────────────────────────────────────────────────
async function runCapture() {
  if (isCapturing) return;
  isCapturing = true;

  try {
    // Try cameras in order, fall back on error
    let base64 = null;
    let usedCamera = null;

    for (let i = 0; i < CAMERAS.length; i++) {
      const cam = CAMERAS[(activeCameraIdx + i) % CAMERAS.length];
      try {
        base64 = await captureFrame(cam.name);
        usedCamera = cam;
        activeCameraIdx = (activeCameraIdx + i) % CAMERAS.length;
        break;
      } catch (e) {
        console.warn(`[WebcamWatcher] ${cam.name} failed: ${e.message.slice(0, 80)}`);
      }
    }

    if (!base64 || !usedCamera) {
      console.warn('[WebcamWatcher] All cameras failed — skipping cycle');
      return;
    }

    const result = await analyzeImage(
      'Look at this webcam frame and answer in JSON:\n' +
      '{"presence": "yes|no|unclear", "identity": "Tzuri|unknown|empty", ' +
      '"emotion": "focused|relaxed|tired|stressed|happy|neutral|away", ' +
      '"people_count": 0, "note": "one short observation"}\n\n' +
      'Rules: presence=yes only if a person is clearly visible. ' +
      'identity=Tzuri if you recognize the user (young man, home office). ' +
      'emotion from face/posture. people_count = total visible people. ' +
      'note = one detail (glasses on, leaning back, looking away, etc). ' +
      'Reply with ONLY the JSON object, no other text.',
      base64,
      { caller: 'webcam-watcher', timeout: 15_000 },
    );

    // Parse the JSON response
    let parsed = {};
    try {
      const jsonMatch = (result || '').match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch { parsed = { presence: 'unclear', raw: result }; }

    const ts = Date.now();
    lastContext = { ...parsed, ts, camera: usedCamera.id };

    run(
      `INSERT INTO events (event_type, session_id, data, created_at)
       VALUES (:type, NULL, :data, datetime('now'))`,
      { type: 'webcam_context', data: JSON.stringify({ ...parsed, ts, camera: usedCamera.id }) }
    );

    const presenceTag = parsed.presence === 'yes' ? '👤' : parsed.presence === 'no' ? '🪑' : '❓';
    console.log(`[WebcamWatcher] (${usedCamera.id}) ${presenceTag} presence=${parsed.presence} identity=${parsed.identity ?? '?'} emotion=${parsed.emotion ?? '?'}${parsed.note ? ` · ${parsed.note}` : ''}`);

  } catch (e) {
    console.warn(`[WebcamWatcher] cycle error: ${e.message}`);
  } finally {
    isCapturing = false;
    try { if (existsSync(SNAP_PATH)) unlinkSync(SNAP_PATH); } catch {}
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startWebcamWatcher() {
  if (watcherTimer) return;
  console.log(`[WebcamWatcher] Started — every ${INTERVAL_MS / 1000}s · cameras: ${CAMERAS.map(c => c.name).join(', ')}`);
  setTimeout(runCapture, 20_000); // first capture 20s after boot (let screen watcher go first)
  watcherTimer = setInterval(runCapture, INTERVAL_MS);
}

export function stopWebcamWatcher() {
  if (watcherTimer) { clearInterval(watcherTimer); watcherTimer = null; }
}

export function getWebcamContext() {
  if (!lastContext) return null;
  const age = Date.now() - lastContext.ts;
  if (age > STALE_MS) return null;
  return { ...lastContext, ageMs: age };
}

export function getWebcamStatus() {
  return {
    running: !!watcherTimer,
    lastCapture: lastContext
      ? { ageMs: Date.now() - lastContext.ts, ...lastContext }
      : null,
    cameras: CAMERAS,
    activeCameraIdx,
  };
}
