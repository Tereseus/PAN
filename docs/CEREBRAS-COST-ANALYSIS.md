# Cerebras Cost Analysis for PAN

**Date:** 2026-03-29
**Current Model:** Qwen 3 235B (qwen-3-235b-a22b-instruct-2507)

## Available Models (Free Tier)

| Model | Parameters | Speed | Context | Cost (Input) | Cost (Output) |
|-------|-----------|-------|---------|-------------|---------------|
| Llama 3.1 8B | 8B | ~70ms | 8,192 | $0.10/1M | $0.10/1M |
| Qwen 3 235B | 235B | ~580ms | 65,536 | Free (preview) | Free (preview) |
| GPT OSS 120B | 120B | ~200-400ms | TBD | $0.35/1M | $0.75/1M |
| Z.ai GLM 4.7 | Unknown | TBD | TBD | $2.25/1M | $2.75/1M |

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

## Speed Comparison

| Provider | Model | Latency | Cost |
|----------|-------|---------|------|
| **Cerebras** | Llama 3.1 8B | **~70ms** | Free |
| **Cerebras** | Qwen 3 235B | **~580ms** | Free |
| Anthropic | Haiku 4.5 | ~1,200ms | $0.08/$0.40 per 1M |
| Anthropic SDK | Haiku 4.5 | ~1,200ms | Subscription |
| OpenAI | GPT-4o-mini | ~800ms | $0.15/$0.60 per 1M |
| Groq | Llama 3 70B | ~300ms | $0.59/$0.79 per 1M |
| Local (MediaPipe) | Gemma 3n 4B | ~5,000ms | Free (on-device) |

## Verdict

Cerebras free tier covers ~285-400 voice queries/day — enough for most users. Power users who talk to PAN 16 hours straight would need pay-as-you-go at ~$10-20/month. The 235B model is the sweet spot: near-instant, massive context, free during preview.

**For PAN's business model:** The AI inference cost per user is effectively $0-10/month. Data dividend revenue from staking should easily cover this. Users never see an API key or a bill — PAN handles it all.
