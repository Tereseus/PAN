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

### Step 2 — migrate phone voice-action off the terminal bridge (HIGH VALUE, tangled)
Goal: let `wearable` gate the browser-PTY/terminal server off. Blocker: the phone
currently drives a Claude session through `/api/v1/terminal/pipe` → `pipeSend`
in `terminal.js`/`terminal-bridge.js`.
- Keep `/api/v1/terminal/pipe`, `/send`, `/messages/:id`, `/wait-response` as a
  **thin HTTP shim that forwards to `claude-control.js`** (the always-on Claude
  Code PTY). Phone doesn't change → no APK rebuild, no plug-in.
- Then add feature flags + gates so `wearable` turns OFF: `terminal.js` WS PTY
  server (`/ws/terminal`), `screen-buffer.js`, reconnect tokens, `open_tabs`,
  `/api/v1/terminal/sessions|new|adapter|set-model|…`. Add `terminal_server` +
  `terminal_dev_api` flags to `profiles.js` (`['full','core']`).
- Trim `steward.cleanZombieSessions` to scope only claude-control/voice PTYs
  (it also resets the #807 frozen-adapter fix — keep that half).
- Verify: wearable boots, phone pipe still answers, no `/ws/terminal`.

### Step 3 — read-only situational view on the phone `/mobile`
The only surviving "dashboard." Add to the static `/mobile` screen: service
health, cloud/work-system state (inbox + ServiceNow/Jira/Slack watch), recent
notifications/alerts, current intuition snapshot, AI usage. Read-only — never a
terminal/model-picker/CRUD. Data endpoints already exist (`/dashboard/api/
services|stats|events`, `/api/v1/intuition/current`, `/api/v1/capture`). Also
split `chatRouter`/`dashboardRouter`: extract the KEEP endpoints (pan-reply/
incoming/unread, phone-ping, read-only status) into a slim router before those
big routers can be gated (they're boot-fatal if unmounted whole).

### Step 4 — pendant closes the loop
Once wearable is the daily driver, wire the pendant firmware's frame+audio stream
into PAN's capture (`/api/v1/vision` + `/api/v1/audio` or a new pendant endpoint)
so intuition sees/hears live.

### Also on the list (from Tereseus, not yet built)
- **Per-device capture control** — extend the `/privacy` capture toggles to each
  pan-client so a device's camera/mic can be killed to save battery (currently
  the toggles govern the hub only).

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
