# PAN Feature Registry

Auto-injected into every Claude session. This is the canonical list of what PAN can do.

## Core System

### Long-Term Memory (PAN Briefing)
- **What**: Claude has no memory between sessions. PAN gives it long-term memory by injecting context from the database, memory files, and living state documents into CLAUDE.md at session start.
- **Components**: `hooks.js:injectSessionContext()`, `dream.js`, `.pan-briefing.md`, `.pan-state.md`, Claude memory files
- **How it works**: On SessionStart hook (or first UserPromptSubmit fallback), PAN reads recent conversation from DB, Claude's auto-memory files, open tasks, and injects them between `<!-- PAN-CONTEXT-START/END -->` markers in CLAUDE.md
- **Status**: Working

### Dream Cycle
- **What**: Every 12 hours, PAN processes recent events and rewrites the living state document using Claude Haiku
- **Components**: `dream.js`, `claude.js`
- **Status**: Working

### Session Continuity
- **What**: Every new Claude session starts with a summary of what was worked on previously, marked as SOLVED or OPEN
- **Components**: `hooks.js`, CLAUDE.md injection, Recent Conversation section
- **Status**: Working

### Database (SQLCipher)
- **What**: Persistent encrypted storage for all PAN data via better-sqlite3-multiple-ciphers (AES-256-CBC) with FTS5 search index
- **Tables**: sessions, events, events_fts, projects, project_tasks, memory_items, devices, device_settings, sensors, sensor_data, commands
- **Status**: Working

## Voice and AI

### Voice Assistant (Phone)
- **What**: Always-listening voice assistant on Android. STT captures speech, classifier routes to local or server commands
- **Components**: `PanForegroundService.kt`, Google Streaming Speech Recognition
- **Local commands**: time, date, battery, flashlight, timer, alarm, navigation, search, app launch, media controls, mute/unmute
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

### Quick Mute
- **What**: App starts muted. User unmutes to activate STT. LIVE (red) / Muted (grey) visual states
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

### Web Dashboard
- **What**: Browser-based UI with chat, projects, sensors, data, settings tabs
- **Components**: `service/public/index.html` (mobile), `service/dashboard/` (Svelte v2)
- **Status**: Working (desktop and mobile)

### Dashboard Chat
- **What**: Shows full conversation transcripts via JSONL parser, same as desktop terminal
- **Components**: `/api/transcript`, `/api/v1/chat` endpoint
- **Status**: Working

### Terminal (WebSocket)
- **What**: Full terminal in dashboard via WebSocket PTY with Claude auto-launch
- **Components**: `terminal.js`, xterm.js, node-pty
- **Status**: Working

## Project Management

### Project Sync
- **What**: Scans for `.pan` files, deduplicates symlinks, tracks renames, auto-detects projects
- **Components**: `db.js:syncProjects()`
- **Status**: Working (re-syncs every 10 minutes)

### Terminal Launch (`pan.js launch`)
- **What**: Opens WezTerm tabs per project with full session context
- **Components**: `pan.js`, `cli/launch.js`
- **Status**: Working

### AutoDev / Scout
- **What**: Autonomous scheduled scouting (GitHub monitor checks issues every 2h)
- **Components**: `scout.js`, `autodev.js`, `orchestrator.js`
- **Status**: Partial

## Devices and Sensors

### Device Registry
- **What**: Tracks all PAN devices, auto-registers from API headers
- **Components**: `routes/devices.js`, `device_settings` table
- **Status**: Working

### Sensor System
- **What**: Collects phone sensor data with per-sensor ON/OFF toggles
- **Components**: `routes/sensors.js`, phone sensor service
- **Status**: Working (category grouping planned)

## Infrastructure

### Windows Service
- **What**: PAN server runs as Windows service via WinSW, auto-starts on boot
- **Status**: Working

### Watchdog
- **What**: Monitors PAN server, Whisper, Voice.ahk and auto-restarts failures
- **Components**: `watchdog.ps1`
- **Status**: Working

### Voice Hotkeys
- **What**: Mouse side buttons for whisper dictation via AutoHotkey v2
- **Components**: `Voice.ahk`
- **Status**: Working

## Planned

### Hardware Pendant (ESP32-S3)
- Wearable with camera, mic, sensors, screen. Magnetic brooch mount. Streams to phone via BLE.

### PAN Hub
- Organizational layer managing all employees' PAN instances from company servers
- RBAC (role-based access), geofencing (auto-enroll devices, enforce sensors by zone)
- Tailnet auto-switching (personal → work → back, based on email + location)
- Full audit trail (every sensor toggle logged, transparent to user and management)
- Data dividends (sensor data at scale has value flowing back to contributors)
- **Status**: Planned — architecture designed, not started

### PAN Token (Cardano)
- Crypto token for anonymized data staking. 0.1% protocol fee. PRIVATE.

### Dashboard V2 (Electron + Svelte)
- Desktop app wrapping the Svelte dashboard. Can open any application in a webview.
- **Bug**: Webview shows Electron icon in title bar instead of the app's icon
- **Status**: Working (icon bug outstanding)

---
*Auto-injected by PAN context briefing. Last updated: 2026-03-30*
