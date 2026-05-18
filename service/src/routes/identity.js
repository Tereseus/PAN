// T3 — Identity → user binding.
//
// Backs the dashboard Identity panel (lives inside T10 Devices panel as a
// sub-section) and the auto-bind logic invoked by webcam-watcher.js +
// voice.js when face/voice are recognised.
//
// Endpoints:
//   GET    /api/v1/identity/clusters                  — list all + status
//   GET    /api/v1/identity/clusters/:id              — one cluster + samples
//   POST   /api/v1/identity/clusters/:id/bind         — manual confirm { user_id }
//   POST   /api/v1/identity/clusters/:id/reject       — reject as not a real person
//   POST   /api/v1/identity/observe                   — internal hook (webcam/voice)
//   GET    /api/v1/identity/thumb/:id                 — JPEG byte stream for UI
//   GET    /api/v1/identity/voice/:id                 — voice sample byte stream
//
// Auto-bind rule (the heart of T3):
//   joint_conf = (last_face_conf ?? 0) * (last_voice_conf ?? 0)
//   if joint_conf >= 0.85 AND cluster.label matches a users.display_name (CI),
//   then identity_clusters.user_id = users.id, status='auto'.
//   Otherwise the row stays status='pending' and shows up in the dashboard.

import { Router } from 'express';
import { all, get, run } from '../db.js';
import { existsSync, mkdirSync, writeFileSync, createReadStream } from 'fs';
import { join } from 'path';
import { platform } from 'os';
import { getDataDir } from '../platform.js';

const router = Router();

const AUTO_BIND_JOINT_CONF = 0.85;     // face_conf * voice_conf
const RECENT_MATCH_WINDOW_MS = 5 * 60 * 1000; // face + voice must agree within 5 min

// ── Storage paths ────────────────────────────────────────────────────────────
let _thumbsDir = null;
let _voiceDir = null;
function thumbsDir() {
  if (_thumbsDir) return _thumbsDir;
  _thumbsDir = join(getDataDir(), 'identity-thumbs');
  if (!existsSync(_thumbsDir)) mkdirSync(_thumbsDir, { recursive: true });
  return _thumbsDir;
}
function voiceDir() {
  if (_voiceDir) return _voiceDir;
  _voiceDir = join(getDataDir(), 'identity-voice');
  if (!existsSync(_voiceDir)) mkdirSync(_voiceDir, { recursive: true });
  return _voiceDir;
}

// ── Upsert helpers ───────────────────────────────────────────────────────────
function upsertClusterByLabel(label) {
  let cluster = get(
    `SELECT * FROM identity_clusters WHERE label = :label`,
    { ':label': label }
  );
  if (cluster) return cluster;
  const r = run(
    `INSERT INTO identity_clusters (label, status, observation_count, confidence, last_seen_at, created_at)
     VALUES (:label, 'pending', 0, 0.0, datetime('now','localtime'), datetime('now','localtime'))`,
    { ':label': label }
  );
  return get(`SELECT * FROM identity_clusters WHERE id = :id`, { ':id': r.lastInsertRowid });
}

function attemptAutoBind(clusterId) {
  const c = get(`SELECT * FROM identity_clusters WHERE id = :id`, { ':id': clusterId });
  if (!c) return { bound: false, reason: 'no_cluster' };
  if (c.user_id) return { bound: true, reason: 'already_bound', user_id: c.user_id };

  const faceConf  = Number(c.last_face_conf || 0);
  const voiceConf = Number(c.last_voice_conf || 0);
  const joint = faceConf * voiceConf;

  if (joint < AUTO_BIND_JOINT_CONF) {
    return { bound: false, reason: 'low_joint_conf', joint, face: faceConf, voice: voiceConf };
  }

  // Check recency — both signals must agree within window
  if (c.last_match_at) {
    const age = Date.now() - new Date(c.last_match_at).getTime();
    if (age > RECENT_MATCH_WINDOW_MS) {
      return { bound: false, reason: 'stale_match', age_ms: age };
    }
  }

  // Match label → users.display_name (case-insensitive)
  const user = get(
    `SELECT id, display_name FROM users
     WHERE LOWER(display_name) = LOWER(:label)
        OR LOWER(COALESCE(display_nickname,'')) = LOWER(:label)
     LIMIT 1`,
    { ':label': c.label }
  );
  if (!user) {
    return { bound: false, reason: 'no_matching_user', label: c.label };
  }

  run(
    `UPDATE identity_clusters SET user_id = :uid, status = 'auto' WHERE id = :id`,
    { ':uid': user.id, ':id': clusterId }
  );
  return { bound: true, reason: 'auto', user_id: user.id, joint };
}

// ── GET /api/v1/identity/clusters ────────────────────────────────────────────
router.get('/clusters', (req, res) => {
  try {
    const rows = all(`
      SELECT c.id, c.label, c.status, c.user_id, c.observation_count,
             c.last_face_conf, c.last_voice_conf, c.last_match_at, c.last_seen_at,
             c.face_thumbnail_path IS NOT NULL AS has_thumb,
             c.voice_sample_path  IS NOT NULL AS has_voice,
             u.display_name AS user_display_name
        FROM identity_clusters c
   LEFT JOIN users u ON u.id = c.user_id
    ORDER BY (c.user_id IS NULL) DESC, c.last_seen_at DESC
    `);
    res.json({ ok: true, clusters: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/v1/identity/clusters/:id ────────────────────────────────────────
router.get('/clusters/:id', (req, res) => {
  try {
    const row = get(
      `SELECT c.*, u.display_name AS user_display_name
         FROM identity_clusters c
    LEFT JOIN users u ON u.id = c.user_id
        WHERE c.id = :id`,
      { ':id': Number(req.params.id) }
    );
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    const obs = all(
      `SELECT * FROM identity_observations WHERE cluster_id = :id ORDER BY created_at DESC LIMIT 20`,
      { ':id': row.id }
    );
    res.json({ ok: true, cluster: row, observations: obs });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/v1/identity/clusters/:id/bind ──────────────────────────────────
// Manual confirm — body: { user_id }
router.post('/clusters/:id/bind', (req, res) => {
  try {
    const id = Number(req.params.id);
    const userId = Number(req.body?.user_id);
    if (!userId) return res.status(400).json({ ok: false, error: 'user_id required' });

    const cluster = get(`SELECT id FROM identity_clusters WHERE id = :id`, { ':id': id });
    if (!cluster) return res.status(404).json({ ok: false, error: 'cluster_not_found' });

    const user = get(`SELECT id, display_name FROM users WHERE id = :uid`, { ':uid': userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

    run(
      `UPDATE identity_clusters SET user_id = :uid, status = 'manual' WHERE id = :id`,
      { ':uid': userId, ':id': id }
    );
    res.json({ ok: true, cluster_id: id, user_id: userId, status: 'manual' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/v1/identity/clusters/:id/reject ────────────────────────────────
// Mark as not a real person / spurious detection.
router.post('/clusters/:id/reject', (req, res) => {
  try {
    const id = Number(req.params.id);
    run(
      `UPDATE identity_clusters SET status = 'rejected', user_id = NULL WHERE id = :id`,
      { ':id': id }
    );
    res.json({ ok: true, cluster_id: id, status: 'rejected' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/v1/identity/observe ────────────────────────────────────────────
// Internal hook. Called by webcam-watcher.js with face data, and by voice.js
// when speaker is recognised. We don't require auth here because it's only
// reachable from localhost (same as /presence).
//
// Body shape:
//   { kind: 'face', label, confidence, thumb_b64?, camera? }
//   { kind: 'voice', label, confidence, sample_path? }
//
router.post('/observe', (req, res) => {
  try {
    const { kind, label, confidence } = req.body || {};
    if (!kind || !label || typeof confidence !== 'number') {
      return res.status(400).json({ ok: false, error: 'kind, label, confidence required' });
    }
    const cluster = upsertClusterByLabel(String(label));

    // Persist optional sample data
    let thumbPath = cluster.face_thumbnail_path;
    let voicePath = cluster.voice_sample_path;

    if (kind === 'face' && req.body.thumb_b64) {
      thumbPath = join(thumbsDir(), `cluster_${cluster.id}.jpg`);
      try {
        const b = String(req.body.thumb_b64).replace(/^data:image\/[a-z]+;base64,/, '');
        writeFileSync(thumbPath, Buffer.from(b, 'base64'));
      } catch (e) {
        // non-fatal — keep going without thumb
        thumbPath = cluster.face_thumbnail_path;
      }
    }
    if (kind === 'voice' && req.body.sample_path) {
      voicePath = String(req.body.sample_path);
    }

    // Update the appropriate confidence + sample column
    if (kind === 'face') {
      run(
        `UPDATE identity_clusters
            SET last_face_conf = :conf,
                face_thumbnail_path = COALESCE(:thumb, face_thumbnail_path),
                observation_count = observation_count + 1,
                last_seen_at = datetime('now','localtime')
          WHERE id = :id`,
        { ':conf': confidence, ':thumb': thumbPath, ':id': cluster.id }
      );
    } else if (kind === 'voice') {
      run(
        `UPDATE identity_clusters
            SET last_voice_conf = :conf,
                voice_sample_path = COALESCE(:sample, voice_sample_path),
                observation_count = observation_count + 1,
                last_seen_at = datetime('now','localtime'),
                voice_profile = :label
          WHERE id = :id`,
        { ':conf': confidence, ':sample': voicePath, ':id': cluster.id, ':label': label }
      );
    }

    // Always log a row in identity_observations for the audit trail
    try {
      run(
        `INSERT INTO identity_observations (cluster_id, camera, match_score, note)
         VALUES (:cid, :cam, :score, :note)`,
        {
          ':cid': cluster.id,
          ':cam': req.body.camera || null,
          ':score': confidence,
          ':note': `kind=${kind}`,
        }
      );
    } catch {} // missing columns in old schemas — non-fatal

    // If both face + voice have fresh confidences, stamp last_match_at and try auto-bind
    const fresh = get(`SELECT last_face_conf, last_voice_conf FROM identity_clusters WHERE id = :id`,
      { ':id': cluster.id });
    if (fresh.last_face_conf > 0 && fresh.last_voice_conf > 0) {
      run(
        `UPDATE identity_clusters SET last_match_at = datetime('now','localtime') WHERE id = :id`,
        { ':id': cluster.id }
      );
    }

    const bindResult = attemptAutoBind(cluster.id);
    res.json({ ok: true, cluster_id: cluster.id, bind: bindResult });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/v1/identity/thumb/:id ───────────────────────────────────────────
router.get('/thumb/:id', (req, res) => {
  const row = get(`SELECT face_thumbnail_path FROM identity_clusters WHERE id = :id`,
    { ':id': Number(req.params.id) });
  if (!row?.face_thumbnail_path || !existsSync(row.face_thumbnail_path)) {
    return res.status(404).end();
  }
  res.setHeader('Content-Type', 'image/jpeg');
  createReadStream(row.face_thumbnail_path).pipe(res);
});

// ── GET /api/v1/identity/voice/:id ───────────────────────────────────────────
router.get('/voice/:id', (req, res) => {
  const row = get(`SELECT voice_sample_path FROM identity_clusters WHERE id = :id`,
    { ':id': Number(req.params.id) });
  if (!row?.voice_sample_path || !existsSync(row.voice_sample_path)) {
    return res.status(404).end();
  }
  res.setHeader('Content-Type', 'audio/wav');
  createReadStream(row.voice_sample_path).pipe(res);
});

export default router;

// Programmatic API for in-process callers (webcam-watcher, voice route)
export function observeFace({ label, confidence, thumb_b64, camera }) {
  // Mirror /observe but skip HTTP — same logic, in-process.
  if (!label || typeof confidence !== 'number') return null;
  const cluster = upsertClusterByLabel(String(label));
  let thumbPath = cluster.face_thumbnail_path;
  if (thumb_b64) {
    try {
      thumbPath = join(thumbsDir(), `cluster_${cluster.id}.jpg`);
      const b = String(thumb_b64).replace(/^data:image\/[a-z]+;base64,/, '');
      writeFileSync(thumbPath, Buffer.from(b, 'base64'));
    } catch { thumbPath = cluster.face_thumbnail_path; }
  }
  run(
    `UPDATE identity_clusters
        SET last_face_conf = :conf,
            face_thumbnail_path = COALESCE(:thumb, face_thumbnail_path),
            observation_count = observation_count + 1,
            last_seen_at = datetime('now','localtime')
      WHERE id = :id`,
    { ':conf': confidence, ':thumb': thumbPath, ':id': cluster.id }
  );
  try {
    run(
      `INSERT INTO identity_observations (cluster_id, camera, match_score, note)
       VALUES (:cid, :cam, :score, 'kind=face')`,
      { ':cid': cluster.id, ':cam': camera || null, ':score': confidence }
    );
  } catch {}
  const fresh = get(`SELECT last_face_conf, last_voice_conf FROM identity_clusters WHERE id = :id`,
    { ':id': cluster.id });
  if (fresh.last_face_conf > 0 && fresh.last_voice_conf > 0) {
    run(`UPDATE identity_clusters SET last_match_at = datetime('now','localtime') WHERE id = :id`,
      { ':id': cluster.id });
  }
  return attemptAutoBind(cluster.id);
}

export function observeVoice({ label, confidence, sample_path }) {
  if (!label || typeof confidence !== 'number') return null;
  const cluster = upsertClusterByLabel(String(label));
  run(
    `UPDATE identity_clusters
        SET last_voice_conf = :conf,
            voice_sample_path = COALESCE(:sample, voice_sample_path),
            voice_profile = :label,
            observation_count = observation_count + 1,
            last_seen_at = datetime('now','localtime')
      WHERE id = :id`,
    { ':conf': confidence, ':sample': sample_path || null, ':id': cluster.id, ':label': label }
  );
  try {
    run(
      `INSERT INTO identity_observations (cluster_id, match_score, note)
       VALUES (:cid, :score, 'kind=voice')`,
      { ':cid': cluster.id, ':score': confidence }
    );
  } catch {}
  const fresh = get(`SELECT last_face_conf, last_voice_conf FROM identity_clusters WHERE id = :id`,
    { ':id': cluster.id });
  if (fresh.last_face_conf > 0 && fresh.last_voice_conf > 0) {
    run(`UPDATE identity_clusters SET last_match_at = datetime('now','localtime') WHERE id = :id`,
      { ':id': cluster.id });
  }
  return attemptAutoBind(cluster.id);
}
