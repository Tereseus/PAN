// PAN Voice Routes — Speaker enrollment, identification, voice print management
//
// POST /api/v1/voice/enroll      — enroll a speaker from uploaded audio
// POST /api/v1/voice/identify    — identify speaker from uploaded audio
// GET  /api/v1/voice/speakers    — list enrolled speakers
// DELETE /api/v1/voice/speaker/:label — remove a speaker
// GET  /api/v1/voice/status      — whisper+speaker server health

import { db } from '../db.js';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import http from 'http';

const WHISPER_HOST = '127.0.0.1';
const WHISPER_PORT = 7782;
const WHISPER_URL  = `http://${WHISPER_HOST}:${WHISPER_PORT}`;

// Use native http module — Python BaseHTTP speaks HTTP/1.0 which Node.js fetch (undici) rejects.
function whisperRequest(method, path, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: WHISPER_HOST, port: WHISPER_PORT,
      path, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ ok: false, status: res.statusCode, body: { error: data } }); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function whisperAvailable() {
  try { const r = await whisperRequest('GET', '/', null, 1000); return r.ok; }
  catch { return false; }
}

// Raw audio body parser for browser enrollment
import express from 'express';

export function registerVoiceRoutes(app) {

  // Health / status
  app.get('/api/v1/voice/status', async (req, res) => {
    try {
      const r = await whisperRequest('GET', '/', null, 2000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      res.json({ ok: true, ...r.body });
    } catch (e) {
      res.json({ ok: false, error: 'Whisper server not reachable', detail: e.message });
    }
  });

  // List enrolled speakers
  app.get('/api/v1/voice/speakers', async (req, res) => {
    try {
      // Get live speakers from whisper server
      let liveSpeakers = [];
      try {
        const r = await whisperRequest('GET', '/speakers', null, 1000);
        liveSpeakers = r.body?.speakers || [];
      } catch {}

      // Sync: ensure every live speaker has a DB row (catches pre-DB enrollments)
      const upsert = db.prepare(`
        INSERT INTO voice_prints (label, embedding, sample_count, org_id)
        VALUES (?, ?, 1, 'org_personal')
        ON CONFLICT(label, org_id) DO NOTHING
      `);
      for (const label of liveSpeakers) {
        try { upsert.run(label, Buffer.alloc(0)); } catch {}
      }

      const dbSpeakers = db.prepare(
        'SELECT label, sample_count, created_at, updated_at FROM voice_prints WHERE org_id = ? ORDER BY label'
      ).all('org_personal');

      res.json({ speakers: dbSpeakers, live: liveSpeakers });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Enroll a speaker — accepts multipart audio upload or wav_path
  app.post('/api/v1/voice/enroll', async (req, res) => {
    const { label, wav_path } = req.body || {};
    if (!label) return res.status(400).json({ error: 'label required' });

    let filePath = wav_path;
    let tempFile = null;

    // If raw audio bytes sent as body with Content-Type audio/*
    if (!filePath && req.headers['content-type']?.startsWith('audio/')) {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      await new Promise(resolve => req.on('end', resolve));
      tempFile = join(tmpdir(), `pan-enroll-${randomBytes(8).toString('hex')}.wav`);
      writeFileSync(tempFile, Buffer.concat(chunks));
      filePath = tempFile;
    }

    if (!filePath || !existsSync(filePath)) {
      return res.status(400).json({ error: 'wav_path required and must exist on server' });
    }

    try {
      if (!(await whisperAvailable())) {
        return res.status(503).json({ error: 'Whisper/speaker server not running' });
      }

      const r = await whisperRequest('POST', '/enroll', { label, wav_path: filePath }, 15000);
      const data = r.body;
      if (!r.ok) return res.status(r.status).json(data);

      // Persist to DB
      db.prepare(`
        INSERT INTO voice_prints (label, embedding, sample_count, org_id)
        VALUES (?, ?, 1, 'org_personal')
        ON CONFLICT(label, org_id) DO UPDATE SET
          sample_count = sample_count + 1,
          updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
      `).run(label, Buffer.alloc(0)); // embedding stored in .npz file, DB tracks metadata

      res.json({ ok: true, label, enrolled: data.enrolled });
    } catch (e) {
      res.status(500).json({ error: e.message });
    } finally {
      if (tempFile) try { unlinkSync(tempFile); } catch {}
    }
  });

  // Identify speaker from audio file
  app.post('/api/v1/voice/identify', async (req, res) => {
    const { wav_path } = req.body || {};
    if (!wav_path || !existsSync(wav_path)) {
      return res.status(400).json({ error: 'wav_path required' });
    }
    try {
      const r = await whisperRequest('POST', '/identify', { wav_path }, 10000);
      res.json(r.body);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Browser enrollment — accepts raw WebM audio from MediaRecorder
  // POST with Content-Type: audio/webm and X-Speaker-Label header
  app.post('/api/v1/voice/enroll-browser',
    express.raw({ type: ['audio/webm', 'audio/ogg', 'application/octet-stream'], limit: '20mb' }),
    async (req, res) => {
      // Label can come from header or query string
      const label = (req.headers['x-speaker-label'] || req.query.label || '').trim();
      if (!label) return res.status(400).json({ error: 'label required (X-Speaker-Label header or ?label= query)' });

      const audioBuffer = req.body;
      if (!audioBuffer || audioBuffer.length < 1000) {
        return res.status(400).json({ error: 'Audio too short or missing' });
      }

      const tmpFile = join(tmpdir(), `pan-enroll-${randomBytes(6).toString('hex')}.webm`);
      let ok = false;
      try {
        writeFileSync(tmpFile, audioBuffer);

        if (!(await whisperAvailable())) {
          return res.status(503).json({ error: 'Voice server not running' });
        }

        const r = await whisperRequest('POST', '/enroll', { label, wav_path: tmpFile }, 20000);
        const data = r.body;
        if (!r.ok) return res.status(r.status).json(data);

        // Track in DB
        db.prepare(`
          INSERT INTO voice_prints (label, embedding, sample_count, org_id)
          VALUES (?, ?, 1, 'org_personal')
          ON CONFLICT(label, org_id) DO UPDATE SET
            sample_count = sample_count + 1,
            updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
        `).run(label, Buffer.alloc(0));

        ok = true;
        res.json({ ok: true, label, enrolled: data.enrolled });
      } catch (e) {
        if (!ok) res.status(500).json({ error: e.message });
      } finally {
        try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch {}
      }
    }
  );

  // Server-side recording enrollment — mic captured by whisper-server.py (no browser permission needed)
  app.post('/api/v1/voice/record-enroll', async (req, res) => {
    const { label, seconds = 10 } = req.body || {};
    if (!label) return res.status(400).json({ error: 'label required' });
    try {
      if (!(await whisperAvailable())) {
        return res.status(503).json({ error: 'Whisper server not running' });
      }
      const r = await whisperRequest('POST', '/record-enroll', { label, seconds }, (seconds + 5) * 1000);
      const data = r.body;
      if (!r.ok) return res.status(r.status).json(data);

      // Track in DB
      db.prepare(`
        INSERT INTO voice_prints (label, embedding, sample_count, org_id)
        VALUES (?, ?, 1, 'org_personal')
        ON CONFLICT(label, org_id) DO UPDATE SET
          sample_count = sample_count + 1,
          updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
      `).run(label, Buffer.alloc(0));

      res.json({ ok: true, label, enrolled: data.enrolled });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Remove a speaker
  app.delete('/api/v1/voice/speaker/:label', async (req, res) => {
    const { label } = req.params;
    try {
      // Remove from whisper server
      await fetch(`${WHISPER_URL}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
        signal: AbortSignal.timeout(5000),
      });
      // Remove from DB
      db.prepare("DELETE FROM voice_prints WHERE label = ? AND org_id = 'org_personal'").run(label);
      res.json({ ok: true, label });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
