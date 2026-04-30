// PAN LLM Interface — unified entry point for all AI providers
// Supports Anthropic, Gemini, Cerebras, Ollama, and LM Studio.
// Routes based on Settings > AI & Usage.

import { insert, get, getOllamaUrl } from './db.js';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { anonymizeForAI } from './anonymize.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const CEREBRAS_URL  = 'https://api.cerebras.ai/v1/chat/completions';
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
  
  // Cerebras — cents per token (0.000030 = $0.30/1M, 0.000060 = $0.60/1M)
  // Verify against https://cloud.cerebras.ai — these are best estimates, update if wrong
  'cerebras:llama3.1-8b':        { input: 0.000010,  output: 0.000010  }, // ~$0.10/1M
  'cerebras:gpt-oss-120b':       { input: 0.000060,  output: 0.000060  }, // ~$0.60/1M
  'cerebras:qwen-3-235b':        { input: 0.000030,  output: 0.000060  }, // ~$0.30 in / $0.60 out per 1M
  'cerebras:zai-glm-4.7':        { input: 0.000060,  output: 0.000060  }, // ~$0.60/1M

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

const CEREBRAS_MODELS = {
  'cerebras:llama3.1-8b':    'llama3.1-8b',
  'cerebras:gpt-oss-120b':   'gpt-oss-120b',
  'cerebras:qwen-3-235b':    'qwen-3-235b-a22b-instruct-2507',
  'cerebras:zai-glm-4.7':    'zai-glm-4.7',
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
      cerebras:  'cerebras_api_key',
      groq:      'groq_api_key',
      openai:    'openai_api_key',
    };
    const row = get(`SELECT value FROM settings WHERE key = '${keyMap[provider]}'`);
    if (row) return row.value.replace(/^"|"$/g, '').trim();
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

  const result = await genModel.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  });

  const response = await result.response;
  return {
    text: response.text(),
    usage: { 
      input_tokens: response.usageMetadata?.promptTokenCount || 0, 
      output_tokens: response.usageMetadata?.candidatesTokenCount || 0 
    }
  };
}

async function callCerebras(prompt, messages, cerebrasModel, maxTokens, signal) {
  const apiKey = getApiKey('cerebras');
  if (!apiKey) throw new Error('No Cerebras API key found.');

  const modelId = CEREBRAS_MODELS[cerebrasModel] || cerebrasModel.replace('cerebras:', '');
  const oaiMessages = messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.filter(c => c.type === 'text').map(c => c.text).join('\n') }));

  const response = await fetch(CEREBRAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: modelId, messages: oaiMessages, max_completion_tokens: maxTokens, temperature: 0.7, stream: false }),
    signal,
  });

  if (!response.ok) throw new Error(`Cerebras ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return {
    text: data.choices?.[0]?.message?.content || '',
    usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 },
  };
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
    body: JSON.stringify({ model: config.id, messages: oaiMessages, max_tokens: maxTokens, stream: false }),
    signal,
  });

  if (!response.ok) throw new Error(`${config.provider} ${response.status}: ${await response.text()}`);
  const data = await response.json();
  
  if (isOllama) {
    return { text: data.message?.content || '', usage: { input_tokens: data.prompt_eval_count || 0, output_tokens: data.eval_count || 0 } };
  }
  return { text: data.choices?.[0]?.message?.content || '', usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 } };
}

// --- Main Interface ---

export async function askAI(rawPrompt, { model, timeout = 15000, maxTokens = 300, caller = 'unknown', _skipAnonymize = false } = {}) {
  const prompt = _skipAnonymize ? rawPrompt : anonymizeForAI(rawPrompt);
  if (!model) model = getModelForCaller(caller);

  // Determine Provider
  let provider = 'sdk';
  if      (model.startsWith('gemini:'))    provider = 'gemini';
  else if (model.startsWith('cerebras:')) provider = 'cerebras';
  else if (model.startsWith('groq:'))     provider = 'groq';
  else if (model.startsWith('openai:'))   provider = 'openai';
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
    } else if (provider === 'cerebras') {
      result = await callCerebras(prompt, [{ role: 'user', content: prompt }], model, maxTokens, controller.signal);
    } else if (provider === 'groq') {
      const key = getApiKey('groq');
      if (!key) throw new Error('No Groq API key in Settings. Add groq_api_key.');
      result = await callOpenAIEndpoint(
        [{ role: 'user', content: prompt }],
        model.replace('groq:', ''), GROQ_URL, key, maxTokens, controller.signal
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
      const q = sdkQuery({ prompt, options: { model, maxTurns: 1, persistSession: false, permissionMode: 'plan', abortController: controller, tools: [], env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `pan-server/${caller}` } } });
      let text = '';
      let usage = null;
      for await (const event of q) {
        if (event.type === 'result' && event.subtype === 'success') { text = event.result || ''; usage = event.usage; }
        else if (event.type === 'assistant' && event.message?.content) text = event.message.content.find(b => b.type === 'text')?.text || text;
      }
      result = { text, usage };
      model = `sdk:${model}`;
    }

    logUsage(caller, model, result.usage, prompt);
    return result.text.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  } finally {
    clearTimeout(timer);
  }
}

export const claude = askAI;

// --- Vision (screenshot understanding via local Qwen2.5-VL or cloud API fallback) ---

// qwen2.5vl:3b crashes on CPU vision. moondream generates empty responses.
// llava-phi3 (2.9GB) is proven reliable with Ollama's API on CPU.
// moondream: 1.7GB, purpose-built CPU vision. Uses /api/generate (not /api/chat).
// qwen2.5vl:3b crashes on vision inference on CPU-only — text works, images don't.
const VISION_MODEL = 'minicpm-v';

export async function analyzeImage(prompt, imageBase64, { caller = 'vision', timeout = 70000, referenceImages = [] } = {}) {
  // referenceImages: optional array of base64 strings prepended before the main image.
  // Ollama /api/generate supports images[] — first image(s) are reference, last is live frame.
  const allImages = [...referenceImages, imageBase64];

  // Primary: mini PC Ollama (100.72.237.137:11434) — getOllamaUrl() returns that address
  try {
    const ollamaUrl = (getOllamaUrl() || 'http://localhost:11434').replace(/\/$/, '');
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VISION_MODEL,
        prompt,
        images: allImages,
        stream: false,
        keep_alive: -1,   // never unload — vision model stays hot between captures
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (res.ok) {
      const data = await res.json();
      const text = data.response?.trim() || '';
      if (text) {
        logUsage(caller, VISION_MODEL, { input_tokens: data.prompt_eval_count || 0, output_tokens: data.eval_count || 0 }, prompt.slice(0, 100));
        return text;
      }
    }
  } catch (e) {
    console.error(`[PAN Vision] Ollama ${VISION_MODEL} failed: ${e.message}`);
  }

  // Fallback: Claude API with vision (requires API key)
  const apiKey = getApiKey('anthropic');
  if (apiKey) {
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: [
              ...allImages.map(img => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } })),
              { type: 'text', text: prompt },
            ],
          }],
        }),
        signal: AbortSignal.timeout(timeout),
      });

      if (res.ok) {
        const data = await res.json();
        const text = data.content?.[0]?.text?.trim() || '';
        logUsage(caller, 'claude-haiku-4-5-20251001', data.usage, prompt.slice(0, 100));
        return text;
      }
    } catch (e) {
      console.error(`[PAN Vision] Claude API fallback failed: ${e.message}`);
    }
  }

  // Fallback: Gemini (if key available)
  const geminiKey = getApiKey('gemini');
  if (geminiKey) {
    try {
      const genAI = new GoogleGenerativeAI(geminiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const result = await model.generateContent([
        prompt,
        { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } },
      ]);
      const text = result.response?.text()?.trim() || '';
      if (text) {
        const meta = result.response?.usageMetadata;
        logUsage(caller, 'gemini-2.0-flash', {
          input_tokens:  meta?.promptTokenCount     || 0,
          output_tokens: meta?.candidatesTokenCount || 0,
        }, prompt.slice(0, 100));
        return text;
      }
    } catch (e) {
      console.error(`[PAN Vision] Gemini fallback failed: ${e.message}`);
    }
  }

  throw new Error(`No vision provider available — ${VISION_MODEL} unreachable on mini PC and no API keys configured`);
}

export function logUsage(caller, model, usage, promptPreview) {
  try {
    const inputTokens = usage?.input_tokens || 0;
    const outputTokens = usage?.output_tokens || 0;
    const pricing = MODEL_PRICING[model] || { input: 0, output: 0 };
    const costCents = inputTokens * pricing.input + outputTokens * pricing.output;
    insert(
      `INSERT INTO ai_usage (caller, model, input_tokens, output_tokens, cost_cents, prompt_preview)
       VALUES (:caller, :model, :input, :output, :cost, :preview)`,
      { ':caller': caller || 'unknown', ':model': model, ':input': inputTokens, ':output': outputTokens, ':cost': costCents, ':preview': (promptPreview || '').slice(0, 100) }
    );
  } catch (e) {
    console.error('[PAN Usage] Failed to log usage:', e.message);
  }
}

export { getConfiguredModel, getCustomModelConfig, MODEL_PRICING, CEREBRAS_MODELS };
