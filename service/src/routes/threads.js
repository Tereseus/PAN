// Thread relay HTTP surface — see src/thread-relay.js for the design.
//
//   Relay side (pan-client/thread-relay/relay.js):
//     POST /api/v1/threads/report            { host, threads:[{session_id,title,cwd,last_activity,pinned}] }
//     GET  /api/v1/threads/jobs/next?host=&wait=25000   long-poll; 204 when nothing arrived
//     POST /api/v1/threads/jobs/:id/delivered { delivery, message_id }
//     POST /api/v1/threads/jobs/:id/reply     { text }
//     POST /api/v1/threads/jobs/:id/fail      { error }
//
//   Anyone (dashboard, tests, MCP):
//     GET  /api/v1/threads                    registry + relay health
//     GET  /api/v1/threads/match?name=        what a spoken name resolves to
//     POST /api/v1/threads/ask                { target, text, wait_ms? } queue (and optionally wait)
//     GET  /api/v1/threads/jobs?host=&status= recent jobs
//     GET  /api/v1/threads/jobs/:id           one job

import { Router } from 'express';
import {
  ensureThreadRelaySchema, reportThreads, listThreads, relayStatus, matchThread, enqueueJob,
  claimNext, markDelivered, postReply, markFailed, getJob, listJobs, waitForOutcome, spokenOutcome,
  relayHeartbeat,
} from '../thread-relay.js';

const router = Router();

try { ensureThreadRelaySchema(); } catch (e) { console.warn('[Threads] schema init failed:', e?.message); }

router.get('/', (req, res) => {
  try { res.json({ ok: true, relays: relayStatus(), threads: listThreads() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/report', (req, res) => {
  const { host, threads } = req.body || {};
  if (!host || !Array.isArray(threads)) return res.status(400).json({ ok: false, error: 'host and threads[] required' });
  try { reportThreads(String(host), threads); res.json({ ok: true, count: threads.length }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/heartbeat', (req, res) => {
  const { host, info } = req.body || {};
  if (!host) return res.status(400).json({ ok: false, error: 'host required' });
  relayHeartbeat(String(host), info || {});
  res.json({ ok: true });
});

router.get('/match', (req, res) => {
  res.json({ ok: true, ...matchThread(String(req.query.name || '')) });
});

router.post('/ask', async (req, res) => {
  const { target, session_id, text, wait_ms = 0 } = req.body || {};
  if (!text || (!target && !session_id)) return res.status(400).json({ ok: false, error: 'text and target (or session_id) required' });
  try {
    let thread;
    if (session_id) {
      thread = listThreads().find(t => t.session_id === session_id);
      if (!thread) return res.status(404).json({ ok: false, error: 'unknown session_id' });
    } else {
      const m = matchThread(String(target));
      if (!m.ok) return res.status(404).json({ ok: false, error: m.reason, candidates: m.candidates });
      thread = m.thread;
    }
    const job = enqueueJob({ thread, text, source: 'api' });
    const waitMs = Math.min(Number(wait_ms) || 0, 120_000);
    if (!waitMs) return res.json({ ok: true, job });
    const outcome = await waitForOutcome(job.id, waitMs);
    res.json({ ok: true, job: outcome || getJob(job.id), spoken: outcome ? spokenOutcome(outcome) : null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/jobs', (req, res) => {
  res.json({ ok: true, jobs: listJobs({ host: req.query.host || null, status: req.query.status || null, limit: req.query.limit }) });
});

router.get('/jobs/next', async (req, res) => {
  const host = String(req.query.host || '');
  if (!host) return res.status(400).json({ ok: false, error: 'host required' });
  let closed = false;
  req.on('close', () => { closed = true; });
  try {
    const job = await claimNext(host, Number(req.query.wait) || 25_000);
    if (!job) return res.status(204).end();
    if (closed) {
      // The relay hung up mid-poll; put the job back so the next poll gets it.
      const { run } = await import('../db.js');
      run(`UPDATE thread_relay_jobs SET status = 'queued', claimed_at = NULL WHERE id = :id AND status = 'claimed'`, { ':id': job.id });
      return;
    }
    res.json({ ok: true, job });
  } catch (e) { if (!closed) res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'no such job' });
  res.json({ ok: true, job });
});

router.post('/jobs/:id/delivered', (req, res) => {
  const job = markDelivered(req.params.id, req.body || {});
  if (!job) return res.status(404).json({ ok: false, error: 'no such job' });
  res.json({ ok: true, job });
});

router.post('/jobs/:id/reply', async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ ok: false, error: 'text required' });
  try { res.json(await postReply(req.params.id, text)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/jobs/:id/fail', async (req, res) => {
  try { res.json(await markFailed(req.params.id, (req.body || {}).error)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
