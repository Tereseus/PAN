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
**Claude** (2026-04-12 15:43:26): Fixed. The old code only appended when `recent.length > _renderedMsgIds.length`, but with a 50-message sliding window, the count never changes — new messages push old ones out, count stays 50, nothing renders.

Now it fingerprints the actual message content and does a full re-render when anything ch
**Claude** (2026-04-12 15:43:27): ```json
{
  "episodes": [
    {
      "summary": "Phone message sending confirmed working via pipe mode",
      "detail": "User tested phone messaging. Message successfully routed to dash-pan-1 via pipe endpoint with response {\"ok\":true,\"session\":\"dash-pan-1\"}. Pipe mode endpoint /api/v1/termi
**Claude** (2026-04-12 15:44:05): Now try sending from the phone again. The console logs will ship to the server via the WebChromeClient and I can see if `loadChat` is even running and whether the fingerprint is changing. After you send, give it 10 seconds then tell me.
**User** (2026-04-12 15:44:52): Test from the phone at 3:44
**User** (2026-04-12 15:45:18): OK it is poiling correctly I see it
**Claude** (2026-04-12 15:45:28): Nice! So the messages are showing up now without leaving the dashboard? The polling and fingerprint re-render are working?
**Claude** (2026-04-12 15:45:35): Try sending another message from the phone. Wait about 10 seconds, then tell me. I'll check what `loadChat` is doing.
**User** (2026-04-12 15:48:01): I just told you that send messages and it can see your messages So it's working what are you trying to get me to do
**Claude** (2026-04-12 15:48:08): Got it — it's working! Phone sends messages, you can see replies. We're good.

What did you want to work on next? You mentioned something about security earlier.
**User** (2026-04-12 15:49:08): Can you cash the state of the of the chat the scroll bar to always make it go to the bottom when you load in on the phone Also the on the phone they're not showing the correct data it's just showing t
**Claude** (2026-04-12 15:50:35): Now go back in to the dashboard on the phone. The settings page should show "PAN Server: Connected / Carrier: ✓ Active / Craft: ✓ Healthy" instead of "PAN Hub: undef", and the chat should scroll to the bottom on load. Try the Data tab too — if it still shows zeros, tell me.
**User** (2026-04-12 15:52:03): Sometimes when I go into the dashboard it just shows black I had to go back out and then go back in for it to load and I just went back in and did the scroll bar that didn't start at the top let me do
**Claude** (2026-04-12 15:53:46): Fixed three things:
1. **Chat scroll** — always scrolls to bottom using `requestAnimationFrame` so DOM is ready
2. **Settings page** — shows "PAN Server: Connected / Carrier: ✓ Active / Craft: ✓ Healthy" instead of "PAN Hub: undef", and capitalizes auth mode
3. **Projects page** — shows "7 projects 
**User** (2026-04-12 16:29:37): So you're telling me my pan project has no goals has no No bugs no tasks then what do I see when I go to the Bugs widget or the Task widget what are you talking about
**Claude** (2026-04-12 16:31:29): Now go back into the dashboard on the phone. You should see:
- **Chat** scrolls to bottom automatically
- **Projects** shows 13 milestones with actual task counts
- **Settings** shows "PAN Server: Connected / Carrier: ✓ Active / Craft: ✓ Healthy" and "Auth Mode: None" (capitalized)

# PAN State — Updated 2026-04-12

## What Works
- PAN server Carrier/Craft with crash-loop recovery via process cleanup ✅
- ΠΑΝ Remembers briefing system with restart banner
- Terminal multi-tab PTY with persistent transcripts
- Pipe mode with child_process.spawn — clean JSON output
- Claude session handoff across restart (Phase 4 ✅)
- Dev/prod resource isolation via PAN_DATA_DIR
- Lifeboat widget with rollback and hot-swap
- Voice API endpoints live (profiles, speak, pregenerate)
- F5-TTS voice cloning on RTX 4070 GPU, XTTS for accents
- Personality sync with server-side logging ✅
- Panel caching persists to localStorage ✅
- System sleep capability ✅
- Mobile pipe endpoint routing (/api/v1/terminal/pipe) ✅
- Mobile send endpoint with fallback to dash-pan-1 ✅
- Tailscale auto-auth for 100.x.x.x IPs ✅

## Known Issues
- Copy-paste broken (Windows PTY limitation, permanent)
- F5-TTS accent capture poor (needs XTTS multi-lingual training)
- Pan.bat duplicate CMD windows on first launch
- Phone message reception broken — user sends OK, can't see Claude responses until page refresh
- Mobile browser caching prevents code updates

## Current Priorities
1. Fix phone message reception real-time updates
2. Understand mobile device API formats and constraints
3. Get XTTS accent matching working for voice packs
4. Build soundboard hybrid system (pre-recorded + XTTS)
5. Phase 7 Forge widget (AutoDev spawn variants)

## Key Decisions
- Voice comes from server → phone via pre-downloaded packs
- Carrier never restarts, owns PTY/WebSocket permanently
- Pipe mode is primary Claude interface
- Focus Claude + Llama only; skip Gemini/Apple/Meta
- Tailscale mesh for remote access

## User Preferences
- Work autonomously without asking permission
- Fix bugs without asking
- Test via Tauri UI screenshots only
- Never ask for permission to restart
- Provide MCP-aware context, not generic UI suggestions

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
- **two Claude sessions** were desktop and dashboard simultaneously editing PAN codebase, creating revert loops — Desktop Claude session and dashboard Claude session simultaneously modifying same files, one reverting the other's changes. (codebase, confidence: 0.95)
- **Phone pipe endpoint** is functioning dash-pan-1 session successfully receives messages — User messages from phone successfully route through /api/v1/terminal/pipe to dash-pan-1 Claude session. Pipe mode working correctly. (codebase, confidence: 0.95)

## Recent Memory
- [2026-04-11 15:50:30] Phase 4 (Claude session handoff) confirmed working across dev restart: User sent message 'the matrix', restarted dev instance, and Claude correctly remembered the context in new session. Proves reconnect tokens and session resumption are functioning.
- [2026-04-12 15:35:25] Mobile loadChat() filtering out Claude sessions entirely: Mobile page was filtering out `dash-` prefixed sessions where Claude actually lives. Also querying JSONL endpoint instead of in-memory adapter for pipe mode messages. This prevented phone from seeing 
- [2026-04-12 15:43:28] Phone message sending confirmed working via pipe mode: User tested phone messaging. Message successfully routed to dash-pan-1 via pipe endpoint with response {"ok":true,"session":"dash-pan-1"}. Pipe mode endpoint /api/v1/terminal/pipe is functioning corre
- [2026-04-12 15:35:25] Fixed phone message routing with endpoint auto-routing and session prefix matching: Made `/api/v1/terminal/send` endpoint auto-route through pipe mode. Added session ID prefix matching so `dash-pan` resolves to `dash-pan-1`. Phone and desktop now share same Craft Claude instance.
- [2026-04-11 15:50:23] Phase 4 (Claude Session Handoff) confirmed working across dev restart: User sent 'the secret word is the matrix', received reply, then restarted dev dashboard. Opened new dev session and Claude still remembered 'the matrix'. Reconnect token persisted Claude session ID to
- [2026-04-11 09:50:15] Phase 4 implementation begun: Claude Session Handoff (Pipe Mode) [partial]: ClaudeAdapter now accepts `resumeClaudeSessionId` parameter. On first query with this param, sets `opts.resume` flag to allow Claude to maintain session context across server restarts. Three changes e
- [2026-04-11 09:50:12] Phase 4 (Claude Session Handoff) initiated [partial]: Started implementing Phase 4 of 7-phase plan. ClaudeAdapter now accepts resumeClaudeSessionId parameter. On first query, sets opts.resume flag so Claude survives server restart with session context.
- [2026-04-11 19:24:33] Carrier/Craft restart architecture validated end-to-end: User confirmed understanding of complete flow: Settings button → restart Carrier → Lifeboat hot-swap → next Craft transition, all with session context preserved. User was on 'Craft One' during session
- [2026-04-10 16:14:44] Cross-tab message contamination confirmed and temporarily fixed, then reverted [partial]: User reported PTY exits and messages from PAN 1 tab bleeding into PAN Main despite separate PTY processes. Root cause identified: broadcastNotification('chat_update') in terminal.js sends to ALL WebSo
- [2026-04-09 12:36:37] Ghost message contamination and Session 0 PTY crashes fixed [partial]: transcript-watcher.js was loading last 5 JSONL session files simultaneously, merging messages from locked-out/old sessions into current terminal. Dedup logic added. PTY crashes were caused by server r
- [2026-04-11 23:36:40] Session briefing (ΠΑΝ Remembers) delivered successfully after restart: User requested briefing, Claude delivered context about Carrier/Craft Phase 6 deployment and terminal blank-after-refresh bug. Session continuity working correctly

## Known Procedures

[... context trimmed ...]
<!-- PAN-CONTEXT-END -->
