// PAN AI Interface — routes all Anthropic calls through Agent SDK (subscription, $0)
// Only uses API key if user explicitly provides one in Settings
// Also supports Ollama, LM Studio, and OpenAI-compatible providers

import { insert, get } from './db.js';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { anonymizeForAI } from './anonymize.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const CEREBRAS_URL = 'https://api.cerebras.ai/v1/chat/completions';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// Pricing per model (cents per token) — SDK models are $0, Cerebras free tier is $0
const MODEL_PRICING = {
  'claude-haiku-4-5-20251001':   { input: 0.00008,  output: 0.0004  },
  'claude-sonnet-4-6-20250514':  { input: 0.0003,   output: 0.0015  },
  'claude-opus-4-6-20250610':    { input: 0.0015,   output: 0.0075  },
  'sdk:claude-haiku-4-5-20251001':   { input: 0, output: 0 },
  'sdk:claude-sonnet-4-6-20250514':  { input: 0, output: 0 },
  'sdk:claude-opus-4-6-20250610':    { input: 0, output: 0 },
  'cerebras:llama3.1-8b':        { input: 0, output: 0 },
  'cerebras:gpt-oss-120b':       { input: 0, output: 0 },
  'cerebras:qwen-3-235b':        { input: 0, output: 0 },
};

// Cerebras model mapping (short name → API model ID)
const CEREBRAS_MODELS = {
  'cerebras:llama3.1-8b':   'llama3.1-8b',
  'cerebras:gpt-oss-120b':  'gpt-oss-120b',
  'cerebras:qwen-3-235b':   'qwen-3-235b-a22b-instruct-2507',
};

// Read configured default model from DB settings
function getConfiguredModel() {
  try {
    const row = get("SELECT value FROM settings WHERE key = 'ai_model'");
    if (row) {
      const val = row.value.replace(/^"|"$/g, '');
      if (val) return val;
    }
  } catch {}
  return DEFAULT_MODEL;
}

// Get model for a specific job/caller (checks per-job override, then falls back to default)
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

// Look up custom model config from settings
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

// Determine if a model is Anthropic (built-in) or custom
function isAnthropicModel(modelId) {
  return modelId.startsWith('claude-');
}

function isCerebrasModel(modelId) {
  return modelId.startsWith('cerebras:');
}

// Get user-provided API key from Settings (if any)
function getUserApiKey() {
  try {
    const row = get("SELECT value FROM settings WHERE key = 'anthropic_api_key'");
    if (row) {
      const key = row.value.replace(/^"|"$/g, '').trim();
      if (key && key.startsWith('sk-ant-')) return key;
    }
  } catch {}
  return null;
}

// Check auth status — is SDK or API key available?
export function getAuthStatus() {
  const apiKey = getUserApiKey();
  // SDK auth is available if claude CLI is logged in (we can't easily check without trying)
  return {
    hasApiKey: !!apiKey,
    method: apiKey ? 'api' : 'sdk',
    description: apiKey
      ? 'Using your API key (paid per token)'
      : 'Using Claude Code subscription (included in plan)',
  };
}

// Get Cerebras API key from settings
function getCerebrasApiKey() {
  try {
    const row = get("SELECT value FROM settings WHERE key = 'cerebras_api_key'");
    if (row) {
      const key = row.value.replace(/^"|"$/g, '').trim();
      if (key && key.length > 10) return key;
    }
  } catch {}
  return null;
}

// Call Cerebras API (OpenAI-compatible, free tier: 1M tokens/day)
async function callCerebras(prompt, messages, cerebrasModel, maxTokens, signal) {
  const apiKey = getCerebrasApiKey();
  if (!apiKey) {
    throw new Error('No Cerebras API key. Add one in Settings > AI & Usage.');
  }

  const modelId = CEREBRAS_MODELS[cerebrasModel] || cerebrasModel.replace('cerebras:', '');

  const oaiMessages = messages.map(m => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    const textParts = m.content.filter(c => c.type === 'text').map(c => c.text);
    return { role: m.role, content: textParts.join('\n') };
  });

  const start = Date.now();
  const response = await fetch(CEREBRAS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: oaiMessages,
      max_completion_tokens: maxTokens,
      temperature: 0.7,
      stream: false,
    }),
    signal,
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`[PAN AI] Cerebras error ${response.status}: ${err.slice(0, 300)}`);
    throw new Error(`Cerebras ${response.status}: ${err.slice(0, 200)}`);
  }

  const data = await response.json();
  const elapsed = Date.now() - start;
  console.log(`[PAN AI] Cerebras ${modelId}: ${elapsed}ms`);

  return {
    text: data.choices?.[0]?.message?.content || '',
    usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 },
  };
}

// Call Anthropic API (only when user has provided their own API key)
async function callAnthropic(prompt, messages, model, maxTokens, timeout, signal) {
  const apiKey = getUserApiKey();
  if (!apiKey) {
    throw new Error('No API key configured. Go to Settings > AI & Usage to add one, or use Claude Code subscription.');
  }

  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages,
    }),
    signal,
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`[PAN AI] Anthropic error ${response.status}: ${err.slice(0, 300)}`);
    throw new Error(`Anthropic ${response.status}: ${err.slice(0, 200)}`);
  }

  const data = await response.json();
  return {
    text: data.content?.[0]?.text || '',
    usage: data.usage,
  };
}

// Call OpenAI-compatible API (Ollama, LM Studio, vLLM, etc.)
async function callOpenAICompat(prompt, messages, config, maxTokens, signal) {
  let url;
  if (config.provider === 'ollama') {
    url = (config.url || 'http://localhost:11434').replace(/\/$/, '') + '/api/chat';
  } else {
    url = (config.url || 'http://localhost:1234').replace(/\/$/, '') + '/v1/chat/completions';
  }

  const headers = { 'Content-Type': 'application/json' };
  if (config.api_key) headers['Authorization'] = `Bearer ${config.api_key}`;

  const oaiMessages = messages.map(m => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    const textParts = m.content.filter(c => c.type === 'text').map(c => c.text);
    return { role: m.role, content: textParts.join('\n') };
  });

  if (config.provider === 'ollama') {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.id, messages: oaiMessages, stream: false }),
      signal,
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Ollama ${response.status}: ${err.slice(0, 200)}`);
    }
    const data = await response.json();
    return {
      text: data.message?.content || '',
      usage: { input_tokens: data.prompt_eval_count || 0, output_tokens: data.eval_count || 0 },
    };
  } else {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.id, messages: oaiMessages, max_tokens: maxTokens, stream: false }),
      signal,
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`${config.provider} ${response.status}: ${err.slice(0, 200)}`);
    }
    const data = await response.json();
    return {
      text: data.choices?.[0]?.message?.content || '',
      usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 },
    };
  }
}

// Call via Agent SDK (uses Claude Code subscription — $0 cost)
async function callSDK(prompt, { model, maxTokens = 300, timeout = 30000, caller = 'unknown' } = {}) {
  if (!model) model = getModelForCaller(caller);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const q = sdkQuery({
      prompt,
      options: {
        model: model || undefined,
        maxTurns: 1,
        persistSession: false,
        permissionMode: 'plan',
        abortController: controller,
        tools: [],
        env: {
          ...process.env,
          CLAUDE_AGENT_SDK_CLIENT_APP: `pan-server/${caller}`,
        },
      },
    });

    let text = '';
    let usage = null;

    for await (const event of q) {
      if (event.type === 'result') {
        const msg = event.subtype === 'success' ? event : null;
        if (msg) {
          text = typeof msg.result === 'string' ? msg.result : '';
          usage = msg.usage || null;
        }
      } else if (event.type === 'assistant') {
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text') text = block.text;
          }
        }
      }
    }

    logUsage(caller, `sdk:${model}`, usage || { input_tokens: 0, output_tokens: 0 }, prompt);

    text = text.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Call with API key (only for users who explicitly set one in Settings)
async function callWithApiKey(prompt, messages, { model, maxTokens = 300, timeout = 15000, caller = 'unknown' } = {}) {
  if (!model) model = getModelForCaller(caller);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    let result;

    if (isAnthropicModel(model)) {
      result = await callAnthropic(prompt, messages, model, maxTokens, timeout, controller.signal);
    } else {
      const config = getCustomModelConfig(model);
      if (!config) {
        throw new Error(`Unknown model: ${model}. Add it in Settings > AI & Usage.`);
      }
      result = await callOpenAICompat(prompt, messages, config, maxTokens, controller.signal);
    }

    logUsage(caller, model, result.usage, typeof prompt === 'string' ? prompt : '');

    let text = result.text.trim();
    text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Log usage to ai_usage table
function logUsage(caller, model, usage, promptPreview) {
  try {
    const inputTokens = usage?.input_tokens || 0;
    const outputTokens = usage?.output_tokens || 0;
    const pricing = MODEL_PRICING[model] || { input: 0, output: 0 };
    const costCents = inputTokens * pricing.input + outputTokens * pricing.output;
    insert(
      `INSERT INTO ai_usage (caller, model, input_tokens, output_tokens, cost_cents, prompt_preview)
       VALUES (:caller, :model, :input, :output, :cost, :preview)`,
      {
        ':caller': caller || 'unknown',
        ':model': model,
        ':input': inputTokens,
        ':output': outputTokens,
        ':cost': costCents,
        ':preview': (promptPreview || '').slice(0, 100),
      }
    );
  } catch (e) {
    console.error('[PAN Usage] Failed to log usage:', e.message);
  }
}

// Decide routing: SDK (subscription) vs API key vs custom model
function getBackend(model) {
  // Check explicit user preference
  try {
    const row = get("SELECT value FROM settings WHERE key = 'ai_backend'");
    if (row) {
      const backend = row.value.replace(/^"|"$/g, '');
      if (backend === 'api') return 'api';
      if (backend === 'sdk') return 'sdk';
    }
  } catch {}

  // Cerebras models
  if (isCerebrasModel(model || getConfiguredModel())) return 'cerebras';

  // Custom/local models always go through their own provider
  if (!isAnthropicModel(model || getConfiguredModel())) return 'custom';

  // Default: SDK (subscription, free)
  return 'sdk';
}

// Public API — text completion
export async function claude(rawPrompt, { model, timeout = 15000, maxTokens = 300, caller = 'unknown', _skipAnonymize = false } = {}) {
  // Anonymize PII before sending to any cloud AI provider
  // _skipAnonymize: caller already handled anonymization selectively (e.g. router
  // anonymizes user text but preserves sensor data like GPS for location queries)
  const prompt = _skipAnonymize ? rawPrompt : anonymizeForAI(rawPrompt);
  if (!model) model = getModelForCaller(caller);
  const backend = getBackend(model);

  if (backend === 'cerebras') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const result = await callCerebras(prompt, [{ role: 'user', content: prompt }], model, maxTokens, controller.signal);
      logUsage(caller, model, result.usage, prompt);
      let text = result.text.trim();
      text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  if (backend === 'custom') {
    const config = getCustomModelConfig(model);
    if (!config) throw new Error(`Unknown model: ${model}. Add it in Settings > AI & Usage.`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const result = await callOpenAICompat(prompt, [{ role: 'user', content: prompt }], config, maxTokens, controller.signal);
      logUsage(caller, model, result.usage, prompt);
      let text = result.text.trim();
      text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  if (backend === 'api') {
    return callWithApiKey(prompt, [{ role: 'user', content: prompt }], { model, maxTokens, timeout, caller });
  }

  // Default: SDK (subscription)
  return callSDK(prompt, { model, maxTokens, timeout: Math.max(timeout, 30000), caller });
}

// Public API — vision (image + text)
export async function claudeVision(prompt, imageBase64, { model, timeout = 30000, caller = 'unknown' } = {}) {
  if (!model) model = getConfiguredModel();

  if (!isAnthropicModel(model)) {
    console.log(`[PAN AI] Vision requested but model ${model} is local — using Anthropic Haiku for vision`);
    model = DEFAULT_MODEL;
  }

  const backend = getBackend(model);

  if (backend === 'sdk') {
    // SDK doesn't support vision well — need API key for this
    const apiKey = getUserApiKey();
    if (!apiKey) {
      // Try SDK with text-only description request
      console.log('[PAN AI] Vision via SDK not supported — falling back to text description');
      return callSDK(`Describe what you see: ${prompt}`, { model, maxTokens: 500, timeout, caller });
    }
  }

  // Use API key for vision
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const messages = [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 },
        },
        {
          type: 'text',
          text: prompt || 'What is in this image? Describe it concisely in 1-3 sentences.',
        },
      ],
    }];

    const result = await callAnthropic(prompt, messages, model, 500, timeout, controller.signal);
    logUsage(caller, model, result.usage, prompt);
    return result.text.trim();
  } finally {
    clearTimeout(timer);
  }
}

// Export for other modules that need model info
export { getConfiguredModel, getCustomModelConfig, MODEL_PRICING, CEREBRAS_MODELS };
