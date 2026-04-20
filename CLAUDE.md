# PAN — Personal AI Network

PAN is a persistent AI operating system across all devices, projects, and conversations.

> **Feature specs live in [FEATURES.md](./FEATURES.md).** Every button, widget, and
> endpoint is documented there with what it calls, what it preserves, what it
> replaces, and its pre-gate. If you're about to guess what a UI element does —
> check FEATURES.md first. Update it in the same commit as any code change.

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
When a **fresh terminal session starts** (the very first message after `claude` launches), begin with a brief "ΠΑΝ Remembers:" summary of recent topics from the "Recent Conversation" section below. This is ONLY for the first message of a fresh session — NEVER repeat it mid-conversation, NEVER repeat it on follow-up messages, and NEVER re-emit it after a PTY restart or context reload. If you've already said it once in this conversation, do not say it again.

**Anti-repetition rule:** Before writing ANY response, check if you've already said the same thing earlier in this conversation. If you have, do NOT repeat it. Never write the same summary, finding, or explanation twice.

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

### Desktop Dashboard Behavior
- **Model switching**: The model selector dropdown saves the chosen model as the default for **new sessions**. To apply a model change, click the **+ button** to create a new tab. Model changes do **not** affect the current running session mid-conversation (the `claude -p` process is already running with a fixed model).
- **New tabs**: Each tab is a separate PTY session running `claude -p --project <dir> --model <model>`. Closing a tab kills the underlying Claude process.

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
| `service/src/router.js` | Unified voice command router — classifies + handles in one Claude/Cerebras call |
| `service/src/claude.js` | AI backend selector — routes to Cerebras/Claude/custom based on settings |
| `service/src/carrier.js` | Carrier runtime — owns port 7777, WebSocket, PTY; spawns Craft on 17700 |
| `service/pan-loop.bat` | Windows respawn loop — restarts node on crash, stops on clean exit (code 0) |
| `service/public/mobile/index.html` | Phone dashboard — static HTML, no build step, served at /mobile/ |
| `dashboard/src/routes/terminal/+page.svelte` | Main dashboard UI (6000+ lines, both prod and dev) |

### Phone Dashboard Architecture
The phone opens the dashboard via **Android WebView** (not a browser — no address bar).
- **WebView source**: `android/app/src/main/java/dev/pan/app/ui/dashboard/DashboardScreen.kt`
- **Loads**: `http://127.0.0.1:<proxyPort>/mobile/?t=<timestamp>` via local Tailscale proxy
- **Cache**: WebView nukes all cache on every load (`LOAD_NO_CACHE` + `clearCache(true)` + timestamp bust)
- **Console logs**: `WebChromeClient` captures JS `console.log` → Android logcat as `PAN-DASH JS:`
- **Static HTML**: `service/public/mobile/index.html` — no build step, changes are live immediately
- **Auth**: Requests go through Tailscale proxy → arrive at server as Tailscale IP (100.x.x.x) → auto-authenticated
- **Sending messages**: Uses `/api/v1/terminal/pipe` (pipe mode) with session ID resolved from `/api/v1/terminal/sessions`
- **Receiving messages**: Polls `/api/v1/terminal/messages/<session_id>` every 3 seconds, fingerprint-based re-render
- **NOT the desktop dashboard**: Desktop uses SvelteKit (`/v2/terminal`), phone uses static HTML (`/mobile/`)

### Phone Voice Pipeline
Phone mic → Google STT (on-device) → text → server `/api/v1/terminal/send` or router
- **AI routing**: `service/src/claude.js` `getModelForCaller(caller)` checks `job_models` setting, falls back to `ai_model` setting
- **Current config**: `ai_model = cerebras:qwen-3-235b` → all router calls go to Cerebras (free, ~580ms)
- **Backend selection**: `getBackend()` in `claude.js` checks model prefix: `cerebras:` → Cerebras, Anthropic models → SDK or API key, other → custom
- **Usage tracking**: `ai_usage` table logs every call with caller, model, tokens, cost. Query via `/api/automation/usage`
- **Phone logs**: `LogShipper.kt` batches every 5s → `POST /api/v1/logs`. Pull with `curl /api/v1/logs?device_type=phone`
- **Browser telemetry**: Ship from mobile page JS via `fetch('/api/v1/logs', { body: { device_id: 'phone-dashboard', ... } })`

### Carrier/Craft Architecture
- **Carrier** (long-lived): owns port 7777, WebSocket, PTY sessions, reconnect tokens. Never restarts for code changes.
- **Craft** (replaceable): `server.js` running on internal port (17700+). Carrier proxies HTTP to Craft.
- **Swap**: `POST /api/carrier/swap` → new Craft spawns, health-checked, proxy switches, 30s rollback window
- **Port cleanup**: Carrier kills stale processes on port 17700 before spawning new Craft (prevents crash loops)
- **PAN.bat**: Launches `pan-loop.bat` in visible CMD window. Loop restarts on crash (exit code ≠ 0), stops on clean exit (code 0)
- **Sleep/wake**: After system sleep, old Craft may hold port 17700. Carrier cleanup + PAN.bat exit-on-healthy prevents infinite crash loop

<!-- PAN-CONTEXT-START -->
## PAN Session Context

This is a fresh session for the "PAN" project.
IMPORTANT: The project documentation is at the TOP of this CLAUDE.md file — read it first.

**Session context** (for the first message of a fresh session only — see Session Continuity Rule above):

### This Tab *(session: 511445f3-6a8)*
**User** (2026-04-19 22:03:29): What are you talking about You you shouldn't respond to background task conclusions those are those are things that you're you're saying you're you're responding to your own things No we definitely were going to design the system I'm pretty sure we a
**Claude** (2026-04-19 22:04:08): Saved. That's a real thing we need to build — agent names, status, what each one is doing, all visible in the dashboard so you always know who you're talking to and background work never floods the chat.

**Where we got to with TED:**

HTTP polling t
**User** (2026-04-19 22:04:14): Why don't you remove all these other devices that I have that are not relevant so I can actually see if it connects correctly
**Claude** (2026-04-19 22:04:39): All cleared. Now go to **Add Device** in the dashboard, grab the install command, run it on TED — you'll see exactly one device appear.
**User** (2026-04-19 22:10:49): OK I guess it's I guess it's connected now I already have the devices open on the dashboard and it didn't appear I had to go to the approvals which is a widget in the dashboard and then come back here to the devices for it to actually show the approv
**Claude** (2026-04-19 22:11:21): TED is live and responding. `pong` came back via HTTP queue (through Cloudflare, as expected). Want me to run a shell command on it to prove it?
**User** (2026-04-19 22:11:57): Umm so yeah I mean can you Yeah can you Yeah just run a shell command I don't know what you what are you gonna do hello world But like OK yeah just do it just so we can prove and then I have a ton a billion questions
**Claude** (2026-04-19 22:12:15): ```
Hello from TED
Ted
ted\tzuridis
```

That's TED's actual machine responding — hostname `Ted`, user `tzuridis`. Fire away with your questions.

### Recent Project Work *(session: 6238608c-d2e)*
**Claude** (2026-04-19 16:46:08): Push via GitHub Desktop (it has full token scope). Open it, click **Push origin**, done. Then to trigger the release build:

```
git tag v0.3.1
git push origin v0.3.1
```

Or push the tag from GitHub Desktop's **Repository → Push** after the main pus
**User** (2026-04-19 16:47:06): What are you talking about your you push why am I pushing what are you talking about you push did you push And you you push to GitHub and then you restart via the settings for the carrier restart
**Claude** (2026-04-19 16:51:22): Done. Here's what the QR flow looks like now:

1. Scan QR → page loads → **"⬇ Download PAN Installer"** button at the top, links to `github.com/Tereseus/PAN/releases/latest/download/pan-installer-win.exe`
2. GitHub is a trusted domain — Chrome and Ed
**Claude** (2026-04-19 16:51:47): Background upload finished clean. Everything's live — the download button on the QR page now points to a real, published binary at GitHub releases.
**User** (2026-04-19 16:55:08): OK I scan the QR code it shows the invite link but it's really fucked up Umm I have a screen shot of it on my phone if you want to look at it I clicked the download it actually downloads an EXE but windows blocks the EXE it says windows protected you
**User** (2026-04-19 16:56:50): I can't send you the screen shot it doesn't L it doesn't work on the phone but you have access to my phone to look at the screenshots I plugged my phone in It's actually a photo not a screen shot We were supposed to have to be ability to to upload ph

### Open Tasks
- [#394 backlog P2] Compose email — send returns HTTP 400, no email service wired
- [#376 backlog P1] Phone transcript race condition � messages from phone sometimes dont appear
- [#382 backlog P1] PAN.bat respawn loop failed to restart today
- [#51 in_progress] Voice marketplace ($1-2 each)
- [#52 todo] Voice personality packs
- [#53 in_progress] Cloud training for no-GPU users
- [#54 tod

[... context trimmed ...]
<!-- PAN-CONTEXT-END -->
