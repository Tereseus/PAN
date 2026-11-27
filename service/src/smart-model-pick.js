// The smart model picker (task 1091, the owner Nov 27). The smart model is the person's own big
// model: whatever terminal they signed in with (Claude Code, Codex, Antigravity), or a big model on
// their own Ollama. ΠAN hands it the hard turns (a laid-out problem, router.js) and never pays for it.
// This file lists what THIS hub can use and keeps the person's pick in the setting `smart_model`.
// The list is built on the hub, so it only offers what the hub itself can start. Whether Claude is
// signed in is smart-model.js (Setup's check); this file is only the pick.

import { get, run, getOllamaUrl } from './db.js';
import { terminalsHere } from './cli-models.js';

export const DEFAULT_SMART_MODEL = 'anthropic:claude-sonnet-5-5';

/** The person's pick, read per turn; Claude when nothing is picked. */
export function smartModel() {
  try {
    const row = get("SELECT value FROM settings WHERE key = 'smart_model'");
    const v = row ? String(row.value).replace(/^"|"$/g, '').trim() : '';
    if (v) return v;
  } catch {}
  return DEFAULT_SMART_MODEL;
}

// Antigravity's own default model took 12 to 16 s on the trains problem; its flash model about 9 s
// (cli-models.js, Nov 27). Both are offered so the person can trade a little care for speed.
const TERMINAL_CHOICES = {
  codex: [{ suffix: '', note: 'Your ChatGPT sign in. About 4 to 14 seconds.' }],
  agy: [
    { suffix: '', note: 'Your Google sign in. About 12 to 16 seconds.' },
    { suffix: ':gemini-3.8-flash-medium', label: 'Antigravity, faster', note: 'Your Google sign in, its flash model. About 9 seconds.' },
  ],
};

// Only a big model counts: ΠAN's own small ones (the hub's primary model, the background and
// vision models) are already busy with their own work and are not smart models. Embedding, speech
// and vision models are not talkers. 12 GB is about a 20B model at 4 bits; on the hub (Nov 27) that
// leaves only Claude, which is right: it has no big local model.
const NOT_A_TALKER = /embed|whisper|minilm|bge|nomic|rerank|vl|-v|-v:|vision|llava|^pan-|^syrinx/i;
const MIN_LOCAL_BYTES = 12e9;

async function localModels() {
  try {
    const url = getOllamaUrl();
    if (!url) return [];
    const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return [];
    const { models = [] } = await r.json();
    return models
      .filter((m) => m?.name && !NOT_A_TALKER.test(m.name) && Number(m.size || 0) >= MIN_LOCAL_BYTES)
      .sort((a, b) => Number(b.size) - Number(a.size))
      .map((m) => ({
        id: `ollama:${m.name}`,
        name: m.name,
        kind: 'local',
        note: `On your own computer, ${(Number(m.size) / 1e9).toFixed(1)} GB. Slow without a strong graphics card.`,
      }));
  } catch { return []; }
}

/** Every smart model this hub can use, the person's own logins first, then local models. */
export async function smartModelChoices() {
  const out = [{ id: DEFAULT_SMART_MODEL, name: 'Claude', kind: 'terminal', note: 'Your Claude Code sign in. About 3 to 7 seconds.' }];
  for (const t of terminalsHere()) {
    for (const c of TERMINAL_CHOICES[t.id] || [{ suffix: '', note: 'Your own sign in.' }]) {
      out.push({ id: `cli:${t.id}${c.suffix}`, name: c.label || t.name.replace(/\s*\(.*\)$/, ''), kind: 'terminal', note: c.note });
    }
  }
  out.push(...await localModels());
  return out;
}

/** Saves the pick if this hub offers it. Returns the saved id, or null for a choice it does not have. */
export async function setSmartModel(id) {
  const want = String(id || '').trim();
  const choices = await smartModelChoices();
  if (!choices.some((c) => c.id === want)) return null;
  run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('smart_model', :v, datetime('now','localtime'))", { ':v': want });
  return want;
}
