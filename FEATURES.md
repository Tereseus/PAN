# PAN Features Registry

**This file is the single source of truth for what every PAN button, widget, and
endpoint does.** If you're Claude and you're about to guess what a UI element
does, STOP. Look here first. If it's not here, add it here before answering.

Rules:
- One entry per feature. Headings describe location in the UI.
- Each entry must state: **Calls**, **Semantics**, **Preserves**, **Replaces**, **Pre-gate** (if any).
- When a feature changes, update this file in the same commit.

---

## Lifeboat widget (dashboard sidebar)

- **Purpose:** Blue/green swap of the **Craft** process only.
- **Calls:** `POST /api/carrier/swap`
- **Semantics:** Spawns a new Craft on the next port (17700+), health-probes it,
  flips the proxy to point at the new Craft, keeps the old one alive for a
  30-second rollback window. Auto-rolls back if any `SWAP_GATE` probe in
  `service/src/perf/stages.js` fails during that window.
- **Preserves:** Carrier process, PTY sessions, WebSocket, Claude CLI children,
  reconnect tokens, Steward, orphan reaper, device heartbeat.
- **Replaces:** The `server.js` process (and everything inside it — routes,
  DB handlers, MCP server, dashboard routes).
- **Pre-gate:** New Craft must answer `/health` AND `perfEngine.isSwapSafe()`
  must be true before commit. Otherwise carrier runs `performRollback()`.
- **UI state:** `lifeboatSwapping`, `lifeboatSwapStarted`, rollback countdown.

---

## Settings → Restart PAN

- **Purpose:** Full restart of the **Carrier** process (and everything with it).
  Use this when you changed `carrier.js`, `stages.js`, `probes.js`, or
  `engine.js` — a Craft swap cannot pick up those changes.
- **Calls:** `POST /api/carrier/restart`
- **Semantics:** Carrier broadcasts `carrier_restarting` on WS to all clients,
  flushes PTY reconnect tokens to DB, then `process.exit(1)`. `pan-loop.bat`
  sees non-zero exit and respawns `node carrier.js`. New carrier reads current
  disk code and re-attaches PTYs via their stored reconnect tokens.
- **Preserves:** PTY sessions (via reconnect tokens), DB, Claude CLI children
  that were spawned by the PTY (if the token-reattach succeeds).
- **Replaces:** Carrier process, stages/probes/engine, the Craft child
  (carrier respawns a fresh Craft on startup).
- **Pre-gate:** `perfEngine.system_ready` must be true (don't kill a healthy
  carrier while something else is already broken). Returns 409 with reason
  if unsafe.
- **Client behavior:** On `carrier_restarting` WS event, show a banner
  "Restarting PAN… reconnecting in ~3s", close WS, retry connect every 500ms
  until the new carrier answers, then reattach PTY via `reconnect_token`.
- **Label in UI:** "Restart PAN" (was previously "Reload Server (Craft Swap)"
  which misleadingly duplicated Lifeboat).

---

## Dashboard sidebar → Instances → Dev Restart

- **Purpose:** Restart the **dev instance** on port 7781 only. Prod (7777) is
  untouched.
- **Calls:** `POST /api/v1/dev/restart`
- **Semantics:** Kills any process holding 7781, spawns
  `node service/dev-server.js` with `PAN_DEV=1`, polls `/health` until healthy,
  returns.
- **Preserves:** Prod carrier, prod craft, everything on 7777.
- **Replaces:** Only the dev node process on 7781.
- **Pre-gate:** None.

---

## Perf panel (left or right sidebar → Perf)

- **Purpose:** Live readiness dashboard — what's ready, what's failing, critical
  path, swap-safety.
- **Reads:** `GET /api/v1/perf/trace` every 5s (polled).
- **Writes:** `POST /api/v1/perf/probe/:id` on ↻ click, `POST /api/v1/perf/event`
  for client-side hot-path timings.
- **Views:** List (stages grouped by phase) and Gantt (bars on shared timeline).
  View preference persists in `localStorage.pan_perf_view`.
- **Registry:** `service/src/perf/stages.js` is the single source of truth for
  stages, budgets, and the DAG. The math spec is auto-generated via
  `GET /api/v1/perf/trace?format=markdown`.
- **Client mirror:** `_loadTimings` (page load) and `_sendTimings` (last message
  round-trip) also shown; these are per-page, not polled.

---

## Terminal tab → + button (new tab)

- **Purpose:** Spawn a new PTY + new `claude -p` session.
- **Calls:** WS `create_session` message, spawns `claude -p --project <dir> --model <model>` in a fresh PTY.
- **Semantics:** Each tab is an independent PTY + Claude CLI child. Closing the
  tab kills that Claude process only.
- **Model selector:** Changing the dropdown sets default model for **new tabs**.
  Does NOT affect the currently-running Claude in the active tab (the process
  is already launched with a fixed `--model`).

---

## Phone dashboard (WebView)

- **Purpose:** Phone-sized mirror of the desktop dashboard.
- **Source:** `service/public/mobile/index.html` (static HTML, no build step).
- **Send:** `POST /api/v1/terminal/pipe` with session ID from
  `/api/v1/terminal/sessions`.
- **Receive:** Polls `/api/v1/terminal/messages/<session_id>` every 3s.
- **Cache:** WebView nukes cache on every load (`LOAD_NO_CACHE` + timestamp
  bust).

---

## Steward (server-side)

- **Purpose:** Health-check every configured service every 60s, auto-restart
  on failure.
- **Only runs in prod mode** (not dev — dev skips system-wide singletons).
- **Not user-facing.** Visible indirectly via Perf panel "Processes" section.

---

---

## Beta Pipeline (AutoDev self-improvement loop)

**The concept:** PAN tests itself, finds what's failing, generates fixes, and
proves they work — all without human intervention. The Craft swap system is the
mechanism. Benchmark suites are the gate. Scout finds better models. AutoDev
writes the code. The pipeline decides what ships.

```
Scout finds better model / AutoDev generates fix
           ↓
  New Craft spawned in beta slot
           ↓
  Benchmark suite runs against beta slot
           ↓
  Score meets threshold? → Promote to production (swap)
  Score fails?           → Kill, pull next candidate
           ↓
  Rollback window: 30s to catch post-promotion failures
```

### Craft Slots

The Carrier manages N Craft slots simultaneously:

| Slot | Port | Role |
|------|------|------|
| `production` | 17700 | Live traffic — what users hit |
| `beta` | 17701 | Benchmark traffic only — being evaluated |
| `pending[]` | 17702, 17703... | Queued candidates — already spawned, waiting their turn |

- **Calls:** `POST /api/carrier/pipeline/start` — kicks off the pipeline for a candidate
- **Calls:** `POST /api/carrier/pipeline/promote` — manually promote beta → production
- **Calls:** `POST /api/carrier/pipeline/abort` — kill beta + all pending, return to idle
- **Reads:** `GET /api/carrier/pipeline/status` — current slot states + benchmark scores
- **Semantics:** Beta slot receives no real user traffic. The benchmark runner hits it
  directly on port 17701. If it passes all required suites, Carrier atomically swaps
  beta into the production slot. The old production goes into a 30s rollback window.
- **Preserves:** Production Craft is never killed until the beta has passed all gates.
  PTY sessions, WebSocket, Claude CLI children all survive on Carrier.
- **Pre-gate for promotion:** All required benchmark suites must score above threshold
  (see AutoDev Test Suites below). Any suite below threshold = automatic abort.
- **Parallel candidates:** While beta is being evaluated, the next candidate can be
  spawning and warming up in a pending slot. If beta fails, pending[0] immediately
  moves to beta and benchmark starts. No idle time between tests.
- **Front-end:** No page refresh needed. Carrier pushes `pipeline_event` over existing
  WebSocket. Dashboard Beta Pipeline panel updates in real-time via WS events.

### Beta Pipeline Panel (dashboard sidebar)

- **Purpose:** Visualize the pipeline state in real-time.
- **Shows:** Each slot (production / beta / pending[]) with port, status, benchmark scores.
- **Live updates:** `pipeline_event` WS messages — no polling.
- **Controls:** Manual promote button, abort button, "run benchmark now" button.
- **Score display:** Each benchmark suite shows as a colored bar (green/yellow/red)
  with score and threshold. Failing suites highlighted.

### Who feeds the pipeline

| Source | What it contributes |
|--------|-------------------|
| **Scout** | Finds better models when Intuition Test scores drop. Submits candidate as model config change. |
| **AutoDev** | Generates code fixes when benchmark suites flag regressions. Submits candidate as code diff. |
| **Manual** | Developer submits a Craft candidate via `/api/carrier/pipeline/start` for any reason. |

All three produce the same artifact: a new Craft candidate. The pipeline doesn't care
where it came from — it just runs the suites and decides.

---

## AutoDev Test Suites (benchmark-gated quality system)

Each suite tests one PAN service against known inputs and expected outputs.
A suite must pass before any Craft candidate can be promoted to production.
AutoDev runs these automatically. Results stored in `ai_benchmark` DB table.

**Trigger:** `POST /api/v1/ai/benchmark` `{ "model": "cerebras:qwen-3-235b", "suite": "intuition" }`
**Run all:** `POST /api/v1/ai/benchmark` `{ "suite": "all", "port": 17701 }` (targets beta slot)

### 🔊 Intuition Test
Tests the voice router — PAN's primary interface. Uses the 7-score vocabulary
(Hearing, Reflex, Clarity, Reasoning, Memory, Voice, Form) defined in `docs/AI-MODEL-SELECTION.md`.

| Sub-test | Inputs | Measures | Floor |
|----------|--------|---------|-------|
| Hearing | 10 garbled STT phrases | Correct intent extraction rate | 8/10 |
| Reflex | 10 calls at real prompt size (~2K tokens) | P50 + P95 TTFT | Grade B (<400ms) |
| Clarity | 20 router prompts | Valid JSON + correct schema rate | 9/10 |
| Reasoning | 10 ambient-detection prompts | Correct `{"intent":"ambient"}` rate | 9/10 |
| Memory | 5-turn conversation, final turn refs turn 1 | Correct reference rate | 8/10 |
| Voice | 5-turn personality conversation | Character consistency score | 8/10 |

All sub-tests must pass their floor. One failure = suite fails = Craft not promoted.

### 🌙 Dream Test
Tests the Dream cycle output quality after feeding it 20 synthetic events.
- **Measures:** Coherence (does the output make sense?), novelty (did it find patterns?),
  accuracy (did it preserve facts correctly?)
- **Floor:** 8/10 composite score

### 🧠 Memory Test
Tell PAN 10 facts via API → wait → query each fact → score recall.
- **Measures:** Recall accuracy %, semantic relevance %, context drift %
- **Floor:** 90% recall, <10% drift

### 🔭 Scout Test
Give Scout 5 known questions with verified answers → score output.
- **Measures:** Factual accuracy %, source citation rate, synthesis quality
- **Floor:** 85% accuracy

### 👁️ Augur Test
Feed 30 labeled events → verify Augur's classification matches labels.
- **Measures:** Classification accuracy %, false positive rate
- **Floor:** 90% accuracy, <5% false positive

### 🎤 Identity Test
Play 10 voice samples (7 known speaker, 3 unknown) → score hits vs misses.
- **Measures:** Speaker identification accuracy %, false positive % (wrong person identified)
- **Floor:** 90% accuracy, <5% false positive

### 🌡️ Sensor Test
Set specific GPS/time/temperature values via API → ask 5 sensor-dependent questions
→ verify responses use the data.
- **Measures:** Sensor data usage rate
- **Floor:** 90% usage rate (model must reference provided sensor data)

### ⚡ Pipeline Test
End-to-end voice latency: STT input → router → response → TTS start.
Measured as total wall-clock time, with per-stage breakdown.
- **Floor:** P50 under 800ms total (STT ~200ms + router ~400ms + TTS start ~200ms)

### 🔗 Orchestration Test
5 multi-step tasks requiring 2+ services in sequence → verify correct ordering + result.
- **Floor:** 80% full success rate

### 🧬 Evolution Test
Score memory relevance before → run Evolution → score after. Must improve.
- **Measures:** Relevance delta, decay accuracy (old/wrong facts removed)
- **Floor:** Positive relevance delta, >80% decay accuracy

### 🔒 Privacy Test
Write data in incognito scope → query from main scope → verify zero leakage.
- **Floor:** Hard pass/fail. Any leak = immediate pipeline abort. Cannot be overridden.

### 🔄 Context Test
Fresh session start → ask about 5 things from previous sessions → score relevance
of injected context.
- **Floor:** 80% relevance, 80% coverage of asked topics

### Benchmark Schedule (when no pipeline is active)

| Suite | Runs | Why |
|-------|------|-----|
| Intuition | Daily, 3am | Primary interface — always monitored |
| Memory + Context | Weekly, Sunday 3am | Memory quality drifts slowly |
| Privacy | Every deploy | Hard gate — must never regress |
| All others | Weekly | Background services, lower churn |

Results visible in dashboard → Services panel → AI Models section.
Each model shows: last benchmark date, suite scores, pass/fail per suite.
A model with no benchmark results cannot be assigned to the voice router.

---

---

## The Self-Evaluating AI Pipeline — A Reusable Pattern

**What PAN built is not just a feature. It is a pattern any AI application can adopt.**

The benchmark-driven self-improvement loop works for any system that:
1. Receives a signal (voice, sensor, text, image, data feed)
2. Processes it through an AI model
3. Produces a structured output (JSON, action, classification, response)
4. Cares about quality over time

### The Pattern

```
Define what "good" looks like for your application
    ↓
Express that as 5-7 measurable axes (your sensory vocabulary)
    ↓
Write test cases with known inputs and expected outputs
    ↓
Run the benchmark on a schedule → results stored in DB → visible in dashboard
    ↓
Any axis below floor → Scout wakes up with specific failure context
    ↓
Scout finds better models / approaches → AutoDev implements candidates
    ↓
Beta Pipeline tests candidates against the same benchmark
    ↓
Pass → promote to production. Fail → try next. Loop runs forever.
```

### The Sensory Vocabulary — Domain-Agnostic

PAN defined 7 axes for voice routing. Any application defines their own:

| Domain | Their "Hearing" | Their "Clarity" | Their "Reflex" |
|--------|----------------|----------------|---------------|
| Voice AI (PAN) | Garbled STT tolerance | JSON schema reliability | TTFT <400ms |
| Trading bot | Parses noisy market signals | Produces valid trade orders | Execution latency |
| Medical AI | Understands clinical abbreviations | Structured diagnosis output | Time to decision |
| Home automation | Commands in noisy environments | Valid device instruction format | Actuation delay |

The names change. The pattern is always: **receive signal → understand it → produce clean output → fast enough to matter.**

### Why This Is a Selling Point

Most AI apps degrade silently. A model updates, an API changes, a new noise pattern
emerges — and no one notices until users complain.

PAN notices at 3am and fixes it before anyone wakes up.

That's not just a feature — it's what makes an AI application trustworthy over time.
Other developers building on PAN's infrastructure get this loop for free. Define
your benchmark suites, point them at your Craft, and the same self-improvement
pipeline runs for your application automatically.

---

_Add new features at the bottom when you build them. Update this file in the
same commit as the code change._
