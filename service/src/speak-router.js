// PAN speak-router — task #496: cross-device TTS routing
//
// One entry point: speakSomewhere({ text, target, voice, rate, fallback, prefer_voice_clone })
//
// Routing decision order (highest priority first):
//   1. Explicit `target` device → try it first.
//   2. Highest-confidence recent device_presence (within 60s, confidence >= 50).
//   3. Most recent foreground activity_events device (within 30s).
//   4. Last device that submitted a voice command (recent ai_usage row with caller like 'phone-%' or device_id set).
//   5. Most recently heart-beating client device.
//   6. Phone push channel (devicePushSockets, device_type='phone').
//   7. Server-local F5-TTS (writes WAV to data/voices/_outbox/, caller polls).
//
// A target/picked device only counts if it is currently connected to the
// pan-client websocket/HTTP bridge — otherwise we fall through to the next rung.
//
// Returns: { ok, device, strategy, via }

import { all } from './db.js';
import { sendToClient, getConnectedClients } from './client-manager.js';
import { devicePushSockets, pushToDevice, pushToDeviceType } from './server.js';

const PRESENCE_WINDOW_MS = 60_000;
const ACTIVITY_WINDOW_MS = 30_000;
const VOICE_WINDOW_MS    = 120_000;
const HEARTBEAT_WINDOW_MS = 5 * 60_000;

function isOnline(deviceId) {
  if (!deviceId) return false;
  const list = getConnectedClients();
  return list.some(c => c.device_id === deviceId && c.online && c.trusted);
}

function pickPresenceDevice() {
  // Recent device_presence rows, highest confidence first, then most recent.
  // as_of is stored in ms epoch (see intuition/index.js writes Date.now()).
  const cutoff = Date.now() - PRESENCE_WINDOW_MS;
  let rows = [];
  try {
    rows = all(
      `SELECT device_id, confidence, as_of, activity
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
  // activity_events.created_at is a localtime DATETIME string — compare via SQLite datetime().
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
  // Last voice command source within VOICE_WINDOW_MS — the device that asked
  // is usually the device that should receive the spoken answer.
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
    // caller looks like 'phone-<id>', 'desktop-<hostname>', etc — strip prefix
    const caller = String(r.caller || '');
    const m = caller.match(/^(?:phone|desktop|client)[-_:](.+)$/i);
    const candidate = m ? m[1] : caller;
    if (isOnline(candidate)) return candidate;
  }
  return null;
}

function pickRecentHeartbeatDevice() {
  // Most recent heart-beating trusted client.
  const clients = getConnectedClients()
    .filter(c => c.online && c.trusted && c.last_heartbeat)
    .sort((a, b) => String(b.last_heartbeat).localeCompare(String(a.last_heartbeat)));
  return clients[0]?.device_id || null;
}

function pickPhoneDevice() {
  // Any device_type='phone' push socket counts.
  for (const [device_id, ws] of devicePushSockets) {
    if (ws.deviceType === 'phone' && ws.readyState === 1) return device_id;
  }
  return null;
}

export function pickSpeakerDevice(opts = {}) {
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
 * Speak text on the best available device.
 * @param {object} opts
 * @param {string} opts.text          - Required.
 * @param {string} [opts.target]      - Preferred device id.
 * @param {string} [opts.voice]       - Voice name (passed to client cmdTtsSpeak).
 * @param {number} [opts.rate=1.0]    - Speech rate (passed to client cmdTtsSpeak).
 * @param {boolean} [opts.fallback=true]
 * @returns {Promise<{ok,device,strategy,via,error?}>}
 */
export async function speakSomewhere(opts = {}) {
  const { text, target, voice, rate = 1.0, fallback = true } = opts;
  if (!text || typeof text !== 'string') {
    return { ok: false, device: null, strategy: 'none', error: 'text required' };
  }

  const exclude = [];
  let lastError = null;

  // Up to 5 attempts: target → presence → activity → voice_src → recent.
  // If a chosen device fails to deliver, blacklist it and re-pick.
  for (let attempt = 0; attempt < 5; attempt++) {
    const choice = pickSpeakerDevice({ target: attempt === 0 ? target : undefined, exclude });

    if (!choice.device) break;

    // Phone goes via push channel, not via pan-client.
    if (choice.strategy === 'phone' || choice.via === 'push') {
      const ok = pushToDevice(choice.device, { type: 'speak', text, voice, rate });
      if (ok) return { ok: true, device: choice.device, strategy: choice.strategy, via: 'push' };
      exclude.push(choice.device);
      lastError = 'phone push failed';
      continue;
    }

    // pan-client desktop/server: tts_speak command via WS or HTTP queue.
    try {
      await sendToClient(choice.device, 'tts_speak', { text, voice, rate }, 8000);
      return { ok: true, device: choice.device, strategy: choice.strategy, via: 'pan-client' };
    } catch (e) {
      lastError = e.message || String(e);
      exclude.push(choice.device);
      if (!fallback) break;
    }
  }

  // Final fallback: broadcast to any phone (push) — uses pushToDeviceType
  try {
    const sent = pushToDeviceType('phone', 'org_personal', { type: 'speak', text, voice, rate });
    if (sent > 0) return { ok: true, device: '(any phone)', strategy: 'phone_broadcast', via: 'push' };
  } catch {}

  return { ok: false, device: null, strategy: 'exhausted', error: lastError || 'no available device' };
}
