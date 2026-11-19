// What models this computer should have, which of them are here, and pointing PAN at them.
// For PAN Setup (installer/windows/pan-setup.ps1 -Voice) and for a settings screen later.
// The rules are in model-set.js; this file only reads Ollama and the settings table.
//
// Mounted at /api/v1/setup/models after the login check. Owner only: it changes which
// model answers.

import os from 'os';
import { Router } from 'express';
import { all, run } from '../db.js';
import { loadModelSet, pickSet, wanted, settingsForModels } from '../model-set.js';

const router = Router();

function ownerOnly(req, res, next) {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'owner only' });
  next();
}

/** The model names Ollama on this computer lists. null when Ollama does not answer. */
async function ollamaModels(url) {
  try {
    const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const body = await r.json();
    return (body.models || []).map((m) => m.name);
  } catch {
    return null;
  }
}

function savedSettings(keys) {
  const out = {};
  for (const row of all('SELECT key, value FROM settings')) {
    if (keys.includes(row.key)) out[row.key] = row.value;
  }
  return out;
}

const KEYS = ['ollama_url', 'ai_model', 'ai_fallback_chain_voice', 'job_models', 'routing_local_model', 'guardian_model',
  'sensitivity_model', 'c2d_local_model', 'embedding_model', 'embedding_dim', 'photo_reader', 'voice_student_model',
  'voice_world_model', 'voice_world_questions', 'voice_hub_paths'];

router.get('/', ownerOnly, async (req, res) => {
  const modelSet = loadModelSet();
  const ramGB = Math.round(os.totalmem() / 2 ** 30 * 10) / 10;
  const set = pickSet(ramGB);
  const have = await ollamaModels(modelSet.ollama.url);
  const plan = settingsForModels(modelSet, have || [], savedSettings(KEYS));
  res.json({
    ok: true, ramGB, set, ollama: have !== null, have: have || [],
    wanted: wanted(modelSet, set).map((m) => ({ role: m.role, name: m.name, from: m.from, gb: m.gb, what: m.what, licence: m.licence })),
    missing: plan.missing, voice: plan.voice, toSet: plan.set,
  });
});

router.post('/apply', ownerOnly, async (req, res) => {
  const modelSet = loadModelSet();
  const have = await ollamaModels(modelSet.ollama.url);
  if (have === null) return res.status(503).json({ error: 'Ollama is not answering on this computer' });
  const plan = settingsForModels(modelSet, have, savedSettings(KEYS));
  for (const [key, value] of Object.entries(plan.set)) {
    run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (:key, :val, datetime('now','localtime'))", { ':key': key, ':val': value });
  }
  console.log(`[Models] pointed PAN at the models here: ${Object.keys(plan.set).join(', ') || 'nothing new'}`);
  // The voice reader and the photo reader are picked when PAN starts (steward.js), so a
  // caller that set a reader has to restart PAN's Craft (POST /api/carrier/swap) to get it.
  res.json({ ok: true, set: plan.set, missing: plan.missing, voice: plan.voice, restart: 'voice_student_model' in plan.set || 'photo_reader' in plan.set });
});

export default router;
