// PAN Dashboard Registry — the list of purpose-built HTML monitoring dashboards
// PAN knows about.
//
// Design (Tereseus, 2026-07): instead of one universal dashboard + a universal
// remote poller (which proved a dead end), each thing worth watching gets its
// own plain-HTML page fed by its own push scripts — WoE, ServiceNow, ops, etc.
// These often live on a different host/port (localhost:877x, 100.86.16.10:8791,
// …). Registering them here lets PAN know what exists, health-check them, and
// render them on the phone (/mobile) — plain HTML renders on mobile where the
// SvelteKit dashboard never did. This is the north-star "watch" surface.
//
//   GET    /api/v1/dashboards         → list (with last-known health)
//   GET    /api/v1/dashboards/probe   → ping every dashboard, update health, return list
//   POST   /api/v1/dashboards         → register { name, url, description?, category?, project?, icon? }
//   PUT    /api/v1/dashboards/:id     → update fields
//   DELETE /api/v1/dashboards/:id     → remove
//
// Always mounted, every profile — the registry is how PAN "knows" the user's
// monitoring surfaces regardless of which profile it boots.

import { Router } from 'express';
import { db, run, get, all } from '../db.js';

const router = Router();

// ── table (self-contained migration at module load, like client-manager) ──
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboards (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      url         TEXT NOT NULL,
      description TEXT,
      category    TEXT,
      project     TEXT,
      icon        TEXT,
      host        TEXT,
      port        INTEGER,
      status      TEXT DEFAULT 'unknown',
      last_seen   TEXT,
      added_at    TEXT DEFAULT (datetime('now','localtime')),
      org_id      TEXT DEFAULT 'org_personal'
    );
  `);
} catch (e) { console.warn('[Dashboards] table init failed:', e?.message); }

function normalizeUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u; // bare host:port → http
  return u;
}

function parseHostPort(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: u.port ? parseInt(u.port) : (u.protocol === 'https:' ? 443 : 80) };
  } catch { return { host: null, port: null }; }
}

// Cheap reachability check. Many hand-rolled dashboards don't implement HEAD,
// so GET with a short timeout and treat any HTTP response (even 4xx) as "up" —
// we only care whether the server is answering, not the exact status.
async function probe(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3500);
  try {
    const r = await fetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'manual' });
    clearTimeout(t);
    return r.status < 500;
  } catch { clearTimeout(t); return false; }
}

router.get('/', (req, res) => {
  try { res.json({ ok: true, dashboards: all('SELECT * FROM dashboards ORDER BY category, name') || [] }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/probe', async (req, res) => {
  try {
    const rows = all('SELECT id, url FROM dashboards') || [];
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await Promise.allSettled(rows.map(async (r) => {
      const up = await probe(r.url);
      run("UPDATE dashboards SET status = :s, last_seen = CASE WHEN :s = 'up' THEN :now ELSE last_seen END WHERE id = :id",
          { ':s': up ? 'up' : 'down', ':now': now, ':id': r.id });
    }));
    res.json({ ok: true, dashboards: all('SELECT * FROM dashboards ORDER BY category, name') || [] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/', (req, res) => {
  try {
    const b = req.body || {};
    const url = normalizeUrl(b.url);
    const name = String(b.name || '').trim();
    if (!name || !url) return res.status(400).json({ ok: false, error: 'name and url required' });
    const { host, port } = parseHostPort(url);
    const info = run(
      `INSERT INTO dashboards (name, url, description, category, project, icon, host, port, org_id)
       VALUES (:name, :url, :description, :category, :project, :icon, :host, :port, :org_id)`,
      { ':name': name, ':url': url, ':description': b.description || null, ':category': b.category || null,
        ':project': b.project || null, ':icon': b.icon || null, ':host': host, ':port': port,
        ':org_id': req.org_id || 'org_personal' });
    const row = get('SELECT * FROM dashboards WHERE id = :id', { ':id': info.lastInsertRowid });
    res.json({ ok: true, dashboard: row });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.put('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = get('SELECT * FROM dashboards WHERE id = :id', { ':id': id });
    if (!existing) return res.status(404).json({ ok: false, error: 'not found' });
    const b = req.body || {};
    const url = b.url != null ? normalizeUrl(b.url) : existing.url;
    const { host, port } = parseHostPort(url);
    run(`UPDATE dashboards SET name=:name, url=:url, description=:description, category=:category,
         project=:project, icon=:icon, host=:host, port=:port WHERE id=:id`,
        { ':name': b.name ?? existing.name, ':url': url, ':description': b.description ?? existing.description,
          ':category': b.category ?? existing.category, ':project': b.project ?? existing.project,
          ':icon': b.icon ?? existing.icon, ':host': host, ':port': port, ':id': id });
    res.json({ ok: true, dashboard: get('SELECT * FROM dashboards WHERE id = :id', { ':id': id }) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.delete('/:id', (req, res) => {
  try {
    run('DELETE FROM dashboards WHERE id = :id', { ':id': parseInt(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

export default router;
