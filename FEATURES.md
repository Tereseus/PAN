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

---

## Identity System (Spec — not yet built)

### Philosophy
PAN identifies people through accumulated multi-modal evidence — never by
comparing against external face databases. All identity data lives in PAN's
own DB. The system builds confidence over time, not from a single image.

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

## Dashboard Refresh Recovery (Spec — not yet built)

### Problem
When the PAN dashboard (Tauri shell) refreshes or gets stuck loading, the
user is locked out until the page finishes loading. Current worst-case: ~2min.
Target: ≤15 seconds.

### Detection
The PAN dashboard always displays the π symbol visually when fully loaded
(top-left, near the palm tree logo). The loading screen is plain black — no π.

**Detection logic (no vision model needed):**
1. Trigger: WebSocket from Tauri disconnects and reconnects (page refresh)
2. Start a 15-second timer
3. At T+15s: capture a screenshot of the Tauri window
4. Check average pixel brightness of the frame:
   - Mostly black (brightness < threshold) AND π not found in frame → **stuck**
   - π symbol visible OR significant UI content → **loaded OK**
5. If stuck: trigger recovery action (see below)

**Why pixel brightness, not vision model:** Brightness check is instant (<5ms).
No need to send to minicpm-v for a binary loaded/stuck determination.

### Recovery Actions (in order)
1. `POST /api/carrier/swap` — replaces Craft, which re-serves the page
2. If swap doesn't resolve within 15s: send WebSocket `force_reload` message
   to Tauri shell
3. If still stuck: log incident, alert user via TTS

### π Detection Method
The π symbol in the dashboard uses a specific Unicode character (π, U+03C0)
rendered at a known position. After capturing the frame:
- Crop the top-left region (~150×80px)
- Run OCR or template match for π character
- Match = dashboard loaded; no match on black frame = stuck

### Timing Target
- T+0: WebSocket disconnect detected
- T+0 to T+15: page reloading normally (don't interfere)
- T+15: brightness check + π scan (~5ms)
- T+15 to T+20: recovery action executes
- T+30: user is back in the dashboard

### Code Location (when built)
- Trigger hook: `service/src/carrier.js` WebSocket reconnect handler
- Detection: new `service/src/dashboard-watchdog.js`
- Calls into: `service/src/screen-watcher.js` `captureViaTauri()`

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
  instead of raw hostname (e.g. "Dell G16-tedprodesk2" not just "tedprodesk2").
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
- User: `👤 Tzuri Jr (lvl 15)`
- Group: `🏢 ΠΑΝ → Member (lvl 25)`
