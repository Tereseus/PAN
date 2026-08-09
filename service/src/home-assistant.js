// PAN <-> Home Assistant.
//
// Design intent (docs/HOME-ASSISTANT.md): HA owns the device layer, PAN owns
// the brain. We do not reimplement Zigbee/Tuya/Matter — we call HA's API and
// consume its event stream.
//
// Two halves:
//   1. Commands  — REST. resolveEntity() turns "the theater" into
//                  switch.theater_power so voice can drive it.
//   2. Ingestion — WebSocket subscription to state_changed.
//
// NOTE ON EVENT VOLUME: the design doc says "capture every state change".
// Doing that literally is a mistake here. A single power-monitoring plug can
// emit a state_changed every second; the DB was pruned from 365K to 108K
// events in Aug 2026 precisely to get rid of that class of noise. So we log an
// allowlist of domains where a transition means something a human would ask
// about, and drop attribute-only churn. Widen with the `ha_capture_domains`
// setting if you want more.

import { get, run, logEvent } from './db.js';
import { getSecret } from './secrets.js';

const DEFAULT_URL = 'http://localhost:8123';

// Domains where "it changed" is a fact worth remembering. `sensor` is
// deliberately absent: numeric telemetry belongs in HA's own recorder, not in
// PAN's event log.
const DEFAULT_CAPTURE_DOMAINS = [
  'light', 'switch', 'lock', 'climate', 'media_player',
  'binary_sensor', 'person', 'device_tracker', 'cover', 'fan', 'alarm_control_panel',
];

let _ws = null;
let _wsId = 1;
let _connected = false;
let _reconnectTimer = null;
let _reconnectDelay = 5000;
let _lastError = null;

function settingValue(key, fallback = null) {
  try {
    const row = get('SELECT value FROM settings WHERE key = :k', { ':k': key });
    if (!row || row.value == null) return fallback;
    return String(row.value).replace(/^"|"$/g, '').trim() || fallback;
  } catch {
    return fallback;
  }
}

/** Config resolved fresh each call so settings changes take effect without a restart. */
export function haConfig() {
  const raw = settingValue('ha_url', DEFAULT_URL) || DEFAULT_URL;
  const url = raw.replace(/\/+$/, '');
  const token = getSecret('hass_token');
  const enabledRaw = settingValue('ha_enabled', null);
  // Enabled by default once a token exists — no one wants to set two settings.
  const enabled = enabledRaw == null ? !!token : !/^(false|0|no)$/i.test(enabledRaw);
  return { url, token, enabled: enabled && !!token };
}

export function haStatus() {
  const { url, enabled } = haConfig();
  return {
    configured: !!getSecret('hass_token'),
    enabled,
    url,
    connected: _connected,
    lastError: _lastError,
  };
}

async function haFetch(path, { method = 'GET', body, timeoutMs = 10_000 } = {}) {
  const { url, token, enabled } = haConfig();
  if (!enabled) throw new Error('Home Assistant is not configured (set hass_token)');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HA ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? await res.json() : await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Every entity HA knows about, normalised to the fields we care about. */
export async function listEntities({ domain = null } = {}) {
  const states = await haFetch('/states');
  return (Array.isArray(states) ? states : [])
    .map((s) => ({
      entity_id: s.entity_id,
      domain: String(s.entity_id).split('.')[0],
      name: s.attributes?.friendly_name || s.entity_id,
      state: s.state,
      attributes: s.attributes || {},
    }))
    .filter((e) => !domain || e.domain === domain);
}

export async function getEntity(entityId) {
  return haFetch(`/states/${encodeURIComponent(entityId)}`);
}

const CONTROLLABLE = new Set([
  'light', 'switch', 'fan', 'cover', 'media_player',
  'climate', 'lock', 'scene', 'script', 'automation', 'input_boolean',
]);

function scoreMatch(query, entity) {
  const q = query.toLowerCase().trim();
  const name = entity.name.toLowerCase();
  const id = entity.entity_id.toLowerCase();
  const idTail = id.split('.')[1] || '';
  const slug = idTail.replace(/_/g, ' ');

  if (name === q || id === q) return 100;
  if (slug === q) return 95;
  if (name.startsWith(q) || slug.startsWith(q)) return 80;
  if (name.includes(q) || slug.includes(q)) return 60;

  // Every word of the query present somewhere in the name/slug.
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => name.includes(w) || slug.includes(w))) return 55;
  return 0;
}

/**
 * Turn a spoken phrase into an entity_id.
 * "the theater" -> switch.theater_power
 *
 * Returns { entity, candidates }. `entity` is null when nothing scored, or when
 * the top two are tied — an ambiguous match should ask, not guess, because
 * guessing wrong here physically does something in someone's house.
 */
export async function resolveEntity(query, { domain = null, controllableOnly = true } = {}) {
  if (!query || !String(query).trim()) return { entity: null, candidates: [] };
  const cleaned = String(query)
    .toLowerCase()
    .replace(/\b(the|my|a|an|please|turn|switch)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let entities = await listEntities({ domain });
  if (controllableOnly) entities = entities.filter((e) => CONTROLLABLE.has(e.domain));

  const scored = entities
    .map((e) => ({ ...e, score: Math.max(scoreMatch(cleaned, e), scoreMatch(String(query).toLowerCase(), e)) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { entity: null, candidates: [] };
  const ambiguous = scored.length > 1 && scored[0].score === scored[1].score;
  return {
    entity: ambiguous ? null : scored[0],
    candidates: scored.slice(0, 5),
    ambiguous,
  };
}

export async function callService(domain, service, data = {}) {
  return haFetch(`/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
    method: 'POST',
    body: data,
  });
}

/**
 * The high-level entry point voice and the API both use.
 * action: 'on' | 'off' | 'toggle'
 */
export async function controlEntity(query, action = 'toggle', extra = {}) {
  const { entity, candidates, ambiguous } = await resolveEntity(query);
  if (!entity) {
    return {
      ok: false,
      reason: ambiguous ? 'ambiguous' : 'not_found',
      query,
      candidates: candidates.map((c) => ({ entity_id: c.entity_id, name: c.name })),
    };
  }

  const domain = entity.domain;
  let service;
  if (domain === 'scene' || domain === 'script') service = 'turn_on';
  else if (action === 'on') service = 'turn_on';
  else if (action === 'off') service = 'turn_off';
  else service = 'toggle';

  await callService(domain, service, { entity_id: entity.entity_id, ...extra });

  logEvent(null, 'HomeAssistantCommand', {
    entity_id: entity.entity_id,
    name: entity.name,
    domain,
    service,
    query,
  }, null, 'org_personal', { trustOrigin: 'self' });

  return { ok: true, entity_id: entity.entity_id, name: entity.name, service };
}

// ============================================================
// Event ingestion
// ============================================================

function captureDomains() {
  const raw = settingValue('ha_capture_domains', null);
  if (!raw) return new Set(DEFAULT_CAPTURE_DOMAINS);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return new Set(parsed);
  } catch {}
  return new Set(DEFAULT_CAPTURE_DOMAINS);
}

function scheduleReconnect() {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    startHaEventStream().catch(() => {});
  }, _reconnectDelay);
  // Back off to a ceiling so a permanently-down HA doesn't spin.
  _reconnectDelay = Math.min(_reconnectDelay * 2, 5 * 60_000);
}

export async function startHaEventStream() {
  const { url, token, enabled } = haConfig();
  if (!enabled) return { started: false, reason: 'not configured' };
  if (_ws) return { started: false, reason: 'already running' };

  const { default: WebSocket } = await import('ws');
  const wsUrl = url.replace(/^http/, 'ws') + '/api/websocket';
  const domains = captureDomains();

  const ws = new WebSocket(wsUrl);
  _ws = ws;

  ws.on('open', () => { _lastError = null; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'auth_required') {
      ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      return;
    }
    if (msg.type === 'auth_invalid') {
      _lastError = 'auth_invalid — the hass_token was rejected';
      console.warn('[HA] auth rejected; not retrying until the token changes');
      try { ws.close(); } catch {}
      return;
    }
    if (msg.type === 'auth_ok') {
      _connected = true;
      _reconnectDelay = 5000; // healthy connection resets the backoff
      ws.send(JSON.stringify({ id: _wsId++, type: 'subscribe_events', event_type: 'state_changed' }));
      console.log('[HA] connected, subscribed to state_changed');
      return;
    }

    if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
      const { entity_id, new_state, old_state } = msg.event.data || {};
      if (!entity_id) return;
      const domain = String(entity_id).split('.')[0];
      if (!domains.has(domain)) return;

      const from = old_state?.state;
      const to = new_state?.state;
      // Attribute-only updates repeat the same state. Those are the churn.
      if (from === to) return;

      logEvent(null, 'HomeAssistant', {
        entity_id,
        domain,
        name: new_state?.attributes?.friendly_name || entity_id,
        from,
        to,
      }, null, 'org_personal', { trustOrigin: 'home_assistant' });
    }
  });

  ws.on('error', (err) => { _lastError = err?.message || String(err); });

  ws.on('close', () => {
    _connected = false;
    _ws = null;
    if (_lastError !== 'auth_invalid — the hass_token was rejected') scheduleReconnect();
  });

  return { started: true, url: wsUrl };
}

export function stopHaEventStream() {
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_ws) { try { _ws.close(); } catch {} _ws = null; }
  _connected = false;
  return { stopped: true };
}

export function setHaConfig({ url, token, enabled } = {}) {
  if (url !== undefined) {
    run(`INSERT INTO settings (key, value) VALUES ('ha_url', :v)
         ON CONFLICT(key) DO UPDATE SET value = :v`, { ':v': String(url) });
  }
  if (token !== undefined) {
    run(`INSERT INTO settings (key, value) VALUES ('hass_token', :v)
         ON CONFLICT(key) DO UPDATE SET value = :v`, { ':v': String(token) });
  }
  if (enabled !== undefined) {
    run(`INSERT INTO settings (key, value) VALUES ('ha_enabled', :v)
         ON CONFLICT(key) DO UPDATE SET value = :v`, { ':v': enabled ? 'true' : 'false' });
  }
  return haStatus();
}
