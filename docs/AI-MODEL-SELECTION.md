# PAN — AI Model Selection & Intuition Vocabulary

**The core idea:** When you speak to PAN, the model does exactly what your brain does when
it hears someone talk. It receives a signal, makes sense of it, reasons about what was meant,
and responds. Every capability we measure maps directly to one of those human steps.

Parameter count (235B, 20B, 8B) tells you almost nothing useful. A well-trained 20B model
can outperform a poorly-trained 120B model on the exact task you need. These are the things
that actually matter.

---

## The 7 Scores — PAN's Sensory Vocabulary

Each model gets a score on each of these. These scores are the only things that matter
for deciding what model runs what service.

---

### 🔊 Hearing
*Can the model understand you even when the words come out wrong?*

STT (speech-to-text) is imperfect. You'll say "hey pan open the terminal" and it
transcribes "hey pam opn the termnal." Hearing measures how well the model still
extracts the correct meaning from garbled, incomplete, or mispronounced input.

| Score | What it means | Example |
|-------|--------------|---------|
| 10 | Understands anything, no matter how garbled | "opn termnal in pan projct" → open terminal, PAN project |
| 8–9 | Handles most noise, fails on very bad input | "open termnal" → correct. "opn in projct" → might miss |
| 6–7 | Needs fairly clean input to work reliably | Works when STT is mostly correct |
| Below 6 | Unreliable — do not use for voice | Frequent wrong intent from minor STT errors |

**Floor for voice router: 8 minimum.** This is the one axis where we allow a slightly lower
bar because STT quality has improved enough to reduce the edge cases.

---

### ⚡ Reflex
*How fast does it react for PAN's actual prompt size?*

Measured as TTFT (time-to-first-token) at PAN's real prompt size (~2,000 tokens in, ~50 out).
Not benchmark numbers from lab conditions — real latency from the server to the API and back.

| Grade | Latency | What it feels like | Suitable for voice? |
|-------|---------|-------------------|-------------------|
| **A** | Under 200ms | Instant — you don't wait | ✅ Excellent |
| **B** | 200–400ms | Fast — barely noticeable | ✅ Acceptable |
| **C** | 400–600ms | Noticeable pause | ⚠️ Marginal |
| **D** | 600ms+ | You're waiting | ❌ Not for voice |

**Floor for voice router: B (under 400ms).** Grade C and D are only acceptable for
background services like Dream, Scout, and Consolidation where no one is waiting.

---

### 🎯 Clarity
*Does it produce clean, valid output — every single time?*

PAN's router returns JSON. If the JSON is malformed, the entire response fails — no
error handling can recover a missing bracket or hallucinated field. Clarity measures
how reliably the model produces exactly the right structure, right field names, right types.

| Score | What it means | Example |
|-------|--------------|---------|
| 10 | Perfect JSON, right schema, 100% of the time | Never fails |
| 9 | Rare slip — maybe 1 in 200 responses malformed | Acceptable for production |
| 7–8 | Occasional schema errors under complex prompts | Risky for voice router |
| Below 7 | Regular malformed output | Unusable — hard failures in production |

**Floor for voice router: 9. This is a near-hard requirement.** A score of 8 means
roughly 1 in 50 voice commands returns nothing. That's too frequent.

---

### 🧠 Reasoning
*Can it figure out what you actually meant — not just what you literally said?*

This is the model's ability to handle ambiguity, edge cases, and subtle distinctions.
Examples: "is the user talking to PAN or to someone else in the room?" — "is this a
command or just thinking out loud?" — "what did they mean by 'that project' in context?"

| Score | What it means | Example |
|-------|--------------|---------|
| 10 | Handles any ambiguity correctly | Knows "I should eat more" is a note, not a command |
| 8–9 | Handles most edge cases, fails on very subtle ones | Gets 90%+ of ambiguous cases right |
| 6–7 | Works for clear commands, fails on nuance | Can't reliably detect ambient speech |
| Below 6 | Only handles obvious, unambiguous input | Not suitable for real voice use |

**Floor for voice router: 9.** Ambient detection and speech act classification
(command vs note vs monologue vs social) require strong reasoning.

---

### 🧬 Form
*How is the model built — and what does that mean for speed and quality?*

This is the architecture. It's not a score — it's a label that explains the other scores.

| Form | What it means | Effect |
|------|--------------|--------|
| **Dense** | Every parameter fires for every token | Cost and speed scale with total size |
| **MoE** (Mixture of Experts) | Only a fraction of parameters fire per token | Runs fast like a small model, reasons like a large one |

**Why this matters:** Qwen 3 235B is MoE — 22 billion parameters fire per token, not 235B.
It runs at 22B compute cost but reasons at 235B quality because the active parameters
are specialists, not generalists. This is why it can be both fast AND smart.

**gpt-oss-20b is also MoE** — 3.6B active per token. It is NOT a 3.6B model.
It reasons closer to a 20B dense model.

**Llama models are Dense** — every parameter fires every time. A 70B dense model
costs as much compute as its full 70B on every single token.

Form explains why parameter count is misleading. Always check Form before comparing sizes.

---

### 🧵 Memory
*Does it actually use the conversation history, or does it treat every message as fresh?*

PAN feeds the model recent conversation turns. Memory measures how well the model
uses that context — whether it connects what you're saying now to what you said 3 turns ago.

| Score | What it means | Example |
|-------|--------------|---------|
| 10 | Fully uses all provided history, connects threads perfectly | "do that again" → knows exactly what 'that' refers to |
| 8–9 | Uses history well, occasional context drift on long sessions | |
| 6–7 | Uses last 1-2 turns, loses earlier context | |
| Below 6 | Effectively stateless — ignores history | Every message feels like talking to a stranger |

**Floor for voice router: 8.** Short voice sessions don't require deep memory,
but multi-turn conversations (follow-up questions, corrections) need at least 8.

---

### 🎭 Voice
*Does it maintain its character across many turns, or drift toward generic assistant?*

PAN has a configured personality. Voice measures whether the model holds that personality
consistently, or whether it gradually becomes a bland helpful assistant with no character.

| Score | What it means |
|-------|--------------|
| 9–10 | Strong character, consistent across long conversations |
| 7–8 | Character holds for short sessions, softens in long ones |
| Below 7 | Generic assistant — personality effectively ignored |

**Floor for voice router: 8.** The personality is part of the product. Losing it mid-session
breaks the experience.

---

## The Floor Rules (Pass/Fail for Voice Router)

A model must pass ALL of these to be used as the PAN voice router.
Failing even one disqualifies it, regardless of how good it is elsewhere.

| Score | Minimum | Rationale |
|-------|---------|-----------|
| Hearing | **8+** | STT quality has improved — 8 covers real-world noise |
| Reflex | **B grade (under 400ms)** | Voice must feel fast |
| Clarity | **9+** | JSON failures = hard crashes. Near-zero tolerance. |
| Reasoning | **9+** | Ambient detection + speech acts require strong reasoning |
| Memory | **8+** | Multi-turn voice conversations require history |
| Voice | **8+** | Character is part of the product |

---

## Current Model Scores

### Cerebras (free tier, active on account)

| Model | Form | Hearing | Reflex | Clarity | Reasoning | Memory | Voice | Router? |
|-------|------|---------|--------|---------|-----------|--------|-------|---------|
| **qwen-3-235b** | MoE (22B active) | 9 | C (~580ms) | 9 | 9 | 9 | 9 | ⚠️ Fails Reflex |
| **gpt-oss-120b** | Dense | 8 | B (~150ms est.) | 9 | 8 | 8 | 8 | ⚠️ Unverified — benchmark first |
| **zai-glm-4.7** | Unknown | ? | ? | ? | ? | ? | ? | ❌ Unscored — do not use |
| **llama3.1-8b** | Dense | 5 | C (~440ms) | 6 | 5 | 5 | 4 | ❌ Fails everything |

> llama3.1-8b is counterintuitively slower than 235B on Cerebras AND worse quality.
> Never use it for the router. It is the worst of both worlds on this hardware.

### Groq (separate provider — requires Groq API key + `groq:` prefix in llm.js)

| Model | Form | Hearing | Reflex | Clarity | Reasoning | Memory | Voice | Router? |
|-------|------|---------|--------|---------|-----------|--------|-------|---------|
| **gpt-oss-20b** | MoE (3.6B active) | 8 | A (~75–200ms) | 8 | 7 | 7 | 7 | ⚠️ Clarity + Reasoning borderline |
| **llama-3.3-70b** | Dense | 8 | B (~300ms) | 8 | 8 | 8 | 7 | ⚠️ Benchmark needed |

---

## Service → Model Map

| PAN Service | Speed needed | Reasoning needed | Current model | Notes |
|-------------|-------------|-----------------|---------------|-------|
| **Voice Router** | ⚡ Critical | High | `cerebras:qwen-3-235b` | Fails Reflex — tolerated until faster option verified |
| **Dashboard Chat** | Moderate | High | `cerebras:qwen-3-235b` | No speed pressure. Best quality. |
| **Augur (classifier)** | Low | Medium | `cerebras:qwen-3-235b` | Runs every 5min in background |
| **Dream Cycle** | None | Very high | `cerebras:qwen-3-235b` | Runs every 6h. Max quality. |
| **Scout** | None | Very high | `cerebras:qwen-3-235b` | Research quality. No compromise. |
| **Consolidation** | Low | High | `cerebras:qwen-3-235b` | Memory quality matters permanently |
| **Task Reconcile** | Low | Medium | `cerebras:qwen-3-235b` | Runs frequently — consider 120b here |
| **Evolution Engine** | None | High | `cerebras:qwen-3-235b` | Rare runs. Max quality. |

**Pattern:** Only voice routing is speed-constrained. Every background service should
run the best available model regardless of latency.

---

## Why Chinese Models Dominate the Speed Tier

Chinese labs (Alibaba/Qwen, DeepSeek, GLM/ZAI) consistently lead the efficiency tier because:

1. **MoE-first architecture** — they optimized for active-parameter efficiency early
2. **Instruction tuning quality** — strong RLHF alignment means high Clarity and Reasoning scores
   at smaller active parameter counts
3. **Multilingual training** — handling Chinese + English + noise improves Hearing scores
4. **Open weights** — they release weights, which means fast inference providers (Cerebras, Groq)
   can run them on optimized hardware

This is why Qwen-3-235B at 22B active outperforms Meta's Llama-3.3-70B dense on most tasks
while being similarly priced. The parameter count comparison (235 vs 70) is meaningless —
the active parameter count (22 vs 70) is the real comparison, and Qwen still wins on quality.

---

## AutoDev Benchmark Plan

PAN should measure these scores automatically. Endpoint:

```
POST /api/v1/ai/benchmark
{ "model": "cerebras:gpt-oss-120b", "suite": "router" }
```

### Test battery:

**Hearing test** — 10 garbled STT inputs, measure correct intent extraction
```
"hey pam opn the termnal"     → intent: terminal, action: open
"what the wether tomoro"       → intent: query, topic: weather
"pley somthing by kendik lamar" → intent: music, artist: Kendrick Lamar
```

**Reflex test** — 10 calls at real PAN prompt size (~2,000 tokens). Record P50 + P95 TTFT.

**Clarity test** — 20 router prompts. Count valid JSON / correct schema / zero hallucinated fields.

**Reasoning test** — 10 ambient-detection prompts (user talking to someone else, background TV).
Measure: correct `{"intent":"ambient"}` return rate.

**Memory test** — 5-turn conversation, final turn requires referencing turn 1. Correct reference = pass.

Results stored in `ai_benchmark` table. Dashboard AI Models panel shows last benchmark + scores.
A model with unverified scores cannot be assigned to the voice router.

---

## Glossary

| Term | Plain English |
|------|--------------|
| **MoE** | Model splits into specialist sub-networks. Only a fraction activates per token. Fast + smart. |
| **Dense** | Every parameter fires every token. Speed scales with total size. |
| **TTFT** | Time To First Token — how long before the response starts arriving |
| **Active params** | The parameters that actually run per token in a MoE model |
| **RLHF** | How the model was trained to follow instructions — affects Clarity and Reasoning scores more than raw size |
| **STT** | Speech To Text — the transcript of what the mic heard |
| **Ambient** | Speech that isn't directed at PAN — background conversation, TV, talking to someone else |
