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
- [todo P1] Smart device routing — default device (auto/nearest) determines where actions execute
- [todo P1] Chat shows only bookend events — need intermediate responses visible
- [todo P1] Terminal scroll still janky — jumps on tool calls
- [todo P1] mDNS auto-discovery on local network (zero-config device finding)
- [todo P1] PAN Hub relay server for remote access (HTTPS message broker)
- [todo P1] Multi-user accounts — user registration, login, session ownership
- [todo P1] Multi-database — per-team databases with isolated data
- [todo P1] PAN Hub — central server aggregating multiple PAN instances
- [todo P1] Smart scroll — remember exact scroll position, restore on every refresh/update/tool call
- [todo P1] NER anonymization (Presidio/spaCy)

### Recent Conversation
**Claude** (2026-03-31 18:55:08): Building with `gradlew.bat`. This will take a few minutes — I'll deploy to the phone once it's done.
**User** (2026-03-31 19:11:15): I tried to say like 100 things like I said Are you are you just ignoring what I Say I've I said so many things and you never replied to anything that I say stated about how you did something with medi
**User** (2026-03-31 19:14:00): How about no how about you don't restart the server how about you put the last action area back in there first how about you do that so that I can fucking see if it actually picks something up on my o
**Claude** (2026-03-31 19:16:46): Done. The phone app now has:

1. **"STT: ..." status always visible** on the main screen — shows exactly what the STT engine is doing (Muted, Starting STT..., Listening..., Error: NETWORK, etc.)
2. **Last Action still shows** when you say something that gets recognized

Open the app, go to the main 
**User** (2026-03-31 19:16:55): So even when I push the live button it still says STT muted that's why it still thinks I'm muted even though I pushed live live doesn't unmute STT
**Claude** (2026-03-31 19:18:39): Installed. Here's what was wrong:

**The Live switch in the UI was calling `sttEngine.enabled = true` directly on the singleton, but the STT callback was never set up from the ViewModel — only the ForegroundService's `onStartCommand` sets it.** So enabling STT did nothing because there was no callba
**User** (2026-03-31 19:19:18): OK now look in the logs it it did actually pick up my last action it did it the main conversation about Genies was back on March 23rd around 3:52 PM you asked why did jeannie's only give three wishes 
**User** (2026-03-31 19:21:43): Why are you looking for March 29th we literally were testing it right here on March 31st
**Claude** (2026-03-31 19:21:43): The genie query was classified as "recall" and sent to the server, but there's no RouterCommand event logged for it today. The response must have come back through a different path. The 10-second delay + errors you saw on the phone screen were the STT `ERROR: UNKNOWN(11)` retries before it finally c
**Claude** (2026-03-31 19:23:13): OK so the "recall" route goes through the router which uses `claude -p` to classify, then searches `memory_items` in the DB. The response goes back via HTTP but doesn't get logged as a `RouterCommand` event. That's why we can't see the response time.

Here's the summary of what we know from today's 
**User** (2026-03-31 19:23:40): How are they normal pixel retries why would it take so long to fit for it to figure that out it took 8 seconds to get a reply that's not correct so that means the router command that's supposed to be 
**Claude** (2026-03-31 19:27:02): Right — the stack is supposed to be:

1. **Phone local model** classifies first (instant)
2. Simple queries → **Cerebras** (fast, ~500ms)
3. Complex/recall queries → **Claude** (slow, ~8s)
4. Conversational awareness, context, etc.

But the local model on the phone says **"No on-device AI found. Usi
**User** (2026-03-31 19:29:15): Yeah there's no undevised bound because like I said 300,000 times that we disabled the media pipeline layer whatever bullshit because it was conflicting with the tail scale when they were both low so 
**Claude** (2026-03-31 19:43:47): Now we can see exactly what's happening:

1. **Feature status = 1** (DOWNLOADABLE — model exists but needs download)
2. **Model download started: 18MB** — it tried
3. **Download FAILED**: `AICore failed with error type 1-DOWNLOAD_ERROR` — "Failed to download file group feature_622"

The Gemini Nano 
**User** (2026-03-31 19:46:33): OK so well that's why we had that's why we had Quinn at 300 the 300 megabyte model that was enough to do the but also look at the other conversation that we had about classification for distress for w

### Last Messages (Full)
**Claude** (2026-03-31 19:27:02):
Right — the stack is supposed to be:

1. **Phone local model** classifies first (instant)
2. Simple queries → **Cerebras** (fast, ~500ms)
3. Complex/recall queries → **Claude** (slow, ~8s)
4. Conversational awareness, context, etc.

But the local model on the phone says **"No on-device AI found. Using regex classifier."** — so there's no local classification happening. The regex classifier catches "genies" as "passive" (ambient speech), then a keyword override catches "recall". Then it sends to the server which uses `claude -p` for recall queries, not Cerebras.

The on-device model (Gemini Nano via Google AICore) isn't working on the Pixel 10 Pro because `Google GenAI API available=false` — the SDK class isn't found at runtime even though AICore is installed. That's why everything falls back to regex → server.

The fix is either:
1. Get Gemini Nano actually working on the phone (needs the right SDK dependency)
2. Or make the server-side recall path use Cerebras instead of Claude CLI

Which do you want me to tackle first?

**User** (2026-03-31 19:29:15):
Yeah there's no undevised bound because like I said 300,000 times that we disabled the media pipeline layer whatever bullshit because it was conflicting with the tail scale when they were both low so they were just trying to use what Google has whether it's Google Assistant or whatever the fuck that shit is Google Gemini on the phone that's what you're trying to figure it out I mean my phone already has a model so why would we have to get Gemini Namo why do we have to get Nana we already tried that look in the database for what we tried look there you need a fucking look stop starting over from the beginning

**Claude** (2026-03-31 19:43:47):
Now we can see exactly what's happening:

1. **Feature status = 1** (DOWNLOADABLE — model exists but needs download)
2. **Model download started: 18MB** — it tried
3. **Download FAILED**: `AICore failed with error type 1-DOWNLOAD_ERROR` — "Failed to download file group feature_622"

The Gemini Nano model can't be downloaded. This is a known issue on Pixel phones — AICore needs Google Play Services to download the model, and it can fail due to:
- VPN interfering with Google's download servers
- The model not being available yet for this specific Pixel 10 Pro / Android version
- AICore needing to be updated through Play Store

The phone's built-in AI (AICore) is installed but the actual model isn't downloaded. This is Google's problem — we need the model file but Google's download service is failing.

For now, the fallback works: regex classification on-device + Cerebras on the server (500ms). The 8-second delay you saw was likely the first call warming up the connection through Tailscale, or the router falling through to `claude -p` instead of Cerebras for recall queries. Want me to make sure recall queries go through Cerebras instead of Claude CLI?

**User** (2026-03-31 19:46:33):
OK so well that's why we had that's why we had Quinn at 300 the 300 megabyte model that was enough to do the but also look at the other conversation that we had about classification for distress for we had a whole bunch of stuff distress you know should it be ambient should it should it take a role in the conversation show me all that stuff do you think the small 300 megabyte Quen model will be able to do that and show me all the classifications that we described And the the the recalls will be going to Cerberus in some way but what about shouldn't the the data be anonymized in some way it is it is already right from the because it it makes it makes a request to the server here the command hub to get that data from the database and then it goes to Cerebrosrit and that data is anonymized when it goes there


<!-- PAN-CONTEXT-END -->
