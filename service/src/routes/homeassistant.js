// Home Assistant API surface.
//
// Mounted at /api/v1/ha. The device layer lives in HA; this is the thin edge
// PAN's dashboard, voice router and MCP tools all call.
//
// See docs/HOME-ASSISTANT.md for the architecture and ../home-assistant.js for
// why event ingestion is domain-filtered rather than firehose.

import { Router } from 'express';
import {
  haStatus, listEntities, resolveEntity, controlEntity,
  callService, startHaEventStream, stopHaEventStream, setHaConfig,
} from '../home-assistant.js';

const router = Router();

function fail(res, err) {
  const msg = err?.message || String(err);
  // Not-configured is a normal state, not a server fault.
  const code = /not configured/i.test(msg) ? 400 : 502;
  return res.status(code).json({ ok: false, error: msg });
}

router.get('/status', (req, res) => res.json({ ok: true, ...haStatus() }));

router.get('/entities', async (req, res) => {
  try {
    const domain = req.query.domain ? String(req.query.domain) : null;
    const entities = await listEntities({ domain });
    res.json({ ok: true, count: entities.length, entities });
  } catch (err) { fail(res, err); }
});

// Preview what a phrase resolves to without acting on it. Worth having: it is
// how you debug "why did 'the theater' turn on the wrong thing".
router.get('/resolve', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const result = await resolveEntity(q);
    res.json({ ok: true, query: q, ...result });
  } catch (err) { fail(res, err); }
});

// The one voice and the dashboard both use.
// body: { query: "theater", action: "on" | "off" | "toggle" }
router.post('/control', async (req, res) => {
  try {
    const { query, action = 'toggle', ...extra } = req.body || {};
    if (!query) return res.status(400).json({ ok: false, error: 'query is required' });
    const result = await controlEntity(query, action, extra);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (err) { fail(res, err); }
});

// Escape hatch for anything the helpers above don't cover (scenes with data,
// climate setpoints, media seek, etc.)
router.post('/service', async (req, res) => {
  try {
    const { domain, service, data = {} } = req.body || {};
    if (!domain || !service) {
      return res.status(400).json({ ok: false, error: 'domain and service are required' });
    }
    const result = await callService(domain, service, data);
    res.json({ ok: true, result });
  } catch (err) { fail(res, err); }
});

router.post('/config', (req, res) => {
  try {
    const { url, token, enabled } = req.body || {};
    const status = setHaConfig({ url, token, enabled });
    res.json({ ok: true, ...status });
  } catch (err) { fail(res, err); }
});

router.post('/connect', async (req, res) => {
  try { res.json({ ok: true, ...(await startHaEventStream()) }); }
  catch (err) { fail(res, err); }
});

router.post('/disconnect', (req, res) => res.json({ ok: true, ...stopHaEventStream() }));

export default router;
