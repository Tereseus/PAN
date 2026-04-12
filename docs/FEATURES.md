# PAN Feature Registry

Auto-injected into every Claude session. This is the canonical list of what PAN can do.

## Core System

### Long-Term Memory (PAN Briefing)
- **What**: Claude has no memory between sessions. PAN gives it long-term memory by injecting context from the database, memory files, and living state documents into CLAUDE.md at session start.
- **Components**: `hooks.js:injectSessionContext()`, `dream.js`, `.pan-briefing.md`, `.pan-state.md`, Claude memory files
- **How it works**: On SessionStart hook (or first UserPromptSubmit fallback), PAN reads recent conversation from DB, Claude's auto-memory files, open tasks, and injects them between `<!-- PAN-CONTEXT-START/END -->` markers in CLAUDE.md
- **Status**: Working

### ΠΑΝ Remembers (Session Continuity)
- **What**: Every new Claude session starts with "ΠΑΝ Remembers:" followed by a summary of what was worked on previously, marked as SOLVED or OPEN
- **Components**: `hooks.js`, CLAUDE.md injection, Recent Conversation section, reconnect tokens
- **Status**: Working

### Dream Cycle
- **What**: Every 6 hours, PAN processes recent events and rewrites the living state document using Claude Haiku
- **Components**: `dream.js`, `claude.js`
- **Status**: Working

### Database (SQLCipher)
- **What**: Persistent encrypted storage for all PAN data via better-sqlite3-multiple-ciphers (AES-256-CBC) with FTS5 search index
- **Tables**: sessions, events, events_fts, projects, project_tasks, memory_items, devices, device_settings, sensors, sensor_data, commands
- **Status**: Working

## Carrier/Craft Runtime

### Carrier (Zero-Downtime Runtime)
- **What**: Long-lived process that owns the HTTP listener (:7777), WebSocket server, and PTY terminals. Never restarts for code changes — spawns swappable Craft instances instead.
- **Components**: `carrier.js`, `cli/start.js`
- **Phases**: All 7 phases complete (foundations → hot-swap → reconnect → PTY handoff → Claude handoff → shadow traffic → Crucible)
- **Status**: Working — deployed in production

### Craft (Swappable Server)
- **What**: The running PAN version (server.js with PAN_CRAFT=1). Carrier spawns new Crafts, health-checks them, switches the proxy, keeps old Craft alive for 30s rollback.
- **Components**: `server.js` (forked by Carrier with PAN_CRAFT=1 env)
- **Status**: Working

### Lifeboat (Rollback Safety)
- **What**: Embedded rollback HTTP handler inside Carrier (~50 lines, no dependencies). Works even when Craft is hung. Three rollback layers: 30s auto-timer, dashboard overlay button, phone Settings rollback.
- **Endpoints**: `/lifeboat/status`, `/lifeboat/rollback`, `/lifeboat/confirm`
- **Status**: Working

### Shadow Traffic (Phase 6)
- **What**: Launch a shadow Craft, mirror all non-GET requests to both primary and shadow. Compare responses side-by-side (status codes, latency, match rate). Promote winners to primary or reject failures.
- **Endpoints**: `POST /api/carrier/shadow` (start), `DELETE /api/carrier/shadow` (reject), `POST /api/carrier/shadow/promote`, `GET /api/carrier/shadow/stats`
- **Status**: Working

### Crucible (Phase 7 — Variant Comparison)
- **What**: Dashboard page at `/v2/crucible` showing live comparison between primary and shadow Craft. Status cards, stats grid, comparison table, promote/reject buttons. Opens in its own Tauri window from Lifeboat panel.
- **Components**: `dashboard/src/routes/crucible/+page.svelte`, carrier.js crucible endpoints
- **Status**: Working

### Reconnect Tokens (Phase 3)
- **What**: WebSocket clients receive a reconnect token on connection. Tokens persist to disk (`reconnect-tokens.json`, 24h TTL). On disconnect, frontend auto-reconnects with saved token — session, project, and Claude session IDs restored transparently.
- **Components**: `terminal.js` (token registry), frontend sessionStorage
- **Status**: Working

## Voice and AI

### Voice Assistant (Phone)
- **What**: Always-listening voice assistant on Android. STT captures speech, classifier routes to local or server commands
- **Components**: `PanForegroundService.kt`, Google Streaming Speech Recognition
- **Local commands**: time, date, battery, flashlight, timer, alarm, navigation, search, app launch, media controls, mute/unmute
- **Status**: Working

### Claude Pipe Mode (Agent SDK)
- **What**: Claude runs via the Agent SDK in pipe mode — no PTY subprocess, no TUI. Clean JSON streaming, session resumption across restarts via `--session-id` and `--resume`.
- **Components**: `llm-adapter-claude.js` (ClaudeAdapter), `terminal.js:pipeSend()`
- **Status**: Working

### AI Router
- **What**: Single Claude call that classifies AND handles voice/text input in one shot
- **Components**: `router.js`, `claude.js`
- **Status**: Working

### Cerebras Backend
- **What**: Fast AI inference (llama3.1-8b) for voice responses at 70ms latency
- **Status**: Working (free tier, 1M tokens/day)

### On-Device AI Classification
- **What**: Cerebras online, OS-provided model offline, regex fallback
- **Components**: `GeminiBrain.kt`, `classifyLocally()` in `PanForegroundService.kt`
- **Status**: Partial (Gemini Nano not yet working on Pixel 10 Pro)

### MCP Server (Claude Code Integration)
- **What**: PAN exposes itself as an MCP server so Claude Code can interact with all PAN systems natively
- **Core tools**: `pan_search`, `pan_memory`, `pan_restart`, `pan_dev`, `pan_terminal_send`, `pan_browser`
- **Router tool (`pan`)**: single dispatch for 20+ actions including carrier control, conversations, projects, tasks, devices, alerts, recording, windows, settings, runner, library, processes
- **Components**: `mcp-server.js`
- **Status**: Working

## Connectivity

### Tailscale VPN (Remote Access)
- **What**: Phone connects to PC through encrypted Tailscale tunnel with embedded tsnet
- **Components**: `RemoteAccessManager.kt`, `panvpn.go`, `PanVpnService.kt`
- **Status**: Working (120-150ms latency)

### Server Discovery
- **What**: Phone finds PAN server automatically: saved IP, *pan-hub* hostname, peer scan, health check
- **Components**: `RemoteAccessManager.kt`, `panvpn.go:FindServerIP()`
- **Status**: Working

## Dashboard

### Web Dashboard (SvelteKit)
- **What**: 11-page browser-based UI: terminal, atlas, crucible, automation, projects, conversations, sensors, data, settings, terminal-dev, chat
- **Components**: `service/dashboard/` (SvelteKit 2 + Svelte 5), built to `service/public/v2/`
- **Must rebuild after editing**: `cd service/dashboard && npm run build`
- **Status**: Working (desktop and mobile)

### Terminal (WebSocket PTY + Pipe Mode)
- **What**: Full terminal in dashboard with multi-tab support. Each tab gets its own PTY session. Claude runs in pipe mode via Agent SDK. Persistent transcripts per tab.
- **Components**: `terminal.js`, `llm-adapter-claude.js`, node-pty
- **Status**: Working

### Atlas (System Map)
- **What**: Visual map of all PAN services, processes, and connections. Interactive zoom/pan, node details.
- **Components**: `dashboard/src/routes/atlas/+page.svelte`
- **Status**: Working

### Dev/Prod Isolation
- **What**: Dev server runs on port 7781 with separate database (`%LOCALAPPDATA%/PAN/data-dev/`). Same dashboard, same terminal, separate data. Page auto-detects dev via port number.
- **Components**: `dev-server.js`, `db.js` (respects PAN_DATA_DIR)
- **Status**: Working

## Project Management

### Project Sync
- **What**: Scans for `.pan` files, deduplicates symlinks, tracks renames, auto-detects projects
- **Components**: `db.js:syncProjects()`
- **Status**: Working (re-syncs every 10 minutes)

### AutoDev / Forge
- **What**: Autonomous development system. Forge generates code variants, shadow Crafts test them against real traffic, Crucible displays comparison, user approves or rejects. The flywheel: user preferences → better variants → faster approval → more data → sharper model.
- **Components**: `carrier.js` (shadow traffic), `crucible/+page.svelte` (UI), `autodev.js` (scout)
- **Status**: Infrastructure complete (Carrier/Shadow/Crucible). Intelligence layer (Intuition personality model, automated variant generation) in progress.

## Devices and Sensors

### Device Registry
- **What**: Tracks all PAN devices, auto-registers from API headers
- **Components**: `routes/devices.js`, `device_settings` table
- **Status**: Working

### Sensor System
- **What**: Collects phone sensor data with per-sensor ON/OFF toggles across 22 categories
- **Components**: `routes/sensors.js`, phone sensor service
- **Status**: Working

## Infrastructure

### Steward (Process Health)
- **What**: Service orchestrator — health checks every 60s, auto-restart on failure
- **Components**: `steward.js`
- **Status**: Working

### Orphan Reaper
- **What**: Kills orphaned bash/claude processes from prior runs on startup
- **Components**: `reap-orphans.js`
- **Status**: Working

### Windows Service
- **What**: PAN server runs as Windows service via WinSW, auto-starts on boot
- **Status**: Working

### Voice Hotkeys
- **What**: Mouse side buttons for whisper dictation via AutoHotkey v2
- **Components**: `Voice.ahk`
- **Status**: Working

## Planned

### Hardware Pendant (ESP32-S3)
- Wearable with camera, mic, sensors, screen. Magnetic brooch mount. Streams to phone via BLE.
- **Status**: Firmware in progress

### Intuition Engine
- User personality model derived from interaction patterns — voice tone, decision speed, word choice, approval/rejection patterns. Weighted feature vector that biases Forge variant generation toward user preferences.
- **Status**: Designed, not implemented

### PAN Hub
- Organizational layer managing all employees' PAN instances from company servers
- RBAC, geofencing, sensor enforcement, tailnet auto-switching, data dividends
- **Status**: Schema migrated (Phase 1), more phases ahead

### PAN Token (Cardano)
- Crypto token for anonymized data staking. 0.1% protocol fee.
- **Status**: Planned

### Visual Comparison Funnel
- L1 (pHash, <1ms) → L2 (CLIP + Lighthouse, ~20-50ms) → L3 (vision LLM, ~5-30s) → L4 (human approval, ~5s glance)
- 100 variants → 20 → 5 → 1 winner in ~40 seconds total
- **Status**: Designed, not implemented

---
*Last updated: 2026-04-11*
