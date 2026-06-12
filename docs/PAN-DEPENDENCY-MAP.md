# PAN Dependency Map

*Traced 2026-06-12 by five parallel code-tracing agents. This is the "what can
I cut without breaking what" document. Update when load-bearing couplings
change.*

**How to read this:** Section 1 is the boot chain (what must exist for PAN to
start). Section 2 is who-imports-whom. Section 3 is who-owns-which-table.
Section 4 is the removability matrix — the actual answer to "can I ship
without X". Section 5 is capture coverage. Section 6 is the minimal-ship
configurations.

---

## 1. Boot chain — what cannot be cut

```
pan-loop.bat
  └─ super-carrier.js        port 7777, permanent, no DB, no internal imports
      └─ carrier.js          port 17760 — WS, PTYs, client-manager, perf engine
          └─ server.js       port 17700+ (Craft) — everything else
```

### Hard (load-time) imports of server.js — Craft cannot boot if any fail

- `db.js` (server.js:73) → which needs `platform.js`, `schema.sql`, `pan.key`,
  better-sqlite3-multiple-ciphers. DB init failure = Craft crash.
- **All 26 route modules** (server.js:20–45). Any route file with a top-level
  error kills boot. This includes routes you might think are optional:
  zones, audit, replication, orgs, teams, email, wrap, incognito…
  **Implication: "removing a feature" requires removing its route import from
  server.js, not just ignoring it.**
- `terminal-bridge.js` (server.js:81)
- `client-manager.js` (server.js:82)
- `steward.js` (server.js:67 — import must succeed; bootAll() is async)

### Conditionally started (safe to not-start, NOT safe to delete imports)

| Subsystem | Gate | Where |
|---|---|---|
| Terminal PTY server | `!IS_CRAFT && IS_USER_MODE` | server.js:5364 |
| Client WS server | `!IS_CRAFT` | server.js:5322 |
| Steward bootAll | `!IS_DEV` | server.js:5845 |
| Smart Steward | `!IS_DEV`, async catch | server.js:5851 |
| Claude Control | via Steward registry, feature-toggleable | steward.js:161 |
| Embeddings backfill | `PAN_DISABLE_EMBEDDINGS_BACKFILL != '1'`, +90s | server.js:5733 |
| Panel broadcaster | `PAN_ENABLE_PANEL_BROADCASTER=1` (off by default) | server.js:5712 |
| Watchers (screen/webcam/activity/watchdog/vision-verifier) | `!IS_DEV`, +20s stagger | server.js:5618–5635 |
| Cloudflare tunnel, discovery, firewall rule | `!IS_DEV` | server.js:5738–5754 |

### Carrier owns (survives Craft swaps; dies on Carrier restart)

- All PTY sessions and the WS server for them
- **pan-client WebSocket connections** (client-manager runs on Carrier;
  Craft's copy of the module has an empty client map — Craft reaches live
  clients only via `POST /api/carrier/client-send` relay, routes/client.js:177)

---

## 2. Module graph — load-bearing couplings

### router.js (the voice/command brain) — hard imports

```
router.js
├─ intuition/index.js   getCurrentSnapshot()      HARD import (router.js:20)
│    └─ in-process, cached, defensive try-catch — intuition crash ≠ router crash
├─ claude.js / llm-fallback.js                    model selection + cascade
├─ memory-search.js     searchMemory()            recall intents (no timeout — bug #461)
├─ conv-state-watcher.js                          conversation phase
├─ intuition/mind.js    recentThoughts()
├─ skills.js, smart-router.js, routes/preferences.js
├─ client-manager.js    sendToClient/fireToClient remote dispatch
└─ db.js                events, memory_items, activity_events, pan_interjections
```

**Verdict:** router.js is the single most load-bearing module after db.js.
If it crashes, voice/chat/phone are all down.

### intuition/index.js — what feeds the cortex

| Signal | Source | If source removed |
|---|---|---|
| screen_context | screen-watcher.js getLatestScreenContext() (intuition:476) | try-catch → null field, degrades |
| webcam_context, last_seen | webcam-watcher.js getWebcamContext() (intuition:691,724) | try-catch → null, identity falls back to hardcoded 'owner' |
| activity | activity_events table (activity-tracker.js) | empty context block |
| needs | pan_need_events (fed by nourishment.js + signals.js, which are fed by screen-watcher + router utterances) | needs decay to zero, interjections stop |
| device context | getConnectedClients() (lazy, intuition:1560) | no device-aware routing |

**Key finding: removing the watchers does NOT crash intuition or router.
Everything degrades to null/empty with try-catch. The cost is context
quality, not uptime.**

### client-manager.js — the surprise load-bearer

Who calls it: routes/client.js (all 9 exports), mic-router.js,
remote-screen-watcher.js, intuition/action.js (interjection dispatch),
intuition/index.js (device context), routes/api.js:1108 (shell exec),
carrier.js:1260 (relay), smart-steward.js (remote fixes), router.js
(claude_control remote dispatch).

**Critical hidden dependency:** `getOllamaUrl()` (db.js:995) resolves the
Ollama URL by scanning `devices.reported_services` for a connected client
reporting `ollama:up`, then uses its `tailscale_ip:11434`
(steward trace: lines 1020–1050). Cache 30s, invalidated on heartbeat.

**On THIS deployment, Ollama and the vision models run on minipc, not
the Hub.** Therefore: no client-manager → no remote Ollama discovery →
embeddings, memory-search, vision, and the intuition classifier all silently
degrade to localhost:11434 (which has nothing). Voice keeps working only
because the primary chain is Cerebras (cloud).

### steward.js — lifecycle owner

Owns start/stop/health/restart for 16 services: claude-control, ollama
(health only), embeddings, whisper, voice-shell, classifier, intuition,
stack-scanner, dream, consolidation, scout, orchestrator, evolution, autodev,
tailscale, pan-server. Nobody imports steward except server.js (bootAll once).
Remove it and nothing crashes — but whisper never spawns, claude-control never
spawns, interval services never tick, zombies never get reaped, and nothing
restarts after a crash.

### MCP layer — fully decoupled (the cleanest seam in the codebase)

`mcp-server.js` (stdio), `routes/mcp-pan.js` (HTTP), `mcp/pan-tools.js`,
`mcp/quality-log-tools.js` import **zero** internal modules besides the MCP
SDK — every tool is an HTTP proxy to `127.0.0.1:7777`. They can be lifted
into a separate process/repo with no code changes beyond a base URL.

---

## 3. DB table ownership (who writes / who reads)

| Table | Writers | Readers |
|---|---|---|
| `events` (the spine) | routes/hooks.js (CLI session hooks), routes/api.js (chat/query/sensors/photos), router.js, dream, scout, orchestrator, guardian, evolution, watchers (webcam_context / screen_context), client-manager (restart history) | pan_search FTS, memory-search vectors, intuition snapshot, router dialog history, dashboard, session recaps |
| `memory_items` | Augur classifier | router context block, pan_memory MCP |
| `event_embeddings` | embeddings backfill worker | memory-search (vector half of RRF) |
| `pan_thoughts` | router, intuition, screen-watcher (via mind.js) | router recentThoughts, dashboard Mind widget |
| `pan_need_events` | nourishment.js, signals.js (fed by screen-watcher + utterances) | intuition deliberation |
| `intuition_snapshots` | intuition tick (append-only) | router situation block, dashboard |
| `devices`, `client_command_queue` | client-manager, routes/client.js, routes/devices.js | getOllamaUrl, steward, mic-router, smart-steward |
| `activity_events` | activity-tracker (3s poll) | router recent-topics, mic/speak-router device pick |
| `identity_clusters`, `identity_observations` | routes/identity.js ← webcam-watcher observeFace, voice.js observeVoice | dashboard Identity panel only |
| `chat_messages/threads` | pan-notify, routes/api.js phone persist, intuition/action.js | dashboard transcript, phone |
| `quality_log` | routes/quality-log.js | quality MCP tools |
| `ai_usage` | llm.js per call | usage widget, cost queries |
| `sessions`, `session_summaries` | routes/hooks.js | context injection into CLAUDE.md |

---

## 4. Removability matrix — the answer table

Severity: **CRASH** = something dies · **BREAK** = feature stops · **DEGRADE**
= works worse · **FREE** = nothing notices.

| Cut this | Effect | Severity |
|---|---|---|
| super-carrier / carrier / server.js / db.js | everything | CRASH |
| any of the 26 route imports | Craft won't boot until import removed from server.js | CRASH (fixable by edit) |
| router.js | voice, chat, phone, interjections all down | CRASH |
| client-manager + pan-client | remote commands, **remote Ollama discovery** (→ embeddings/vision/memory-search degrade on this deployment), device context, mic routing, smart-steward remote fixes | BREAK |
| steward.js | whisper + claude-control never spawn; no restarts, no health alerts, no zombie reaping | BREAK (slow death) |
| whisper (port 7782) | server-side STT + speaker ID gone; phone still has Google STT, browser has Web Speech | BREAK (server), DEGRADE (clients) |
| intuition/index.js | router situation block empty (defensive), no interjections, no snapshots | DEGRADE |
| screen-watcher | no screen context, no nourishment/safety signals, vision interjections stop | DEGRADE |
| webcam-watcher | no presence/identity/emotion; identity falls back to 'owner'; **gates NOTHING security-wise** (verified: no auth/permission reads identity) | DEGRADE |
| activity-tracker | router loses recent-apps block; mic-router loses device pick heuristic | DEGRADE |
| identity routes + face-id worker | enrollment stops, Identity panel dead; zero security impact | DEGRADE |
| memory-search / embeddings | recall intents return empty; voice still routes | DEGRADE |
| scout / dream / orchestrator / evolution / autodev | no discovery, no state-doc rewrites, no action queue, findings pile up | FREE-ish (long-run drift) |
| smart-steward.js | no LLM-driven fixes; deterministic Steward still restarts things | FREE |
| claude-control.js | voice computer-control gone; router falls back to `system` intent (one-liners) or remote pan-client dispatch. Edits needed: steward registry entry, router case, 4 server endpoints | FREE (with 3 small edits) |
| dashboard-watchdog | already neutered (early return at line 72) | FREE |
| dashboard-vision-verifier | no vision-vs-DOM bug filing | FREE |
| sensors routes | pendant/phone sensor policy UI dead; nothing else reads it | FREE |
| mail/contacts/photos, zones, orgs/teams, incognito, replication, audit | each self-contained behind its route; nothing else imports them (but their route imports must be removed from server.js to truly delete) | FREE (per-feature) |
| dashboard UI (public/v2) | nothing server-side cares; MCP + API unaffected | FREE |

---

## 5. Capture coverage — where the "PAN remembers everything" pitch is true

The chain for Claude Code CLI (verified end-to-end, ~50–100ms):

```
~/.claude/settings.json hooks (UserPromptSubmit/Stop/Pre+PostToolUse/SessionStart/End/PermissionRequest)
  → POST http://127.0.0.1:7777/hooks/<EventType>       (routes/hooks.js:477)
  → insertScoped INTO events                            (hooks.js:649 → db.js:858)
  → indexEventFTS (instant search)                      (hooks.js:657)
  → async vector embedding                              (memory-search)
  → broadcastChatUpdate WS push                         (hooks.js:786)
SessionEnd additionally → session summary + CLAUDE.md context injection (hooks.js:587)
```

| Surface | Captured? | Mechanism | Gap |
|---|---|---|---|
| Claude Code CLI | **FULL** | native hooks, 8 event types | none |
| PAN dashboard chat | FULL | /api/v1/chat → DashboardChat events | no tool-use granularity |
| Phone voice | FULL | /api/v1/query → VoiceCommand + chat_messages | intent+response pairs only |
| Claude desktop app (chat) | **NONE** | — | MCP plugin gives READ access only; its conversations are not written to PAN |
| Claude.ai / Cowork (cloud) | **NONE** | — | same: read via /mcp/pan, no write-back |

**The single biggest gap vs. the product pitch.** Options: (a) transcript
import sidecar, (b) make MCP tool calls write an event per invocation
(cheap, partial), (c) a `pan_log_exchange` tool the remote Claude is
instructed to call (depends on model compliance).

---

## 6. Minimal-ship configurations

### Config A — "Memory + MCP" (smallest useful PAN)

Boot chain + db.js + routes (hooks, api, dashboard, mcp-pan, quality-log) +
MCP servers + Claude Code hooks in settings.json.
- **Not started:** watchers, steward intervals beyond whisper, scout/dream/
  orchestrator/evolution/autodev, client WS, identity, sensors, zones, orgs.
- **Works:** full CLI capture, pan_search/memory/thoughts/decide, FTS,
  session recaps, CLAUDE.md injection, quality-log.
- **Lost:** voice, interjections, multi-device, embeddings (unless local
  Ollama present — embeddings need *an* Ollama URL).
- **Caveat:** the 26 route imports in server.js mean "not started" ≠
  "deleted." Shipping this cleanly means a build/flag pass over server.js's
  import block — that's the real refactor, and it's mechanical.

### Config B — Config A + Voice

Add: steward (for whisper lifecycle), whisper, router's full context path,
Cerebras key. Optional: local Ollama for embeddings/memory-search.
- Single machine, no pan-client needed **if** Ollama/Whisper run locally —
  which requires the "diesel computer" caveat, or accepting Cerebras-only.

### Config C — Config B + Presence/Intuition (the current personal PAN)

Add: screen-watcher, webcam-watcher, activity-tracker, intuition tick,
interjections. This is where the privacy opt-in surface starts (camera,
screen). Everything here is DEGRADE-class — strictly additive context.

### Config D — + Multi-device

Add: client-manager (Carrier), pan-client on each machine, steward remote
probes, claude-control per-client. Required when models run on a different
box (this deployment). Hardest install path; the SYSTEM-account credential
and PATH issues live here.

---

## 7. Corrections to folklore

- "Intuition needs the Claude CLI" — **false.** The cortex classifies via
  Cerebras/getModelForPurpose. claude-control is downstream of routing only.
- "Identity gates security" — **false.** identity_clusters feed UI display
  and auto-bind only; auth middleware never reads them.
- "reap-orphans.js" — no longer exists; merged into steward
  (detectOrphanAiProcesses).
- "dashboard-watchdog recovers black screens" — currently **disabled**
  (early return, line 72).
- "Craft talks to pan-clients directly" — **false.** WS lives on Carrier;
  Craft relays via /api/carrier/client-send. Anything on the Craft calling
  getConnectedClients() locally sees an empty map (this bit us in the
  claude_control device picker — fixed by querying /api/carrier/clients).
