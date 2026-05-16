// PAN Dashboard Vision Verifier — task #507, Layer 4 of dashboard self-heal stack.
//
// The ULTIMATE ground-truth: every 2 minutes, capture the dashboard window and
// ask a vision model what it actually sees. Compare with the markup state from
// L2 (dashboard_health table). When they disagree — markup says state='ok' but
// the vision model says the panel looks blank, or vice versa — file a P1 bug
// because that's a class of bug nothing else can catch (CSS gone wrong, font
// failed to load, z-index covered, overflow:hidden clipping, etc).
//
// Markup can lie. Pixels can't.
//
// Builds on top of L1 (widget identifiers) + L2 (dashboard_health). Independent
// of L3 (steward UI lane) — runs in parallel and cross-checks the same data.

import { all, get, insert } from './db.js';
import { analyzeImage } from './llm.js';
import { createAlert } from './routes/dashboard.js';
import { broadcastNotification } from './terminal-bridge.js';

const TAURI_PORT = 7790;
const SCAN_INTERVAL_MS = 2 * 60_000;
const FIRST_RUN_DELAY_MS = 90_000; // give the dashboard time to settle on a fresh boot
const PROJECT_ID = 791;
const SOURCE_TAG = 'dashboard-vision-verifier';

let _interval = null;
let _runningScan = false;

async function captureDashboard() {
  const res = await fetch(`http://127.0.0.1:${TAURI_PORT}/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ windowId: 'main' }),
    signal: AbortSignal.timeout(8_000)
  });
  if (!res.ok) throw new Error(`Tauri ${res.status}`);
  const json = await res.json();
  if (!json.base64) throw new Error('no base64');
  return json.base64;
}

// Build the structured prompt. We ask for strict JSON so parsing is reliable.
// List only the widgets we have telemetry for, so the model knows what to look for.
function buildPrompt(widgetNames) {
  const list = widgetNames.length > 0
    ? widgetNames.join(', ')
    : 'intuition, services, devices, alerts, approvals, terminal, transcript';
  return `You are looking at a screenshot of the PAN dashboard. The dashboard is divided into panels.
For each of the panels listed below, decide whether it is VISIBLE on screen and whether it APPEARS TO HAVE DATA.
"Appears to have data" means: shows rows / lists / non-placeholder content. An empty panel with just a title bar or "no data" text counts as blank=true.

Panels to evaluate: ${list}

Respond ONLY with a JSON object of this shape (no prose, no markdown fence):
{
  "panels": [
    { "name": "<panel name>", "visible": true|false, "blank": true|false, "error_visible": true|false, "evidence": "<one short phrase>" }
  ]
}`;
}

function parseVisionJSON(text) {
  if (!text || typeof text !== 'string') return null;
  // Strip code fences if model added them anyway
  let s = text.trim();
  if (s.startsWith('```')) s = s.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
  // Find first '{' and last '}' to be resilient to leading/trailing junk
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try {
    return JSON.parse(s.slice(i, j + 1));
  } catch (e) {
    return null;
  }
}

function findOpenBug(widget, suffix) {
  try {
    return get(`SELECT id FROM project_tasks
      WHERE project_id = :pid AND status IN ('todo','in_progress')
        AND type = 'bug' AND title LIKE :pat
        AND created_at >= datetime('now','localtime','-1 day')
      ORDER BY created_at DESC LIMIT 1`,
      { ':pid': PROJECT_ID, ':pat': `%Vision: ${widget}%${suffix}%` });
  } catch (e) { return null; }
}

function fileVisionBug({ widget, markupState, visionBlank, evidence }) {
  const suffix = visionBlank ? 'blank' : 'has-data';
  const existing = findOpenBug(widget, suffix);
  if (existing) return existing.id; // dedup
  const title = `Vision: ${widget} markup=${markupState} but vision says ${suffix} (auto-filed)`;
  const description = `The dashboard vision verifier (L4, task #507) detected a disagreement between markup state and visual appearance for widget='${widget}'.\n\n`
    + `  markup state: ${markupState}\n`
    + `  vision blank: ${visionBlank}\n`
    + `  evidence: ${evidence || '(none)'}\n\n`
    + `This is the class of bug only vision can catch — CSS gone wrong, font missing, z-index covering content, overflow:hidden clipping, white-on-white, etc.\n`
    + `Auto-filed by ${SOURCE_TAG} (cross-checks dashboard_health from L2 against pixel reality).`;
  try {
    const bugId = insert(`INSERT INTO project_tasks
      (project_id, title, description, type, status, priority, sort_order, org_id, created_at)
      VALUES (:pid, :title, :desc, 'bug', 'todo', 'p1', 0, 'org_personal', datetime('now','localtime'))`,
      { ':pid': PROJECT_ID, ':title': title, ':desc': description });
    console.log(`[VisionVerifier] filed bug #${bugId}: ${title}`);
    try {
      createAlert({
        alert_type: 'dashboard_render',
        severity: 'critical',
        title: `Vision/markup mismatch: ${widget}`,
        detail: `Bug #${bugId}. Markup=${markupState}, vision=${suffix}.`
      });
    } catch (e) {}
    try { broadcastNotification('widget_update', { widget: 'alerts' }); } catch (e) {}
    return bugId;
  } catch (e) {
    console.warn('[VisionVerifier] insert bug failed:', e.message);
    return null;
  }
}

async function scanOnce() {
  if (_runningScan) return;
  _runningScan = true;
  try {
    // Grab the latest markup-state per widget (one row per widget; pick most recent if dupes).
    let health;
    try {
      health = all(`SELECT widget, side, state, has_data, recorded_at FROM dashboard_health
        WHERE recorded_at >= :since
        ORDER BY recorded_at DESC`,
        { ':since': Date.now() - 5 * 60_000 });
    } catch { health = []; }
    if (!Array.isArray(health) || health.length === 0) {
      // Nothing being reported — dashboard might not be open. Skip; not a failure.
      return;
    }
    // De-dup: take latest row per (widget, side)
    const latest = new Map();
    for (const r of health) {
      const k = `${r.widget}|${r.side || ''}`;
      if (!latest.has(k)) latest.set(k, r);
    }
    const widgetNames = Array.from(new Set(Array.from(latest.values()).map(r => r.widget)));

    // Capture + vision call
    let base64;
    try { base64 = await captureDashboard(); }
    catch (e) {
      // Tauri offline (running in browser only) — vision verifier can't help. Skip.
      return;
    }
    const prompt = buildPrompt(widgetNames);
    let raw = '';
    try {
      raw = await analyzeImage(prompt, base64, { caller: 'dashboard-vision-verifier', timeout: 60_000 });
    } catch (e) {
      console.warn('[VisionVerifier] analyzeImage failed:', e.message);
      return;
    }
    const parsed = parseVisionJSON(raw);
    if (!parsed || !Array.isArray(parsed.panels)) {
      console.warn('[VisionVerifier] could not parse vision JSON, snippet:', String(raw).slice(0, 200));
      return;
    }

    // Cross-check vision vs markup. We file bugs only on disagreement.
    for (const p of parsed.panels) {
      if (!p || !p.name) continue;
      const widget = String(p.name).toLowerCase().trim();
      // Find the matching markup row (any side)
      const markupRow = Array.from(latest.values()).find(r => r.widget.toLowerCase() === widget);
      if (!markupRow) continue; // vision named a widget we don't track
      if (!p.visible) continue;  // off-screen panel — not a render bug, just not selected

      const markupOk = markupRow.state === 'ok';
      const visionBlank = !!p.blank;

      if (markupOk && visionBlank) {
        // Markup lied — file a bug.
        fileVisionBug({ widget: markupRow.widget, markupState: markupRow.state, visionBlank: true, evidence: p.evidence });
      } else if (!markupOk && !visionBlank && (markupRow.state === 'empty' || markupRow.state === 'error')) {
        // Markup says broken, vision says fine — possibly a stale state flag.
        // Less urgent — file as p2.
        fileVisionBug({ widget: markupRow.widget, markupState: markupRow.state, visionBlank: false, evidence: p.evidence });
      }
    }
  } finally {
    _runningScan = false;
  }
}

export function startDashboardVisionVerifier() {
  if (_interval) return;
  console.log('[VisionVerifier] starting — scan every', SCAN_INTERVAL_MS / 1000, 's, first run in', FIRST_RUN_DELAY_MS / 1000, 's');
  setTimeout(() => {
    scanOnce().catch(e => console.warn('[VisionVerifier] scan error:', e.message));
    _interval = setInterval(() => {
      scanOnce().catch(e => console.warn('[VisionVerifier] scan error:', e.message));
    }, SCAN_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
}

export function stopDashboardVisionVerifier() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

// For manual triggering / tests
export async function runVisionVerifierOnce() {
  await scanOnce();
  return { ok: true };
}
