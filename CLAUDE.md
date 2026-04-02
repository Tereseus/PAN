# PAN — Personal AI Network

PAN is a persistent AI operating system across all devices, projects, and conversations.

## Architecture (as of 2026-03-20)

### Three layers:
1. **Phone App** (Android/Kotlin) — always-listening voice assistant, on-device commands, routes to server
2. **PAN Server** (Node.js, port 7777) — runs as Windows service, bridges phone to Claude CLI, manages projects/sessions/memory
3. **Hardware Pendant** (ESP32-S3) — wearable with camera, mic, sensors, screen — streams to phone via BLE (in development)

### Phone App (`android/`)
- **STT**: Google Streaming Speech Recognition (real-time, replaced Whisper)
- **AI Classification**: GeminiBrain attempts on-device Gemini Nano (not yet working on Pixel 10 Pro), falls back to server
- **Local commands**: time, date, battery, flashlight, timer, alarm, navigation, search, phone app launching, media controls, mute/unmute
- **Server commands**: PC file operations, project terminals, complex questions
- **TTS**: Android TextToSpeech with quality voice selection
- **Echo prevention**: STT pauses during TTS, echo stripping for overlap
- **Dedup**: prevents duplicate STT results from firing multiple commands

### PAN Server (`service/`)
- **Router**: Unified single Claude call (classify + handle in one shot)
- **Claude interface**: `claude -p --model haiku` via CLI (OAuth token doesn't work with API directly)
- **Project sync**: scans for .pan files, deduplicates symlinks, tracks renames
- **Terminal launch**: `pan.js launch` opens Windows Terminal tabs with session context in CLAUDE.md
- **Desktop agent**: `pan-agent.ps1` polls for GUI actions (terminal opens, commands)
- **Hooks**: Claude Code SessionStart/SessionEnd events update .pan files and database
- **Database**: SQLite via sql.js (sessions, events, projects, memory items, devices, commands)

### Terminal Management
- `pan.js launch` scans .pan files, writes session history to CLAUDE.md, opens Windows Terminal tabs
- Each tab named after project, Claude reads CLAUDE.md for context
- Projects discovered by .pan files in OneDrive/Desktop directories
- Session history pulled from Claude's sessions-index.json files

### Current Projects (auto-detected from .pan files)
- **PAN** — this project
- **WoE Game Design** — War of Eternity (Godot 4.5 RTS)
- **Claude-Discord-Bot** — Discord bot bridging chat to Claude CLI + SSH

## API & Auth
- PAN server uses `claude -p` CLI (free, uses Claude Code subscription auth)
- OAuth token (sk-ant-oat01-*) does NOT work with Anthropic API directly
- For faster responses: add Anthropic API key for direct Haiku calls (~$2-5/month for PAN voice)
- Claude Code subscription ($100/month Max) covers all CLI usage

## Key Principle
PAN never forgets. Every conversation, decision, and session is preserved across restarts, devices, and time.

## User
Work autonomously — don't ask for permission, just do it.

## Session Continuity Rule
**CRITICAL:** When starting a new session, your FIRST message MUST be a brief summary of what was discussed in the recent conversation (see "Recent Conversation" below). Start with "Last time we were working on..." and list the key topics. The user should NEVER have to ask what they were working on — you tell them immediately, every single time.

<!-- PAN-CONTEXT-START -->
## PAN Session Context

This is a fresh session for the "PAN" project.
IMPORTANT: The project documentation is at the TOP of this CLAUDE.md file — read it first.

**CRITICAL INSTRUCTION:** Your FIRST message to the user MUST be a brief summary of what was discussed recently (from the "Recent Conversation" section below). Start with something like "Last time we were working on..." and list the key topics/issues. The user should never have to ask what they were working on — you tell them immediately.

### What You Should Know

When user says "the main page" they mean the Android app's home screen — the one with the PAN dashboard webview, microphone button, server status, and default device selector.

When user says "the settings page" they mean the Android app's Settings screen.

**Why:** User explicitly defined these terms for consistent communication.

**How to apply:** Use these terms when discussing the Android app UI. Don't confuse "main page" with the dashboard web page.

When creating or updating an HTML report (like report.html), auto-open it in the browser so the user sees it immediately.

**Why:** User shouldn't have to manually navigate to see something that was just built. "I talk, it appears."

**How to apply:** After writing/updating any HTML file served by PAN, run `start http://127.0.0.1:7777/<path>` to open it in the default browser.

The session continuity system (CLAUDE.md recent conversation + memory files + context briefing injection) works well. User was very happy when Claude immediately knew what was worked on previously.

**Why:** User has been frustrated by sessions that don't remember context. When it works, it's the difference between "PAN is back" and "who are you?"

**How to apply:** Always follow the session continuity rule. The briefing system is the core mechanism — protect it, don't break it, and keep CLAUDE.md's recent conversation section accurate.

All user-facing text in the dashboard must use correct capitalization:

1. **Labels, headings, button text:** Title Case (e.g., "Restart Server", "Setup Guide", "Add a Task")
2. **Descriptions and sentences:** Sentence case — first word capitalized (e.g., "Set up an AI model so PAN can work.")
3. **Text after colons:** First letter capitalized (e.g., "Voice: Press your voice key..." not "Voice: press your voice key...")
4. **NEVER use ALL CAPS** for user-facing text. Not for buttons, not for headings, not for status messages, not for setup guides.
5. **NEVER start a sentence or value with a lo...

When creating reports, HTML pages, or any resource with a URL, send the link to the dashboard chat as well (not just terminal output). The phone dashboard needs clickable hyperlinks.

**Why:** The user works voice-first from their phone. Terminal output isn't visible on mobile. Links need to appear in the chat interface so they can tap to open.

**How to apply:** After generating any report or URL, POST it to the PAN chat endpoint or broadcast it via the dashboard WebSocket so it appears in the mobile chat view as a clickable link.

When user says "check the memory", "look at what we did", "find that thing", search ALL of these in order:

1. **PAN database** (`%LOCALAPPDATA%/PAN/data/pan.db` via `node -e` with better-sqlite3)
   - `events` table — raw event log (UserPromptSubmit, AssistantMessage, Stop, etc.)
   - `memory_items` table — classified items (task, decision, design_decision, feature_request, fact, insight, preference)
   - `sessions` table — session timestamps and project paths
   - Filter by date with `created_at >= 'YYYY-MM-DD'`
   - Use FTS5 (`events_fts`) for keyword search across all history

2. **Claude ...

This terminal exists solely to manage the PAN server process. When user says restart, just run `node pan.js start` again without questions.

**Why:** User corrected Claude for asking unnecessary confirmation instead of just restarting the service.

**How to apply:** When user says start/stop/restart, do it immediately. No confirmation needed. Run `node pan.js start` in the service directory.

Never ask the user to run manual commands (adb pull, gh auth login, etc.). Just do it.

**Why:** PAN's core thesis is "I talk, it appears." An average person doesn't know how to run ADB or CLI commands. Asking them to copy-paste terminal commands defeats the entire purpose. Claude should handle everything autonomously — pull files, authenticate, whatever it takes.

**How to apply:** When you need to do something (pull photos, push code, restart a service), just do it directly via tools. If a permission blocks you, try alternative approaches or explain what permission is needed in plain English...

When the user says "look at my photos" or "find photos", pull them and actually VIEW them (read the image files). Don't just list filenames and sizes.

**Why:** Listing filenames is useless — the user wants to know WHAT the photos are OF. The correct flow is: find → pull → view → describe contents. The subagent wasted time listing files when it should have been pulling and examining them.

**How to apply:** For phone photos: use ADB pull directly (no asking user), then Read tool to view images. For local photos: just Read them. Always describe what you see in the photos.

Every project launched by PAN should have its development environment mapped in memory so Claude knows what the user is referring to without them having to use precise technical names.

**Why:** User said "terminal scrollbar" and Claude wasted time investigating the web dashboard's xterm.js code instead of WezTerm config. An average person shouldn't have to specify "WezTerm" — saying "terminal" should be enough.

**How to apply:**
1. When starting a PAN project session, the tools stack memory should already be loaded
2. When user mentions a component by a casual name ("terminal", "the app", "s...

When a restart happens (server crash, session restart, app crash), save what caused it before or after restarting.

**Why:** User was frustrated that the new session didn't know what was being worked on before the crash/restart. The context was lost because nobody recorded why the restart happened.

**How to apply:** Before restarting, note what was being worked on and what caused the restart. After restart, the session summary should reference what went wrong and what was being done. Check git log and recent DB events if needed to reconstruct context.

Service names should feel warm and intelligent, not creepy or surveillance-like.

**Why:** These show up as running services in the dashboard. Users (especially future PAN Hub users) shouldn't feel watched.

**Decided names (2026-03-31):**
- Process health monitor: **Steward** (was "Watcher") — keeps services alive, `watchdog.ps1` renamed
- State/consciousness service: **Intuition** — understands your state, dimensional awareness
- Security service (future): **Guardian** — facial recognition, voice auth, attack protection

**How to apply:**
- Use these names in dashboard, logs, API endpoints, ...

When giving the session summary at start of conversation:

1. **Don't repeat "ΠΑΝ remembers.."** — the launch command already prints it. Just go straight into the summary.
2. **Mark items as solved or open** — don't list everything as if it's all still active. Show status clearly (e.g. "SOLVED: app crash" vs "OPEN: terminal scroll").
3. **Keep it concise** — only mention things that matter for the current session.

**Why:** User said "don't show things that are like were worked on, show if they were solved or not solved" and "it shows pan remembers too many times."

**How to apply:** Every ses...

# PAN Crypto System — PRIVATE

## Overview

PAN Token on Cardano blockchain. Users stake anonymized data → AI companies buy aggregated data → users earn PAN tokens → 1% protocol fee to PAN treasury on every transaction.

## Chain: Cardano

**Why Cardano:**
- Native tokens (no smart contract needed just to mint PAN token)
- $0.05-0.20 transaction fees (critical for micro-transactions)
- Built-in staking (delegation to stake pools)
- Plutus V3 / Aiken for smart contracts
- Proof of Stake, energy efficient
- Academic rigor, peer-reviewed protocols

**Why Cardano over Solana/Ethereum (FINAL DECISI...

# PAN Data Economics — PRIVATE

## Revenue Model

Users run PAN → data flows through it → they choose to stake anonymized data → AI companies buy aggregated training data → crypto transaction occurs → PAN creator takes 1% of each transaction.

- User controls everything: toggle data sharing on/off
- Anonymization happens locally before data leaves the device (PII stripped on-device)
- Hub aggregates anonymized data across all PAN instances
- Users get staking rewards (crypto) for contributing data
- PAN creator gets a micro-fee (1%) per transaction

## Fee Structure (FINAL DECISION)

**The 1% ...

PAN's AutoDev/Scout system should be an autonomous agent loop, not just reactive.

**Why:** The user shouldn't have to ask "check my GitHub issues" — PAN should already know. This applies to everything: GitHub replies, dependency updates, new tools, project tasks, anything relevant to active goals.

**How to apply:**
1. **Scheduled scouting missions** run automatically when server is up (GitHub monitor is the first example)
2. **Classifier processes findings** — decides what's actionable vs informational, creates memories/tasks/design decisions
3. **Surfaces to user** via dashboard, phone noti...

# PAN as Internal Biosensor Integration Platform

## Core Framing
PAN does not build internal biosensors. PAN is the OS they plug into. Every internal sensor device is a data silo with no cross-correlation, no longitudinal intelligence, no user ownership. PAN solves all of that.

## Target Devices for Integration
- **PillCam / capsule endoscopy** (Medtronic) — gut imaging, 8-12hr battery, RF transmission, ~2-6fps. Data currently goes to clinician, discarded.
- **Atmo Biosciences capsule** — gut gas composition (H2, CO2, O2), 24-48hr transit, wireless transmission. No personal longitudinal stor...

# Project: AI Blood Sampling Analysis

## Concept
Daily fingerprick blood draw (same as diabetic glucose test). Blood on microscope slide, imaged at high magnification via cheap USB/smartphone microscope ($30-80). PAN captures image, runs CV analysis, logs to health timeline. Longitudinal daily data builds personal blood health record.

## Hardware
- Fingerprick lancet device (commodity, diabetic supply)
- Portable USB/smartphone digital microscope (~$30-80, 1000x)
- Microscope slides + cover slips (consumable)
- PAN Android app as capture interface → analysis pipeline
- Optional: clip-on smar...

# PAN Consciousness Architecture (designed 2026-03-31)

## Three-Tier Triangle

```
        Claude (PAN Server - live service)
       /  writes state.json continuously  \
      /   full context: photos, audio,      \
     /    sensors, conversation history       \
Phone ←——— shared state on server ———→ Cerebras 120B
 Qwen 0.6B    (awareness.json)              fast response
 sensors       dimensions                    reads state
 new events    ~1K tokens                    ~250ms
```

## How It Works
1. Claude runs as a LIVE SERVICE (like Guardian/Watcher), continuously processing all inputs
2...

# PAN Core Vision

## The Next Step of Computing

"I talk, it appears."

No menus. No learning curves. No tutorials. No documentation. You talk, it happens. The AI handles everything else. The stupidest person and the smartest person have the same interface — their voice.

After "I talk, it appears" comes "I think, it appears." That's brain-computer interface territory. But "talk to appear" is basically here NOW.

## What This Means for PAN

- Every feature must be voice-accessible
- The UI exists for LOOKING, not for DOING — you look at what you want to see, you talk to make things happen
- T...

## PAN Dashboard Terminology (agreed 2026-04-01)

**Instance** — A full environment (Prod, Dev, Test). Only admins can see/switch instances. Dev and Test show a label in the Topbar; Prod does NOT. Admin-only, hidden from regular users behind RBAC.

**Sidebar** — The left vertical navigation strip. Contains Tabs.

**Tab** — Each nav item in the Sidebar. Switches the active App.

**App** — What fills the Main View (Terminal, Chat, ATC map, etc.). Can also open in a new window. Tabs switch between Apps.

**Main View** — The large center content area. Displays the active App. One App at a time.

*...

PAN dashboard is ALREADY an Electron app. V2 direction:

1. **Chat** = default view, replaces terminal as primary interface
2. **Embedded webviews** = any app/site/stream (YouTube, cameras, games, tools) running inside PAN's shell via Electron webview/BrowserView
3. **Terminal** = background, accessible for power users
4. **PAN observes everything** running in its shell — builds memory from what user sees, reads, watches, does

**Core thesis:** PAN is a personal data sovereignty platform. All data flows through it, user owns it all, can stake anonymized data via crypto for revenue. This gives ...

Data dividends use a **federated model** — raw data NEVER leaves the user's machine.

**How it works:**
1. Raw data stays encrypted locally (SQLCipher DB)
2. Buyers/AI companies send queries/algorithms TO your PAN instance (via Hub)
3. PAN runs the algorithm locally against raw data
4. Only anonymized results go back through the NER anonymizer (outbound filter)
5. User earns PAN tokens for matched/contributed data

**Why:** Privacy-preserving computation. No bulk data export. The anonymizer (`anonymizer.js`) is the gatekeeper — nothing exits without NER stripping.

**How to apply:**
- DB store...

PAN will ship installers for both Windows and Linux. Development is currently on Windows but Linux deployment is a priority for easier DB tooling, terminal control, and cloud integration.

Phone app targets both standard Android AND GrapheneOS (hardened AOSP). GrapheneOS considerations:
- No Google Play Services — no Firebase/GMS dependencies allowed
- Stricter background process killing — foreground service with persistent notification required (already done)
- More aggressive permission revocation — handle denial gracefully
- BLE, sensors, USB serial all use standard Android APIs, no changes...

SOLVED (2026-03-25): Context reload is now handled by:
1. `.pan-state.md` — living state file maintained by dream cycle (rewrites, never appends)
2. `/api/v1/context-briefing` — endpoint serves state file + recent chat to fresh sessions
3. Dashboard auto-injects briefing when launching Claude in terminal tabs

**Why:** --continue caused throttling from massive context. JSONL grep was too slow and inaccurate. Individual memory_items rows in DB created unbounded garbage.

**How to apply:** This is done. If issues arise with session continuity, check the state file quality and dream cycle, not th...

PAN needs a structured feature registry that gets injected into every new Claude session's context.

**Why:** Each new Claude session is "the first Claude" — it has no weight-level memory of PAN. The only way to give it full knowledge is context injection. Features are currently scattered across CLAUDE.md, memory files, and code comments. A single structured registry would let any Claude instantly know everything PAN can do.

**How to apply:**
1. Create a feature registry (FEATURES.md or JSON) listing every PAN feature with: name, status, components, how it works
2. Include it in the context b...

License: AGPL-3.0 with a custom addendum that forks cannot remove or reassign the default PAN treasury wallet address without explicit permission from the project owner.

**Why:** Monetization is protocol-level through Cardano blockchain data staking fees (1% per transaction), not license fees. Anyone who stakes data through any PAN deployment (including commercial forks) pays 1% to the PAN treasury via smart contract. Users/companies who don't stake pay nothing.

**How to apply:** When drafting LICENSE, use standard AGPL-3.0 text + addendum about treasury wallet. Don't add license-fee clauses...

## LM Studio
- Proprietary freeware (NOT open source), free to use
- Local LLM inference server, exposes OpenAI-compatible API on localhost:1234
- Runs GGUF models from Hugging Face (Llama, Qwen, DeepSeek, Gemma, etc.)
- Has CLI tool `lms` and headless daemon `llmster`
- NOT a coding agent — it's a model server/backend

## OpenCode
- Fully open source (MIT license), 95K+ GitHub stars
- Terminal-based AI coding agent written in Go — open-source Claude Code clone
- Has bash execution, file read/write/edit, grep, glob (same tools as Claude Code)
- Supports 75+ LLM providers: Anthropic, OpenAI, Ge...

# PAN as MCP Memory Server

PAN exposes its database as an MCP server so any Claude interface (app, Code, API) can read/write PAN memory.

## Architecture
- PAN Node.js server hosts MCP endpoint alongside existing REST API
- Claude app connects via MCP → queries PAN DB for context, writes memories back
- Claude Code already writes to PAN DB via hooks — MCP formalizes this
- Any future interface (Discord bot, phone app, web) uses the same MCP endpoint

## Tiered Access
- **Command hub** (Claude Code terminal) — full access, unrestricted
- **Claude app / external** — sandboxed read/write with ra...

Built on 2026-03-30 but NOT YET TESTED in production:
- Three-tier vector memory (episodic, semantic, procedural) — service/src/memory/
- Evolution pipeline (6-step) — service/src/evolution/engine.js
- Upgraded dream cycle — now runs evolution + state update
- Ollama auto-boot — service/src/memory/ollama-boot.js
- Memory consolidation on SessionEnd hook

**Why:** All modules load clean and basic store/recall tested in isolation, but we haven't verified: dream cycle still works end-to-end, evolution pipeline produces sane config changes, consolidation extracts useful memories from real events, ...

Phone AI routing: Cerebras online, OS-provided local model offline, regex fallback.

**Why:** Local models add latency vs just calling Cerebras. Regex covers 80% of offline cases. Bundling a model (Qwen) is unnecessary — use whatever the phone OS already provides.

**How to apply:**
1. Online → Cerebras (fast, free tier)
2. Offline → OS on-device model for classification (not bundled model)
3. Fallback → regex classifier in `classifyLocally()` (PanForegroundService.kt:1301)

On-device model abstraction — detect and use whatever's available:
- Google AICore (Gemini Nano) — Pixel 8 Pro+
- Samsun...

PAN Hub is the organizational layer on top of personal PAN instances.

**Architecture:**
- PAN = personal (your phone, PC, sensors, data)
- PAN Hub = organizational server(s) managing all employees' PAN instances
- Tailnet switching = device moves between personal and work tailnets based on geofencing/email/enrollment

**Core features:**
- RBAC — roles define what each user can see/do/configure
- Geofencing — auto-enrolls devices, auto-enables required sensors when entering a zone
- Sensor policy enforcement — org defines mandatory sensors per role/location, PAN enforces
- Full audit trail — e...

PAN pendant (ESP32-S3 wearable) mounts to clothing via two-piece magnetic sandwich — same mechanism as magnetic scarf brooches/lapel mic mounts.

**Design:**
- One magnet embedded in the PAN device enclosure (outer piece, visible)
- One flat backing magnet goes inside the shirt (hidden)
- Fabric sandwiched between, zero modification to clothing
- Works on any shirt — no pockets, clips, or velcro needed

**Prototype:** Two flat square neodymium magnets, 3D printed enclosure for the device half.

**Consumer vision:** Stylish decorative outer piece (heart-shaped for women, sleek disc for men). Th...

Remote access via embedded tsnet is **WORKING** as of 2026-03-27.

**Resolved:** VPN route fix (dummy TEST-NET-2 route), Go proxy Dial timeout increased to 30s, all API calls successfully reroute through Tailscale tunnel with 120-150ms latency.

**Full stack working:**
- tsnet starts, VpnService establishes TUN
- Tailscale auth — pan-phone registered on tailnet (tail0acfd.ts.net)
- Local TCP proxy tunnels OkHttp connections through tsnet
- Dashboard toggle per device, phone auto-polls settings every 30s
- Device settings API: GET/PUT /api/v1/devices/:id/settings
- SharedRemoteAccessManager syn...

Sensor data should be organized into categories (camera, GPS, gas, mic, etc.) with each category having its own dashboard section and phone app section.

**Core concept:** Any sensor can be attached to any other category if applicable. Taking a picture? Toggle whether GPS coordinates get attached. Gas sensor reading? Toggle whether GPS gets attached. It's mix-and-match per category.

**Master mute/unmute:** Each sensor has a global toggle. Muting GPS means nothing gets GPS across all categories. Turning it back on restores all previous per-category settings (settings are preserved, not erased)...

# Spatial Mapping Vision for PAN

Three-layer spatial architecture:
- **MICRO** — indoor rooms via COLMAP photogrammetry (pendant camera)
- **MESO** — personal routes, frequent locations (GPS, BMI270, Pixel)
- **MACRO** — world layer, bridges to Google Earth / OpenStreetMap

## COLMAP as PAN Module
- Video walkthrough captured via Pixel 10 Pro or pendant camera
- COLMAP runs on ASUS G16 (GPU-accelerated), produces point cloud + mesh
- Post-processed into room JSON schema (id, area, sensors, adjacency)
- Stored in PAN `spatial/` module as persistent versioned home map
- Camera pose data = free ...

## Current Status (2026-04-01)

### Working / Solved
- **SQLCipher encryption — DONE** (migrated 2026-03-31, AES-256-CBC, better-sqlite3-multiple-ciphers, key in pan.key)
- PAN service restart — WORKING
- Dashboard naming: Chat→Conversation, sidebar Chat→Transcript
- Terminal input rename: voiceInput*→terminalInput*, directTerminal→directMode
- Image/text paste single-Enter — SOLVED
- Terminal scrollbar jump on tool calls — SOLVED
- Chat/transcript scrollbar jump — SOLVED
- Smart scroll (position restore on refresh) — SOLVED
- Context briefing injection — SOLVED
- Dashboard chat full transcrip...

PAN Hub remote access will use Tailscale instead of custom WireGuard or relay server.

**Why:** Tailscale is already trusted by the user, handles NAT traversal, gives stable hostnames per device. Also solves Google OAuth redirect URI issue since devices get consistent hostnames instead of changing LAN IPs.

**How to apply:** When building remote access features, assume Tailscale is the connectivity layer. Don't build custom VPN/relay infrastructure. Make Tailscale optional but recommended — enterprise users may have their own solution.

# Universal Panel System (designed 2026-03-31)

Both left and right panels in the terminal page are identical containers with a `<select>` dropdown. Any widget can go in any panel.

**Core widgets (always available):**
- Transcript (conversation history)
- Project (progress, milestones)
- Services (live service status with dots)
- Tasks (project tasks with milestones)
- Bugs (issue tracking)
- Devices (connected devices — phones, pendants, vehicles)
- Setup Guide

**Project-specific widgets (added per-project):**
- Air traffic: Aircraft, Ground Units, Zones
- Any project can register custom wi...

# PAN Development Velocity Tracker

## Efficiency Metric
**How it's calculated:** Estimate how long a traditional team (multiple specialists) would take to deliver the same output, divide by actual time spent.

## Daily Logs

### 2026-03-25 (two sessions)
- **Output:** Remote access full stack (6 parallel features), voice permission approval, device settings API, phone auto-polling, dashboard toggles
- **Traditional estimate:** ~6-8 weeks across Android dev, backend dev, frontend dev
- **Actual time:** Full day (~8 hours)
- **Efficiency: ~15,000-20,000%**
- **Notes:** Heavy parallel agent usag...

Voice hotkeys (mouse side buttons for whisper dictation + Win+H) require AutoHotkey v2 runtime.

**Why:** Windows 11 silently blocks low-level mouse hooks from .NET/managed processes. A C# exe with SetWindowsHookEx(WH_MOUSE_LL) installs the hook successfully but the callback never fires. AHK uses native C hooks that Windows trusts.

**How to apply:**
- Voice.ahk is at `C:\Users\tzuri\OneDrive\Desktop\Voice.ahk`
- AHK v2 runtime at `C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe`
- Watchdog starts it as admin and monitors/restarts
- For PAN installer: bundle AutoHotkey64.exe + Voice.ahk + GPL ...

## Android App Build & Deploy

```bash
# Build debug APK (from any directory)
cd /c/Users/tzuri/OneDrive/Desktop/PAN/android && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew.bat assembleDebug

# Install to connected phone via ADB
/c/Users/tzuri/AppData/Local/Android/Sdk/platform-tools/adb.exe install -r app/build/outputs/apk/debug/app-debug.apk

# Build + install in one shot
cd /c/Users/tzuri/OneDrive/Desktop/PAN/android && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew.bat installDebug

# Check connected devices
/c/Users/tzuri/AppData/Local/Android/Sdk/p...

GitHub username: **Tereseus** (changed from Tzuridis)
Repo: https://github.com/Tereseus/PAN
Pages: https://tereseus.github.io/PAN/

Remote origin should be `https://github.com/Tereseus/PAN.git`

When linking externally, use the Pages URL.

## Development Environment

**OS:** Windows 11 Home
**Terminal:** WezTerm — config at `~/.wezterm.lua`
**IDE:** VS Code (assumed from Claude Code extension usage)
**Shell:** Bash (via Git Bash / MSYS2 on Windows)
**Package Manager:** npm (Node.js projects), Gradle (Android)
**Version Control:** Git + GitHub
**AI Tools:** Claude Code CLI (subscription), Gemini (phone-side)

## Term Mapping — What the User Means

| User says | They mean |
|-----------|-----------|
| "terminal" | WezTerm |
| "scrollbar" (in terminal context) | WezTerm scrollbar, check ~/.wezterm.lua |
| "the chat" | Dashboard cha...

The About PAN page at https://tereseus.github.io/PAN needs to be rebuilt.
Currently it's for an old Alexa app — needs to be updated to describe PAN.

**Why:** Users need a public-facing help/about page for PAN.

**How to apply:** This is a GitHub Pages site in a separate repo. Rebuild with current PAN info when working on public-facing features.

### Recent Conversation
**User** (2026-04-01 14:53:14): OK so we just worked on the TED GL Services computer it's still red it went back to being red That's still a problem and the approvals take way too long to go away like I said yes so so long ago And t
**User** (2026-04-01 14:56:39): What the fuck are you doing are you adding new shit like what are you adding a new tab The approvals clearly exist in the same area where Services Transcript Project all that shit lives I don't know w
**Claude** (2026-04-01 14:57:06): TedGL will stay green now. 

For the approvals — the API says the queue is empty (`"permissions": []`), so the server processed them. The dashboard UI just isn't picking that up. What does the approvals tab show you right now — is it a specific approval that's stuck, or just the "(1)" count that won
**User** (2026-04-01 14:58:03): [Image #4] Whatever just just focus on fixing the voice to text the voice input hold to speak button beside the input box at the bottom right here
**User** (2026-04-01 15:03:37): Like what the fuck are you doing like I don't it's it's it's literally part of the spelled app SVELTE I don't know what the fuck you're doing this exists on its belt as an HTML page right we have an i
**User** (2026-04-01 15:04:57): No it definitely exists it definitely fucking exists i'm literally fucking using it right now I think you've become so bad that I'm literally going to end this session whatever you just added get that
**Claude** (2026-04-01 15:05:41): I'm going to be straight with you — I've been going in circles and making things worse. I'm confused about the dashboard codebase because previous sessions modified the built JS directly without updating the Svelte source, so what you see running doesn't match what I see in the source files.

You sh
**Claude** (2026-04-02 08:11:16): Build succeeded. Refresh the dashboard and you should see:

1. **Center panel** now has 3 tabs: **Terminal | Chat | Atlas**
2. **Right panel dropdown** now has **Apps** option (between Bugs and Setup Guide)
3. Click **Atlas** tab or click the Atlas app card in the Apps panel to see the architecture 
**Claude** (2026-04-02 08:30:35): Build succeeded. Here's what I fixed:

**Chat transcript now persists across page refresh:**

1. **`sessionStorage` backup** — every time chat loads from server, it saves the last 200 messages to `sessionStorage`. On page refresh, these are instantly restored before the server even responds.

2. **N
**Claude** (2026-04-02 08:42:23): Good. Here's what was fixed:

**3 layers of defense against refresh creating new sessions:**

1. **Buffer detection** — When the WebSocket connects and the server sends back existing output (>100 bytes), `hasExistingBuffer` is set to `true`. The auto-launch check now requires `!hasExistingBuffer` in
**User** (2026-04-02 08:43:23): So no that's not correct so OK why do we have these instances if you can't launch a dev instance to test it yourself and then you can see what happens in the dev instance what what the fuck is the poi
**Claude** (2026-04-02 09:04:36): Here's what I built:

**Refresh fix (3 layers of defense):**
1. **Buffer detection** — if PTY sends back existing output, skip auto-launch (the real signal)
2. **localStorage session persistence** — saves/restores session IDs across refresh via `beforeunload` + periodic save
3. **Chat in localStorag
**Claude** (2026-04-02 12:40:24): I found the root cause. The PAN service daemon runs from `C:\Users\tzuri\OneDrive\Desktop\PAN\` but I've been looking at `C:\Users\tzuri\Desktop\PAN\` — **two different copies**. The OneDrive version (what actually runs) is missing:

1. The `claude-usage` endpoint entirely
2. The `readdirSync`, `sta
**Claude** (2026-04-02 12:45:19): I need write permission to `C:\Users\tzuri\Desktop\PAN\service\src\server.js`. The edit:

1. **Removes the broken Anthropic OAuth API call** (returns 401 "OAuth authentication not supported")
2. **Reads `stats-cache.json`** — already has aggregated token usage (928K input, 1.7M output for Opus 4.5, 
**Claude** (2026-04-02 15:30:30): Everything fixed. Here's the summary:

**Files updated (old OneDrive path → new Desktop path):**
- `pan-start.ps1` — now uses `$PSScriptRoot` (dynamic, move-proof)
- `watchdog.ps1` — now uses `$PSScriptRoot` (dynamic, move-proof)
- `electron/main.cjs` — "Open PAN Folder" now uses `__dirname` (dynami

### Last Messages (Full)
**Claude** (2026-04-02 08:42:23):
Good. Here's what was fixed:

**3 layers of defense against refresh creating new sessions:**

1. **Buffer detection** — When the WebSocket connects and the server sends back existing output (>100 bytes), `hasExistingBuffer` is set to `true`. The auto-launch check now requires `!hasExistingBuffer` in addition to `!isReconnect`. So even if the reconnect flag is wrong, Claude won't re-launch into an existing session.

2. **localStorage session persistence** — Session IDs, project names, and CWDs are saved to `localStorage` every 5 seconds AND on `beforeunload`. On page load, if the server API returns no sessions (race condition, timeout), the saved state is used as fallback — and reconnects with `isReconnect=true`.

3. **Chat persistence via localStorage** — Switched from `sessionStorage` to `localStorage` so chat survives even if the tab is closed and reopened. Also saves on `beforeunload` as backup.

Refresh the dashboard and test. The terminal should reconnect to the existing Claude session without starting a new one.

**User** (2026-04-02 08:43:23):
So no that's not correct so OK why do we have these instances if you can't launch a dev instance to test it yourself and then you can see what happens in the dev instance what what the fuck is the point if you can't test that way every UI change that we do should be tested that way so that I don't lose context so I don't lose your here that bullshit You you need to make it so that the the testing of the UI and the stupid fucking shit that comes with all the things that we do doesn't happen You need to understand what happens you have to be able to debug it you have to see hey it restarted hey the transcript is not there

**Claude** (2026-04-02 09:04:36):
Here's what I built:

**Refresh fix (3 layers of defense):**
1. **Buffer detection** — if PTY sends back existing output, skip auto-launch (the real signal)
2. **localStorage session persistence** — saves/restores session IDs across refresh via `beforeunload` + periodic save
3. **Chat in localStorage** — switched from sessionStorage (fragile) to localStorage (survives everything)

**Dev testing infrastructure:**
- Vite dev server uses isolated `dev-dash-*` session IDs (won't touch Prod)
- Proxy config routes API/WS to PAN server (port 7777)
- `+layout.js` fixes SSR issues in dev mode
- Instances panel in right sidebar (Prod/Dev/Test)
- `/api/v1/dev/start` endpoint detects running dev server

**MCP server updated:**
- `pan_dev` tool with full testing guide, session checklist, and key file locations
- Every future session will know how to test before deploying

**MCP auto-approval:**
- Added `.mcp.json` to `OneDrive/Desktop/PAN/` so Dev sessions find the MCP config
- `enableAllProjectMcpServers: true` already set globally

Refresh the Prod dashboard to pick up the changes. Want me to start a proper Dev test of the refresh behavior now?

**Claude** (2026-04-02 12:40:24):
I found the root cause. The PAN service daemon runs from `C:\Users\tzuri\OneDrive\Desktop\PAN\` but I've been looking at `C:\Users\tzuri\Desktop\PAN\` — **two different copies**. The OneDrive version (what actually runs) is missing:

1. The `claude-usage` endpoint entirely
2. The `readdirSync`, `statSync`, `https` imports needed for it

I need write permission to `C:\Users\tzuri\OneDrive\Desktop\PAN\service\src\server.js` to add the usage endpoint there. Can you approve the edit?

**Claude** (2026-04-02 12:45:19):
I need write permission to `C:\Users\tzuri\Desktop\PAN\service\src\server.js`. The edit:

1. **Removes the broken Anthropic OAuth API call** (returns 401 "OAuth authentication not supported")
2. **Reads `stats-cache.json`** — already has aggregated token usage (928K input, 1.7M output for Opus 4.5, 251K input, 919K output for Opus 4.6, total 57K messages across 31 sessions)
3. **Reads subscription info** from `.credentials.json` (Max plan, 5x tier)
4. **Still scans JSONL files** for live session token counts
5. **Returns real data** instead of zeros

Can you approve the edit?

**Claude** (2026-04-02 15:30:30):
Everything fixed. Here's the summary:

**Files updated (old OneDrive path → new Desktop path):**
- `pan-start.ps1` — now uses `$PSScriptRoot` (dynamic, move-proof)
- `watchdog.ps1` — now uses `$PSScriptRoot` (dynamic, move-proof)
- `electron/main.cjs` — "Open PAN Folder" now uses `__dirname` (dynamic)
- `daemon/pan.xml` — updated hardcoded paths
- `bin/Voice.ahk` — updated to new path
- `src/pan-voice.cs` — updated to new path
- `.pan` — updated metadata paths

**Windows integration:**
- Start Menu shortcut → recreated pointing to `C:\Users\tzuri\Desktop\PAN\PAN.bat`
- Startup shortcut → recreated (auto-launches on boot)
- Windows Service → uninstalled old, reinstalled with new path, **running now**

Server is up, 34s uptime, Tailscale connected. You should be able to launch PAN from the Start Menu now.

<!-- PAN-CONTEXT-END -->

## Current Focus (updated 2026-03-25)

### What we're working on right now:
1. **Context briefing injection** — Fixed: LIKE query used single backslashes but DB stores JSON-escaped double backslashes. Now correctly matches both UserPromptSubmit and Stop events so Claude responses appear in the briefing.
2. **Dashboard chat showing full transcripts** — Built JSONL transcript parser (`/api/transcript`). Fixed double-prefix bug (`/dashboard/dashboard/...`). Code written but uncommitted.

### Active bugs:
- Terminal scrollbar jumps to bottom on any update (MOST ANNOYING)
- Classifier tags ambient speech as "query"
- Chat scrollbar same jump issue

### Next up:
- Sensor categories on dashboard
- Dashboard panel resize/zoom/hide
- Per-sensor toggle buttons
- About PAN page rebuild (tereseus.github.io/PAN)
