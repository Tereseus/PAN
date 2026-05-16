// PAN Dashboard Render Health — task #506, Layer 3 of dashboard self-heal stack.
//
// Reads the dashboard_health table (populated by L2 telemetry from
// service/dashboard/src/routes/terminal/+page.svelte). For each widget that
// reports state='empty' or state='error' for longer than the persistence
// threshold while the server has fresh data for that widget, file a bug into
// project_tasks. For 'stale' widgets file a lower-severity bug.
//
// Dedup window: 24h. If an open bug already exists for the same widget within
// that window, we append a comment to it instead of filing a duplicate.
//
// Designed to be loaded from server.js boot (NOT through the steward service
// registry — that registry is for processes, this is a passive monitor).

import { all, get, run, insert } from './db.js';
import { createAlert } from './routes/dashboard.js';
import { broadcastNotification } from './terminal-bridge.js';

const PROJECT_ID = 791; // PAN
const SCAN_INTERVAL_MS = 30_000;
const EMPTY_PERSIST_MS = 60_000;       // empty state must persist this long before filing
const STALE_PERSIST_MS = 5 * 60_000;   // stale state threshold
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const SOURCE_TAG = 'dashboard-render-health';

// In-process memory of when each widget first entered a non-ok state.
// Key: `${device_id}|${widget}|${side}`  Value: { state, since_ms }
const _seenSince = new Map();
let _lastInsertError = null;
let _lastInsertOk = null;

let _interval = null;

function widgetKey(row) {
  return `${row.device_id}|${row.widget}|${row.side || ''}`;
}

// Has the dashboard recorded a snapshot for this widget recently?
// If it's been >5min since the last telemetry POST for this row, the
// dashboard is probably not even running — skip filing a bug.
function isTelemetryFresh(row) {
  return row.recorded_at && (Date.now() - row.recorded_at) < 5 * 60_000;
}

function findOpenBug(widget) {
  try {
    return get(`SELECT id, title, description FROM project_tasks
      WHERE project_id = :pid AND status IN ('todo','in_progress')
        AND type = 'bug' AND title LIKE :pat
        AND created_at >= datetime('now','localtime','-1 day')
      ORDER BY created_at DESC LIMIT 1`,
      { ':pid': PROJECT_ID, ':pat': `%Widget '${widget}' rendering %` });
  } catch (e) {
    console.warn('[DashboardRenderHealth] findOpenBug failed:', e.message);
    return null;
  }
}

function fileBug({ widget, state, side, persistMs, row, priority }) {
  const existing = findOpenBug(widget);
  const stamp = new Date().toISOString();
  const detail = `Auto-detected by ${SOURCE_TAG} at ${stamp}.\n`
    + `  state=${state} side=${side || '-'} persisted_ms=${persistMs}\n`
    + `  device=${row.device_id} page=${row.page}\n`
    + `  data_source_at=${row.data_source_at} rendered_at=${row.rendered_at} recorded_at=${row.recorded_at}`;

  if (existing) {
    try {
      run(`UPDATE project_tasks SET description = COALESCE(description,'') || :append
           WHERE id = :id`,
        { ':append': `\n\n--- recurrence ${stamp} ---\n${detail}`, ':id': existing.id });
      console.log(`[DashboardRenderHealth] appended recurrence to bug #${existing.id} for widget=${widget}`);
    } catch (e) {
      console.warn('[DashboardRenderHealth] append failed:', e.message);
    }
    return existing.id;
  }

  const title = `Widget '${widget}' rendering ${state} (auto-filed)`;
  const description = `The dashboard reported widget='${widget}' state='${state}' for ${Math.round(persistMs/1000)}s. `
    + `This was auto-filed by ${SOURCE_TAG} (L3 of dashboard self-heal stack, task #506).\n\n${detail}\n\n`
    + `To verify the underlying data source has it, look at the corresponding API endpoint for this widget. `
    + `If the API has data but the panel is empty, this is a render/state-binding bug in service/dashboard/src/routes/terminal/+page.svelte.`;
  try {
    const bugId = insert(`INSERT INTO project_tasks
      (project_id, title, description, type, status, priority, sort_order, org_id, created_at)
      VALUES (:pid, :title, :desc, 'bug', 'todo', :pri, 0, 'org_personal', datetime('now','localtime'))`,
      { ':pid': PROJECT_ID, ':title': title, ':desc': description, ':pri': priority });
    if (!bugId) throw new Error('insert returned null bug_id');
    _lastInsertOk = { at: new Date().toISOString(), bug_id: String(bugId), widget, state };
    console.log(`[DashboardRenderHealth] filed bug #${bugId} for widget=${widget} state=${state}`);
    try {
      createAlert({
        alert_type: 'dashboard_render',
        severity: state === 'error' ? 'critical' : 'warning',
        title: `Widget '${widget}' empty`,
        detail: `Auto-filed bug #${bugId}. State=${state} persisted ${Math.round(persistMs/1000)}s.`
      });
    } catch (e) { /* alert failure must not block bug filing */ }
    try {
      broadcastNotification('widget_update', { widget: 'alerts' });
    } catch (e) {}
    return bugId;
  } catch (e) {
    _lastInsertError = { at: new Date().toISOString(), message: e.message, stack: (e.stack || '').split('\n').slice(0, 5).join('\n'), widget, state };
    console.warn('[DashboardRenderHealth] insert bug failed:', e.message);
    return null;
  }
}

// Manual trigger + debug accessors for the runtime probe endpoint.
export function runRenderHealthOnce() {
  try { scanOnce(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}
export function _lastError() { return _lastInsertError; }
export function _lastOk() { return _lastInsertOk; }

function scanOnce() {
  let rows;
  try {
    // Pull only the LATEST row per (device, widget, side) within a fresh window.
    // The historical table accumulates rows every 30s — without this dedup,
    // a single old state='ok' row anywhere in history wipes the in-process tracker
    // (see `state === 'ok' → _seenSince.delete(key)` below), so persistence never
    // accumulates to EMPTY_PERSIST_MS and bugs never fire. Bug discovered 2026-05-16
    // after observing intuition widget sat state='empty' for 87 minutes with zero
    // bugs filed despite L3 being wired and running. See task #506.
    rows = all(`SELECT h.* FROM dashboard_health h
      INNER JOIN (
        SELECT device_id, widget, COALESCE(side,'') AS side_key, MAX(recorded_at) AS max_recorded
        FROM dashboard_health
        WHERE recorded_at >= :since
        GROUP BY device_id, widget, COALESCE(side,'')
      ) latest
        ON h.device_id = latest.device_id
       AND h.widget = latest.widget
       AND COALESCE(h.side,'') = latest.side_key
       AND h.recorded_at = latest.max_recorded
      ORDER BY h.widget, h.side, h.device_id`,
      { ':since': Date.now() - 5 * 60_000 });
  } catch (e) {
    // Table may not exist yet (server hasn't received its first telemetry POST)
    return;
  }
  if (!Array.isArray(rows) || rows.length === 0) return;
  const now = Date.now();
  const stillSeen = new Set();

  for (const row of rows) {
    const key = widgetKey(row);
    stillSeen.add(key);

    // Healthy → clear any timer.
    if (row.state === 'ok') {
      _seenSince.delete(key);
      continue;
    }
    // Telemetry must be fresh — old rows shouldn't trigger bugs (browser closed)
    if (!isTelemetryFresh(row)) {
      _seenSince.delete(key);
      continue;
    }

    const tracked = _seenSince.get(key);
    if (!tracked || tracked.state !== row.state) {
      _seenSince.set(key, { state: row.state, since_ms: now });
      continue;
    }
    const persistMs = now - tracked.since_ms;

    // Trigger thresholds
    const isEmptyOrError = row.state === 'empty' || row.state === 'error';
    const isStale = row.state === 'stale';

    if (isEmptyOrError && persistMs >= EMPTY_PERSIST_MS && !tracked.filed) {
      const bugId = fileBug({
        widget: row.widget, state: row.state, side: row.side,
        persistMs, row, priority: 'p1'
      });
      if (bugId) { tracked.filed = true; tracked.bug_id = bugId; _seenSince.set(key, tracked); }
      // else: leave filed=false so we retry on the next scan
    } else if (isStale && persistMs >= STALE_PERSIST_MS && !tracked.filed) {
      const bugId = fileBug({
        widget: row.widget, state: row.state, side: row.side,
        persistMs, row, priority: 'p2'
      });
      if (bugId) { tracked.filed = true; tracked.bug_id = bugId; _seenSince.set(key, tracked); }
    }
  }

  // Garbage-collect entries for widgets no longer being reported.
  for (const key of _seenSince.keys()) {
    if (!stillSeen.has(key)) _seenSince.delete(key);
  }
}

export function startDashboardRenderHealth() {
  if (_interval) return;
  console.log('[DashboardRenderHealth] starting — scan every', SCAN_INTERVAL_MS, 'ms');
  // First scan delayed so the dashboard has a chance to POST its first batch.
  setTimeout(() => {
    try { scanOnce(); } catch (e) { console.warn('[DashboardRenderHealth] scan failed:', e.message); }
    _interval = setInterval(() => {
      try { scanOnce(); } catch (e) { console.warn('[DashboardRenderHealth] scan failed:', e.message); }
    }, SCAN_INTERVAL_MS);
  }, 45_000);
}

export function stopDashboardRenderHealth() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  _seenSince.clear();
}

// Test-facing: read current in-memory state.
export function _renderHealthDebug() {
  return Array.from(_seenSince.entries()).map(([k, v]) => ({ key: k, ...v }));
}
