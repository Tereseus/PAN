# PAN Tool Registry

PAN is a compilation of the best available tools. All we do is take what they create and integrate it.
This document tracks what's installed, what's next, and what the Scout discovers.

Last updated: 2026-03-23

---

## Installed & Active

| Tool | Category | What it does | Status |
|------|----------|-------------|--------|
| Claude API (Haiku) | AI | Intent classification, routing, memory extraction | Running |
| better-sqlite3 | Database | Local persistent storage, WAL mode | Running |
| Piper TTS | Voice | Text-to-speech (custom voice training in progress) | Training |
| Google STT | Voice | Speech-to-text on phone | Running |
| Gemini Nano | AI (Phone) | On-device intent classification | Running |
| Phi 3.5 Mini | AI (Phone) | On-device LLM for complex queries | Connected |
| Browser Extension | Browser | Tab reading, page content, click/type automation | Running (being replaced by Playwright) |
| Electron Tray | Desktop | UI automation, terminal opens, system commands | Running |
| Docker | Infrastructure | Container runtime for training + builds | Running |
| node-windows (WinSW) | Infrastructure | PAN runs as Windows service, auto-start on boot | Running |
| **WezTerm** | Terminal | Socket API terminal control — send-text, get-text, list-panes, spawn. Replaces Windows Terminal. | **Installed + Wired** |
| **Playwright MCP** | Browser | Browser automation via MCP — replaces custom browser extension. Chromium installed. | **Installed** |
| **GWS CLI** | Google | Gmail, Calendar, Drive, Sheets, Docs, Chat — all via CLI. v0.18.1 | **Installed** (needs gcloud for auth) |
| **1mcp/agent** | MCP | Aggregates multiple MCP servers into one endpoint. Playwright + GWS added. v0.30.1 | **Installed + Configured** |
| **Context Mode** | Dev Tools | Virtualizes context window — 98% reduction. Indexes tool outputs in local SQLite FTS5. | **Installed** |
| **Tool Scout** | Discovery | Scans GitHub Trending, Awesome MCP, AI Agents, CLI lists for new tools. Every 12h. | **Running** |

## In Progress

| Tool | Category | What it does | % | Blocker |
|------|----------|-------------|---|---------|
| PersonaPlex (Moshi) | Voice | Real-time voice conversation on PC (7B model) | 70% | Loading with --cpu-offload for 8GB GPU, slow but stable |
| Piper Voice Training | Voice | Custom TTS voice clone from recordings | 50% | Training never started. Data ready (274 segments). Need working Docker or native pip install |
| Resistance Router | Routing | Multi-path action execution with learning | 90% | Needs real-world usage data |

## Next Up — Approved for Integration

| Priority | Tool | Category | Why | URL |
|----------|------|----------|-----|-----|
| 1 | **NanoClaw skill pattern** | Agent | Skills via instruction files instead of hardcoding integrations. "Connect to WhatsApp" loads a skill file. 500 lines, Anthropic Agent SDK. | https://github.com/qwibitai/nanoclaw |
| 5 | **yt-dlp** | Media | Download video/audio from any platform via CLI. PAN says "download this" and it just works. | https://github.com/yt-dlp/yt-dlp |

## Potential — Scouted, Not Yet Evaluated

| Tool | Score | Category | What it does | URL |
|------|-------|----------|-------------|-----|
| Aganium | 0.92 | Agent | DNS-like discovery for AI agents, mTLS trust, capability search | https://github.com/Aganium/aganium |
| AgentHotspot | 0.88 | MCP | Marketplace for MCP connectors — discover + install dynamically | https://github.com/AgentHotspot/agenthotspot-mcp |
| Adala | 0.72 | Agent | Autonomous data labeling with learning capabilities | https://github.com/HumanSignal/Adala |
| AgentForge | 0.68 | Agent | Low-code multi-LLM agent framework | https://github.com/DataBassGit/AgentForge |
| AgentPilot | 0.65 | Agent | Desktop agent manager with group chat, Open Interpreter | https://github.com/jbexta/AgentPilot |
| streamlink | 0.60 | Media | Extract streams from websites, pipe to player | https://github.com/streamlink/streamlink |
| mpv | 0.50 | Media | Scriptable video player with CLI remote control | https://mpv.io |

## Evaluated & Rejected

| Tool | Reason |
|------|--------|
| CMUX | macOS-only (Swift/AppKit). PAN already has terminal management. Concept is good — socket API for terminals — but can't run on Windows. |
| NemoClaw (NVIDIA) | Enterprise-focused agent sandbox. Too heavy for personal use. Security model is interesting but overkill for PAN. |
| RunPod Flash | Cloud GPU — costs money per second. Only useful for one-time training, not daily PAN operations. |

## Future Vision

| Concept | Description |
|---------|-------------|
| **Data Staking** | PAN captures everything (voice, photos, browsing, conversations). Users stake their data for AI training, get paid via crypto. Integrate with Ocean Protocol / Vana / Streamr. |
| **Skill Marketplace** | NanoClaw-style skills that anyone can write and share. "Connect PAN to Spotify" is just a skill file. |
| **Agent Network** | Via Aganium — PAN discovers and calls other agents' tools across a network. |

---

*This file is auto-updated by Tool Scout (every 12h) and manually during development sessions.*
*Scout sources: GitHub Trending, Awesome MCP Servers, Awesome AI Agents, Awesome CLI Tools*
