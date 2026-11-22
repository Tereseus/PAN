// compute-store.js: the database side of compute.js (the machines ΠAN can run models on).
//
// device_hardware: each pan-client's own report of its chips (compute.js cleanHardware).
// Settings: compute_allowed ({ device id: bool }, his switch per machine), compute_speeds (the last
// speed test per machine), gpu_share_device (the machine whose card WoE shares; its switch is
// pan_mint_gpu_allowed, which WoE's pan-gpu.sh reads).

import { hostname } from 'os';
import { db, get, all } from './db.js';
import { cleanHardware, machineForUrl, isAllowed } from './compute.js';

let ready = false;
function table() {
  if (ready) return;
  db.exec(`CREATE TABLE IF NOT EXISTS device_hardware (
    device_id TEXT PRIMARY KEY, hardware TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  ready = true;
}

/** A pan-client's report, saved when it registers. Nothing saved for an empty report. */
export function saveHardware(deviceId, hw) {
  const clean = cleanHardware(hw);
  if (!deviceId || !clean) return false;
  table();
  db.prepare(`INSERT INTO device_hardware (device_id, hardware, updated_at) VALUES (?, ?, datetime('now','localtime'))
    ON CONFLICT(device_id) DO UPDATE SET hardware = excluded.hardware, updated_at = excluded.updated_at`).run(String(deviceId), JSON.stringify(clean));
  return true;
}

export function setting(key) {
  return String(get('SELECT value FROM settings WHERE key = :k', { ':k': key })?.value ?? '').replace(/^"|"$/g, '');
}

function json(key, empty) {
  try { const v = JSON.parse(get('SELECT value FROM settings WHERE key = :k', { ':k': key })?.value || ''); return v && typeof v === 'object' ? v : empty; } catch { return empty; }
}

/** The pan-client devices, with their hardware reports. A bridge with no report is kept here; compute.js leaves it out. */
export function machinesFacts() {
  table();
  const hw = new Map(all('SELECT device_id, hardware FROM device_hardware').map(r => { try { return [r.device_id, JSON.parse(r.hardware)]; } catch { return [r.device_id, null]; } }));
  const devices = all(`SELECT hostname AS id, name, online, tailscale_ip FROM devices WHERE device_type = 'pc' AND (trusted IS NULL OR trusted = 1)`)
    .map(d => ({ ...d, online: !!d.online, hardware: hw.get(d.id) || null }));
  const me = hostname().toLowerCase();
  const hubId = devices.find(d => String(d.id).toLowerCase() === me)?.id || hostname();
  return { devices, hubId };
}

export function switches(hubId) {
  return {
    hubId,
    allowedMap: json('compute_allowed', {}),
    shareId: setting('gpu_share_device'),
    shareAllowed: setting('pan_mint_gpu_allowed') === 'true',
  };
}

export function speeds() { return json('compute_speeds', {}); }

let cache = { at: 0, facts: null };
/**
 * May a model pinned to this URL run there? false when his switch for that machine is off
 * (llm.js then runs it on the hub). Unknown machines are allowed. Cached 15 s: called on every turn.
 */
export function pinAllowed(url) {
  try {
    if (!cache.facts || Date.now() - cache.at > 15_000) cache = { at: Date.now(), facts: machinesFacts() };
    const { devices, hubId } = cache.facts;
    const id = machineForUrl(devices, url, hubId);
    return isAllowed(id, switches(hubId));
  } catch {
    return true;
  }
}

/** After his switch changes, the next turn reads it fresh. */
export function forgetCache() { cache = { at: 0, facts: null }; }
