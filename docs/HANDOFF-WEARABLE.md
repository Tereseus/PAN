# Handoff — PAN Wearable Refactor (resume here)

*Written 2026-07-13 at a context limit. A fresh session (or Tereseus) picks up
from this. Read [NORTH-STAR-AUDIT.md](./NORTH-STAR-AUDIT.md) first — this is the
"what's next + how" companion.*

## Where we are

PAN pivoted to a **wearable, voice-first situational-awareness layer**. Four jobs:
(1) voice all day via a pendant, (2) watch cloud/work systems, (3) notify the
phone, (4) reply by voice to trigger actions through Claude Code / terminal LLM
tools. **Not** a coding env, **not** a dashboard dev tool. Governing principle:
**"turn off, don't delete."**

### Done ✅
- **North-star audit** (354-component sweep) → `docs/NORTH-STAR-AUDIT.md` (KEEP/
  TURN-OFF/MAYBE ledger + roadmap).
- **`wearable` boot profile SHIPPED** (`profiles.js`, `server.js`, `steward.js`).
  `PAN_PROFILE=wearable`: dashboard `/v2/*` 404, quality-log/teams/runner off;
  email/sensors/capture/incognito/sync/intuition/MCP on; tailscale + device mesh
  on; claude-control on. 9 steward services. Prod `full` verified byte-identical.
  Last commit: `a51bbcb`.
- **Step 2 SHIPPED** — `wearable` now gates the **browser xterm terminal WS
  server** off (`terminal_server` flag) while the phone's voice-action path
  keeps working unchanged. **Deviated from this doc's original plan** (which said
  "forward pipe → `claude-control.js`"): reading `terminal.js` showed the phone's
  pipe mode only depended on the WS server for one thing — `ScreenBufferClass`,
  which was lazy-loaded *inside* `startTerminalServer()`. Fixed by eager-loading
  ScreenBuffer at module top, so `createPipeSession`/`pipeSend`/`getSessionMessages`
  run standalone. This keeps **real per-session transcripts** (the claude-control
  ring-buffer rewrite would have lost `/messages/:id`) and needs **no APK change**.
  Gated at both boot sites: `carrier.js` (prod: Carrier owns the PTY) and
  `server.js:5414` (standalone/dev). Verified on dev-server :7781: wearable →
  no `/ws/terminal` (no 101), but `/new`+`/sessions`+`/pipe`+`/messages` full
  round-trip works (adapter replied "PIPE_OK", transcript retrievable). `full` →
  `/ws/terminal` returns 101, terminal ready; prod craft-swapped + verified
  byte-identical. Did NOT gate the terminal HTTP endpoints (`/sessions|new|
  set-model|…`) as the original plan suggested — **the phone uses them**; they're
  cheap handlers that need no WS server. Did NOT add `terminal_dev_api` or trim
  `cleanZombieSessions` (it already only touches sessions in the Map, which in
  wearable are just the phone's pipe sessions, and it preserves the #807 fix).
- Earlier in this arc: identity/camera made opt-in (camera off by default),
  `/status`+`/privacy` capture-consent console, cloud-Claude capture write-back
  (`pan_log_exchange` + `/api/v1/exchange` + CloudExchange FTS indexing),
  `/mcp/pan` umbrella MCP + plugin, quality-log MCP.

### The pendant (hardware, ordered)
Sensory input for the whole layer. Decided build:
- **QCY T13 ANC2** (circular blue earbud case, ~€16, ordered) — gut the cradle,
  KEEP its LiPo + USB-C charging board + magnetic shell. Charge via the case's
  back USB-C (do NOT expose the fragile XIAO port).
- **Seeed XIAO ESP32-S3 Sense** (already owned) — camera + mic. Solder battery to
  its BAT+/BAT− pads (two dots; watch polarity, red=+). Glue camera to the lid,
  drill a lens hole + a 1mm mic pinhole, seal closed.
- Wear via neodymium magnets (glue to back + magnet behind shirt) — ordered.
- Firmware: fork **OpenGlass** (Based Hardware / Omi ecosystem, XIAO S3 Sense
  based). Capture a **frame every ~10s + continuous audio** (NOT continuous
  video — that's the battery killer). Stream to PAN over WiFi/BLE via the phone.
- Battery reality: ~few hours on the case's ~400mAh with audio; fine for an
  evening. Duty-cycle stretches it.

## What's next — in trap order (do NOT reorder)

### Step 2 — DONE (see "Done ✅" above for the shipped approach + verification)
The browser xterm WS terminal server is now gated off in `wearable` via the
`terminal_server` flag, with the phone's pipe path decoupled from it. Next is
Step 3.

### Step 3 — situational view on the phone `/mobile` — REDIRECTED + core SHIPPED
Two findings reshaped this step:
1. The `/mobile` page is **already** a full situational view (11 tabs: intuition,
   usage, alerts, tasks, services, devices, sensors, events). Hand-coding more
   widgets would duplicate it.
2. **New direction (Tereseus, 2026-07):** don't build one universal dashboard or
   poller. Each thing worth watching gets its **own purpose-built HTML page fed
   by its own push scripts** (WoE, ServiceNow, ops…), each on its own host/port
   (`localhost:877x`, `100.86.16.10:8791`, different IPs). PAN holds a
   **registry** of them so it knows what exists and renders them on the phone —
   plain HTML renders on mobile where the SvelteKit dashboard never did. This
   also retires the dead universal remote-screen poller for good.

SHIPPED: a **dashboard registry** — table `dashboards` + `routes/dashboards.js`
(`GET/POST/PUT/DELETE /api/v1/dashboards` + `GET /api/v1/dashboards/probe` health
check), always mounted every profile, and a new `/mobile` **Dashboards** tab
(2nd tab) that lists registered dashboards with health dots, opens each in a
full-screen iframe (`Open direct ↗` fallback for X-Frame-blocked pages), and has
an inline add/delete form. Verified in prod: register → probe(up) → open(iframe)
→ delete round-trip; card renders + health dot + iframe src correct.

What's left on Step 3:
- **Register the real dashboards.** WoE + ServiceNow dashboards exist on other
  hosts/ports (one ~`877x`, one `8791`, different IPs) — get exact URLs from
  Tereseus and either POST them or add via the phone. Registry seeded empty on
  purpose (no guessed URLs).
- The genuine remaining watch-gap is a **work-systems glance** (inbox +
  ServiceNow/Jira/Slack). With the registry, the clean way is to build that as
  its own small HTML dashboard fed by the SN/Jira/Slack bridges and register it,
  rather than hand-coding it into `/mobile`.
- (Deferred, only if a big router must be gated later) split `chatRouter`/
  `dashboardRouter` to extract KEEP endpoints — they're boot-fatal if unmounted
  whole. Not needed for the registry.

### Step 4 — pendant closes the loop
Once wearable is the daily driver, wire the pendant firmware's frame+audio stream
into PAN's capture (`/api/v1/vision` + `/api/v1/audio` or a new pendant endpoint)
so intuition sees/hears live.

### Also on the list (from Tereseus)
- **Per-device capture control** — PARTIALLY SHIPPED. `capture-consent.js` now
  has device-aware consent (`isDeviceCaptureOn`/`setDeviceCaptureConsent`, key
  `capture_<name>@<device_id>`, default ON). `GET /api/v1/capture` returns a
  `devices[]` array (read from the `devices` DB table — the Craft's in-memory
  client map is always empty), `POST /api/v1/capture/:name` takes an optional
  `device_id`. `remote-screen-watcher.js` skips devices opted out. The phone
  `/mobile` Sensors tab now shows a "Capture & Privacy" card: the hub's own
  camera/screen/activity kill-switches (these WORK today) + per-device screen
  toggles ("save battery"). Verified in prod: API round-trips, toggles persist,
  card renders + fires the API. **What's left:** (1) the continuous remote
  poller (`remote-screen-watcher`) is currently a **no-op in prod** — it runs in
  the Craft (server.js:5682) where `getConnectedClients()` is empty, so per-device
  screen throttling has no live target yet; the gate is correct and future-proof
  for when capture is active. (2) push a `capture_control` command to the client
  so it also refuses locally (defense-in-depth) — needs a client/pendant rollout.
  (3) camera/mic per-device once clients/pendant expose those watchers (Step 4).

## Traps / gotchas (respect these)
- **Route imports in `server.js` are boot-fatal** — gate the `app.use(...)` mount,
  never break the import. Verify each cut with a boot.
- **Don't cut `client-manager`** — `getOllamaUrl` discovers remote Ollama through
  it; local AI silently breaks. It's also the device-control mesh (KEEP feature).
- **Tailscale** is now core for wearable — don't let a profile strip it.
- `chatRouter`/`dashboardRouter` mix KEEP + OFF — extract keepers, don't unmount.
- `carrier.js` KEEP the process; its Phase 5/6/7 (handoff/shadow/crucible) cut
  surgically inside the file.
- `/health` on :7777 is the **super-carrier's** (no `profile` field); the craft's
  profile is in the boot log and on the craft's internal port / dev-server :7781.

## How to work / test
- Reload code: **Craft swap** `POST http://127.0.0.1:7777/api/carrier/swap`
  (swap=safe, restart=death — never `node server.js` standalone; it wedges).
- Test a profile in isolation: `PAN_PROFILE=wearable node dev-server.js` (:7781),
  then curl the routes. Verify `full` after every change via a prod swap.
- Key files: `service/src/profiles.js` (the profile gates), `server.js` (mounts +
  boot), `steward.js` (service registry `profiles:` tags), `router.js` (voice),
  `intuition/`, `claude-control.js`, `client-manager.js`.
- Repo: github.com/Tereseus/PAN, branch master. All work committed + pushed.

## Reference docs
- `docs/NORTH-STAR-AUDIT.md` — the KEEP/OFF/MAYBE ledger + roadmap (source of truth).
- `docs/SHIP-PLAN.md` — core/full profiles, capture write-back, install path.
- `docs/PAN-DEPENDENCY-MAP.md` — who-imports-whom, removability matrix, the traps.
- `CLAUDE.md` — project rules (autonomous mode, swap-not-restart, windowsHide, etc).
