# ΠΑΝ — System Architecture

This document describes what is **currently built and running** in PAN.
For aspirational specs, see `docs/BLE-MESH.md`, `docs/DATA-DIVIDENDS.md`,
`docs/HOME-ASSISTANT.md`. For feature-level detail, see `FEATURES.md`.

---

## Process Hierarchy (Server)

PAN runs as a three-tier process stack on the host PC:

```
┌─────────────────────────────────────────────────────┐
│  SUPER-CARRIER  (super-carrier.js)  — PERMANENT     │
│  Port: 7777 (public)                                │
│  Never dies. Owns the port forever.                 │
│  Proxies HTTP + WebSocket → Carrier on 17760.       │
│  Buffers up to 200 WS frames during Carrier restart.│
│  Spawns Carrier via fork(). Auto-respawns on crash. │
└───────────────────┬─────────────────────────────────┘
                    │ fork()
┌───────────────────▼─────────────────────────────────┐
│  CARRIER  (carrier.js)  — RESTARTABLE               │
│  Port: 17760 (internal)                             │
│  Owns PTY sessions, WebSocket, reconnect tokens.   │
│  Spawns and manages Craft(s).                       │
│  Restart: POST /api/carrier/restart                 │
│  Survives: Craft swaps (PTY, WS, Claude all stay)  │
└───────────────────┬─────────────────────────────────┘
                    │ spawn()
┌───────────────────▼─────────────────────────────────┐
│  CRAFT  (server.js)  — HOT-SWAPPABLE                │
│  Port: 17700 (primary), 17701 (beta), 17702+ (queue)│
│  HTTP routes, DB handlers, MCP server, dashboard.   │
│  Swap: POST /api/carrier/swap                       │
│  A swap does NOT restart Claude or PTY sessions.    │
└─────────────────────────────────────────────────────┘
```

**What survives what:**

| Event | PTY/Claude | WebSocket | DB | Routes |
|-------|-----------|-----------|-----|--------|
| Craft swap | ✅ | ✅ | ✅ | ♻️ replaced |
| Carrier restart | ✅ (via reconnect tokens) | ✅ | ✅ | ♻️ replaced |
| Super-Carrier restart | ❌ | ❌ | ✅ | ❌ |

**Startup:** `PAN.bat` → `pan-loop.bat` → `node super-carrier.js`.
Loop restarts on crash (exit ≠ 0), stops on clean exit (code 0).

---

## Full System Map

```
┌──────────────────────────────────────────────────────────────────────┐
│  PENDANT (ESP32-S3) — in development                                │
│  Camera (OV2640) · Mic (PDM) · BLE 5.0 · Screen (1.69" IPS)        │
│  Sensors: UV, air quality, temp, humidity, IMU, gas, spectral...    │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ BLE (sensor data + photos down, display + audio up)
┌────────────────────────────▼─────────────────────────────────────────┐
│  PHONE (Android)                                                     │
│  • Google Streaming STT (on-device, real-time)                      │
│  • GeminiBrain classifier (local intent classification)             │
│  • Android TTS (Piper fallback)                                     │
│  • BLE receiver (Pendant data)                                      │
│  • LogShipper → POST /api/v1/logs every 5s                          │
│  • WebView dashboard (polls /mobile/ every 3s)                      │
│  • Tailscale VPN → server                                           │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ Tailscale (HTTP + WS)
┌────────────────────────────▼─────────────────────────────────────────┐
│  SERVER (Node.js — three-tier above)                                │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ VOICE PIPELINE                                               │   │
│  │ Phone STT → POST /api/v1/terminal/send → router.js           │   │
│  │ → Cerebras Qwen-3-235B (~580ms) → action dispatch → TTS     │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ TERMINAL (PTY + CLAUDE)                                      │   │
│  │ claude -p --project <dir> --model <model>                    │   │
│  │ WebSocket push: transcript_messages → dashboard              │   │
│  │ MCP server: 8 tools + 20+ router actions (see FEATURES.md)  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ MEMORY PIPELINE                                              │   │
│  │ 1. Event captured → events table (FTS5 indexed)              │   │
│  │ 2. Embeddings generated async → memory_items.embedding       │   │
│  │ 3. Augur classifier (every 5 min) → typed memory_items       │   │
│  │ 4. Consolidation (SessionEnd + scheduled) → episodic/        │   │
│  │    semantic/procedural memories                              │   │
│  │ 5. Evolution (6h) → merge, decay, bump relevance            │   │
│  │ 6. Dream (6h) → narrative synthesis, CLAUDE.md update       │   │
│  │ 7. Context injection (SessionStart) → CLAUDE.md context      │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ PRESENCE & SENSORS                                           │   │
│  │ Webcam Watcher (30s/5min) → face ID → identity_clusters     │   │
│  │ Screen Watcher (60s) → vision AI → screen_context event     │   │
│  │ Activity Tracker (3s) → foreground window → activity_events │   │
│  │ → intuition.js → context for voice router                   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ COMMUNICATIONS                                               │   │
│  │ chat.js → chat_threads + chat_messages tables               │   │
│  │ pan-notify.js → ΠΑΝ system thread (Scout, Dream, Pipeline)  │   │
│  │ email.js → mail transport (provider pending)                │   │
│  │ Dashboard pages: /v2/comms, /v2/chat, /v2/compose, /v2/call │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ ORGANIZATIONS & MULTI-TENANCY                                │   │
│  │ Per-org encrypted SQLCipher DBs (db-registry.js)            │   │
│  │ Roles: owner(100) admin(75) manager(50) user(25) viewer(0)  │   │
│  │ All queries scoped by org_id via allScoped/getScoped helpers │   │
│  │ Cross-org sharing with explicit grants                       │   │
│  │ Geofencing via zones.js (location-aware permissions)        │   │
│  │ Incognito sessions → isolated, no persistent trace          │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ AI INTELLIGENCE TIER                                         │   │
│  │ Cerebras Qwen-3-235B → default voice router (free, ~580ms)  │   │
│  │ Claude (claude -p) → terminal sessions, deep reasoning      │   │
│  │ Scout (Cerebras 120B) → model/tool discovery, 6h cycle      │   │
│  │ Augur → event classification, 5min cycle                    │   │
│  │ Dream → narrative synthesis, 6h cycle                       │   │
│  │ AutoDev → code generation, benchmark-gated                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ STEWARD (service orchestrator)                               │   │
│  │ Health checks every 60s. Manages 50+ registered services.   │   │
│  │ Auto-restarts on failure. Functional checks (not just PID). │   │
│  │ Only runs in prod (not dev).                                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ DATABASE (SQLite/SQLCipher)                                  │   │
│  │ 88+ tables. WAL mode. FTS5 full-text search.                │   │
│  │ Key tables: events, memory_items, episodic_memories,        │   │
│  │   semantic_memories, project_tasks, devices, chat_threads,  │   │
│  │   chat_messages, activity_events, ai_usage, ai_benchmark,  │   │
│  │   identity_clusters, zones, settings                        │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────────┐
│  DESKTOP (Tauri shell + AHK)                                        │
│  • Tauri: serves dashboard at port 7790, provides screenshot API    │
│  • AHK: voice hotkey, tooltip display, window control               │
│  • Dashboard (SvelteKit): 18 pages compiled to service/public/v2/   │
│  • PTY terminal tabs: each tab = claude -p process                  │
│  • Dashboard Watchdog: detects stuck/black screen, auto-recovers    │
└──────────────────────────────────────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────────┐
│  CLIENT DEVICES (pan-client.js)                                     │
│  Registered: Minipc-Ted, TED Hub (TedGL)                           │
│  Connects via WebSocket to Carrier.                                 │
│  Receives action commands: open_app, shell_exec, media_control...  │
│  See: docs/MULTI-DEVICE-ROUTING.md, docs/PAN-CLIENT.md            │
└──────────────────────────────────────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────────┐
│  INFRASTRUCTURE                                                     │
│  Tailscale VPN: all devices on same mesh, no port forwarding        │
│  Cloudflare Tunnel: optional public access                          │
│  Whisper STT: :7782/:7783 (local speech recognition)               │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Port Map

| Port | Owner | Purpose |
|------|-------|---------|
| 7777 | Super-Carrier | Public-facing HTTP + WS |
| 7781 | Dev Server | Dev instance (full copy of prod) |
| 7790 | Tauri Shell | Screenshot API, window control |
| 7782 | Whisper | STT inference |
| 7783 | Whisper (alt) | STT inference |
| 17700 | Craft (primary) | HTTP routes, DB, MCP, dashboard |
| 17701 | Craft (beta) | Benchmark evaluation slot |
| 17702+ | Craft (queue) | Spawned candidates waiting |
| 17760 | Carrier | Internal WS, PTY sessions |

---

## AI Model Selection

| Caller | Model | Why |
|--------|-------|-----|
| Voice router | `cerebras:qwen-3-235b` | Fast (~580ms), free tier |
| Terminal sessions | `claude` (claude -p) | Best reasoning, subscription |
| Scout | `cerebras:gpt-oss-120b` | Discovery + synthesis |
| Augur classifier | `cerebras:qwen-3-235b` | Classification at scale |
| Skill Learner | `cerebras:qwen-3-235b` | Fast, cheap for eval |
| Pan Notify replies | `cerebras:qwen-3-235b` | Conversational responses |

Model selection is in `service/src/claude.js` `getModelForCaller()`.
Overrides via `job_models` setting or `ai_model` global setting.

See `docs/AI-MODEL-SELECTION.md` for the 7-score evaluation framework.
See `docs/CEREBRAS-COST-ANALYSIS.md` for cost and latency breakdown.

---

## Data Flow: Voice Query

```
User speaks
    │
    ▼ (phone)
Google STT → text
    │
    ▼
GeminiBrain classifier
    ├── Local command? → execute on phone (time, flash, timer, nav, media)
    └── Server command? ↓
    │
    ▼ (Tailscale)
POST /api/v1/terminal/send (or /api/v1/brain for legacy)
    │
    ▼ (server — router.js)
Cerebras Qwen-3-235B
    │ (~580ms TTFT)
    ▼
Action dispatch
    ├── terminal_send → PTY → Claude
    ├── device command → client device
    ├── local action → server-side execution
    └── response text ↓
    │
    ▼ (phone)
Android TTS → audio playback
```

---

## Atlas V2 — What It Shows

The Atlas radial diagram at `/v2/atlas` is the best single-view of the
current system state. It renders:

- **Center:** ΠΑΝ Server with live stats (events, sessions, nodes)
- **Ring 1 (Core):** Database, Dashboard, Steward, Tauri
- **Ring 2 Sectors:** Services, Memory, Processing, Intelligence, Orgs, Presence, Comms
- **Ring 3:** All registered devices + all active projects (with task counts)
- **Voice pipeline strip:** Full phone → server → TTS chain with latency labels
- **Status indicators:** Green (up), yellow (degraded), red (down) per node

This diagram auto-generates from live service data. It is not a static image.

---

## Key Architectural Rules

1. **Super-Carrier never dies.** If it crashes, something is seriously wrong.
2. **Craft swaps are cheap.** HTTP routes only. PTY/Claude/WS are unaffected.
3. **Carrier restarts are heavier.** PTY reconnect tokens handle session continuity.
4. **Every `spawn()`/`exec()` needs `windowsHide: true`** — PAN runs dozens/min.
5. **All queries are org-scoped** — never query the DB without `org_id` context.
6. **Memory pipeline is async** — events ingested now may not be searchable for 5 min
   (until Augur runs). Factor this into any memory recall latency expectations.
7. **Dashboard Watchdog is always running** — if you see the dashboard stuck on
   black, it should auto-recover within 20s via Craft swap.
