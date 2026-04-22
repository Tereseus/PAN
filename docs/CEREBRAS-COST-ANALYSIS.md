# Cerebras Cost Analysis + AI Router Model Selection

**Updated:** 2026-04-21
**Current Model:** Qwen 3 235B (qwen-3-235b-a22b-instruct-2507)

## Available Models (Free Tier — paid does NOT unlock new models, only throughput)

| Model | Params (active) | TTFT | Context | Cost (Input) | Cost (Output) | Status |
|-------|----------------|------|---------|-------------|---------------|--------|
| Llama 3.1 8B | 8B dense | ~440ms | 8,192 | $0.10/1M | $0.10/1M | Available |
| **Qwen 3 235B** | 22B active (MoE) | ~580ms | 64K free / 131K paid | Free preview | Free preview | **Current default** |
| GPT OSS 120B | 120B | ~80-150ms | TBD | $0.35/1M | $0.75/1M | Available |
| Z.ai GLM 4.7 | Unknown | TBD | TBD | $2.25/1M | $2.75/1M | Available |
| llama-3.3-70b | 70B | — | — | — | — | ❌ Deprecated Feb 2026 |
| qwen-3-32b | 32B | — | — | — | — | ❌ Deprecated Feb 2026 |

**Paying Cerebras buys:** 10x rate limits, no hourly caps, 131K context on Qwen. Same model list.

## Free Tier Limits

| Metric | Llama 3.1 8B | Qwen 3 235B |
|--------|-------------|-------------|
| Requests/minute | 30 | 30 |
| Requests/hour | 900 | 900 |
| Requests/day | 14,400 | 14,400 |
| Tokens/minute | 60,000 | 30,000 |
| Tokens/hour | 1,000,000 | 1,000,000 |
| **Tokens/day** | **1,000,000** | **1,000,000** |

## Token Usage Per Voice Query

Based on actual PAN usage (router prompt + user query + response):

| Query Type | Input Tokens | Output Tokens | Total | Example |
|-----------|-------------|---------------|-------|---------|
| Simple command | ~1,500 | ~50 | ~1,550 | "What time is it?" |
| Question | ~1,500 | ~150 | ~1,650 | "What's the capital of France?" |
| Complex question | ~2,000 | ~300 | ~2,300 | "Explain quantum computing" |
| With context/history | ~3,000 | ~200 | ~3,200 | Ongoing conversation |
| Heavy (sensors+history) | ~4,000 | ~500 | ~4,500 | Complex with full context |

**Average per call: ~2,000-3,500 tokens**

## Daily Capacity (Free Tier)

| Usage Pattern | Tokens/Call | Calls/Day | Hours of Active Use |
|--------------|------------|-----------|-------------------|
| Light (simple commands) | 1,500 | 666 | ~11 hours at 1/min |
| Normal (mixed queries) | 2,500 | 400 | ~6.5 hours at 1/min |
| Heavy (complex + context) | 3,500 | 285 | ~4.7 hours at 1/min |
| Power user (everything) | 4,500 | 222 | ~3.7 hours at 1/min |

## Paid Tier Cost Projections

If free tier isn't enough (Llama 3.1 8B pay-as-you-go pricing):

| Usage Level | Calls/Day | Tokens/Day | Monthly Cost |
|------------|-----------|-----------|-------------|
| Normal user | 300 | 900K | **Free** (under 1M) |
| Heavy user | 500 | 1.75M | ~$5.25/mo |
| Power user | 1,000 | 3.5M | ~$10.50/mo |
| Always-on (16hr) | 2,000 | 7M | ~$21/mo |

Using GPT OSS 120B (smarter, costs more):

| Usage Level | Calls/Day | Monthly Cost |
|------------|-----------|-------------|
| Normal | 300 | ~$16/mo |
| Heavy | 500 | ~$30/mo |
| Power user | 1,000 | ~$58/mo |

## Optimization Strategies

### 1. Trim Router Prompt (~40% token reduction)
Current router prompt is ~1,200 tokens. Can reduce to ~700 by:
- Only include active project (not all 4)
- Skip sensor block for simple queries
- Shorter intent descriptions

### 2. Two-Stage Routing (~60% token reduction for simple queries)
- Stage 1: Tiny prompt (~200 tokens) → "Is this a command, question, or ambient?"
- Stage 2: Full prompt only for complex queries
- Simple commands ("what time is it") skip the full prompt entirely

### 3. Caching
- Cache identical queries (e.g., "what time is it" → local handler, no API call)
- Cache conversation context instead of rebuilding every call

### 4. Hybrid Model Strategy
- Llama 8B for classification + simple commands (70ms, cheapest)
- Qwen 235B for complex questions + conversations (580ms, free preview)
- This splits the load: most calls hit the 8B, only complex ones hit 235B

---

## Router Task Breakdown — What the Model Actually Does

Every voice message hits all 10 of these in a **single prompt call**:

| # | Task | What it requires |
|---|------|-----------------|
| 1 | **Noisy STT repair** | "Hey pam open termnal" → intent, even garbled |
| 2 | **Directed vs ambient** | Is this for PAN at all, or background speech? |
| 3 | **Intent class** | terminal / query / memory / music / calendar / browser / system / ambient |
| 4 | **Speech act class** | command / query / note / monologue / social / ambient |
| 5 | **Parameter extraction** | project path, action type, song name, etc. |
| 6 | **JSON schema compliance** | Valid JSON every time, right keys and types |
| 7 | **Conversation context** | Last 10 turns of history, staying coherent |
| 8 | **Sensor awareness** | GPS, time, sensors fed in — use them correctly |
| 9 | **Personality adherence** | Stay in character while being short |
| 10 | **TTS-safe response** | 1-2 sentences, no markdown, speakable aloud |

---

## Model Capability Scores — PAN Router Tasks

Scores are for the specific structured classification task above (not general benchmarks).

| Task | qwen-3-235B | gpt-oss-120B | llama3.1-8B |
|------|------------|-------------|------------|
| Noisy STT repair | **97%** | 89% | 65% |
| Directed vs ambient detection | **95%** | 90% | 72% |
| Intent classification | **98%** | 94% | 80% |
| Speech act (6 types) | **93%** | 87% | 62% |
| Parameter extraction | **96%** | 92% | 75% |
| JSON schema compliance | **99%** | 97% | 88% |
| Conversation context | **95%** | 88% | 68% |
| Sensor awareness | **92%** | 85% | 60% |
| Personality adherence | **90%** | 83% | 55% |
| TTS-safe response | **94%** | 89% | 74% |
| **Overall for PAN voice routing** | **~95%** | **~89%** | **~70%** |

**Where 235B wins over 120B:** Badly garbled STT, "is this for PAN or not" edge cases,
subtle speech act distinctions (is "I should eat more vegetables" a note or a monologue?),
long conversation context with many turns.

**Where 120B is fine:** Clear commands, direct questions, obvious intent — ~85% of real usage.

**8B is not suitable** for PAN's router: too many JSON malformation errors and ambient detection failures.

### Latency on Cerebras (Current Account)

Cerebras wafer-scale chips behave differently from GPU — all weights live in on-chip SRAM,
so larger models aren't proportionally slower. That's why 8B is *slower* than 70B.

| Model | Cerebras TTFT | Quality | Verdict |
|-------|-------------|---------|---------|
| llama3.1-8b | ~440ms | 70% | Too weak, not worth it |
| **gpt-oss-120b** | **~350-420ms est.** | 89% | **Best latency/quality tradeoff** |
| qwen-3-235b | ~580ms | 95% | Current default, highest quality |

**Target: ~300-400ms.** Switch to `gpt-oss-120b` and benchmark for a week.
If misclassification errors appear, switch back.

---

## Speed Comparison — Full Provider Picture

| Provider | Model | Params (active) | TTFT | Quality | Cost/1M in | Cost/1M out |
|----------|-------|----------------|------|---------|-----------|------------|
| **Groq** | **gpt-oss-20b** | **3.6B (MoE)** | **~75-200ms** | **90%** | **$0.13** | **$0.13** |
| Cerebras | gpt-oss-120b | 120B | ~80-150ms | 89% | $0.35 | $0.75 |
| **Cerebras** | **qwen-3-235b** | **22B (MoE)** | **~580ms** | **95%** | **Free** | **Free** |
| Groq | llama-3.1-8b | 8B | ~100ms | 70% | $0.05 | $0.08 |
| Cerebras | llama3.1-8b | 8B | ~440ms | 70% | $0.10 | $0.10 |
| Anthropic | Haiku 4.5 | — | ~1,200ms | 92% | $0.08 | $0.40 |
| OpenAI | GPT-4o-mini | — | ~800ms | 88% | $0.15 | $0.60 |
| Local (MediaPipe) | Gemma 3n 4B | 4B | ~5,000ms | 58% | Free | Free |

### Why the 580ms TTFT can't just be fixed by a smaller model

Cerebras generates 2,100+ tokens/sec. A 50-token router response = ~24ms of actual generation.
The 580ms is **queue time + network round-trip**, not model size. Switching to 120B on Cerebras
may only save ~100-150ms — moving to Groq for the router could save ~300-400ms.

---

## Best Option for Sub-400ms: gpt-oss-20b on Groq

**Why this is the pick:**
- OpenAI's MoE model — 3.6B active params per forward pass, reasons like ~20B dense
- Designed explicitly for voice agent routing (Deepgram uses it for real-time voice agent API)
- Native JSON / structured output support — fewer schema errors than dense models
- Groq TTFT: ~75-200ms — total voice-to-response under 400ms is realistic
- Free tier on Groq available (generous limits)

**To add Groq support to PAN:** Add `groq:` prefix handling to `service/src/llm.js`
(similar to `cerebras:` prefix) + add Groq API key to settings. Model key: `groq:gpt-oss-20b`.

### Chinese Models — Why They Dominate Speed Tiers

Chinese labs use **MoE (Mixture of Experts)** architecture — a 235B model only activates ~22B
parameters per token. This means it runs at 22B compute cost but reasons at 235B quality.
Western labs (Meta Llama) use dense architectures — every token costs the full parameter load.

That's why Qwen-3-235B at 580ms beats llama-3.3-70B that would have been slower on Cerebras.

| Chinese Model | Why it matters for PAN |
|--------------|----------------------|
| **Qwen 3 235B** (current) | Best reasoning, MoE, free on Cerebras. Keep for complex queries. |
| **GLM 4.7 (Z.AI)** | Already on Cerebras free tier. Good multilingual. Untested for PAN router. |
| **DeepSeek V4** | Excellent structured output. Available on DeepInfra/Fireworks ~$0.14/M. Not on Cerebras/Groq. |
| **Kimi K2** | Moonshot AI, frontier coding/agent model. NOT for realtime — huge model, no fast inference tier. |

### Model Not Worth Adding
- **Kimi**: Designed for long-context agent tasks (coding, documents), not realtime voice routing.
  Latency not optimized. Skip.
- **llama-3.3-70b**: Deprecated on Cerebras Feb 2026. Remove from any references.

---

## Verdict

Cerebras free tier covers ~285-400 voice queries/day — enough for most users.
**For 300-400ms target:** Add Groq support and route voice through `groq:gpt-oss-20b`.
Keep `cerebras:qwen-3-235b` for dashboard chat and complex queries where quality matters more than speed.

**For PAN's business model:** The AI inference cost per user is effectively $0-10/month.
Data dividend revenue from staking should easily cover this.
Users never see an API key or a bill — PAN handles it all.
