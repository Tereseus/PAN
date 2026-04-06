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

# PAN State — Updated 2026-04-06 (11:22)

## What Works
- SQLite DB encrypted with SQLCipher (AES-256-CBC)
- Tailscale remote access working
- Phone commands: flashlight, timer, alarm, navigation, search, media controls
- Browser extension: 10+ actions
- MCP server with 15 tools wrapping PAN HTTP API
- Dream cycle runs every 6h
- Context briefing system working via SessionEnd injection
- Window registry supports labeled Tauri windows (e.g. "dev", "prod")
- `/api/v1/ui` endpoints: `list_windows`, `screenshot`, `focus` with windowId routing
- Tauri `/open` accepts `label` for deterministic window identification
- Tauri `/screenshot` accepts `windowId` and captures correct monitor
- Node.js dashboard server on port 7777
- Tauri desktop shell on port 7790 with PAN Π icon
- Fast Whisper STT running with 0.3s end-silence delay, batch-only mode
- AHK script launched via Tauri resolves Windows session boundary
- Hard restart via settings button triggers full process restart
- All live PTY sessions restored on page refresh
- Terminal status messages no longer corrupt screen buffer
- `.left-content` and `.chat-container` prevent horizontal overflow
- Tabs are permanent in DB with `closed_at` and `claude_session_ids`
- PTY dynamically resizes based on container width (px → columns)
- Approval keys (1/2/3) only trigger when pending approval exists
- Health checks now run asynchronously without blocking event loop
- Bash and MCP tool permissions are allowlisted (effective next session)
- Voice input uses batch MediaRecorder with single active tab enforcement
- WebSocket broadcast for voice respects active tab focus and session scope
- Terminal scroll regions reset correctly on buffer switch
- Frontend deduplication ensures only one transcription per utterance across tabs
- Input box auto-grows up to 10 lines during voice input
- Voice transcription no longer duplicates text on partial updates
- AHK tooltip shows only "Π Listening" with no extra text or actions
- New `client_logs` table in DB with indexes for device, level, created_at, device_type
- New log endpoints: `POST /api/v1/logs`, `GET /api/v1/logs`, `GET /api/v1/logs/summary`, `DELETE /api/v1/logs`
- Android `LogShipper.kt` batches logs every 5s with retry and OOM protection
- Terminal overflow fixed: code blocks wrap or scroll without overlapping
- Mic button now works via server-side Whisper with streaming partials
- `dictate-vad.py` plays stop sound correctly (G4, 100ms)
- Steward uses `schtasks` to launch AHK (reverted to working method)

## Known Issues
- Mic button start sound (C5+E5, 150ms) is cut off or inaudible
- Mouse hotkey (XButton2) does not trigger AHK reliably after restart
- Mic button fails to initiate recording despite UI feedback

## Current Priorities
1. Fix mic button start sound cut-off — ensure full 150ms tone plays before recording
2. Restore reliable XButton2 hotkey functionality after restart
3. Fix mic button recording failure — diagnose Whisper trigger path

## Key Decisions
- STT engine choice must be settings-driven, not hardcoded
- GUI processes (e.g. AHK) must be launched via Tauri due to Windows session isolation
- Each dashboard tab is a named bookmark to a persistent conversation thread
- Tauri windows must be labeled at creation for reliable identification and targeting
- Background AI (Dream, Scout) requires 30B+ models — using Cerebras 120B
- Interactive terminal uses Claude; embeddings via local Ollama 7B
- Server-side terminal rendering (@xterm/headless) is standard
- Universal device telemetry requires a common log protocol and ingestion endpoint

## User Preferences
- Do everything autonomously — never ask for manual commands
- Understand full architecture before building
- Visual test verification required for all changes
- Logo area in sidebar reserved for user company/app icons
- Test in prod only after full system understanding
- Avoid unnecessary restarts — they break context and session state

## Known Facts
- **user_correction** stated creating new sessions (user_preference, confidence: 0.9)
- **user_preference** wants to do for tasks and stuff like that (user_preference, confidence: 0.8)
- **CLAUDE.md injection** happens before SessionStart hooks run — Claude Code reads CLAUDE.md into context before command hooks execute. Writing to CLAUDE.md in hooks is invisible to current session (process, confidence: 0.95)
- **Voice-to-text memory system** should track raw voice input plus corrections/preferences per project — Critique prompt was dumping 49 raw voice transcriptions creating a 124,574 character prompt that exceeded evolution timeout. Memory should compress raw input to corrections only (domain_knowledge, confidence: 0.9)
- **user_preference** wants what the fuck we just talked about (user_preference, confidence: 0.8)
- **user_preference** wants to see where this is coming from (user_preference, confidence: 0.8)
- **xterm.js auto-scroll** caused by 5 code sources plus scrollOnOutput/scrollOnUserInput options — Terminal was force-scrolling to bottom from multiple places: doFit(), WebSocket handler, tab switches, view mode button, plus xterm.js built-in options (codebase, confidence: 0.95)
- **user_correction** stated do at the end of the day (user_preference, confidence: 0.9)
- **user_preference** wants to use the desktop session to actually start pan and we're actually doing it correctly (user_preference, confidence: 0.8)
- **user_correction** stated understand why you would delete the test Why wouldn't you keep the last like 10 tests the results (user_preference, confidence: 0.9)
- **user_preference** wants that nothing was missed and then I'll confirm to delete it (user_preference, confidence: 0.8)
- **user_correction** stated think it did I Click to restart (user_preference, confidence: 0.9)
- **user_correction** stated look at the fucking clipboard look in the fucking conversation (user_preference, confidence: 0.9)

## Recent Memory
- [2026-04-01 20:37:25] Mapped complete PAN memory system with three scopes and three thinking systems: Memory should be scoped per-terminal, per-project, and global. Three independent processes: Consolidation (extract episodes/facts/procedures), Dream Cycle (rewrite pan-state.md with what's solved/open
- [2026-04-01 20:37:25] Identified memory system architecture issue: CLAUDE.md read before SessionStart hooks [failure]: Claude Code reads CLAUDE.md before SessionStart command hooks run. Writing to CLAUDE.md in hooks is invisible to current session. This breaks the context injection pipeline
- [2026-04-01 14:03:43] Critical correction: Always use PAN database, never git or guessing: User explicitly stated to check PAN database for prompts and session context, not git history or file searching. This was due to Claude making incorrect assumptions about what was already built
- [2026-04-01 20:37:25] Discovered terminal was being force-scrolled to bottom by 5 different code sources [partial]: Found auto-scroll triggers in: doFit() on resize, WebSocket output handler, two tab switches, view mode button. Also xterm.js has scrollOnOutput and scrollOnUserInput options causing auto-scroll
- [2026-04-01 20:37:25] Discovered evolution system running 49 times with 45-second timeout failures [failure]: Critique prompt was 124,574 characters (~31,000 tokens) due to dumping entire raw voice transcriptions. SDK timeout is 45 seconds, maxTokens 2000. Evolution pipeline couldn't complete
- [2026-04-01 20:37:25] User decision: replace xterm.js with custom HTML/WebSocket terminal [partial]: xterm.js is too janky with unreliable scroll behavior. Plan to build simple <pre>/<div> renderer with ANSI color parsing and manual WebSocket PTY connection. Avoids all the TUI escape code complexity
- [2026-04-01 20:37:24] Fixed nested CSS flexbox height rendering bug in dashboard: Added `min-height: 0` to every flex container in height chain (.content, .content-body, .terminal-layout, .term-container) and changed `100vh` to `100%` on html/body/.shell. Root cause: flex children 
- [2026-04-01 14:03:43] Transcript loading issue diagnosed and fixed with fallback logic: After crash recovery, Claude session cwd was Desktop but terminal tab was PAN. Transcript now tries project path first, then falls back to most recent 3 sessions globally
- [2026-03-31 10:15:53] TEST: User fixed the terminal scrollbar bug: Modified WezTerm config to prevent auto-scroll on new output
- [2026-04-01 14:03:43] User reported 7 bugs and priorities were set for the session [partial]: AHK not starting on reboot, conversation loading before terminal ready, steward not running, chat input issues, terminal paste issues, approvals tab flashing, escape key behavior
- [2026-04-01 20:37:25] Built PAN MCP server with 15 tools wrapping HTTP API: Created service/src/mcp-server.js, registered in .mcp.json (project-level) and Desktop/.mcp.json (global). Requires Claude Code restart to pick up new tools
- [2026-04-01 14:03:43] Hard refresh button implemented to bypass browser cache: Refresh button now uses location.reload(true) to force cache bypass. This was necessary because old broken dashboard code was being cached
- [2026-04-01 14:03:44] Multi-transcript system implemented for multi-tab support: Each dashboard tab now tracks its own claudeSessionIds array. Chat_update events associate sessions with active tabs
- [2026-04-01 20:37:24] Fixed TedGL 'My Computer' showing offline when device is actively connected: Added hostname equality check in dashboard.j

[... context trimmed ...]
<!-- PAN-CONTEXT-END -->
