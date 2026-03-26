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

Always capitalize titles, labels, and dynamically rendered names in the dashboard UI. Never display raw lowercase keys like `scout`, `dream`, `autodev`, `project_sync` — use proper display names like "Scout", "Dream", "AutoDev", "Project Sync".

**Why:** User was frustrated that the Automation > Jobs list was rendering feature names in lowercase (e.g., "scout" instead of "Scout"). This applies broadly to all UI labels.

**How to apply:** When rendering any key/identifier as a UI label, always map it to a properly capitalized display name. Use a display name map or capitalizer function. This ap...

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
**User** (2026-03-25 22:02:50): This is a fresh session. Read the PAN session context injected into CLAUDE.md. Summarize what we were working on last time — start with Last time we were working on and list the key topics. Then ask w
**Claude** (2026-03-25 22:03:00): Last time we were working on:

1. **Session context injection** — getting the `.pan-briefing.md` content to inject into CLAUDE.md before Claude reads it on fresh sessions. Fixed a bug where the LIKE query used single backslashes but the DB stores JSON-escaped double backslashes, so Claude responses 
**User** (2026-03-25 22:04:31): Just keep the setup in the desk in the bugs don't make it ever go away just leave it in there That would be set up when you click it to share some of my green text if it's correct to send it your set 
**Claude** (2026-03-25 22:18:25): The permission hook keeps denying. Are you seeing the approval prompt on your phone? It might be that the PAN server's PermissionRequest hook is auto-denying or timing out. 

Try approving on your phone, or if you want to bypass it temporarily, you can type:

`! claude config set-hook PermissionRequ
**User** (2026-03-25 22:28:00): Oh send it to me again
**Claude** (2026-03-25 22:28:54): Done. Here's what changed:

**Setup Guide:**
- Never removed from the dropdown — always stays as an option
- When validated: shows green "✓ SETUP VALIDATED" with model name and provider displayed
- Has a "RE-VALIDATE" button so you can re-check anytime
- Only auto-selects the setup tab on first load
**User** (2026-03-25 22:29:49): Just restarted from the settings and everything just the uptime it never changes running when you click start I still see the project set up in the in the Test and bugs panel so yeah
**User** (2026-03-25 22:30:13): This is a fresh session. Read the PAN session context injected into CLAUDE.md. Summarize what we were working on last time — start with Last time we were working on and list the key topics. Then ask w
**User** (2026-03-25 22:30:28): > ## Last Messages (Full)

> User (2026-03-25 22:29:49):

> Just restarted from the settings and everything just the uptime it never changes running when you click start I still see the project set up
**Claude** (2026-03-25 22:30:28): Last time we were working on:

1. **Session context injection** — Getting fresh Claude sessions to auto-load context from `.pan-state.md` + recent chat into CLAUDE.md so we could stop using `--continue` (which caused throttling). The hook was firing but timing was tricky — Claude sometimes read CLAU
**Claude** (2026-03-25 22:38:46): Here's what I did:

**Restart fixes (server.js):**
- Uptime now resets on restart (`const` → `let`, reset in `start()`)
- Restart button now spawns a **fresh process** and exits the old one — code changes from disk are picked up

**Launcher (new):**
- `PAN.bat` — starts server if not running, opens 
**User** (2026-03-25 22:40:35): This is a fresh session. Read the PAN session context injected into CLAUDE.md. Summarize what we were working on last time — start with Last time we were working on and list the key topics. Then ask w
**Claude** (2026-03-25 22:40:45): Last time we were working on:

1. **Session context injection** — getting the `.pan-briefing.md` + recent chat to inject into CLAUDE.md on fresh session start. The hook was firing but timing was off (Claude reading before write finished). Eventually got it working.
2. **Dashboard HTML breakage** — a
**User** (2026-03-25 22:45:14): Can you get rid of the Gl project
**Claude** (2026-03-25 22:53:56): Done. Here's what I built:

**API:** `DELETE /dashboard/api/projects/:id` — removes all PAN data (tasks, milestones, sections, tabs, the project record itself) and deletes the `.pan` file so sync doesn't re-add it. Session history is preserved (just unlinked from the project).

**UI:** Small ✕ butto

### Last Messages (Full)
**Claude** (2026-03-25 22:30:28):
Last time we were working on:

1. **Session context injection** — Getting fresh Claude sessions to auto-load context from `.pan-state.md` + recent chat into CLAUDE.md so we could stop using `--continue` (which caused throttling). The hook was firing but timing was tricky — Claude sometimes read CLAUDE.md before the write finished. Eventually got it working.

2. **Dashboard HTML broken** — Another Claude session reorganized the Data/Settings/Automation pages into sub-tab layouts and broke the entire dashboard (nothing clickable, tabs dead, terminal won't load). There are 1075 lines of uncommitted changes in `index.html`.

3. **Chat transcripts** — Built a JSONL transcript parser (`/api/transcript`) and fixed a double-prefix routing bug (`/dashboard/dashboard/...`). Code written but uncommitted.

4. **Memory tab** — Working on reading real Claude memory files from `~/.claude/projects/*/memory/` in the dashboard.

5. **Ongoing irritants** — Terminal scroll jumping on updates, classifier tagging ambient speech as "query", duplicate server processes.

The dashboard being broken seems like the most critical issue from last session. What do you want to work on?

**Claude** (2026-03-25 22:38:46):
Here's what I did:

**Restart fixes (server.js):**
- Uptime now resets on restart (`const` → `let`, reset in `start()`)
- Restart button now spawns a **fresh process** and exits the old one — code changes from disk are picked up

**Launcher (new):**
- `PAN.bat` — starts server if not running, opens dashboard in browser
- `PAN.vbs` — silent wrapper (no cmd window flash)
- **Start Menu shortcut** — type "PAN" in Windows search, hit Enter, it starts
- **Startup folder shortcut** — PAN auto-starts on Windows login

Next time you restart your PC, PAN will start automatically. And right now you can press Win, type "PAN", hit Enter.

**User** (2026-03-25 22:40:35):
This is a fresh session. Read the PAN session context injected into CLAUDE.md. Summarize what we were working on last time — start with Last time we were working on and list the key topics. Then ask what I want to work on next.

**Claude** (2026-03-25 22:40:45):
Last time we were working on:

1. **Session context injection** — getting the `.pan-briefing.md` + recent chat to inject into CLAUDE.md on fresh session start. The hook was firing but timing was off (Claude reading before write finished). Eventually got it working.
2. **Dashboard HTML breakage** — another Claude session reorganized the Data, Settings, and Automation pages into sub-tab layouts, breaking clickability/tabs/terminal loading. 1075 lines of uncommitted changes.
3. **Context briefing SQL fix** — the LIKE query used single backslashes but DB stores JSON-escaped double backslashes, so Claude responses weren't appearing in the briefing.
4. **Chat transcripts** — built JSONL transcript parser (`/api/transcript`), fixed double-prefix routing bug.
5. **Known bugs still open** — uptime never resets after restart, setup validation persists after restart, code changes not applying on restart (same-process stop/start doesn't reload from disk), terminal scroll jumps.

What do you want to work on?

**User** (2026-03-25 22:45:14):
Can you get rid of the Gl project

**Claude** (2026-03-25 22:53:56):
Done. Here's what I built:

**API:** `DELETE /dashboard/api/projects/:id` — removes all PAN data (tasks, milestones, sections, tabs, the project record itself) and deletes the `.pan` file so sync doesn't re-add it. Session history is preserved (just unlinked from the project).

**UI:** Small ✕ button on each project card. Requires **two confirms** — first explains what it does ("your actual project files are NOT touched"), second is a final "ARE YOU SURE?".

Restart the server to pick up the changes.

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
