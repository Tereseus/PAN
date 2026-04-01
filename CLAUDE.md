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
**User** (2026-03-31 21:59:48): Well the whole point of the data dividend was so that people could make money with their data right So I mean I guess I could do the model where you have the personalization and then it shows you the 
**Claude** (2026-03-31 22:00:38): Two separate revenue streams for users, both without data leaving:

**Stream 1: Attention matching** (what we just designed)
- Advertisers broadcast → your PAN matches locally → you get a cut
- This is the commerce side, revolves around buying

**Stream 2: Data contribution** (the real data dividend
**User** (2026-03-31 22:05:51): Yeah so it's it's not just local model update on your device it's everything all the data so that as so many other companies will be looking for this data to make stuff better right so like attention 
**Claude** (2026-03-31 22:06:42): Here's the truth: the 1% fee isn't your moat. The **network effect** is.

A fork at 0.5% with 100 users is worthless. No advertiser is going to broadcast to 100 people. They'll pay PAN's 1% to reach 10 million people. That's why Google wins — not because they're cheaper, but because everyone's alrea
**User** (2026-03-31 22:09:12): Attention matching literally has to do with users buying something though so they're not actually making money there Training contributions again sensor data did like like all of these values that you
**Claude** (2026-03-31 22:09:44): Yeah. You're talking about the real problem — AI replaces jobs, people need income, data dividends was supposed to be that income source. And $20/month is insulting. That's not a solution.

The honest answer: passive data collection alone won't replace a salary. The numbers don't work because data i
**User** (2026-03-31 22:13:40): Yeah I guess Pan basically becomes your own robot worker right and everybody's assigned one and that's basically how they survive I guess when you think about it when AI takes over what the fuck this 
**Claude** (2026-03-31 22:14:09): Yeah. You just worked through the whole economic reality in real time. The conclusion is honest:

- Data dividends as passive income = gimmick, pennies
- AI replaces all the micro-tasks that could earn money
- PAN-to-PAN communication eliminates customer service, scheduling, negotiation
- Real money
**User** (2026-04-01 10:02:34): ΠΑΝ remembers... Start session. Read CLAUDE.md and give the session continuity summary.
**Claude** (2026-04-01 10:02:45): Last time we were working on:

- **Git push fix** — OneDrive symlink paths were causing issues, got it resolved so all 151 commits show on GitHub
- **Data dividends deep dive** — worked through the full economic model: attention matching (advertisers broadcast, PAN matches locally), training contrib
**User** (2026-04-01 10:05:31): I see a couple of issues for one via auto hotkey stuff that we have on restart I restarted my computer it didn't it didn't actually activate the auto hot key so put that as a bug the other thing that 
**User** (2026-04-01 10:09:06): Number three is caused by Windows voice to text randomly inserting stuff and you know that you stated previously I think this only happens when you're in the terminal though the input box doesn't real
**Claude** (2026-04-01 10:09:29): All 7 tasks captured. My take on priority:

1. **#5 Approvals tab + tab flashing** — you said this is really important
2. **#1 AHK not starting on reboot** — quick fix, foundational
3. **#2 Conversation loads before terminal ready** — blocks first-use experience
4. **#3 Steward not running** — relat
**User** (2026-04-01 10:10:23): Yeah exactly no so not when you're stuck in terminal mode it's when you're in chat mode there's no way to send escape now that when you when you're in terminal you can push escape that's that's what t
**Claude** (2026-04-01 10:25:12): Server's back up. Running on port 7777, uptime 10s. No Tailscale IP detected but local access is working.

Last session you were deep in the economic model conversation — data dividends, PAN-to-PAN communication eliminating jobs, UBI as the real answer. On the dev side, dashboard naming cleanup was 

### Last Messages (Full)
**User** (2026-04-01 10:09:06):
Number three is caused by Windows voice to text randomly inserting stuff and you know that you stated previously I think this only happens when you're in the terminal though the input box doesn't really 'cause this problem as much but it's not really like a traditional bug it's a Windows voice to text weird copy paste retard retardation shit We need a hotkey to switch between the terminal chat and the chat right so like the little bullying we have at the bottom and the terminal and the terminal tab So there should be like a little hot key to switch between those and then there's certain things like if you're stuck in the terminal chad you can't push escape to make you stop you have to switch right so then you have to push 2 keys to make you stop Maybe there could be like a stop button too or something I guess just that would send the you know the information to the terminals to to push escape to stop the terminal from doing whatever it's doing Even though I don't know that's really worth it but anyway some of the terminal commands don't work when you're in the chat instead of being in the terminal right In the chat in this case I mean the remember I'm always talking about the bullying here i'm not talking about the conversation tab Oh yeah approval staff is really important Yeah so you got it you got everything else yeah that's all good yeah


**Claude** (2026-04-01 10:09:29):
All 7 tasks captured. My take on priority:

1. **#5 Approvals tab + tab flashing** — you said this is really important
2. **#1 AHK not starting on reboot** — quick fix, foundational
3. **#2 Conversation loads before terminal ready** — blocks first-use experience
4. **#3 Steward not running** — related to #2, steward should manage this
5. **#4 Device naming + sections** — UI polish
6. **#7 Hotkey toggle** — quality of life
7. **#6 Classifier → Intuition architecture** — bigger design work

Want me to start with approvals, or you want to reorder?

**User** (2026-04-01 10:10:23):
Yeah exactly no so not when you're stuck in terminal mode it's when you're in chat mode there's no way to send escape now that when you when you're in terminal you can push escape that's that's what that's what that meant OK let's do those well approvals tab and approvals flashing it's important I wouldn't say maybe you know that all of these are important they're all basically you know just as important they're all just do it by easy easiest verse to hardest I'd say

**Claude** (2026-04-01 10:25:12):
Server's back up. Running on port 7777, uptime 10s. No Tailscale IP detected but local access is working.

Last session you were deep in the economic model conversation — data dividends, PAN-to-PAN communication eliminating jobs, UBI as the real answer. On the dev side, dashboard naming cleanup was done, input paste fix was in testing, dream cycle set to 12h, and double memory injection was fixed.

<!-- PAN-CONTEXT-END -->
