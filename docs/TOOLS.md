# PAN Tool Registry

PAN is a compilation of the best available tools. All we do is take what they create and integrate it.
This document tracks what's installed, what's next, and what the Scout discovers.

Last updated: 2026-05-04

---

## Installed & Active

| Tool | Category | What it does | Status |
|------|----------|-------------|--------|
| **Claude (claude -p)** | AI | Terminal sessions, deep reasoning, code, memory consolidation | Running |
| **Cerebras — Qwen-3-235B** | AI | Default voice router — fast (~580ms), free tier | Running |
| **Cerebras — GPT-OSS-120B** | AI | Scout discovery + synthesis | Running |
| **better-sqlite3 + SQLCipher** | Database | Local persistent storage, WAL mode, per-org encrypted DBs | Running |
| **Google STT** | Voice | Streaming speech-to-text on phone (on-device, real-time) | Running |
| **Piper TTS** | Voice | Text-to-speech on server + phone fallback | Running |
| **Android TTS** | Voice | Primary TTS on phone (system, no latency) | Running |
| **Tailscale** | Network | VPN mesh — all devices on same network, no port forwarding | Running |
| **Tauri** | Desktop | Shell for the dashboard — provides screenshot API at port 7790 | Running |
| **node-pty** | Terminal | PTY sessions — one per dashboard tab, hosts claude -p | Running |
| **Playwright MCP** | Browser | Browser automation via MCP — used by test suite | Running |
| **GWS CLI** | Google | Gmail, Calendar, Drive, Sheets, Docs, Chat — all via CLI v0.18.1 | Installed (needs gcloud auth) |
| **1mcp/agent** | MCP | Aggregates multiple MCP servers into one endpoint | Running |
| **WezTerm** | Terminal | Socket API terminal control — send-text, get-text, list-panes, spawn | Installed |
| **AHK (AutoHotkey)** | Desktop | Voice hotkey, tooltip display, window focus control | Running |
| **Tool Scout** | Discovery | Scans GitHub Trending, Awesome MCP, AI Agents, CLI lists for new tools every 12h via Cerebras 120B | Running |
| **Augur Classifier** | Memory | Background event classifier — every 5min, types events into memory_items | Running |
| **Dream Engine** | Memory | Narrative synthesis + CLAUDE.md update — every 6h | Running |
| **Evolution Engine** | Memory | Memory merge, decay, relevance bump — every 6h | Running |
| **Activity Tracker** | Presence | Polls foreground window every 3s (Win32 API), logs to activity_events | Running |
| **Dashboard Watchdog** | Reliability | Detects stuck black screen via brightness check, triggers Craft swap auto-recovery | Running |
| **Skill Learner** | Learning | Stop hook — evaluates each session for reusable skills, auto-generates SKILL.md | Running |
| **Webcam Watcher** | Presence | Face ID every 30s (face-api), identity lock, auto-enroll to cluster | Running |
| **Screen Watcher** | Presence | Vision AI screenshot every 60s via Tauri/FFmpeg, stores screen_context | Running |
| **PAN Notify** | Comms | Unified service → user messaging via ΠΑΝ chat thread | Running |
| **Context Mode** | Dev Tools | Virtualizes context window — 98% reduction. Indexes tool outputs in local SQLite FTS5 | Installed |
| **pan-client.js** | Clients | Remote PC agent — receives + executes action commands from server | Running (Minipc-Ted, TedGL) |
| **Cloudflare Tunnel** | Network | Optional public access without port forwarding | Configured |

## In Progress

| Tool | Category | What it does | % | Blocker |
|------|----------|-------------|---|---------|
| Piper Voice Training | Voice | Custom TTS voice clone from user recordings | 50% | Training data ready (274 segments). Docker or native pip needed. |
| Resistance Router | Routing | Multi-path action execution with learning | 90% | Needs real-world usage data to tune weights |
| Email Provider | Comms | Outbound email for compose/notify — initEmail() exists, no provider configured | 0% | Pick provider (Resend, SES, etc.) and wire credentials |
| Pendant Firmware | Hardware | ESP32-S3 Sense: camera, mic, BLE, sensors | 30% | Hardware in dev, BLE protocol designed |
| Geofencing (zones.js) | Presence | Location-aware permission gating | 50% | zones.js wired, GPS source integration pending |
| Personal Sync | Data | Sync across PAN instances (home ↔ laptop) | 40% | startPersonalSync() exists, conflict resolution pending |
| Identity System | Presence | Multi-modal identity from visual + voice + context | 40% | Schema designed (see FEATURES.md), matching algorithm pending |

## Next Up — Approved for Integration

| Priority | Tool | Category | Why | URL |
|----------|------|----------|-----|-----|
| 1 | **yt-dlp** | Media | Download video/audio from any platform via CLI. PAN says "download this" and it just works. | https://github.com/yt-dlp/yt-dlp |
| 2 | **Groq** | AI | 300-400ms TTFT target for voice router. Needs API key. | https://groq.com |
| 3 | **WebSocket for phone dashboard** | Comms | Replace 3s polling with real-time push. Eliminates phone transcript race condition (#376). | — |

## Potential — Scouted, Not Yet Evaluated

| Tool | Score | Category | What it does | URL |
|------|-------|----------|-------------|-----|
| Aganium | 0.92 | Agent | DNS-like discovery for AI agents, mTLS trust, capability search | https://github.com/Aganium/aganium |
| AgentHotspot | 0.88 | MCP | Marketplace for MCP connectors — discover + install dynamically | https://github.com/AgentHotspot/agenthotspot-mcp |
| Adala | 0.72 | Agent | Autonomous data labeling with learning capabilities | https://github.com/HumanSignal/Adala |
| AgentForge | 0.68 | Agent | Low-code multi-LLM agent framework | https://github.com/DataBassGit/AgentForge |
| streamlink | 0.60 | Media | Extract streams from websites, pipe to player | https://github.com/streamlink/streamlink |
| mpv | 0.50 | Media | Scriptable video player with CLI remote control | https://mpv.io |

## Evaluated & Rejected

| Tool | Reason |
|------|--------|
| CMUX | macOS-only (Swift/AppKit). PAN already has terminal management. |
| NemoClaw (NVIDIA) | Enterprise-focused agent sandbox. Too heavy for personal use. |
| RunPod Flash | Cloud GPU — costs money per second. Only useful for one-time training. |
| Gemini Nano ML Kit | `Generation.getClient()` hangs indefinitely on Pixel 10 Pro. Beta API, not stable. Server-side Cerebras is faster anyway. |
| Phi 3.5 Mini (on-device) | Replaced by Cerebras free tier — faster, smarter, no local resource cost. |
| Browser Extension | Replaced by Playwright MCP. More reliable, no Chrome extension restrictions. |

## Future Vision

| Concept | Description |
|---------|-------------|
| **Data Staking** | PAN captures everything. Users stake their data for AI training, get paid. See docs/DATA-DIVIDENDS.md. |
| **Skill Marketplace** | Skills anyone can write and share — already started with skill-learner.js. |
| **BLE Mesh** | Pendants communicate nearby presence without server. See docs/BLE-MESH.md. |
| **Agent Network** | Via Aganium — PAN discovers and calls other agents' tools across a network. |
| **Home Assistant** | PAN + HA integration for smart home control. See docs/HOME-ASSISTANT.md. |

---

*This file is manually updated during development sessions and reviewed by Scout (every 12h).*
*Scout sources: GitHub Trending, Awesome MCP Servers, Awesome AI Agents, Awesome CLI Tools*
