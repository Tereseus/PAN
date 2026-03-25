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

This terminal exists solely to manage the PAN server process. When user says restart, just run `node pan.js start` again without questions.

**Why:** User corrected Claude for asking unnecessary confirmation instead of just restarting the service.

**How to apply:** When user says start/stop/restart, do it immediately. No confirmation needed. Run `node pan.js start` in the service directory.

Every project launched by PAN should have its development environment mapped in memory so Claude knows what the user is referring to without them having to use precise technical names.

**Why:** User said "terminal scrollbar" and Claude wasted time investigating the web dashboard's xterm.js code instead of WezTerm config. An average person shouldn't have to specify "WezTerm" — saying "terminal" should be enough.

**How to apply:**
1. When starting a PAN project session, the tools stack memory should already be loaded
2. When user mentions a component by a casual name ("terminal", "the app", "s...

PAN Hub (cloud relay) doubles as a data marketplace for enterprise.

**Why:** Users generate valuable behavioral/sensor data running PAN locally. AI companies want training data. PAN can broker this.

**How to apply:** When designing the Hub and org system, keep data flow architecture compatible with:
- Local PII stripping before any data leaves the user's machine
- Anonymized data aggregation at the hub level
- "Staking" mechanism where users opt-in their data for AI training revenue
- This is beyond the core org system — separate future phase after Hub is working

SOLVED (2026-03-25): Context reload is now handled by:
1. `.pan-state.md` — living state file maintained by dream cycle (rewrites, never appends)
2. `/api/v1/context-briefing` — endpoint serves state file + recent chat to fresh sessions
3. Dashboard auto-injects briefing when launching Claude in terminal tabs

**Why:** --continue caused throttling from massive context. JSONL grep was too slow and inaccurate. Individual memory_items rows in DB created unbounded garbage.

**How to apply:** This is done. If issues arise with session continuity, check the state file quality and dream cycle, not th...

Sensor data should be organized into categories (camera, GPS, gas, mic, etc.) with each category having its own dashboard section and phone app section.

**Core concept:** Any sensor can be attached to any other category if applicable. Taking a picture? Toggle whether GPS coordinates get attached. Gas sensor reading? Toggle whether GPS gets attached. It's mix-and-match per category.

**Master mute/unmute:** Each sensor has a global toggle. Muting GPS means nothing gets GPS across all categories. Turning it back on restores all previous per-category settings (settings are preserved, not erased)...

## Current Status (2026-03-25)

**Memory system overhaul completed:** Living state file (.pan-state.md) replaces old dream cycle DB pollution. Uncommitted changes in dream.js, classifier.js, server.js, dashboard.js, index.html.

## What's Actually Working
- Phone app (voice, STT, TTS, local commands)
- Permission prompt (mobile approval end-to-end)
- Context briefing (fresh sessions, no --continue)
- Dashboard terminals, chat, project tracking
- Calendar voice commands
- Scout, AutoDev, FTS5 search
- Regular Gemini + Google Assistant for on-device AI (Gemini Nano not needed)
- Some streaming s...

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

When linking to PAN externally (GitHub issues, docs, etc.), always use https://tereseus.github.io/PAN/ — not the GitHub repo URL.

**Why:** User preference — this is the public-facing project page.

**How to apply:** Any time PAN is referenced in issues, PRs, external communication, use this URL.

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

### Open Tasks
- [todo P1] Smart device routing — default device (auto/nearest) determines where actions execute
- [todo P1] Chat shows only bookend events — need intermediate responses visible
- [todo P1] Terminal scroll still janky — jumps on tool calls
- [todo P1] mDNS auto-discovery on local network (zero-config device finding)
- [todo P1] PAN Hub relay server for remote access (HTTPS message broker)
- [todo P1] Phone auto-discovers PAN server on WiFi (replace manual IP entry)
- [todo P1] Multi-user accounts — user registration, login, session ownership
- [todo P1] Multi-database — per-team databases with isolated data
- [todo P1] PAN Hub — central server aggregating multiple PAN instances
- [todo P1] Smart scroll — remember exact scroll position, restore on every refresh/update/tool call

### Recent Conversation
**User** (2026-03-25 19:32:15): Or do we put anything in there this is a memory whateverIt clearly has text in it doesn't it Would it be way too long someone to open up an actual read actual read That would that would give you a nic
**User** (2026-03-25 19:34:00): <task-notification>
<task-id>bs0omh667</task-id>
<tool-use-id>toolu_017xJNLVvfcBuNkAwoUDG54Y</tool-use-id>
<output-file>C:\Users\tzuri\AppData\Local\Temp\claude\C--Users-tzuri-OneDrive-Desktop-PAN\e92
**Claude** (2026-03-25 19:34:00): The Memory tab now shows **real Claude memory files** — the actual `.md` files from `~/.claude/projects/*/memory/`. Each one reads like a story:

- **Project Status** — what's working, what's broken, priorities
- **Feedback** — how you like Claude to work (don't ask to restart, map casual names to t
**Claude** (2026-03-25 19:34:03): Server's up. Refresh the dashboard and check out the Memory tab.
**Claude** (2026-03-25 19:45:47): Now the dashboard should work. Refresh the page (`localhost:7777/dashboard`) — the syntax error is fixed. 

**What was broken:** Line 2325 had a nested template literal where `${typeColors[t] || 'var(--bg3)'}` inside a backtick-delimited string caused `var` to be parsed as a JavaScript keyword. This
**User** (2026-03-25 19:46:39):  ▐▛███▜▌   Claude Code v2.1.83

▝▜█████▛▘  Opus 4.6 (1M context) · Claude Max

  ▘▘ ▝▝    ~\Desktop



❯ Hey can you look at my pan folder I have a project in there it's basically running Claude and t
**User** (2026-03-25 19:47:22): I don't know if it's like a double tab or something I'm restarting it myself by ending the node pan JS I have so maybe there's two of them
**Claude** (2026-03-25 19:47:35): Just one instance — PID 5024 is the only one listening. The TIME_WAITs are just old closed connections. You're good, only one server running. Go ahead and restart it yourself and then refresh the dashboard to see the new Memory tab.
**User** (2026-03-25 19:49:22): Well I restarted it myself At you restart it it still says this[Image #1]
**Claude** (2026-03-25 19:49:49): The code IS updated on disk. The running server just hasn't loaded it. You need to kill the current node process and start it fresh. The server that's running right now was started before the code change.

Try killing it and starting again — make sure you kill the old one first so port 7777 is free.
**User** (2026-03-25 19:51:26): is the server still up
**User** (2026-03-25 19:51:42): I closed mine
**Claude** (2026-03-25 19:51:42): Yeah it's still up. And yes — if you're talking to me through PAN, that means the server is running. The problem is it's running the **old** code from before my changes. You need to fully kill it and restart for the new memory API to take effect.

Want me to kill it and restart it?
**Claude** (2026-03-25 19:52:06): PID 5024 is still holding port 7777. That's the stale one running old code. Want me to kill it and restart with the new code?
**User** (2026-03-25 19:52:10): Yes

### Last Messages (Full)
**Claude** (2026-03-25 19:49:49):
The code IS updated on disk. The running server just hasn't loaded it. You need to kill the current node process and start it fresh. The server that's running right now was started before the code change.

Try killing it and starting again — make sure you kill the old one first so port 7777 is free. You said you're restarting it yourself, so go ahead and do that. Once the new server process starts, it'll read the updated `dashboard.js` and the Memory tab will show the real Claude memory files.

**User** (2026-03-25 19:51:26):
is the server still up

**User** (2026-03-25 19:51:42):
I closed mine

**Claude** (2026-03-25 19:51:42):
Yeah it's still up. And yes — if you're talking to me through PAN, that means the server is running. The problem is it's running the **old** code from before my changes. You need to fully kill it and restart for the new memory API to take effect.

Want me to kill it and restart it?

**Claude** (2026-03-25 19:52:06):
PID 5024 is still holding port 7777. That's the stale one running old code. Want me to kill it and restart with the new code?

**User** (2026-03-25 19:52:10):
Yes

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
