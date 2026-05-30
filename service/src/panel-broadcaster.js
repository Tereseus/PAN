// PAN Panel Broadcaster (Phase 3)
//
// Maintains a `/ws/panels` WebSocket endpoint that dashboard tabs connect
// to and receive periodic "panel data" pushes for the major routes —
// /dashboard/api/services, /dashboard/api/progress, /api/v1/devices/list,
// /api/automation/status, etc. The dashboard's client-side stream listener
// writes the payloads directly into the SWR cache that lives in
// $lib/api.js, so every panel route's `await api(path)` call resolves
// instantly from cache instead of triggering a network round-trip.
//
// Why this is better than fetch-on-mount or even SWR alone:
//   - SWR (Phase 2) made tab cycling within ~30s feel instant by serving
//     last-known data immediately. But the FIRST visit to any panel — or
//     any visit more than 30 seconds after the last load — still paid
//     the fetch round-trip + queued behind whatever else the main thread
//     was doing.
//   - Push (this phase) eliminates the fetch entirely. The server sends
//     fresh data every ~10–30 seconds; the client receives it passively
//     and warms its cache continuously. By the time the user clicks any
//     panel, the data is already sitting in their browser memory.
//
// Cost control:
//   - The broadcaster fetches its source endpoints ONCE per interval,
//     regardless of how many dashboard tabs are open. The result is
//     fanned out via WebSocket to all subscribers — no per-tab fetch.
//   - When zero tabs are connected (no panel WS open), the fetcher
//     short-circuits and doesn't touch the source endpoints at all.

import { WebSocketServer } from 'ws';

const TOPICS = [
  // Most-visited panels first. Intervals balance freshness vs. backend load.
  { name: 'services',   path: '/dashboard/api/services',  interval: 10_000 },
  { name: 'progress',   path: '/dashboard/api/progress',  interval: 30_000 },
  { name: 'devices',    path: '/api/v1/devices/list',     interval: 15_000 },
  { name: 'automation', path: '/api/automation/status',   interval: 15_000 },
  { name: 'stacks',     path: '/api/v1/stacks',           interval: 60_000 },
  { name: 'settings',   path: '/api/v1/settings',         interval: 60_000 },
];

const _clients = new Set();
let _wss = null;
const _timers = [];
const _lastPayload = new Map(); // path → { data, ts } to deduplicate broadcasts

function _craftPort() {
  return process.env.PAN_PORT || 17700;
}

async function _fetchInternal(path, timeoutMs = 8000) {
  const res = await fetch(`http://127.0.0.1:${_craftPort()}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function _broadcastJson(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of _clients) {
    if (ws.readyState === 1 /* OPEN */) {
      try { ws.send(msg); } catch {}
    }
  }
}

// Called from terminal.js's upgrade handler — see that file for the
// path dispatcher. We get a raw HTTP upgrade and complete the handshake.
export function handlePanelWsUpgrade(request, socket, head) {
  if (!_wss) _wss = new WebSocketServer({ noServer: true });
  _wss.handleUpgrade(request, socket, head, (ws) => {
    _clients.add(ws);
    ws.on('close', () => _clients.delete(ws));
    ws.on('error', () => _clients.delete(ws));

    // Send a hello so the client knows it's subscribed and can start its
    // cache-warming logic. Include the topics list so the client knows
    // what to expect.
    try {
      ws.send(JSON.stringify({
        type: 'hello',
        topics: TOPICS.map(t => ({ name: t.name, path: t.path, interval_ms: t.interval })),
        ts: Date.now(),
      }));
    } catch {}

    // On a fresh connect, send the last-known payload for every topic
    // we have one for — so this tab gets instant data without waiting
    // for the next interval tick.
    for (const [path, entry] of _lastPayload.entries()) {
      try {
        ws.send(JSON.stringify({
          type: 'panel_update',
          path,
          data: entry.data,
          ts: entry.ts,
          replay: true,
        }));
      } catch {}
    }
  });
}

export function startPanelBroadcaster() {
  for (const topic of TOPICS) {
    const fire = async () => {
      // Cost guard: if nobody's listening, skip the fetch entirely.
      // The first connecting client triggers an immediate per-topic fetch
      // via _bumpTopic so they get instant data on connect.
      if (_clients.size === 0) return;
      try {
        const data = await _fetchInternal(topic.path);
        _lastPayload.set(topic.path, { data, ts: Date.now() });
        _broadcastJson({ type: 'panel_update', topic: topic.name, path: topic.path, data, ts: Date.now() });
      } catch {
        // Silent: the next tick retries. We don't want this to spam the log.
      }
    };
    // Stagger the initial fire so all topics don't hammer the backend at
    // boot. 5–10s spread keeps Carrier's startup gauntlet calm.
    setTimeout(fire, 5_000 + Math.random() * 5_000);
    _timers.push(setInterval(fire, topic.interval));
  }
  console.log(`[PAN Panel Broadcaster] started — ${TOPICS.length} topics, push-on-change to /ws/panels`);
}

export function stopPanelBroadcaster() {
  for (const t of _timers) clearInterval(t);
  _timers.length = 0;
  for (const ws of _clients) { try { ws.close(); } catch {} }
  _clients.clear();
}
