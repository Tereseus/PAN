// PAN mic-router — symmetric to speak-router.js
//
// One entry point: listenSomewhere({ duration_ms, target, transcribe, fallback })
//
// Routing decision order is identical to speak-router so the mic ends up on
// the same device the user is in front of (and would have spoken to):
//   1. Explicit `target` device → try it first.
//   2. Highest-confidence recent device_presence (within 60s, confidence >= 50).
//   3. Most recent foreground activity_events device (within 30s).
//   4. Last device that submitted a voice command (recent ai_usage, 120s).
//   5. Most recently heart-beating client device.
//   6. Browser-dashboard mic (if a dashboard WS is open).
//   7. Phone push channel (devicePushSockets, device_type='phone').
//
// Push-to-talk by default: caller specifies `duration_ms`, client records that
// long, returns WAV bytes (base64) in the WS result. Server then optionally
// pipes through the existing whisper pipeline at /api/v1/whisper.
//
// Returns: { ok, device, strategy, via, audio_b64?, text?, seconds?, error? }

import { all } from './db.js';
import { sendToClient, getConnectedClients } from './client-manager.js';
import { devicePushSockets, pushToDevice } from './server.js';

const PRESENCE_WINDOW_MS  = 60_000;
const ACTIVITY_WINDOW_MS  = 30_000;
const VOICE_WINDOW_MS     = 120_000;
const DEFAULT_DURATION_MS = 5_000;
const MAX_DURATION_MS     = 30_000;

function isOnline(deviceId) {
  if (!deviceId) return false;
  const list = getConnectedClients();
  return list.some(c => c.device_id === deviceId && c.online && c.trusted);
}

function pickPresenceDevice() {
  const cutoff = Date.now() - PRESENCE_WINDOW_MS;
  let rows = [];
  try {
    rows = all(
      `SELECT device_id, confidence, as_of
         FROM device_presence
        WHERE as_of >= :c AND confidence >= 50
        ORDER BY confidence DESC, as_of DESC
        LIMIT 10`,
      { ':c': cutoff }
    );
  } catch { return null; }
  for (const r of rows) if (isOnline(r.device_id)) return r.device_id;
  return null;
}

function pickActivityDevice() {
  let rows = [];
  try {
    rows = all(
      `SELECT device_id, created_at
         FROM activity_events
        WHERE device_id IS NOT NULL
          AND created_at >= datetime('now','localtime', :w)
        ORDER BY created_at DESC
        LIMIT 10`,
      { ':w': `-${Math.round(ACTIVITY_WINDOW_MS / 1000)} seconds` }
    );
  } catch { return null; }
  for (const r of rows) if (isOnline(r.device_id)) return r.device_id;
  return null;
}

function pickRecentVoiceSourceDevice() {
  let rows = [];
  try {
    rows = all(
      `SELECT caller, created_at
         FROM ai_usage
        WHERE caller IS NOT NULL
          AND created_at >= datetime('now','localtime', :w)
        ORDER BY created_at DESC
        LIMIT 20`,
      { ':w': `-${Math.round(VOICE_WINDOW_MS / 1000)} seconds` }
    );
  } catch { return null; }
  for (const r of rows) {
    const caller = String(r.caller || '');
    const m = caller.match(/^(?:phone|desktop|client)[-_:](.+)$/i);
    const candidate = m ? m[1] : caller;
    if (isOnline(candidate)) return candidate;
  }
  return null;
}

function pickRecentHeartbeatDevice() {
  const clients = getConnectedClients()
    .filter(c => c.online && c.trusted && c.last_heartbeat)
    .sort((a, b) => String(b.last_heartbeat).localeCompare(String(a.last_heartbeat)));
  return clients[0]?.device_id || null;
}

function pickPhoneDevice() {
  for (const [device_id, ws] of devicePushSockets) {
    if (ws.deviceType === 'phone' && ws.readyState === 1) return device_id;
  }
  return null;
}

export function pickMicDevice(opts = {}) {
  const { target, exclude = [] } = opts;
  const blocked = new Set(exclude);

  if (target && !blocked.has(target) && isOnline(target)) {
    return { device: target, strategy: 'target' };
  }

  for (const [strategy, fn] of [
    ['presence', pickPresenceDevice],
    ['activity', pickActivityDevice],
    ['voice_src', pickRecentVoiceSourceDevice],
    ['recent', pickRecentHeartbeatDevice],
  ]) {
    const d = fn();
    if (d && !blocked.has(d)) return { device: d, strategy };
  }

  const phone = pickPhoneDevice();
  if (phone && !blocked.has(phone)) return { device: phone, strategy: 'phone', via: 'push' };

  return { device: null, strategy: 'none' };
}

/**
 * Record audio on the best available device.
 * @param {object} opts
 * @param {number} [opts.duration_ms=5000]  Push-to-talk window (capped at 30s).
 * @param {string} [opts.target]            Preferred device id.
 * @param {boolean} [opts.transcribe=true]  Pipe through whisper after capture.
 * @param {string}  [opts.sample_rate=16000]
 * @param {boolean} [opts.fallback=true]
 * @returns {Promise<{ok,device,strategy,via,audio_b64?,text?,seconds?,error?}>}
 */
export async function listenSomewhere(opts = {}) {
  const {
    target,
    transcribe = true,
    sample_rate = 16000,
    fallback = true,
  } = opts;
  let duration_ms = Number(opts.duration_ms) || DEFAULT_DURATION_MS;
  if (duration_ms < 500) duration_ms = 500;
  if (duration_ms > MAX_DURATION_MS) duration_ms = MAX_DURATION_MS;

  const exclude = [];
  let lastError = null;

  // Up to 5 attempts: target → presence → activity → voice_src → recent.
  for (let attempt = 0; attempt < 5; attempt++) {
    const choice = pickMicDevice({ target: attempt === 0 ? target : undefined, exclude });
    if (!choice.device) break;

    // Phone push path — fire-and-forget, no result returned via WS.
    // Phone records locally and pushes transcript via /api/v1/terminal/send.
    if (choice.strategy === 'phone' || choice.via === 'push') {
      const ok = pushToDevice(choice.device, {
        type: 'listen',
        duration_ms,
        sample_rate,
      });
      if (ok) return { ok: true, device: choice.device, strategy: choice.strategy, via: 'push', mode: 'fire-and-forget' };
      exclude.push(choice.device);
      lastError = 'phone push failed';
      continue;
    }

    // pan-client desktop/server: audio_capture command via WS or HTTP queue.
    try {
      // Total timeout = duration + 5s slack for ffmpeg startup/encode/upload.
      const result = await sendToClient(
        choice.device,
        'audio_capture',
        { duration_ms, sample_rate },
        duration_ms + 5000,
      );

      const audio_b64 = result?.audio_b64;
      const seconds  = result?.seconds;
      if (!audio_b64) {
        lastError = result?.error || 'no audio returned';
        exclude.push(choice.device);
        if (!fallback) break;
        continue;
      }

      let text = null;
      if (transcribe) {
        try {
          const buf = Buffer.from(audio_b64, 'base64');
          const port = process.env.PAN_PORT || 7777;
          const res = await fetch(`http://127.0.0.1:${port}/api/v1/whisper`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: buf,
            signal: AbortSignal.timeout(20000),
          });
          const j = await res.json();
          if (j?.ok && j.text) text = j.text;
        } catch (e) {
          // transcript optional — caller still gets audio_b64
        }
      }

      return {
        ok: true,
        device: choice.device,
        strategy: choice.strategy,
        via: 'pan-client',
        audio_b64,
        seconds,
        text,
      };
    } catch (e) {
      lastError = e.message || String(e);
      exclude.push(choice.device);
      if (!fallback) break;
    }
  }

  return { ok: false, device: null, strategy: 'exhausted', error: lastError || 'no available mic device' };
}
