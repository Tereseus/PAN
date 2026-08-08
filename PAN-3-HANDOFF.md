# PAN 3 — Work-in-Progress Handoff

**Tab:** `dash-pan-1779102650923` (PAN 3)
**Snapshot:** 2026-05-18 19:30 PT
**Reason:** Tab is unresponsive in dashboard; preserving full state so it can be resumed without restarting from zero.

---

## Resume into pan-3 with full transcript

Three claude UUIDs ran in this tab today. **All three are now stamped onto `open_tabs.claude_session_ids`** (was `[]` before — that's why refresh wasn't restoring).

JSONL transcripts live at:
```
~/.claude/projects/C--Users-owner-Desktop-PAN/
  faa28c5b-8344-4723-b965-c534f86a0d6e.jsonl   # 07:11–08:00 — 10 prompts — UUID-stamp + open_tabs bug diagnosis
  1b07ef17-a017-436f-8e1c-85908ab832a0.jsonl   # 08:14–15:27 — 32 prompts — T1/T2/T3 + mic-routing build (the big one)
  29a93581-45fb-401a-a3b1-950594bed08e.jsonl   # 15:27–15:36 — 4 prompts — last short check-in before tab went unresponsive
```

To resume the most recent thread: `claude -r 29a93581-45fb-401a-a3b1-950594bed08e`
To resume the big T1/T2/T3 session: `claude -r 1b07ef17-a017-436f-8e1c-85908ab832a0`

---

## What pan-3 was doing — by task

### ✅ DONE / shipped today

| Task | Status | Files |
|---|---|---|
| **Mic-input routing** (mirror of TTS speak-router) | shipped, loaded after craft swap @ 14:50 | `service/src/mic-router.js` (NEW, 212 LOC), `pan-client/pan-client.js` `+audio_capture` (+85 LOC), `service/src/server.js` `POST /api/v1/listen` + `GET /api/v1/listen/preview` (+25 LOC) |
| **T1 (#665) — schema additions for ownership** | DONE, live | `service/src/schema/ownership.js`: `devices.owner_user_id`, `devices.room`, `devices.display_name`, `identity_clusters.user_id`, `device_aliases.added_by_user_id`. All 5 devices auto-owned by owner. (Speculative tables `device_capabilities` + `device_preferences` were dropped — `smart-router.js` + `action_preferences` already exist.) |
| **T2 (#674) — pan-client capability poller** | `in_test`, staged on minipc, queued for desktop-pc | `pan-client/pan-client.js`: `staticCapabilities` + `liveCapabilities` + Proxy back-compat; `probeCapabilitiesWindows()` returns 21 live tags (BT, mic, speakers, display, gpu); 5-min refresh on WS-open/reconnect/HTTP poll. macOS/Linux stubs empty (no crash). |
| **T3 (#667) — identity binding backend** | `in_test`, smoke-tested, auto-bind verified | `service/src/routes/identity.js` (NEW, 250 LOC): `GET /clusters`, `GET /clusters/:id`, `POST /clusters/:id/bind`, `POST /clusters/:id/reject`, `POST /observe`, `GET /thumb/:id`, `GET /voice/:id`. Webcam hook calls `observeFace()` on known identity. Voice `/identify` calls `observeVoice()`. Auto-bind: `face_conf × voice_conf ≥ 0.85` + label CI-matches `users.display_name`/`display_nickname` within 5-min window → `status='auto'`, `user_id` set. UI rolled into T10. |
| **minipc client restart via SSH** | DONE | PID 9580, WS connected, **26 caps** including paired iPhone via BT, AMD mic array. PowerShell scripts at `%USERPROFILE%\AppData\Local\Temp\pan-*.ps1`. |

### ⏸ AWAITING USER DECISION (this is where pan-3 stopped)

Last assistant message in pan-3 (15:27:38):
> **"T3 backend shipped and verified. Awaiting your call on T4 (mic arbitration) vs T6 (smart-router scoring)."**

Pick one to continue:

- **T4 — Mic arbitration**: every mic that hears an utterance reports RMS/SNR/match, server picks winner, losers suppress. Winner's device determines "where" for routing. Depends on live two-way WS (desktop-pc stale-WS bug below is a blocker).
- **T6 (#676) — Smart-router scoring extension**: `smart-router.js` already exists with `pickDevice()`, `NATURAL_DEVICE_HINTS`, `DEVICE_CAP_SCORES`. Only 3 small additions needed (not a rewrite). Independent of desktop-pc fix.

### 🐛 TWO OBSERVATIONS LEFT OPEN

1. **desktop-pc stale-WS**: dashboard shows `online=true`, but every WS-bound command falls to http-queue and times out. Either WS dropped without close-frame and DB wasn't updated, or queue routing is broken for desktop-pc. **Blocks T4** since mic arbitration needs live two-way comms.
2. **Two pan-client.js processes on minipc**: PID 10144 (relative path, parent = interactive PowerShell) + PID 8088 (absolute path at `%LOCALAPPDATA%\PAN\client\`, parent dead). Only one registers as minipc in DB. Killing 10144 may close someone's interactive PS window. Staged update only affects 8088.

### 📋 BACKLOG (in the order T1/T2/T3 was set up to enable)

| # | Task | Notes |
|---|---|---|
| T8 (#678) | Extend `learnCorrection` with auto-alias-write on disambig resolve | "play music on the projector" → ask "which?" → user picks Predator → silently writes `projector → Predator` alias for that user/org |
| T10 | Dashboard Devices+Identities panel | UI for T3 cluster review + T1 device ownership + T6 routing visualization. Single panel, not two |
| T11 | Installer prompt for `room` + `display_name` at setup; PAN asks in chat if device connects unnamed | Populates fields T6 needs |
| T12 (#681) | Pixel-duplicate-record nightmare bug (3rd recurrence) + regression test gate | Independent of critical path |

---

## CRITICAL — unfinished from morning, still not loaded

Two fixes were written to the working tree this morning but the Carrier has not been restarted since 08:12:40, so they are **not running**:

1. **`service/dashboard/src/routes/.../dashboard.js`** — clobber-merge fix in POST + PUT `/api/open-tabs` so frontend bulk writes don't wipe `claude_session_ids`
2. **`service/src/terminal.js`** — JSONL UUID discovery watchdog (scans `~/.claude/projects/<slug>/` for newest JSONL, pushes UUID into `session.claudeSessionIds`, server-side PUT)

**Why the open_tabs row was `[]` despite 3 claude sessions running today: those fixes never loaded.** I just manually stamped the row above, but the next frontend bulk-write will re-empty it unless Carrier reloads with the fixes.

**Carrier restart will kill pan-3's PTY** (PID 52460, 11h uptime — lives in Carrier, not Craft). The PTY is the bash shell hosting the adapter; restart spawns a fresh one. Transcript is preserved via the UUIDs above, so resume is `claude -r 1b07ef17…` after restart.

Sequence to land both safely:
```
1. git add service/dashboard/src/routes/.../dashboard.js service/src/terminal.js
2. git commit -m "fix: persist claude_session_ids on open_tabs (#457 leftover)"
3. POST /api/carrier/restart
4. After reconnect: open pan-3, choose "resume 1b07ef17" or "resume 29a93581"
```

---

## Why this file exists

User: "I keep having to start over because this thing does not work correctly. You understand that I keep fucking starting over and it's very difficult to come back."

This file is the manual workaround until the open_tabs persistence bug stays fixed across restarts. If pan-3 looks empty again, read this file + `claude -r <uuid>` against the JSONLs listed at the top.
