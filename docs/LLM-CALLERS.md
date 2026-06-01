# LLM Callers — what each one does and what it should be routed to

This doc maps every `caller:` string in PAN to its purpose, prompt shape, and
the routing decision behind which model handles it. It exists because the
LLM Routing widget shows raw caller names — without this doc you'd have to
read the source to know what `pan-reasoning-render` actually is.

See also:
- **`/api/v1/usage/llm-routing`** — live per-caller stats (cloud vs local,
  tokens/day, configured model).
- **UsagePanel.svelte** — the dashboard widget that renders this data.
- **`docs/AI-MODEL-SELECTION.md`** — how `model_selections`, `job_models`,
  and `ai_model` interact in `llm.js getModelForCaller`.

Routing source of truth, in priority order:
1. `settings.job_models[caller]` — per-caller override
2. `settings.ai_model` — default for everything else
3. `model_selections` registry — purpose-based (`reasoning_cloud`,
   `chat_cloud_fallback`, `chat_local`) used by the fallback chain when the
   primary fails (Cerebras 429/quota → Claude SDK → Ollama)

---

## Cloud-bound callers (count against Cerebras quota)

### `router` — voice + dashboard chat reply (THE big one)
**File:** `src/router.js` (lines 362, 567, 1328, 1479)
**Caller class:** `voice` (uses `askAIWithFallback` chain)
**What it does:** Takes a user utterance + huge context block (intuition
snapshot, conv-state, dialog history, recent mind, active tasks, dismissal
feedback, memory facts, episodic hits, sensor data) and emits a single
JSON action `{intent, response, speech_act, importance, why, mind}`.
This is the heart of every voice turn and every dashboard chat message.
**Prompt size:** ~5,000-8,000 tokens.
**Latency target:** <2 seconds for live voice.
**Current routing:** `cerebras:zai-glm-4.7` (~1.4s, smart enough for JSON +
reasoning, 720M tok/day quota).
**Fallback:** chain → `cerebras:gpt-oss-120b` → `ollama:qwen3:4b`.

### `scout` — broken-thing research (#1 token burner)
**File:** `src/scout.js` (line 217)
**What it does:** Scans recent errors / failures (broken benchmarks, Steward
DOWN events, Cerebras 5xx storms, etc.) and figures out the likely root
cause + suggested fix. Outputs a finding row in `scout_findings`.
**Prompt size:** HUGE — ~19,000 tokens average per call. Includes full
recent error log + stack traces. This caller alone burns ~25% of the daily
Cerebras token cap.
**Latency target:** doesn't matter — background, 6h interval.
**Current routing:** `cerebras:gpt-oss-120b` (2B tok/day quota fits Scout's
heavy prompts).
**Optimization lever:** If you ever hit the daily token cap, trimming
Scout's context is the highest-leverage fix.

### `intuition-classifier` — utterance classifier
**File:** `src/intuition/index.js` (line 1011)
**What it does:** Classifies events flowing through PAN into intent
categories (e.g. "user is requesting help", "user is reflecting",
"system event"). Drives Intuition's deliberation stage.
**Prompt size:** ~500-1500 tokens.
**Latency target:** <2s (runs in classification loop).
**Volume:** ~70 calls/day actual (NOT 25k — that was an SQL bug in my
prior count).
**Current routing:** `cerebras:gpt-oss-120b`.
**Why not local:** Classification quality matters for the entire downstream
intuition pipeline. qwen3:4b would mislabel often enough to corrupt
deliberation.

### `pan-reasoning` — "what does PAN think right now"
**File:** `src/intuition/reasoning.js` (line 377)
**What it does:** Reads the current intuition snapshot + recent mind stream
+ dialog state and writes PAN's reasoning trace ("I notice the user is
debugging the dashboard; they seem focused but tired"). Backs the 🧠
disclosure under each chat bubble.
**Prompt size:** ~3,000 tokens.
**Latency target:** doesn't matter — async render.
**Current routing:** default `cerebras:zai-glm-4.7`.

### `pan-reasoning-render` — formatting the reasoning into prose
**File:** `src/intuition/reasoning.js` (line 496)
**What it does:** Post-processes pan-reasoning's structured output into
human-readable prose for the trace panel.
**Current routing:** default `cerebras:zai-glm-4.7`.

### `conv-state` — conversation-state distillation
**File:** `src/conv-state-watcher.js` (line 174)
**What it does:** Watches every utterance and ~500ms after a "final"
turn distills the conversation state: `{topic, phase, pending_question,
user_pattern, likely_turn_complete, summary}`. Feeds the router so it
doesn't have to think about the whole conversation each turn.
**Prompt size:** ~2,000 tokens (last 10 turns + previous state).
**Current routing:** default `cerebras:zai-glm-4.7`.

### `session-recap` — end-of-session summary
**File:** `src/session-summary.js` (line 164)
**What it does:** On session end (PTY close / explicit /end), writes a
short recap so the next session can pick up where this one left off.
**Volume:** ~4/day.
**Current routing:** default `cerebras:zai-glm-4.7`.

### `task-reconcile` — pending-task housekeeper
**File:** `src/memory/consolidation.js` (line 226)
**What it does:** Periodically reads `project_tasks` + recent conversation
and emits status updates ("task #57 looks done — claude session 09a09145
said 'pushed to master' for it").
**Volume:** ~10/day (bursts during dev sessions).
**Current routing:** `cerebras:gpt-oss-120b`.

### `consolidation` — memory consolidation
**File:** `src/memory/consolidation.js` (line 157)
**What it does:** Daily-ish pass over `events` table → groups related
events into `episodic_memories` with summary + retrieval keys. Backs the
"Episodic Hits" block in the router prompt.
**Volume:** ~2/day.
**Current routing:** `cerebras:gpt-oss-120b`.

### `dream` — 6-hourly memory consolidation cycle
**File:** `src/dream.js` (line 125)
**What it does:** Deep pass over recent events → reorganizes the
knowledge graph, generates higher-order narrative memories, prunes
duplicates. The Dream Service is the "sleep" cycle PAN runs every 6h.
**Volume:** ~1/day (low — runs 4×/day but most cycles are no-ops).
**Current routing:** `cerebras:zai-glm-4.7`.

### `orchestrator` — service coordination
**File:** `src/orchestrator.js` (line 163)
**What it does:** Watches for cross-service decisions that need human
or LLM judgment (e.g. "Scout found 3 conflicting fixes — which one?")
and writes a structured proposal to `orchestrator_actions`.
**Volume:** ~1/day.
**Current routing:** `cerebras:zai-glm-4.7`.

### `evolution-critique` — self-improvement loop
**File:** `src/evolution/engine.js` (line 205)
**What it does:** Reads recent failed runs + benchmark dips and proposes
a concrete code change (file + diff) to address them. Feeds the
Evolution panel.
**Volume:** typically very low.
**Current routing:** `cerebras:zai-glm-4.7`.

### `recall` — explicit memory lookup
**File:** `src/router.js` (line 386), `src/routes/api.js` (lines 629, 755)
**What it does:** When the user says "remember when..." or asks a fact
question, this caller does the vector + FTS hybrid search and rewrites
the result as a natural-language answer.
**Current routing:** default `cerebras:zai-glm-4.7`.

### `recall-synthesis` — multi-hit memory synthesizer
**File:** `src/router.js` (line 1031)
**What it does:** When `recall` returns multiple memory hits, this
caller combines them into one coherent answer rather than listing them.
**Current routing:** default `cerebras:zai-glm-4.7`.

### `pan_persona` — Π chat reply
**File:** `src/pan-notify.js` (line 120)
**What it does:** When you type a message in the Π chat thread (the
contact panel), this generates the persona reply ("I'm here. Scout is
running, Dream wakes in 3h, anything you need?").
**Volume:** depends on how much you chat with Π.
**Current routing:** default `cerebras:zai-glm-4.7`.

### `guardian` — privacy / sensitivity classifier
**File:** `src/guardian.js` (line 157)
**What it does:** Before any event is logged in clear text, Guardian
classifies it for PII / sensitive content. Drives anonymisation.
**Current routing:** default `cerebras:zai-glm-4.7`.

### `sensitivity` — sensitivity-level scorer (sister of guardian)
**File:** `src/sensitivity.js` (line 182)
**Current routing:** default `cerebras:zai-glm-4.7`.

### `benchmark_judge` / `benchmark_dream_judge` — test harness
**File:** `src/benchmark.js` (lines 134, 552)
**What it does:** Acts as the LLM-judge in PAN's benchmark suites.
Reads a prompt-response pair and grades it pass/fail.
**Volume:** spikes during benchmark runs only.
**Current routing:** uses `getJudgeModel()` — read from settings.

### `dashboard` — privacy middleware caller
**File:** `src/routes/guardian.js`, `src/routes/privacy.js`
**What it does:** Marks the caller for the privacy middleware so the
right anonymisation rules apply.

### `setup-check` — one-shot LLM health probe
**File:** `src/server.js` (line 509)
**What it does:** On boot, sends a single "Say 'ok' and nothing else."
to verify the LLM backend is reachable.
**Volume:** 1 per boot.

---

## Local-only callers (don't burn Cerebras quota at all)

These hit Ollama on minipc via Tailscale. Free, unmetered.

### `screen-watcher` — screen-content vision (every 120s)
**File:** `src/screen-watcher.js` (line 278)
**What it does:** Takes a screenshot, runs it through a local vision
model, produces a short sentence describing what's on screen. Feeds
intuition's situation block ("the user is debugging dashboard routing").
**Model:** `minicpm-v:latest` (5.2GB), ~78-106s per call on CPU.
**Why local:** Vision is high-volume (~80/day) and minicpm-v is
purpose-built. Cloud vision would cost real money.

### `dashboard-vision-verifier` — dashboard sanity check
**File:** `src/dashboard-vision-verifier.js` (line 161)
**What it does:** Takes a dashboard screenshot, asks "does this look
normal or is it stuck/black/error?". Drives the dashboard-watchdog
auto-recovery loop.
**Model:** `minicpm-v:latest`.
**Volume:** ~25/day.

### `webcam-watcher` — presence + identity (every 30s)
**File:** invoked indirectly via `vision` caller path.
**What it does:** Reads the webcam frame, runs face-id (now in
worker thread per task #59) + a vision description ("Tereseus at
their desk, focused").
**Models:** `face-api.js` for identity + `minicpm-v` for description.

### `vision` — generic image-analysis API
**File:** `src/routes/api.js` (line 480)
**What it does:** Endpoint for any caller (incl. phone) that wants
"describe this image" without going through a specific watcher.
**Model:** local `minicpm-v`.

---

## How to use the LLM Routing widget

Open the right column → Usage dropdown. The new "PAN LLM Routing"
section shows:

1. **Cloud vs Local split** — calls/day each. Local is free, cloud
   counts against Cerebras quota.
2. **Cerebras Free Tier Caps** — % bars for daily tokens (1M/day cap)
   and daily requests (2,400/day cap). Color: green <50%, yellow 50-80%,
   red >80%.
3. **Top Callers** — per-caller 7d totals + the model each caller will
   hit on its NEXT call (decoupled from historical mix).

When the bars go red, the lever is usually Scout — it's the biggest
single token burner. The next move is either:
- Pay Cerebras (~$10/mo unlocks 1k RPM + 2B tok/day per model)
- Get a Groq key (free, fast — wires in as cloud fallback)
- Move Scout to local qwen3:4b (loses some reasoning quality)

---

## Adding a new caller

1. Pick a unique caller name (kebab-case).
2. Pass it as `caller: 'your-name'` in the `claude()` / `askAI()` /
   `askAIWithFallback()` call.
3. (Optional) Add an override in `settings.job_models` if this caller
   needs a non-default model. Otherwise it gets `ai_model`.
4. Add an entry in this doc with: what it does, prompt size, latency
   target, and current routing.
5. The Usage widget picks it up automatically on the next refresh.
