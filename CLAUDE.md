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

=== PAN SESSION CONTEXT BRIEFING ===

## Development Environment
OS: Windows
Terminal: WezTerm (config: C:\Users\tzuri\.wezterm.lua)
Shell: bash (Git Bash)
IDE: VS Code
Tools: Claude Code CLI, Android SDK

Runtimes: Node.js, Kotlin, Python, C/C++
Frameworks: Express, Jetpack Compose
Languages: C++, Python, JavaScript, HTML, TypeScript, C, Go, CSS, Swift, C#, SQL, Rust, Ruby

## Term Mapping
When the user says "terminal" they mean: WezTerm
When the user says "the app" or "phone" they mean: the Android PAN app
When the user says "the server" they mean: PAN Node.js server (port 7777)
When the user says "the dashboard" they mean: the web dashboard served by PAN

# PAN State — Updated 2026-04-04

## What Works
- SQLite DB encrypted with SQLCipher (AES-256-CBC)
- Phone voice pipeline: Google STT → PAN server → Claude Haiku → TTS
- Phone commands: flashlight, timer, alarm, navigation, search, media controls
- Tailscale remote access working
- Browser extension: 10+ actions
- MCP server with 15 tools wrapping PAN HTTP API
- Dream cycle runs every 6h
- `/api/v1/dev/proxy/*` route (Express 5 named wildcards)
- Context briefing system working
- Window registry with IDs and titles
- `/api/v1/ui` endpoints: `list_windows`, `screenshot`, `focus` verified working
- Screenshots capture all monitors with `all_screens=True`
- Node.js dashboard server on port 7777
- Tauri desktop shell running on port 7790 with PAN Π icon (window title + system tray correct)
- Server running stable with package dependencies fixed

## Known Issues
- Chat input box broken
- Terminal input lag: intermittent 10s+ delay
- Ollama/embeddings: falls back to keyword hash when Ollama not running
- Taskbar icon showing generic app icon instead of PAN Π
- Server endpoints still reference Electron polling system (needs refactor but not blocking)

## Current Priorities
1. Push Tauri build to GitHub
2. Fix taskbar icon in Tauri manifest
3. Refactor server endpoints to call Tauri's HTTP API directly (port 7790)
4. Delete Electron backup (`electron-OLD/`) once confident Tauri is stable

## Key Decisions
- Tauri replaces Electron (DONE — 5MB vs 500MB, native OS integration)
- Cardano blockchain for PAN token
- AGPL-3.0 license with treasury wallet addendum
- Tailscale for all remote access
- Service names: Steward, Intuition, Guardian

## User Preferences
- Never ask for manual commands — do everything autonomously
- Fix broken tools immediately, no workarounds
- Don't ask for permission on dev actions (already agreed = just do it)
- Multi-monitor support required
- Keep dev instance stable during major architecture changes

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
- [2026-04-01 20:37:25] Built PAN MCP server with 15 tools wrapping HTTP API: Created service/src/mcp-server.js, registered in .mcp.json (project-level) and Desktop/.mcp.json (global). Requires Claude Code restart to pick up new tools
- [2026-04-01 14:03:43] User reported 7 bugs and priorities were set for the session [partial]: AHK not starting on reboot, conversation loading before terminal ready, steward not running, chat input issues, terminal paste issues, approvals tab flashing, escape key behavior
- [2026-03-31 10:15:53] TEST: User f

[... context trimmed to reduce CLAUDE.md size ...]
<!-- PAN-CONTEXT-END -->
