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
- **Database**: SQLCipher-encrypted SQLite via better-sqlite3-multiple-ciphers (AES-256-CBC, key in AppData/Local/PAN/data/pan.key)

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



## Current Focus (updated 2026-03-31)

### Active work (2026-03-31):
- Dashboard naming cleanup (Conversation/Transcript/Chat/Terminal) — DONE
- Input paste fix (image + text single-Enter via pendingSend queue) — TESTING
- Dream cycle set to 12h — DONE
- Double memory injection — FIXED (hooks.js skips memory files)

### Roadmap by category:

**Security (foundation — do first):**
- Database encryption (SQLCipher) — DONE (2026-03-31, uncommitted)
- NER anonymization (Presidio/spaCy) — NOT DONE
- Data capture controls (user chooses what events get logged) — NOT DONE
- Facial recognition (auth/identity) — NOT DONE
- Permission caching on phone (no spam, server reply-back) — NOT DONE

**PAN Hub (requires security + multi-user):**
- Multi-user accounts + RBAC (roles, permissions)
- Per-org isolated databases
- Geofencing (auto-enroll devices, enforce sensors by zone)
- Tailnet auto-switching (personal ↔ work)
- Sensor policy enforcement
- Full audit trail (every toggle logged, user + management transparency)
- Data dividends (sensor data at scale → revenue)

**Dashboard/UI:**
- Sensor category grouping — NOT DONE (toggles work, grouping doesn't)
- Panel resize/zoom/hide
- Electron webview icon bug (shows Electron icon instead of app's)
- Mobile top bar distortion on scroll

**Device/Connectivity:**
- Smart device routing (default device, pendant routing)
- mDNS auto-discovery (zero-config LAN)

**Later:**
- Classifier ambient speech filtering
- One-click installer + guided setup tutorial
- AutoDev/Scout full autonomy

<!-- PAN-CONTEXT-START -->
## PAN Session Context

This is a fresh session for the "PAN" project.
IMPORTANT: The project documentation is at the TOP of this CLAUDE.md file — read it first.

**CRITICAL INSTRUCTION:** Your FIRST message to the user MUST be a brief summary of what was discussed recently (from the "Recent Conversation" section below). Start with something like "Last time we were working on..." and list the key topics/issues. The user should never have to ask what they were working on — you tell them immediately.

### PAN Features (Auto-Injected)

The complete feature registry is in FEATURES.md. Reference it when the user mentions any PAN feature.
Key: You ARE PAN. These are YOUR features. When the user says "remember your features" or "you can do X" — this is what they mean.

### Open Tasks
- [todo P1] Intuition service — dimensional state engine (Qwen phone + Cerebras 120B + Claude background state writer)
- [todo P1] Bring back Qwen 0.6B on phone — re-enable llama.cpp, download GGUF, wire into dimension classifier
- [todo P1] Cerebras switch to 120B — faster (220ms vs 500ms) and cheaper than 235B
- [todo P1] Sticky state — skip Qwen on continuation turns, use cached dimensional state
- [todo P1] Tab flash on pending approvals — terminal tab should visually flash
- [todo P1] Phone approval staleness fix — accepted/denied approvals re-appearing
- [todo P1] Services panel — restart server to activate /dashboard/api/services endpoint
- [todo P1] Smart device routing — default device (auto/nearest) determines where actions execute
- [todo P1] mDNS auto-discovery on local network (zero-config device finding)
- [todo P1] PAN Hub — multi-user, RBAC, geofencing, tailnet switching
- [todo P1] NER anonymization (Presidio/spaCy)
- [todo P2] Terminal center swappable — video, maps, web content not just terminal
- [todo P2] Project-specific widgets — custom panels per-project (e.g. Aircraft for ATC)
- [todo P2] Tailnet handoff — geofenced zone transfer between PAN instances

### Recent Conversation
**User** (2026-03-31 20:35:43): No get you why do you keep asking me for so many permissions just send me one fucking permission to push you've asked me like 35 times for permissions I go and I do something else so send me the fucki
**Claude** (2026-03-31 20:39:00): OK here's everything measured, all real data:

**Cerebras actual benchmarks (just measured right now):**

| Model | 100 tokens | 500 tokens | 2K tokens | 5K tokens | 10K tokens |
|---|---|---|---|---|---|
| **8B** | 336ms | 342ms | 470ms | 772ms | ~400ms* |
| **120B** | 329ms | 214ms | 220ms | 280ms
**Claude** (2026-03-31 20:40:55): Push permission sent. Accept it when it pops up — that's the only one you need.
**User** (2026-03-31 20:47:22): Well if it got when we get on device AI for the phone Gemini Nano whatever that's equal to device right so we would win a lot of speed there or would it be like the same really I guess we won't know u
**Claude** (2026-03-31 20:48:04): Sticky state absolutely works. Here's why:

**Human conversation doesn't change state every sentence.** If you're stressed, you're stressed for minutes, not milliseconds. If you're talking to PAN, the next sentence is probably also to PAN. The state drifts slowly. Claude updating every 10 seconds is
**User** (2026-03-31 20:50:43): Yeah awareness awareness makes sense Sensorium that's a cool that's a funny word Sentient you know that's you kind of going in a awareness kind of seems like your presence See awareness kind of seems 
**User** (2026-03-31 20:51:25): ΠΑΝ remembers... Start session. Read CLAUDE.md and give the session continuity summary.
**Claude** (2026-03-31 20:51:41): Last time we were working on:

- **Cerebras speed benchmarks** — measured real latency for 8B, 120B, and 235B models. The 120B sweet spot: ~250-380ms total round-trip, ~$2/month at 200 calls/day. You called it "stupidly fast."

- **Sticky state architecture** — designed the flow where Claude runs as
**Claude** (2026-03-31 20:52:19): Saved. Pick your names when you're ready — we can always change them later. The architecture is locked in. What do you want to tackle next?
**User** (2026-03-31 20:52:59): Yeah make make the watcher be steward I actually don't even see that as a scheduled job in the automation or what I think it would be in the automation right intuition Yeah I guess we can do into intu
**Claude** (2026-03-31 20:55:14): Done. Names are set:

- **Steward** — process health monitor (renamed from Watcher, `watchdog.ps1` updated)
- **Intuition** — the consciousness/state engine (to be built)
- **Guardian** — security service (future, when we build auth)

The automation page needs a **Services** tab added to show these 
**User** (2026-03-31 20:58:04): Should it be shown there or should it be shown in the right pan Similar to all how Tasks and Bugs and Setup guide are and it just has a services tab there What do you think And I guess we can make it 
**Claude** (2026-03-31 20:58:17): Right panel makes way more sense. The automation page is for configuring scheduled jobs. Services are live status — you want to glance at them while working in the terminal, not navigate to a separate page.

So the right panel tabs become: **Tasks | Bugs | Services | Setup Guide**

Services tab show
**User** (2026-03-31 20:59:01): And right so like different different applications can list different services there as well so you'll always have guardian and intuition and Stewart and all that stuff that are pan central right and 
**Claude** (2026-03-31 21:04:00): Built. Now the right panel has a **Services** tab (default) showing:

- **PAN Core** section:
  - PAN Server — green dot, uptime, PID
  - Steward — green/yellow based on last heartbeat
  - Intuition — grey (offline, not yet built)
  - Phone Link — green if phone connected in last 60s
  - Dream — las

### Last Messages (Full)
**User** (2026-03-31 20:58:04):
Should it be shown there or should it be shown in the right pan Similar to all how Tasks and Bugs and Setup guide are and it just has a services tab there What do you think And I guess we can make it you know have real time updates of of lights and stuff when things go down or up or whatever And then I guess if like the you know the steward finds a problem they can list the problem there so you have a faster access to see that stuff What do you think

**Claude** (2026-03-31 20:58:17):
Right panel makes way more sense. The automation page is for configuring scheduled jobs. Services are live status — you want to glance at them while working in the terminal, not navigate to a separate page.

So the right panel tabs become: **Tasks | Bugs | Services | Setup Guide**

Services tab shows:
- Green/red dots for up/down
- Service name + uptime
- If Steward detects a problem, it shows inline — "PAN Server restarted 2m ago" or "Whisper STT down — retrying"

Quick, always visible, no page navigation needed. Want me to build it?

**User** (2026-03-31 20:59:01):
And right so like different different applications can list different services there as well so you'll always have guardian and intuition and Stewart and all that stuff that are pan central right and then you can have project specific ones so like air traffic controller could have like radar or whatever so you can have like sections of categories in there that's easily done right so yeah we just need that stuff uptime and then you know yeah exactly I think that's perfect

**Claude** (2026-03-31 21:04:00):
Built. Now the right panel has a **Services** tab (default) showing:

- **PAN Core** section:
  - PAN Server — green dot, uptime, PID
  - Steward — green/yellow based on last heartbeat
  - Intuition — grey (offline, not yet built)
  - Phone Link — green if phone connected in last 60s
  - Dream — last run time
  - Scout — last run time

- **Recent Issues** section (if Steward logged any restarts)

- Project-specific services will show up when configured via `project_services` setting

Refresh the dashboard and check the Services tab on the right panel. It defaults to Services now instead of Tasks.

<!-- PAN-CONTEXT-END -->
