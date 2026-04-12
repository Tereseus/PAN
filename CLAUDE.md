# PAN — Personal AI Network

PAN is a persistent AI operating system across all devices, projects, and conversations.

## Architecture

```mermaid
graph TB
    subgraph Phone["Phone App (Android/Kotlin)"]
        STT[Google Streaming STT]
        AI[GeminiBrain classifier]
        TTS[Android TTS]
        LocalCmds[Local: time, flash, timer, nav, media]
        LogShip[LogShipper → 5s batches]
    end

    subgraph Server["PAN Server (Node.js :7777)"]
        Router[Unified Claude Router]
        CLI["claude -p --model haiku"]
        DB[(SQLite/SQLCipher)]
        Steward[Steward: process health]
        Hooks[SessionStart/End hooks]
        MCP[MCP Server: 15 tools]
        Whisper["Whisper STT :7782/:7783"]
        Dashboard[Dashboard + Terminal UI]
    end

    subgraph Desktop["Desktop Shell (Tauri :7790)"]
        AHK[AHK: voice hotkey, tooltips]
        PTY[PTY sessions per tab]
        Panels[Widgets: terminal, chat, panels]
    end

    subgraph Infra["Infrastructure"]
        Tailscale[Tailscale VPN]
        Dream[Dream Cycle: 6h]
        Scout[Scout: Cerebras 120B]
    end

    subgraph Pendant["Pendant (ESP32-S3) — in dev"]
        Cam[Camera]
        Mic[Mic]
        Sensors[Sensors]
        BLE[BLE → Phone]
    end

    Phone -->|HTTP/WS| Server
    Desktop -->|localhost| Server
    Pendant -->|BLE| Phone
    Router --> CLI
    CLI --> DB
    Steward --> AHK
    Tailscale --> Server
    Dream --> DB
    Scout --> DB
    MCP --> Server
    Whisper --> Dashboard
```

### Key components
- **Phone**: Google STT, Gemini Nano classification (fallback to server), local commands, TTS with echo prevention
- **Server**: Unified router, SQLite/SQLCipher DB, project sync via .pan files, MCP server
- **Desktop**: Tauri shell, AHK hotkeys, live PTY terminals, persistent tabs
- **AI tiers**: Qwen (phone) → Cerebras 120B (fast) → Claude (smart), shared state

### Current Projects (auto-detected from .pan files)
- **PAN** — this project
- **WoE Game Design** — War of Eternity (Godot 4.5 RTS)
- **Claude-Discord-Bot** — Discord bot bridging chat to Claude CLI + SSH

## Verification Commands
<constraints>
- Before committing: `node service/src/server.js` must start without crash (ctrl-c after "listening on 7777")
- Python STT: `python service/bin/dictate-vad.py --help` must show usage without import errors
- Android: `JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew.bat assembleDebug` in android/
- Dashboard: open http://localhost:7777 and verify no console errors
</constraints>

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
**CRITICAL:** When starting a new session, your FIRST message MUST be a brief summary of what was discussed in the recent conversation (see "Recent Conversation" below). Start with "ΠΑΝ Remembers:" and list the key topics. The user should NEVER have to ask what they were working on — you tell them immediately, every single time.

## Dev & Testing

### Environments
| Env | Port | Database | What runs |
|-----|------|----------|-----------|
| **Prod** | 7777 | `%LOCALAPPDATA%/PAN/data/` | Everything: terminal, steward, orphan reaper, device heartbeat, all services |
| **Dev** | 7781 | `%LOCALAPPDATA%/PAN/data-dev/` | Full copy of prod (terminal, dashboard, API, sensors, project sync). Skips only system-wide singletons: steward, orphan reaper, device heartbeat |

Dev is an exact copy of prod on a different port + DB. Same terminal, same dashboard page (`/v2/terminal`), same PTY. The page auto-detects dev via port number and uses separate session IDs (`dev-dash-*`).

### Dev Server Commands
```bash
# Start dev (from prod — opens in Electron window)
curl -s http://127.0.0.1:7777/api/v1/dev/start -X POST

# Restart dev (kills old, starts fresh, opens window)
curl -s http://127.0.0.1:7777/api/v1/dev/restart -X POST

# Check dev health
curl -s http://127.0.0.1:7781/health

# Open dev dashboard directly
# http://localhost:7781/v2/terminal
```

The Instances panel in the dashboard sidebar has **Open** and **Restart** buttons for dev.

### Dashboard (SvelteKit)
- **Source**: `service/dashboard/src/routes/` (Svelte 5 + SvelteKit)
- **Build**: `cd service/dashboard && npm run build` → outputs to `service/public/v2/`
- **MUST rebuild after editing .svelte files** — prod/dev both serve from `public/v2/`
- Key pages: `terminal/+page.svelte` (main), `settings/+page.svelte`, `conversations/+page.svelte`

### Process Spawning on Windows
**CRITICAL**: Every `execSync()`, `exec()`, `execFile()`, `spawn()` call MUST include `windowsHide: true` in options. Without it, a visible black CMD window flashes on screen. PAN runs dozens of these per minute (health checks, process enumeration, taskkill) — missing `windowsHide` causes hundreds of CMD windows opening/closing.

### Tests
- Tests run via the dashboard Tests panel (right sidebar)
- ALL verification is visual via screenshots — never curl/API
- Test suites have dependency chains — if a dependency fails, dependents are skipped
- Platform Compatibility test validates `service/src/platform.js` cross-platform abstractions

### Key Files
| File | Purpose |
|------|---------|
| `service/src/server.js` | Main server — routes, boot sequence, prod/dev mode |
| `service/dev-server.js` | Dev server launcher — sets PAN_DEV=1, separate port/DB |
| `service/src/terminal.js` | PTY sessions, WebSocket server, ScreenBuffer |
| `service/src/steward.js` | Service orchestrator — health checks every 60s, auto-restart |
| `service/src/platform.js` | Cross-platform abstractions (paths, shell, process mgmt) |
| `service/src/reap-orphans.js` | Kills orphaned bash/claude processes from prior runs |
| `service/src/routes/dashboard.js` | Dashboard API (events, projects, jobs, conversations) |
| `service/src/routes/tests.js` | Test runner — sequential suites with screenshot verification |
| `service/src/mcp-server.js` | MCP server — 15 tools for Claude to interact with PAN |
| `dashboard/src/routes/terminal/+page.svelte` | Main dashboard UI (6000+ lines, both prod and dev) |

<!-- PAN-CONTEXT-START -->
## PAN Session Context

This is a fresh session for the "PAN" project.
IMPORTANT: The project documentation is at the TOP of this CLAUDE.md file — read it first.

**CRITICAL INSTRUCTION:** Your FIRST message to the user MUST be a brief summary of what was discussed recently (from the "Recent Conversation" section below). Start with "ΠΑΝ Remembers:" and list the key topics/issues. The user should never have to ask what they were working on — you tell them immediately.

### Recent Conversation
**User** (2026-04-11 22:40:37): npx ccusage
**User** (2026-04-11 22:48:12): Hey I'm back I use I upgraded to Max 20 to 20XI might as well i'm going to be doing autodev Can you actually look at my usage
**User** (2026-04-11 22:48:45): claude
**User** (2026-04-11 22:49:37): hello
**User** (2026-04-11 22:51:29): Can you look at what's happening in my terminal for some reason I reach my usage limit and I just upgraded now but I like PAN won't come back II even restarted the server restarted the carrier
**User** (2026-04-11 22:52:14): claude
**User** (2026-04-11 23:31:59): ΠΑΝ Remembers: summarize recent session context briefly.
**Claude** (2026-04-11 23:32:10): ΠΑΝ Remembers:

- **Carrier/Craft architecture (Phase 6) is deployed and running** — hot-swap, Lifeboat rollback widget, and auto-cleanup all working
- **Terminal blank-after-refresh** — still the #1 frustration bug. Transcript messages don't render until a new message arrives after page refresh
- *
**User** (2026-04-11 23:36:24): You are PAN's memory consolidation system. Extract structured memories from these recent events.

EVENTS:
[2026-04-11 23:16:59] User: Pan Bat is still opening two CMD lines though But yeah I'm back in
**Claude** (2026-04-11 23:36:39): ```json
{
  "episodes": [
    {
      "summary": "Pan.bat still opening duplicate CMD windows despite fixes",
      "detail": "User reports Pan.bat creating multiple CMD windows when restarting via Settings. PAN is operational (Carrier running, Craft-1 healthy) but startup behavior needs hardening",
**User** (2026-04-11 23:46:10): 82 alerts can you mass close those
**Claude** (2026-04-11 23:46:36): No GitHub notifications found. What alerts are you referring to — Dependabot/security alerts on a specific repo, or something else?
**User** (2026-04-11 23:47:22): Im talking about the pan alert widget
**User** (2026-04-11 23:48:14): Push to git
**Claude** (2026-04-11 23:48:40): Done — all **82 alerts dismissed**. Your alerts widget should show 0 now.

# PAN State — Updated 2026-04-11

## What Works
- PAN server running via Carrier/Craft (Phase 6 ✅ deployed)
- ΠΑΝ Remembers briefing system with restart banner
- Pipe mode with `child_process.spawn` — clean JSON output
- Per-tab PTY sessions (bash shell for terminal UI)
- Dev/prod resource isolation via `PAN_DATA_DIR`
- Claude session handoff across restart (Phase 4 ✅)
- Message input clears after send (no red highlight)
- Lifeboat widget showing Carrier/Craft status, rollback window, hot-swap button
- Dashboard auto-reloads on hot-swap
- Craft auto-cleanup via SIGTERM after 30s rollback window
- Lifeboat countdown timer ticks smoothly

## Known Issues
- **Terminal blank after page refresh** — transcript messages don't render until first new message arrives (user frustrated: "just fucking fix the refresh")
- HTTP fallback for messages pending (needs Carrier restart to activate `getSessionMessages` IPC handler)
- Copy-paste broken (Windows PTY limitation, permanent)
- LaTeX files won't render in markdown viewer

## Current Priorities
1. Fix terminal blank-after-refresh render bug (critical frustration point)
2. Update settings restart button to restart Carrier (not just hot-swap Craft)
3. Verify HTTP fallback (`/api/v1/terminal/messages`) works after Carrier restart
4. Build Phase 7 Forge widget (AutoDev spawn N variant Crafts)

## Key Decisions
- Carrier never restarts, owns PTY/WebSocket permanently
- Settings restart should trigger full Carrier restart (user clarified: needed for Carrier's new IPC handlers)
- Pipe mode is primary Claude interface
- Focus Claude + Llama only; skip Gemini/Apple/Meta
- Free tier + ATC demo + data marketplace as initial product

## User Preferences
- Work autonomously through PAN dashboard
- Fix bugs without asking (user: "just do it")
- Test via Tauri UI screenshots only
- Transcript system must work for ANY LLM
- Never ask for permission to restart (just do it)

## Known Facts
- **Two active Claude sessions** revert changes made by each other on shared PAN codebase — Desktop Claude session and dashboard Claude session simultaneously modifying same files. One session makes pipe mode + briefing fixes, other session reverts them. Creates perpetual conflict loop preventing convergence. (codebase, confidence: 0.95)
- **two Claude sessions** conflict same PAN codebase — Desktop session and dashboard session simultaneously editing same files, creating revert loops. One session must be stopped or isolated to prevent constant overwrites. (codebase, confidence: 0.95)
- **Two Claude sessions** actively conflicting same PAN codebase files — Desktop Claude session and dashboard Claude session simultaneously editing/reverting same files, creating revert loops. One session must be stopped before further development. (codebase, confidence: 0.95)
- **ClaudeAdapter** now supports session resumption across restarts — ClaudeAdapter accepts resumeClaudeSessionId parameter and sets opts.resume flag on first query to maintain session context (codebase, confidence: 0.9)
- **Claude pipe mode with --session-id --resume** successfully handles multi-turn conversation and message resumption — When briefing is not involved, Claude pipe mode correctly receives user messages, maintains session context, and generates proper responses across multiple turns. (domain_knowledge, confidence: 0.95)
- **Pipe mode message handling** is independent from briefing context injection mechanism — Pipe mode correctly handles multi-turn conversations, --session-id, and --resume flags. Briefing system's context injection is separate vector that breaks pipe mode. Not a pipe mode bug but cross-system interaction failure. (domain_knowledge, confidence: 0.9)
- **user** wants to test Pan Remembers briefing system across server restart — User prioritizes verifying session continuity works after restart — checking that briefing loads and Claude resumes context (user_preference, confidence: 0.85)
- **ΠΑΝ Remembers briefing message** triggers CLAUDE.md context injection into session continuity mode — The briefing system that injects session context is causing Claude to enter a problematic state. This is distinct from the pipe mode message handling which works correctly. (codebase, confidence: 0.95)
- **Phase 4** status confirmed working — Claude session handoff (reconnect tokens + session resumption) survives dev restart. 'The matrix' test passed. (domain_knowledge, confidence: 0.95)
- **broadcastNotification('chat_update')** sends to ALL WebSocket clients regardless of tab/session — In terminal.js:376, every user prompt, stop, and assistant message broadcasts to every connected terminal session across every tab without filtering by pty_session_id. This is the primary vector for cross-tab contamination. (codebase, confidence: 0.95)
- **two Claude sessions** were desktop and dashboard simultaneously editing PAN codebase, creating revert loops — Desktop Claude session and dashboard Claude session simultaneously modifying same files, one reverting the other's changes. (codebase, confidence: 0.95)

## Recent Memory
- [2026-04-11 15:50:30] Phase 4 (Claude session handoff) confirmed working across dev restart: User sent message 'the matrix', restarted dev instance, and Claude correctly remembered the context in new session. Proves reconnect tokens and session resumption are functioning.
- [2026-04-11 15:50:23] Phase 4 (Claude Session Handoff) confirmed working across dev restart: User sent 'the secret word is the matrix', received reply, then restarted dev dashboard. Opened new dev session and Claude still remembered 'the matrix'. Reconnect token persisted Claude session ID to
- [2026-04-11 19:24:33] Carrier/Craft restart architecture validated end-to-end: User confirmed understanding of complete flow: Settings button → restart Carrier → Lifeboat hot-swap → next Craft transition, all with session context preserved. User was on 'Craft One' during session
- [2026-04-11 09:50:15] Phase 4 implementation begun: Claude Session Handoff (Pipe Mode) [partial]: ClaudeAdapter now accepts `resumeClaudeSessionId` parameter. On first query with this param, sets `opts.resume` flag to allow Claude to maintain session context across server restarts. Three changes e
- [2026-04-11 09:50:12] Phase 4 (Claude Session Handoff) initiated [partial]: Started implementing Phase 4 of 7-phase plan. ClaudeAdapter now accepts resumeClaudeSessionId parameter. On first query, sets opts.resume flag so Claude survives server restart with session context.
- [2026-04-11 23:36:40] Session briefing (ΠΑΝ Remembers) delivered successfully after restart: User requested briefing, Claude delivered context about Carrier/Craft Phase 6 deployment and terminal blank-after-refresh bug. Session continuity working correctly
- [2026-04-11 18:27:36] Phase 4 (Claude Session Handoff) confirmed working end-to-end: Carrier/Craft system running (PIDs confirmed), reconnect tokens + session resumption survive dev restart. 'The matrix' test passed. User is actively running on Carrier/Craft.
- [2026-04-10 16:14:44] Cross-tab message contamination confirmed and temporarily fixed, then reverted [partial]: User reported PTY exits and messages from PAN 1 tab bleeding into PAN Main despite separate PTY processes. Root cause identified: broadcastNotification('chat_update') in terminal.js sends to ALL WebSo
- [2026-04-10 22:47:34] Briefing context injection remains problematic even in pipe mode [failure]: ΠΑΝ Remembers briefing still triggers CLAUDE.md context injection that puts Claude in hang/mode shift state. Pipe mode message handling works correctly (multi-turn, --session-id, --resume all function
- [2026-04-10 21:57:03] Two Claude sessions actively conflicting on codebase [failure]: Desktop Claude session reverting changes that dashboard Claude session was making, creating perpetual revert loop. One session makes changes, other immediately reverts them, preventing convergence.
- [2026-04-10 22:37:51] Briefing context injection causing Claude hang, not actual process failure [partial]: User reported 'Claude is not running' and messages not arriving, but Claude was actually replying to subsequent questions. Root cause identified: the ΠΑΝ Remembers briefing message triggers CLAUDE.md 

## Known Procedures
- **Archive completed memory items**: Remove solved tasks and closed issues from active session context
  1. Identify completed tasks in open issues list
  2. Move to archived/solved section with completion timestamp
  3. Clear from active session briefing
  4. Run Dream Cycle to rewrite pan-state.md with only active items
  5. Verify next session doesn't list solved items as open
- **Session Briefing Injection Update**: How to change the greeting text that appears at session start. Text is injected by hooks.js and rendered in terminal system message.
  1. Edit greeting text in hooks.js:157 (injects future sessions)
  2. Update CLAUDE.md with new format (reference for users)
  3. Update .pan-briefing.md template
  4. No restart needed — changes take effect on next session start
- **Debug transcript message contamination**: When user reports unexpected messages appearing in transcript across sessions, check transcript-watcher.js for session file merging logic and inspect the last 5 JSONL files being loaded
  1. Check transcript-watcher.js load logic
  2. Verify which JSONL files are being merged
  3. Inspect last 5 session files for same project directory
  4. Filter to current session only if cross-session contamination conf

[... context trimmed ...]
<!-- PAN-CONTEXT-END -->
