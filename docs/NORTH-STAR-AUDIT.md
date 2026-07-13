# PAN North-Star Audit

*Decided 2026-07 with Tereseus. Companion to [SHIP-PLAN.md](./SHIP-PLAN.md) and
[PAN-DEPENDENCY-MAP.md](./PAN-DEPENDENCY-MAP.md). Backed by a full 354-component
inventory (7-agent sweep of the whole codebase). This is the KEEP / TURN-OFF /
MAYBE ledger against the new north star, plus the roadmap.*

## 0. North star + the core principle

**PAN is a wearable, voice-first situational-awareness layer.** Four jobs:

1. **VOICE** — talk to it all day via the pendant. Voice in / voice out.
2. **WATCH** — watch the state of my cloud / work systems, my screen, my files.
3. **NOTIFY** — push to my phone when something needs me.
4. **VOICE-ACTIONS** — reply by voice to trigger actions through Claude Code /
   terminal-native LLM tools.

PAN is **not** a coding environment and **not** a dashboard dev tool. All coding
happens in terminal-native LLM tools (Claude Code CLI) + the PAN MCP server,
which gives the same data access the dashboard used to.

**THE CORE PRINCIPLE (Tereseus, verbatim): "I'm not saying delete it. Just turn
it off."** Nothing in this audit gets deleted. Everything classified TURN-OFF is
gated out of a new `wearable` boot profile — the code stays in the repo, `full`
can still run it, and any of it can be turned back on. This is the existing
`profiles.js` mechanism (core/full) extended one notch thinner.

---

## 1. KEEP — the non-negotiables

### The wearable voice loop (Job 1)
- **Phone application** — must exist. Listens all day (pendant mic → phone STT),
  talks back (phone TTS), barge-in. `GoogleStreamingStt.kt`, `PiperTtsEngine.kt`,
  `BargeInMonitor.kt`, `LogShipper.kt`.
- **Router + voice API**: `router.js` (route/handleUnified/routeStream), the
  voice fast-path, `/api/v1/query` + `/chat` + `/recall` (+ streams).
- **STT/TTS/local AI**: whisper (:7782), `tts.js`/`tts-worker.py`, conv-state
  endpointing, mic-router / speak-router presence routing, **ollama (:11434)** +
  embeddings.

### Situational state / intuition (Job 2) — must ALWAYS exist
- **Intuition cortex**: `buildSnapshot`, `classifyAxes`, `tickIntuition`,
  deliberation, `mind.js` (grounds every voice reply). `routes/intuition.js`.
- **Screen watching** — confirmed "somewhat important." Keep the presence/activity
  watcher (screen-watcher, activity-tracker; webcam opt-in per the privacy work).
- **Reading files / sections PAN needs** — screen + activity + capture feed the
  cortex; PAN reads what it needs via the MCP data tools.
- **Work-system watchers (the real "watch my cloud" job)** — these are the point:
  - **ServiceNow tasks thread** + **ServiceNow↔Jira playbook thread** — live,
    write-capable, the working example of "things update." KEEP.
  - **Email (IMAP)** watcher — the one in-repo cloud-state watcher.
  - Slack bridge (on work-pc) — external machine, KEEP as a watch source.
- **Capture → memory spine**: `logEvent` → `events`/FTS/embeddings, `memory_items`,
  hooks (Claude Code auto-capture), `exchange` (cloud-Claude write-back),
  transcript-watcher, `memory-search`.

### Notifications (Job 3)
- `intuition/action.js dispatchAction` (single-device rule that killed alert spam),
  `pan-notify.js`, `alerts`, the `pan` chat channel (pan-reply/incoming/unread),
  phone-ping. Notify → phone.

### Voice-actions via terminal LLM tools (Job 4)
- **MCP server for PAN** — the dashboard replacement. `mcp-server.js` (stdio, for
  Claude Code CLI) + `/mcp/pan` (HTTP) + `mcp/pan-tools.js`. Gives any LLM the same
  data/functionality the dashboard did. KEEP, central.
- **claude-control PTY** (voice → action executor, built deliberately *outside* the
  dashboard terminal stack) + `/api/v1/claude-control/*` + router `claude_control`/
  `task` intents + `_pickClaudeControlTarget`.
- **`/hooks/PermissionRequest`** — approve-by-voice/phone for Claude Code actions.

### QR onboarding + control all my computers (confirmed CRITICAL by Tereseus)
> "Control all my computers with just a QR code section of adding PAN to whatever
> computer you want... being able to see and interact with any system via SSH."

This is a first-class feature, not just infra:
- **Install / QR onboarding**: `/install/:token`, `/download`, `/api/setup-status`,
  static `/setup`, pan-client agent + tray/status scripts, invite tokens, APK serve.
- **Device control mesh**: `client-manager.js` (`/ws/client`), `/api/v1/client`
  (approve/deny, command dispatch, shell/SSH, heartbeat, presence), `/api/v1/devices`,
  device capability scanner, `_pickClaudeControlTarget` remote dispatch.
- **Transport**: **Tailscale** (promote to core — it's how the phone/pendant/notify
  and all remote-computer control reach each other).

### Infra (load-bearing regardless of job)
- **Super-Carrier → Carrier → Craft** — confirmed keep; needed for any change to
  PAN (hot-swap the always-on server without dropping pendant/phone).
- SQLCipher DB + capture spine; steward supervisors (health/restart/reap/sleep-wake);
  auth (single-owner Google sign-in only — strip roles/impersonate); replication
  (backup/restore — "never forgets"); capture-consent / sensors / incognito / privacy
  (the on/off + camera-off privacy floor we just built).

---

## 2. TURN OFF — gated out of the `wearable` profile (NOT deleted)

### The dashboard-as-dev-environment (the whole thing)
> "The terminal section does not matter at all. You don't even have to use the PAN
> dashboard — just use Claude Code and the MCP server."

- **Terminal / PTY-in-browser**: `terminal.js` WS server, `screen-buffer.js`,
  terminal-bridge, reconnect tokens, `open_tabs`, all `/api/v1/terminal/sessions|
  new|adapter|set-model|…`, model pickers.
- **The entire SvelteKit dashboard app**: routes `/terminal`, `/terminal-dev`,
  `/chat`, `/automation`, `/crucible`, `/kanban`, `/call`, `/compose`, `/atlas-v2`;
  the dev widgets (Perf, Tests, Benchmarks, Instances, Lifeboat, Pipeline, Tasks,
  Bugs, ApprovalBar, PtyStatusBar, CenterChatView, model picker). "The whole Svelte
  stuff is pointless."
- **Dev instance + QA**: `dev-server.js` (:7781), `routes/tests.js`, benchmark
  routers, `/perf/probe`, `/dev/*`, daily benchmarks.
- **Tauri desktop shell + window control**: `/api/v1/windows|ui-commands|popout`,
  `Voice.ahk` (already retired).
- **Runner**: `/api/v1/runner` (running dev servers from the browser).

### Not needed / superseded by future app-MCPs
- **Users / teams / applications** — "no point. Claude will just do computer use
  when it eventually has it." TURN OFF: `/api/v1/teams`, `/api/v1/users`+roles,
  impersonate, permissions matrix, AppsPanel.
- **Contacts / messaging** — "comes down to MCP tools of using certain applications
  (WhatsApp, Facebook, Instagram) — wait for those to be built." TURN OFF contacts/
  compose/messaging-prefs for now; re-enable per-app as their MCPs land.
- **Browser / computer automation** (`/api/v1/browser`, accessibility) — superseded
  by terminal-native tools + future computer-use.

### Dead / experimental loops (serve nothing)
- scout, orchestrator, evolution, autodev (Forge), stack-scanner, personal-sync,
  remote-screen-watcher, dashboard-watchdog / render-health / vision-verifier /
  forge-dashboard (all babysit the dead dashboard), nourishment/signals need-adapters
  (nothing consumes them under the `{safety}` allowlist). These are removed from ALL
  profiles — they don't even belong in `full`.

### Off-mission, carve off
- **Paean Records music subsystem** (`/api/v1/quality-log`, `/mcp/quality-log`,
  tools, `quality_log` table) — a separate project. Turn off in PAN; it keeps
  running as its own thing.

---

## 3. MAYBE — read-only situational view (the ONLY dashboard survivor)

If any dashboard survives, it is a **read-only status/widgets view**, ideally
rehosted on the phone `/mobile` screen, showing: service health, cloud/work-system
state (inbox, ServiceNow/Jira/Slack watch), recent notifications/alerts, the current
intuition snapshot, active call, AI usage/cost. It must **never** regain a terminal,
model picker, task CRUD, or deploy controls.

- **Atlas** — Tereseus started to cut it, then said "no, we need that." Resolution:
  the **Atlas as a live system/situational map** (services + devices + what PAN is
  doing) is a legit read-only situational view → MAYBE-keep. The old *interactive*
  Atlas dev-diagram is not. (The QR/computer-control feature he pivoted to naming is
  already KEEP in §1 — separate thing.)
- Survivor widgets (read-only): Intuition (strip cam/enroll controls), Services,
  Devices, Alerts/Approvals (data path KEEP, panels view-only), Usage, Mail-read.
- `/settings` stays (KEEP infra — configures model, email watch, devices, auth).
- Collapse redundancies: `/timeline` vs `/kronos` (one); three Atlas copies (≤1).

---

## 4. Things not explicitly named but load-bearing (flagging so nothing slips)

- **DB / capture / memory spine** — the foundation; obviously KEEP.
- **Privacy / capture-consent / camera-off** — the trust floor we just built; KEEP.
- **Backup / replication** — "never forgets" depends on it; KEEP.
- **Data-staking / anonymize** (`/api/v1/anonymize`, export) — a real PAN business
  goal but orthogonal to the four jobs; MAYBE/later, not in the wearable core.
- **The pendant firmware itself** (ESP32-S3 cam+mic → phone) — the new sensory input;
  the whole reason for this refactor.

---

## 5. Traps — tangled cuts that need care (boot-fatal risk)

A route module that fails to import kills the whole Craft. And several files mix
KEEP + TURN-OFF. So gating (not deleting) is safest, and these need order:

1. **`terminal-bridge.js` / `/api/v1/terminal/pipe`** — how the phone currently
   drives a Claude session. Migrate the phone voice-action path to `claude-control.js`
   BEFORE gating terminal off. Most tangled.
2. **`chatRouter` + `dashboardRouter`** — each mixes KEEP (pan-reply/incoming/unread,
   phone-ping, read-only status) with OFF (mail/calendar/contacts, task/tab CRUD) in
   one router. Extract the keepers into a slim router before gating.
3. **Tailscale** — currently `full`-only in profiles; it's load-bearing for phone/
   pendant/notify AND all remote-computer control. Promote to core.
4. **`client-manager` / `getOllamaUrl`** — never gate off client-manager; local AI
   (embeddings/memory) silently breaks (Ollama URL discovery runs through it). Also
   it's the device-control mesh — a KEEP feature now.
5. **`carrier.js`** — KEEP the process; gate its Phase 5/6/7 sub-features (handoff/
   shadow/crucible) surgically inside the file.
6. **`steward.cleanZombieSessions`** — manages dead dashboard PTYs (OFF) but also
   resets frozen claude-control/voice adapters (KEEP, the #807 fix). Trim, don't cut.

---

## 6. Where we go from there

### Step 1 — the `wearable` profile (reversible, no deletions)
Extend `profiles.js` with a third profile below `core`:
- Does NOT mount the OFF routers/WS servers (terminal, tests, dev, runner,
  benchmark, quality-log, teams, browser, users) and does NOT serve the SvelteKit
  dashboard static (or serves only the read-only status subset).
- Does NOT start the OFF loops/watchers (scout/orchestrator/evolution/autodev/
  stack-scanner/personal-sync/remote-screen + dashboard self-healers + nourishment/
  signals).
- Promotes **Tailscale to always-on**.
- KEEPS: boot chain, DB + capture, intuition, voice pipeline, notify, claude-control
  + hooks + MCP, QR/device-control mesh (client-manager/devices/install/SSH),
  capture-consent/privacy, replication.
- `full` still runs everything; the dead experiments get pulled from all profiles.

### Step 2 — the tangled migrations (in trap order)
- Move the phone voice-action path off `terminal-bridge.js pipe` onto `claude-control.js`.
- Split `chatRouter`/`dashboardRouter` — extract the notify + read-only-status keepers.

### Step 3 — the read-only situational view
Decide whether the survivor widgets live on the phone `/mobile` screen or a stripped
status shell. Build only that; never let it become a dev tool again.

### Step 4 — the pendant closes the loop
Once the wearable profile is the daily driver, the ESP32-S3 pendant (camera every
~10s + audio) becomes PAN's live sensory organ — the input the whole voice-first
layer was built to consume.

---

## Ledger note

The full 354-component inventory (per-endpoint KEEP/CUT/MAYBE with file:line, from
the 7-agent audit) is the backing record for this doc. This file is the decision
layer; the inventory is the evidence. Update this doc when a KEEP/OFF call changes.
