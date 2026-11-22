// PAN LLM Interface — unified entry point for all AI providers
// Supports Anthropic, Gemini, Ollama, and LM Studio.
// Routes based on Settings > AI & Usage.

import { insert, get, run, getOllamaUrl, getConfiguredOllamaUrl, getModelForPurpose, pickHealthyOllama, reportOllamaLatency, isOllamaDegraded } from './db.js';
import { pinAllowed } from './compute-store.js';
import { readerStream } from './voice-reader.js';
import { describeWithPhotoReader } from './photo-reader.js';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { anonymizeForAI } from './anonymize.js';
import { getSecret } from './secrets.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GROQ_URL      = 'https://api.groq.com/openai/v1/chat/completions';
const OPENAI_URL    = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// Pricing per model (cents per token)
const MODEL_PRICING = {
  // Anthropic
  'claude-haiku-4-5-20251001':   { input: 0.00008,  output: 0.0004  },
  'claude-sonnet-4-5-20250514':  { input: 0.0003,   output: 0.0015  },
  'claude-sonnet-4-6-20250514':  { input: 0.0003,   output: 0.0015  },
  'claude-opus-4-6-20250610':    { input: 0.0015,   output: 0.0075  },
  'sdk:claude-haiku-4-5-20251001':   { input: 0, output: 0 },
  'sdk:claude-sonnet-4-5-20250514':  { input: 0, output: 0 },
  'sdk:claude-sonnet-4-6-20250514':  { input: 0, output: 0 },
  'sdk:claude-opus-4-6-20250610':    { input: 0, output: 0 },
  
  // Gemini (via API)
  'gemini-1.5-flash':            { input: 0.0000075, output: 0.00003 },
  'gemini-1.5-pro':              { input: 0.00035,   output: 0.00105 },
  'gemini-2.0-flash':            { input: 0.00001,   output: 0.00004 },
  
  // Gemini (via CLI)
  'cli:gemini-1.5-pro':          { input: 0, output: 0 },
  
  // Groq (free tier available)
  'groq:gpt-oss-20b':            { input: 0.00013,  output: 0.00013  },
  'groq:llama-3.3-70b':          { input: 0.00059,  output: 0.00079  },
  'groq:llama-3.1-8b-instant':   { input: 0.00005,  output: 0.00008  },
  'groq:mixtral-8x7b':           { input: 0.00027,  output: 0.00027  },

  // OpenAI
  'openai:gpt-4o-mini':          { input: 0.00015,  output: 0.0006   },
  'openai:gpt-4o':               { input: 0.005,    output: 0.015    },

  // Generic custom endpoint (OpenAI-compatible)
  'custom:*':                    { input: 0,        output: 0        },
};

// --- Helper Functions ---

function getConfiguredModel() {
  try {
    const row = get("SELECT value FROM settings WHERE key = 'ai_model'");
    if (row) return row.value.replace(/^"|"$/g, '');
  } catch {}
  return DEFAULT_MODEL;
}

function getModelForCaller(caller) {
  try {
    const row = get("SELECT value FROM settings WHERE key = 'job_models'");
    if (row) {
      const jobModels = JSON.parse(row.value);
      if (jobModels[caller]) return jobModels[caller];
    }
  } catch {}
  return getConfiguredModel();
}

function getCustomModelConfig(modelId) {
  try {
    // model_hosts pins one model to one machine. custom_models can't do that: every boot rebuilds it.
    const pin = JSON.parse(get("SELECT value FROM settings WHERE key = 'model_hosts'")?.value || '{}')[modelId];
    // His switch per machine (compute.js): a machine he switched off gets none of ΠAN's models;
    // the model runs on the hub's own Ollama instead.
    if (pin && pinAllowed(pin)) return { id: modelId, provider: 'ollama', url: pin, pinned: true };
    const row = get("SELECT value FROM settings WHERE key = 'custom_models'");
    if (row) {
      const models = JSON.parse(row.value);
      return models.find(m => m.id === modelId);
    }
  } catch {}
  return null;
}

function getApiKey(provider) {
  try {
    const keyMap = {
      anthropic: 'anthropic_api_key',
      gemini:    'gemini_api_key',
      groq:      'groq_api_key',
      openai:    'openai_api_key',
    };
    const key = keyMap[provider];
    if (!key) return null;
    // getSecret checks PAN_<KEY> in the environment first and falls back to the
    // settings table, so a key can be moved out of the database by setting the
    // env var — no code change, no migration, nothing breaks in the meantime.
    return getSecret(key);
  } catch {}
  return null;
}

export function getAuthStatus() {
  const apiKey = getApiKey('anthropic');
  return {
    hasApiKey: !!apiKey,
    method: apiKey ? 'api' : 'sdk',
    description: apiKey ? 'Using your API key' : 'Using Claude Code subscription',
  };
}

// --- Provider Calls ---

async function callGemini(prompt, model, maxTokens, signal) {
  const apiKey = getApiKey('gemini');
  if (!apiKey) throw new Error('No Gemini API key found in Settings.');

  const genAI = new GoogleGenerativeAI(apiKey);
  const genModel = genAI.getGenerativeModel({ model: model.replace('gemini:', '') || 'gemini-1.5-flash' });

  // The signal goes to the SDK's fetch (see callGeminiStream), or a timeout or cancel cannot cut it.
  const result = await genModel.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  }, signal ? { signal } : {});

  const response = await result.response;
  return {
    text: response.text(),
    usage: { 
      input_tokens: response.usageMetadata?.promptTokenCount || 0, 
      output_tokens: response.usageMetadata?.candidatesTokenCount || 0 
    }
  };
}

// Streaming Gemini. The whole voice pipeline was already built to stream -
// the hub yields chunks, the phone speaks each sentence the moment it lands -
// but askAIStream only had a real implementation for Cerebras, and Cerebras
// has been returning 402 on every model since August. So every reply fell
// into the 'non-streaming providers' else-branch, arrived as ONE chunk at the
// end, and the phone could not start talking until the last word was written.
// That single else is why the whole thing felt like a walkie-talkie: measured
// first=43463ms total=43470ms, seven milliseconds apart.
async function* callGeminiStream(prompt, model, maxTokens, signal, usageOut = null) {
  const apiKey = getApiKey('gemini');
  if (!apiKey) throw new Error('No Gemini API key found in Settings.');
  const genAI = new GoogleGenerativeAI(apiKey);
  const genModel = genAI.getGenerativeModel({ model: model.replace('gemini:', '') || 'gemini-1.5-flash' });
  // The signal has to reach the SDK's fetch. Checked only between chunks, a stream that never sent
  // one could not be cut by the timeout or by a cancel: an overloaded free-tier model held a voice
  // turn 81 s with nothing, then "Sorry, I ran into a problem" (2026-11-03).
  const result = await genModel.generateContentStream({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  }, signal ? { signal } : {});
  // Rejects with the stream, and nothing awaits it if the stream throws first.
  result.response.catch(() => {});
  for await (const chunk of result.stream) {
    if (signal && signal.aborted) break;
    let t = '';
    try { t = chunk.text() || ''; } catch { t = ''; }
    if (t) yield t;
  }
  if (usageOut) {
    try {
      const resp = await result.response;
      usageOut.input_tokens  = resp.usageMetadata?.promptTokenCount || 0;
      usageOut.output_tokens = resp.usageMetadata?.candidatesTokenCount || 0;
    } catch {}
  }
}

// Streaming Ollama. /api/chat with stream:true answers newline-delimited JSON,
// one object per token-ish chunk. Same health reporting as the non-streaming
// path so a degraded GPU box still trips the failover.
// GPU PLACEMENT GUARD
//
// ollama decides GPU offload ONCE, when a model loads, from the VRAM free at
// that instant - and never revisits it. Mint is also the gaming box. A game
// takes the card, the model reloads into a ~1GiB window, gets ZERO layers
// offloaded, and then serves every request from CPU for the rest of that load,
// long after the game is closed and the card is idle again. Nothing errors. It
// just goes slow and stays slow.
//
// Measured on Mint 2026-09-16, same model, same 3,223-token prompt:
//   cold prefill  10,646ms (295 tok/s)  ->  1,114ms (2,894 tok/s)
//   decode            24 tok/s          ->  78-81 tok/s
// End to end that was a voice p90 of 11.8s against 1.6s.
//
// keep_alive: -1 prevents the reload that causes it. This is the second line of
// defence for when the pin is not enough: ollama restarted, the model was
// stopped by hand mid-game, or something else held the card at load time.
//
// It follows the CONFIGURED ollama url, so it never fights GAME MODE. When that
// button points the hub at the mini PC, this checks the mini PC, and a model
// deliberately stopped on Mint is left stopped.
const VRAM_CHECK_EVERY_MS = 2 * 60 * 1000;
const VRAM_REPAIR_COOLDOWN_MS = 10 * 60 * 1000;
// The host PAN was configured to use on the previous call. When that changes
// - which is exactly what the GAME MODE button does - the model left pinned on
// the old host must be released, or it sits there forever.
//
// keep_alive: -1 made this mandatory. Before it, a model stranded by a config
// switch expired on its own after OLLAMA_KEEP_ALIVE (5m) and the VRAM came
// back. Pinned, it never expires: one leaked call during game mode",
// permanently costs 1.7GB of the card he wanted for a game. Measured live.
let _lastConfiguredUrl = null;
let _lastVramCheck = 0;
let _lastVramRepair = 0;
// Hosts seen with a model in VRAM. On a box with no GPU everything sits at 0, and that is not a fault.
const _gpuHosts = new Set();

// Unload a model we pinned on a host we are no longer pointed at.
async function releasePinnedModel(url, model) {
  try {
    await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0, options: { num_predict: 1 } }),
      signal: AbortSignal.timeout(15000),
    });
    console.log(`[ollama] released ${model} on ${url} — PAN is not using that host any more`);
  } catch (e) {
    console.warn(`[ollama] could not release ${model} on ${url}: ${e.message}`);
  }
}

async function guardModelOnGpu(ollamaUrl, model, force = false) {
  const now = Date.now();
  // `force` is set when the turn that scheduled this was itself slow. The
  // throttle exists so a busy conversation does not poll /api/ps every turn,
  // but a slow turn IS the symptom - throttling the check exactly when the
  // evidence arrives is backwards, and it is why this never fired in testing.
  if (!force && now - _lastVramCheck < VRAM_CHECK_EVERY_MS) return;
  _lastVramCheck = now;
  // Ollama lists 'name:latest' even when PAN asked for plain 'name'.
  const tagged = model.includes(':') ? model : `${model}:latest`;
  const ps = async () => {
    const r = await fetch(`${ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = await r.json();
    const loaded = j.models || [];
    if (loaded.some((x) => x.size_vram > 0)) _gpuHosts.add(ollamaUrl);
    return loaded.find((x) => x.name === tagged || x.model === tagged) || null;
  };
  try {
    const m = await ps();
    // Not loaded is fine - the next call loads it, and that load will be
    // pinned. Only a LOADED model sitting at zero VRAM is the broken state.
    if (!m) { console.log(`[ollama] guard: ${model} not loaded on ${ollamaUrl} — nothing to do`); return; }
    if (m.size_vram > 0) return;   // already on the GPU, the normal case
    // Without a GPU a repair only throws the model out, and the next turn pays for the reload.
    if (!_gpuHosts.has(ollamaUrl)) return;

    if (now - _lastVramRepair < VRAM_REPAIR_COOLDOWN_MS) {
      console.warn(`[ollama] ${model} is on CPU (size_vram=0) — repair on cooldown, not retrying yet`);
      return;
    }
    _lastVramRepair = now;
    console.warn(`[ollama] ${model} loaded with NO GPU offload — unloading and reloading to force placement`);

    const post = (body, ms) => fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    await post({ model, prompt: 'x', keep_alive: 0, options: { num_predict: 1 } }, 30000);
    await new Promise((r) => setTimeout(r, 1500));   // let the card actually free
    await post({ model, prompt: 'x', keep_alive: -1, options: { num_predict: 1 } }, 120000);

    const after = await ps();
    if (after && after.size_vram > 0) {
      console.log(`[ollama] ${model} back on GPU (${(after.size_vram / 1e9).toFixed(1)}GB VRAM)`);
    } else {
      // Reloading did not help, so something else is holding the card - most
      // likely a game running right now. Say so rather than looping: the
      // cooldown stops this becoming a thrash, and GAME MODE is the answer.
      console.warn(`[ollama] ${model} STILL on CPU after reload — something else is holding VRAM (a game?). Use the GAME MODE button.`);
    }
  } catch (e) {
    console.warn(`[ollama] GPU placement guard failed: ${e.message}`);
  }
}

// phi4-mini wraps a JSON answer in a ```json fence (Nov 16). Callers parse the text as JSON, and the
// voice gate reads the first field of a stream, so the fence comes off here, for every Ollama model.
function stripFence(text) {
  const m = String(text || '').match(/^\s*```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/);
  return m ? m[1] : text;
}

async function* callOllamaStream(prompt, ollamaModel, maxTokens, signal, usageOut = null, temperature = null) {
  const perModelOllama = getCustomModelConfig(ollamaModel);
  // The CONFIGURED host, before any health rerouting. The guard has to repair
  // THIS one. getOllamaUrl() already ends in pickHealthyOllama(), so asking it
  // while Mint is degraded returns the mini PC - the guard then inspected the
  // healthy box, found nothing wrong, and left Mint on CPU. Measured: the guard
  // silently no-opped through two full test runs because of exactly this.
  const configuredOllamaUrl = ((perModelOllama && perModelOllama.url) || getConfiguredOllamaUrl() || 'http://localhost:11434').replace(/\/$/, '');
  const ollamaUrl = pickHealthyOllama(configuredOllamaUrl);
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        // think:false stays load-bearing here too - reasoning goes to
        // message.thinking and content comes back empty.
        think: false,
        // keep_alive: -1 pins the chat model, as embeddings.js pins the
        // embedding model and analyzeImage pins the vision model. Chat was the
        // only unpinned one and the only latency-critical one. It is not about
        // load time - see guardModelOnGpu below for what it actually prevents.
        keep_alive: -1,
        // temperature: only when the caller sets one (the hub's spoken answers, router.js HUB_TEMPERATURE).
        options: { num_predict: maxTokens, ...(typeof temperature === 'number' ? { temperature } : {}) },
      }),
      signal,
    });
  } catch (e) {
    reportOllamaLatency(ollamaUrl, Date.now() - t0, false);
    throw e;
  }
  if (!resp.ok) {
    reportOllamaLatency(ollamaUrl, Date.now() - t0, false);
    throw new Error(`Ollama ${resp.status}`);
  }

  // Scheduled here, NOT in the finally below.
  //
  // routeStream breaks out of its for-await the moment the JSON object closes,
  // and that abrupt close does not reach this generator through
  // askAIStreamWithFallback - so the finally never ran and the guard never
  // fired. Verified: a debug log at the top of guardModelOnGpu printed nothing
  // across three full test runs while turns were plainly being served here.
  //
  // The delay keeps the repair away from the turn that scheduled it, since the
  // repair unloads the model and would otherwise cut its own stream off. The
  // throttle inside guardModelOnGpu stops these piling up.
  // The configured host changed since the last call (GAME MODE, or any
  // settings edit). Hand the old host its VRAM back immediately - not on a
  // timer, because the whole point is that he is waiting to start a game.
  // A pinned model runs beside the others, so its host is not a change of host.
  if (!perModelOllama?.pinned) {
    if (_lastConfiguredUrl && _lastConfiguredUrl !== configuredOllamaUrl) {
      const stranded = _lastConfiguredUrl;
      releasePinnedModel(stranded, ollamaModel).catch(() => {});
    }
    _lastConfiguredUrl = configuredOllamaUrl;
  }

  setTimeout(() => {
    // A turn that took longer than the slow threshold is the strongest signal
    // we get that the model fell off the GPU, so it skips the throttle.
    const wasSlow = (Date.now() - t0) > 8000;
    guardModelOnGpu(configuredOllamaUrl, ollamaModel, wasSlow).catch(() => {});
  }, 15000).unref?.();
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // A reply that opens with a ``` line (see stripFence): that line is dropped, and the last few
  // characters are held back so the closing ``` can be dropped too.
  let head = '', headDone = false, fenced = false, held = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        let piece = obj.message?.content || '';
        if (piece && !headDone) {
          head += piece;
          const t = head.trimStart();
          if (t.length < 3 && '```'.startsWith(t)) piece = '';            // may still become a fence
          else if (t.startsWith('```')) {
            const eol = t.indexOf('\n');
            if (eol < 0 && t.length < 24) piece = '';                     // the fence line is not over yet
            else { piece = eol < 0 ? t : t.slice(eol + 1); headDone = true; fenced = eol >= 0; }
          } else { piece = head; headDone = true; }
        }
        if (piece && fenced) {
          const out = held + piece;
          held = out.slice(-6);
          piece = out.slice(0, -6);
        }
        if (piece) yield piece;
        if (obj.done && usageOut) {
          usageOut.input_tokens  = obj.prompt_eval_count || 0;
          usageOut.output_tokens = obj.eval_count || 0;
        }
      }
    }
    if (!headDone && head) yield head;
    const last = held.replace(/\s*```\s*$/, '');
    if (last) yield last;
  } finally {
    reportOllamaLatency(ollamaUrl, Date.now() - t0, true);
  }
}

// "reader:<model>": the voice reader (voice-reader.js), else the same model on Ollama, which is
// slower but always there.
async function* callReaderStream(prompt, ollamaModel, maxTokens, signal, usageOut, readerOpts) {
  let yielded = false;
  try {
    for await (const piece of readerStream(prompt, maxTokens, signal, usageOut, readerOpts)) {
      yielded = true;
      yield piece;
    }
    return;
  } catch (e) {
    if (yielded || signal?.aborted) throw e;
    // Not Ollama: the same model there has read nothing and took 13 to 19 s a turn in the car
    // (Nov 14). The router sends the turn to the cloud model instead (routeStream, full prompt).
    console.warn(`[voice-reader] not answering (${e.cause?.code || e.message}), the cloud model takes this turn`);
    throw e;
  }
}

/**
 * Who answers a student turn. A voice box that stopped answering is routed to the hub's Ollama by
 * pickHealthyOllama, so the voice reader has to go first by name or it is never reached.
 */
export function studentChain(model, backup) {
  const pin = model.startsWith('ollama:') ? getCustomModelConfig(model.slice('ollama:'.length)) : null;
  if (pin?.pinned && isOllamaDegraded(pin.url) && backup.startsWith('reader:')) return [backup];
  return [model, backup].filter(Boolean);
}

// Classify a model ID into { tier, sizeB } from its name.
//
// Used by the resolver's substitution path: when an exact and prefix-family
// match both miss, we pick the closest-classified live model instead of
// falling all the way through to the next provider. Heuristic only —
// providers don't publish structured metadata via /v1/models — but the
// naming conventions are stable enough (size suffix in "B", role keywords
// in the model id) that this picks sensible substitutes in practice.
function _classifyModel(modelId) {
  const id = String(modelId || '').toLowerCase();

  // Vision-language models — output is different from text chat; we don't
  // substitute across vision/non-vision because the caller's prompt format
  // (image payload) is incompatible with chat-only models.
  if (/moondream|llava|minicpm-v|qwen[-_.]?vl|gpt-4o[-_.]?vision/.test(id)) {
    return { tier: 'vision', sizeB: null };
  }

  // Embedding models — different output vector dimensionality between
  // families means we cannot silently substitute one for another (the
  // existing event_embeddings rows are tied to the original model's
  // dimension count). Return tier='embedding' so the resolver explicitly
  // refuses substitution.
  if (/embed|embedding/.test(id)) {
    return { tier: 'embedding', sizeB: null };
  }

  // Pull a parameter count out of the name: "8b", "20b", "32b", "70b",
  // "120b", "235b", "405b", etc. Pick the FIRST match — for compound
  // names like "qwen-3-235b-a22b" the 235b is the headline total, a22b
  // is the active expert count we don't care about for tier sorting.
  const sizeMatch = id.match(/(\d{1,3})b\b/);
  const sizeB = sizeMatch ? Number(sizeMatch[1]) : null;

  // Reasoning / thinking tier — either explicit role keyword or >= 100B
  // params (which is where the dedicated reasoning class lives across
  // providers right now: gpt-oss-120b, qwen-3-235b, deepseek-r1-…).
  if (/thinking|reasoning|\bo[13]-|deepseek[-_.]?r1|\br1\b/.test(id) || (sizeB && sizeB >= 100)) {
    return { tier: 'reasoning', sizeB };
  }

  // Default: chat tier, sized by the param count if we found one.
  return { tier: 'chat', sizeB };
}

// Pick the most-similar live model when no exact / prefix match was found.
// Order:
//   1. Same tier as the requested model, closest by parameter count.
//   2. If the request was 'reasoning' but nothing in the live list is
//      classified that way, fall back to the LARGEST 'chat' model (still
//      better than a 404).
//   3. Refuse substitution for 'embedding' and 'vision' tiers (see
//      _classifyModel comments above — substitution would silently break
//      callers that depend on shape compatibility).
function _findSubstitute(provider, modelId, knownSet) {
  const target = _classifyModel(modelId);
  if (target.tier === 'embedding' || target.tier === 'vision') return null;

  const classified = [...knownSet].map(id => ({ id, ...(_classifyModel(id)) }));
  const sameTier = classified.filter(c => c.tier === target.tier);

  if (sameTier.length > 0) {
    if (target.sizeB != null) {
      sameTier.sort((a, b) => Math.abs((a.sizeB || 0) - target.sizeB) - Math.abs((b.sizeB || 0) - target.sizeB));
    } else {
      sameTier.sort((a, b) => (b.sizeB || 0) - (a.sizeB || 0));
    }
    return sameTier[0].id;
  }

  // Reasoning requested but provider has no reasoning class right now —
  // grab the largest chat model as the next-best.
  if (target.tier === 'reasoning') {
    const chats = classified.filter(c => c.tier === 'chat');
    if (chats.length > 0) {
      chats.sort((a, b) => (b.sizeB || 0) - (a.sizeB || 0));
      return chats[0].id;
    }
  }

  return null;
}

// Resolve & validate a model ID against Scout's live source of truth.
//
// Scout's scanProviderModels() runs after Craft boot + every 6h, asks each
// cloud provider for its model list, and writes it to provider_models. llm.js
// consults that table before a Groq call so a retired model does not cost an
// HTTP round-trip and a 404 log line on every cycle.
//
// Resolution order:
//   1. Exact match in live list → use as-is.
//   2. Prefix family match (name-…-2507 → name-…-2509) →
//      use the longest matching candidate (most-specific / likely newest).
//   3. Smart substitution by tier (see _findSubstitute): pick the closest
//      live model in the same class. A list can still hold models the account
//      may not use: this step once picked an archived one and every call 404'd.
//   4. No match found → throw, fallback chain takes over.
//
// Permissive on cold boots: if Scout hasn't populated the table yet
// (returns null), we trust the caller and let the real API decide.
let _scoutModForValidation = null;
async function _resolveModelLive(provider, modelId) {
  if (!_scoutModForValidation) {
    try { _scoutModForValidation = await import('./scout.js'); }
    catch { _scoutModForValidation = { getKnownProviderModels: () => null }; }
  }
  try {
    const known = _scoutModForValidation.getKnownProviderModels(provider);
    if (!known) return { live: modelId, reason: null }; // cold boot, trust caller
    // Exact match: the model is live → use as-is.
    if (known.has(modelId)) {
      return { live: modelId, reason: null };
    }

    // (2) Prefix family match — handles "name-…-2507" → "name-…-2509"
    const baseFamily = modelId.replace(/-\d{4}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
    const candidates = [...known].filter(id => id.startsWith(baseFamily));
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.length - a.length); // most-specific first
      console.warn(`[LLM] ${provider} model "${modelId}" retired; routing to "${candidates[0]}" (prefix family match)`);
      return { live: candidates[0], reason: null };
    }

    // (3) Smart tier-based substitution
    const sub = _findSubstitute(provider, modelId, known);
    if (sub) {
      console.warn(`[LLM] ${provider} model "${modelId}" retired; substituting "${sub}" (same tier classification)`);
      return { live: sub, reason: null };
    }

    return { live: null, reason: `${provider} model "${modelId}" not in live list (no tier substitute available)` };
  } catch { return { live: modelId, reason: null }; }
}

// Public streaming API — yields text chunks. Falls back to single yield for non-streaming models.
// #986 batch 2: accept an external `signal` (AbortSignal) so callers (router /chat/stream,
// /cancel endpoint) can abort the in-flight fetch mid-stream. The internal
// timeout controller still fires, and either abort source short-circuits the fetch.
export async function* askAIStream(rawPrompt, { model, timeout = 20000, maxTokens = 300, caller = 'unknown', _skipAnonymize = false, source, device_id, signal: externalSignal = null, readerOpts, temperature = null } = {}) {
  const prompt = _skipAnonymize ? rawPrompt : anonymizeForAI(rawPrompt);
  if (!model) model = getModelForCaller(caller);
  const startedAt = Date.now(); // #471: t0 for ai_usage.latency_ms

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  // Wire external abort: if the caller's signal fires (user said "cancel", new
  // utterance, route swap), forward to the internal controller so the underlying
  // fetch unwinds and the generator's finally{} flushes logUsage with whatever
  // tokens the model had sent before the cut.
  let externalAbortHandler = null;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else {
      externalAbortHandler = () => controller.abort();
      externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }
  // #465: declare usage holder outside try{} so finally{} can flush logUsage even
  // when the consumer break-s out of `for await` early (router does this once it
  // has parsed enough JSON). Otherwise the generator's return() short-circuits
  // logUsage and the row never lands in ai_usage.
  let streamUsage = null;
  try {
    if (model.startsWith('gemini:')) {
      streamUsage = { input_tokens: 0, output_tokens: 0 };
      for await (const chunk of callGeminiStream(prompt, model, maxTokens, controller.signal, streamUsage)) {
        yield chunk;
      }
    } else if (model.startsWith('ollama:')) {
      streamUsage = { input_tokens: 0, output_tokens: 0 };
      for await (const chunk of callOllamaStream(prompt, model.replace('ollama:', ''), maxTokens, controller.signal, streamUsage, temperature)) {
        yield chunk;
      }
    } else if (model.startsWith('reader:')) {
      streamUsage = { input_tokens: 0, output_tokens: 0 };
      for await (const chunk of callReaderStream(prompt, model.replace('reader:', ''), maxTokens, controller.signal, streamUsage, readerOpts)) {
        yield chunk;
      }
    } else {
      // Genuinely non-streaming providers: yield full result at once.
      const text = await askAI(rawPrompt, { model, timeout, maxTokens, caller, _skipAnonymize, source, device_id });
      if (text) yield text;
    }
  } finally {
    clearTimeout(timer);
    if (externalSignal && externalAbortHandler) {
      try { externalSignal.removeEventListener('abort', externalAbortHandler); } catch {}
    }
    if (streamUsage) {
      // Always log — even on early break (router) or abort (timeout). usage tokens
      // may be 0 if the final frame had not arrived yet, which is fine —
      // the row still gets source / device_id tagged for routing telemetry.
      logUsage(caller, model, streamUsage, prompt.slice(0, 100), { source, device_id, started_at: startedAt });
    }
  }
}

async function callOpenAIEndpoint(messages, modelId, url, apiKey, maxTokens, signal) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const oaiMessages = messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
  }));
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: modelId, messages: oaiMessages, max_tokens: maxTokens, stream: false }),
    signal,
  });
  if (!response.ok) throw new Error(`${url} ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return {
    text: data.choices?.[0]?.message?.content || '',
    usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 },
  };
}

async function callOpenAICompat(prompt, messages, config, maxTokens, signal) {
  const isOllama = config.provider === 'ollama';
  const url = (config.url || (isOllama ? getOllamaUrl() : 'http://localhost:1234')).replace(/\/$/, '') + (isOllama ? '/api/chat' : '/v1/chat/completions');
  
  const headers = { 'Content-Type': 'application/json' };
  if (config.api_key) headers['Authorization'] = `Bearer ${config.api_key}`;

  const oaiMessages = messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.filter(c => c.type === 'text').map(c => c.text).join('\n') }));

  const response = await fetch(url, {
    method: 'POST',
    headers,
    // think:false for Ollama: gemma4 thinks by default, which cost 1.52s vs 0.06s
    // on the same question. Harmless for non-thinking models and for LM Studio.
    // keep_alive only means anything to Ollama, hence the spread.
    body: JSON.stringify({ model: config.id, messages: oaiMessages, max_tokens: maxTokens, stream: false, ...(isOllama ? { think: false, keep_alive: -1 } : {}) }),
    signal,
  });

  if (!response.ok) throw new Error(`${config.provider} ${response.status}: ${await response.text()}`);
  const data = await response.json();
  
  if (isOllama) {
    return { text: stripFence(data.message?.content || ''), usage: { input_tokens: data.prompt_eval_count || 0, output_tokens: data.eval_count || 0 } };
  }
  return { text: data.choices?.[0]?.message?.content || '', usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 } };
}

// --- Main Interface ---

export async function askAI(rawPrompt, { model, timeout = 15000, maxTokens = 300, caller = 'unknown', _skipAnonymize = false, source, device_id } = {}) {
  const prompt = _skipAnonymize ? rawPrompt : anonymizeForAI(rawPrompt);
  if (!model) model = getModelForCaller(caller);
  const startedAt = Date.now(); // #471: t0 for ai_usage.latency_ms

  // Determine Provider
  let provider = 'sdk';
  if      (model.startsWith('gemini:'))    provider = 'gemini';
  else if (model.startsWith('groq:'))     provider = 'groq';
  else if (model.startsWith('openai:'))   provider = 'openai';
  else if (model.startsWith('ollama:'))   provider = 'ollama';
  else if (model.startsWith('anthropic:')) {
    // Strip prefix so the SDK/CLI gets a clean model name. This is the
    // path model_selections uses when reasoning_cloud is set to a Claude
    // model — keeps the table consistent (provider:model) without
    // requiring a separate Anthropic API integration here. The 'sdk'
    // provider routes via claude -p which uses the user's subscription.
    model = model.replace(/^anthropic:/, '');
    try {
      const row = get("SELECT value FROM settings WHERE key = 'ai_backend'");
      if (row) provider = row.value.replace(/^"|"$/g, '');
    } catch {}
  }
  else if (model.startsWith('claude-')) {
    try {
      const row = get("SELECT value FROM settings WHERE key = 'ai_backend'");
      if (row) provider = row.value.replace(/^"|"$/g, '');
    } catch {}
  } else provider = 'custom';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    let result;
    if (provider === 'gemini') {
      result = await callGemini(prompt, model, maxTokens, controller.signal);
    } else if (provider === 'groq') {
      const key = getApiKey('groq');
      if (!key) throw new Error('No Groq API key in Settings. Add groq_api_key.');
      const groqRequested = model.replace('groq:', '');
      // Scout-backed resolver: auto-route to the current model name when ours
      // has retired, fast-fail when there's no prefix family match.
      const { live: groqModelId, reason } = await _resolveModelLive('groq', groqRequested);
      if (reason) throw new Error(`Groq 404 (pre-check): ${reason}`);
      result = await callOpenAIEndpoint(
        [{ role: 'user', content: prompt }],
        groqModelId, GROQ_URL, key, maxTokens, controller.signal
      );
    } else if (provider === 'openai') {
      const key = getApiKey('openai');
      if (!key) throw new Error('No OpenAI API key in Settings. Add openai_api_key.');
      result = await callOpenAIEndpoint(
        [{ role: 'user', content: prompt }],
        model.replace('openai:', ''), OPENAI_URL, key, maxTokens, controller.signal
      );
    } else if (provider === 'custom') {
      const config = getCustomModelConfig(model);
      if (!config) throw new Error(`Unknown model: ${model}`);
      result = await callOpenAICompat(prompt, [{ role: 'user', content: prompt }], config, maxTokens, controller.signal);
    } else if (provider === 'ollama') {
      // `ollama:` prefix path. llm-fallback's default chain emits these
      // (e.g. "ollama:qwen3:4b") via _formatModelRef. Previously this fell
      // through to the 'custom' branch which looked up custom_models by id
      // — but custom_models stores the bare model id ("qwen3:4b"), not
      // "ollama:qwen3:4b", so the lookup missed and threw "Unknown model"
      // in 1ms, killing the local fallback. Route directly to Ollama here.
      const ollamaModel = model.replace(/^ollama:/, '');
      // A per-model url in custom_models wins over the global endpoint, so one
      // model (the conversational one) can run on the GPU box while embeddings,
      // vision, guardian and sensitivity stay on the always-on hub. custom_models
      // keys on the BARE id, which is what ollamaModel already is.
      const perModelOllama = getCustomModelConfig(ollamaModel);
      // Through the health check: a per-model url from custom_models bypasses
      // getOllamaUrl entirely, so without this the failover would not apply to
      // exactly the model that runs on the GPU box - the one that goes slow
      // when a game has the card.
      const ollamaUrl   = pickHealthyOllama(((perModelOllama && perModelOllama.url) || getOllamaUrl() || 'http://localhost:11434').replace(/\/$/, ''));
      const _ollamaT0 = Date.now();
      let resp;
      try {
        resp = await fetch(`${ollamaUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: ollamaModel,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            // gemma4 and qwen3 think by default; the flag is what keeps local fast.
            think: false,
            // Pinned for the same reason as the streaming path above: it keeps
            // the model from reloading onto the CPU during a low-VRAM window.
            keep_alive: -1,
            options: { num_predict: maxTokens },
          }),
          signal: controller.signal,
        });
      } catch (e) {
        // Refused or aborted is the loudest 'this host is not usable right now'
        // signal there is. Count it here too, otherwise the failover would wait
        // on the background classifier to notice while every voice turn in the
        // meantime kept paying the full timeout first.
        reportOllamaLatency(ollamaUrl, Date.now() - _ollamaT0, false);
        throw e;
      }
      if (!resp.ok) {
        reportOllamaLatency(ollamaUrl, Date.now() - _ollamaT0, false);
        throw new Error(`Ollama ${resp.status}: ${await resp.text().catch(() => '')}`);
      }
      const data = await resp.json();
      // Text only. Vision never reports here - moondream is legitimately slow
      // and would mark the host degraded forever.
      reportOllamaLatency(ollamaUrl, Date.now() - _ollamaT0, true);
      result = {
        text: stripFence(data.message?.content || ''),
        usage: { input_tokens: data.prompt_eval_count || 0, output_tokens: data.eval_count || 0 },
      };
    } else if (provider === 'api') {
      const apiKey = getApiKey('anthropic');
      const resp = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
        signal: controller.signal
      });
      const data = await resp.json();
      result = { text: data.content?.[0]?.text || '', usage: data.usage };
    } else {
      // Claude Agent SDK path. The SDK spawns a `claude -p` subprocess and
      // streams events back; passing `abortController` is supposed to kill
      // the subprocess when the controller fires. Empirically it doesn't
      // always — the for-await loop has been seen hanging 150-200s past
      // the 15s timeout (see ai_fallback_attempt logs with ms:152433,
      // 195410, 204709). The router's outer code then has nothing to fall
      // back to because the "timeout" never actually fired.
      //
      // Hard-cap via Promise.race against the same timer: if the SDK
      // doesn't yield a result by `timeout`ms, abort the controller AND
      // throw — the fallback chain in llm-fallback.js sees a clean
      // timeout error and moves to the next backend.
      result = await new Promise((resolve, reject) => {
        let settled = false;
        const hardCap = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { controller.abort(); } catch {}
          const e = new Error(`SDK timeout > ${timeout}ms`);
          e.name = 'AbortError';
          reject(e);
        }, timeout);
        (async () => {
          try {
            const q = sdkQuery({ prompt, options: { model, maxTurns: 1, persistSession: false, permissionMode: 'plan', abortController: controller, tools: [], env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `pan-server/${caller}` } } });
            let text = '';
            let usage = null;
            for await (const event of q) {
              if (settled) return;
              if (event.type === 'result' && event.subtype === 'success') { text = event.result || ''; usage = event.usage; }
              else if (event.type === 'assistant' && event.message?.content) text = event.message.content.find(b => b.type === 'text')?.text || text;
            }
            if (settled) return;
            settled = true;
            clearTimeout(hardCap);
            resolve({ text, usage });
          } catch (err) {
            if (settled) return;
            settled = true;
            clearTimeout(hardCap);
            reject(err);
          }
        })();
      });
      model = `sdk:${model}`;
    }

    logUsage(caller, model, result.usage, prompt, { source, device_id, started_at: startedAt });
    return result.text.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  } finally {
    clearTimeout(timer);
  }
}

export const claude = askAI;

// --- Vision (screenshot understanding via local Qwen2.5-VL or cloud API fallback) ---

// Hardware notes the user enforced:
//   - mini PC is CPU-only (AMD integrated GPU; force num_gpu=0 in body below)
//   - qwen2.5vl:3b crashes on CPU vision
//   - llava-phi3 (2.9GB) is proven reliable on CPU
//   - moondream (1.7GB) is the default — purpose-built, ~10-15s/query on CPU
//   - minicpm-v (5.4GB) is too slow on CPU (3min+/query) — never auto-select
//
// Read the canonical name from the model_selections table (purpose='vision')
// so the user can swap to llava-phi3 / qwen2.5vl from the dashboard without
// editing source. Falls back to 'moondream' if the registry isn't initialised.
function _getVisionModel() {
  const sel = getModelForPurpose('vision');
  return sel?.model || 'moondream';
}

// De-dupe latch for vision-failure alerts. A broken vision stack (mini PC
// Ollama down) would otherwise raise an alert on every user photo. Suppress
// duplicates within a 5-minute window; a successful mini-PC analysis clears it
// so the next genuine failure alerts immediately. Modelled on scout.js's
// _lastReasoningCloudAlertModel latch.
let _lastVisionAlertAt = 0;
const VISION_ALERT_WINDOW_MS = 5 * 60 * 1000;

async function _raiseVisionAlert(model, reason) {
  const now = Date.now();
  if (now - _lastVisionAlertAt < VISION_ALERT_WINDOW_MS) return; // de-dupe
  _lastVisionAlertAt = now;
  try {
    // Lazy import: routes/dashboard.js pulls in llm.js indirectly, so a
    // top-level import would risk a circular dependency. Only runs on a
    // genuine user-photo failure, long after boot.
    const { createAlert } = await import('./routes/dashboard.js');
    createAlert({
      alert_type: 'vision_failed',
      severity: 'warning',
      title: 'Vision analysis failed — no answer for your photo',
      detail: `A user photo got no result. ${reason} Model "${model}" was unreachable/too slow on the mini PC Ollama, and no cloud vision fallback (Claude/Gemini API key) was available.`,
    });
  } catch (e) {
    console.warn('[PAN Vision] Could not raise vision_failed alert:', e.message);
  }
}

// `model` picks the Ollama vision model for this one call (default: model_selections.vision).
export async function analyzeImage(prompt, imageBase64, { caller = 'vision', timeout = 70000, referenceImages = [], model = null, maxTokens = 300 } = {}) {
  // referenceImages: optional array of base64 strings prepended before the main image.
  // Ollama /api/generate supports images[] — first image(s) are reference, last is live frame.
  const allImages = [...referenceImages, imageBase64];
  const startedAt = Date.now(); // #471: t0 for ai_usage.latency_ms — vision is the slowest caller

  // Hard wall-clock budget across the WHOLE fallback chain (Ollama →
  // Claude → Gemini). Previously each provider got its own `timeout`
  // (default 70s), so a fully-broken vision stack burned 210s+ per call —
  // we observed `WebcamWatcher 222s` in the field, which kept Craft pinned
  // and made the dashboard unresponsive. Cap the total run at 1/3 of the
  // per-provider budget. Successful Ollama returns in ~10-15s on CPU so
  // this still leaves headroom for the primary path.
  // User-initiated photos (caller='vision') run LOCAL-ONLY on a CPU-only mini PC.
  // Give them the FULL budget instead of the /3 chain-split: there's effectively one
  // local provider, and the user is waiting on a deliberate, private analysis.
  // Background watchers keep the short /3 cap so they never pin the CPU for minutes.
  //
  // Floor raised 45s → 120s on 2026-08-07. The old floor was written when the
  // seeded model was moondream and the estimate above it said "~10-15s on CPU".
  // Measured on the Mini-PC (Ryzen 7 5800H, CPU-only), one 1.9MB photo:
  //   moondream  35s · gemma4:e4b  60s · minicpm-v 140s · qwen2.5vl 297s
  // routes/api.js:480 calls this with no explicit timeout, so it took the 70000
  // default → a 70s budget. That is BELOW the real latency of every vision model
  // seeded since moondream, so user-initiated /api/v1/vision was aborting and
  // returning an empty description rather than failing loudly. 120s matches the
  // budget screen-watcher already grants itself (360000/3).
  const budgetMs = caller === 'vision'
    ? Math.max(120000, timeout)
    : Math.max(15000, Math.round(timeout / 3));
  const overallDeadline = startedAt + budgetMs;
  const remaining = () => Math.max(500, overallDeadline - Date.now());

  // Captured so the vision_failed alert (raised at the exhausted/throw exits
  // below) can name why the mini PC Ollama primary failed.
  let ollamaFailReason = null;
  const visionModel = model || _getVisionModel();

  // The photo reader (photo-reader.js): this same model on the hub's graphics chip, when the
  // steward runs one for it (5.1 s a new photo against 7.5 to 8.3 s in Ollama on the CPU). Only
  // one image a call. Not running, or running another model, costs one local request; a failure
  // part way costs at most 20 s, then Ollama answers as before.
  if (!referenceImages.length) {
    try {
      const r = await describeWithPhotoReader(prompt, imageBase64, { model: visionModel, maxTokens, timeoutMs: Math.min(remaining(), 20_000) });
      if (r?.text) {
        _lastVisionAlertAt = 0;
        logUsage(caller, `photo-reader:${visionModel}`, { input_tokens: r.input_tokens, output_tokens: r.output_tokens }, prompt.slice(0, 100), { started_at: startedAt });
        return r.text;
      }
    } catch (e) {
      console.warn(`[PAN Vision] photo reader failed (${e.message}) - asking Ollama`);
    }
  }

  // Primary: mini PC Ollama (getOllamaUrl() returns the discovered address)
  try {
    const ollamaUrl = (getOllamaUrl() || 'http://localhost:11434').replace(/\/$/, '');
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: visionModel,
        prompt,
        images: allImages,
        stream: false,
        keep_alive: -1,   // never unload — vision model stays hot between captures
        // gemma4 is a THINKING model and thinks by DEFAULT. With no think flag
        // and no token cap it spends most of the wall clock reasoning before
        // emitting any description. Measured 2026-09-07 on the hub, same model
        // and same frame: think=true 25.4s, think=false 13.1s, and the uncapped
        // live endpoint 57s. With this, the same endpoint returns in ~2s warm.
        think: false,
        // Cap the reply too. A description needs a couple of sentences, and an
        // uncapped budget on a thinking model is how an 80 token probe once
        // returned an EMPTY string with done_reason "length".
        // num_predict is not a load option, so a shorter cap reuses the loaded model.
        options: { num_gpu: 0, num_predict: maxTokens }, // mini PC has AMD integrated GPU — force CPU inference
      }),
      // Use the shared overall budget — each provider can take at most what's left.
      signal: AbortSignal.timeout(remaining()),
    });
    if (res.ok) {
      const data = await res.json();
      const text = data.response?.trim() || '';
      if (text) {
        _lastVisionAlertAt = 0; // mini PC answered — re-arm the failure-alert latch
        logUsage(caller, visionModel, { input_tokens: data.prompt_eval_count || 0, output_tokens: data.eval_count || 0 }, prompt.slice(0, 100), { started_at: startedAt });
        return text;
      }
    }
  } catch (e) {
    ollamaFailReason = e.message;
    console.error(`[PAN Vision] Ollama ${visionModel} failed: ${e.message}`);
  }

  // No cloud fallback. Images stay on the mini PC: the owner's rule since 2026-07-15
  // (no Gemini, no Claude API for photos). This used to fall back to Claude Haiku and
  // then Gemini whenever the local model failed, so a down Ollama sent photos off box.

  // All providers exhausted — surface user-facing failures (de-duped).
  if (caller === 'vision') {
    _raiseVisionAlert(visionModel,
      ollamaFailReason ? `Mini PC Ollama error: ${ollamaFailReason}.` : 'No provider produced a result.');
  }
  throw new Error(`No vision provider available — ${visionModel} unreachable on mini PC and no API keys configured`);
}

// #465: source = phone | dashboard | mcp | scout | dream | intuition | router | internal
// device_id = e.g. "pixel-10-pro", "minipc", null for server-internal
// Background callers like 'scout', 'dream', 'intuition-classifier' auto-classify
// by name so we don't have to retrofit every call site.
const INTERNAL_CALLERS = new Set([
  'scout', 'dream', 'evolution', 'consolidation', 'intuition-classifier',
  'augur', 'classifier', 'verifier', 'screen-watcher', 'webcam-watcher',
  'pan-notify', 'orchestrator',
]);

function inferSource(caller, explicitSource) {
  if (explicitSource) return explicitSource;
  if (!caller) return 'internal';
  if (INTERNAL_CALLERS.has(caller)) return caller; // self-tagging for known background callers
  if (caller.startsWith('phone') || caller.includes('pixel') || caller.startsWith('mic')) return 'phone';
  if (caller.startsWith('dash') || caller === 'terminal') return 'dashboard';
  if (caller.startsWith('mcp')) return 'mcp';
  if (caller === 'router' || caller === 'router-stream') return 'router';
  return 'internal';
}

export function logUsage(caller, model, usage, promptPreview, opts = {}) {
  try {
    const inputTokens = usage?.input_tokens || 0;
    const outputTokens = usage?.output_tokens || 0;
    const pricing = MODEL_PRICING[model] || { input: 0, output: 0 };
    const costCents = inputTokens * pricing.input + outputTokens * pricing.output;
    const source = inferSource(caller, opts.source);
    const deviceId = opts.device_id || null;
    // #471: per-call wall-clock latency. Callers pass either `latency_ms` (already
    // measured) or `started_at` (Date.now() at request entry) — we derive ms.
    // Null is fine — old call sites that haven't been updated yet just leave it blank.
    let latencyMs = null;
    if (typeof opts.latency_ms === 'number' && opts.latency_ms >= 0) latencyMs = Math.round(opts.latency_ms);
    else if (typeof opts.started_at === 'number') latencyMs = Math.max(0, Date.now() - opts.started_at);
    insert(
      `INSERT INTO ai_usage (caller, model, input_tokens, output_tokens, cost_cents, prompt_preview, source, device_id, latency_ms)
       VALUES (:caller, :model, :input, :output, :cost, :preview, :source, :device_id, :latency)`,
      { ':caller': caller || 'unknown', ':model': model, ':input': inputTokens, ':output': outputTokens, ':cost': costCents, ':preview': (promptPreview || '').slice(0, 100), ':source': source, ':device_id': deviceId, ':latency': latencyMs }
    );
  } catch (e) {
    console.error('[PAN Usage] Failed to log usage:', e.message);
  }
}

export { getConfiguredModel, getCustomModelConfig, getModelForCaller, MODEL_PRICING };
