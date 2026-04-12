# [ΠΑΝ — Personal AI Network](https://tereseus.github.io/PAN/)

Voice-controlled AI operating system. Phone, computer, browser, wearable pendant — one unified system. Self-hosted, open source, all data on your hardware.

> **[See the interactive demo with screenshots](https://tereseus.github.io/PAN/)**

<p align="center">
  <img src="docs/v2-terminal.png" width="800" alt="Terminal — Claude Code with chat sidebar and task tracking">
</p>

<p align="center">
  <img src="docs/device/Minicam.jpg" width="220">
  <img src="docs/v2-phone.png" width="140">
  <img src="docs/device/MinicamKeyForScale.jpg" width="220">
</p>

<p align="center">
  <em>ESP32-S3 camera module (smaller than a car key) — Android app — Size comparison</em>
</p>

| Chat | Data Overview | Activity Log |
|------|---------------|-------------|
| ![Chat](docs/v2-chat.png) | ![Data](docs/v2-data.png) | ![Activity](docs/v2-activity.png) |

| Projects | Sensors | Settings |
|----------|---------|----------|
| ![Projects](docs/v2-projects.png) | ![Sensors](docs/v2-sensors.png) | ![Settings](docs/v2-settings.png) |

---

## What PAN Does

PAN captures, organizes, and protects your personal data across all devices. Voice commands route across phone, PC, browser tabs, and pendant sensors. Always-on microphone with full conversation context.

### Voice Examples

**"What did we say about genies?"**
Searches PAN's database across all conversations — voice, text, terminal — finds the matching conversation in under a second.

**"Show me videogamedunkey's newest video."**
Opens YouTube via browser extension → navigates to channel → plays most recent upload → tells you the title.

**"Is this meat still good?"**
Pendant spectrometer reads chemical composition at the surface — fat oxidation, moisture content. Tells you what a camera can't see.

**"Tell Marcus I'm running late."**
Picks the right messaging app, types the message, sends it.

### Proactive Awareness

PAN learns your patterns and helps before you ask. Every category is independently controllable.

- **Face recognition** — pendant camera identifies people, recalls where you met and what you discussed
- **Conversation capture** — phone numbers, deadlines, promises are automatically saved
- **Context bridging** — connects what you're reading to conversations from last week
- **Safety** — fall detection, emergency contacts, location sharing, duress detection

### Connected PANs

When two people both use PAN, their devices coordinate automatically. Everything is opt-in.

- Silent message queuing when you're busy
- Shared ETAs when heading to the same place
- Emergency detection and automatic contact alerting
- Cross-device memory search with permission

---

## Your Data, Your Control

All data stays on your devices. Not in the cloud, not on anyone else's servers.

- **SQLite database** on your PC (`%LOCALAPPDATA%/PAN/data/pan.db`) — encrypted at rest
- **All communication encrypted** via Tailscale (WireGuard tunnel) — even on local WiFi
- **Data anonymization** — PII stripped before any data leaves your device to cloud AI
- **Delete anything** — single events, entire days, bulk search results, or everything
- **Every action logged** — what PAN heard, how it classified it, what API it called, response time

### Data Dividends

PAN captures your data. You own it. You can sell it.

Three anonymization tiers let you control what you share:
- **Tier 1 (Full Anonymize)** — topics and sentiment only. AI companies buy conversation patterns.
- **Tier 2 (Partial)** — city-level GPS, conversations without names. Urban planning, transit analysis.
- **Tier 3 (Minimal)** — precise GPS, full sensors, conversations with context. Name and personal identifiers always stripped.

Your name, home address, and personal identifiers are permanently removed at every tier. Revenue via crypto staking on Cardano — PAN is free forever, you earn by contributing anonymized data.

---

## Architecture

```
Phone (Android)                    PC (Windows)
├── Google Streaming STT           ├── Carrier (port 7777) ─── owns HTTP, WebSocket, PTY
├── On-device AI (MediaPipe GPU)   │   ├── Craft (server.js) ─── swappable, zero-downtime
├── Gemma 3n (classify + chat)     │   ├── Lifeboat ─── rollback safety (30s auto-revert)
├── Camera + Vision                │   └── Crucible ─── variant comparison (shadow traffic)
├── Tailscale (encrypted tunnel)   ├── Claude Code (via Agent SDK, pipe mode)
├── Voice commands                 ├── SvelteKit Dashboard (11 pages)
└── BLE ↔ Pendant                  ├── MCP Server (7 tools + 1 router, 20+ actions)
                                   ├── SQLite + FTS5 Search
Pendant (ESP32-S3)                 ├── Data Anonymization Layer
├── Camera (OV2640)                ├── Tailscale Auto-Auth
├── Microphone                     └── Dream Cycle (memory consolidation)
├── Screen (ST7789V)
├── Speaker + Amplifier            Desktop Shell (Tauri)
└── 22 sensor slots (see below)    ├── Global hotkeys (voice trigger)
                                   ├── Multi-window manager (Atlas, Crucible, ATC)
                                   └── PTY terminal sessions
```

### Carrier/Craft Runtime

PAN runs on a **zero-downtime hot-swap architecture**. The system never goes down for code changes.

| Component | Role |
|-----------|------|
| **Carrier** | Long-lived process. Owns HTTP listener (:7777), WebSocket server, PTY terminals. Never restarts for code changes. |
| **Craft** | The running PAN version (server.js). Swappable — Carrier spawns new Craft, health-checks it, switches proxy, keeps old Craft for 30s rollback. |
| **Lifeboat** | Embedded rollback handler inside Carrier (~50 lines, no dependencies). Works even when Craft is hung. Three rollback layers: auto-timer, dashboard overlay, phone button. |
| **Crucible** | Variant comparison system. Launch a shadow Craft, mirror real traffic to both, compare responses side-by-side. Promote winners, reject failures. |

**Implementation phases (all complete):**
1. ✅ Foundations — orphan reaping, PTY exit detection, db-registry
2. ✅ Carrier + Lifeboat + 30s auto-rollback
3. ✅ Reconnect tokens — persist to disk, frontend auto-reconnects with token
4. ✅ PTY handoff — terminals live in Carrier, survive Craft swaps
5. ✅ Claude session handoff — context preserved across restarts
6. ✅ Shadow traffic — mirror requests to shadow Craft, compare responses
7. ✅ Crucible — dashboard UI for variant comparison, promote/reject controls

### Dashboard Pages

| Page | Description |
|------|-------------|
| Terminal | Main interface — Claude chat, PTY shell, multi-tab, sidebar widgets |
| Chat | Standalone conversation view |
| Atlas | Visual system map — services, processes, connections |
| Crucible | Shadow traffic comparison — launch/promote/reject variants |
| Automation | Automation rules and triggers |
| Projects | Task tracking with milestones, drag-and-drop |
| Conversations | Search and browse all past conversations |
| Sensors | 22 sensor categories with per-sensor toggles |
| Data | Event log, activity feed, data overview |
| Settings | Server config, voice settings, branding, restart |

### MCP Server (Claude Code Integration)

PAN exposes itself as an MCP server so Claude Code can interact with it natively:

**Core tools:** `pan_search`, `pan_memory`, `pan_restart`, `pan_dev`, `pan_terminal_send`, `pan_browser`

**Router tool (`pan`)** — single dispatch for 20+ actions:
`conversations`, `projects`, `tasks`, `services`, `devices`, `stats`, `sessions`, `sensors`, `photos`, `scout`, `alerts`, `recording`, `windows`, `settings`, `logs`, `runner`, `library`, `context`, `processes`, `carrier`

**Carrier actions:** `status`, `swap`, `shadow_start`, `shadow_stop`, `shadow_promote`, `shadow_stats`, `crucible`, `open_crucible`, `rollback`, `confirm`, `lifeboat`

### Security

- **Tailscale required** for all device communication (raw LAN blocked)
- **Auto-auth** — sign in with Google once, Tailscale connects silently via pre-authorized keys
- **Database encryption** at rest (SQLCipher)
- **Anonymization layer** — emails, phones, GPS, addresses, SSN stripped from all cloud AI calls
- **WireGuard alternative** available for users who prefer self-managed tunnels
- **Headscale** (self-hosted coordination server) planned for enterprise

---

## The Pendant

PAN works with just a phone and computer. The pendant adds first-person perspective.

Size of a Zippo lighter. €155 total cost. 22 sensor slots — use all or just the basics.

| Sensor | What It Does |
|--------|-------------|
| Camera (OV2640) | Identify objects, read signs, translate text |
| Microphone (PDM) | Voice commands, conversation recall |
| Spectrometer (AS7341) | Chemical analysis — food freshness, material ID |
| Thermal Camera (MLX90640) | See heat through walls, detect hot wires |
| Gas Sensor (BME688) | Detect leaks, carbon monoxide, smoke |
| GPS (L76K) | Geotag every event |
| Heart Rate + SpO2 (MAX30102) | Continuous pulse and blood oxygen |
| Accelerometer + Gyro (BMI270) | Fall detection, step counting |
| + 14 more | UV, magnetometer, air quality, color, distance, EMF, radiation... |

Full sensor specifications: [docs/SENSOR-ARRAY.md](docs/SENSOR-ARRAY.md)

**Build it yourself** — full parts list, 3D printable case, assembly guide, firmware. All open source.

---

## Quick Start

### Server (Windows)
```bash
git clone https://github.com/Tereseus/PAN.git
cd PAN/service
npm install
node pan.js start                  # Start via Carrier (hot-swap enabled)
node pan.js start --no-carrier     # Start directly (no hot-swap)
node pan.js start -d               # Start detached (background)
```

Dashboard opens at `http://localhost:7777/v2/terminal`

### Dev Server
```bash
# From production (opens in separate window on port 7781)
curl -s http://127.0.0.1:7777/api/v1/dev/start -X POST

# Or manually
PAN_DEV=1 PAN_PORT=7781 node pan.js start --no-carrier
```

### Phone (Android)
1. Build APK from `android/` in Android Studio
2. Install on phone
3. Set server URL → your PC's IP, port 7777
4. Grant microphone + camera permissions
5. Start talking — on-device AI responds in ~5s, server queries in ~7s

### Browser Extension
1. `chrome://extensions/` → Developer Mode → Load unpacked → select `browser-extension/`
2. PAN can now read and control all browser tabs

### Desktop App (Tauri)
```bash
cd desktop && cargo tauri dev
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Phone | Kotlin, Jetpack Compose, MediaPipe GPU, Gemma 3n, Google STT, Hilt DI, Tailscale (tsnet) |
| Server | Node.js, Express, SQLite (better-sqlite3 + SQLCipher), Claude Agent SDK, MCP Server |
| Runtime | Carrier/Craft hot-swap architecture, Lifeboat rollback, Crucible variant comparison |
| Dashboard | SvelteKit 2, Svelte 5, WebSocket terminals, 11 pages |
| Desktop | Tauri, multi-window manager, global hotkeys |
| Browser | WebExtension API (Manifest V3) — Chrome, Edge, Brave |
| AI | Claude Code (terminal, pipe mode), Gemma 3n (phone, on-device), MediaPipe (GPU inference) |
| Memory | Dream Cycle (6h consolidation), ΠΑΝ Remembers (session continuity), reconnect tokens |
| Security | Tailscale (WireGuard), auto-auth keys, data anonymization, SQLCipher |
| Pendant | ESP32-S3, I2C/SPI sensors, BLE 5.0 |
| Voice | Google Streaming STT, Android TTS, Whisper (streaming) |

## System Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | Any i5 (2018+) | i5-10th gen+ |
| RAM | 8 GB | 16 GB |
| Storage | 128 GB SSD | 256 GB+ SSD |
| Network | Always-on internet | Ethernet preferred |
| OS | Windows 10/11 | Windows 11 |
| Phone | Android 12+, 6GB RAM | Pixel 10 Pro or equivalent |
| Cost | ~$150 used PC | ~$200-300 |

At ~1.5 MB/day for text data, 256 GB lasts decades. With pendant photos, ~50-100 MB/day.

---

## Key Files

| File | Purpose |
|------|---------|
| `service/src/carrier.js` | Carrier runtime — owns HTTP, PTY, WebSocket. Hot-swap orchestrator. |
| `service/src/server.js` | Craft (swappable server) — routes, API, boot sequence |
| `service/src/terminal.js` | PTY sessions, WebSocket server, reconnect tokens, pipe mode |
| `service/src/mcp-server.js` | MCP server — 7 tools + router for Claude Code integration |
| `service/src/steward.js` | Service orchestrator — health checks every 60s, auto-restart |
| `service/src/platform.js` | Cross-platform abstractions (paths, shell, process management) |
| `service/src/reap-orphans.js` | Kills orphaned bash/claude processes from prior runs |
| `service/src/llm-adapter-claude.js` | Claude Agent SDK adapter — pipe mode, session resumption |
| `service/dashboard/src/routes/terminal/+page.svelte` | Main dashboard UI (6000+ lines) |
| `service/dashboard/src/routes/crucible/+page.svelte` | Crucible variant comparison UI |

---

## Status

### Working
- Voice conversation across phone + PC (on-device + server)
- SvelteKit dashboard with 11 pages (terminal, atlas, crucible, projects, sensors, data, settings, automation, conversations, chat)
- Carrier/Craft zero-downtime hot-swap with 30s auto-rollback
- Lifeboat rollback system (dashboard overlay, API, phone button)
- Crucible shadow traffic comparison (launch shadow, mirror traffic, promote/reject)
- Claude pipe mode via Agent SDK (session resumption across restarts)
- ΠΑΝ Remembers session continuity (briefing injection, reconnect tokens)
- Cross-device command routing (phone → PC → browser)
- Remote access via Tailscale with auto-authentication
- On-device AI (Gemma 3n via MediaPipe GPU, ~5s responses)
- FTS5 full-text search across all events and conversations
- Data anonymization (PII stripping before cloud AI calls)
- Project tracking with milestones, tasks, drag-and-drop
- Phone sensor control from dashboard
- MCP server integration (Claude Code tools for all PAN operations)
- Browser extension (read/control tabs, click elements, type text)
- Dream cycle (consolidates events into structured memory every 6h)
- Dev/prod resource isolation (separate databases, ports, session IDs)
- Multi-tab terminal with persistent transcripts

### In Progress
- Pendant firmware (ESP32-S3 — camera, BLE, screen driver)
- Voice fingerprinting (Piper training with user audio)
- Data dividend / treasury system (Cardano staking)
- Installer (one-click setup)
- AutoDev/Forge (autonomous development with Crucible variant comparison)
- Intuition engine (user personality model from interaction patterns)

### Planned
- Headscale (self-hosted coordination for enterprise)
- Cross-user messaging relay
- Duress detection (stress analysis, silent emergency alerts)
- File access across devices via Tailscale (no USB needed)
- Voice emotion classification (sentiment tagging from audio waveform)
- Visual comparison funnel (pHash → CLIP → vision LLM → human approval)

---

*PAN doesn't require any specific AI provider. Use Claude Code, Gemini CLI, Cursor, or any tool — as long as your project has a `.pan` file, PAN captures everything. The AI is pluggable. Your data is not.*

---

**License:** Open Source
**Created by:** [Tereseus](https://github.com/Tereseus)
