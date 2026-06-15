// PAN Capture Consent — the privacy control plane for everything that
// observes the user: camera (identity), screen, and app activity.
//
// SHIP-PLAN Phase 4. This is the surface a shipped PAN exposes so a person
// can SEE what is watching and turn each one off — the trust story that
// separates PAN from "always-on assistant that records everything."
//
// Each capture feature resolves on/off in this order:
//   1. env PAN_ENABLE_<NAME>=1/0  — hard override for headless/server config
//   2. DB setting capture_<name>  — the user's consent toggle (persisted, live)
//   3. profile default            — identity OFF everywhere; screen + activity
//                                   ON in full, OFF in core
//
// Toggling writes the setting AND starts/stops the watcher live, so the
// consent page takes effect without a restart.

import { get, run } from './db.js';
import { PROFILE } from './profiles.js';
import { startWebcamWatcher, stopWebcamWatcher, getWebcamStatus } from './webcam-watcher.js';
import { startScreenWatcher, stopScreenWatcher, getScreenWatcherStatus } from './screen-watcher.js';
import { startActivityTracker, stopActivityTracker, getActivityTrackerStatus } from './activity-tracker.js';

const FEATURES = {
  identity: {
    label: 'Camera & Face ID',
    blurb: 'Uses the webcam to sense presence and recognise who is at the desk. Off by default — turn on only if you want it.',
    defaultFull: false,            // OFF even in full — must be opted in
    start: startWebcamWatcher,
    stop:  stopWebcamWatcher,
    status: () => !!getWebcamStatus()?.running,
  },
  screen: {
    label: 'Screen watching',
    blurb: 'Periodically captures a screenshot and describes what you are working on, so PAN has context.',
    defaultFull: true,
    start: startScreenWatcher,
    stop:  stopScreenWatcher,
    status: () => !!getScreenWatcherStatus()?.running,
  },
  activity: {
    label: 'App activity',
    blurb: 'Tracks which application is in the foreground (app name + window title — no screenshots).',
    defaultFull: true,
    start: startActivityTracker,
    stop:  stopActivityTracker,
    status: () => !!getActivityTrackerStatus()?.running,
  },
};

export const CAPTURE_FEATURE_NAMES = Object.keys(FEATURES);

function envOverride(name) {
  const v = process.env[`PAN_ENABLE_${name.toUpperCase()}`];
  if (v === '1' || v === 'true')  return true;
  if (v === '0' || v === 'false') return false;
  return null;
}

function settingOverride(name) {
  try {
    const row = get('SELECT value FROM settings WHERE key = :k', { ':k': `capture_${name}` });
    if (!row) return null;
    const v = String(row.value).replace(/^"|"$/g, '');
    if (v === 'on')  return true;
    if (v === 'off') return false;
  } catch {}
  return null;
}

function profileDefault(name) {
  const f = FEATURES[name];
  if (!f) return false;
  return PROFILE === 'full' ? f.defaultFull : false; // core: all capture off
}

export function isCaptureOn(name) {
  const env = envOverride(name);
  if (env !== null) return env;
  const setting = settingOverride(name);
  if (setting !== null) return setting;
  return profileDefault(name);
}

function sourceOf(name) {
  if (envOverride(name) !== null) return 'env';
  if (settingOverride(name) !== null) return 'user';
  return 'default';
}

function safe(fn) { try { return !!fn(); } catch { return false; } }

// Full state for the consent UI.
export function getCaptureState() {
  return {
    profile: PROFILE,
    features: Object.entries(FEATURES).map(([name, f]) => ({
      name,
      label: f.label,
      blurb: f.blurb,
      enabled: isCaptureOn(name),        // intended state
      running: safe(f.status),           // actually running right now
      source:  sourceOf(name),           // env | user | default
      env_locked: envOverride(name) !== null,
    })),
  };
}

// Toggle a feature: persist consent + start/stop live. An env override pins
// the feature — the UI cannot override a deliberate headless config.
export function setCaptureConsent(name, on) {
  const f = FEATURES[name];
  if (!f) throw new Error(`unknown capture feature: ${name}`);
  if (envOverride(name) !== null) {
    return { ok: false, error: `${name} is pinned by PAN_ENABLE_${name.toUpperCase()} — unset the env var to control it from here`, enabled: isCaptureOn(name) };
  }
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (:k, :v)',
      { ':k': `capture_${name}`, ':v': JSON.stringify(on ? 'on' : 'off') });
  try {
    if (on) f.start(); else f.stop();
  } catch (e) {
    return { ok: false, error: `consent saved but watcher ${on ? 'start' : 'stop'} failed: ${e.message}`, enabled: on };
  }
  console.log(`[Capture] ${name} → ${on ? 'ON' : 'OFF'} (user consent)`);
  return { ok: true, name, enabled: on, running: safe(f.status) };
}

// Boot hook — start whichever captures should be on per resolved state.
// Replaces the per-feature featureEnabled() gates in server.js for these three.
export function applyCaptureConsentAtBoot() {
  for (const [name, f] of Object.entries(FEATURES)) {
    if (isCaptureOn(name)) {
      try { f.start(); } catch (e) { console.warn(`[Capture] ${name} start failed:`, e.message); }
    } else {
      console.log(`[Capture] ${name} OFF at boot (${sourceOf(name)})`);
    }
  }
}
