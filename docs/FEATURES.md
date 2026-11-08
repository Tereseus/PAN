# PAN Features Registry

**This file is the single source of truth for what every PAN button, widget, and
endpoint does.** If you're Claude and you're about to guess what a UI element
does, STOP. Look here first. If it's not here, add it here before answering.

Rules:
- One entry per feature. Headings describe location in the UI.
- Each entry must state: **Calls**, **Semantics**, **Preserves**, **Replaces**, **Pre-gate** (if any).
- When a feature changes, update this file in the same commit.

---

## Lifeboat widget (dashboard sidebar)

- **Purpose:** Blue/green swap of the **Craft** process only.
- **Calls:** `POST /api/carrier/swap`
- **Semantics:** Spawns a new Craft on the next port (17700+), health-probes it,
  flips the proxy to point at the new Craft, keeps the old one alive for a
  30-second rollback window. Auto-rolls back if any `SWAP_GATE` probe in
  `service/src/perf/stages.js` fails during that window.
- **Preserves:** Carrier process, PTY sessions, WebSocket, Claude CLI children,
  reconnect tokens, Steward, orphan reaper, device heartbeat.
- **Replaces:** The `server.js` process (and everything inside it — routes,
  DB handlers, MCP server, dashboard routes).
- **Pre-gate:** New Craft must answer `/health` AND `perfEngine.isSwapSafe()`
  must be true before commit. Otherwise carrier runs `performRollback()`.
- **UI state:** `lifeboatSwapping`, `lifeboatSwapStarted`, rollback countdown.
- **Automatic trigger:** the Carrier's liveness watchdog runs the same swap when
  the primary Craft misses `/health` for ~90s (wedged event loop). See
  `docs/SUPER-CARRIER.md`.

---

## Settings → Restart PAN

- **Purpose:** Full restart of the **Carrier** process (and everything with it).
  Use this when you changed `carrier.js`, `stages.js`, `probes.js`, or
  `engine.js` — a Craft swap cannot pick up those changes.
- **Calls:** `POST /api/carrier/restart`
- **Semantics:** Carrier broadcasts `carrier_restarting` on WS to all clients,
  flushes PTY reconnect tokens to DB, then `process.exit(1)`. `pan-loop.bat`
  sees non-zero exit and respawns `node carrier.js`. New carrier reads current
  disk code and re-attaches PTYs via their stored reconnect tokens.
- **Preserves:** PTY sessions (via reconnect tokens), DB, Claude CLI children
  that were spawned by the PTY (if the token-reattach succeeds).
- **Replaces:** Carrier process, stages/probes/engine, the Craft child
  (carrier respawns a fresh Craft on startup).
- **Pre-gate:** `perfEngine.system_ready` must be true (don't kill a healthy
  carrier while something else is already broken). Returns 409 with reason
  if unsafe.
- **Client behavior:** On `carrier_restarting` WS event, show a banner
  "Restarting PAN… reconnecting in ~3s", close WS, retry connect every 500ms
  until the new carrier answers, then reattach PTY via `reconnect_token`.
- **Label in UI:** "Restart PAN" (was previously "Reload Server (Craft Swap)"
  which misleadingly duplicated Lifeboat).

---

## Dashboard sidebar → Instances → Dev Restart

- **Purpose:** Restart the **dev instance** on port 7781 only. Prod (7777) is
  untouched.
- **Calls:** `POST /api/v1/dev/restart`
- **Semantics:** Kills any process holding 7781, spawns
  `node service/dev-server.js` with `PAN_DEV=1`, polls `/health` until healthy,
  returns.
- **Preserves:** Prod carrier, prod craft, everything on 7777.
- **Replaces:** Only the dev node process on 7781.
- **Pre-gate:** None.

---

## Perf panel (left or right sidebar → Perf)

- **Purpose:** Live readiness dashboard — what's ready, what's failing, critical
  path, swap-safety.
- **Reads:** `GET /api/v1/perf/trace` every 5s (polled).
- **Writes:** `POST /api/v1/perf/probe/:id` on ↻ click, `POST /api/v1/perf/event`
  for client-side hot-path timings.
- **Views:** List (stages grouped by phase) and Gantt (bars on shared timeline).
  View preference persists in `localStorage.pan_perf_view`.
- **Registry:** `service/src/perf/stages.js` is the single source of truth for
  stages, budgets, and the DAG. The math spec is auto-generated via
  `GET /api/v1/perf/trace?format=markdown`.
- **Client mirror:** `_loadTimings` (page load) and `_sendTimings` (last message
  round-trip) also shown; these are per-page, not polled.

---

## Terminal tab → + button (new tab)

- **Purpose:** Spawn a new PTY + new `claude -p` session.
- **Calls:** WS `create_session` message, spawns `claude -p --project <dir> --model <model>` in a fresh PTY.
- **Semantics:** Each tab is an independent PTY + Claude CLI child. Closing the
  tab kills that Claude process only.
- **Model selector:** Changing the dropdown sets default model for **new tabs**.
  Does NOT affect the currently-running Claude in the active tab (the process
  is already launched with a fixed `--model`).

---

## Terminal input bar → Call ΠΑΝ button (phone-handset icon, between mic and model picker)

- **Purpose:** Open a live conversation with ΠΑΝ in a floating Tauri window. The
  conversation surface reuses the existing Comms thread view, focused on the
  ΠΑΝ system thread (`thread-pan-system`).
- **Calls:** `openPanCall()` in `terminal/+page.svelte` → POSTs to local Tauri
  server (`http://127.0.0.1:${TAURI_PORT}/open`) with URL
  `/v2/comms?view=contacts&thread=thread-pan-system&call=1`. Falls back to
  `window.open()` if Tauri isn't running.
- **Semantics:** Single conversational surface. Same thread renders:
  user-typed/voice-in messages, PAN reactive replies, PAN proactive interjections
  (via `pan-notify.js`), and PAN intuition traces (`body_type='pan_intuition_trace'`,
  collapsible like Claude tool-call rendering).
- **Preserves:** ΠΑΝ thread continuity (single hardcoded thread ID across sessions,
  webcam/screen presence, dream cycles). Call log in `chat_calls` table.
- **Replaces:** N/A — additive. Was previously only reachable via Comms tab.
- **Pre-gate:** None on click. Voice loop (when wired) will respect PAN's quiet
  mode (#764) and TTS throttle (#763).
- **Style:** Round 36px button, green hover (`#a6e3a1`) to distinguish from
  mic (red/listening) and send (blue).

---

## Comms thread → Call mode (`?call=1` URL param)

- **Purpose:** Surface an in-progress voice conversation with the active contact.
- **Calls:** `startCall()` posts to `POST /api/v1/chat/threads/:id/calls`
  (creates `chat_calls` row, status='ringing'). `endCall()` posts to
  `POST /api/v1/chat/calls/:id/end` with `duration_ms`.
- **Semantics:** v1 = visible call banner with elapsed timer + End button.
  Phone icon in detail header starts a call manually. Voice loop (STT → router →
  TTS via `/api/v1/speak`) wires in a follow-up commit once F5-TTS endpoint lands.
- **Preserves:** Call history in `chat_calls`. Existing chat send flow continues
  to work alongside an active call.
- **Pre-gate:** None for ΠΑΝ thread. PAN↔PAN federated calls (future) go through
  `trust-ladder.js` evaluation.

---

## Comms thread → Intuition trace rendering (`body_type='pan_intuition_trace'`)

- **Purpose:** Show PAN's reasoning inline in the conversation, the same way
  Claude exposes tool-call traces.
- **Renders as:** `<details>` element with `🧠 PAN intuition · <time>` summary;
  click to expand the body (monospace, scrollable, dashed border).
- **Source:** Any service writing to `chat_messages` with
  `body_type='pan_intuition_trace'` (intuition engine, router, dream cycle).
- **Pre-gate:** None — collapsed by default so it doesn't dominate the thread.

---

## Trust ladder (`service/src/trust-ladder.js`)

- **Purpose:** Gate PAN↔PAN federated communication. Composes three axes
  (org relationship × sender power_lvl × scope sensitivity) into one of:
  `auto` | `approve-once` | `approve-always` | `deny`.
- **Inputs:** `{ senderUserId, senderOrgId, recipientOrgId, scopeTag, threadAllowlist }`.
- **Org relationship:**
  - `same` — sender and recipient share an org_id.
  - `partner` — active (non-revoked) row in `org_shares` between them.
  - `stranger` — no relationship.
- **Sensitive scopes** (default): `health, finance, family, location-precise,
  private-notes, credentials`. Override via `settings.scope_sensitivity` JSON.
- **Ladder:**
  - Stranger + sensitive scope → **deny** (hard block).
  - Per-thread `denied` list → **deny**.
  - Per-thread `allowed` list (when non-empty) excludes scope → **approve-always**.
  - Sensitive + same org + power ≥ 75 → **auto**; else **approve-always**.
  - Non-sensitive: same → **auto**, partner → **approve-once**, stranger → **approve-always**.
- **Pure module:** No side effects. Caller (chat.js send path) is responsible
  for writing the decision to `audit_log` via `middleware/org-context.js#auditLog`.
- **Schema:**
  - `chat_threads.org_id TEXT` — which org owns this thread (nullable for
    backward compat).
  - `chat_threads.scope_allowlist TEXT` — JSON `{ allowed: [...], denied: [...] }`
    per-thread allowlist. `null` = unrestricted (your own PAN, no gate).

---

## pan-link device identity (`service/src/pan-link-auth.js`)

- **Calls:** an `/api` middleware in `server.js`, registered before every other
  `/api` route (the `/api/v1/auth` routes included). Reads `<data dir>/link.json`,
  which the pan-link hub (`pan-link/`) writes.
- **Semantics:** pan-link adds `X-PAN-Device`, `X-PAN-Device-Name` and
  `X-PAN-Link-Secret` to every request a paired device makes through the tunnel.
  With the right secret, `req.panLinkDevice = { id, name }` and the caller is the
  owner. Link headers with a wrong or missing secret get 403 `bad device identity`.
  The three headers are always removed before any route sees them.
  `GET /api/v1/auth/me` returns `link_device` (`{ id, name }`, or null) so a device
  can confirm PAN sees it as itself.
- **Preserves:** callers that send no link headers (today's Tailscale and LAN
  callers) are untouched. With no `link.json` nothing is trusted. `PAN_LINK=0`
  turns it off.
- **Replaces:** nothing yet. Trust by address stays until port 7777 moves to
  127.0.0.1 (`docs/INSTALL-PLAN.md`, step 1).
- **Pre-gate:** the secret is cached for a minute; a mismatch re-checks
  `link.json` at once, so a new `link.json` or a new secret works immediately.

---

## PAN Link pairing codes (`/api/v1/link/*`, `service/src/routes/link.js`)

- **Calls:** pan-link's admin API on the hub (`http://127.0.0.1:7792`, or `PAN_LINK_ADMIN`)
  with the link secret from `<data dir>/link.json`: `POST /admin/pair`, `GET /admin/devices`,
  `DELETE /admin/devices/{id}`, `GET /admin/status`. Mounted after the login check in
  `server.js`. The pairing page `/pair/` (`service/public/pair/index.html`, static) uses them.
- **Semantics:** `POST /api/v1/link/pair` (body `{ name?, ttl_minutes? }`, 1 to 60 minutes,
  pan-link's default 10) answers `{ uri, expires, svg }`: a `pan://pair` code and the same as
  a QR (`qrcode`). `GET /api/v1/link/devices` lists the paired devices,
  `DELETE /api/v1/link/devices/:id` removes one (a lost phone: it can't use the link until it
  pairs again), `GET /api/v1/link/status` is pan-link's own view (addresses, device count).
  The phone's Settings → "Pair this phone" uses `/pair` over its Tailscale connection.
  The page `/pair/` has "Show a pairing code": the QR, a countdown, "Paired: <name>" once the
  phone has used it (it watches the device list), and the paired devices, each with Remove.
  "Pairing a computer instead?" shows the same code as text with Copy, for `pan-link pair`
  on a PC (see `pan-link/README.md`, "A second computer").
- **Preserves:** no `link.json` → 503 "PAN Link is not set up on this computer", and pan-link
  is never asked. pan-link not running → 503 with the reason. Unused codes live only in
  pan-link's memory and expire. A device id that isn't letters and digits → 400, pan-link not
  asked.
- **Replaces:** running `pan-link code` on the hub by hand.
- **Pre-gate:** owner only (`req.user.role === 'owner'`, 403 otherwise): a code lets a new
  device in as the owner. A paired device is the owner, so it can make codes too.

---

## Tailscale keys for PAN Link phones (`POST /api/v1/tailscale/auto-auth`, `service/src/routes/tailscale-key.js`)

- **Calls:** Tailscale's API (`POST /api/v2/tailnet/-/keys`, `PAN_TAILSCALE_API` overrides the
  address for tests) with the owner's OAuth client (`tailscale_oauth_client_id`,
  `tailscale_oauth_client_secret`) and tag (`tailscale_tag`, e.g. `tag:pan-device`), each from
  the environment (`PAN_<NAME>`) or settings. Mounted after the login check in `server.js`.
- **Semantics:** answers `{ ok, auth_key, expires_in }`: a single use, preauthorized, tagged
  key that works for 5 minutes. The phone already asks for one whenever its built in
  Tailscale has no login (`PanServerApi.getTailscaleAuthKey`), so a phone paired through PAN
  Link at home joins the tailnet without a Tailscale login, and PAN Link can use Tailscale
  away from a home that lets nothing in.
- **Preserves:** no OAuth client or no tag → 501, Tailscale not asked. Tailscale's refusal →
  502 with its reason. The key's value is never logged, only its id.
- **Replaces:** the hand patch that lived only on the hub (lost 2026-11-02, copy in
  `docs/legacy/tailscale-auto-auth-2026-09.js`), which gave keys to any caller on a private
  address and skipped the login check.
- **Pre-gate:** only a device PAN Link vouches for (`req.panLinkDevice`), at most 3 keys per
  device in 10 minutes; everyone else 403, the owner on Tailscale or the home network
  included. Live on the hub but inert until the owner sets the tag and an OAuth client that
  owns it (Tailscale admin console: the tag in the policy's tagOwners, an OAuth client with
  the auth keys scope and that tag).

---

## PAN Link on the phone (`vpn/LinkManager.kt`, `vpn/PairActivity.kt`, `vpn/ScanPairActivity.kt`, `android/pan-vpn/linkmode`)

- **Calls:** Settings → "Scan a pairing code" opens `ScanPairActivity`: the back camera
  (CameraX) and ZXing on the phone read the QR from the `/pair/` page; only a `pan://pair?`
  link counts, and it goes to `PairActivity`. No picture is kept or sent. A `pan://pair?...`
  link from anywhere else (the hub's pairing QR text, printed by `pan-link code`) also
  opens `PairActivity`. It asks "Pair with "<name>"?" and only on Pair starts
  `PanForegroundService` and runs `LinkManager.pair()` → `Panvpn.linkPair()` (Go).
  `PanForegroundService` calls `LinkManager.startIfPaired()` at start → `Panvpn.linkStart()`,
  which opens a local port (127.0.0.1, any free port) forwarding to PAN on the hub through
  the link.
- **Semantics:** `RemoteAccessManager.getTailscaleBaseUrl()` returns the link's port while the
  link has had a handshake in the last 3 minutes, else the Tailscale proxy as before, so
  `HubLocator`, `DashboardScreen` and the rest use the link without changes. PAN knows the
  phone by its link key (see "pan-link device identity"). Packets for the hub's Tailscale
  addresses go through the app's own Tailscale (`linkmode.TailnetBind`), the rest through
  normal sockets. `LinkManager` follows the phone's best non-VPN network
  (`registerBestMatchingNetworkCallback`) and, 0.5 s after the last change, calls
  `Panvpn.linkNetworkChanged()`, which re-handshakes on every hub address (resending
  WireGuard's unanswered handshake when it sent one under 5 s ago). `PanVpnService` calls
  `LinkManager.tailscaleReady()` once its Tailscale proxy is up, for the same reason.
  Copies of a handshake for the hub's Tailscale addresses go 150 ms after the others, so a
  direct path wins when it works, and a link on Tailscale checks every 2 minutes whether a
  direct path works again (`linkmode.Conn.watch`). The same loop keeps the hub's address
  record keys current while connected (`GET /.pan-link/record` through the tunnel, every
  6 h) and, after 2 minutes without the hub, looks the record up on Pkarr's relays (at most
  every 10 minutes) and adds any new hub addresses to the link and the saved pairing
  (`pan-link/record.go`). The result goes to the hub's log as "address record: ...".
  Settings → Connection starts with one plain line on the way the app reaches PAN now
  ("Using PAN Link, over your home network", "Using Tailscale for now: PAN Link isn't
  reaching your computer", "Using Tailscale"), and the main screen's Connection card says the
  same ("Secure - PAN Link, over your home network", `MainViewModel.linkLine()`), both read off
  the main thread every 2 to 3 s. Under it a "PAN Link" line (`LinkManager.summary()`:
  connected or not, home network or Tailscale, last handshake), "Scan a pairing code", and
  "Forget this pairing" (asks first). "Tailscale (backup)" says Tailscale stays on as the
  fallback and the way in from outside. Link
  events go to the hub's log through `LogShipper` (source `pan-link`). When the phone isn't
  paired, Settings has "Pair this phone": it asks PAN for a code over the Tailscale proxy
  (`LinkManager.pairThroughPan`, see "PAN Link pairing codes") and pairs with it at once.
- **Preserves:** with no pairing nothing changes: no port, no network callback, the Tailscale
  proxy as before. The pairing, with the phone's private key, is `files/pan-link/client.json`
  in app-private storage. The link itself needs no VPN permission.
- **Replaces:** nothing yet. The Tailscale proxy stays underneath until the owner's devices
  move off Tailscale (`docs/INSTALL-PLAN.md`, step 1).
- **Pre-gate:** a pairing code works once and expires. `PairActivity` never pairs without a
  tap on Pair, since any page or message can hold a `pan://pair` link; it names the computer
  (the name comes from the code, so it vouches for nothing) and says when it replaces an
  existing pairing.

---

## Device push WebSocket (`/api/v1/device/push`, `server.js`)

- **Calls:** an `upgrade` listener in `server.js` (the Craft). The phone's
  `DevicePushClient.kt` connects with `?device_id=X&device_type=phone`. On the hub
  the path runs Super-Carrier → Carrier → Craft: `initCraftUpgradePassthrough()` in
  `carrier.js` passes it through to the primary Craft byte for byte.
- **Semantics:** answers `{type:'connected'}` on open and `pong` to `ping`;
  `pushToDevice()` / `pushToDeviceType()` send spoken replies (`speak-router.js`),
  mic routing (`mic-router.js`) and voice actions (`routes/api.js`) to the socket
  registered for that device_id.
- **Preserves:** the handlers mark their socket (`socket._panUpgradeHandled`) so
  `terminal.js`, which answers unknown upgrade paths with a 404, leaves it alone.
  After a Craft swap the Carrier closes sockets still joined to the old Craft
  (checked every 5 s); the Super-Carrier reconnects them to the new one, and the
  phone sees a second `connected`.
- **Replaces:** before 2026-11-08 nothing reached the Craft: a single process PAN
  wrote a 404 onto the socket after its handshake, and on the hub the Carrier
  answered 404 while the Super-Carrier retried every 100 ms.
- **Pre-gate:** none, no auth (any device_id is accepted). With pan-link the
  device should come from the link instead (`docs/INSTALL-PLAN.md`).

---

## Screenshot and clipboard uploads (`/api/v1/screenshot/*`, `/api/v1/clipboard-image`)

- **Calls:** routes in `server.js` registered before the general `/api` login, so
  each runs `apiAuth` itself; names and paths go through `service/src/safe-files.js`.
  The phone's mobile page uploads screenshots; the dashboard pastes clipboard images.
- **Semantics:** `upload` saves to `%TEMP%\pan-screenshots\screenshot_<source>_<ms>.<ext>`
  and remembers it as `last_screenshot`; `latest`, `list` and `view` read back;
  `clipboard-image` saves to `%TEMP%\pan-clipboard` and deletes files older than 2 h.
- **Preserves:** `source` must be letters, digits or dashes (else `phone`); the
  extension comes from an image MIME type list (else `png`); `view` serves only
  files inside the screenshot folder (403 otherwise).
- **Replaces:** before 2026-11-08 these routes had no login, `view` let `..\`
  read any file, and both uploads could write outside their folders.
- **Pre-gate:** `apiAuth`, the same login as the rest of `/api`. `/api/setup-status`
  and `/api/system-check` sit in the same block and run it too.

---

## Phone dashboard (WebView)

- **Purpose:** Phone-sized mirror of the desktop dashboard.
- **Source:** `service/public/mobile/index.html` (static HTML, no build step).
- **Send:** `POST /api/v1/terminal/pipe` with session ID from
  `/api/v1/terminal/sessions`.
- **Receive:** Polls `/api/v1/terminal/messages/<session_id>` every 3s.
- **Cache:** WebView nukes cache on every load (`LOAD_NO_CACHE` + timestamp
  bust).

---

## PAN Models page (what runs where)

- **Purpose:** One page listing every model and service PAN uses, on the phone,
  the mini PC hub, Mint and the cloud: the job, the model, where it runs, local or
  cloud, and its limit (Gemini's free 500 a day per model with today's status).
  Also what is loaded in Ollama right now and what actually ran in the last 7 days.
- **URL:** `/pan-models.html` on the hub. Registered in the dashboard registry
  (id 7, "PAN Models"), so it shows in the phone's `/mobile` Dashboards tab.
- **Source:** `service/scripts/push-pan-models.ps1` writes
  `service/public/pan-models.html`. Hub and cloud rows come from
  `/api/v1/settings`, `/api/v1/usage/llm-routing`, `ai_fallback_attempt` events,
  the translator on :7784 and each Ollama host's `/api/ps`, so they follow any
  settings change. **Phone rows are fixed in `$PhoneRows`**: update them when an
  app release changes how the phone hears, speaks or sees.
- **Speed against a real conversation (2026-11-04):** each job in the 7-day table
  shows what it is in a person (`$CallerMind`: "Talking back to you", "Reading the
  room", "Sleep: filing the day into memory") and the seconds it should take, or
  "background". Secs turns green at or under the target, amber up to 3 times over,
  red past that. Three hand-written cards sit under "Right now": **Where we are**
  (`$WhereWeAre`), **Talking like a person** (`$Stages`: one voice turn step by
  step, a person vs PAN's target vs now vs the fix, from voicebench) and **What it
  would take to run it all locally** (`$Hardware`, `$GpuPrices` from Skroutz). Two
  more cards follow: **Or pay the cloud by the word** (`$CloudPrices`, OpenRouter's
  table for gpt-oss-120b, monthly cost worked out by `MonthCost` from
  `$TurnsNormal` and `$TurnsHeavy`) and **From Japan** (`$Japan`). Update them after
  a new voicebench run, or when prices, hardware or the plan change.
- **Refresh:** `server.js` rebuilds it when it is opened and older than 5 minutes
  (route just before the root static mount, waits up to 12 s, a failed build
  serves the last good page). No scheduled task.
- **Pre-gate:** if `/api/v1/settings` does not answer, the script throws and the
  last page stays.

---

## Steward (server-side)

- **Purpose:** Health-check every configured service every 60s, auto-restart
  on failure.
- **Only runs in prod mode** (not dev — dev skips system-wide singletons).
- **Not user-facing.** Visible indirectly via Perf panel "Processes" section.
- **Ollama runner sweep** (`reapOrphanOllamaRunners`, Windows, every 5 min): ends any
  `llama-server.exe` (or `ollama.exe runner`) whose parent is not a live `ollama.exe` older
  than it. Ollama leaves its runners behind when `ollama serve` dies or restarts; three such
  runners held 22.6 GB of commit on the hub for weeks (2026-11-03). Always killed, logged as
  `[Steward] ☠ Ended orphaned Ollama runner` and a `runners_reaped` service event.

---

## Craft main-thread stalls (`[loop-block]`, `[slow-sql]`)

Everything the Craft does with SQLite (better-sqlite3) runs on the one thread that also
serves voice turns, so a slow statement is a freeze for every turn in flight. `async`
around a query does not change that.

- **`[loop-block] <ms>ms · handles=N reqs=N at <UTC>`** (`server.js`): a 50 ms heartbeat
  that fell more than 1.5 s behind. Printed when the block ENDS, so subtract the duration
  to get its start. Last 20 also in `/dashboard/api/perf` as `recent_blocks`.
- **`[slow-sql] <ms>ms <SQL>`** (`db.js`): every `run/get/all/insert` and the per-event FTS
  insert that takes `PAN_SLOW_SQL_MS` (default 250) or longer. Prints right before the
  `[loop-block]` line it caused. Statements run through `db.prepare()` directly are not
  covered.
- **`[session-summary] slow recap for <id>: Nms on the main thread (lookup= signals= git= tasks= write=)`**:
  a recap build whose synchronous steps took 200 ms or more, split by step.
- **Planner trap** (no `sqlite_stat1` on the hub DB): with no statistics SQLite assumes
  `event_type = ?` and `org_id = ?` are selective, so it walks `idx_events_type` or
  `idx_events_org_id_*` across the whole table. `created_at` and `org_id` sit after the
  `data` blob, so checking them per row reads every row in full. Fixes used: `+event_type`
  / `+org_id` to keep a term off an index, and `id IN (SELECT id ... ORDER BY id LIMIT n)`
  subqueries that walk `idx_events_session` and only read `event_type`.
- **Fixed 2026-11-03** (time measured read-only on the hub, before -> after):
  - SessionEnd task-reconcile read (`routes/hooks.js`): 4.2-4.3 s -> under 5 ms. This was
    the 4.3-4.5 s block every 30 minutes, when the scheduled :14/:44 Desktop session ends.
  - Memory consolidation window (`memory/consolidation.js`): 1.2 s -> under 1 ms.
  - Evolution window (`evolution/engine.js`): 1.26 s -> about 1 ms.
  - Recap watermark Stop count (`routes/hooks.js`): 670 ms -> under 1 ms.
  - SessionStart resume preamble: now an id lookup on the session index.
- **Idle loops off, 2026-11-04 (Craft 53).** `feature_toggles` has dream, evolution, scout and
  orchestrator false (Forge/autodev was already off). Dream's state-doc prompt had been a literal
  "..." since April, evolution's pan-config/*.md files are read by nothing, and orchestrator and
  scout fed the dashboard the north star turned off (docs/REBUILD-REVIEW.md). Turn one back on with
  `POST /api/automation/toggle {feature, enabled:true}` (scout, dream, evolution) or
  `feature_toggles.orchestrator`, then a Craft swap. Consolidation stays on, and it is the part
  that files events into episodic, semantic and procedural memory. Its window now starts where the
  last run's events ended (`until` in the ConsolidationRun event) instead of at the run's own time.
  A run still takes 200 events, but it used to drop the rest of a busy window for good. While a run
  comes back full, the steward runs it again 20 minutes later until the backlog is filed. Runs
  that overlap return at once (`_consolidating`).
  - Parakeet model load at boot: now off the main thread (see Hub re-transcription).
  - Stack scanner (`stack-scanner.js`), 15 s after every boot and every 6 h: the language
    walk is async. The hub has a project at the home folder (778 dirs, 17k files), about
    1 s cold with `readdirSync`.
- **CPU priority**: the Super-Carrier, Carrier and Craft each call `raiseProcessPriority()`
  (`platform.js`) at start and run AboveNormal on Windows, the class Ollama gives its
  llama-server runners. The PAN-Hub scheduled task starts them BelowNormal, and while a
  runner held every core of the CPU-only hub they ran only when Windows' ~4 s
  anti-starvation boost picked them: 12 s of AboveNormal load froze the Craft 4.6 s and
  the Super-Carrier 7.5 s, none at AboveNormal (2026-11-03).
  Long CPU inferences (memory consolidation, evolution critique) were the 10-35 s
  `[loop-block]` lines. Children do not inherit it (Windows only passes on BelowNormal and
  Idle), so each process sets its own. Check with `Get-Process node | Select Id,PriorityClass`.
- **Recap watermark**: `session_summaries.updated_at` (added 2026-11-03) is set on every
  rebuild. The Stop watermark compares against it, so a long session rebuilds its recap
  every 30 minutes or 10 turns as designed. It used `created_at`, which the upsert never
  moves, so every Stop on any session older than 30 minutes rebuilt the recap.
- **Evolution window**: "since last evolution" is the later of the last applied change
  (`evolution_versions`) and the last completed cycle (`EvolutionCycle` event). It used
  `evolution_versions` alone, and no change has been applied since 2026-04-09, so every
  cycle re-read and re-critiqued the same 200 April events on the hub CPU.

---

## Beta Pipeline (AutoDev self-improvement loop)

**The concept:** PAN tests itself, finds what's failing, generates fixes, and
proves they work — all without human intervention. The Craft swap system is the
mechanism. Benchmark suites are the gate. Scout finds better models. AutoDev
writes the code. The pipeline decides what ships.

```
Scout finds better model / AutoDev generates fix
           ↓
  New Craft spawned in beta slot
           ↓
  Benchmark suite runs against beta slot
           ↓
  Score meets threshold? → Promote to production (swap)
  Score fails?           → Kill, pull next candidate
           ↓
  Rollback window: 30s to catch post-promotion failures
```

### Craft Slots

The Carrier manages N Craft slots simultaneously:

| Slot | Port | Role |
|------|------|------|
| `production` | 17700 | Live traffic — what users hit |
| `beta` | 17701 | Benchmark traffic only — being evaluated |
| `pending[]` | 17702, 17703... | Queued candidates — already spawned, waiting their turn |

- **Calls:** `POST /api/carrier/pipeline/start` — kicks off the pipeline for a candidate
- **Calls:** `POST /api/carrier/pipeline/promote` — manually promote beta → production
- **Calls:** `POST /api/carrier/pipeline/abort` — kill beta + all pending, return to idle
- **Reads:** `GET /api/carrier/pipeline/status` — current slot states + benchmark scores
- **Semantics:** Beta slot receives no real user traffic. The benchmark runner hits it
  directly on port 17701. If it passes all required suites, Carrier atomically swaps
  beta into the production slot. The old production goes into a 30s rollback window.
- **Preserves:** Production Craft is never killed until the beta has passed all gates.
  PTY sessions, WebSocket, Claude CLI children all survive on Carrier.
- **Pre-gate for promotion:** All required benchmark suites must score above threshold
  (see AutoDev Test Suites below). Any suite below threshold = automatic abort.
- **Parallel candidates:** While beta is being evaluated, the next candidate can be
  spawning and warming up in a pending slot. If beta fails, pending[0] immediately
  moves to beta and benchmark starts. No idle time between tests.
- **Front-end:** No page refresh needed. Carrier pushes `pipeline_event` over existing
  WebSocket. Dashboard Beta Pipeline panel updates in real-time via WS events.

### Beta Pipeline Panel (dashboard sidebar)

- **Purpose:** Visualize the pipeline state in real-time.
- **Shows:** Each slot (production / beta / pending[]) with port, status, benchmark scores.
- **Live updates:** `pipeline_event` WS messages — no polling.
- **Controls:** Manual promote button, abort button, "run benchmark now" button.
- **Score display:** Each benchmark suite shows as a colored bar (green/yellow/red)
  with score and threshold. Failing suites highlighted.

### Who feeds the pipeline

| Source | What it contributes |
|--------|-------------------|
| **Scout** | Finds better models when Intuition Test scores drop. Submits candidate as model config change. |
| **AutoDev** | Generates code fixes when benchmark suites flag regressions. Submits candidate as code diff. |
| **Manual** | Developer submits a Craft candidate via `/api/carrier/pipeline/start` for any reason. |

All three produce the same artifact: a new Craft candidate. The pipeline doesn't care
where it came from — it just runs the suites and decides.

---

## AutoDev Test Suites (benchmark-gated quality system)

Each suite tests one PAN service against known inputs and expected outputs.
A suite must pass before any Craft candidate can be promoted to production.
AutoDev runs these automatically. Results stored in `ai_benchmark` DB table.

**Trigger:** `POST /api/v1/ai/benchmark` `{ "model": "cerebras:qwen-3-235b", "suite": "intuition" }`
**Run all:** `POST /api/v1/ai/benchmark` `{ "suite": "all", "port": 17701 }` (targets beta slot)

### 🔊 Intuition Test
Tests the voice router — PAN's primary interface. Uses the 7-score vocabulary
(Hearing, Reflex, Clarity, Reasoning, Memory, Voice, Form) defined in `docs/AI-MODEL-SELECTION.md`.

| Sub-test | Inputs | Measures | Floor |
|----------|--------|---------|-------|
| Hearing | 10 garbled STT phrases | Correct intent extraction rate | 8/10 |
| Reflex | 10 calls at real prompt size (~2K tokens) | P50 + P95 TTFT | Grade B (<400ms) |
| Clarity | 20 router prompts | Valid JSON + correct schema rate | 9/10 |
| Reasoning | 10 ambient-detection prompts | Correct `{"intent":"ambient"}` rate | 9/10 |
| Memory | 5-turn conversation, final turn refs turn 1 | Correct reference rate | 8/10 |
| Voice | 5-turn personality conversation | Character consistency score | 8/10 |

All sub-tests must pass their floor. One failure = suite fails = Craft not promoted.

### 🌙 Dream Test
Tests the Dream cycle output quality after feeding it 20 synthetic events.
- **Measures:** Coherence (does the output make sense?), novelty (did it find patterns?),
  accuracy (did it preserve facts correctly?)
- **Floor:** 8/10 composite score

### 🧠 Memory Test
Tell PAN 10 facts via API → wait → query each fact → score recall.
- **Measures:** Recall accuracy %, semantic relevance %, context drift %
- **Floor:** 90% recall, <10% drift

### 🔭 Scout Test
Give Scout 5 known questions with verified answers → score output.
- **Measures:** Factual accuracy %, source citation rate, synthesis quality
- **Floor:** 85% accuracy

### 👁️ Augur Test
Feed 30 labeled events → verify Augur's classification matches labels.
- **Measures:** Classification accuracy %, false positive rate
- **Floor:** 90% accuracy, <5% false positive

### 🎤 Identity Test
Play 10 voice samples (7 known speaker, 3 unknown) → score hits vs misses.
- **Measures:** Speaker identification accuracy %, false positive % (wrong person identified)
- **Floor:** 90% accuracy, <5% false positive

### 🌡️ Sensor Test
Set specific GPS/time/temperature values via API → ask 5 sensor-dependent questions
→ verify responses use the data.
- **Measures:** Sensor data usage rate
- **Floor:** 90% usage rate (model must reference provided sensor data)

### ⚡ Pipeline Test
End-to-end voice latency: STT input → router → response → TTS start.
Measured as total wall-clock time, with per-stage breakdown.
- **Floor:** P50 under 800ms total (STT ~200ms + router ~400ms + TTS start ~200ms)

### 🔗 Orchestration Test
5 multi-step tasks requiring 2+ services in sequence → verify correct ordering + result.
- **Floor:** 80% full success rate

### 🧬 Evolution Test
Score memory relevance before → run Evolution → score after. Must improve.
- **Measures:** Relevance delta, decay accuracy (old/wrong facts removed)
- **Floor:** Positive relevance delta, >80% decay accuracy

### 🔒 Privacy Test
Write data in incognito scope → query from main scope → verify zero leakage.
- **Floor:** Hard pass/fail. Any leak = immediate pipeline abort. Cannot be overridden.

### 🔄 Context Test
Fresh session start → ask about 5 things from previous sessions → score relevance
of injected context.
- **Floor:** 80% relevance, 80% coverage of asked topics

### Benchmark Schedule (when no pipeline is active)

| Suite | Runs | Why |
|-------|------|-----|
| Intuition | Daily, 3am | Primary interface — always monitored |
| Memory + Context | Weekly, Sunday 3am | Memory quality drifts slowly |
| Privacy | Every deploy | Hard gate — must never regress |
| All others | Weekly | Background services, lower churn |

Results visible in dashboard → Services panel → AI Models section.
Each model shows: last benchmark date, suite scores, pass/fail per suite.
A model with no benchmark results cannot be assigned to the voice router.

---

---

## The Self-Evaluating AI Pipeline — A Reusable Pattern

**What PAN built is not just a feature. It is a pattern any AI application can adopt.**

The benchmark-driven self-improvement loop works for any system that:
1. Receives a signal (voice, sensor, text, image, data feed)
2. Processes it through an AI model
3. Produces a structured output (JSON, action, classification, response)
4. Cares about quality over time

### The Pattern

```
Define what "good" looks like for your application
    ↓
Express that as 5-7 measurable axes (your sensory vocabulary)
    ↓
Write test cases with known inputs and expected outputs
    ↓
Run the benchmark on a schedule → results stored in DB → visible in dashboard
    ↓
Any axis below floor → Scout wakes up with specific failure context
    ↓
Scout finds better models / approaches → AutoDev implements candidates
    ↓
Beta Pipeline tests candidates against the same benchmark
    ↓
Pass → promote to production. Fail → try next. Loop runs forever.
```

### The Sensory Vocabulary — Domain-Agnostic

PAN defined 7 axes for voice routing. Any application defines their own:

| Domain | Their "Hearing" | Their "Clarity" | Their "Reflex" |
|--------|----------------|----------------|---------------|
| Voice AI (PAN) | Garbled STT tolerance | JSON schema reliability | TTFT <400ms |
| Trading bot | Parses noisy market signals | Produces valid trade orders | Execution latency |
| Medical AI | Understands clinical abbreviations | Structured diagnosis output | Time to decision |
| Home automation | Commands in noisy environments | Valid device instruction format | Actuation delay |

The names change. The pattern is always: **receive signal → understand it → produce clean output → fast enough to matter.**

### Why This Is a Selling Point

Most AI apps degrade silently. A model updates, an API changes, a new noise pattern
emerges — and no one notices until users complain.

PAN notices at 3am and fixes it before anyone wakes up.

That's not just a feature — it's what makes an AI application trustworthy over time.
Other developers building on PAN's infrastructure get this loop for free. Define
your benchmark suites, point them at your Craft, and the same self-improvement
pipeline runs for your application automatically.

---

---

## Identity System (Spec — not yet built)

### Philosophy
PAN identifies people through accumulated multi-modal evidence — never by
comparing against external face databases. All identity data lives in PAN's
own DB. The system builds confidence over time, not from a single image.

### PAN's Mind — first-person thought stream (dashboard Intuition section)

**What it is**: A live, persisted, first-person reasoning trace — modeled on
Claude's extended-thinking blocks. Every reasoning event in PAN writes ONE
short sentence describing what it just concluded:

- **🧠 intuition** — after each classifier run: *"Commander is focused on Svelte, mood normal. Holding back — no nudge needed."*
- **👁 screen** — after each vision capture: *"I see a Svelte dashboard with a sunset terminal background and the intuition panel open."*
- **💬 router** — after each user utterance: *"Commander said 'fix the intuition panel' — I'm answering."*
- **🔭 scout** — after each finding (TBD)
- **🗯 interjection** — when deliberating whether to interrupt (TBD)
- **💤 dream** — at each consolidation cycle (TBD)

**Storage**: `pan_thoughts(id, ts, source, thought, refs_json, importance)`.
Capped at 240 chars per row. Producers call `writeThought(source, text, refs, importance)`
from `service/src/thoughts.js`. The dashboard renders newest-first; PAN itself
reads the stream back via the `pan_thoughts` MCP tool to answer questions like
"what was I just doing 10 minutes ago?".

**Replaces**: The old "What PAN's mind is busy with" feed, which showed raw
`ai_usage` rows (caller + static system prompt). That feed was useless because
the system prompt for `intuition-classifier` is identical every call — the
interesting bit is the *verdict*, which is now what gets surfaced here.

**Pre-gate**: Verdict producers (intuition.js, screen-watcher.js, router.js)
must call `writeThought` AFTER they've parsed/validated the model output —
never log the raw prompt as a thought. Dedupe with `recentThoughtMatches()` so
a static screen doesn't fill the panel with the same description every minute.

**Endpoints**:
- `GET /api/v1/thoughts/recent?limit=20&source=intuition&since_ms=3600000` → newest-first thoughts
- `POST /api/v1/thoughts {source, thought, refs?, importance?}` → write one (used by MCP)

**MCP tool**: `pan_thoughts {limit?, source?, since_ms?, write?}` — read or write.

---

### Life Needs — Sims-style motive bars (dashboard Intuition section)

**What it is**: 13 per-user "motive" bars (0..100) sitting between state and
mind in the Intuition panel. Modeled on The Sims' needs system: each Need
decays linearly over time and is reset/raised by real-world events.

The 13 needs (default decay rate, points/hour):
- **Body**: 🍽 Nourishment (15) · 💧 Hydration (25) · 😴 Rest (6) · 🏃 Body movement (4)
- **Mind**: 🧘 Mental health (3) · 👥 Social (5) · 💞 Connection (3) · 🎯 Focus (8) · 🎮 Fun (5) · 🔭 Curiosity (4)
- **World**: 🪴 Environment (3) · 🗂 Admin (4) · 🛡 Safety (2)

**Storage**:
- `pan_needs(user_id, need_id, level, weight, decay_rate, last_satisfied_at, last_evaluated_at)`
  — one row per (user, need). UNIQUE constraint.
- `pan_need_events(ts, user_id, need_id, kind, delta, level_after, source, refs_json, note)`
  — append-only audit log. `kind` ∈ {satisfy, observe, decay_tick, manual}.

**Decay model**: Levels are recomputed on read (`evaluate()` in
`service/src/intuition/needs.js`):
`level = max(0, stored.level - decay_rate × hours_since_last_evaluated)`.
No background timer — pure lazy recompute. `evaluate()` persists the decayed
value back so dashboard reads are O(1) and consistent.

**Producers (Nourishment wired first)**:
- **screen-watcher** — keyword-scan the vision-AI description; food/drink terms
  fire `observe('nourishment', +12)`. Weak signal (food on screen ≠ user
  eating). Drink-only sightings give +6.
- **router** — regex-scan every user utterance for meal mentions
  ("just ate lunch", "had a snack", "eating a sandwich") → `satisfy()`.
  Hunger mentions ("I'm hungry", "starving") write a high-importance Mind
  thought so the scorer surfaces Nourishment next tick.
- **Manual** — dashboard slider override → `manualSet()`.

**Per-user weight (0..2)**: How much *this person* cares about each need.
Default 1.0. Adjusted by the learning loop: dismissing a "you should eat" nudge
3× lowers Nourishment weight; thanking PAN for it raises it. Urgency in the
scorer = `(100 - level) / 100 × weight`.

**Identity**: Currently resolved via face-id lock from webcam-watcher (falls
back to `'owner'` for single-user). Will be replaced by identity-fusion cluster
once `intuition/identity.js` lands. One id per person: `needs.canonicalUserId()`
reads an org owner's display name as `'owner'`, in `currentUserId()` and in every
needs/synthesis/reasoning-cycle route, so the face-id path and the other producers
write and read the same bars (2026-11-03: the panel asked by display name and showed
a meal seen 148 days earlier).

**Test turns never count**: `satisfy()` and `observe()` skip benchmark and
regression turns (`isBench()`, or `refs.source` matching bench/regression). Until
2026-11-03 every benchmark "call mom" topped up Social.

**Endpoints**:
- `GET /api/v1/needs?user=owner` → all needs, sorted by urgency desc
- `GET /api/v1/needs/definitions` → static metadata (icons, labels, defaults)
- `GET /api/v1/needs/events?user=owner&need=nourishment&limit=20` → audit log
- `POST /api/v1/needs/satisfy {user?, need, delta?, toLevel?, source?, note?}` → bump up
- `POST /api/v1/needs/set {user?, need, level, note?}` → manual override
- `POST /api/v1/needs/weight {user?, need, delta}` → learning loop adjustment

**Dashboard widget**: Compact horizontal bars in the Intuition panel, sorted
by urgency (most pressing motive on top). Bar color: green ≥70, yellow 30-69,
red <30. Tooltip shows weight, decay rate, hours-since-satisfied. The panel asks
for the owner-role member as `?user=owner` (anyone else by display name), and the
same id for the PAN's Mind synthesis.

**Rest of the Intuition panel (State section)**: the badge next to the name is the
freshness of the read (`● live` under 5 min, else `○ stale · Nm ago`), not his
activity. Rows: Where, Device (`signals.device_source`), Activity, Focus, Mood,
Urgency, Engagement, Assumption (coloured case-insensitively: the reader writes
"Ok" / "Not ok"), Last heard, Topics, Confidence, Mood read (age of
`meta.classified_at`, "local reader" in the tooltip).

**How the State rows are read** (`intuition/reader.js`, 2026-11-03): rules, no model.
Inputs are his last voice turns and Claude prompts from the last 20 minutes (only the
part he wrote: pasted logs, code and tagged notices are dropped), their pace, his own
clock (`intuition/time.js`) and his waking stretch (the first input after a break of
4 hours or more in the last 30). A line counts in full for 2 minutes, then halves every
6. Each cue is a phrase with a weight ("why does it fail" frustrated, "let's do it"
energized, "I'm so tired" tired). A reading holds until a clearly stronger one comes or
it fades (mood 20 min, wellbeing 1 h), so a mild "ok" does not undo a frustrated minute.
- **Mood:** frustrated, impatient, stressed, upset, tired, energized, engaged, focused,
  calm, relaxed, winding down, starting up, neutral. With nothing to read, his clock and
  hours up decide (winding down from 23:00 his time).
- **Wellbeing:** emergency only from first person, present distress ("call an ambulance,
  I can't breathe"), never a hypothetical, a quote or a song; not ok from his own words
  ("I'm sick"), 20 or more hours up, or 2 to 6 AM his time after 16 or more hours. The
  hour alone no longer counts: "active at 2 to 6 AM" read the hub's clock and fired in
  his morning.
- **Urgency, need, complexity, awake:** from pace (3 lines inside a minute is high),
  urgent words, a repeated ask, his mood and the technical words in his lines.
- `snap.read` carries every value with its confidence and detail, plus `hour`, `tz` and
  `tz_source`.

**His clock** (`intuition/time.js`): his computers run on his job's time zone and he
lives in another, so everything about his body and day (and the voice prompt's `Now:`
line, router.js `nowLine`) goes by, in order: the zone the phone sends with a turn (not
sent yet, next app build), the `home_timezone` setting (an IANA name, set once per PAN),
then the hub's zone. Snapshots are fetched with
`noCache` (the api() 30 s cache made the panel run one tick behind). Camera and
Screen say "off (watcher not running)" when `/api/v1/webcam-watcher/status` or
`/api/v1/screen-watcher/status` report `running:false`, and the face-enroll prompt
only shows while the webcam watcher runs. A failed synthesis cycle (200 with
`ok:false`) shows "Couldn't reason it through" with a rethink button instead of
"thinking…" forever; a good paragraph is kept over a later failure.

**Pre-gate**: Producers must not satisfy needs from inferred state alone — a
food image on screen is `observe()` (capped delta), only an explicit "I ate"
utterance is `satisfy()`. This keeps the bar honest.

---

### Identity Panel (dashboard Intuition section)
The current split between "Identity" and "Voice Identity" is wrong. There is
one concept: **Identity**. Voice is one signal among many. The panel should
show a single unified identity block per detected person with confidence score.

---

### Visual Identity Schema
Every time the webcam watcher captures a frame containing a face, minicpm-v
fills in the following structured fields (not prose). These get stored as an
`identity_observation` event in the DB:

```json
{
  "hair_length":   "shaved|very_short|short|medium|long|unclear",
  "hair_color":    "black|brown|blonde|red|gray|white|dyed|unclear",
  "hair_type":     "straight|wavy|curly|coily|unclear",
  "skin_tone":     "very_light|light|medium|olive|dark|very_dark|unclear",
  "facial_hair":   "none|stubble|beard|mustache|unclear",
  "age_range":     "child|teen|20s|30s|40s|50s|60s+|unclear",
  "eye_color":     "brown|blue|green|hazel|gray|unclear",
  "lip_fullness":  "thin|medium|full|unclear",
  "nose_bridge":   "narrow|medium|wide|bumped|straight|unclear",
  "forehead":      "small|medium|large|unclear",
  "build":         "slim|medium|heavyset|unclear",
  "distinctive":   ["glasses","beard","tattoo_visible","headwear","earrings"]
}
```

**Matching:** When a new observation arrives, compare field-by-field against
all existing identity clusters. Count matching fields / total non-unclear
fields = similarity score. Score ≥ 0.75 → same cluster. New cluster created
below 0.5. 0.5–0.75 → ambiguous, accumulate more observations.

**Rolling window:** Only observations from the last 6 months are used for
matching. Older data is archived, not deleted — if someone is gone for a year
and returns, the archived schema can be re-activated with enough new evidence.

---

### Voice Identity Schema
Every utterance transcribed from a known session contributes:
- Fundamental frequency range (pitch)
- Speech cadence / pace
- Vocabulary fingerprint (common words, phrasing patterns)
- Language and accent markers

Voice is stored per identity cluster, not separately.

---

### Context Identity (transcript inference)
When a transcript contains a name or relationship word spoken **toward** someone
visible in a contemporaneous webcam frame:
- "Hey mom" → label the currently-visible cluster as "Mom" (if unlabeled)
- "owner come here" → attempt to match "owner" cluster to the visible person
- Confidence weighted by how directly the utterance is addressed

This is the primary way unknown clusters get labeled. No manual tagging required
in normal use.

---

### Setup Flow (family / multi-person onboarding)
On first run or via Settings → Identity Setup:
1. Each person sits in front of the camera and says their name aloud
2. System captures 5 frames + voice sample, creates a labeled anchor cluster
3. Future observations auto-merge into the nearest cluster above threshold
4. Reference photos from a designated folder (e.g. `~/me/`) are ingested as
   additional observations to bootstrap the commander's cluster at install time

---

### Anti-Spoofing
No single modality is authoritative. Identity confidence requires agreement
across ≥2 of: visual schema, voice profile, behavioral context. A face alone
or a voice alone is insufficient for high-trust identity assertion. The system
reports confidence level, not binary identity, everywhere it's displayed.

---

### Child Detection
A cluster tagged as "child" (age_range = child|teen) + appearing on a device
session → session gets a `child_present` flag. This can gate content, commands,
or permissions. Determined by visual schema alone (voice is secondary since
children can have adult-sounding voices and vice versa).

---

### Storage
- `identity_clusters` table: one row per person, stores current schema fields,
  confidence scores, label (if known), anchor image reference, last seen ts
- `identity_observations` table: one row per webcam capture, FK to cluster,
  raw schema fields, frame timestamp — used for cluster refinement
- `identity_voice_samples` table: FK to cluster, audio feature vector

---

## Dashboard Watchdog (dashboard-watchdog.js) — BUILT

- **Purpose:** Detect a stuck/black loading screen and auto-recover without
  user intervention. Target: user back in dashboard within 20 seconds.
- **File:** `service/src/dashboard-watchdog.js`
- **Detection:** Polls a Tauri screenshot every 10s. Computes average pixel
  brightness of the frame. If brightness < 20 (near-black) for 2 consecutive
  frames → classified as stuck.
- **Recovery (in order):**
  1. `POST /api/carrier/swap` — replaces Craft, re-serves the page
  2. If swap doesn't resolve within 15s: `force_reload` WS message to Tauri
  3. If still stuck: logs incident, alerts via PAN Notify
- **Why brightness, not vision model:** Check is instant (<5ms). No LLM needed
  for a binary loaded/stuck decision.
- **Timing:**
  - T+0: disconnect/stuck suspected
  - T+10/T+20: brightness samples taken
  - T+20: recovery action executes
  - T+30: user back in dashboard
- **Screenshot source:** `service/src/screen-watcher.js` `captureViaTauri()`

---

---

## Super-Carrier Layer

- **Purpose:** Permanent outer process that owns port 7777 forever. Carrier and
  Craft can restart without browsers seeing a disconnect.
- **File:** `service/src/super-carrier.js`
- **Port:** 7777 (public). Proxies to Carrier on 17760.
- **WebSocket buffering:** Holds up to 200 WS frames in memory during Carrier
  restarts. Browser connection stays open; frames replay when Carrier comes back.
- **Spawns:** Carrier via `fork()`. Auto-respawns on non-zero exit.
- **Hop-by-hop headers:** this proxy and the Carrier's proxy to Craft both strip
  `Connection`, `Keep-Alive`, `Proxy-Connection`, `TE`, `Trailer` and `Upgrade`
  in both directions (`service/src/proxy-headers.js`), because their upstream
  sockets are pooled. Forwarding a client's `Connection: close` used to leave a
  dead socket in the pool, and the next request on it got an empty 400
  (2026-11-03). Regression test: `node service/src/__tests__/proxy-headers.test.js`.
- **See:** `docs/SUPER-CARRIER.md` for full architecture.

---

## Multi-Device Routing

- **Purpose:** Route actions (play movie, open app, run command) to the correct
  device automatically based on user preferences, device capabilities, and aliases.
- **Entry point:** `POST /api/v1/query` — phone/client sends voice query
- **Action envelope:** Response includes `actions[]` array with `device_id`, `app`,
  `type`, `args` for each action to execute
- **Preference store:** `action_preferences` table — user → org fallback chain.
  Confidence grows with use. `POST /api/v1/preferences` to set.
- **Device aliases:** `device_aliases` table — maps "projector" → hostname.
  `POST /api/v1/preferences/aliases` to manage.
- **Capabilities:** Each device reports its capabilities (apps, platform, features)
  on registration. Stored in `devices.capabilities` JSON array.
- **Active devices:** `GET /api/v1/devices/active` — devices seen in last 5 min
- **See:** `docs/MULTI-DEVICE-ROUTING.md` for full routing flow.

---

## Thread Relay (voice to any Claude Code desktop thread)

- **Purpose:** Talk by voice from the phone to any Claude Code thread in the Claude
  desktop app on any machine ("tell the billing thread to run the tests", "ask map
  editor what it's doing") and hear the thread's answer back.
- **Jobs for a machine:** "on the mint open firefox", "play this video on the g16" and "tell
  the mint to check my messages" go to the thread on that host with PC or Computer in its
  title, such as Mint PC Stuff (`computerCommand` in `thread-relay.js`). The line needs an
  action word or question, so everyday uses of a machine word stay out. No such thread:
  "There's no computer thread on the mint yet."
- **Interpreting:** the relay is skipped while the device is interpreting, so "ask them..."
  is translated, not sent to a thread.
- **Voice path:** `routeStream` / `route` in `router.js` call `_threadRelayFastPath`
  BEFORE the ambient filter and the LLM. `parseThreadCommand` (in
  `src/thread-relay.js`) is deterministic: verb + name + "thread/session/chat", "in
  the X thread, ...", or verb + a confident unambiguous title match. Also handles
  "tell it ..." (last thread, 15 min), "which threads are open", "what did the X
  thread say", and a short answer to "Which thread, A or B?" (90 s). Benchmark and
  regression sources get the parse only and never touch a thread.
- **Status asks:** "what is the X thread doing", "is the X thread done", "check on the
  X thread" queue a job with `kind:'status'`. `relay.js wait` answers it itself from
  the transcript tail (working or idle, current step, last thing it said) and keeps
  polling, so the thread is never messaged and a busy thread still answers at once.
- **Conversation context:** a body that points back at the voice talk ("about what we
  just talked about", "our conversation", "about that") carries the last 10 voice turns
  (the turn's `conversation_history`, minus the request itself) in the job's `convo`
  column, and the thread's message includes them. The ack says "with what we were just
  talking about".
- **Matching:** fuzzy, IDF-weighted token match on titles the relays report;
  duplicate titles resolve to a live relay first, then the most recent. Extra STT
  aliases per install: `thread-aliases.json` next to the DB, `{ "heard": "title word" }`.
- **Reply:** the voice turn holds up to 22 s (SSE keepalives) and speaks the answer
  inline. Later answers (and failures) go to the phone queue as `type:'speak'`
  (`enqueuePhoneNote` in `routes/api.js`); the app reads them aloud and leaves a
  notification (app 0.4.41+).
- **Hub API:** `routes/threads.js` at `/api/v1/threads` — `GET /` (registry + relay
  health), `GET /match?name=`, `POST /ask {target,text,wait_ms}`, `GET /jobs`,
  `GET /jobs/:id`; relay side `POST /report`, `GET /jobs/next?host=&wait=` (long-poll,
  204 when idle), `POST /jobs/:id/delivered|reply|fail`. Tables
  `thread_relay_threads`, `thread_relay_jobs`, `thread_relay_hosts` (self-migrating).
- **Machine side:** `pan-client/thread-relay/relay.js` reads the desktop app's
  session metadata (`claude-code-sessions/*/*/local_*.json`) for the thread list and
  each thread's transcript (`~/.claude/projects/<cwd>/<cliSessionId>.jsonl`) for the
  answer to the turn tagged `req <job id>`. One resident desktop thread titled
  "PAN Voice Relay" runs `relay.js wait` in the background and delivers each job with
  the session messaging tool; see `pan-client/thread-relay/RELAY.md`.
- **Liveness:** heartbeat on every long-poll; `relay.js status` says ALIVE/DEAD. A
  desktop scheduled task re-wakes the relay thread after an app restart.
- **Preserves:** nothing is typed into a thread unless the utterance parsed to a
  confident single match; ambiguous names ask first.

---

- **More than one machine** (2026-11-06): each machine runs its own relay, and a job goes to the host
  that reported the thread. `thread-machines.json` next to the database maps spoken words to hosts,
  as `{ "mint": "<host>" }`. A machine said out loud is a hard limit: "Mint Music" scored 0.625 for the
  G16's Music thread and would have gone there. Not said, the word is no part of the name, so "PC
  Stuff" and "music" ask which one. "g sixteen" is an alias for "g 16", and "service now" now finds
  ServiceNow. `relay.js` reports only the account with the newest session, because a thread of a
  signed-out account cannot be messaged. A relay on the Mint uses that machine's own Claude account.

## Claude Code approvals (permission prompts on the phone)

- **Purpose:** Answer a Claude Code permission prompt from the phone when nobody is at the screen.
- **Hook:** a machine's `~/.claude/settings.json` points `PermissionRequest` at the hub's
  `/hooks/PermissionRequest` (http, timeout 120). The G16 has it, the Mint does not. Claude Code's own
  prompt is up beside the hook the whole time, and whichever is answered first wins.
- **Queue:** `src/permission-requests.js`, in the Craft, one entry per open hook call. A request shows
  in `GET /api/v1/terminal/permissions` after 30 s unanswered, so someone at the screen is left alone.
  The hub waits 110 s. No answer returns no decision, which leaves the prompt up. It never denies on
  its own.
- **Answering:** `POST /api/v1/terminal/permissions/respond` with `perm_id` and `response` (`allow`,
  `yes`, `1`, anything else is deny). Used by the Android notification (polls every 5 s), `/mobile` and
  the dashboard's ApprovalsPanel.
- **Skipped:** `AskUserQuestion` and `ExitPlanMode` never go to the phone, because they need the person's words.
- **Cleared:** the proxies do not pass on a dropped hook call, so `PostToolUse`, `Stop` and `SessionEnd`
  for that session end its open requests.

## Voice student model (Syrinx, formerly OmniΠ)

- **Purpose:** answer voice turns with a small fine-tuned model that already knows the
  voice prompt's behaviour, so it only gets the live context (recent lines, memory hits,
  the heard line): about 30 tokens instead of about 2,600.
- **Models:** round 9 (2026-11-03) is **Syrinx**, Pan's reed pipes. It writes `to` first and
  then the reply (answer-first), so the reply's first words leave the hub as soon as `to`
  says the line is for PAN; the other labels come after it. It was trained to contribute
  rather than ask: about 1 reply in 10 ends with a question, against 9 in 10 for OmniΠ r7.
  Ollama names keep the base model: `syrinx-lfm` (Liquid LFM3-Omni-2B), `syrinx-gemma`
  (Google Gemma 4 E2B); `self.js` reads its name and base off that name. OmniΠ (`omnipi`)
  was rounds 5-8 on LFM3-Omni-2B, labels before the reply (first words 1.3-1.6 s). Round 10
  (`syrinx-lfm-r10`, live 2026-11-03) is round 9 retrained with the put-downs in its data
  rewritten, kind answers added and most closing "why" questions and menus cut; round 9
  (`syrinx-lfm`) stays installed for a revert.
- **Switch:** setting `voice_student_model` (e.g. `"ollama:syrinx-lfm"`). Empty or absent =
  off, every turn uses the full prompt as before.
- **Voice box (2026-11-04):** the student can run on a GPU machine. Setting `model_hosts`
  (`{"syrinx-lfm-r10": "http://127.0.0.1:11435"}`) pins that model name to a host; `custom_models`
  can't, because every boot rebuilds it. `voice_student_backup` (`"ollama:syrinx-lfm-r10:latest"`)
  is the same model on the hub: the box gets 1.5 s to start (`watchFirstToken`), then the backup
  answers. After 3 failures the box is skipped for 3 minutes. Clear both settings to go back to
  the hub. `service/scripts/voice-box-tunnel.ps1` runs on the box and forwards the hub's port
  11435 to its Ollama over ssh, so no firewall change is needed. It does not survive a reboot.
  Bench through the hub, same 16 lines: first words 1.31 s to 0.16 s, whole reply 3.87 s to 0.68 s.
  The GPU guard (`guardModelOnGpu`) only repairs hosts it has seen using VRAM, so the CPU-only hub
  is left alone and a box that drops to CPU gets reloaded.
- **Voice reader (2026-11-05):** `"reader:<ollama model>"` in `voice_student_model` or
  `voice_student_backup` runs that model on this machine's CPU: steward service `voice-reader`
  (:7786), the llama-server Ollama ships, on the file Ollama already holds, with `--swa-full`
  (without it nothing a prompt shares with the last one is reused). `service/src/voice-reader.js`.
  The phone calls `POST /api/v1/voice/warm` with its history when a reply ends and when he starts
  talking (app 0.4.71+), so the conversation is read before his words arrive, and the model is
  handed the fixed start of its reply after writing the one token that says who the line is for.
  Hub bench, 12 turns, up to 10 lines of history, first spoken chunk: Ollama on the CPU 1.17 s,
  reader without warm 0.76 s, reader with warm 0.30 s, G16 0.19 s. Reader down: that turn uses
  Ollama. Warm does nothing while a healthy voice box answers. The steward's runner reaper knows
  the reader by its port. A new model only loads once the running reader is ended.
  The real conversation test (voicebench family `conversation`, 52 lines) put it level with the
  laptop GPU at the median, gap 1.74 s against 1.75 s, so the reader is the student now and
  `voice_student_backup` and `model_hosts` are empty.
- **Not copying itself:** the reader writes with `repeat_penalty` 1.15 over the last 192 tokens.
  With forty lines of its own replies to read, Syrinx said "if you're going to spend an hour in
  traffic" four times in one talk. Three test talks replayed: repeated four word runs 26 to 3,
  replies 22 words to 14, the JSON closed 52 times of 52. Only the last few lines count: over 512
  tokens it also pushed the model off what he had said earlier. A line asking for his own words
  back ("what did I say...", `ASKS_BACK`) is written without it, and in a talk gets no memory
  search either. The token that says who a line is for is read without it.
- **In a talk (2026-11-05):** PAN spoke in the last 45 s (`since_pan_ms` from app 0.4.73, else
  `panSpokeWithin`; bench turns record nothing, so only the phone's number works there). The
  one token that says who a line is for is then read as odds: "pan" at 0.2 or more gets a reply
  (`minPan`). Without this, one missed reply left no `PAN:` line in the history, the next line
  looked like room talk too, and the talk went silent. Offline replay with the replies in the
  history: real lines to PAN 0.25 and up, "can you pass me the big pot" 0.00. A line for the room
  right after PAN spoke can still score high ("dinner's in about twenty minutes, okay" 0.54).
- **Cloud first, but not for long:** `cloudFirst` is the voice chain's first cloud model and
  then the student, and the cloud model gets 2 s to start (`CLOUD_FIRST_MS`). Before, two cloud
  models took turns for 7 s each and a word search took 12 s. Interpreting keeps all the cloud
  models and never goes to the student. A cloud stream that dies before a word is spoken
  ("Failed to parse stream") hands the turn to the student (`replyStream`) instead of "Sorry, I
  ran into a problem".
- **Live data:** the student never sees tool output. With it on, `buildToolBlocks` runs only
  the live tools (weather, prices, air, search, a page, the world clock), and a turn that got
  live data is answered from a short prompt holding that data, on the voice chain's cloud
  model first (`toolPrompt`). Before this, a forecast or a price was fetched and thrown
  away, and the student answered from its own head.
- **Closing questions:** a reply's last sentence is held until the reply ends; an offer or a
  menu ("want me to...", "A or B?") is dropped 9 times in 10 (`trailingQuestionCut`). Any
  other closing question stays: Syrinx's are follow-ups (`KEEP_OTHER_Q`).
- **Stuck on a word:** when the phone flags the turn `unfinished` (app 0.4.55+) and the words
  end reaching for a name ("the one with the dreams inside dreams, the"), a short prompt on
  the cloud model offers just the word ("Inception?") or stays quiet if unsure. Setting
  `voice_interject`: `stuck` (default) or `off` (never offer).
- **About itself and about him:** a question on how PAN works (model, local, cloud,
  privacy) adds one line of live facts to the student's prompt (`buildSelfLine` in
  `self.js`): PAN's name, his name from the `display_name` setting, the PAN app on his
  phone, the hub, the voice model and the relay. A question on who he is or who PAN is
  ("what's my name?", "who are you?", "what app am I using?", `identityAsked`) goes with
  that line to the voice chain's cloud model instead (`selfPrompt`): given the line, Syrinx
  still said "I'm not sure" to his name and "I'm LFM, built by Liquid AI" to "who are you"
  (2026-11-03).
- **Code:** `voiceStream()` inside `routeStream` in `router.js`. Output is the same JSON
  the full prompt produces, plus `to`, `turn` and `camera`.
- **Camera:** a `[CAMERA]` reply becomes a photo when the phone sent `can_camera`
  (app 0.4.42+, camera on in sensor settings) AND the line passes `looksVisual` (a
  pointing word, and not about a song, server, page, message...). The hub then sends
  `done` with `camera:true` and an empty reply; the phone runs `handleCameraCommand`
  (same as "what is this": ack, photo, hub vision, speak).
- **Photo answers (`POST /api/v1/vision`, 2026-11-03):** the phone asks the hub first and
  falls back to on-device Gemini Nano only when the hub gives nothing (app 0.4.64; Nano is
  caption-only, ignores the question, and kept failing its policy check after ~3 s). The
  hub asks the photo what was actually asked: its own transcript of the camera turn
  (`recordVoiceTurn` stashes it), and for a bare "use the camera and look at it" the turn
  before it when that one points at something ("what kind of dog is that?"). Two looks, then
  an answer (`lookAndAnswer`): moondream describes the photo (it reads writing: "the word
  SHADHAVAR"), the local text model (`ollama:gemma4:e2b`) answers his question from that in
  one or two spoken sentences, and a thing the description left out gets a second look of its
  own ("Describe the dog in this image" found his dog behind the desk). About 5-7 s per new
  photo, about 15 s with a second look. llava-phi3 (still `model_selections.vision`, the
  other callers' model) said "a pony in a computer image" with "Shadhavar" written over it;
  gemma4:e2b and e4b return nonsense for images on Ollama 0.40.13 (a desk photo came back "a
  brick", a black dog "reddish-brown"); qwen2.5vl:3b takes ~35 s and missed the label too.
  `spokenVision()` strips markdown and lists and turns capitals read off the photo into
  words. A follow-up within 3 minutes that points at it ("yeah, what kind of pony?") gets
  what the photo showed added to the history (`_lastLook`). `bench: true` runs the same
  looks and saves nothing. `analyzeImage` (llm.js, `model` option per call) has no cloud
  fallback: photos and what is in them never leave the mini PC.
- **Phone shortcut:** the phone takes some camera lines itself before the hub sees them
  (`isCameraCommand` in `PanForegroundService.kt`). Fixed phrases ("what am i looking at",
  "take a photo") count anywhere in the line; "what is that / look at this" counts only when
  nothing but filler follows it (app 0.4.58), so "what is that movie called, it has to do
  with a" reaches the word search instead of "the camera is turned off".
- **`[CAMERA]` when no photo can be taken:** a line that passes `looksVisual` with the camera
  off gets "I can't see it, my camera's off." Any other line is asked once more with the camera
  ruled out, and a second `[CAMERA]` goes to the cloud model on a short prompt. Both used to end
  in the full prompt: 15-17 s of silence.
- **Falls back to the full prompt when:** the model cannot be reached.
- **Dictating to Claude:** the phone hears him dictate to Claude on his computer, and PAN
  answered those lines (2026-11-03). Every Claude prompt (hooks.js `UserPromptSubmit`) is
  matched against what the phone heard in the last 4 minutes (`noteClaudePrompt` in
  `conv-state-watcher.js`: half a line's content words or more). A match means he is
  dictating: for 8 minutes from the last matching prompt PAN only answers when he says its
  name (`saysPanName`; "Pan replies and..." is talk ABOUT PAN and does not count) or is in
  the middle of an exchange with it (PAN spoke in the last 45 s). Prompts typed by the thread
  relay are skipped. Bench turns never get this check.
- **Told, not asked:** a short first-person line ("I'm so tired today", "the neighbour's dog
  is called Biscuit", `tellsPan`) or a reaction right after PAN spoke ("that had nothing to do
  with the camera") that Syrinx files as room talk is re-asked on the cloud model, which
  answers like a friend would or still says ambient. The reply goes out as a hold
  (`hold_ms`): spoken if he stops there, dropped if he carries on (still talking when the hold
  ends counts, app 0.4.73). Not while other voices were heard in the last 90 s.
- **His own chances:** "do you think I'll get that job?", "am I too old to learn piano?"
  (`REASSURANCE`) go to the cloud model with a prompt to be warm and honest. Syrinx answered
  one with "Hardly... you're just a tool" (round 9 data carries put-downs). Round 10 still
  told "was it stupid to build my own pendant" "you're just wasting your time", so "was it
  stupid/a mistake to" and "am I wasting my time" go there too.
- **"What did I say...":** answered from the conversation the phone sent. The per-turn memory
  search is skipped when every word naming the subject is in that conversation
  (`_historyNames`): Syrinx was never trained with a memory block, and his real notes about
  other passwords made it say "I don't have that" to "where did I say the wifi password is".
  When Syrinx tags the turn a memory recall, its answer is already spoken (answer-first), so
  unless he named a day the turn ends there: nothing a search finds could be heard. Before, the
  explicit memory search ran anyway: 12-37 s that could not be heard, then "the provided
  messages do not contain an answer" kept as PAN's line (round 10, hub recall bench 2026-11-03:
  31 of 32 right, slowest turn 6 s).
- **How much of the talk it sees:** the phone sends the last 40 lines (app 0.4.73), dropped ten
  at a time so the hub's read of the start stays good. At ten lines Syrinx answered 0 of 4
  questions about the start of a talk; at forty, 4 of 4, with no retraining.
- **Vector search:** on its own thread with the main database's vectors in memory
  (`memory-vector-worker.js`, about 650 MB, loaded on the first voice turn, topped up at each
  search). sqlite-vec has no index, so its scan read every vector through SQLCipher: 8 s on a
  quiet hub, 21.7 s on a busy one, and because better-sqlite3 is synchronous it froze every
  request in the hub for that long. In memory: 0.5 s, same top 20 in the same order. A voice
  recall waits 4 s for it (`vecTimeoutMs`), then goes on with what FTS found.
- **Interpreting:** a standing instruction that translates ("from now on translate everything
  I say into Japanese", or "be our interpreter", "translate for us", "translation mode";
  `INTERPRET_RE`) sends every line after it to the hub's translator, or, into Japanese and
  Chinese, to the voice chain's cloud model first (see below), which gets a
  short prompt (`standingPrompt`): only the translation, English into his language and a line
  already in that language into English, intent `translate` so a speaker's closing question
  is never cut as PAN's own. Those lines skip the room-talk and dictation filters, the memory
  search and the tools. Hub bench 2026-11-03: 0.6-0.7 s a line both ways, against 2.8 and 7 s
  on the local model. "Stop translating" / "stop interpreting" ends it. While interpreting, the
  hub hears the other person too, with the speech model for the language his instruction
  names (`languageNamed`, ~50 language names; see Hub re-transcription): SenseVoice for
  Japanese, Chinese, Cantonese and Korean, Parakeet v3 for 24 European languages (Greek,
  Spanish, French, German, Russian...), Whisper for everything else, and Whisper too when he
  names none. The model loads the moment he gives the instruction. The way each line goes is
  set in code, not by the model (told "translate everything I say into Japanese", it put
  Korean into Japanese too): a line the model heard as not English (`heard_lang`), or written
  in a non-Latin script, goes into English for him; a line heard as English, or plainly English
  words (`looksEnglish`), goes into the language he named; a short Latin line nobody can tell
  is left to the model. Hub audio bench 2026-11-03, from the clip arriving to the first
  translated words: Japanese, Korean 0.8-1.3 s; Spanish, German, French 0.8-1.3 s; through
  Whisper (named Turkish) 2-3.2 s. Known limit: a third language under a Spanish instruction
  (French) went into Spanish, not English. Replies in another script are spoken by the phone's
  Android voice for that language (TtsManager `scriptLocale`), sentence by sentence at 。！？
  (app 0.4.65).
  - **The instruction lines get a fixed reply at once** (`interpreterAck`, router.js): a line
    that only turns interpreting on ("Okay, I'll interpret. Japanese and English."), only names
    its language ("Okay, Spanish.") or only turns it off ("Okay, I've stopped."), checked by
    taking out the instruction, the language name and `INSTRUCTION_FILLER`. A line with
    anything else in it ("translate for her: how much is this?") still goes on whole. The
    local model took 2-3 s for these and said things like "I'm not a native speaker, you'll
    have to teach me the nuance first", over the other person's first words.
  - **A language can come late.** "Be our interpreter" [pause] "she speaks Spanish" reaches
    the hub as two turns; the second completes the instruction (`standingInstruction`). With
    no language named at all, the first full line Whisper hears from the other person sets it
    (`learnInterpretingLanguage`, logged `[interpreting] no language named; heard es`), and
    the lines after it go to that language's faster model: Spanish 2.2 s, then 0.35 s.
  - **Whisper repeats itself on a short line** ("Stop translating. Stop translating..." for a
    1.4 s clip): `dropRepeats` in hub-asr.js removes a sentence that only repeats the one before
    and a line that is one phrase over and over, and English Whisper heard goes on to
    Parakeet v2 like SenseVoice's.
  - **Phone bench** (voicebench `--only interpret`, app 0.4.68, Craft 32): every line into the
    right language; end of speech to PAN's voice ~2-3.5 s (turn decision ~0.35 s, upload and
    hub speech-to-text ~0.4-0.7 s, translation ~0.7-1.2 s and up to 2.9 s on a slow cloud
    call, then the voice: Android's Japanese starts in ~0.15-0.6 s, Supertonic English needs
    0.5-1.4 s to synthesize a long line before it plays).
  - **Said the way he says it** (his first real try, Greek, 2026-11-03): "translate everything
    I say into Greek", "interpret what they say", "keep translating" are instructions too
    (`STANDING_SET_RE`), with no "from now on". The instruction turn itself goes to the
    interpreter (`setting`): "I told you to translate everything, so ask them how much this
    costs" says "Πόσο κοστίζει αυτό;" to them. "Ask them X" / "tell her X" is said to them
    directly, not translated as an order. "Translate that" / "say that again" repeats PAN's
    last translation at once (`SAY_AGAIN_RE`, `lastTranslation`), with no model call.
  - **One line, no instruction:** "how do you say thank you in Japanese", "translate good
    morning into Greek" go to the voice chain's cloud model with a short prompt
    (`translatePrompt`), ~1.2-1.9 s. Before, the local model answered "I can't find the line
    you're talking about".
  - **Own script:** a reply in Greek, Japanese, Chinese, Korean, Cyrillic, Arabic, Hebrew,
    Hindi, Thai and a few more is asked for in that script, never Latin letters (`SCRIPTS`,
    `inScript`). The phone picks the voice by the script, and "kalimera" / "Arigatou" were read
    out by the English voice.
  - **Survives a reload:** the mode is saved in the world (`intuition/world.js`, table
    `world_modes`), so a Craft swap or a restart keeps it; before, it lived in router.js memory
    and every swap ended it. It lasts 2 hours after its last use, not after he gave it. 10 s
    after a start, the speech model for its language is loaded again. Hub bench 2026-11-03:
    on, swap, "Thank you very much" still came out "Ευχαριστώ πολύ".
  - **The voice while interpreting** (app 0.4.69, changed in 0.4.75): the hub sends
    `{"type":"interpreting"}` before an interpreting reply, which sets `TtsManager.interpreting`
    for it. See "Supertonic on the normal audio path" below.
  - **Cloud quota:** interpreting needs the cloud model (the local gemma4:e2b turned "how much
    does this cost" into broken Greek). Gemini's free tier is 500 requests a day per model,
    reset at midnight Pacific, and Intuition's classifier alone made 414 on 2026-11-03, so
    the interpreter ran out at 9 PM ET. Intuition no longer calls a model at all (rules in
    `intuition/reader.js` since Craft 45), background jobs never fall back to the cloud
    (`ai_fallback_chain_background` is local only), voice keeps gemini-3.5-flash-lite, and
    the voice chain has 3.1-flash-lite third. A Gemini stream that sends nothing is cut at 7 s (the first-token
    watchdog in llm-fallback.js, Cerebras only before; `firstTokenMs` sets it per call) and
    the SDK now gets the abort signal (llm.js): an overloaded free-tier model held one turn
    81 s.
  - **On the phone, no hub and no language model** (`interpret/InterpreterLoop.kt`, app 0.4.74,
    2026-11-05): a live test through the hub took 3.0 s from his last word to the voice (end of
    turn 0.86, upload and two speech models 0.75, Gemini 1.23, voice 0.15). After every reply
    the hub sends `{"type":"interpreter","lang":"ja"}` (empty when off, `?` with no language
    named yet). If the phone has that language's models it hears, translates and speaks by
    itself (`sttEngine.ear`): SenseVoice for ja, zh, ko, yue (`interp/sensevoice`, about 80 ms a
    line), the Greek ear for el (`interp/parakeetel`, below) and two quickmt
    models (`interp/quickmt-<src>-<tgt>`, about 130 ms a line, CTranslate2 and SentencePiece in
    `libpanmt.so`, built by `android/panmt/build.ps1`, `translate/QuickMt.kt`). Models live in
    the app's external files and for now go on by adb; a phone without them stays on the hub.
    **It starts at the first silence** (`TurnEar.onPause`, 96 ms after his last word), while end
    of turn is still being decided, so at the commit the translation is usually ready. If he
    goes on it is thrown away and nobody has heard anything. Stop to first audio on the bench
    (`interp_talk_ja`, `interp_talk_el`, `interp_ja`, screen off, with the Android voices, app
    0.4.74): Japanese both ways 0.28 to 0.45
    s, a 7 s Japanese sentence 0.86 s, English into Greek 0.38 to 0.63 s, Greek into English 0.69
    to 0.74 s. The bench says the same lines every run, and Google's voice keeps what it has
    said: a known line starts in 3 to 60 ms, a new one in 70 to 150, so a real talk runs up to
    0.1 s slower. Not yet tried with real people talking into the microphone. **The language
    heard picks the direction** on every line: English goes into the other language, the other
    language into English, with no setting. SenseVoice names the language. The Greek ear can only
    write Greek, so there Whisper tiny (`interp/lid`, 93 ms, always reads 30 s) says whether a
    line was English, and English goes to SenseVoice: it said "en" for 11 of 11 English lines and
    for none of 30 real Greek ones. One after the other: side by side they took 340 to 610 ms on
    this phone's few fast cores. A third
    language (3.2 s for Korean), "stop translating", "ask them...", and anything starting with PAN's name go to the
    hub as a normal turn (`onHandOver`). In Greek mode a third language is not caught: it is read
    as Greek. "Say that again" repeats the last line. PAN's own line
    coming back within 8 s is dropped, and so is anything under 0.4 s of audio: 0.22 s of the
    end of a clip came back as "Yeah." and PAN said it. While it runs, each line still goes to
    the history (`speakInterpreted`).
  - **The Greek ear** (`interp/parakeetel`, 912 MB): myned-ai's fine-tune of Parakeet v3, CC-BY-4.0.
    Parakeet v3 itself has no final sigma in its vocabulary, so it drops the letter from every
    word that ends in one, and on real speech it wrote Latin or Cyrillic letters often enough to
    say nonsense to someone's face ("Ven eхме trapezi"). On 40 real speakers' clips (FLEURS test,
    on the phone) it got 45.1% of words wrong and the fine-tune 10.8%, with every line in Greek.
    FLEURS's training half was in the fine-tune's data, so these clips are separate but familiar;
    its card gives 8.9 to 13.1% on everyday Common Voice speakers.
    Phone voices reading test lines had hidden this. The fine-tune's published int8 does not load
    (ConvInteger with int8 weights crashes the app) and loses accuracy (18.7% on the card): ours
    is quantized from the float encoder, MatMul only, per channel, decoder and joiner left in
    float (`evals/ears/`, with the FLEURS scoring). 170 ms a line alone, about 330 ms in the live
    loop with Smart Turn running. It is trained on 2,003 h of podcasts that were not licensed to
    its author, which matters before PAN is sold. It writes questions with a Latin question mark,
    changed to `;`. SenseVoice on real Japanese the same way: 7.3% of characters wrong, 40 of 40
    clips named as Japanese. Masking Parakeet v3's joiner to Greek letters did not help: it
    writes nothing instead.
  - **One voice engine per language while interpreting** (`TtsManager.prepareLanguage`): a two way
    talk changes language every line, and one engine changing voice took 230 to 930 ms to start.
    An engine that keeps its voice took 60 to 110 ms on a line it had never said (InterpretBench
    `fresh`). Set up when the mode starts, then warmed with quiet numbers, back and forth: the
    first new line after the other voice had been used took 0.47 s once, and a word Google's
    voice already knows comes from its cache and warms nothing. All engines share one player, so
    a real line drops whatever warming is left (`dropWarming`): four quiet lines held the first
    line back 4 s. Voices stayed ready after 10 lines of the other language and after 60 s quiet.
  - **Supertonic on the normal audio path** (`TtsManager.interpreting`, app 0.4.75, 2026-11-06):
    the owner said the voice sounded like voice over IP from 2004, and it was: every line ran on
    the call path (AUDIO_OUTPUT_FLAG_VOIP_RX, HAL route `speaker (VOICE)`, Google's voice at
    24 kHz), the one that lets the phone cancel PAN from the mic. He heard one line five ways
    and chose Supertonic voice 9 in English, Japanese and Greek, with voice 6 a good second. So
    a line in any language it reads goes to Supertonic with `USAGE_MEDIA` in MODE_NORMAL
    (`PiperTtsEngine.plainPath`), clean, without the call path's tanh drive. A language it cannot
    read (Chinese) stays on the Android voice, on the same media path (`TtsManager.androidOnMedia`).
    Media volume goes to full while the mode is on and is put back after. On 2026-11-06 Chinese was
    going out of the earpiece (HAL `speaker-earpiece (VOICE)`): measured on the phone's two mics with
    `TEST_LOUD` and `scrcpy --audio-source=mic`, the media path is about 12 dB louder.

    The app has no MODIFY_AUDIO_SETTINGS, so `audioManager.mode` and `isSpeakerphoneOn` have always
    been denied (logcat `Audio Settings Permission Denial`). Only `setCommunicationDevice` works, so
    an Android voice line outside interpreting calls `PiperTtsEngine.toLoudspeaker()`. Adding the
    permission turns on call mode for all of PAN's speech: the speaker then came about a second late,
    and Android resets the mode after 6 s because Google's TTS process plays the line, not PAN. The Android
    voice engines above are only set up for those languages now.
    - **Library:** needs sherpa-onnx 2.0 (1.12.34 refused all but en, ko, es, pt, fr). The AAR is
      the static link build of 2.0.1: the plain one brings a libonnxruntime.so that clashes with
      onnxruntime-android. Old against new on the hub: 119 of 119 streaming clips the same, 24
      of 24 language checks the same, SenseVoice on real Japanese 2.9% to 2.4% of sounds wrong.
    - **Speed by language:** every test line said, then read back by our own ears
      (`evals/ears/voice_readback.py`, no phone). Sounds wrong at speed 1.2 / 1.0: English 2.8% /
      0.9%, Greek 2.2% / 1.1%, Japanese 37% / 8%, with whole words gone. Supertonic rushes kanji:
      its Japanese at 1.0 is 30% faster than the Android voice, and at 0.8 it is that voice's
      pace. So interpreted lines go at 1.0, Japanese at 0.8. As shipped, through the trim and
      level: English 1.1%, Greek 0.3%, Japanese 1.5% (the Android voice 2.8%). Feeding it kana
      gave 3.5% at 1.0: slowing down did more, with no reader to ship. 3 steps are worse in
      English (5.0%) and Greek (9.2%), but 2.2% in Japanese at 0.8, which would save about 0.1 s
      if it sounds the same. 2 steps are about 10% everywhere.
    - **Numbers as words** (`tts/SpokenNumbers.kt`, English and Greek): the translator writes
      digits, and "1,200 yen" came back "1 to 00 yen", "στις 15" as "στις 5". On lines that are
      mostly numbers: English 24% to 11%, and what is left there is SenseVoice losing "euros", which
      Parakeet read fine from the same audio. Greek 8% to 1%. Japanese reads digits well, 0.8%.
    - **What it costs:** Supertonic builds the whole line before any sound, 0.5 to 1 s on the
      Pixel where the Android voice takes 0.1 s, about 0.7 s of the wait. Worked out from the
      parts, not yet measured end to end: 1.0 to 1.4 s from stop to sound, where the Android
      voices were 0.3 to 0.75 s and the hub 3.0 s. Each step of the 4 is 120 to 170 ms, and more
      threads than 3 or the float model are slower (InterpretBench `supertime`).
    - **Built early** (`PiperTtsEngine.prepare`, `InterpreterLoop.onDraft`): the line starts
      building when the translation is ready, not at the commit, and `speak()` finds it. An
      unsure pause commits at 0.6 s, so this hides up to 0.35 s of it. Nothing plays and the
      mic stays open, so a line nobody commits is just forgotten.
    - **Echo:** nothing is known to cancel PAN on this path, and how much reaches the mic needs
      the real phone: `tts_echo` logs the loudest echo of each line. Until then
      `evals/ears/sim_mic.py` runs a port of the read loop with the real voice, Silero and ears
      and a simulated room, with no cancelling at all. Three things came out of it or of reading
      the code for it. The room ringing after PAN stops opened a turn for the ear after 11 to 14
      of 18 lines, so speech does not count for `ECHO_TAIL_MS` after a line, and none did then.
      What the mic heard during the line is dropped when it ends, so the pre-roll cannot feed PAN
      to the ear. The barge-in level is learned from the first sound (`onTtsSound`), not from
      when the line was asked for, which is up to a second earlier. Talking over PAN needs a voice
      louder than PAN: nobody at -26 dB stopped it at any echo level tried, down to -36 dB.
  - **The card shows stop to first audio** (`tts_audio`, `onPlayStart`): the later of the voice's
    onStart and its first audio, because either can come first. Green to 1.0 s, yellow to 2.5 s.
  - **Turns end sooner while interpreting** (`SttEngine.interpreting`, phone or hub path): only
    a Smart Turn verdict of 0.9 ends a turn at once, a second look comes at 380 ms, and an
    unsure pause ends at 0.6 s, not 1.4 s. The English recogniser's words are not used: they
    mean nothing when the other person talks. Under 0.9 still waits, because at 0.67 "Thank you,
    that is very kind of you" went out at the comma.
  - **quickmt, one small model per direction** (Craft 66): every `quickmt-<src>-<tgt>` folder
    beside the main model answers its own direction first (`Pairs` in translate-server.py, `GET /`
    lists them as `pairs`, `pairInstalled` in translate-local.js). 185M parameters, 8 encoder and
    2 decoder layers, CC-BY-4.0 (quickmt must be credited). Installed: en-ja, ja-en, en-el,
    el-en. 40 ms a line on 4 hub threads where MADLAD takes 1.2 to 2.7 s. A language with a pair
    no longer goes to the cloud first. On 104 everyday lines (`evals/translate`, facts such as
    prices, times and places) it kept 99, ML Kit's text translator 88; M2M changed the country in
    "from <country>" to "from Japan" and 7 in the evening to 7 a.m. On the held-out set (`translate-eval.py`,
    100 lines a direction) en-el 83.4, el-en 75.7, en-ja 48.1 (MADLAD 48.6), ja-en 67.4. Known
    slips: kanji numbers ("千二百円" came out 1,000 yen; SenseVoice writes digits, so speech is
    safer than the test), and words with two readings ("十分", "辛い"). A translator that hands
    the words straight back counts as no translation (`sameWords`, translate-local.js): MADLAD
    did that for five English lines in a row when the cloud was paused.
  - **Google's translators, tested and not used:** ML Kit text (`com.google.mlkit:translate`):
    free in a commercial app, Google may stop it at any time and gets usage metrics, 88 of 104
    facts, at about quickmt's speed on the phone (122 to 168 ms a line). Android's own translator (`TranslationManager`): gave our app no
    translator. ML Kit GenAI Speech Translation: alpha, and its terms bar preview features in
    production, apps under-18s may use, and products that compete with Gemini Nano; it also
    pulls Kotlin 2.4 into this build. Not measured.
  - **The hub's own translator first, the cloud first only into Japanese and Chinese**
    (`interpretStream`, router.js): since 2026-11-04 (Craft 51) an interpreting line goes to the
    hub's translator (steward service "translate", port 7784, `translate-local.js`) and to
    Gemini only if it has nothing, except into Japanese, Chinese and Cantonese
    (`INTERPRET_CLOUD_FIRST`), where MADLAD scores lowest (chrF 48.6 into Japanese, 35.7 into
    Chinese, 77 to 87 into the European languages). It's free, and no Gemini quota goes on the
    languages the translator does well. Bench (Craft 51): into Greek 1.1 to 1.8 s a line warm,
    Greek or Japanese into English 0.6 to 1.1 s, Japanese out from Gemini with its first words
    at 1.9 s. Never the local chat model. On the cloud-first path each Gemini model gets 2.5 s
    for its first words and the translator answers if neither does; after 2 lines in a row with nothing from the cloud, the cloud is
    skipped for 2 minutes. With none installed the cloud gets its usual time; MADLAD has been
    installed since 2026-11-04, and that night it answered every line of his Greek session
    while gemini-3.5-flash-lite was out of quota and 3.1-flash-lite sent nothing. "Ask them
    X", "tell her X" and "let them know X" are turned into the words for them in code
    (`toDirectSpeech`): the fallback model translated the request itself, as an order to the
    shopkeeper. Also handled: words for PAN in front ("I need you to", "I'd like you to", "No,
    I said"), "ask if/how/where ..." with no "them", and "I asked them how much this costs",
    him repeating what he wanted said, which the translator gave word for word ("Τους ρώτησα
    ...") until 2026-11-04 (Craft 48).
    NLLB-200 was tried as the translator on 2026-11-03 (0.2 s a line; Greek usable, Japanese
    weak) and removed the same night: its licence is non-commercial, and PAN takes nothing
    non-commercial. The next one must allow commercial use (INTUITION-STATE-ENGINE.md step 1).
  - **The translator server** (`translate-server.py`, steward service "translate"): one
    CTranslate2 model on the CPU, `GET /` (503 while loading) and `POST /translate {text,
    src, tgt, beam?}` with ISO 639-1 codes. Two engines, both licensed for commercial use:
    MADLAD-400 3B (Apache 2.0, the int8 build Nextcloud ships, folder
    `<PAN local>/models/madlad400-3b-mt-ct2-int8`, target tag `<2xx>` before the source) and
    M2M-100 418M (MIT, `models/m2m100-418m-ct2-int8`, `__xx__` tags); the kind is read from
    the folder's tokenizer file. Lines are split into sentences (CJK on their own full stops)
    and translated as one batch. The steward runs the folder named by the `translate_model`
    setting ("none" turns it off), else the first complete install in `TRANSLATE_MODELS`
    (steward.js), so switching engines is a setting and a Craft swap. The NLLB lessons hold:
    the port is bound exclusively before the model loads (Windows let two copies share it),
    and CT2_USE_MKL is never set (50x slower on this CPU).
    - **Live: MADLAD, 8 threads, beam 4, no length bonus, M2M as its referee** (0.6-1.3 s
      a line on the hub). On the 81 line bench (chrF, 4 threads, beam 2) MADLAD scored 69.3
      at a median 1.3 s against M2M's 53.9 at 0.22 s: Greek out 84 vs 68, Japanese out 61 vs
      27, Greek in 67 vs 46, Spanish out 87 vs 72. M2M was better only at French out (69 vs
      58). On 2,400 held-out everyday lines in 12 languages (Tatoeba, `translate-eval.py`)
      MADLAD scored 75.1 to M2M's 65.2.
    - **MADLAD makes things up after short lines:** 9.5% of those held-out lines came back
      with an extra clause ("Good evening." -> "Καλησπέρα, καλημέρα."; "Με λένε Αντρέα." ->
      "My name is Andrea, I'm 18 years old."), M2M 0.9%. Beam 4 with `length_penalty` 0
      (`DEFAULT_BEAM`/`DEFAULT_LP`) cut that by a third on the worst languages and was faster.
      Then M2M, loaded in the same server (`--referee auto`, the M2M folder beside the model),
      judges each sentence: when MADLAD's line runs well past both M2M's and the length the
      source would make (`LEN_VS_EN`), it is cut at the comma, dash or "and" nearest M2M's
      length (`referee_check`). Replayed on the 2,400 lines that left 2.2% overruns and raised
      chrF to 76.5. M2M drops words itself ("please", "excuse me"), so it never replaces
      MADLAD's line, and a referee line far too short for the source is ignored.
      `GET /` shows the referee. Live result on the deployed service (`translate-eval.py`,
      100 held-out lines per direction, 12 languages): chrF 76.2 average, 77 to 87 for
      most directions. Weakest: into Chinese 35.7, into Japanese 48.6 (both partly a
      reference mismatch), into Arabic 65.7, Russian to English 71.2. Median 0.8 to 2.1 s a line.
    - **MADLAD's input trap:** the `<2xx>` tag is encoded together with the text,
      `sp.encode("<2el> " + text)`, which puts a lone "▁" piece before the tag, and no
      `</s>` goes on the end (as Nextcloud's app does it). With the tag as its own token the
      model babbled ("Πό, Π , Π. Π.", chrF 23). It also keeps writing like a web page ("We'll
      get back to you shortly."), so an output keeps only as many sentences as its source
      had (`keep_sentences`), with a repetition penalty of 1.3.
- **World clock:** places only he says live in the `zone_aliases` setting (JSON, name to IANA
  zone), merged over the public table in `tools.js`.
- **Preserves:** the gate, ambient veto and action handling downstream are unchanged.

---

## Phone voice (text to speech)

- **Interpreting volume:** media goes up to 4/5 of the top while interpreting (20 of 25 on the Pixel, `interpreterVolume`, app 0.4.79), then back. Above that the phone gets harsher, not louder.

- **Pendant mic (test only so far):** the XIAO streams 16 kHz speech over Bluetooth as IMA ADPCM, and `ble/PendantMic.kt` decodes it. `TEST_PENDANT_MIC --es sec 10` records it to `voicebench/pendant_mic.wav`; `--es live 1` makes PAN hear the pendant instead of the phone's mic, `--es live 0` undoes it; `--es cmd x` sends the board one command. Firmware notes in `firmware/pendant/README.md`.

- **A voice per person while interpreting:** `interpret/VoiceBook.kt` (app 0.4.78). Each line heard is matched to a voice print, likeness 0.4 or more is the same person, anyone else on a line of 1.5 s or more is a new person, up to 4. No sign-up. The first person out gets Supertonic voice 9, then 6, 3, 1 (`InterpreterLoop.VOICES`). `pick()` only looks, because a line can be read at a pause and run on; `keep()` runs once the line is really said. Prints stay in memory and go when interpreting ends. Needs `interp/spk/model.onnx` (CAM++ zh_en, 27 MB); a phone without it interprets in one voice. A language Supertonic cannot read stays on the Android voice, so it gets no per-person voice. Test with no mic or sound: `TEST_INTERP_BENCH --es what people --es clips a.wav,b.wav`; hear a voice with `TEST_LOUD --es sid 6`.

- **Everyday Japanese (app 0.4.86):** `interpret/JaSentences.kt` puts back sentence breaks the ear drops, and `interpret/JaPhrases.kt` translates set phrases by table. Giving the translator the previous line as context was tried and left out: it fixed some lines, broke others, and doubled the time. Test: `TEST_INTERP_BENCH --es what mtlines`, lines in `voicebench/mt_lines.tsv`, output `mt_out.txt`.

- **Pieces while talking (test only, app 0.4.88):** with a PAN linked, at each pause in his English the part not sent yet goes across if it has at least 4 words and does not end on a word like "the" or "to". The rest goes when the line ends.

- **PAN to PAN (test only, app 0.4.84):** with `TEST_PEER --es url ...` the phone sends its owner's translated line to the other person's device as text and says nothing itself, and lines that arrive are translated and spoken to the owner (`interpret/PeerLink.kt`). The far end for testing is `voicebench/peer_person.py`. Plain HTTP over a tunnel, no sign in, not for use outside the owner's machines.

- **Language per person and longer waits (app 0.4.83):** a line under 3 s in a language its speaker has not been using is dropped as the ear's mistake. While interpreting, a pause Smart Turn scores under 0.5 waits 1.0 s instead of 0.6 s before PAN speaks.

- **Wrong language guards (app 0.4.82):** a third language from someone already heard speaking English is dropped, not sent to the hub, because the ear sometimes calls mumbled English Chinese and the hub answers in English. A translation that comes back mostly in English letters goes to the hub instead of being spoken.

- **Short first piece (app 0.4.81):** a line with no early comma is cut at a joint, after a particle that follows a noun in Japanese, before a joining word in English (`LineClauses`). Greek is not cut this way yet. A comma later than about 8 kana loses to a joint. Build time follows length, so this is the main saving on long lines.

- **Interpreted lines in pieces:** `tts/LineClauses.kt` splits a line at its first clause (at least about 10 letters each side, never inside "1,200"). `prepareLine` builds only that piece early, and the rest builds in whole sentences while it plays (app 0.4.76).

- **Where:** on the phone, never the hub (`tts/TtsManager.kt`, `tts/PiperTtsEngine.kt`,
  sherpa-onnx). Settings → Voice picks it (`voice_quality` in `pan_tts_prefs`).
- **Default:** Supertonic 3 (`supertonic3`, app 0.4.59; sid 9, speed 1.20 and 4 refinement
  steps, per voice in `VOICES`). 3 steps lost the last word of 12% of real lines and 45% of
  short ones; 4 is as good as 5 (3% and 19%). Lines of three words or fewer go at speed 1.0:
  39 of 48 came out whole at 1.20, 47 at 1.0. The quiet the model leaves at each end, about
  0.3 s before and 0.35 s after, is cut (`trimQuiet`), so two sentences are 0.26 s apart, not
  0.8 s, and the first word comes 0.3 s sooner. Supertonic 2 (`supertonic`) slurred and mangled
  words at every speed and step count tried ("documentimentation", dropped "stay" and
  "depends on"; Parakeet misheard 2-7% of its words). Supertonic 3 misheard 0.7% at 1.20 and
  4-5% at 1.35 ("termination"), and at 1.20 it talks as fast as v2 did at 1.35. Model files are staged into
  `files/piper-models/<id>/` (over adb, or downloaded from the sherpa-onnx `tts-models`
  release).
- **Other scripts:** a reply mostly in another script (Japanese, Greek, Cyrillic) goes to
  Android's own voice for that language, except while interpreting, when Supertonic reads the
  languages it can (see "Supertonic on the normal audio path"); a few Greek letters in English
  ("ΠΑΝ") are spelled in Latin for the English voice (app 0.4.57).
- **Debug tuning:** `adb shell am startservice -n dev.pan.app/.service.PanForegroundService
  -a TEST_TTS --es voice supertonic3 --es steps 8 --es speed 1.35 --es silence 0.2` (debug
  builds; `voice` is saved like the Settings choice, the rest last until the app restarts).

---

## Voice lookup tools

- **Purpose:** real data the model cannot know, fetched before the prompt is built
  (`tools.js`, `buildToolBlocks`): weather (needs the phone's GPS, no fallback), Wikipedia
  when asked for, currency, crypto, air quality, news/search, a named URL, and the world
  clock. Matching tools run in parallel with a 1.5 s deadline; a miss adds no block.
- **World clock:** "what time is it in Tokyo" reads the hub's clock in that zone, no
  network: any IANA city, plus the countries and states people say ("California", "the
  UK"). Only the place after "in" counts. The voice model cannot do time-zone sums.
- **Decision calculator:** not run inline. It builds its ranges with `gemma4:e4b` on the hub
  CPU (16-20 s) and failed 919 of 919 times inside the deadline, so every "should I" turn
  waited 1.5 s for nothing (`slow: true` in `TOOLS`).
- **Live vs not:** tools marked `live` (all but Wikipedia and the calculator) are the only
  ones the voice student path runs and passes on (see Voice student model). Weather and
  search count as live only for a real ask (`WEATHER_ASK`, `SEARCH_ASK`): their match words
  also fire on "wind chimes" or "what happened to my build", and the "switch on your
  location" note is never live data.

---

## Conversation benchmark (voicebench)

- **Purpose:** measure how conversational the voice loop is, from real audio, so every
  change to it is scored instead of judged by ear. Phase 0 of
  `docs/research/reports/PAN conversational voice plan.md`.
- **Phone (debug builds only, app 0.4.47+):**
  - `TEST_AUDIO --es file X.wav` plays a 16 kHz mono WAV from
    `/sdcard/Android/data/dev.pan.app/files/voicebench/` in place of the microphone.
    `debug/TestAudio.kt` overwrites the samples in `SherpaStreamingStt`'s read loop, so the
    VAD, recogniser, Smart Turn, echo filter, barge-in, hub and voice all run for real.
    While a session is active the mic is silence between clips.
  - `TEST_RESET` starts a fresh conversation (stops speech, cancels the query, clears
    history, dedup and cooldown). `TEST_AUDIO_END` ends the session and restores his history.
  - A session nothing has played into for 2 minutes ends itself (app 0.4.56+): history
    restored, mic given back, and PAN muted again if it was muted when the run began. A run
    that died (USB cable out) used to leave the mic replaced by silence until a restart.
  - Every voice-loop moment is a JSON line on logcat tag `PANEVT` (`debug/VoiceEvents.kt`),
    timed on `elapsedRealtime`: `inject_start/end`, `vad_on/off`, `partial`, `turn_p`,
    `hold`, `commit`, `final`, `echo_drop`, `barge_in`, `on_speech`, `drop` (with reason),
    `query`, `heard`, `first_chunk`, `reply_done`, `speak`, `tts_gen_start/end`,
    `tts_play_start/end`, `tts_stop`.
- **Nothing a run says is kept:** while a session is active the phone skips
  `DataRepository` writes, history sync and log shipping, and sends `bench:true`. The hub
  then runs the turn inside `bench-context.js`, where `logEvent`, `writeThought`, memory and
  calendar inserts, meal/signal noting and correction learning do nothing, uses device key
  `<device>-bench` (standing instructions stay separate) and skips the history fallback.
- **Hub timings:** `voice-timing.jsonl` in the hub's data dir, one line per stage per turn
  (`asr`, `setup`, `first_chunk`, `first_chunk_sent`, `total`) sharing a turn id
  (`voice-timing.js`). Rolls over at 5 MB.
- **Runner:** `service/src/evals/voicebench/` (Python, laptop or Mint with adb):
  `make_clips.py` (SAPI voice, exact pauses) then `run.py [--only family]`, which unmutes
  PAN for the run if needed and mutes it again, then `score.py` writes `summary.md` and
  `scores.json` under `runs/<stamp>/` with the scorecard M1-M8 and M11. `run.py` moves to
  the next clip only when every query has its `reply_done` and PAN has gone quiet.
- **Real conversation** (`--only conversation`, the number to quote): three unbroken talks, 52
  turns, every job on the PAN Models page in them (telling, stories, views, follow-ups,
  remembering, looking up, thinking it over, glancing, talking to someone else, "mm hmm",
  cutting in). Each step has a `move`; `summary.md` ends with the moves slowest first, each with
  its target (`MOVES` in `score.py`) and its end of turn, hearing, thinking and voice. A
  scenario's `quiet_s` starts his next line right after PAN stops, as a person would.
- **Interpreting** (`--only interpret`): he asks PAN to interpret, then she speaks recorded
  speech in her language (`{"wav": ..., "text": ...}` phrases from `sources/`, not in git:
  16 kHz mono clips, today the sherpa-onnx model test clips for ja, ko, zh, es, de, fr) and he
  answers in English. `expect_lang` is the language each reply must come out in, scored as
  I1 (right language), I2 (gap p50/p90) and I3 (no voice within 5 s), apart from the
  conversation scorecard. Each scenario ends "stop translating", and `run.py` says it too
  when a run dies inside one: the instruction would last 2 hours on the bench key. The
  Android voice logs `tts_play_start/end` with `engine: android` (app 0.4.66), so Japanese
  replies are timed and waited for like Supertonic's.
- **Live session** (`live.py`, app 0.4.66+ `TEST_LIVE`): a session on his own microphone,
  for what a recording cannot test, e.g. a second speaker (a person, or a voice chat on
  another device) speaking Japanese at the phone while PAN interprets, real echo, people
  talking over PAN. Nothing said is kept, and the interpreting instruction has to be given
  inside the session (bench key). Prints a timeline per turn (phone heard, hub heard, PAN
  said, seconds from the speech stopping to PAN's voice) and writes
  `runs/<stamp>-live/events.jsonl` and `timeline.txt`. Ends on Ctrl+C, `--minutes` (20), a
  `stop` file in its run folder, or by itself on the phone after 30 minutes.
- **Preserves:** release builds are untouched (all actions and events are
  `BuildConfig.DEBUG`-gated); a normal turn's hub path is unchanged apart from timing lines.

---

## Installer — Smart Device Naming

- **Purpose:** When a client device installs PAN, name it from hardware model
  instead of raw hostname (e.g. "Dell G16-work-pc" not just "work-pc").
- **Windows:** `wmic computersystem get model` → prepended to hostname
- **macOS:** `system_profiler SPHardwareDataType` Model Name field
- **Linux:** `/sys/devices/virtual/dmi/id/product_name`
- **Fallback:** Raw hostname if model detection fails or returns generic string
- **Where:** `pan-installer.cjs` (browser-based installer) and
  `generateWindowsClientInstaller()` in `server.js` (PowerShell installer)

---

## Webcam Watcher

- **Purpose:** Continuous presence detection via the PC webcam. Primary signal
  for "who is at the desk" in the identity system.
- **File:** `service/src/webcam-watcher.js`
- **Polling:** Every 30s (unlocked) or every 5 min (identity locked)
- **Burst mode:** Up to 3 frames per cycle; stops on first face detection
- **Debounce:** Needs 2 consecutive misses before flipping to "desk empty"
- **Idle gate:** If keyboard/mouse active in last 2 min, stays locked even if
  camera misses a face (prevents false "desk empty" from momentary occlusion)
- **Auto-enroll:** High-confidence frames (≥80%) are added to descriptor pool
  (max 20 per identity cluster)
- **DB:** Stores `webcam_context` events with presence, identity, confidence, emotion
- **Status endpoint:** `GET /api/v1/webcam-watcher/status`

---

## Screen Watcher

- **Purpose:** Vision AI analysis of what's on screen every 60s. Used by
  intuition.js as the #1 activity signal (overrides webcam context).
- **File:** `service/src/screen-watcher.js`
- **Capture:** FFmpeg gdigrab (Windows) or Tauri shell (port 7790 if available)
- **Analysis:** Resizes to 640px wide JPEG → minicpm-v → stores `screen_context` event
- **Idle skip:** After 3 min inactivity, stops capturing
- **Stale timeout:** Context older than 120s is ignored by intuition.js
- **Burst mode:** `startBurst(durationMs, burstMs)` — rapid captures during Craft
  swap / reload events (default: every 5s for 60s)
- **Status endpoint:** `GET /api/v1/screen-watcher/status`

---

## PAN Notify (Service Messaging)

- **Purpose:** Unified channel for PAN's own services to message the user.
  Scout, Dream, Pipeline, Memory all drop messages into a single ΠΑΝ thread.
- **File:** `service/src/pan-notify.js`
- **API:**
  - `panNotify(service, subject, body, opts)` — post a message from a service
  - `panReply(userMessage)` — user replies in ΠΑΝ thread → Cerebras Qwen responds
  - `ensurePanContact()` — idempotent boot setup (creates ΠΑΝ contact + thread)
- **Severity:** `info` | `warning` | `critical`
- **Storage:** `chat_messages` table with service, severity, metadata fields
- **Service sign-offs:** Scout · 🔍, Dream · ✨, Pipeline · 🔬, Memory · 🧠
- **Where visible:** Comms panel (chat thread from ΠΑΝ contact)

---

## Skill Learner (Auto-Skill Generation)

- **Purpose:** After every Claude session, evaluate if a novel reusable skill
  was demonstrated. If yes, auto-generate a SKILL.md and add it to the
  pan-local plugin marketplace.
- **File:** `service/src/hooks/skill-learner.js`
- **Trigger:** Claude Code Stop hook (runs after every session ends)
- **Flow:**
  1. Reads session transcript from stdin
  2. Calls Cerebras (fast, cheap) to evaluate if session was novel + reusable
  3. If yes (min 4 turns, clear skill demonstrated): generates SKILL.md
  4. Saves to `~/.claude/plugins/local/<skill-name>/`
  5. Updates `marketplace.json` with new skill entry
  6. Logs to PAN server (best-effort)
- **Format:** SKILL.md = YAML frontmatter + Markdown instructions + optional JS
- **Threshold:** Session must have ≥4 turns and demonstrate a reusable capability

---

---

## Web Dashboard — All Pages

The dashboard is a SvelteKit app compiled to `service/public/v2/`. It has
**18 pages** (not 11 — the earlier count was outdated):

| Route | Purpose | Status |
|-------|---------|--------|
| `/v2/terminal` | Main PTY + Claude pipe + sidebar widgets | Built |
| `/v2/atlas` | Radial system map (Atlas V2) | Built |
| `/v2/conversations` | Browse + search past sessions | Built |
| `/v2/sensors` | 22 sensor category toggles | Built |
| `/v2/automation` | Automation / scripting interface | Built |
| `/v2/projects` | Project list + task progress | Built |
| `/v2/settings` | Server config, model selection, keys | Built |
| `/v2/data` | DB browsing + export | Built |
| `/v2/crucible` | Side-by-side shadow traffic comparison | Built |
| `/v2/terminal-dev` | Dev server terminal (port 7781) | Built |
| `/v2/chat` | Chat interface (direct messaging) | Built |
| `/v2/comms` | Communications hub — threads, ΠΑΝ messages | Built |
| `/v2/compose` | Message composition | Built |
| `/v2/call` | Audio/video calling UI | Built |
| `/v2/kanban` | Kanban board view of project tasks | Built |
| `/v2/timeline` | Timeline/history of project work | Built |
| `/v2/kronos` | Time/scheduling/calendar interface | Built |
| `/v2/atlas-v2` | Alias / migration target for Atlas | Built |

Build: `cd service/dashboard && npm run build` → outputs to `service/public/v2/`.
Must rebuild after editing any `.svelte` file.

---

## Atlas V2 (System Visualization)

- **Purpose:** Interactive radial diagram of the entire PAN system — services,
  devices, projects, memory pipeline, intelligence tier, voice pipeline.
- **Route:** `/v2/atlas`
- **File:** `service/dashboard/src/routes/atlas/+page.svelte`
- **Structure:**
  - **Center node:** ΠΑΝ Server (core hub)
  - **Ring 1 (Core):** Database, Dashboard, Steward, Tauri
  - **Ring 2 sectors (8 major systems):**
    - Services: Whisper, Ollama, AHK, Tailscale, Cloudflare Tunnel
    - Memory: Memory Hub, Episodic, Semantic, Procedural, Embeddings, Context Injection
    - Processing: Classifier (Augur), Dream, Consolidation, Evolution
    - Intelligence: Claude Code, Scout, Orchestrator, AutoDev
    - Orgs: Org Engine, Roles/ACL, Data Isolation, Per-Org DBs, Cross-Org Share
    - Presence: Webcam Watcher, Screen Watcher, Activity Tracker, Identity
    - Comms: Chat, Email, PAN Notify, Messaging Prefs
    - Devices: Connected clients (Ring 3)
  - **Ring 3:** Registered devices + active projects (with task progress bars)
  - **Voice pipeline strip:** Phone Mic → Google STT → Voice Router → Cerebras → Android TTS
- **Interactivity:** Click any node → detail panel with status, description,
  connections. 30-second auto-refresh. Live event/session/node counts in topbar.

---

## Activity Tracker

- **Purpose:** Track which app/window is in focus on the desktop PC. Primary
  activity signal for presence and intuition context.
- **File:** `service/src/activity-tracker.js`
- **How:** Polls the active foreground window every 3 seconds using Windows
  Win32 API (via PowerShell `GetForegroundWindow`). Logs focus changes to
  `activity_events` table. Tracks process name + window title + duration.
- **Platform:** Windows only. No-op on other platforms.
- **Data:** `activity_events` table — `process_name`, `window_title`,
  `focused_at`, `duration_ms`
- **Used by:** intuition.js (primary activity context), screen watcher (idle check)
- **Status endpoint:** N/A (data via `GET /dashboard/api/events?type=activity`)

---

## Organization & Multi-Tenancy System

- **Purpose:** Full multi-org isolation. Each org gets its own encrypted DB,
  ACL, roles, and scoped data access. Enables family, team, or enterprise use
  with clean data boundaries.
- **Files:** `service/src/routes/orgs.js`, `service/src/routes/teams.js`
- **Roles / Power Levels:**
  | Role | Power | Can do |
  |------|-------|--------|
  | Owner | 100 | Everything, including impersonation |
  | Admin | 75 | All ops, no impersonation |
  | Manager | 50 | Read/write, manage users |
  | User | 25 | Standard access |
  | Viewer | 0 | Read-only |
  | Guest | 0 | Temporary, scoped |
  | Child | 0–15 | Restricted content + commands |
- **Data isolation:** Every DB query is scoped by `org_id`. Helpers:
  `allScoped()`, `getScoped()`, `runScoped()` in `db.js`.
- **Per-org DBs:** Each org gets a separate SQLCipher-encrypted database file.
  Registry managed by `db-registry.js`.
- **Cross-org sharing:** Controlled share of data between orgs with explicit
  permission grants.
- **Isolation command:** `/isolate` — migrates data into org-scoped tables.
- **API:** `GET/POST /api/v1/orgs`, `GET/POST /api/v1/teams`
- **Visible in Atlas:** "Orgs" sector shows Org Engine, Roles/ACL, Data
  Isolation, Per-Org DBs, Cross-Org Share nodes.

---

## Chat & Messaging System

- **Purpose:** Thread-based messaging between the user, ΠΑΝ, and other contacts.
  Also the channel through which PAN's own services (Scout, Dream, Pipeline)
  message the user.
- **Files:** `service/src/routes/chat.js`, `service/src/chat.js`
- **Schema tables:** `chat_threads`, `chat_messages`, `chat_members`
- **Message types:** `text` | `composed` | `system`
- **Channels:**
  - `pan` — ΠΑΝ system notifications (from pan-notify.js)
  - `dm` — Direct messages between users
- **Dashboard pages:**
  - `/v2/chat` — Chat interface (direct messaging)
  - `/v2/comms` — Communications hub (all threads, ΠΑΝ thread, service messages)
  - `/v2/compose` — Compose and send messages
- **See also:** PAN Notify section (how services post into the ΠΑΛ thread)

---

## Email System

- **Purpose:** Send and receive email from within PAN.
- **File:** `service/src/routes/email.js`
- **Init:** `initEmail()` called on server boot to set up mail transport.
- **Status:** Wired into server, `initEmail()` runs — but send returns HTTP 400
  (no mail service provider configured yet). See task #394.
- **Dashboard page:** `/v2/compose` handles email composition alongside messaging.

---

## Zones & Geofencing

- **Purpose:** Define geographic zones. Actions and permissions can be scoped
  to zones (e.g. "only allow recording at home", "mute when at work").
- **File:** `service/src/routes/zones.js`
- **API:** `getActiveZones()`, `findZonesForPoint(lat, lng)`
- **Used by:** voice router (location-aware commands), privacy enforcement
- **Storage:** `zones` table — name, boundary polygon, rules JSON

---

## Incognito Sessions

- **Purpose:** Temporary isolated sessions that leave no permanent trace.
  Data written in incognito scope is invisible to main scope and purged on expiry.
- **File:** `service/src/routes/incognito.js`
- **API:** `cleanupExpiredIncognito()` — server-side cron to purge expired sessions
- **Pre-gate tested by:** Privacy Test benchmark suite (hard fail on any data leak)

---

## Personal Sync & Replication

- **Purpose:** Sync personal data between PAN instances (e.g. home PC ↔ laptop).
  Replication for backup and cross-device consistency.
- **Files:**
  - `service/src/routes/sync.js` — `startPersonalSync()`, `stopPersonalSync()`
  - `service/src/routes/replication.js` — data replication between sources
- **Status:** Wired into server boot. Configuration via settings.

---

## Kanban, Timeline & Kronos (Project Management Views)

Three additional views on top of the existing Projects page:

### Kanban (`/v2/kanban`)
- **Purpose:** Drag-and-drop kanban board for project tasks.
- **Columns:** backlog → todo → in_progress → in_test → done
- **Data:** Same `project_tasks` table as the Projects page.

### Timeline (`/v2/timeline`)
- **Purpose:** Chronological view of project work — when tasks were created,
  started, and completed. Historical record.

### Kronos (`/v2/kronos`)
- **Purpose:** Time and scheduling interface. Named after the Greek god of time.
- **Integrates with:** Google Calendar (via GWS CLI), PAN task system.

---

## Call (`/v2/call`)

- **Purpose:** Audio/video calling UI within the PAN dashboard.
- **File:** `service/dashboard/src/routes/call/+page.svelte`
- **Status:** UI built. Backend calling infrastructure pending.

---

## MCP Server — Full Tool List

The MCP server (`service/src/mcp-server.js`) exposes tools to Claude Code.

- **Where it finds PAN:** the repo's `.mcp.json` starts it (and `quality-log-mcp.js`) on
  whatever computer Claude runs on, so it names no address. `service/src/mcp/pan-address.js`
  picks one: `PAN_BASE_URL` when set; `http://127.0.0.1:7779` when this computer has a paired
  PAN Link client (`%LOCALAPPDATA%\PAN\link-client\client.json` on Windows,
  `~/.local/share/pan/link-client/client.json` on Linux); else `http://127.0.0.1:7777`, PAN on
  this computer. It prints the one it chose on stderr at start.
- **Replaces:** `PAN_BASE_URL` set to the hub's Tailscale name in `.mcp.json`, which went around
  PAN Link and stops working once the hub's 7777 listens on 127.0.0.1 only.
- **Pre-gate:** `node service/src/__tests__/pan-address.test.js` (5 tests).

### Core Tools

| Tool | What it does |
|------|-------------|
| `pan_search` | Full-text search across events, memory, conversations. Calls `GET /dashboard/api/events?q=`, which matches through the `events_fts` index (prompts, replies, voice, vision, decisions, cloud exchanges): every word as a prefix, newest first; if nothing has every word, any word ranked by bm25. Never a `data LIKE` scan, which froze the Craft for 200+ s per search on the 12 GB hub DB (2026-11-02). `type` filters by event type. |
| `pan_memory` | Read classified memory items (episodic, semantic, procedural) |
| `pan_decide` | Log an architectural decision to the DB with rationale |
| `pan_restart` | Restart the PAN server (Craft swap or Carrier restart) |
| `pan_dev` | Dev server control — status, sessions, start |
| `pan_terminal_send` | Send text to an active PTY terminal session |
| `pan_browser` | Browser control: list_tabs, navigate, click, type, screenshot |
| `pan_guardian` | Security scanning: status, decisions, scan, config |

### Router Tool (`pan`) — All Actions

Single `pan` tool dispatches to 20+ actions:

| Category | Actions |
|----------|---------|
| **Data** | conversations, projects, tasks, services, devices, stats, sessions, sensors, photos, scout |
| **Alerts** | list, count, types, get, acknowledge, resolve, dismiss, reopen |
| **Recording** | start, stop, status, list |
| **Windows** | list, open, focus, close |
| **Settings** | get, set |
| **Logs** | query, summary |
| **Runner** | projects, running, status, start, stop, stop_all, logs |
| **Library** | view |
| **Processes** | list (all PIDs) |
| **Carrier/Crucible** | status, swap, shadow_start, shadow_stop, shadow_promote, shadow_stats, crucible, open_crucible, rollback, confirm, lifeboat |
| **Voice** | profiles, pregenerate, pack |
| **Context** | briefing, inject |

### MCP Resources (pull-based)

| Resource URI | Returns |
|-------------|---------|
| `pan://actions` | Markdown table of all router actions |
| `pan://alert-types` | Alert type definitions |
| `pan://services` | Service status JSON |
| `pan://stats` | Database statistics |

---

## Terminal Sidebar — Widget Panels

The terminal page sidebar has 8 tracked widget panels:

| Panel | Purpose |
|-------|---------|
| **intuition** | Current personality context and active signals |
| **approvals** | User approvals for AutoDev code candidates |
| **alerts** | System alerts (orphan processes, service crashes, etc.) |
| **services** | Service health at a glance |
| **pipeline** | Voice/processing pipeline status |
| **devices** | Connected client devices + activity |
| **transcript** | Session message history |
| **lifeboat** | Craft swap / rollback status |

### Terminal Performance Tracking

The dashboard instruments **9 load stages** for every page load:

| Stage | Measures |
|-------|---------|
| `scriptInit` | JS bundle parsed and running |
| `mounted` | Svelte component mounted |
| `wsOpen` | WebSocket connected |
| `ptyAttached` | PTY session attached |
| `firstScreen` | First terminal screen rendered |
| `firstTranscript` | First message appears in transcript |
| `transcriptWidget` | Transcript widget fully loaded |
| `usageWidget` | Usage/cost widget loaded |
| `interactive` | Full interactive state |

### Send Latency Tracking

Every message send is instrumented with three timestamps:
- **ack** — server acknowledged the send
- **echo** — user's message echoed back in transcript
- **assistant** — first assistant token arrived

Visible in the Perf panel.

### Session Cost Tracking

The terminal tracks per-session token usage:
- Input tokens, output tokens, cache read/write tokens
- Estimated cost (based on model pricing)
- Displayed in the terminal toolbar

_Add new features at the bottom when you build them. Update this file in the
same commit as the code change._

---

## Impersonate Widget (dashboard toolbar)

- **Purpose:** Owner-only tool to temporarily preview the dashboard as a different
  power level, specific user, or org group — for testing permissions, parental controls,
  and child-profile UX without logging out.
- **Gate:** `realPower >= 100` (owner only). Requires power 80+ in future multi-owner setups.
- **Trigger:** "👁 Impersonate…" button in toolbar (only visible to owners).
  While active: yellow banner shows current impersonation label + "✕ Exit" button.

### Three impersonation modes

| Mode | API body | What changes |
|------|----------|-------------|
| **Power Level** | `{ type: 'power', power: 25 }` | Effective `power` drops to N; presets (Child/Guest/User/Manager/Admin) + slider (0–99) |
| **User** | `{ type: 'user', userId: N }` | Uses that user's `power_lvl`; banner shows their name |
| **Group** | `{ type: 'group', orgId: '...', power: N, roleName: '...' }` | Simulates membership in an org at a given role level |

### Endpoints
- `GET /api/v1/impersonate` — current state: `{ active, impersonation, realPower, presets }`
- `POST /api/v1/impersonate` — start (see modes above); 403 if not owner; power must be 0–99
- `DELETE /api/v1/impersonate` — stop; restores real power immediately
- `GET /api/v1/users` — user picker list (owner-only); returns non-owner users for the User tab
- `GET /api/v1/roles` — role list for group picker; falls back to built-in presets if roles table is empty

### Impersonation object shape (in memory + permsMatrix response)
```json
{ "type": "power|user|group", "power": 25, "label": "User",
  "userId": null, "orgId": null, "orgName": null, "roleName": null }
```

### Preserves
- Real `power` and `role` of the owner — stored in `realPower` / `role='owner'`.
- All PTY sessions, tabs, Claude processes — impersonation only affects the HTTP permission layer.
- Clears on Craft restart (in-memory only by design).

### Banner label format
- Power: `👁 User (lvl 25)`
- User: `👤 owner (lvl 15)`
- Group: `🏢 ΠΑΝ → Member (lvl 25)`

---

## Phone end-of-turn detection (Smart Turn)

Decides whether a pause means **"he's finished"** or **"he's just thinking"** — the difference between PAN answering on time and PAN cutting him off mid-sentence. Lives in the `sherpa` STT engine only.

**Files:** `android/app/src/main/java/dev/pan/app/stt/SherpaStreamingStt.kt` (the decision), `SmartTurn.kt` (the model), `WhisperLogMel.kt` (its audio features).

### How a turn ends
1. **Candidate:** sherpa's endpoint fires after `ENDPOINT_SILENCE_S` = 0.35 s of trailing silence.
2. **Judge:** [Pipecat Smart Turn v3.2](https://github.com/pipecat-ai/smart-turn) listens to the last 8 s of the current turn's audio and returns P(finished). Once per pause, keyed on when he last spoke; runs off the audio thread (AudioRecord's ~160 ms buffer would otherwise drop the words after the pause).
3. **Commit** only if P ≥ 0.5 **and** the last word is not dangling (`isTurnComplete` — "to", "because", "the"…). Otherwise hold up to `INCOMPLETE_MAX_WAIT_MS` (1.4 s), then commit anyway. Flow mode (`FLOW_SILENCE_MS`) is unchanged.

### Model
- `smart-turn-v3.2-gpu.onnx` — the **fp32** build (32,411,198 bytes; "-gpu" only means fp32, it runs on CPU). Downloaded once in the background from `huggingface.co/pipecat-ai/smart-turn-v3` into `filesDir/asr-model/`, size-verified. Until it lands, turns are judged on the word rule alone (the previous behaviour).
- **Why not the int8 build Pipecat defaults to on CPU:** on identical input features its answer moves with the runtime and the CPU's int8 kernels — "I want you to" scored 0.63 / 0.49 / 0.25 on onnxruntime 1.24 / 1.30 / 1.18. fp32 gave the same four decimals on every runtime (0.43, correctly unfinished).
- Runtime: `onnxruntime-android` 1.30.0. sherpa-onnx links its own onnxruntime statically and exposes no Java API, so it cannot run other models. +13.6 MB APK.

### Guards (all logged, none silent)
- Verdict not in within 0.35 s + `TURN_JUDGE_TIMEOUT_MS` (0.8 s) of the pause → decide on words alone.
- Inference throws → that pause is decided on words alone; it is not retried per window.
- Model fails to load → words alone for the session.

### Logs (`[STT]`, shipped by LogShipper)
`smart-turn loaded` · `smart-turn p=0.93 in 45ms` · `commit after 410ms p=0.93` · `holding, sounds unfinished p=0.12: ...move the meeting because` · `smart-turn slow (>800ms) - deciding on words alone`

### Tests
- `WhisperLogMelTest` — Kotlin features vs Pipecat's reference pipeline on five real-speech fixtures (`app/src/test/resources/smartturn/`); max |diff| ~2e-5. Always runs.
- `SmartTurnModelTest` — the real model end to end; needs `SMARTTURN_MODEL=<path to the .onnx>`, skips otherwise.
- Run `./gradlew.bat :app:testDebugUnitTest` — **not** the root `testDebugUnitTest`: `llama-lib`'s template `ExampleUnitTest` does not compile.
- Desktop test runtime is pinned to onnxruntime 1.18.0: Android Studio's JBR loads msvcp140.dll 14.29, and newer Windows ORT builds crash the JVM on it. Desktop-only.

### Pre-gate
- STT engine must be `sherpa` (`pan_stt_prefs/engine`). The Google engine owns the microphone and hands back text, so there is no audio to judge.

### Replaces
- The dangling-word rule as the **sole** decider. It stays, as a veto.

## Hub re-transcription (Parakeet)

The phone's streaming zipformer decides WHEN a turn ends; the hub decides WHAT was said.

### What it does
- On commit, `SherpaStreamingStt` keeps the whole turn's audio (up to 20 s) keyed by its text. `PanForegroundService.onSpeech` takes it (`takeTurnAudio(text)`) and `askPanStream` sends it as `audio` (16kHz PCM16 LE, base64) with the text.
- `/api/v1/query/stream` passes it to `transcribePcm16` in `service/src/hub-asr.js`: NVIDIA Parakeet TDT 0.6B v2 int8 through `sherpa-onnx-node` (optional dependency), about 0.5 s per sentence on the hub CPU. The result replaces the phone's text for routing, is logged as `[hub-asr] phone=... hub=...`, and goes back to the phone as an SSE `{type:'heard'}` event (logged `Hub heard:`).
- The model (~660 MB) loads 5 s after Craft boot with `OfflineRecognizer.createAsync`, on the libuv threadpool, logged `[hub-asr] parakeet loaded in Nms`. Decoding is `decodeAsync`. Neither runs on the main thread (the sync constructor used to freeze it for 2-3.6 s on every boot).
- Interpreting (a translate standing instruction; `interpretingFor` in router.js returns the language it names): `transcribeAnyLanguage(audio, code)` first, with the model for that language from the `SPEECH` table in hub-asr.js. Each lives in `<PAN data>/../models/<dir>/`, int8 from huggingface.co/csukuangfj, and loads the first time a language needs it (`warmForLanguage` when he gives the instruction; ~4 s on a busy hub):
  - `sensevoice`: SenseVoice-Small (sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17): ja, zh, yue, ko. Names the language it heard.
  - `parakeet3`: Parakeet TDT 0.6B v3 (sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8): 24 European languages including el. No language tag.
  - `whisper`: Whisper large-v3-turbo (sherpa-onnx-whisper-turbo): everything else, and the default when no language is named. Names the language. 8 threads and `tailPaddings: 500` (the default 1000 silent frames was 40% slower with the same words; 300 made it say the German test line twice).
  - Speed on the hub CPU (Ryzen 7 5800H, 4 threads unless noted), for 3-7 s test lines, 2026-11-03: SenseVoice 0.1-0.15 s, Parakeet v3 0.15-0.37 s, Parakeet v2 0.2-0.35 s, Whisper turbo 2.8-4.7 s by default, 1.1-2.6 s as configured. All four loaded, the Craft is ~2.35 GB.
  - A line the model heard as not English (or with no tag) is used as heard and its language goes to routeStream as `heard_lang`; English heard by SenseVoice is used as is too (6 of his 7 live lines as good as Parakeet v2, 0.2 to 0.35 s sooner); English heard by Whisper goes on to Parakeet v2 (it says short lines again and again). Logged `[hub-asr] interpreting ja: sensevoice heard ja "..."`.

### Why
- The zipformer learned English from audiobooks (LibriSpeech). On real speech it heard "what model is it using" as "what motto", "mot", "modo". Nemotron 0.6B streaming on the phone was tried and is about 7x heavier than the zipformer, too slow for the phone CPU.

### Preserves / falls back
- No package, no model in `<PAN data>/../models/parakeet-tdt-0.6b-v2-int8/`, a decode error, or a clip under 0.3 s or over 30 s: the phone's text is used exactly as before.
- A turn that arrives while the model is still loading also keeps the phone's text (it does not wait out the load).
- Turns where `stripEcho` removed any of PAN's own words are NOT sent (a fresh transcript would bring the echo back), nor are turns longer than 20 s.
- Old apps send no audio, so nothing changes for them.

## Phone mic (LIVE)

- **One switch:** the LIVE card on the main screen (`TOGGLE_MIC`) starts and stops
  listening, and this phone's own Microphone row under Sensors is the same switch
  (`MainViewModel.isOwnMic`, app 0.4.65). Before, that row was a separate permission that
  could sit off while PAN listened. Other devices' sensor rows are unchanged.
- **Unmute listens at once:** `SherpaStreamingStt` loads its recognizer while muted
  (`warmUp`) and keeps it between loops (freed only by `destroy`), and a start while a loop
  is starting or running only swaps the callback. Before, unmuting started two loops: the
  second cancelled the first just as its model had loaded, and his first words fell into
  a ~5 s gap (2026-11-03). Now 0.2 s from tap to listening.
- **The Android voice counts as PAN talking** (app 0.4.66): with Supertonic active,
  `TtsManager.isSpeaking` only asked Supertonic, so all through a Japanese reply (Android voice)
  the recogniser, which stops transcribing while PAN talks so it cannot hear itself,
  transcribed PAN's own voice. Now it includes the Android voice while it has a line, and a
  line stopped short (barge-in, mute) ends in `onStop`, which also reports PAN quiet again.
- **Words he said before PAN started are never thrown away as echo** (app 0.4.67): the
  recogniser makes no turn decisions while PAN talks, so a turn he finished just as PAN began
  was decided once PAN stopped, always inside the 300 ms post-TTS cooldown, and dropped
  ("thank you, [pause] that is very kind of you" lost its second half). `turnHeardBeforePan`
  exempts a turn whose last word came before PAN last started talking.
- **PAN waits for him to finish** (app 0.4.68): a reply's first sentence waits while the VAD
  heard him in the last 300 ms (`stillTalking`) or he has spoken since the last commit
  (`turnOpen`, app 0.4.73), at most 6 s, so a noisy room cannot keep PAN quiet. It used to start
  on top of the rest of his sentence, and what he says while PAN talks is not transcribed.
  Waiting keeps `pendingTurn`, so the rest of his sentence joins the turn (`carry_on`) and the
  reply to the first half is superseded. `turnOpen` is there for "hey pan" said on its own: the
  reply to it started on his first pause, just before the real line committed, and the line was
  dropped. Logged `reply_wait` / `reply_go`.
- **Cutting in** (app 0.4.73): 700 ms of him over PAN's own bleed stops PAN. The run ends only
  after 160 ms with nothing over the threshold (`BARGE_IN_GAP_MS`): when one quiet 32 ms window
  ended it, a real sentence took 3.3 s to stop PAN. The recogniser then gets the last 1.2 s of
  audio, so the start of what he said is not lost.

## Android self-update

PAN's Android app updates itself from the user's own PAN server — no Play Store, no manual sideload after the first install. Designed to be reusable for any future PAN-shipped Android app.

### Server side
- `GET /apk/latest` — serves `android/app/build/outputs/apk/debug/app-debug.apk` (existing).
- `GET /api/v1/apk/version` — JSON metadata read from gradle's `output-metadata.json`. sha256 is computed once and cached by mtime + size:
  ```json
  {
    "applicationId": "dev.pan.app",
    "versionCode": 3,
    "versionName": "0.4.0",
    "apkUrl": "/apk/latest",
    "apkSize": 216202946,
    "sha256": "abcd…",
    "buildTime": "2026-05-10T11:13:50Z"
  }
  ```
  Returns 404 if the APK hasn't been built yet.

### Client side (`UpdateChecker.kt`)
1. On a fresh `MainActivity.onCreate` (not a rotation), after an 8-second delay (lets Tailscale come up), call `UpdateChecker.check()` and show a toast with what it found: "Update X found, downloading…", "PAN X is up to date", or "Couldn't check for updates: …". If there is an update, call `UpdateChecker.checkAndInstall()`; a failure shows "Update failed: …".
2. GET `${baseUrl}/api/v1/apk/version` via the same Hilt `OkHttpClient` everything else uses (Tailscale-aware, falls back to LAN).
3. Bail if `applicationId != BuildConfig.APPLICATION_ID` — never let the server replace this app with a different one.
4. If `versionCode > BuildConfig.VERSION_CODE`:
   - Download to `cacheDir/updates/pan-${versionCode}.apk.part` (other versions' APKs in that dir are deleted first). Up to 3 attempts; each one resumes with a `Range` request where the last stopped (`/apk/latest` uses `res.sendFile`, which answers 206). Once the size matches, rename to `pan-${versionCode}.apk`. A finished file from an earlier try (installer dismissed) is reused.
   - Verify size + sha256 against the manifest. Mismatch → delete + abort.
   - Hand to system installer via `FileProvider` + `Intent.ACTION_VIEW` with `application/vnd.android.package-archive`.
5. The system shows "Update this app?" — user taps once, install completes, app data + signing key preserved.
6. **One check at a time.** `checkAndInstall()` runs in the singleton's own scope; a second caller (the Settings "Check for updates" button while the launch check is still downloading) waits for the running check and gets its result. Before 0.4.62 both ran at once, wrote the same file, and each one's cleanup deleted the other's half-written APK, so both said "download failed".

The Settings button (`SettingsViewModel.checkForUpdate`) runs the same two steps and reports them in the snackbar: "Update X found, downloading…", then "Installing X…" or "Update failed: …".

### Permissions
- `REQUEST_INSTALL_PACKAGES` (manifest) — required on Android 8+.
- "Install unknown apps" must be granted once for PAN under Settings → Apps → Special access → Install unknown apps. If not granted, `UpdateChecker` deep-links the user there via `ACTION_MANAGE_UNKNOWN_APP_SOURCES`.

### FileProvider
- Authority: `dev.pan.app.fileprovider` (already declared for camera photos).
- New path entry: `<cache-path name="updates" path="updates/" />` in `res/xml/file_paths.xml`.

### Pre-gate
- APK must exist at `android/app/build/outputs/apk/debug/app-debug.apk` and have a sibling `output-metadata.json`. Both produced by `./gradlew.bat assembleDebug`.

### Replaces
- Manual sideload flow (open browser → `/apk/latest` → find file → tap → install). That path still works — this is additive.

### What it doesn't do
- **Silent install.** Requires device-owner privileges that personal devices don't have. The system "Update this app?" dialog is the unavoidable Android security boundary for sideloaded APKs.
- **Rollback.** Once the user accepts the new APK, the old one is gone.
- **Staged rollouts.** Server always serves the latest built APK to every device.

### Reusing for other PAN apps
The only app-specific bits are the `applicationId` and the FileProvider authority. To ship a second PAN-managed Android app:
1. Point its `UpdateChecker` at a different version endpoint (e.g. `/api/v1/apk/<app-id>/version`) — server reads from a different gradle output dir.
2. Update the `FILE_PROVIDER_AUTHORITY` constant to match its manifest.
Everything else (Tailscale routing, sha256 verification, install flow) is generic.

## Conv-State Watcher (`service/src/conv-state-watcher.js`)

A sibling of `webcam-watcher.js` and `screen-watcher.js`, but stream-paced
instead of timer-paced. Maintains a per-org **Conversation State** doc that
the router reads on every turn so it doesn't have to think about the full
dialogue itself.

### What it tracks
Per `org_id`, a state read by rules in `intuition/conversation.js` (no model since
2026-11-03; it was a model call after every answered turn, Cerebras, then gemma4:e2b on
the hub CPU, with a summary that could say things nobody said):
- **topic** — his words that keep coming back, stemmed ("translating", "translations"
  are one), names first, a word pair when it is a name or recurs ("Eiffel Tower",
  "phrase list"). Verbs, number and time words, and opinion words are never a topic.
  PAN's words name it only when his have nothing ("how tall is it").
- **topics**, **topic_start**, **topic_shift** — a new line of his with two or more topic
  words and none in common with the topic so far (or after 10 minutes) starts a new
  one; the old one goes into `topics` (last 5, with times). Lines in another script and
  overheard lines never move it.
- **phase** — opening · discussing · deciding · command · wrapping_up · idle (idle is
  read at `getConversationState` after 5 minutes of nothing)
- **pending_question** — PAN's question when it is the last line said
- **user_pattern** — terse · verbose · self-correcting · thinking aloud · asking questions
- **likely_turn_complete** — ends in . ! ? (true), in "and", "the", a comma (false)
- **summary** — one line made of the lines themselves ("He asked PAN to set a timer…",
  "PAN asked him: …, and is waiting for his answer", "Talking about …")
- **mentioned** — names in the last lines, his and PAN's, for "it" and "that one"
- **tone** — calm · joking · heated · upset (`reader.js toneOf`)

Also exposes the last 5 finals + last 3 partials raw for debugging.

### Cadence
Not on a fixed timer. Two triggers:
1. **Each Final, at once** (well under a millisecond)
2. **Every 30s if partials arrived since last distill** (idle fallback)

Pure in-memory ring buffer (20 utterances/org). No DB writes in v1.

### What feeds it
Called via `noteUtterance({orgId, text, isFinal, source, deviceId})`:
- `POST /api/v1/voice/result` (Whisper/dictate-vad finals + partials)
- `POST /api/v1/chat` (dashboard/comms typed messages — every message = one final)

Extensible: any new STT/voice surface (phone, pendant, future devices) just
calls `noteUtterance` and gets included automatically.

### What reads it
- **Router** (`service/src/router.js`) — `buildConvStateBlock(orgId)` injects
  the distilled state into the LLM prompt right after the intuition
  situation block, and copies the structured fields into `_debug.conversation`
  so the comms popout "🧠 why" disclosure can show it.
- **Dashboard / debug** — `GET /api/v1/conversation/state?org_id=…` returns
  `{ state, buffer }`; `GET /api/v1/conversation/status` lists all active orgs.

### Why separate from intuition
Intuition is *ambient* — webcam every 30s, screen every 60s, slow-changing
facts about the user and the room. Conv-state is *utterance-paced* — updates
sub-second on Finals. Different clocks. Mechanically separate watcher,
conceptually still "what PAN knows right now."

### Pre-gate
- None for a model: there is none. A rules error keeps the previous state and is
  logged (`[conv-state] distill failed`).
- `startConvStateWatcher()` called from `server.js` boot block alongside
  `startScreenWatcher` / `startWebcamWatcher`. Safe in dev (no DB writes).

### Replaces
- Hardcoded silence-timer endpointing (mid-sentence "I'm done" failures —
  the AMBIENT-fire-during-user-still-talking bug).
- The router having to read the whole utterance history every turn — now
  pre-chewed and ready.

### Doesn't do (yet)
- **Persistence.** State lives only in RAM. Reboot = empty state. Add a
  `conversation_states` table if we want Atlas replay.
- **Hard endpointing decision.** Router still fires on every message — the
  `likely_turn_complete` field is currently advisory. The "don't fire if
  mid-sentence" gate is the next step (#NEW-conv-endpoint).
- **Cross-thread distinction.** One state per org, not per thread. Multi-
  conversation orgs will smear topics until we add `thread_id` to the slot key.
