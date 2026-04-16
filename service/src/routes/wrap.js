// PAN Wrapper routes — Tauri webview wrappers around third-party apps.
//
// Flow:
//   1. Dashboard (or voice) calls POST /api/v1/wrap/open/:service
//   2. This route looks up the content script for that service, builds an
//      initScript payload, and POSTs it to the Tauri shell's /open endpoint.
//   3. Tauri opens a webview pointing at the service URL with the script
//      injected at page load.
//   4. The content script observes the DOM and POSTs messages to the Tauri
//      shell's /wrap/inbound, which forwards to /api/v1/wrap/inbound here.
//   5. We write the messages to the events table and the wrap_messages table.

import { Router } from 'express';
import { db } from '../db.js';
import { DISCORD_CONTENT_SCRIPT } from '../wrappers/discord.js';

const router = Router();
const TAURI_SHELL = 'http://127.0.0.1:7790';

// Registry of supported wrappers.
// Each entry: { url, script, title, label_prefix }
const WRAPPERS = {
  discord: {
    url: 'https://discord.com/app',
    script: DISCORD_CONTENT_SCRIPT,
    title: 'Discord (PAN)',
    label_prefix: 'wrap-discord',
  },
};

export function ensureWrapSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wrap_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL,                -- 'discord', 'slack', etc.
      msg_id TEXT,                          -- service-specific message id
      author TEXT,
      text TEXT,
      timestamp TEXT,                       -- ISO string from the service
      channel_id TEXT,
      guild_id TEXT,
      url TEXT,
      raw_json TEXT,                        -- original payload
      received_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      org_id TEXT NOT NULL DEFAULT 'org_personal'
    );
    CREATE INDEX IF NOT EXISTS idx_wrap_messages_service ON wrap_messages(service, received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wrap_messages_msg_id ON wrap_messages(service, msg_id);
  `);
}

// GET /api/v1/wrap/services — list supported wrappers
router.get('/services', (req, res) => {
  res.json({
    services: Object.keys(WRAPPERS).map(k => ({
      id: k,
      url: WRAPPERS[k].url,
      title: WRAPPERS[k].title,
    })),
  });
});

// POST /api/v1/wrap/open/:service — open a Tauri webview with the service wrapped
// Closes any existing windows for the same service first (no stale wrappers running old scripts).
router.post('/open/:service', async (req, res) => {
  const { service } = req.params;
  const wrapper = WRAPPERS[service];
  if (!wrapper) return res.status(404).json({ ok: false, error: `unknown service: ${service}` });

  // Close existing wrappers for this service so the new one doesn't race with stale scripts
  try {
    const winsResp = await fetch(`${TAURI_SHELL}/windows`);
    if (winsResp.ok) {
      const winsData = await winsResp.json();
      const stale = (winsData.windows || []).filter(w => (w.id || '').startsWith(wrapper.label_prefix));
      for (const w of stale) {
        await fetch(`${TAURI_SHELL}/close`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ windowId: w.id }),
        }).catch(() => {});
      }
    }
  } catch {}

  const label = `${wrapper.label_prefix}-${Date.now().toString(36)}`;
  const payload = {
    url: wrapper.url,
    title: wrapper.title,
    label,
    initScript: wrapper.script,
    width: 1280,
    height: 860,
  };

  try {
    const r = await fetch(`${TAURI_SHELL}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) return res.status(502).json({ ok: false, error: data.error || 'tauri open failed' });
    res.json({ ok: true, service, windowId: data.windowId, label });
  } catch (err) {
    res.status(502).json({ ok: false, error: `tauri unreachable: ${err.message}` });
  }
});

// POST /api/v1/wrap/inbound — content scripts POST messages here (forwarded by Tauri shell)
router.post('/inbound', (req, res) => {
  const body = req.body || {};
  const { type, service } = body;
  if (!service) return res.status(400).json({ ok: false, error: 'service required' });

  try {
    if (type === 'message') {
      const { msg_id, author, text, timestamp, channel_id, guild_id, url } = body;
      // Dedupe by (service, msg_id) — but allow "upgrade" when the row
      // originally arrived with null text and now real text is available.
      if (msg_id) {
        const existing = db.prepare('SELECT id, text, author FROM wrap_messages WHERE service = ? AND msg_id = ?').get(service, msg_id);
        if (existing) {
          const wantUpgrade = (text && !existing.text) || (author && !existing.author);
          if (!wantUpgrade) return res.json({ ok: true, deduped: true });
          db.prepare(`
            UPDATE wrap_messages
            SET text = COALESCE(?, text),
                author = COALESCE(?, author),
                timestamp = COALESCE(?, timestamp),
                raw_json = ?
            WHERE id = ?
          `).run(text || null, author || null, timestamp || null, JSON.stringify(body), existing.id);
          try {
            db.prepare(`
              INSERT INTO events (event_type, session_id, data, org_id)
              VALUES ('WrapMessage', ?, ?, 'org_personal')
            `).run(`wrap-${service}`, JSON.stringify({ service, author, text, channel_id, url, upgrade: true }));
          } catch {}
          return res.json({ ok: true, upgraded: true });
        }
      }
      db.prepare(`
        INSERT INTO wrap_messages (service, msg_id, author, text, timestamp, channel_id, guild_id, url, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(service, msg_id || null, author || null, text || null, timestamp || null, channel_id || null, guild_id || null, url || null, JSON.stringify(body));

      // Also log an event so the Events feed + memory pipeline see it
      try {
        db.prepare(`
          INSERT INTO events (event_type, session_id, data, org_id)
          VALUES ('WrapMessage', ?, ?, 'org_personal')
        `).run(`wrap-${service}`, JSON.stringify({ service, author, text, channel_id, url }));
      } catch {}

      return res.json({ ok: true });
    }

    if (type === 'ready') {
      try {
        db.prepare(`
          INSERT INTO events (event_type, session_id, data, org_id)
          VALUES ('WrapReady', ?, ?, 'org_personal')
        `).run(`wrap-${service}`, JSON.stringify(body));
      } catch {}
      return res.json({ ok: true });
    }

    if (type === 'heartbeat') {
      try {
        db.prepare(`
          INSERT INTO events (event_type, session_id, data, org_id)
          VALUES ('WrapHeartbeat', ?, ?, 'org_personal')
        `).run(`wrap-${service}`, JSON.stringify(body));
      } catch {}
      return res.json({ ok: true });
    }

    if (type === 'debug') {
      try {
        db.prepare(`
          INSERT INTO events (event_type, session_id, data, org_id)
          VALUES ('WrapDebug', ?, ?, 'org_personal')
        `).run(`wrap-${service}`, JSON.stringify(body));
      } catch {}
      return res.json({ ok: true });
    }

    if (type === 'send_result' || type === 'send_error') {
      try {
        db.prepare(`
          INSERT INTO events (event_type, session_id, data, org_id)
          VALUES ('WrapSend', ?, ?, 'org_personal')
        `).run(`wrap-${service}`, JSON.stringify(body));
      } catch {}
      return res.json({ ok: true });
    }

    res.json({ ok: true, ignored: true, type });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/v1/wrap/send/:service — send a message through a wrapped app
// Body: { text }   Finds the newest wrapper window for the service and evals
// window.__PAN_SEND__(text) inside it. Requires the wrapper to already be open.
router.post('/send/:service', async (req, res) => {
  const { service } = req.params;
  const text = (req.body?.text || '').toString();
  if (!WRAPPERS[service]) return res.status(404).json({ ok: false, error: `unknown service: ${service}` });
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });
  const prefix = WRAPPERS[service].label_prefix;

  try {
    const winsResp = await fetch(`${TAURI_SHELL}/windows`);
    if (!winsResp.ok) return res.status(502).json({ ok: false, error: 'tauri /windows failed' });
    const winsData = await winsResp.json();
    const candidates = (winsData.windows || []).filter(w => (w.id || '').startsWith(prefix));
    if (candidates.length === 0) {
      return res.status(409).json({ ok: false, error: `no open ${service} wrapper — call /api/v1/wrap/open/${service} first` });
    }
    // Use the newest window (highest created_at)
    candidates.sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
    const windowId = candidates[0].id;

    // Escape text for JS string literal — JSON.stringify handles quotes, newlines, unicode.
    const js = `(async () => { try { if (typeof window.__PAN_SEND__ !== 'function') { return fetch('http://127.0.0.1:7790/wrap/inbound', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({type:'send_error',service:'${service}',error:'__PAN_SEND__ missing'})}); } const ok = await window.__PAN_SEND__(${JSON.stringify(text)}); fetch('http://127.0.0.1:7790/wrap/inbound', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({type:'send_result',service:'${service}',text:${JSON.stringify(text)},ok}) }); } catch(e) { fetch('http://127.0.0.1:7790/wrap/inbound', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({type:'send_error',service:'${service}',error:e.message}) }); } })();`;

    const evalResp = await fetch(`${TAURI_SHELL}/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowId, js }),
    });
    const evalData = await evalResp.json();
    if (!evalResp.ok || !evalData.ok) return res.status(502).json({ ok: false, error: evalData.error || 'eval failed' });
    res.json({ ok: true, service, windowId, text });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// GET /api/v1/wrap/messages?service=discord&limit=50 — recent wrapped messages
router.get('/messages', (req, res) => {
  const service = req.query.service;
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const where = service ? 'WHERE service = ?' : '';
  const params = service ? [service] : [];
  const rows = db.prepare(`
    SELECT id, service, msg_id, author, text, timestamp, channel_id, guild_id, url, received_at
    FROM wrap_messages ${where}
    ORDER BY received_at DESC LIMIT ?
  `).all(...params, limit);
  res.json({ messages: rows, count: rows.length });
});

export default router;
