// PAN Smart Steward — LLM-driven autonomous maintenance agent.
//
// User policy 2026-06-05: "The Steward should have some type of smart logic
// in it so that it looks at the problems it's facing and makes an LLM
// request, makes a smart evaluation of the system to make determinations
// as to what it needs to do. ... I shouldn't actually ever have to say
// 'PAN, update minipc'. The system should know."
//
// What this does:
//   Every TICK_MS, surveys the system for problems (open alerts, services
//   down, recent restart failures, etc.). If anything looks non-healthy,
//   gathers context and asks Claude (via the SDK / subscription, NOT
//   Cerebras — Cerebras is for speed in the voice loop) what to do.
//   Executes the action with safety guards. Logs what it tried so the
//   NEXT tick can see whether it worked and escalate if not.
//
// Why Claude over Cerebras for this caller:
//   - Maintenance decisions need careful reasoning, not 600ms throughput
//   - Cerebras gpt-oss-120b is brilliant but optimised for speed; this loop
//     is fine with a 5-15s thinking pass
//   - Claude Haiku via SDK is "free" against the user's Claude Code
//     subscription instead of burning Cerebras free-tier budget
//   - Per the LLM-CALLERS.md doc, this caller registers as 'smart-steward'
//     and the user can change the model via job_models if they ever want.
//
// Safety model:
//   - Only operates on PAN-managed devices (in the devices table, trusted)
//   - Action types are an allowlist. No shell_exec with arbitrary commands.
//   - Rate-limited to once per TICK_MS regardless of pending issues
//   - Idempotent operations only (restart_service ok, delete DB never)
//   - Tracks what it's already tried so it doesn't loop on the same fix

import { db, get, all, insert, run } from './db.js';
import { claude } from './claude.js';
import { createAlert } from './routes/dashboard.js';

// How often to survey. 5 min is fast enough to catch real issues but slow
// enough not to burn LLM budget on every transient blip. Steward's own
// 60s health-check loop is the fast path; this is the slow-thinking
// supervisor that escalates patterns the fast path can't fix on its own.
const TICK_MS = 5 * 60 * 1000;

// Cap how many separate concerns we let Claude evaluate per tick.
// Keeps the prompt bounded + prevents runaway action storms.
const MAX_CONCERNS_PER_TICK = 5;

// Action allowlist. Any action Claude returns that's NOT in here gets
// rejected. Adding a new action means adding the executor below AND
// documenting why it's safe to call autonomously.
const ALLOWED_ACTIONS = new Set([
  'restart_service',       // Send restart_service command to a pan-client device
  'push_update',           // Trigger pan-client self-update on a remote device
  'create_alert',          // Escalate to the user (when autonomous fix is unsafe)
  'no_op',                 // Don't act — the situation will resolve or needs a human
]);

let _tickTimer = null;
let _lastTickAt = 0;
let _lastActions = [];   // last 20 actions taken, for "have I already tried this"

export function startSmartSteward() {
  if (_tickTimer) return;
  console.log('[SmartSteward] starting — tick interval ' + (TICK_MS / 1000) + 's');
  // Run once at startup after a brief delay so boot has time to settle,
  // then on the interval.
  setTimeout(() => { tickOnce().catch(e => console.warn('[SmartSteward] first tick failed:', e.message)); }, 60_000);
  _tickTimer = setInterval(() => {
    tickOnce().catch(e => console.warn('[SmartSteward] tick failed:', e.message));
  }, TICK_MS);
}

export function stopSmartSteward() {
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}

// One survey-+-decide-+-act cycle.
async function tickOnce() {
  _lastTickAt = Date.now();
  const concerns = surveyConcerns();
  if (concerns.length === 0) {
    return; // healthy — nothing to do
  }
  console.log('[SmartSteward] ' + concerns.length + ' concern(s):', concerns.map(c => c.kind).join(', '));

  const prompt = buildPrompt(concerns);
  let raw = '';
  try {
    // Claude Haiku via SDK — see file header for why this caller doesn't
    // use Cerebras. logUsage will record latency + token cost as
    // caller='smart-steward'.
    raw = await claude(prompt, {
      caller: 'smart-steward',
      maxTokens: 800,
      timeout: 30_000,
    });
  } catch (e) {
    console.warn('[SmartSteward] LLM call failed:', e.message);
    return;
  }

  const action = parseAction(raw);
  if (!action) {
    console.warn('[SmartSteward] no parseable action in LLM response');
    return;
  }
  if (!ALLOWED_ACTIONS.has(action.action)) {
    console.warn('[SmartSteward] rejecting non-allowlisted action:', action.action);
    return;
  }

  // Don't loop on the same action targeting the same device within 30 min.
  // If the previous attempt didn't fix it, we need a different approach
  // (or human escalation) — repeating won't help and burns the rate limit.
  const key = `${action.action}|${action.params?.device_id || ''}|${action.params?.service || ''}`;
  const recent = _lastActions.find(a => a.key === key && Date.now() - a.ts < 30 * 60_000);
  if (recent) {
    console.log('[SmartSteward] skipping repeat of ' + key + ' (last fired ' + Math.round((Date.now() - recent.ts) / 60_000) + 'm ago)');
    return;
  }

  console.log('[SmartSteward] executing:', action.action, JSON.stringify(action.params || {}));
  try {
    const result = await executeAction(action);
    _lastActions.push({ key, ts: Date.now(), action: action.action, result });
    if (_lastActions.length > 20) _lastActions.shift();
    // Persist for the dashboard — user wants visibility into autonomous decisions.
    insert(
      `INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`,
      {
        ':sid': 'smart-steward',
        ':type': 'SmartStewardAction',
        ':data': JSON.stringify({
          action: action.action,
          params: action.params || {},
          why: action.why || null,
          result,
          concerns: concerns.map(c => c.kind),
          timestamp: Date.now(),
        }),
      }
    );
  } catch (e) {
    console.warn('[SmartSteward] action execution failed:', e.message);
  }
}

// Survey the system for things that look wrong. Each concern is structured
// data the prompt can include verbatim — no string mangling required.
function surveyConcerns() {
  const concerns = [];
  // Open alerts in the last 6h
  try {
    const alerts = all(
      `SELECT id, alert_type, severity, title, detail, created_at
       FROM alerts
       WHERE status = 'open'
         AND created_at > datetime('now', 'localtime', '-6 hours')
       ORDER BY id DESC LIMIT :n`,
      { ':n': MAX_CONCERNS_PER_TICK }
    );
    for (const a of alerts) {
      let detail = {};
      try { detail = JSON.parse(a.detail || '{}'); } catch {}
      concerns.push({
        kind: 'open_alert',
        severity: a.severity,
        alert_type: a.alert_type,
        title: a.title,
        detail,
        created_at: a.created_at,
      });
    }
  } catch (e) {
    console.warn('[SmartSteward] alert survey failed:', e.message);
  }
  // Services that are down (Steward writes status_change events; we look at
  // the most recent state per service over the last hour)
  try {
    const rows = all(
      `SELECT created_at, data FROM events
       WHERE event_type = 'StewardAction'
         AND data LIKE '%status_change%'
         AND created_at > datetime('now', 'localtime', '-1 hour')
       ORDER BY id DESC LIMIT 30`
    );
    const latestPerService = new Map();
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data);
        if (d.action === 'status_change' && d.service && !latestPerService.has(d.service)) {
          latestPerService.set(d.service, d);
        }
      } catch {}
    }
    for (const [svcId, d] of latestPerService.entries()) {
      if (d.to === 'down' || d.to === 'giving_up') {
        concerns.push({
          kind: 'service_down',
          service_id: svcId,
          state: d.to,
          error: d.error || '(no error captured)',
          since: d.timestamp ? new Date(d.timestamp).toISOString() : null,
        });
      }
    }
  } catch (e) {
    console.warn('[SmartSteward] service survey failed:', e.message);
  }
  // Recent failed pan-client restart attempts (from the new ClientRestartAttempt
  // events). These tell the LLM that a remote watchdog tried something and
  // failed — useful context for deciding whether to push_update or escalate.
  try {
    const rows = all(
      `SELECT created_at, data FROM events
       WHERE event_type = 'ClientRestartAttempt'
         AND created_at > datetime('now', 'localtime', '-1 hour')
       ORDER BY id DESC LIMIT 5`
    );
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data);
        const failed = (d.attempts || []).filter(a => a.ok === false);
        if (failed.length) {
          concerns.push({
            kind: 'remote_watchdog_failures',
            device: d.device,
            failed_steps: failed.slice(0, 3),
          });
        }
      } catch {}
    }
  } catch (e) {
    console.warn('[SmartSteward] watchdog survey failed:', e.message);
  }
  return concerns.slice(0, MAX_CONCERNS_PER_TICK);
}

function buildPrompt(concerns) {
  const devices = all('SELECT hostname, online, last_seen FROM devices WHERE trusted = 1 ORDER BY last_seen DESC LIMIT 10');
  return `You are PAN's Smart Steward — an autonomous system-maintenance supervisor running every 5 minutes. Your job is to look at the current health of PAN's services and decide ONE safe corrective action per tick. You do NOT chat. You return JSON only.

CURRENT CONCERNS (in priority order):
${JSON.stringify(concerns, null, 2)}

KNOWN DEVICES (pan-client agents the hub can command):
${JSON.stringify(devices, null, 2)}

ALLOWED ACTIONS:
- {"action":"restart_service","params":{"device_id":"<hostname>","service":"<name>"},"why":"..."}
  Fires a restart_service command via WS or HTTP queue to the pan-client on the device. Use for services like ollama on a remote device.
- {"action":"push_update","params":{"device_id":"<hostname>","strategy":"git_pull"},"why":"..."}
  Trigger pan-client self-update on the device. Use when the device's pan-client is outdated (e.g. its restart_history is missing fields the hub expects).
- {"action":"create_alert","params":{"title":"...","severity":"warning|critical","detail":"..."},"why":"..."}
  Escalate to the human when autonomous fix is unsafe or you've already tried automated remediation and it didn't work.
- {"action":"no_op","params":{},"why":"<reason — e.g. transient blip, recent action still pending, etc.>"}

RULES:
1. ONE action per response. The next tick (5 minutes later) can take another.
2. Prefer no_op when in doubt. Burning Claude budget on bad guesses is worse than waiting another tick.
3. Never propose anything not in ALLOWED ACTIONS. No shell exec, no file deletion, no schema changes.
4. If the same problem persists across multiple ticks despite the autonomous fix, create_alert to surface it to the human — don't loop forever.
5. If a 'remote_watchdog_failures' concern is present for a step like 'probe_binary' (Ollama not on PATH), the fix is NOT a restart — it's a create_alert telling the user the binary needs to be installed.

Respond with ONLY the JSON action. No prose, no markdown fence.`;
}

function parseAction(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Strip markdown fence + thinking tags
  let s = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  s = s.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  // Extract first {...} block
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    if (obj && typeof obj === 'object' && typeof obj.action === 'string') return obj;
  } catch {}
  return null;
}

// Execute the chosen action. Each branch handles ONE action type and
// returns a result the persistence layer can store for the next tick to
// see. No branch ever throws to the caller — failures get returned as
// { ok: false, error } so the next tick can adjust.
async function executeAction(action) {
  switch (action.action) {
    case 'no_op':
      return { ok: true, action: 'no_op' };
    case 'create_alert':
      try {
        const p = action.params || {};
        createAlert({
          alert_type: 'smart_steward',
          severity: p.severity || 'warning',
          title: p.title || 'Smart Steward escalation',
          detail: typeof p.detail === 'string' ? p.detail : JSON.stringify(p.detail || {}),
        });
        return { ok: true, alert_created: true };
      } catch (e) { return { ok: false, error: e.message }; }
    case 'restart_service': {
      const p = action.params || {};
      if (!p.device_id || !p.service) return { ok: false, error: 'device_id and service required' };
      // Fire via the existing /api/v1/client/command endpoint (loopback HTTP
      // so we go through the WS-or-HTTP-queue logic for free).
      try {
        const r = await fetch('http://127.0.0.1:7777/api/v1/client/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: p.device_id, type: 'restart_service', service: p.service }),
          signal: AbortSignal.timeout(30_000),
        });
        const j = await r.json();
        return j;
      } catch (e) { return { ok: false, error: e.message }; }
    }
    case 'push_update': {
      const p = action.params || {};
      if (!p.device_id) return { ok: false, error: 'device_id required' };
      try {
        const r = await fetch('http://127.0.0.1:7777/api/v1/client/push-update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: p.device_id, strategy: p.strategy || 'git_pull' }),
          signal: AbortSignal.timeout(15_000),
        });
        const j = await r.json();
        return j;
      } catch (e) { return { ok: false, error: e.message }; }
    }
    default:
      return { ok: false, error: `unhandled action: ${action.action}` };
  }
}

// Diagnostic — exposed for the dashboard to render "last tick at" badges.
export function getSmartStewardStatus() {
  return {
    running: !!_tickTimer,
    tick_ms: TICK_MS,
    last_tick_at: _lastTickAt,
    recent_actions: _lastActions.slice(-10),
  };
}
