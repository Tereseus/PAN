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

## Terminal input bar → Call ΠΑΝ button (phone-handset icon, between mic and model picker)

- **Purpose:** Open a live conversation with ΠΑΝ in a floating Tauri window. The
  conversation surface reuses the existing Comms thread view, focused on the
  ΠΑΝ system thread (`thread-pan-system`).
- **Calls:** `openPanCall()` in `terminal/+page.svelte` → POSTs to local Tauri
  server (`http://127.0.0.1:${TAURI_PORT}/open`) with URL
  `/v2/comms?view=contacts&thread=thread-pan-system&call=1`. Falls back to
  `window.open()` if Tauri isn't running.
- **Semantics:** Single conversational surface. Same thread renders:
  user-typed/voice-in messages, PAN reactive replies, PAN proactive interjections
  (via `pan-notify.js`), and PAN intuition traces (`body_type='pan_intuition_trace'`,
  collapsible like Claude tool-call rendering).
- **Preserves:** ΠΑΝ thread continuity (single hardcoded thread ID across sessions,
  webcam/screen presence, dream cycles). Call log in `chat_calls` table.
- **Replaces:** N/A — additive. Was previously only reachable via Comms tab.
- **Pre-gate:** None on click. Voice loop (when wired) will respect PAN's quiet
  mode (#764) and TTS throttle (#763).
- **Style:** Round 36px button, green hover (`#a6e3a1`) to distinguish from
  mic (red/listening) and send (blue).

---

## Comms thread → Call mode (`?call=1` URL param)

- **Purpose:** Surface an in-progress voice conversation with the active contact.
- **Calls:** `startCall()` posts to `POST /api/v1/chat/threads/:id/calls`
  (creates `chat_calls` row, status='ringing'). `endCall()` posts to
  `POST /api/v1/chat/calls/:id/end` with `duration_ms`.
- **Semantics:** v1 = visible call banner with elapsed timer + End button.
  Phone icon in detail header starts a call manually. Voice loop (STT → router →
  TTS via `/api/v1/speak`) wires in a follow-up commit once F5-TTS endpoint lands.
- **Preserves:** Call history in `chat_calls`. Existing chat send flow continues
  to work alongside an active call.
- **Pre-gate:** None for ΠΑΝ thread. PAN↔PAN federated calls (future) go through
  `trust-ladder.js` evaluation.

---

## Comms thread → Intuition trace rendering (`body_type='pan_intuition_trace'`)

- **Purpose:** Show PAN's reasoning inline in the conversation, the same way
  Claude exposes tool-call traces.
- **Renders as:** `<details>` element with `🧠 PAN intuition · <time>` summary;
  click to expand the body (monospace, scrollable, dashed border).
- **Source:** Any service writing to `chat_messages` with
  `body_type='pan_intuition_trace'` (intuition engine, router, dream cycle).
- **Pre-gate:** None — collapsed by default so it doesn't dominate the thread.

---

## Trust ladder (`service/src/trust-ladder.js`)

- **Purpose:** Gate PAN↔PAN federated communication. Composes three axes
  (org relationship × sender power_lvl × scope sensitivity) into one of:
  `auto` | `approve-once` | `approve-always` | `deny`.
- **Inputs:** `{ senderUserId, senderOrgId, recipientOrgId, scopeTag, threadAllowlist }`.
- **Org relationship:**
  - `same` — sender and recipient share an org_id.
  - `partner` — active (non-revoked) row in `org_shares` between them.
  - `stranger` — no relationship.
- **Sensitive scopes** (default): `health, finance, family, location-precise,
  private-notes, credentials`. Override via `settings.scope_sensitivity` JSON.
- **Ladder:**
  - Stranger + sensitive scope → **deny** (hard block).
  - Per-thread `denied` list → **deny**.
  - Per-thread `allowed` list (when non-empty) excludes scope → **approve-always**.
  - Sensitive + same org + power ≥ 75 → **auto**; else **approve-always**.
  - Non-sensitive: same → **auto**, partner → **approve-once**, stranger → **approve-always**.
- **Pure module:** No side effects. Caller (chat.js send path) is responsible
  for writing the decision to `audit_log` via `middleware/org-context.js#auditLog`.
- **Schema:**
  - `chat_threads.org_id TEXT` — which org owns this thread (nullable for
    backward compat).
  - `chat_threads.scope_allowlist TEXT` — JSON `{ allowed: [...], denied: [...] }`
    per-thread allowlist. `null` = unrestricted (your own PAN, no gate).

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

---

## Identity System (Spec — not yet built)

### Philosophy
PAN identifies people through accumulated multi-modal evidence — never by
comparing against external face databases. All identity data lives in PAN's
own DB. The system builds confidence over time, not from a single image.

### PAN's Mind — first-person thought stream (dashboard Intuition section)

**What it is**: A live, persisted, first-person reasoning trace — modeled on
Claude's extended-thinking blocks. Every reasoning event in PAN writes ONE
short sentence describing what it just concluded:

- **🧠 intuition** — after each classifier run: *"Commander is focused on Svelte, mood normal. Holding back — no nudge needed."*
- **👁 screen** — after each vision capture: *"I see a Svelte dashboard with a sunset terminal background and the intuition panel open."*
- **💬 router** — after each user utterance: *"Commander said 'fix the intuition panel' — I'm answering."*
- **🔭 scout** — after each finding (TBD)
- **🗯 interjection** — when deliberating whether to interrupt (TBD)
- **💤 dream** — at each consolidation cycle (TBD)

**Storage**: `pan_thoughts(id, ts, source, thought, refs_json, importance)`.
Capped at 240 chars per row. Producers call `writeThought(source, text, refs, importance)`
from `service/src/thoughts.js`. The dashboard renders newest-first; PAN itself
reads the stream back via the `pan_thoughts` MCP tool to answer questions like
"what was I just doing 10 minutes ago?".

**Replaces**: The old "What PAN's mind is busy with" feed, which showed raw
`ai_usage` rows (caller + static system prompt). That feed was useless because
the system prompt for `intuition-classifier` is identical every call — the
interesting bit is the *verdict*, which is now what gets surfaced here.

**Pre-gate**: Verdict producers (intuition.js, screen-watcher.js, router.js)
must call `writeThought` AFTER they've parsed/validated the model output —
never log the raw prompt as a thought. Dedupe with `recentThoughtMatches()` so
a static screen doesn't fill the panel with the same description every minute.

**Endpoints**:
- `GET /api/v1/thoughts/recent?limit=20&source=intuition&since_ms=3600000` → newest-first thoughts
- `POST /api/v1/thoughts {source, thought, refs?, importance?}` → write one (used by MCP)

**MCP tool**: `pan_thoughts {limit?, source?, since_ms?, write?}` — read or write.

---

### Life Needs — Sims-style motive bars (dashboard Intuition section)

**What it is**: 13 per-user "motive" bars (0..100) sitting between state and
mind in the Intuition panel. Modeled on The Sims' needs system: each Need
decays linearly over time and is reset/raised by real-world events.

The 13 needs (default decay rate, points/hour):
- **Body**: 🍽 Nourishment (15) · 💧 Hydration (25) · 😴 Rest (6) · 🏃 Body movement (4)
- **Mind**: 🧘 Mental health (3) · 👥 Social (5) · 💞 Connection (3) · 🎯 Focus (8) · 🎮 Fun (5) · 🔭 Curiosity (4)
- **World**: 🪴 Environment (3) · 🗂 Admin (4) · 🛡 Safety (2)

**Storage**:
- `pan_needs(user_id, need_id, level, weight, decay_rate, last_satisfied_at, last_evaluated_at)`
  — one row per (user, need). UNIQUE constraint.
- `pan_need_events(ts, user_id, need_id, kind, delta, level_after, source, refs_json, note)`
  — append-only audit log. `kind` ∈ {satisfy, observe, decay_tick, manual}.

**Decay model**: Levels are recomputed on read (`evaluate()` in
`service/src/intuition/needs.js`):
`level = max(0, stored.level - decay_rate × hours_since_last_evaluated)`.
No background timer — pure lazy recompute. `evaluate()` persists the decayed
value back so dashboard reads are O(1) and consistent.

**Producers (Nourishment wired first)**:
- **screen-watcher** — keyword-scan the vision-AI description; food/drink terms
  fire `observe('nourishment', +12)`. Weak signal (food on screen ≠ user
  eating). Drink-only sightings give +6.
- **router** — regex-scan every user utterance for meal mentions
  ("just ate lunch", "had a snack", "eating a sandwich") → `satisfy()`.
  Hunger mentions ("I'm hungry", "starving") write a high-importance Mind
  thought so the scorer surfaces Nourishment next tick.
- **Manual** — dashboard slider override → `manualSet()`.

**Per-user weight (0..2)**: How much *this person* cares about each need.
Default 1.0. Adjusted by the learning loop: dismissing a "you should eat" nudge
3× lowers Nourishment weight; thanking PAN for it raises it. Urgency in the
scorer = `(100 - level) / 100 × weight`.

**Identity**: Currently resolved via face-id lock from webcam-watcher (falls
back to `'owner'` for single-user). Will be replaced by identity-fusion cluster
once `intuition/identity.js` lands.

**Endpoints**:
- `GET /api/v1/needs?user=owner` → all needs, sorted by urgency desc
- `GET /api/v1/needs/definitions` → static metadata (icons, labels, defaults)
- `GET /api/v1/needs/events?user=owner&need=nourishment&limit=20` → audit log
- `POST /api/v1/needs/satisfy {user?, need, delta?, toLevel?, source?, note?}` → bump up
- `POST /api/v1/needs/set {user?, need, level, note?}` → manual override
- `POST /api/v1/needs/weight {user?, need, delta}` → learning loop adjustment

**Dashboard widget**: Compact horizontal bars in the Intuition panel, sorted
by urgency (most pressing motive on top). Bar color: green ≥70, yellow 30-69,
red <30. Tooltip shows weight, decay rate, hours-since-satisfied.

**Pre-gate**: Producers must not satisfy needs from inferred state alone — a
food image on screen is `observe()` (capped delta), only an explicit "I ate"
utterance is `satisfy()`. This keeps the bar honest.

---

### Identity Panel (dashboard Intuition section)
The current split between "Identity" and "Voice Identity" is wrong. There is
one concept: **Identity**. Voice is one signal among many. The panel should
show a single unified identity block per detected person with confidence score.

---

### Visual Identity Schema
Every time the webcam watcher captures a frame containing a face, minicpm-v
fills in the following structured fields (not prose). These get stored as an
`identity_observation` event in the DB:

```json
{
  "hair_length":   "shaved|very_short|short|medium|long|unclear",
  "hair_color":    "black|brown|blonde|red|gray|white|dyed|unclear",
  "hair_type":     "straight|wavy|curly|coily|unclear",
  "skin_tone":     "very_light|light|medium|olive|dark|very_dark|unclear",
  "facial_hair":   "none|stubble|beard|mustache|unclear",
  "age_range":     "child|teen|20s|30s|40s|50s|60s+|unclear",
  "eye_color":     "brown|blue|green|hazel|gray|unclear",
  "lip_fullness":  "thin|medium|full|unclear",
  "nose_bridge":   "narrow|medium|wide|bumped|straight|unclear",
  "forehead":      "small|medium|large|unclear",
  "build":         "slim|medium|heavyset|unclear",
  "distinctive":   ["glasses","beard","tattoo_visible","headwear","earrings"]
}
```

**Matching:** When a new observation arrives, compare field-by-field against
all existing identity clusters. Count matching fields / total non-unclear
fields = similarity score. Score ≥ 0.75 → same cluster. New cluster created
below 0.5. 0.5–0.75 → ambiguous, accumulate more observations.

**Rolling window:** Only observations from the last 6 months are used for
matching. Older data is archived, not deleted — if someone is gone for a year
and returns, the archived schema can be re-activated with enough new evidence.

---

### Voice Identity Schema
Every utterance transcribed from a known session contributes:
- Fundamental frequency range (pitch)
- Speech cadence / pace
- Vocabulary fingerprint (common words, phrasing patterns)
- Language and accent markers

Voice is stored per identity cluster, not separately.

---

### Context Identity (transcript inference)
When a transcript contains a name or relationship word spoken **toward** someone
visible in a contemporaneous webcam frame:
- "Hey mom" → label the currently-visible cluster as "Mom" (if unlabeled)
- "Tereseus come here" → attempt to match "Tereseus" cluster to the visible person
- Confidence weighted by how directly the utterance is addressed

This is the primary way unknown clusters get labeled. No manual tagging required
in normal use.

---

### Setup Flow (family / multi-person onboarding)
On first run or via Settings → Identity Setup:
1. Each person sits in front of the camera and says their name aloud
2. System captures 5 frames + voice sample, creates a labeled anchor cluster
3. Future observations auto-merge into the nearest cluster above threshold
4. Reference photos from a designated folder (e.g. `~/me/`) are ingested as
   additional observations to bootstrap the commander's cluster at install time

---

### Anti-Spoofing
No single modality is authoritative. Identity confidence requires agreement
across ≥2 of: visual schema, voice profile, behavioral context. A face alone
or a voice alone is insufficient for high-trust identity assertion. The system
reports confidence level, not binary identity, everywhere it's displayed.

---

### Child Detection
A cluster tagged as "child" (age_range = child|teen) + appearing on a device
session → session gets a `child_present` flag. This can gate content, commands,
or permissions. Determined by visual schema alone (voice is secondary since
children can have adult-sounding voices and vice versa).

---

### Storage
- `identity_clusters` table: one row per person, stores current schema fields,
  confidence scores, label (if known), anchor image reference, last seen ts
- `identity_observations` table: one row per webcam capture, FK to cluster,
  raw schema fields, frame timestamp — used for cluster refinement
- `identity_voice_samples` table: FK to cluster, audio feature vector

---

## Dashboard Watchdog (dashboard-watchdog.js) — BUILT

- **Purpose:** Detect a stuck/black loading screen and auto-recover without
  user intervention. Target: user back in dashboard within 20 seconds.
- **File:** `service/src/dashboard-watchdog.js`
- **Detection:** Polls a Tauri screenshot every 10s. Computes average pixel
  brightness of the frame. If brightness < 20 (near-black) for 2 consecutive
  frames → classified as stuck.
- **Recovery (in order):**
  1. `POST /api/carrier/swap` — replaces Craft, re-serves the page
  2. If swap doesn't resolve within 15s: `force_reload` WS message to Tauri
  3. If still stuck: logs incident, alerts via PAN Notify
- **Why brightness, not vision model:** Check is instant (<5ms). No LLM needed
  for a binary loaded/stuck decision.
- **Timing:**
  - T+0: disconnect/stuck suspected
  - T+10/T+20: brightness samples taken
  - T+20: recovery action executes
  - T+30: user back in dashboard
- **Screenshot source:** `service/src/screen-watcher.js` `captureViaTauri()`

---

---

## Super-Carrier Layer

- **Purpose:** Permanent outer process that owns port 7777 forever. Carrier and
  Craft can restart without browsers seeing a disconnect.
- **File:** `service/src/super-carrier.js`
- **Port:** 7777 (public). Proxies to Carrier on 17760.
- **WebSocket buffering:** Holds up to 200 WS frames in memory during Carrier
  restarts. Browser connection stays open; frames replay when Carrier comes back.
- **Spawns:** Carrier via `fork()`. Auto-respawns on non-zero exit.
- **See:** `docs/SUPER-CARRIER.md` for full architecture.

---

## Multi-Device Routing

- **Purpose:** Route actions (play movie, open app, run command) to the correct
  device automatically based on user preferences, device capabilities, and aliases.
- **Entry point:** `POST /api/v1/query` — phone/client sends voice query
- **Action envelope:** Response includes `actions[]` array with `device_id`, `app`,
  `type`, `args` for each action to execute
- **Preference store:** `action_preferences` table — user → org fallback chain.
  Confidence grows with use. `POST /api/v1/preferences` to set.
- **Device aliases:** `device_aliases` table — maps "projector" → hostname.
  `POST /api/v1/preferences/aliases` to manage.
- **Capabilities:** Each device reports its capabilities (apps, platform, features)
  on registration. Stored in `devices.capabilities` JSON array.
- **Active devices:** `GET /api/v1/devices/active` — devices seen in last 5 min
- **See:** `docs/MULTI-DEVICE-ROUTING.md` for full routing flow.

---

## Installer — Smart Device Naming

- **Purpose:** When a client device installs PAN, name it from hardware model
  instead of raw hostname (e.g. "Dell G16-work-pc" not just "work-pc").
- **Windows:** `wmic computersystem get model` → prepended to hostname
- **macOS:** `system_profiler SPHardwareDataType` Model Name field
- **Linux:** `/sys/devices/virtual/dmi/id/product_name`
- **Fallback:** Raw hostname if model detection fails or returns generic string
- **Where:** `pan-installer.cjs` (browser-based installer) and
  `generateWindowsClientInstaller()` in `server.js` (PowerShell installer)

---

## Webcam Watcher

- **Purpose:** Continuous presence detection via the PC webcam. Primary signal
  for "who is at the desk" in the identity system.
- **File:** `service/src/webcam-watcher.js`
- **Polling:** Every 30s (unlocked) or every 5 min (identity locked)
- **Burst mode:** Up to 3 frames per cycle; stops on first face detection
- **Debounce:** Needs 2 consecutive misses before flipping to "desk empty"
- **Idle gate:** If keyboard/mouse active in last 2 min, stays locked even if
  camera misses a face (prevents false "desk empty" from momentary occlusion)
- **Auto-enroll:** High-confidence frames (≥80%) are added to descriptor pool
  (max 20 per identity cluster)
- **DB:** Stores `webcam_context` events with presence, identity, confidence, emotion
- **Status endpoint:** `GET /api/v1/webcam-watcher/status`

---

## Screen Watcher

- **Purpose:** Vision AI analysis of what's on screen every 60s. Used by
  intuition.js as the #1 activity signal (overrides webcam context).
- **File:** `service/src/screen-watcher.js`
- **Capture:** FFmpeg gdigrab (Windows) or Tauri shell (port 7790 if available)
- **Analysis:** Resizes to 640px wide JPEG → minicpm-v → stores `screen_context` event
- **Idle skip:** After 3 min inactivity, stops capturing
- **Stale timeout:** Context older than 120s is ignored by intuition.js
- **Burst mode:** `startBurst(durationMs, burstMs)` — rapid captures during Craft
  swap / reload events (default: every 5s for 60s)
- **Status endpoint:** `GET /api/v1/screen-watcher/status`

---

## PAN Notify (Service Messaging)

- **Purpose:** Unified channel for PAN's own services to message the user.
  Scout, Dream, Pipeline, Memory all drop messages into a single ΠΑΝ thread.
- **File:** `service/src/pan-notify.js`
- **API:**
  - `panNotify(service, subject, body, opts)` — post a message from a service
  - `panReply(userMessage)` — user replies in ΠΑΝ thread → Cerebras Qwen responds
  - `ensurePanContact()` — idempotent boot setup (creates ΠΑΝ contact + thread)
- **Severity:** `info` | `warning` | `critical`
- **Storage:** `chat_messages` table with service, severity, metadata fields
- **Service sign-offs:** Scout · 🔍, Dream · ✨, Pipeline · 🔬, Memory · 🧠
- **Where visible:** Comms panel (chat thread from ΠΑΝ contact)

---

## Skill Learner (Auto-Skill Generation)

- **Purpose:** After every Claude session, evaluate if a novel reusable skill
  was demonstrated. If yes, auto-generate a SKILL.md and add it to the
  pan-local plugin marketplace.
- **File:** `service/src/hooks/skill-learner.js`
- **Trigger:** Claude Code Stop hook (runs after every session ends)
- **Flow:**
  1. Reads session transcript from stdin
  2. Calls Cerebras (fast, cheap) to evaluate if session was novel + reusable
  3. If yes (min 4 turns, clear skill demonstrated): generates SKILL.md
  4. Saves to `~/.claude/plugins/local/<skill-name>/`
  5. Updates `marketplace.json` with new skill entry
  6. Logs to PAN server (best-effort)
- **Format:** SKILL.md = YAML frontmatter + Markdown instructions + optional JS
- **Threshold:** Session must have ≥4 turns and demonstrate a reusable capability

---

---

## Web Dashboard — All Pages

The dashboard is a SvelteKit app compiled to `service/public/v2/`. It has
**18 pages** (not 11 — the earlier count was outdated):

| Route | Purpose | Status |
|-------|---------|--------|
| `/v2/terminal` | Main PTY + Claude pipe + sidebar widgets | Built |
| `/v2/atlas` | Radial system map (Atlas V2) | Built |
| `/v2/conversations` | Browse + search past sessions | Built |
| `/v2/sensors` | 22 sensor category toggles | Built |
| `/v2/automation` | Automation / scripting interface | Built |
| `/v2/projects` | Project list + task progress | Built |
| `/v2/settings` | Server config, model selection, keys | Built |
| `/v2/data` | DB browsing + export | Built |
| `/v2/crucible` | Side-by-side shadow traffic comparison | Built |
| `/v2/terminal-dev` | Dev server terminal (port 7781) | Built |
| `/v2/chat` | Chat interface (direct messaging) | Built |
| `/v2/comms` | Communications hub — threads, ΠΑΝ messages | Built |
| `/v2/compose` | Message composition | Built |
| `/v2/call` | Audio/video calling UI | Built |
| `/v2/kanban` | Kanban board view of project tasks | Built |
| `/v2/timeline` | Timeline/history of project work | Built |
| `/v2/kronos` | Time/scheduling/calendar interface | Built |
| `/v2/atlas-v2` | Alias / migration target for Atlas | Built |

Build: `cd service/dashboard && npm run build` → outputs to `service/public/v2/`.
Must rebuild after editing any `.svelte` file.

---

## Atlas V2 (System Visualization)

- **Purpose:** Interactive radial diagram of the entire PAN system — services,
  devices, projects, memory pipeline, intelligence tier, voice pipeline.
- **Route:** `/v2/atlas`
- **File:** `service/dashboard/src/routes/atlas/+page.svelte`
- **Structure:**
  - **Center node:** ΠΑΝ Server (core hub)
  - **Ring 1 (Core):** Database, Dashboard, Steward, Tauri
  - **Ring 2 sectors (8 major systems):**
    - Services: Whisper, Ollama, AHK, Tailscale, Cloudflare Tunnel
    - Memory: Memory Hub, Episodic, Semantic, Procedural, Embeddings, Context Injection
    - Processing: Classifier (Augur), Dream, Consolidation, Evolution
    - Intelligence: Claude Code, Scout, Orchestrator, AutoDev
    - Orgs: Org Engine, Roles/ACL, Data Isolation, Per-Org DBs, Cross-Org Share
    - Presence: Webcam Watcher, Screen Watcher, Activity Tracker, Identity
    - Comms: Chat, Email, PAN Notify, Messaging Prefs
    - Devices: Connected clients (Ring 3)
  - **Ring 3:** Registered devices + active projects (with task progress bars)
  - **Voice pipeline strip:** Phone Mic → Google STT → Voice Router → Cerebras → Android TTS
- **Interactivity:** Click any node → detail panel with status, description,
  connections. 30-second auto-refresh. Live event/session/node counts in topbar.

---

## Activity Tracker

- **Purpose:** Track which app/window is in focus on the desktop PC. Primary
  activity signal for presence and intuition context.
- **File:** `service/src/activity-tracker.js`
- **How:** Polls the active foreground window every 3 seconds using Windows
  Win32 API (via PowerShell `GetForegroundWindow`). Logs focus changes to
  `activity_events` table. Tracks process name + window title + duration.
- **Platform:** Windows only. No-op on other platforms.
- **Data:** `activity_events` table — `process_name`, `window_title`,
  `focused_at`, `duration_ms`
- **Used by:** intuition.js (primary activity context), screen watcher (idle check)
- **Status endpoint:** N/A (data via `GET /dashboard/api/events?type=activity`)

---

## Organization & Multi-Tenancy System

- **Purpose:** Full multi-org isolation. Each org gets its own encrypted DB,
  ACL, roles, and scoped data access. Enables family, team, or enterprise use
  with clean data boundaries.
- **Files:** `service/src/routes/orgs.js`, `service/src/routes/teams.js`
- **Roles / Power Levels:**
  | Role | Power | Can do |
  |------|-------|--------|
  | Owner | 100 | Everything, including impersonation |
  | Admin | 75 | All ops, no impersonation |
  | Manager | 50 | Read/write, manage users |
  | User | 25 | Standard access |
  | Viewer | 0 | Read-only |
  | Guest | 0 | Temporary, scoped |
  | Child | 0–15 | Restricted content + commands |
- **Data isolation:** Every DB query is scoped by `org_id`. Helpers:
  `allScoped()`, `getScoped()`, `runScoped()` in `db.js`.
- **Per-org DBs:** Each org gets a separate SQLCipher-encrypted database file.
  Registry managed by `db-registry.js`.
- **Cross-org sharing:** Controlled share of data between orgs with explicit
  permission grants.
- **Isolation command:** `/isolate` — migrates data into org-scoped tables.
- **API:** `GET/POST /api/v1/orgs`, `GET/POST /api/v1/teams`
- **Visible in Atlas:** "Orgs" sector shows Org Engine, Roles/ACL, Data
  Isolation, Per-Org DBs, Cross-Org Share nodes.

---

## Chat & Messaging System

- **Purpose:** Thread-based messaging between the user, ΠΑΝ, and other contacts.
  Also the channel through which PAN's own services (Scout, Dream, Pipeline)
  message the user.
- **Files:** `service/src/routes/chat.js`, `service/src/chat.js`
- **Schema tables:** `chat_threads`, `chat_messages`, `chat_members`
- **Message types:** `text` | `composed` | `system`
- **Channels:**
  - `pan` — ΠΑΝ system notifications (from pan-notify.js)
  - `dm` — Direct messages between users
- **Dashboard pages:**
  - `/v2/chat` — Chat interface (direct messaging)
  - `/v2/comms` — Communications hub (all threads, ΠΑΝ thread, service messages)
  - `/v2/compose` — Compose and send messages
- **See also:** PAN Notify section (how services post into the ΠΑΛ thread)

---

## Email System

- **Purpose:** Send and receive email from within PAN.
- **File:** `service/src/routes/email.js`
- **Init:** `initEmail()` called on server boot to set up mail transport.
- **Status:** Wired into server, `initEmail()` runs — but send returns HTTP 400
  (no mail service provider configured yet). See task #394.
- **Dashboard page:** `/v2/compose` handles email composition alongside messaging.

---

## Zones & Geofencing

- **Purpose:** Define geographic zones. Actions and permissions can be scoped
  to zones (e.g. "only allow recording at home", "mute when at work").
- **File:** `service/src/routes/zones.js`
- **API:** `getActiveZones()`, `findZonesForPoint(lat, lng)`
- **Used by:** voice router (location-aware commands), privacy enforcement
- **Storage:** `zones` table — name, boundary polygon, rules JSON

---

## Incognito Sessions

- **Purpose:** Temporary isolated sessions that leave no permanent trace.
  Data written in incognito scope is invisible to main scope and purged on expiry.
- **File:** `service/src/routes/incognito.js`
- **API:** `cleanupExpiredIncognito()` — server-side cron to purge expired sessions
- **Pre-gate tested by:** Privacy Test benchmark suite (hard fail on any data leak)

---

## Personal Sync & Replication

- **Purpose:** Sync personal data between PAN instances (e.g. home PC ↔ laptop).
  Replication for backup and cross-device consistency.
- **Files:**
  - `service/src/routes/sync.js` — `startPersonalSync()`, `stopPersonalSync()`
  - `service/src/routes/replication.js` — data replication between sources
- **Status:** Wired into server boot. Configuration via settings.

---

## Kanban, Timeline & Kronos (Project Management Views)

Three additional views on top of the existing Projects page:

### Kanban (`/v2/kanban`)
- **Purpose:** Drag-and-drop kanban board for project tasks.
- **Columns:** backlog → todo → in_progress → in_test → done
- **Data:** Same `project_tasks` table as the Projects page.

### Timeline (`/v2/timeline`)
- **Purpose:** Chronological view of project work — when tasks were created,
  started, and completed. Historical record.

### Kronos (`/v2/kronos`)
- **Purpose:** Time and scheduling interface. Named after the Greek god of time.
- **Integrates with:** Google Calendar (via GWS CLI), PAN task system.

---

## Call (`/v2/call`)

- **Purpose:** Audio/video calling UI within the PAN dashboard.
- **File:** `service/dashboard/src/routes/call/+page.svelte`
- **Status:** UI built. Backend calling infrastructure pending.

---

## MCP Server — Full Tool List

The MCP server (`service/src/mcp-server.js`) exposes tools to Claude Code.

### Core Tools

| Tool | What it does |
|------|-------------|
| `pan_search` | Full-text search across events, memory, conversations |
| `pan_memory` | Read classified memory items (episodic, semantic, procedural) |
| `pan_decide` | Log an architectural decision to the DB with rationale |
| `pan_restart` | Restart the PAN server (Craft swap or Carrier restart) |
| `pan_dev` | Dev server control — status, sessions, start |
| `pan_terminal_send` | Send text to an active PTY terminal session |
| `pan_browser` | Browser control: list_tabs, navigate, click, type, screenshot |
| `pan_guardian` | Security scanning: status, decisions, scan, config |

### Router Tool (`pan`) — All Actions

Single `pan` tool dispatches to 20+ actions:

| Category | Actions |
|----------|---------|
| **Data** | conversations, projects, tasks, services, devices, stats, sessions, sensors, photos, scout |
| **Alerts** | list, count, types, get, acknowledge, resolve, dismiss, reopen |
| **Recording** | start, stop, status, list |
| **Windows** | list, open, focus, close |
| **Settings** | get, set |
| **Logs** | query, summary |
| **Runner** | projects, running, status, start, stop, stop_all, logs |
| **Library** | view |
| **Processes** | list (all PIDs) |
| **Carrier/Crucible** | status, swap, shadow_start, shadow_stop, shadow_promote, shadow_stats, crucible, open_crucible, rollback, confirm, lifeboat |
| **Voice** | profiles, pregenerate, pack |
| **Context** | briefing, inject |

### MCP Resources (pull-based)

| Resource URI | Returns |
|-------------|---------|
| `pan://actions` | Markdown table of all router actions |
| `pan://alert-types` | Alert type definitions |
| `pan://services` | Service status JSON |
| `pan://stats` | Database statistics |

---

## Terminal Sidebar — Widget Panels

The terminal page sidebar has 8 tracked widget panels:

| Panel | Purpose |
|-------|---------|
| **intuition** | Current personality context and active signals |
| **approvals** | User approvals for AutoDev code candidates |
| **alerts** | System alerts (orphan processes, service crashes, etc.) |
| **services** | Service health at a glance |
| **pipeline** | Voice/processing pipeline status |
| **devices** | Connected client devices + activity |
| **transcript** | Session message history |
| **lifeboat** | Craft swap / rollback status |

### Terminal Performance Tracking

The dashboard instruments **9 load stages** for every page load:

| Stage | Measures |
|-------|---------|
| `scriptInit` | JS bundle parsed and running |
| `mounted` | Svelte component mounted |
| `wsOpen` | WebSocket connected |
| `ptyAttached` | PTY session attached |
| `firstScreen` | First terminal screen rendered |
| `firstTranscript` | First message appears in transcript |
| `transcriptWidget` | Transcript widget fully loaded |
| `usageWidget` | Usage/cost widget loaded |
| `interactive` | Full interactive state |

### Send Latency Tracking

Every message send is instrumented with three timestamps:
- **ack** — server acknowledged the send
- **echo** — user's message echoed back in transcript
- **assistant** — first assistant token arrived

Visible in the Perf panel.

### Session Cost Tracking

The terminal tracks per-session token usage:
- Input tokens, output tokens, cache read/write tokens
- Estimated cost (based on model pricing)
- Displayed in the terminal toolbar

_Add new features at the bottom when you build them. Update this file in the
same commit as the code change._

---

## Impersonate Widget (dashboard toolbar)

- **Purpose:** Owner-only tool to temporarily preview the dashboard as a different
  power level, specific user, or org group — for testing permissions, parental controls,
  and child-profile UX without logging out.
- **Gate:** `realPower >= 100` (owner only). Requires power 80+ in future multi-owner setups.
- **Trigger:** "👁 Impersonate…" button in toolbar (only visible to owners).
  While active: yellow banner shows current impersonation label + "✕ Exit" button.

### Three impersonation modes

| Mode | API body | What changes |
|------|----------|-------------|
| **Power Level** | `{ type: 'power', power: 25 }` | Effective `power` drops to N; presets (Child/Guest/User/Manager/Admin) + slider (0–99) |
| **User** | `{ type: 'user', userId: N }` | Uses that user's `power_lvl`; banner shows their name |
| **Group** | `{ type: 'group', orgId: '...', power: N, roleName: '...' }` | Simulates membership in an org at a given role level |

### Endpoints
- `GET /api/v1/impersonate` — current state: `{ active, impersonation, realPower, presets }`
- `POST /api/v1/impersonate` — start (see modes above); 403 if not owner; power must be 0–99
- `DELETE /api/v1/impersonate` — stop; restores real power immediately
- `GET /api/v1/users` — user picker list (owner-only); returns non-owner users for the User tab
- `GET /api/v1/roles` — role list for group picker; falls back to built-in presets if roles table is empty

### Impersonation object shape (in memory + permsMatrix response)
```json
{ "type": "power|user|group", "power": 25, "label": "User",
  "userId": null, "orgId": null, "orgName": null, "roleName": null }
```

### Preserves
- Real `power` and `role` of the owner — stored in `realPower` / `role='owner'`.
- All PTY sessions, tabs, Claude processes — impersonation only affects the HTTP permission layer.
- Clears on Craft restart (in-memory only by design).

### Banner label format
- Power: `👁 User (lvl 25)`
- User: `👤 owner (lvl 15)`
- Group: `🏢 ΠΑΝ → Member (lvl 25)`

---

## Android self-update

PAN's Android app updates itself from the user's own PAN server — no Play Store, no manual sideload after the first install. Designed to be reusable for any future PAN-shipped Android app.

### Server side
- `GET /apk/latest` — serves `android/app/build/outputs/apk/debug/app-debug.apk` (existing).
- `GET /api/v1/apk/version` — JSON metadata read from gradle's `output-metadata.json`. sha256 is computed once and cached by mtime + size:
  ```json
  {
    "applicationId": "dev.pan.app",
    "versionCode": 3,
    "versionName": "0.4.0",
    "apkUrl": "/apk/latest",
    "apkSize": 216202946,
    "sha256": "abcd…",
    "buildTime": "2026-05-10T11:13:50Z"
  }
  ```
  Returns 404 if the APK hasn't been built yet.

### Client side (`UpdateChecker.kt`)
1. On `MainActivity.onCreate`, after an 8-second delay (lets Tailscale come up), call `UpdateChecker.checkAndInstall()`.
2. GET `${baseUrl}/api/v1/apk/version` via the same Hilt `OkHttpClient` everything else uses (Tailscale-aware, falls back to LAN).
3. Bail if `applicationId != BuildConfig.APPLICATION_ID` — never let the server replace this app with a different one.
4. If `versionCode > BuildConfig.VERSION_CODE`:
   - Download to `cacheDir/updates/pan-${versionCode}.apk` (older APKs in that dir are deleted first).
   - Verify size + sha256 against the manifest. Mismatch → delete + abort.
   - Hand to system installer via `FileProvider` + `Intent.ACTION_VIEW` with `application/vnd.android.package-archive`.
5. The system shows "Update this app?" — user taps once, install completes, app data + signing key preserved.

### Permissions
- `REQUEST_INSTALL_PACKAGES` (manifest) — required on Android 8+.
- "Install unknown apps" must be granted once for PAN under Settings → Apps → Special access → Install unknown apps. If not granted, `UpdateChecker` deep-links the user there via `ACTION_MANAGE_UNKNOWN_APP_SOURCES`.

### FileProvider
- Authority: `dev.pan.app.fileprovider` (already declared for camera photos).
- New path entry: `<cache-path name="updates" path="updates/" />` in `res/xml/file_paths.xml`.

### Pre-gate
- APK must exist at `android/app/build/outputs/apk/debug/app-debug.apk` and have a sibling `output-metadata.json`. Both produced by `./gradlew.bat assembleDebug`.

### Replaces
- Manual sideload flow (open browser → `/apk/latest` → find file → tap → install). That path still works — this is additive.

### What it doesn't do
- **Silent install.** Requires device-owner privileges that personal devices don't have. The system "Update this app?" dialog is the unavoidable Android security boundary for sideloaded APKs.
- **Rollback.** Once the user accepts the new APK, the old one is gone.
- **Staged rollouts.** Server always serves the latest built APK to every device.

### Reusing for other PAN apps
The only app-specific bits are the `applicationId` and the FileProvider authority. To ship a second PAN-managed Android app:
1. Point its `UpdateChecker` at a different version endpoint (e.g. `/api/v1/apk/<app-id>/version`) — server reads from a different gradle output dir.
2. Update the `FILE_PROVIDER_AUTHORITY` constant to match its manifest.
Everything else (Tailscale routing, sha256 verification, install flow) is generic.

## Conv-State Watcher (`service/src/conv-state-watcher.js`)

A sibling of `webcam-watcher.js` and `screen-watcher.js`, but stream-paced
instead of timer-paced. Maintains a per-org **Conversation State** doc that
the router reads on every turn so it doesn't have to think about the full
dialogue itself.

### What it tracks
Per `org_id`, a distilled blob produced by Cerebras Qwen 235B (caller
`conv-state`):
- **topic** — what's being discussed right now
- **phase** — opening · discussing · deciding · command · wrapping_up · idle
- **pending_question** — what PAN (or commander) asked that's still unanswered
- **user_pattern** — how the user is talking (verbose · self-correcting · long-pauses-mid-thought · …)
- **likely_turn_complete** — whether the last utterance looks like a complete thought or mid-sentence
- **summary** — one sentence grounding the router's reply

Also exposes the last 5 finals + last 3 partials raw for debugging.

### Cadence
Not on a fixed timer. Two triggers:
1. **~500ms after each Final** (debounced — gives STT a beat to deliver more partials)
2. **Every 30s if utterances arrived since last distill** (idle fallback)

Pure in-memory ring buffer (20 utterances/org). No DB writes in v1.

### What feeds it
Called via `noteUtterance({orgId, text, isFinal, source, deviceId})`:
- `POST /api/v1/voice/result` (Whisper/dictate-vad finals + partials)
- `POST /api/v1/chat` (dashboard/comms typed messages — every message = one final)

Extensible: any new STT/voice surface (phone, pendant, future devices) just
calls `noteUtterance` and gets included automatically.

### What reads it
- **Router** (`service/src/router.js`) — `buildConvStateBlock(orgId)` injects
  the distilled state into the LLM prompt right after the intuition
  situation block, and copies the structured fields into `_debug.conversation`
  so the comms popout "🧠 why" disclosure can show it.
- **Dashboard / debug** — `GET /api/v1/conversation/state?org_id=…` returns
  `{ state, buffer }`; `GET /api/v1/conversation/status` lists all active orgs.

### Why separate from intuition
Intuition is *ambient* — webcam every 30s, screen every 60s, slow-changing
facts about the user and the room. Conv-state is *utterance-paced* — updates
sub-second on Finals. Different clocks. Mechanically separate watcher,
conceptually still "what PAN knows right now."

### Pre-gate
- Cerebras (`cerebras:qwen-3-235b`) reachable — falls back gracefully (state
  stays null, router proceeds without the block).
- `startConvStateWatcher()` called from `server.js` boot block alongside
  `startScreenWatcher` / `startWebcamWatcher`. Safe in dev (no DB writes).

### Replaces
- Hardcoded silence-timer endpointing (mid-sentence "I'm done" failures —
  the AMBIENT-fire-during-user-still-talking bug).
- The router having to read the whole utterance history every turn — now
  pre-chewed and ready.

### Doesn't do (yet)
- **Persistence.** State lives only in RAM. Reboot = empty state. Add a
  `conversation_states` table if we want Atlas replay.
- **Hard endpointing decision.** Router still fires on every message — the
  `likely_turn_complete` field is currently advisory. The "don't fire if
  mid-sentence" gate is the next step (#NEW-conv-endpoint).
- **Cross-thread distinction.** One state per org, not per thread. Multi-
  conversation orgs will smear topics until we add `thread_id` to the slot key.
