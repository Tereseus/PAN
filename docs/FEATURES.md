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
- **Also:** the PAN client WebSocket (`/ws/client`, below) checks the same headers. The
  Super-Carrier passes them on with the socket (`super-carrier.js` `linkHeaders`).
  `linkDevice(dataDir, id)` reads whether pan-link limits a device (its allow list in
  `link.json`), or that it is no longer paired.

---

## PAN client names (`/ws/client`, `service/src/client-claim.js`)

- **Calls:** `client-manager.js` (in the Carrier) on every `register` message, with
  `decideClaim()` from `client-claim.js`; the holder is kept in `devices.link_device_id`.
- **Semantics:** pan-client and the Slack client pick their own name (`device_id`), and PAN
  sends that name's commands to whoever holds it. A name belongs to the computer that first
  used it: a PAN Link device (by its key), or `local` for the hub itself. Any other computer
  gets `{ type: 'name_taken' }` and is closed after 3 s (not `denied`, which makes pan-client
  exit). A name moves only when its link device is removed from pan-link, or from `local` to
  one of the owner's own link computers (moving a PC off Tailscale). A limited link device
  can't inherit an approved name: it gets the name back as pending, and the dashboard asks
  the owner again ("<name> now connects from <computer>, which is limited"). Forged link
  headers are refused at the upgrade (403, which the Super-Carrier passes on as close code
  4403 and does not retry). Until a socket holds its name, it may only send `register`, so a
  refused socket can't send heartbeats in another computer's name or take it off line when it
  closes. Approve and Deny in the dashboard take effect on a connected client at its next
  command (the Carrier reads the database instead of the trust it had at registration).
- **Preserves:** names that already exist and nobody holds go to the first computer that
  uses them, keeping their approval (the owner's computers, at the first start with this);
  a limited computer's come back pending. Without PAN Link every name is `local`, so nothing
  changes. A restarted client from the same computer replaces its old socket.
- **Replaces:** tokens starting with `dev-`, which skipped approval for any new name (also on
  `/install/:token`), and the last socket under a name winning.
- **Pre-gate:** tests: `node service/src/__tests__/client-claim.test.js` (7) and
  `pan-link-auth.test.js` (12).

---

## PAN Link pairing codes (`/api/v1/link/*`, `service/src/routes/link.js`)

- **Calls:** pan-link's admin API on the hub (`http://127.0.0.1:7792`, or `PAN_LINK_ADMIN`)
  with the link secret from `<data dir>/link.json`: `POST /admin/pair`, `GET /admin/devices`,
  `PUT /admin/devices/{id}/allow`, `DELETE /admin/devices/{id}`, `GET /admin/status`. Mounted after the login check in
  `server.js`. The pairing page `/pair/` (`service/public/pair/index.html`, static) uses them.
- **Semantics:** `POST /api/v1/link/pair` (body `{ name?, ttl_minutes?, limited? }`, 1 to 60
  minutes, pan-link's default 10) answers `{ uri, expires, svg }`: a `pan://pair` code and the
  same as a QR (`qrcode`). `limited: true` makes a code for a limited device: pan-link lets it
  send only `LIMITED_ALLOW` (alerts and Slack messages in, Slack reply drafts, its scoped PAN
  client's WebSocket, `/health`) and answers 403 itself to everything else, so it can't read
  PAN or change it (`pan-link/allow.go`). It is for a computer someone else also controls, such
  as a work computer. `PUT /api/v1/link/devices/:id/limited` (`{ limited: true|false }`) limits
  a paired device or lifts the limit, from its next request. `GET /api/v1/link/devices` lists the paired devices,
  `DELETE /api/v1/link/devices/:id` removes one (a lost phone: it can't use the link until it
  pairs again), `GET /api/v1/link/status` is pan-link's own view (addresses, device count).
  The phone's Settings → "Pair this phone" uses `/pair` over its Tailscale connection.
  The page `/pair/` has "Show a pairing code": the QR, a countdown, "Paired: <name>" once the
  phone has used it (it watches the device list), and the paired devices, each with Remove
  and Limit / Give full access (with a confirm), limited ones marked "Limited: can only send
  alerts and messages". "Pairing a computer instead?" shows the same code as text with Copy,
  for `pan-link pair` on a PC (see `pan-link/README.md`, "A second computer"), and "Make a
  limited code". Until 2026-11-08 the page's script never ran (an apostrophe in a quoted
  string), so it stayed on "Checking PAN Link…".
- **Preserves:** no `link.json` → 503 "PAN Link is not set up on this computer", and pan-link
  is never asked. pan-link not running → 503 with the reason. Unused codes live only in
  pan-link's memory and expire. A device id that isn't letters and digits → 400, pan-link not
  asked.
- **Replaces:** running `pan-link code` on the hub by hand.
- **Pre-gate:** owner only (`req.user.role === 'owner'`, 403 otherwise): a code lets a new
  device in as the owner. A paired device is the owner, so it can make codes too; a limited
  one never reaches these routes. Tests: `node service/src/__tests__/pan-link-routes.test.js`
  (11), and `go test` in `pan-link/` for the limit itself.

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
  WireGuard's unanswered handshake when it sent one under 5 s ago). `PanVpnService` (a plain foreground service since 0.4.98, no longer an Android VPN) calls
  `LinkManager.tailscaleReady()` once its Tailscale has an address, for the same reason (once
  per start; before 0.4.97 only after it also found PAN on port 7777 over Tailscale, which a
  hub with `PAN_HOST=127.0.0.1` never answers). On a paired phone that port is only a backup:
  when nothing answers there, the service says "Connected" and stops, instead of scanning
  every Tailscale peer every 15 s. `GET /api/v1/hub-address` answers `base_url: null` to a
  caller on the link, so `HubLocator` keeps the link instead of trying the Tailscale name.
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
  fallback and the way in from outside. While the app's own Tailscale needs signing in it
  shows "Sign in to Tailscale" and a QR code of the sign-in link (for devices with no
  browser, like car head units), and while the tailnet admin still has to approve the device
  it says so (0.4.101; `TailscaleSignIn`, from `PanVpn.getStatus()` state and authUrl). The
  "PAN Server" field shows the hub found, or "Not found yet" (no hardcoded default). Link
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

## Voice situation line: place, daylight, weather (`buildSituationLine`, router.js; `intuition/place.js`)

- **What:** one line of what is going on around him, given to the voice model as background.
  Since 2026-11-11 it carries his place (this turn's GPS, else the last known place with its
  age), daylight with today's sunrise and sunset (computed from the place, no network), and the
  weather (open-meteo, refreshed in the background at most every 30 min, never awaited by a
  turn), plus what his computers show, the camera's last look, the topic, other voices nearby.
- **When:** on every voice turn the line is not empty. Setting `voice_situation`: `auto`
  (default, every turn), `off` (only on a phrase list such as "where am I", the old gate).
- **Stores:** the last GPS fix in memory and the settings row `last_phone_place`. Coordinates
  never go in the line; the place name does.
- **Known trade:** with the line, Syrinx r11 took "how's it going" as room talk on the hub bench
  (2026-11-11). Sunrise, sunset and "is it dark" now answer right.
- Design: docs/INTUITION-STATE.md v2, sections 10 to 14.

## Phone Sensors list (app main screen; `GET/PUT /api/sensors/devices/:id`)

- Each row is a permission switch for what PAN may use from that device. The phone copies the
  hub's state every 10 s.
- **Mute (the mic button) is the mic only** since app 0.4.100. It used to switch every sensor off
  and back on only from the same button, which left GPS off for days; the app puts back once
  what the old mute switched off.
- Phone and computer rows describe their own hardware (the catalog's descriptions are the
  pendant's parts).

## Accessories (app Settings > Accessories; `accessory/AccessoryHub.kt`, app 0.4.103)

- **Slots:** Glasses, Headphones, Watch, Medallion, Other. Each lists what is connected in it; a slot with nothing says so.
- **What fills them:** any Android audio device (LE Audio, Bluetooth call and media audio, hearing aids, wired and USB headsets), sorted by the Bluetooth device class (glasses, wrist watch) and then the name. Paired watches and glasses that are not audio right now show as "paired". The Medallion row is PendantBle's link state.
- **The switch on a row with a mic:** ΠAN listens and speaks through that accessory. It calls `AudioManager.setCommunicationDevice`, the route the mic (VOICE_COMMUNICATION with echo cancelling) and ΠAN's voice already use, so echo cancelling moves with it. Saved on the phone (`accessories` prefs, `voice_key`). If the accessory leaves, ΠAN goes back to the phone and says so on the screen; it moves back when the accessory returns.
- **Preserves:** off by default, so nothing changes until the switch is used. The hub only gives back a route it set itself: a phone call or the TTS loudspeaker route is never touched. The Medallion has no switch here (its mic comes over ΠAN's own link, PendantMic).
- **Not yet:** glasses camera and display (Jetpack Projected), talking through a watch (needs a Wear OS app). Untested on a real headset as of Nov 14: no test device on hand.

## Assistant button (`assist/VoiceAssistActivity.kt`, app 0.4.105)

- **What:** ΠAN answers Android's VOICE_ASSIST and ASSIST, so a car's steering wheel voice button (the owner's Joying head unit: com.car.service starts VOICE_ASSIST with no package) or any assistant button can be pointed at ΠAN. Pick ΠAN once in Android's chooser.
- **Press:** no screen. PanForegroundService gets ADDRESS_PAN: PAN stops talking, the mic opens if muted, the wake beep plays, and the next line within 20 s is sent with `addressed_now` (router.js: no room rules, `forcePan`, the reader answers whatever its first token says).
- **Preserves:** without the button nothing changes. Tested on the hub with bench lines ("[participation] assistant button - for PAN"); not yet pressed on the head unit.

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
  An exact title wins outright ("pan" is the ΠAN thread, not Mint ΠAN, which scored the
  same because machine words are no part of a name). Words after "not" rule a thread out:
  "pan, not mint pan" excludes the Mint host instead of limiting to it.
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
  2026-11-12: the warm read now opens with the situation line, as the turn's prompt does
  (`warmStudent` builds it from the same `buildSituationLine`, with the org and the phone's sensors
  from the warm request). Before, a turn with a situation line, nearly every turn, shared nothing
  with the warm read. Window titles that say nothing ("envir_utf8: 1", bare paths, shell prompts)
  are left out of the situation line (`meaningfulTitle`).
  The reader's "who is this for" token: `p_pan` (its odds for "pan") and `to_top` come back in the
  done result, so convbench can replay other thresholds offline (`evals/convbench/sweep_pan.py`).
  Bench turns (device id ending `-bench`) give that call 30 s instead of 4 s and the chain's
  first-token watch 30 s instead of 1.5 s: a bench turn arrives cold, and at 4 s 272 of 872
  convbench turns fell back to Ollama and skipped the decision being measured.
  History budget (2026-11-12, `fitHistory` in router.js): the reader's window is 4,096 tokens, and a
  long talk went over it, so the reader answered 400, the backup echoed the history without JSON and
  he heard "I didn't catch that" (15 of 20 Greek bench turns; Greek costs about twice the tokens of
  English per letter). The history now gets about 2,000 tokens and his line 700 (`estTokens`, a
  per-letter guess checked against the reader's tokenizer on 18 languages). A talk that fits goes in
  untouched; one that does not keeps its last four lines whole, shortens older lines to about 120
  tokens (keeping their ends) and drops the oldest. The warm read and the turn use the same
  `voiceHistoryBlock`, so the read ahead still matches.
  Whose voice (2026-11-12): `/query/stream` takes `wearer` (true = his voice, false = someone
  else's, from the phone's voice ID; left out when unknown). With `wearer: false` and no "PAN" in
  the line, routeStream stays quiet before any model runs (`reason: 'other_voice'`), except while
  interpreting. Why: convbench's addressed test (`evals/convbench/addressed_bench.py`, real talk in
  18 languages with lines said to PAN put in) showed PAN quiet on 98% of room talk and answering
  93% of "PAN, ..." lines, but quiet on only 47% of other people's lines right after it answered
  him, and the words alone cannot tell those from his follow-ups. The hub works `wearer` out
  itself from the turn's audio, which the phone already sends (`voice-id.js`, CAM++ zh_en, about
  30 ms a line). His profile learns by itself, no name needed (2026-11-13): every real turn's
  print goes in a pool of the last 200, and the biggest group of alike voices (at least 10 turns
  and 40% of the pool) is his, since the phone sits on him. Kept in the data dir as
  `voice-profile.json`. On the hub's 3-person recordings it found the right voice after 9 turns
  and then got 16 of 16 lines right. Where this is going: docs/INTUITION-STATE.md section 15.
  Likeness 0.5 and up = his voice, 0.25 and down = someone else's, between
  or under 1 s = unknown. Setting `voice_id_gate`: `observe` (default) only logs
  `[voice-id] likeness ...`; `on` passes the verdict to the router. `GET /api/v1/voice/profile`
  shows the state, `DELETE` starts the profile again. Hub check with real recordings of three
  people: his lines 0.63 to 0.81, the others 0.06 to 0.17. The ambient veto now also counts a
  line that starts with PAN's name (`saysPanName`), so a named line in a language without English
  question words or "?" (Thai) is answered.
- **Participation** (2026-11-13, `intuition/participation.js`, plain rules, no model, about
  0.01 ms): every turn gets PAN's place in the talk (partner, on_call, observer, interpreter),
  logged as `[participation]` and returned as `participation`. A line said to someone in the talk
  by name ("Maria, what time...", any script, names from the history's speakers) stays quiet
  before any model runs (`reason: 'named_other'`), unless it also says PAN's name or PAN is
  interpreting. A title counts as a name: "Gracias, señor Martínez.", "Κύριε Υπουργέ, ...",
  "..., Sr. Deputado." (title at the start or after a comma; not "remind me to call Dr. Smith").
  `shapeOf(text)` gives the line's size and whether it is a short question or a
  long line (CJK and Thai counted by characters / 3).
- **Turn book and nightly learner** (2026-11-13, the situational state program learning from his
  own turns; docs/INTUITION-STATE.md section 16). Every real voice turn (never a bench turn) is
  saved on the hub in `situation_turns`: the line, the history, the language, what the program
  saw (place, time since PAN spoke, whose voice, likeness, p_pan, named_other) and what PAN did
  (spoke, reason, held, the first 300 characters of the reply). The next turn labels it from what
  he did: `missed` (PAN was quiet and he said it again or called within 25 s), `quiet_ok` (the
  talk went on), `intruded` (PAN spoke and he said "not now", "shh", "σώπα"... within 15 s),
  `spoke_ok` (he followed up within 45 s). Someone else's voice never labels a turn. Kept 180
  days. The steward service `situation-learner` checks hourly and runs once a day
  (`intuition/situation-learn.js`): it tries the short question and long line sizes over a grid
  on the older 70% of labeled turns, and keeps a new setting (`situation_params`) only when it
  beats the current one by 2 points on the newest 30%, with at least 20 of them. Every try goes in
  `situation_learn_runs`. It writes the labeled turns to `situation-dataset/labeled.jsonl` in the
  data dir, the material for the next voice model round. A pass takes about 5 ms. Nothing leaves
  the hub. The rule these settings drive is in the router behind setting `situation_rules`:
  `off` (default), `bench` (bench turns only), `on`. With it on, right after PAN answered and in a
  voice not known to be someone else's, a long line stays quiet before any model runs
  (`reason: 'long_line_room'`), a bare acknowledgement ("yeah", "はいはい", "그렇지", "อือฮึ ใช่",
  `isBackchannel`) stays quiet unless PAN's last line asked him something (`reason: 'backchannel'`),
  and a short question gets the reader's lowest bar (`minPan` 0), logged as
  `[participation] long line...` / `backchannel...` / `short question...`.
- **Fixes from his Nov 14 talk** (Craft 24): (1) voice ID threw "Cannot add property print, object is not extensible" on every turn (api.js stored the print on the module namespace), so it never learned his voice; now a local. (2) The nightly benchmark (`benchmark.js callRoute`) waits until 5 min after his last real voice turn (`globalThis.__panLastVoiceAt`, set in api.js): it ran through his talk, the voice reader timed out and turns took 8 to 11 s on the Ollama fallback. (3) The long-line-for-the-room rule needs someone else in the talk (`part.others > 0`, also in `situation-learn.programSays`): alone, two lines to PAN went unanswered. (4) camera-ask.js: "what is this (right here) in front of me" / "on my desk" take a photo instead of answering from the screen.
- **Voice model round 15 live** (2026-11-14, Craft 28): `voice_student_model` = `reader:syrinx-lfm-r15:latest` (gguf sha256 e0c17dbff14e9d51, hub `pan-models/Modelfile.r15`). Trained on his Nov 14 lines; the 31b judge scored it above r12. Rollback: set the setting back to `reader:syrinx-lfm-r12:latest`, Craft swap, wait for the swap to confirm (about 30 s, or the old Craft relaunches the old model), then end the :7786 reader by PID. **PAN's name:** asked what PAN stands for, both r12 and r15 made one up ("Perceptual Anomaly Notation", "Panic Attack"); the self line now says "short for Personal AI Network", and "what does PAN stand for / mean" and "what is PAN" count as identity questions (router.js `identityAsked`), so the cloud model answers from that line.
- **Fixes from his Nov 14 morning talk, part 2** (Craft 31, app 0.4.104): (1) **3 s before every reply:** the prompt opens with the situation line, and the turn's line never matched the read ahead's (a GPS fix with the turn, the camera's age in minutes, a new topic after his words), so the reader read all ~800 tokens again each turn. The turn now reuses the line its read ahead used when under 2 min old (`warmedSituation`, router.js); his GPS fix is still recorded. Phone style bench (read ahead, then a turn with GPS): first chunk 3.16 s to 0.27 s. (2) **Old lines copied:** "I still can't tell you" at 08:41 came from the same question at 04:03. The phone starts a new talk after 30 min of quiet (`TALK_GAP_MS`, PanForegroundService) and `GET /api/v1/history` returns only the last 30 min. (3) "Do you think PAN will be successful" answered about PAN as "he": "will PAN be / PAN will be / PAN's future" count as identity questions.
- **Nightly voice report** (`service/src/voice-report.js`, steward service `voice-report`, Craft 40, Nov 14): for Claude threads, not for him. Once a day between 01:00 and 07:00 hub time, when nobody talked to PAN for 10 min, it scores yesterday's real voice turns (bench turns left out). It joins situation_turns (every turn, said or silent, with the silence reason), RouterCommand (reply, turn id), voice-timing.jsonl (hub stages and the new `path` stage) and the phone's client_logs ("[STT] commit after", "Stream (first= total=)", "Build: versionCode="). A judge (gemini flash-lite, then gemma4:e4b) scores each reply 1 to 5 and says whether each silence within a minute of PAN speaking was for PAN. Max 160 judged a day; judge output is never training data. Writes `<data>/voice-reports/YYYY-MM-DD.json` and `.md` (versions, paths, p50/p90 per stage against the last report, quality mean and share at 4 or more, by path, worst replies, missed lines, slowest first words) and one line per day in `index.jsonl`. By hand: `node src/voice-report.js [YYYY-MM-DD] [--no-judge]`.
- **Thread names said out loud** (Craft 38, Nov 14 evening): "what did the uh buy plus animation thread say" (the thread is "WOE Char Sprites Bi + Anim") got the newest ΠAN relay reply. thread-relay.js now: reads "+" as "plus" and "&" as "and" in titles; drops uh/um/er; scores words that sound alike (`soundKey`: first letter plus consonants, so "buy" = "bi") at 0.7 and a two letter title word as short for a longer spoken one ("bi" for "bipedal") at 0.6; does not count a "(fork)" copy as a rival, but same-name threads on two machines still get "Which thread?"; a named thread that matches nothing gets "I couldn't find a thread called X. The closest is Y." and never another thread's reply; "what did X say" for a thread with no relay reply (or that has worked since) reads where it is now from its transcript. Over all 183 thread titles plus real asks, 6 answers changed, all fixes.
- **Threads by number** (Craft 24, Nov 15): titles are long and odd, so nobody knows them. "List my threads" reads the five newest with numbers ("one, Mint ΠAN PowerArmor. two, ΠΑΝ ... Say a number to check on one."). For 15 min after, "thread two", "number 2", "the second one", "what's number three doing" or just "two" picks from that list; with no list read, a number counts in the order a list would be read now. A name or number said right after the list checks on that thread. "Which thread, A or B?" then "the second one" is B. A number past the list gets "I only read out 5. Which one?". "thread N" is read as a number only after a word that can't be part of a name, so "tell the PAN thread one more thing" still goes to PAN.
- **Two silences right after it** (Craft 39): (1) "can you look at thread two? ..." went to the room (`long_line_room`): the phone's history labels PAN's lines "assistant:", and participation.js counted that label as another person, so every talk had "others" and every long line after PAN answered was the room's. `assistant`, `system`, `ai` and `παν` are PAN's own labels now. (2) "But that was for you, Pand." was `named_other` ("Pand" taken for a person). `PAN_SOUND` (`pa+h?(n+d?|m)`) counts as PAN's name in namedOther and router.js saysPanName. Each turn's answering path is now in voice-timing.jsonl (stage `path`: reader, reader_retry, think, tool, self, kind, search, translate, camera, camera_short, reader_failed, cloud_fallback, full).
- **Dictating to Claude no longer mutes PAN** (Nov 15): in the car he dictated a long line to the G16 PC Stuff thread; the car mic heard it, the prompt matched (conv-state-watcher noteClaudePrompt), and PAN stayed silent for 8 min unless named, so "Hey, can you hear me?" and "What is the meaning of life?" got nothing ("JPAN" did not count as the name). Now, with the voice reader on, a line in that window goes to the voice model with a stricter bar: it answers only when its odds the line is for PAN are 0.9 or more (`CLAUDE_QUIET_MIN_PAN`, router.js; `needPan`, voice-reader.js). Lines to Claude that night scored 0.15 to 0.84, lines to PAN 0.93 to 0.99. In that window the shortcut prompts (translate, word search, live data, self, kind) are skipped, and if the reader misses its deadline the turn stays quiet (path `claude_quiet`). With the reader off, the old mute stays.
- **Car mode on the phone** (app 0.4.107, Nov 15): the phone does the work, the car is its speakers ("everyone plugs their phone in"). AccessoryHub puts a Bluetooth device whose class is car audio or hands-free in a new Car slot; while its media (A2DP) output is connected, `car` is set and the service turns on `TtsManager.carMode`: PAN speaks on the media path (USAGE_MEDIA, no call mode), so it plays through the car in full sound and never puts the car in a call, and holds AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK while talking so music ducks. The phone's own mic keeps listening. VoiceAssistActivity also takes VOICE_COMMAND, the intent Android starts when a car or headset voice button sends Bluetooth hands-free "start voice recognition", so the wheel button can open PAN on the phone (pick PAN once if Android asks). Log lines "Car mode on: <name>" / "Car mode off". Not yet tested in a real car: no echo cancelling on this path, so watch for PAN hearing itself through the car speakers. The head unit app is optional now.
- **Test bench without a car, and three fixes from it** (apps 0.4.108 to 0.4.110, Nov 15): the OnePlus Pad (Android 15, adb over wireless debugging from the G16) paired to a Bluetooth speaker; debug action `TEST_CAR --ez on true` forces car mode on any speaker. (1) **Updates**: OTA downloads stalled on the in-app tailnet and gave up after 3 tries (the hub sends 85 MB in 14 s); now up to 40 tries while each gets further, with "Download try N stopped at X of Y MB" in the hub log. (2) **Fresh install crash on Android 14+**: with no mic permission yet the service started with the manifest types (microphone) and was killed; it now starts as CONNECTED_DEVICE (allowed by the normal CHANGE_NETWORK_STATE permission) and waits instead of crashing. (3) **Mute fresh installs**: first start downloaded Piper medium and switched to it, but the Piper voices speak nothing on sherpa-onnx 2.x; it now downloads Supertonic 3 (the phone's voice) and moves anyone on low/medium/high to it (Android voice until downloaded); those three are gone from Settings. (4) **Hearing itself**: on the speaker PAN heard its own sentence and answered it. The text echo window (3 s) was timed from the start of the line at 80 ms a word; now 400 ms a word and restarted when PAN stops talking (`SttEngine.onTtsDone`), punctuation is ignored, and a short piece made only of words PAN just said ("night") is dropped too. Retest: both lines played on the media path, "echo discarded: AT NIGHT" and "TEN IN THE MORNING", no turn sent.
- **Music in the room, YAMNet** (app 0.4.112, Nov 15): `stt/MusicDetector.kt` runs YAMNet (Google, Apache 2.0, assets/yamnet.tflite, 4 MB, TFLite 2.16.1) twice a second on its own thread, so replies are not slower. The recogniser's VOICE_COMMUNICATION path suppresses noise and strips music (a song read "music 0.00, speech 0.92"), so YAMNet listens on a second raw stream (AudioSource.UNPROCESSED), falling back to the recogniser's audio if the phone refuses. Music = AudioSet Music, Singing, Rapping, Vocal music or Song at 0.3 or more; two such readings in the last 12 s make `musicPlaying()` true, so the line goes up with `media_playing` and the hub answers only lines that name PAN or follow the assistant button. Log: "Music in the room (YAMNet x)", "music started/stopped". Pad bench: lyrics from the Mint's speakers at 70% were answered before; with this every line was silent ("Ambient no-op"), and after the assistant button a question over music was answered. At 25% volume the Pad barely hears the song and the recogniser writes nothing either. Test actions: `TEST_PLAY --es path <file>` plays a song as a music app; `TOGGLE_MIC --ez on true/false` sets the mic outright. Untested on the Pixel: the second mic stream next to the call-mode one.
- **Updates download over Tailscale, not PAN Link** (app 0.4.113, hub server.js, Nov 15): Settings > Update always failed. The hub serves /apk/latest in milliseconds (85 MB in 14 to 19 s over Tailscale), but over PAN Link a bulk download stalls after about 100 to 240 KB (0.4.99 put the link first, and the phone logged "Download try 1 stopped at 0 of 85 MB: timeout"). Two fixes. Phone: `UpdateChecker` downloads from `RemoteAccessManager.getTailnetOnlyBaseUrl()` (the in-app Tailscale proxy) when it is up, and sends header `X-PAN-Keep-Url` so the `NetworkModule` interceptor leaves that one request's address alone; with no Tailscale it falls back to the old route. Hub: `/apk/latest` answers a request that came over the link (it carries `x-pan-link-secret`) with a 302 to this computer's Tailscale address `http://100.x:7777/apk/latest?direct=1`; OkHttp follows redirects after the app's interceptor, so phones already on 0.4.99 to 0.4.112 update too, as long as the phone has Tailscale. Checked through the OnePlus Pad's link: 302, then the full 90,582,600 bytes. Log: "[APK] link download sent to Tailscale". The link's own bulk stall is still open.
- **PAN Link bulk stall fixed** (pan-link on the hub + `panvpn.aar`, Nov 15): two separate bugs, one on each end. (1) **Hub:** gVisor's RACK loss detection (on by default in the link's network stack) marks a segment lost when it shares its send time with the newest acknowledged one but comes after it, the reverse of RFC 8985. Go's clock on Windows ticks coarsely, so the hub stamps whole bursts with one time and RACK resent segments that had arrived fine: about 600 needless recoveries in 20 s, the window cut to a few packets each time, with no SACK hole, drop or reordering anywhere. `pan-link/netstack/tun.go` `setTCPOptions` now uses Tailscale's settings (RACK off, Reno, buffers up to 8 MB receive and 6 MB send); test `TestBulkTransferNoSpuriousRetransmits` (16 MB back to back: 20,708 of 34,693 segments resent before, 0 after). (2) **Phone:** wireguard-go turns on UDP GRO on Android but reads the size of merged packets only when GOOS is "linux", so a burst the kernel merged arrived as one datagram, failed to decrypt and was dropped; lone packets got through, which is why small requests always worked. `pan-link/bind_android.go` turns GRO off on the link's sockets each time they open (`link.AndroidSafe`, applied in `linkmode.TailnetBind` and `link.NewDefaultBind`). Measured on the OnePlus Pad on home Wi-Fi, `/apk/latest?direct=1` (90,590,708 bytes): before, 2 to 84 KB per 20 to 90 s through the app's link; after, 19.2 s and 20.8 s on the Pad, 15.9 s from the G16 through `adb forward`; the G16's own link client 24 s. Hub exe swapped by the PAN-Link task (`pan-link.v2.exe` is the one before). The Pad runs a debug build of 0.4.115 with the new `panvpn.aar`; phones get the phone half with the next app build. The `/apk/latest` redirect to Tailscale above is no longer needed for speed.
- **PAN Link meets in the middle** (pan-link on the hub since Nov 15 10:20 ET; phone half in app 0.4.117, on the OnePlus Pad only, NOT published yet): the way in from outside for a home that lets nothing in, with no relay, no Tailscale account and nothing hosted (owner's decision, Nov 15; design and measurements in docs/INSTALL-PLAN.md, reach order 4). `pan-link/stun.go`: `STUNBind` sits in the link's socket chain on both ends, asks free public STUN servers from WireGuard's own socket (`link.STUNServers` / hub flag `--stun` replaces the list), takes the answers and punch packets out of the stream, and reports the outside IPv4 and IPv6 address and whether the network is the hard kind (different port per destination). `pan-link/punch.go`: the hub adds its outside address to its address record and pairing codes (`withOutside`, flag `--meet`, default on); a device with no direct path leaves its outside address where the hub looks (`PublishOutside`: a record on the same public relays, signed with a key made from the record secret and the device's key, sealed with the record secret) or, when some path is up (Tailscale), sends it through the tunnel (`POST /.pan-link/outside`, limited devices too); the hub (`PunchTick` every 2 s) looks for the record of each device silent for 45 s (every 5 s for 10 min, 15 s for an hour, 2 min for a day, then 10 min) and sends punch packets toward the address for 40 s, which opens the home's router and provider for exactly that device, so its next handshake gets in. Device side: `link.Meeter`, run by the phone's `linkmode` every 5 s while no direct path is up and at once after a network change (which also stops the old handshake from counting as connected). `LinkStatus` JSON gained `outside`, `hard`, `meet`. Log: hub `outside address [...]`, `meeting <name> (<id>) at <addrs>`; phone `pan-link: outside ... hard=...`, `published our outside address for the hub`. Tests: `TestMeetInTheMiddle` (both sides on networks that drop every packet from an address they have not sent to: connected about 1.3 s after both loops start, nothing before), `TestHardNetworkPublishesNothing`, `TestTellHubOutsideThroughTheTunnel`, 4 STUN tests; live (`PAN_LINK_LIVE=1`): outside address <outside IPv4>, not hard; a device record published to Pkarr's relays in 2.9 s and found by the hub in 59 ms. On the hub: outside `<outside IPv4>:39057` and its IPv6 address, record published with 6 addresses. The Pad on home Wi-Fi learned its outside address and published it before its link came up, then connected on the local path as before. NOT yet proven: a real device on a second provider getting in this way (the Pad is pattern locked, so its Wi-Fi could not be switched without the owner). To turn it off on the hub: add `--meet=false` in `start-pan-link.bat`; the exe before it is `pan-link.v3.exe`.
  - **Second round, same day** (hub exe swapped 10:39 ET, backup `pan-link.v4.exe`; app 0.4.118 code 121 on the Pad only, hub still serves 0.4.116):
    - **IPv4 only when two servers agree.** One STUN answer cannot tell an easy network from a hard one, and a test caught a hard network publishing an address after its first answer. `OutsideAddrs.Sure` is true when two servers saw the same IPv4 address and port (or only one server is set up); `AimV4()` = valid, not hard, sure; `Strings()` offers IPv4 only then. IPv6 is offered at once.
    - **PC client meets in the middle too.** `pan-link client` (`runClient` in `cmd/pan-link/main.go`) now holds one link open and runs the same `link.Meeter` every 5 s as the phone, with flags `--meet` and `--stun`. Tested with a temporary pairing on the G16: connected on the home path in 1 s; started with only the hub's outside address, it found the hub through the record and connected in 5 s. NOT rolled out: the G16, the Mint and the ProDesks still run the old client exe.
    - **Plain words for the person** (`ReachWords`, `AwayWords`, `PathOf` in `punch.go`, `TestPlainWords`). Hub `/admin/status` (and so `/api/v1/link/status`) gained `outside`, `hard`, `reach`; the pairing page (`service/public/pair/index.html`) adds `reach` to its status line. On the owner's hub: "Phones can reach this computer from outside your home on most networks, with nothing to set up." The phone's link status gained `away` (linkmode `Status`, shown by `LinkManager.kt`): "Checking this network.", "Finding a direct way to your PAN computer.", "directly, from outside your home", "through the backup route", and for a network where nothing direct is possible: "This network cannot reach your PAN computer directly. PAN works again on your home Wi-Fi or on another network." This is the message Setup's Wi-Fi-off check will show; Setup itself is not built.
  - **Third round, same day: removing a device no longer strands the others** (hub exe swapped 10:59 ET, backup `pan-link.v5.exe`; app 0.4.119 code 122). Found in the laptop client's log after a test device was removed: removal changes the hub's record secret (so the removed device cannot read where the hub is), and the first version made each device's own record from that secret. Every device that was away at that moment would have published where the hub no longer looked, and stayed locked out until it came home. Now:
    - A device's record is signed and sealed with keys made from the **pair secret**: the Diffie-Hellman result of the device's and the hub's WireGuard keys (`pairSecret`, `pairKeys` in `punch.go`). Only those two know it, and it never changes while the device is paired. `PublishOutside` and `Hub.FindDevice` use it.
    - **The hub answers.** When `PunchTick` finds a lost device's record it leaves its own current addresses in a second record made from the same pair secret (`Hub.PublishReply`; again only when they change or after 10 min). The device reads it (`FindHubReply`) when the shared record does not open or is missing, logs `the hub's addresses came from its answer to this device` once, and adds the addresses to its handshake list. So a device that was away during a removal still finds a hub whose address has changed.
    - **Pacing** (`findEvery`, `publishEvery`): a device with no path looks again 8 s after a miss for the first 3 minutes (the hub's answer takes a few seconds to appear), every 30 s otherwise, and after an hour without a path every 5 min, publishing its own address every 10 min instead of 90 s. A network change starts it over.
    - Test `TestRemovingADeviceDoesNotStrandTheOthers`: two devices paired, one removed, the phone on a strict network knowing only a dead hub address: in after 3.3 s; with the hub's answer taken out the test fails. Live on Pkarr's relays: device record up in 3.0 s, found in 57 ms; hub's answer up in 4.4 s, found in 52 ms. Full suite passes.
    - Not compatible with app 0.4.117 and 0.4.118 (they publish under the old key, the hub no longer looks there); both were on the Pad only.
  - **Rolled out, same day:** app 0.4.119 published on the hub 11:08 ET (rollback `app-debug.v119.apk` + `output-metadata.v119.json` = 0.4.116). New PC client on the G16 (11:12 ET, the SYSTEM task `PAN-Link-Client`, swapped through a Windows admin prompt, old exe kept as `pan-link.v1.exe`) and on the Mint (11:15 ET, `~/.local/bin/pan-link`, old kept as `pan-link.v1`); both answered `/health` through the link right after. The ProDesks keep the old client. The outside test device is the owner's Pixel on a second provider's Wi-Fi (the Pad could not join that network): pass = the hub's `link-endpoints.json` shows a public address for it instead of a Tailscale one.
  - **First outside run, 11:35 ET, did NOT pass, and why** (fixed in hub exe 11:45 ET, backup `pan-link.v6.exe`, and app 0.4.120 code 123, published 11:52 ET, rollback `app-debug.v122.apk` = 0.4.119): the Pixel on 0.4.119 told the hub its outside address through the tunnel and the hub punched (`meeting Pixel 10 Pro ... at [<IPv6>]:59226, <IPv4>:58248`), but the link stayed on the Tailscale path. A phone that has been on the backup route all along never reads the address record (it only looks when it has no path), so it sent its handshakes to the hub addresses it knew from long ago, not to the outside address the hub had just opened. Now the hub's answer to `POST /.pan-link/outside` carries its own current addresses (`"hub": [...]`), `TellHubOutside` returns them, and the `Meeter` adds them (log `the hub told us N new addresses of its own`, pairing saved) before it re-handshakes. Test `TestBackupRouteMovesToDirect`: phone connected through a stand-in backup route knowing only that address, both sides strict; it learns the direct address, the backup route is cut, the link carries on. PC clients updated too (G16 11:55, Mint 11:54).
  - **PASSED from outside, 12:10 ET** (owner's Pixel, app 0.4.120, on a second provider's Wi-Fi, home on Starlink behind shared IPv4): the app started at 12:09:57, came up on the Tailscale path at 12:10:01, the hub logged `meeting Pixel 10 Pro ... at [<IPv6>]:55769, <IPv4>:64397` at 12:10:05, and the phone logged `link connected, internet path <outside IPv4>:39057` at 12:10:09. The hub's `link-endpoints.json` then held `<IPv4>:64397` for it, a public address, and still did minutes later. Six `/health` requests from the phone through the link: 116 to 379 ms each, all 200. No relay, no open port, no Tailscale on that path. Not separated: whether the phone had the hub's outside address from the hub's answer or from a record lookup at start (its log said `address record: 6 addresses, 0 new`); both are in this build. Still untested: a phone on mobile data, and a hard network on either side (expected to stay on the backup route or home only).
  - **Words stop ΠAN** (app 0.4.121, code 124, on the hub 12:40 ET, rollback `app-debug.v123.apk` = 0.4.120): while ΠAN talks, a loud run of speech is read on a recognizer stream of its own; a stop word ("stop", "wait", "hold", "no"...) or two real words interrupt, "mm hmm", "yeah" and ΠAN's own words do not. voicebench on the Pad: interruption to quiet 1738 ms before, 400 to 560 ms after; all interruptions obeyed, all backchannels talked through; no self-interruption on three long lines out loud. Full write-up, limits and constants: `docs/TURN-TAKING.md`, "Row 4 built".
  - **"Yeah" and humming never stop ΠAN** (app 0.4.125, code 128, on the hub 15:10 ET, rollback `app-debug.v127.apk` = 0.4.124; the owner's call): while held, only a stop word, a word that starts like "stop" / "shut", or three real words end it. The first "stop" makes ΠAN go quiet for about a second; a second one said into that quiet ends it. One "stop" alone mostly does not, until ΠAN has its own echo cancelling. `docs/TURN-TAKING.md`, "Strict rule".
  - **"Stop" works on a real phone: hold, then decide** (app 0.4.124, code 127, on the hub 14:56 ET, rollback `app-debug.v126.apk` = 0.4.123): the owner's "stop" was ignored on the Pixel. Cause: the phone's echo canceller chews a word said over ΠAN ("stop" read as "WELL", "ONE") and the speech detector often misses it. Now any sound over ΠAN holds its voice within about 0.1 s; then a stop word, two real words, or any real word once the sound has ended stops it, and "yeah" / "mm" / nothing readable lets it carry on 0.7 s later. On the Pixel with a voice from the Mint's speakers: stop lines obeyed 19 of 24 (was 9 of 36), quiet at once on 28 to 29 of 30. Price: "yeah" over ΠAN mostly stops it on a phone. `docs/TURN-TAKING.md`, "Row 4 redone".
  - **Faster end of turn, and an optional "mm-hm"** (app 0.4.123, code 126, on the hub 13:45 ET, rollback `app-debug.v124.apk` = 0.4.121): the phone now looks for the end of his turn from 0.1 s of quiet and again every 0.2 s while it holds a turn, and flushes the recognizer while it looks. A turn it is sure about commits 270 to 350 ms after his last word (was 380 to 460). Settings > Feedback > "Mm-hm while you think" (off by default): a soft "mm-hm" in ΠAN's voice when he pauses in the middle of a long thought; it is not a line, so the turn stays open. Loudspeaker devices (tablet on a desk, car speakers): measured that reading words cannot make interruption work there, ΠAN's echo covers the person; needs echo cancelling, not built. Numbers, limits, what is untested: `docs/TURN-TAKING.md`, "Row 1 built", "The loudspeaker level gate", "Row 6".
  - **One voice for other languages** (app 0.4.120, `TtsManager.speak`; checked on the Pad: `TEST_SPEAK` with a Japanese line outside interpreting was spoken by `PiperTTS`, the built in voice): a reply in another script now goes to Supertonic in ΠAN's own voice whenever Supertonic can read that language, not only while interpreting. Before, the line that starts interpreting ("translate what I say to Japanese") was not yet marked as interpreted, so its Japanese acknowledgement came out in the Android voice (a woman's) and every later line in ΠAN's (owner heard it, Nov 15).
- **Fixes from his Nov 15 talks** (hub only, Craft 52 to 54, Nov 16; `router.js`, `intuition/reader.js`, `self.js`, `routes/api.js`, `thread-relay.js`; rollback: the `*.pre-nov16` copies beside them on the hub, then a Craft swap). All 33 of his real turns were read, then 29 of them replayed silently through the bench path before and after (`replay_turns.py` in the session scratchpad; each talk gets its own bench device, or a replayed "translate what I say" stays in force for the rest). (1) **The game in every answer:** the setting `about_him` ("he makes War of Eternity...") rode on every turn's background line, and the voice model wove it into answers on unrelated subjects. It now goes in only while a window on his screens names something in it (`buildSituationLine`, `touches`), or under the history when his own words do (`aboutHimFor`). The model still brings the game up now and then with no fact in the prompt: round 15's his_facts rows taught it, round 17 is there to undo it. (2) **Lost with the answers:** `reader.js` `lostBy` (Intuition's CONFUSED cues, widened with what he really said: "what does that have to do with...", "what are you talking about", "that has nothing to do with...", "why did you say...", plus the frustrated cues). When his line or one of his last two reads that way and ΠAN spoke in the last 3 minutes, the cloud model rereads the talk and answers (path `reread`, first word 0.6 to 0.9 s): it owns the wrong answer once and gives the right one. Replay: one run of wrong answers now gets a sound, practical answer at the first pushback, where the voice model kept inventing for six turns. (3) **"What were we just discussing?"** (`ABOUT_THIS_TALK`) no longer searches his long term notes and says "nothing on the record"; the same reread prompt answers from the talk. (4) **A dropped question:** a two-sentence "Why did you say X? What do you mean by that?" came flagged unfinished, ended in "that", went down the word search and got silence. A whole question that ends in a pronoun is not a word search (`PRONOUN_END`); "that film with the dreams inside dreams, the" still gets "Inception?". (5) **Knows it is on ΠAN Link:** the voice route passes `via_link` (the turn came through pan-link) and the self line says so; "are you working using the Pan Link system" got "I'm not, I don't use that", now "I am". (6) **"Wait, what did you just say?"** in the car (Nov 16) was read by the thread relay as a thread called "you just" ("I couldn't find a thread called you just."); a person with an adverb is never a thread name now (`thread-relay.js`, Craft 54, rollback `thread-relay.js.pre-nov16`), and the line is answered from the talk. Not a bug: "sunset 10:10" for his town was his phone's own clock (US Eastern); with no phone clock the hub uses `home_timezone` (his home zone). Still open, needs the model: first answers to knowledge questions are still made up by the 2B model until he pushes back (round 17).
- **Questions about the world go to the bigger model** (hub only, Nov 16, Craft 56; `intuition/reader.js` `asksTheWorld`, `router.js` `worldQ` / `worldPrompt` / path `world`; **ON for him since Nov 16 08:30 ET, his call** ("go ahead and turn it on"): setting `voice_world_questions` is `cloud` (every device); `bench` = benchmark devices only, anything else is off, so `bench` is the one-step way back; rollback of the code: `router.js.pre-world` and `intuition\reader.js.pre-world` on the hub, Craft swap). Why: training round 17 (below) did not teach the 2B voice model which questions it cannot answer, so the reading is done by Intuition, by the FORM of his line, not its subject: a whole question that opens with how / why / what / when / who / which, or is it / should I / do you think, three words or more. Left with the voice model: greetings and checks ("how's it going", "can you hear me"), the clock, weather and daylight, sums, his screens, his own past ("what did I say..."), requests ("can you..."), likes ("do you like..."), short reactions ("really?", "why not?"). A miss either way costs speed only: the bigger model can tell the time too. Not used for a standing instruction, a word search, a look with the camera on, a line his own notes answered, while he dictates to Claude, or when an earlier path took the turn (live data, self, reread, kind). Two ways in: while PAN is in the talk (spoke in the last 45 s) the bigger model is asked at once and also judges whether he was talking to PAN; on a cold line the voice model decides that first, and the moment it starts a spoken answer the bigger model answers instead. Tested on 70 written lines (0 wrong), on 144 of his real lines of Nov 3 to 14 (60 would go to the bigger model, many of those camera or interpreter lines that other paths take first) and by silent replay of his 29 turns of Nov 15 (`replay_world2.json`): a statistics question gets a sound range where the voice model made up a number and tied it to his game; a how-to question gets sound advice on the FIRST ask; a vague follow-up gets concrete places. **The catch, measured the same hour:** the bigger model is `gemini:gemini-3.5-flash-lite` on the free tier (`ai_fallback_chain_voice`). From 06:22 ET it missed the 2 s first-token limit on about half the calls (events `ai_fallback_attempt`, reason timeout, none on Nov 14 or 15), most likely my own test burst (a single paced call ten minutes later was back to 1.2 s); each miss waits 2 s and then the voice model answers after all (5 to 9 s on the bench). Healthy, first word was 0.6 to 1.3 s in the talk and about 2 s cold on the bench (the bench's voice model starts cold, about 0.7 s; live it is about 0.2 s). Still open now that it is on: a stall costs him 2 s and then the voice model's answer; watch `ai_fallback_attempt` timeouts on his real days. This is his own hub's setup only: the Gemini key is his developer key and cannot ship (users never see keys, nothing hosted), so for a shipped hub the bigger model has to be one that runs on the hub or the user's own Claude sign-in. Not decided.
- **The bigger model can be one on the hub: setting `voice_world_model`** (hub only, Nov 16, Craft 59; `router.js` `worldModel`, `worldPromptHub`, `worldAsk`, `plainAsReply`, `WORLD_LOCAL_MS` 4 s; rollback `router.js.pre-worldhub` on the hub, Craft swap). Why: the cloud model above is Gemini on the owner's own developer key, which cannot ship (users never see keys, nothing hosted). Values: `ollama:<model>` = that hub model answers questions about the world for every device, the cloud model and then the voice model stay behind it in the chain; `bench=ollama:<model>` = benchmark devices only (the value until Nov 16 noon); **the value now, since Nov 16 about 11:50 ET, his call ("we're not using Gemini"): `ollama:phi4-mini:3.8b`, so his real questions go to Phi on the hub and Gemini only answers if Phi has not started in 4 s. Back to Gemini: set it to `bench=ollama:phi4-mini:3.8b`**); empty = cloud as before. The hub model is asked for plain spoken words, not JSON, with every fixed word first so it is read once and kept; `plainAsReply` wraps the words as `{"to":"pan","response":...}` so the gate opens on the first word, turns `[AMBIENT]` into the ambient reply, and passes a JSON answer from a model further down the chain through untouched. Asked for JSON, phi4-mini wrapped it in a code fence and nothing was spoken until the reply was over. The test model is loaded on the first call and pinned by llm.js; unload it after a test (`keep_alive: 0`), the hub holds 5 models at most. **Model survey, Nov 16** (`F:/pan-finetune/hubmodels/`, `hubmodels.py <model>`, 30 spoken questions, world-path instructions, straight to Ollama, answers read by hand). Hub, no graphics card (Ryzen 7 5800H), first word / first sentence: phi4-mini 3.8B (MIT) 0.3 / 1.4 s, all sound; qwen3.5:4b (Apache, sees images) 1.4 / 3.6 s, best answers; granite4.2:3b (Apache) 0.3 / 1.7 s, wordy, one wrong; nemotron-3-nano:4b (NVIDIA licence) 2.9 / 4.2 s; gemma4:e2b 1.0 / 1.6 s, slips on facts; gemma4:e4b 1.6 / 2.9 s; ministral-3:3b and gemma3:4b invent scores and events; lfm2.5:8b rambles; qwen3:4b speaks its thinking. On the G16's RTX 4070 Laptop 8 GB: phi4-mini 0.06 / 0.26 s at 82 tok/s, qwen3.5:4b 0.10 / 0.42 s at 66 tok/s (3.1 GB on the card). **Through the real hub path** (silent replay of his 29 turns, `replay_phi1.json`, 6 turns went to phi4-mini, no timeouts): in the talk first word 1.9 to 2.8 s, cold 3.0 to 5.9 s (the voice model shares the CPU and the history is new text each turn; a lone question with a warm prompt was 0.4 to 0.7 s), and the answers were blander than Gemini's on the same lines (on one how-to question, a vague answer against a specific one). So on a hub with no card nothing in this size answers like the cloud model in about a second; with a laptop card qwen3.5:4b does. Not decided by the owner. Kept on the hub: phi4-mini:3.8b, qwen3.5:4b, granite4.2:3b; the rest of the test downloads were deleted.
- **Fixes from the car talk of Nov 18: hub Craft 92 (about 08:35 UTC) and app 0.5.12 (versionCode 141, published on the hub).** Four of the six faults listed under 0.5.11 below, (a) to (d). Rollback: the hub's `router.js.pre-car`, `thread-relay.js.pre-car`, `camera-ask.js.pre-car`, `routes/api.js.pre-car`, and the app pair `app-debug.v140.apk`. (1) **PAN's own voice at the head of his line** (`own-tail.js`, called in `/query/stream` after the hub's transcript is chosen). In the car the mic took the last one to three words of PAN's reply as the start of his next line, each closed by a full stop; a request that followed them no longer read as one. Five of 135 lines in three days. The hub keeps the last reply it sent to each device (`noteSaid`) and takes that tail off the head of the next line (`dropOwnTail`) when: the first words of the line are the last words of the reply, a full stop follows them, and at least two words are left. One word alone is taken only when the timing says his line began before PAN stopped or within 1.5 s (how long ago PAN stopped, minus the length of the turn's audio), and never a word he would say himself (yes, okay, right...). A line that began later is never touched. The app's own filter (`stripEcho`) is unchanged: it wants 80% of PAN's sentence back, which a tail never is. (2) **A thread named anywhere in the line** (`thread-relay.js` `namedAnywhere`). The relay forms wanted the asking at the very start of the line. In the car he asked three times in other shapes (the asking in the middle of a longer line, the thread named first, a complaint that it had not been sent); none matched, the voice model took a photo, then said it had sent the update. Now: a word that asks for something to be passed on (tell, ask, send, push, ping, forward, notify; message, update, pass, relay only as verbs) anywhere in the line, said to PAN and not about himself or the past, plus `<name> thread` where the name is a real thread's at 0.8 or better (the longest run of up to four words before the word thread that matches; a machine after it, as in `on the G16`, limits it to that machine). The whole line goes to the thread, with the last voice turns when the line points back at the talk. Replayed on 618 real heard lines of three weeks: only the car's own asks parse differently. The relay itself was never down: the G16's was polling the whole time. The Mint's relay has not been seen since Nov 16. (3) **A line about a thread is not a look** (`camera-ask.js`): the words for showing PAN a thing no longer ask for the camera when the line names a thread, a session or a conversation. (4) **Mute that mutes** (`mute-ask.js`, `router.js`, app 0.5.12). The device checks its own transcript for the mute command; in the car its ear got the words wrong five times in two days, the line went to the voice model, and it said "Got it" and muted nothing. The hub's transcript had every one right, so the hub checks too (the command is the whole last sentence of a short line, as on the device) and answers `mute: true` with no words; app 0.5.12 mutes on it. An older app says nothing for that turn. (5) **The repeated opener** (`router.js` `plainAsReply`): the round 18 hub model's "Fair point." / "Fair." / "Fair enough." is not said when an answer follows it. A stopgap until a training round caps it. Tests: `__tests__/own-tail.test.js` (9), the old reply cleanup cases plus the opener (15), 16 bench turns through the dev hub and again through the live hub. NOT seen on a device: the mute from the hub (0.5.12) and the tail removal on real car audio. Still open from that talk: (e) the ear's mishearings in the car carried into translation, no Vietnamese voice; (f) asked what should be done next, the hub model answers in general terms, because it knows nothing of the work in the Claude threads; and the hub model saying it did a thing it has no way to do, which the next training round should cover.
- **App 0.5.10 published on the hub Nov 18 about 07:37 UTC, then app 0.5.11 (versionCode 140) about 08:15 UTC (the owner: the latest goes on the hub).** 0.5.10 was the first 0.5 build the hub offered, so the car unit could leave 0.4.125 (rollback pairs on the hub: `app-debug.v128.apk` = 0.4.125, `app-debug.v139.apk` = 0.5.10, each with its `output-metadata` file). 0.5.11, from the owner's first talk in the car on 0.5: (1) the Latin letters and word meanings were missing on most Japanese lines. The hub gives a reading for every one of those lines when asked again, so the phone's single request was lost on the road (poor coverage that drive); `attachReading` now tries three times (at once, after 3 s, after 10 s) and writes a line in the shipped log when all three fail. (2) Memory on a device with no fingerprint. The car unit has no reader, so Memory cannot open there. A PIN set in the app was written for that (`ui/memory/Pin.kt`: 4 to 8 digits, salted PBKDF2 hash, rests after five wrong tries) and then SWITCHED OFF the same hour by the owner's call: a device with no fingerprint must not open Memory at all, so a shared screen (a TV, a car) can never search it. `Pin.allowed` is false everywhere and nothing in the app sets it. The code stays for one case only: the owner granting a PIN to one device from his own phone. It must never be a switch on the device itself. Its dialogs have never been seen on a screen. The addressed test after the round 18 switch (`runs\addr_20261117_r18live`): all 0.97, 0 errors, the same as before it. Seen in that car talk and NOT fixed: (a) the tuned hub model opens with "Fair" or "Fair point" again and again when he pushes back; 85 of its 3,611 training answers (2.4%) open that way, nearly all on pushback lines, so the next round must cap an opener like that; (b) the car's mic hears the end of PAN's own voice and puts it in front of his next line, which then no longer reads as an instruction (a request to interpret Cantonese was answered "I can't do that"); (c) asked to send an update to a thread with the words "look at it", the voice model took a photo and described it; (d) asked to mute, it says it has and has not; (e) the ear mishears in the car and the translator carries the wrong word over; a director's name came out as another person's in Cantonese; there is no Vietnamese voice; (f) asked what should be done next, it answers in general terms: it knows nothing of the work in the Claude threads.
- **Round 18 is LIVE, Nov 18 about 05:00 UTC, and hub Craft 91 (the owner: push it live).** Setting `voice_world_model = ollama:pan-phi-r1:latest` (back: `ollama:phi4-mini:3.8b`, which stays on the hub's disk, unloaded). The model was loaded first, so no turn waited for it. The handed-up lines test through the live path as bench devices: first word 0.4 to 1.2 s once warm, replies short and to the point. Craft 91, `self.js` `handedUpModel` (rollback `self.js.pre-handedup`): asked what it runs on, PAN named the small Gemma, because the facts line named the first model of the cloud chain; with `voice_hub_paths = all` it now names the hub model that answers ("a fine-tune of Microsoft's Phi 4 mini"). Checked on the dev copy, then live. The addressed test was run before the switch (Craft 90, plain Phi: all 0.97, 0 errors) and again after it (`runs\addr_20261117_r18live`).
- **Round 18, Nov 17 to 18: a tuned Phi 4 mini for the lines the voice model hands up (`pan-phi-r1`), trained and installed on the hub; and hub Craft 90.** Phi 4 mini answered those lines like a help desk and went quiet on lines said to it, and the prompt could not fix that, so it was tuned on PAN's manner: 580 new scenes plus the knowledge, lost, statement and identity scenes of rounds 11 to 17, each handed-up line answered by the 31b teacher in the hub's own prompt (3,810 rows), LoRA rank 16 on Phi-4-mini-instruct (MIT), two epochs, merged, GGUF Q4_K_M as the hub's own copy is. Scored on 637 held-out lines by the 31b on four marks (answers what he said, nothing false, fits the talk, sounds like a friend): all four pass 21% plain, 76% tuned; answers 49 to 93%, fits the talk 36 to 90%, friend 64 to 100%, nothing false 89 to 85% (the weak spot: on the build-on scenes 80 to 68%); quiet on a line said to it 171 to 25; help-desk lines, surveys and repeats 52 to 0. On the owner's 28 real lines of Nov 17 (never trained on): all four 29 to 61%. Same speed (same size, same quantization). Through the real hub path as bench devices (`voice_hub_paths_model = bench=ollama:pan-phi-r1:latest`, so no live turn changed): first word median 1.28 to 1.41 s against 1.30 to 1.33 s plain. Quiet check on 300 real conversation lines in the hub prompt (`quiet18.py --cb`): neither model tells talk for PAN from room talk (that is the voice model's job); the plain one is quiet by kind only (overheard questions 102 of 103, statements 8 of 133), the tuned one is quiet on 47% over all kinds against 37%, so it answers an overheard question the voice model was unsure of about half the time where the plain one almost never did, and is quieter on statements. To put it live: setting `voice_world_model = ollama:pan-phi-r1:latest` (back: `ollama:phi4-mini:3.8b`); the model is in the hub's Ollama, unloaded. Hub Craft 90 (`router.js` `plainAsReply`, rollback `router.js.pre-tidy`): a hub model's spoken reply ends at a square bracket (the tuned model once put the quiet tag after an answer, which would have been read out), and a quote mark left open at the very end is dropped; tested on chunked replies with the hub's own function, on the dev copy, then live. Cost and what went wrong: about $8.50 for a $3.55 run. The first pod had a 3.6 MB/s link, the second hit its stop time unfinished and its disk was then locked on a full machine. What changed in how rounds run: the link is tested first, every step runs on a few rows before the long run (`smoke18.sh`; it caught the GGUF step: llama.cpp's Phi converter needs the base model's own tokenizer files in the merged folder), and every finished stage is copied off the pod at once (`r18/watch18.py`). Files: `F:/pan-finetune/runs/pan-phi-r1.Q4_K_M.gguf` (sha256 c171c4013336d980), the adapter, `eval18_*.json`, `F:/pan-finetune/r18/`. Still wrong in both models: asked what model it runs on, it says the small Gemma (the facts line names the wrong one).
- **App 0.5.10 (versionCode 139) and hub Craft 88, Nov 17 about 08:45 ET (tablet only; not published): getting out of interpreting, a made-up "yeah", and the credits page.** From the owner's first real session with interpreting on the phone. (1) Hub, `router.js`: a stop line that also named the language ("stop translating <language>") did not stop it. `interpreterAck` only took a stop line with nothing else in it, the language name counted as something else, so the line was translated into Japanese as a line of its own and the phone stayed interpreting. Now the language may be in the stop line, a stop line with nothing in force answers "I'm not interpreting." (and the `interpreter` event after it ends it on a phone that still thinks it is on), and a stop line is never taken as a line to translate (`oneOffLang`). A line like "translate now to <language>" came back as the word "now" in that language: a line that is only "translate / interpret (now) to <language>" now starts interpreting (`BARE_INTERPRET_RE`, `setsStanding`); with something to translate in it ("translate that to Greek", "translate to Greek: where is the station") it stays one translation. Checked with the hub's own function on 16 lines and through the live path as a bench device (start, a line, stop, stop again). Rollback: `router.js.pre-stop`. The addressed test and the conversation bench were NOT rerun for this change (he was using the hub); they run with the round 18 check. (2) App: the "Interpreting: Japanese" badge on Home has a cross and a tap ends it (`ACTION_STOP_INTERPRETING`: off on the phone at once, then the line "Stop translating." to the hub). (3) App: a "yeah" he never said appeared in the talk and was translated. The interpreter's own ear (SenseVoice) writes "Yeah." for a breath or the tail of PAN's voice; one or two English words that the live English ear wrote nothing of are now left out (`InterpreterLoop.onCommit`, `TurnEar.onCommit` gets the live words). This is a reasoned guard, not yet seen catching one: the phone was not on the cable, so the events of his session could not be read. From now on every interpreted line, and every one left out, goes to the app's shipped log (`Interpreter ...` lines in `/api/v1/logs`) with its length and what the live ear wrote. (4) Settings, About: the version, and "Credits and licences" (`ui/settings/Credits.kt`), which opens the list of everything PAN runs on, the makers and the licences, in two groups (on your computer, on this device). It follows docs/MODEL-CREDITS.md and changes with it. Not fixed, seen in the same session: he read the Latin letters aloud with interpreting OFF, so the English ear wrote nonsense and the English voice read nonsense back (with interpreting on, his Japanese is heard as Japanese and said in English); and a request to mute inside a longer line was answered by the voice model as if it had muted, while nothing was muted (the phone only mutes on an exact phrase; the hub has no mute action).
- **App 0.5.9 (versionCode 138) and hub Craft 87, Nov 17 about 08:30 ET (tablet only, the phone was not on the cable; not published): a Japanese line shows how it is said, word by word (PRODUCT-MAP idea 14, first part).** Hub: new `service/src/reading.js` and `POST /api/v1/reading { text, lang }` -> `{ ok, romaji, words[] }`. It splits the line with kuromoji (Apache 2.0, with its IPADIC dictionary), writes each word in Latin letters (Hepburn with long marks: Tōkyō), reads numbers and about 25 counters aloud (7時 shichiji, 二人 futari), joins verb endings into one word (shite, imasu) and gives each word a short meaning: particles and endings from PAN's own notes, the rest from a meanings file made from JMdict (`<data dir>/reading/jmdict-gloss-common.json`, 22,661 common words, built by `service/scripts/build-reading-gloss.mjs`; the file is NOT in the repo and the route works without it). Measured on the hub: 0.96 s for the first line (loads the dictionaries, about 300 MB), 9 ms after; dropped again after 20 minutes without a line. Tested on dev 7781 first. Other languages answer `{ ok: false }` for now. App: any stored line with kana in it (his or PAN's, interpreted on the phone or answered by the hub) asks the hub for its reading after it is spoken (`attachReading`, `PanServerClient.reading`, `ConversationDao.setDetail`); the row's `detail` gains `romaji` and `words` (s, r, m, b, f). Home shows the Latin letters in italics under the line in the bubble, and a tap opens the words: sound, writing, meaning, and for a verb the word it is a form of. Checked on the tablet with a typed line (the row got `Konnichiwa, Tōkyō eki wa doko desu ka` and 7 words); the screen itself was NOT looked at (the tablet stays locked). Known wrong readings (kuromoji picks one reading without looking at the meaning): 市場 as shijō where ichiba is meant, 十分 always jūbun, 一日 as a date only after a month, names of people and small places; an override list in reading.js fixes about a dozen common ones (日本 Nihon, 辛い karai, 明後日 asatte) and will have to grow. Meanings are the first dictionary sense, so sometimes rough. Open: JMdict is CC BY-SA 4.0 with EDRDG's terms (selling allowed; credit on an About screen; the data file stays share-alike; it has to be rebuilt from the newest JMdict regularly), which is outside the MIT/BSD/Apache rule, so the owner decides before it ships to anyone; kuromoji's NOTICE.md has to ship with the product. Next: Chinese (pinyin-pro, MIT), Korean (es-hangul, MIT), Greek and Russian by table; Arabic and Thai have no good open reader. Rollback: hub `routes/api.js.pre-reading` and delete `src/reading.js`; the app simply shows nothing when the route is not there.
- **App 0.5.8 (versionCode 137, Nov 17 about 08:00 ET; tablet and the owner's phone by cable, not published): interpreting shows, and its lines have times.** With interpreting on, every line is translated and none is answered; he forgot it was on and wondered why two replies had no time under them. (1) Home shows a badge beside the connection line while it is on ("Interpreting: Japanese"; `stt/LiveWords.interpreting`, set in `PanForegroundService.setInterpreter` from the hub's `interpreter` event, so it appears with the first line after the app starts). (2) A line the phone translates by itself (`speakInterpreted`) is stored with the wait from the end of his speech to the line being ready, and opens to "Translated on this device". Not seen on a screen yet.
- **App 0.5.7 (versionCode 136, Nov 17 about 07:25 ET; tablet and the owner's phone by cable, not published): reply times in the talk, the address off the top.** (1) Under every ΠAN line on Home, after the clock time: how long he waited for the first word ("6:55 AM · 1.3 s"). (2) Tap a ΠAN line and it opens: first word and finish as the phone measured them; the hub's own clock (hearing him, when the model started, when the first words left); the time on the way to and from the device; which model answered and why it went there; and what ΠAN thought was going on at that moment (the one-line read). Stored with the line (`conversations.ms` and `conversations.detail`, a small JSON object; phone database version 3 with a real migration). Lines from before 0.5.7 have no times. (3) Home's top line is what he is doing (activity, focus), not where: his address sat there all day. Tested on the tablet: a silent typed line came back with `ms` and the hub's breakdown stored; the old talk survived the database update. Seen on the owner's phone: Home with "Connected", "Idle" and no address. Not seen yet: an opened line on a screen (no reply has been made on the phone since the install).
- **Hub, Nov 17 (Craft 83 to 86; `router.js`, `intuition/reader.js`, `self.js`, `voice-timing.js`, `routes/api.js`; rollback: the `*.pre-nov17b` copies beside each on the hub, copy back, Craft swap): reasons, times, and what a prompt could and could not fix.** From the owner's first real talk on the new app. (1) **Every quiet verdict says why.** The done event of a line ΠAN stays out of carries `reason`: `dictating`, `not_addressed`, `still_talking` (cut off mid sentence), next to the ones that were there (`named_other`, `other_voice`, `music_playing`, `long_line_room`, `backchannel`, `pan_own_voice`). The app shows it as the "Not for ΠAN" note. (2) **Every reply carries where its time went.** `voice-timing.js` keeps the last 200 turns' stages in memory (`turnTimings`), and `/api/v1/query/stream` puts them on the done event as `result.timing`: `asr_ms` (hearing), `setup_ms`, `first_chunk_ms` (the model's first token), `first_chunk_sent_ms` (the first words leaving the hub, from the moment his line arrived), `total_ms`, `path` and `model`. The same numbers still go to `voice-timing.jsonl`. (3) **A request to come up with something** (`reader.js asksForSomething`, by form: ask me, tell me a, give me a, say something, surprise me; not actions like music, a timer, a photo or a thread) goes up to the hub model like a question about the world, with its own rule (`ASKED`) and a hint at the end of the prompt saying who "me" is. (4) **Dictating to Claude no longer blocks the hand-up**: the voice model still has to be very sure the line is ΠAN's, and once it is, a question goes to the hub model (kept from it, the voice model made up a benchmark). (5) The hub model's fixed block has manner rules (no offers of help, no repeated sentence, a view in place of a survey), the `WORLD` rule says to build on the conversation, and the self line says which two models think, that Parakeet only listens, and the three ways ΠAN is tested. **Measured, replay of 28 of his real lines of that morning through the bench path, four times (before, and after each change; `F:\pan-finetune\r17\replay`, rows from `/dashboard/api/mem`):** the request for a question now gets a real question in all three runs after (two words of agreement before); the question about its average speed is answered from the self line in two of three. **Not fixed by any wording:** phi4-mini still offers help after small talk, still repeats a sentence that is in the talk, still answers a big question with a survey, and still mixes up the self line (it named the speech-to-text model as the model it runs on, and once answered a line about solar panels with its own earlier answer). The same rules repeated at the very end of the prompt changed nothing, and a reminder to use the self line made it talk about itself on unrelated lines; both were taken back (Craft 86). So the manner is the model's, not the prompt's: the next step is a better or a tuned hub model, not more rules. **Bench before (Craft 82):** addressed test 0.97 right over 630 lines (quiet on room talk 0.99, his talk to others after ΠAN spoke 0.91, follow-ups 0.92, the rest 1.00); English conversation bench, 300 items: accuracy 0.61, false speaking 0.25, recall 0.47, addressing 0.75, first word p50 1.46 s. **Bench after (Craft 86), same items:** addressed test 0.97 (follow-ups 0.91, one line fewer; everything else the same); English bench accuracy 0.60, false speaking 0.26, recall 0.47, addressing 0.75, first word p50 1.40 s. One item of 300 changed, so when ΠAN speaks is untouched. Runs `addr_20261117_craft86` and `cb_en_20261117_craft86` on the hub. Both bench runs load the hub: his own turns during them were slow (hearing 0.8 to 2.4 s in place of 0.3, first words 3 to 12 s).
- **App 0.5.6 (versionCode 135, Nov 17 about 06:40 ET; tablet and the owner's phone by cable, not published): "where am I" goes the normal way.** The app caught location questions by their words ("where am i", "my location", "what city"...) and sent them down the old one-shot route (`askPanWithContext`) with the GPS pasted into the text. That route asks for JSON, the hub's own model answers it in plain words, and the parse error came back as "ΠAN is having trouble thinking right now": three times in a row in the car on Nov 17. The branch is gone from `PanForegroundService.onSpeech`; the line goes down the streaming route like any other, which already carries the sensors, and the hub's situation line knows where the phone is. Tested on the tablet with a silent typed line while the conversation bench was loading the hub: first word 1.7 s, the place named, 4.2 s in all. Still on the old route: the calendar branch a few lines above it (same risk, not touched).
- **App 0.5.5 (versionCode 134, Nov 17 about 06:30 ET; tablet and the owner's phone by cable, not published): only what is used, and a note when ΠAN stays out of it.** (1) **Taken out, because nothing used them** (owner: "if we don't use it anymore, we just get rid of it"): the three Piper voices and Kokoro (`tts/PiperTtsEngine.kt` now loads Supertonic only; the class keeps its name), the 18 MB of espeak-ng data in the APK's assets (GPL, and only those voices read it), Vosk (`stt/VoskSttEngine.kt`, never wired in), and the phone's Google on-device AI (ML Kit GenAI: `ai/GeminiBrain.kt` and `ai/OnDeviceAi.kt` had no callers, `ai/NanoVision.kt` was the last resort for a picture when the hub gave no answer; it only captioned, often refused, Google blocks it for an app that is not on screen, and its terms shut out under 18s). A picture the hub cannot answer now gets the plain "could not" line. On start the app deletes the old voices' files from a device that had them (`dropOldVoiceFiles`). The voice picker (developers only) lists the Android voice and the two Supertonic versions. (2) **"Not for ΠAN" on Home.** A line ΠAN heard and stayed out of gets one small slanted grey line under it, on his side, with the reason in a few words ("you were talking to Claude", "music was playing", "sounded like you were talking to someone else"...). It is stored in the phone's talk as role `note` (`DataRepository.addNote`, drawn in `HomeScreen.TalkLine`), it is not something the model reads, and it goes when its line is joined to the next one. The reason is the hub's `reason` on the done event (`QueryResponse.reason`); an older hub that only sends `to_claude` reads as the Claude one, and no reason at all reads as plain "Not for ΠAN". A line cut off mid sentence gets no note. Tested on the tablet with the dictation signal on and a silent typed line: the hub answered "ambient" in 64 ms and the note row was stored; Supertonic 3 loaded on both devices after the old files went. Not seen on a screen yet: the tablet is locked and no such line has been said on the phone.
- **App 0.5.4 (versionCode 133, Nov 17 about 06:15 ET; tablet and the owner's phone by cable, not published): no blank lines.** A reply with no words was kept as an empty ΠAN line: a blank bubble on Home, and a blank turn of its own in the history the model reads. Now nothing is kept (`PanForegroundService`, the streaming branch), and Home skips blank lines already in the store. **Read from his first real talk on the new app (10 answered turns, 05:52 to 06:06 ET), not fixed:** (1) the hub model on the `world` path talks like a help desk and repeats itself: the same sentence about being there to assist, twice in a row, to two wordings of one question; its first word took 4.9 and 5.3 s on two of three turns (1.8 s on the third). (2) The voice model made up a fact about ΠAN itself when asked what benchmarks exist, and held to it on the follow-up. (3) Asked twice to ask him something, it said two words of agreement and asked nothing. (4) A plain "how are you" kind of line went to the `world` path. These need the conversation bench, not a guess at the prompt.
- **ΠAN stays quiet while the dictation hotkey records; a remark no longer throws a question away (Nov 17 about 05:40 ET; hub Craft 82, app 0.5.3 code 132 on the tablet and the owner's phone by cable, not published).** (1) **Hub:** `POST /api/v1/voice/dictating {on}` (owner only, `server.js`) calls `noteDictation` in `conv-state-watcher.js`. On: quiet for up to 3 minutes; off: quiet for 20 more seconds, because the phone's copy of his last sentence arrives after he stops. `dictatingToClaude()` returns `live: true` in that time, and `routeStream` then answers nothing unless he says ΠAN's name, even in the middle of an exchange (the older rule, known only after the prompt reaches Claude, lets the voice model through at 0.9 and exempts the 45 s after ΠAN spoke). Rollback `conv-state-watcher.js.pre-dict`, `router.js.pre-dict`, `server.js.pre-dict`. (2) **His computer:** `service/bin/Dictate.ahk` `TellHub(on)` posts on start and on every way out, never waiting. The hub's address is one line in `%LOCALAPPDATA%\PAN\hub-url.txt`; no file, nothing sent. **Correction the same hour:** he does not use that hotkey (Windows shows its last microphone use on Oct 10); he dictates with the Claude desktop app's own dictation. `service/scripts/mic-watch.ps1` covers that: it reads Windows capture sessions (state 1 = a program is recording) and posts the same on / off for `-Match claude`. Seen on a real dictation: on at 05:53:53, off at 05:56:18. It runs from a session for now; it is not a startup item yet. (3) **App 0.5.3:** words said while the answer to the last turn is still on its way, or has arrived and is waiting for him to stop talking, join that turn for up to 20 s (`CARRY_ON_OPEN_MS`; it was 5 s from the send, whatever the state). On Home the first piece is removed and the joined line stands in its place (`dropUserLine`). The live box shows the phone's quick guess as a sentence, not in capitals. Tested: with the signal on, a silent typed line from the tablet got no answer (0.7 s, intent ambient); 24 s after off, the next one was answered; two lines sent back to back joined into one turn and one answer covered both. Not tested with real speech: the 5 to 20 s case itself, and the hotkey's own post (first real press after the script restart at 05:30 ET).
- **App 0.5.2 (versionCode 131, built Nov 17 about 05:15 ET; on the test tablet and the owner's phone by cable, NOT published to the hub).** From the owner's first look at 0.5.1. (1) The name is written ΠAN everywhere a person reads it: screens, toasts, notifications, the pairing screens, and the app's name under its icon (`res/values/strings.xml`). (2) Settings: the "Mm-hm while you think" switch is gone and the section is called Sounds. (3) Home follows the talk: a new line scrolls into view unless he has scrolled up to read. (4) Home shows the hub's words for his line, not the phone's rough ones: when the hub's transcript arrives the line in the phone's own store is replaced (`DataRepository.correctUserLine`). (5) The drop-down notification says what Home says: "ΠAN is listening" or "ΠAN is muted"; then Connected, "No internet on this device" or "Your computer is not answering", with what he is doing; pulled down it adds the last line each way, the mood and who is there. Buttons: Mute / Unmute, Stop talking. The second notification is "ΠAN connection". (6) **Hub, Craft 81, `intuition/reader.js` (rollback `reader.js.pre-swear`):** swearing by itself is no longer a mood. "what the fuck", "fuck this", "this shit", "so much shit" are `register` cues: they count only on a line that also has a real cue of 0.4 or more ("this shit does not work" is still frustrated; "what the fuck happened to it, I just saw it" is not). His reading had sat on Frustrated, urgency High, need "a fix that works" all day from lines like that; after the swap it read Engaged. Checked with nine lines through `toneOf` / `lostBy`. **Found, not fixed:** a second line said before ΠAN answers cancels the first even when it is not a correction (his question was dropped when he made a remark to someone else right after it), and ΠAN answers what he dictates to another program at his desk ("My mistake."). Both are turn-taking work for the voice bench, not the Home box, which only shows the words.
- **App 0.5.1: three tabs (versionCode 130, built Nov 17 about 04:45 ET; on the test tablet and the owner's phone by cable, NOT published to the hub, so the car unit still has 0.4.125).** Step 3 of docs/MOBILE-APP-PLAN.md. The app's frame is now a bottom bar with Home, Memory and Settings (`ui/navigation/PanNavGraph.kt`); the old single main screen and the typed conversation screen are gone (`ui/main/MainScreen.kt` keeps only the sensor list). One `MainViewModel` for the whole app, owned by the activity. (1) **Home** (`ui/home/HomeScreen.kt`): Π and one connection line ("Connected", "No internet on this device" from Android's own validated-network check, or "Your computer is not answering"); an Incognito badge while it is on; one line for what PAN thinks is going on, tap for who is here, the mood and the topics; "Needs you" with Allow / Deny for Claude's questions and Dismiss for open alerts (`MainViewModel.approvals/alerts`, polled every 5 s); the talk from the phone's own store, his lines right, PAN's left, the day on lines that are not from today; a picture where PAN took one (kept in `files/talk-photos`, newest 60; phone database version 2 adds `conversations.photo` with a real migration, so settings survive); a box that shows his words while he says them (`stt/LiveWords.kt`, set from the speech engine's partial results, empty while PAN talks), and tapped it becomes a text field whose line goes down the same path as a spoken one (service action `TYPED_LINE`); a round mic button. (2) **Memory** (`ui/memory/`): locked by the phone's fingerprint (framework `BiometricPrompt`, biometrics only, never the PIN: `Fingerprint.kt`); it locks again when the tab is left or the app goes to the background, nothing is fetched before it opens, and deleting asks again. A device with no fingerprint set up cannot open it. Inside: search by word, a day picker with back and forward, each thing with its time on the phone's clock, delete one, delete everything a search found, delete the day. (3) **Settings** is a tab: Privacy gained "Lock Memory" (turning it off takes the fingerprint) and the per device sensor switches that were on the main screen; a Data dividend section that says it is not ready and nothing is shared; with Developer options on, buttons for the web Dashboard and the Command log. (4) **Hub, Craft 79 and 80** (`routes/dashboard.js`, `server.js`; rollback `*.pre-mem` on the hub): `GET /dashboard/api/mem?date=YYYY-MM-DD&tz=<minutes east of UTC>` (one day of talk and pictures through the created_at index; tz makes "today" the phone's day when the hub's clock is in another zone; each item carries `ms`), `GET /dashboard/api/mem?q=` (the events_fts index, only talk and pictures, test turns left out), `POST /dashboard/api/mem/forget` with `ids`, `q` or `date` plus `confirm:"yes"`: removes the events, their lines in the search index and the picture files; owner only, and `/dashboard/api/mem` now runs the login check the rest of `/dashboard` never ran. Tested on dev 7781 with seeded rows (by id, by word, by day: only talk and picture rows went, a tool event in the same list and on the same day stayed), then on the hub: one silent typed line from the tablet came back answered in 3.5 s, showed in the search, was forgotten by word, and the day went from 32 things to 31. Seen on the owner's phone: Home and Settings. Not seen: Memory past the lock (it needs his finger). Not built yet: spoken search in Memory, keeping time and timed erase, lockdown, memory answers only to his voice, names on lines when more than one person talks (the phone is not told who spoke), holding a spoken line for a correction by hand (the spoken line still goes when he stops; the box only helps for a typed one), the same Memory page on the dashboard. Forgetting does not yet remove the vector copy of a line or summaries made from it.
- **App 0.5.0 (versionCode 129, built Nov 17 about 04:06 ET; on the test tablet only, NOT published to the hub yet).** First build of the redesign in docs/MOBILE-APP-PLAN.md. (1) **Incognito survives an app restart.** The switch was only put back into the request header when the Settings screen or the Dashboard opened, so after a restart events went to the main store while the switch showed ON. It is now also kept in SharedPreferences (`ScopeHolder.set/saved`, `di/NetworkModule.kt`) and restored in `PanApplication.onCreate` before anything can send; the first start after an update reads the old value from the settings table once. Proven on the tablet: incognito on, app stopped and started, Settings never opened, one test turn: nothing in the main store; the same with incognito off: the turn is there. (2) **Hub, Craft 78:** `POST /api/v1/logs` keeps nothing from a request marked incognito (the app's log lines carry what was heard and what PAN said, and that table is in the main store); rollback `server.js.pre-inclogs`. (3) **Settings screen:** removed Voice Responses, Device Preference, Music App, Messaging App, Query Answers, the Local AI Model section and the Gemini API Key field (nothing read them, or what they said was no longer true). New switch About > Developer options (SharedPreferences `pan_ui`/`developer`, off by default) shows the PAN Server address, the Tailscale backup block, the voice picker and Stop / Force Restart. Sections are now This device, Connection, Voice, Accessories, Privacy, Personality, App Updates, About; plain words in the incognito and update texts. (4) **Sound Effects and Vibration work:** `FeedbackSounds` reads the two switches (SharedPreferences `pan_feedback`); before, sounds and vibration played whatever they said. Not seen yet: the Settings screen itself on a device (the tablet was locked).
- **Phone page cleanup, step 1 of docs/MOBILE-APP-PLAN.md (Craft 76, Nov 17 about 03:55 ET; `public/mobile/index.html`, `routes/dashboard.js`, `server.js`; rollback: the `*.pre-step1` copies on the hub, then a Craft swap).** The tabs for building PAN (Intuition, Dashboards, Usage, Tasks, Services, Projects, Data) show only when the hub setting `mobile_developer_tabs` is on; the switch is Settings > Developer > Developer tabs on the phone page. Off for a new hub, turned on for the owner's. Left for everyone: Chat, Alerts, Devices, Library, Sensors, Settings. Fixed: Services counted everything as stopped (the hub says `up`, the page looked for `running`); the Tasks tab had no route (`GET /dashboard/api/tasks`, optional `?project_id=`); Add Device said 24 hours for a code that lasts 30 minutes (and sent `ttl_hours`, which the hub does not read); a sensor switch sent the sensor's name where the route takes its id, with a bare word as a fourth argument that threw; Settings had two Devices sections, one calling every device ever seen Online, now one "Your devices" list with the Devices tab's 5 minute rule; an owner name was the page's fallback user name. `POST /api/v1/terminal/permissions/respond` now answers only for the owner (`isOwner`); with `auth_mode` none every caller is the owner, so this bites once sign-in is real. Checked on the dev copy in a phone-sized browser (tabs hide and show, Services 29 running, no console errors) and on the hub by route.
- **Fixes from the first car talk on app 0.4.125 (hub only, Craft 75, Nov 17 about 03:05 ET; `routes/api.js`, `router.js`, `self.js`; rollback: the `*.pre-stale` copies beside them on the hub, then a Craft swap).** (1) Voice turns are ordered by when the phone sent them (`sensors.timestamp`), not by when they reach the hub. On a slow link an older sentence could land after a newer one and cancel it: the real question got "Sorry, I ran into a problem" and the answer to the dropped line was spoken to nobody. An older turn that lands late is now ended as `cancelled` at once and cancels nothing (gap capped at 2 minutes, so a phone whose clock was set back is not shut out). (2) A cancelled turn says nothing: `routeStream` rethrows on an aborted signal in place of falling to the full prompt and ending on the error sentence, and raises no voice alert for it. (3) The self line (`buildSelfLine`, now also given the device id) ends with two more facts: the app version on the device he is talking through with the newest build the hub holds, and how fast replies started on the last day of the nightly voice report. Both are cached (10 minutes and 1 hour) and sit at the end of the line, behind the hub model's fixed block. Tested on the dev copy and then on the hub with bench turns: the late older turn came back cancelled in 17 ms and the newer one kept running; asked its version it said "0.4.125", asked its response time "About 3.4 seconds". Not fixed here, they need an app build: a spoken mute does nothing (the app knows only the play_music and navigate actions), the turn's sound is uploaded only after he stops talking (9 to 14 s on long sentences over a relayed 4G link), and the hub does not know a device is the car.
- **Two hub models side by side, and the hub prompt that reads only what is new (Nov 16 about 12:50 ET, Craft 72). This supersedes parts of the entry below.** The owner, an hour after the one-model switch: "4 seconds is a lot", "losing it on the long prompts is bad", "why not both". **Who does what now:** `phi4-mini:3.8b` answers every line the voice model hands up (`voice_world_model`, `voice_hub_paths = all`); `gemma4:e2b` is back on the long prompts (`ai_model`, `job_models.smart-steward`, `ai_fallback_chain_voice` = `["ollama:gemma4:e2b"]`, `ai_fallback_chain_background`, `model_selections.chat_local`), because it reads 127 to 149 tok/s and writes 21 to 22 where Phi reads 75 to 118 and writes 11 to 14. Still no cloud model in the voice chain. Both stay in memory: 14.4 GB of models, 8 GB of the hub's 29 GB free. A side effect that matters: nothing but voice lines calls Phi now, so what Phi read last time is always a voice prompt. **Gemma is not faster for the handed-up lines** (`paths_cmp.py`, 7 lines x 2 rounds, new talk each line): first word median 2.8 s against Phi's 2.4 s, right 12 of 14 against 13 of 14 (it repeated the wrong resin answer and said it runs on "the NVIDIA Parakeet model"). New setting `voice_hub_paths_model` (same values as `voice_world_model`, empty now) lets those lines use another hub model than the world questions. **Checked again on the new layout in one continuing talk (Nov 16 about 14:35 ET, `talk_cmp.py`, 9 turns x 2 rounds each; only name / who are you / what did I ask / can I pull this off switch model, Phi answers the world questions in both):** first word the same, median 1.24 to 1.26 s Gemma against 1.19 to 1.23 s Phi, so the layout works for either model. Gemma's answers were worse on those four kinds: it mixed up "I" and "you" in all 4 identity answers ("You are PAN, his personal AI", "I am a language model developed by Google DeepMind"), listed the whole talk for "what did I just ask you" both times, and had one 11.3 s first word (most likely its first read of the fixed block). Phi: 7 of 8 right. Phi keeps the handed-up lines. **The fix for the 4 s: `HUB_FIXED` + `hubPrompt(kind, middle, selfLine)`** in `router.js` (replaces `plainPrompt()`). The model keeps what it read last time as long as the next prompt starts the same. Before, each kind of line put its own rule near the top, so each kind started differently and the talk was read again. Now: one block that never changes (first line, `HUB_PRONOUNS`, all twelve rules `HUB_RULES`), then the facts about PAN (`buildSelfLine`, always), then the talk, the clock, any data, his line, and last `Kind of line: X.` with a few words for two kinds (`HUB_HINTS`). The background line (what he is doing) is left out of hub prompts. For SELF his name goes in once more just ahead of his line (`hubOwnerLine`): with the facts a block away Phi said "PAN" to "what's my name?". The fixed block is read once 25 s after the code starts (log line `hub model ... read its fixed block in N ms`, 2 to 11 s). **Measured, one continuing talk through the real hub path (`talk_test.py`, 9 turns, bench device):** old layout first word median 1.2 to 1.9 s with "what's my name" at 3.8 to 4.9 s, "who are you" 4.2 to 7.3 s, "what did I just ask" 2.7 to 4.8 s; new layout median 1.2 to 1.4 s with those three at 1.3 to 1.5 s; slowest normal turn about 2 s (one 4.8 s outlier in 5 runs). Straight to the model with nothing else on the CPU it was 0.6 s on every kind (`cache_test.py`). A brand new talk still pays for reading its first lines. All 11 lines of `paths_test.py` pass on Craft 72. Still weak: "what did I just ask you" names the wrong earlier question about 1 time in 3. The rules in `HUB_RULES` are copies of the cloud prompts' rules in plain-words form: change one, change the other. **Gemini Nano is not an answer for the hub:** it only runs inside Android (AICore) and inside Chrome, it is a tuned small Gemma (v3 on Gemma 3n, v4 on Gemma 4), so about what gemma4:e2b already is, and Chrome's own flag text says not for factual accuracy.
- **Phi 4 mini is the hub's one thinking model (Nov 16 about 12:05 ET, Craft 66; the owner: "I want to stick to one", no keys, "go ahead and do Phi").** The voice model (Syrinx) still talks; everything it hands up, and every job small Gemma had, goes to `phi4-mini:3.8b` (MIT). His hub now runs as a hub with no cloud key does. **Settings changed on the hub** (old value in brackets, this is the rollback): `ai_model` = `ollama:phi4-mini:3.8b` [`ollama:gemma4:e2b`]; `job_models` = `{"smart-steward":"ollama:phi4-mini:3.8b"}` [gemma4:e2b]; `ai_fallback_chain_voice` = `["ollama:phi4-mini:3.8b"]` [`["ollama:gemma4:e2b","gemini:gemini-3.5-flash-lite","gemini:gemini-3.1-flash-lite"]`]; `ai_fallback_chain_background` = `["ollama:phi4-mini:3.8b"]` [gemma4:e2b]; `model_selections.chat_local` = `phi4-mini:3.8b` [gemma4:e2b]; `voice_world_model` = `ollama:phi4-mini:3.8b`; new `voice_hub_paths` = `all` [absent = off]. To move every job to a better model later: those seven values, nothing in code (the photo answerer follows `ai_model` now). **Code** (hub backups `router.js.pre-phi`, `llm.js.pre-phi`, `self.js.pre-phi`, `routes/api.js.pre-phi` = Craft 59 exactly, hashes checked): `router.js` `hubPathsOn()`, `plainPrompt()`, `bigAsk()`: with `voice_hub_paths` = `all` (or `bench` = test devices only) the nine lines that went to the cloud model (reached-for word, live data, who PAN is, reread, his own chances, [THINK], camera asked twice, his name with no answer, something he told PAN) go to the hub model, asked for plain spoken words, with the rule moved to right after the first line and his own line last; chain `[hub model, ...cloudFirst()]`, 4 s to start (`WORLD_LOCAL_MS`). `plainAsReply(stream, HUB_SENTENCES)` stops the reply after 3 sentences and drops a copied `PAN:` / `You:` / `User:` label; `HUB_TEMPERATURE` 0.3 (new `temperature` option through `askAIStream` to `callOllamaStream`); `HUB_PRONOUNS` line in the hub prompts; the hub world prompt gets the self line when he asks about PAN itself; with the hub model the "statement to PAN" re-ask only fires on a line plainly told to PAN (`tellsPan`). `llm.js` `stripFence()` takes the code fence off every Ollama answer, stream and not. `routes/api.js` `photoAnswerer()` = the hub's own local model. `self.js` says moondream does images. **Why each guard exists (hub bench, `paths_test.py`, same 11 lines with the cloud model and with Phi):** Phi gave five sentences where one to three were asked; answered "Yeah I told him we would call back on Tuesday" where the cloud model said [AMBIENT]; answered a reread by repeating his question; named Inception one run and Interstellar the next; said "PAN" to "what's my name?"; said "the latest Windows 10 Pro" to "what model are you running on?" with no self line. After the guards all 11 lines pass, 4 runs. **Still weaker than the cloud model:** first word 0.3 to 4 s against 0.5 to 2.5 s; it sometimes flips "I" and "you" ("I asked you how far away the moon is"); plainer answers. **Speed on long prompts:** 1,500 new tokens on the hub CPU, phi4-mini reads 75 to 118 tok/s and writes 11 to 14; gemma4:e2b reads 127 to 149 and writes 21 to 22. So the background jobs (steward 272 a week, task-reconcile 252, consolidation 49) and the full prompt when the voice model is down (11 to 27 s on the dev copy) are slower than before. The owner chose one model knowing that. **Left alone:** `tools.js` decide and the nightly voice report judge still name `gemma4:e4b` / Gemini; `model_selections.vision`; interpreting into Japanese and Chinese on the hub now uses the hub translator only. gemma4:e2b is unloaded (hub models in memory 13.5 GB to 7 GB), still on disk. Seen in the hub log while checking: 4,166 old `[PAN Router] Unified call error` lines, the non-stream `route()` on gemma4:e2b answering in plain words (865 of them echo "rename my Downloads screenshots"), last at Craft 53: not from this change, not looked into.
- **Models page shows who answers what** (Nov 16, `service/scripts/push-pan-models.ps1`, hub backup `.pre-who`): two rows and two "Right now" lines built from `voice_world_questions`, `voice_world_model` and the first cloud model in the voice chain. The owner, Nov 16: what every model does must be written down and kept current there, so nobody has to look it up. Change a model or a route: change that script in the same go.
- **Training round 17, not shipped** (Nov 16, RunPod RTX 6000 Ada, $3.66, pod deleted; `F:\pan-finetune\r17\`, results in `runs\keep-r17.tgz`, model `runs\syrinx-lfm-r17\`). Aim: the voice model hands knowledge questions and "what are you talking about" to the bigger model itself ([THINK]) and stops bringing up his game. 470 scenes written in the recogniser's style with his real lines as examples. Result against the live r15: hand-off on its own held-out scenes 0% to 99%, on his real Nov 15 lines 0 of 18 to 7 of 18, and all 7 are pushback lines the hub's reread path already takes; none of his cold knowledge questions. A probe of 27 new questions (`probe17.py`): 5 handed off (a diet question got a confident wrong figure). So it learned the scenes' subjects, not "do I know this". Cost on the old tests: false speaking 36% to 43% (convbench), group addressing 72% to 56%, must-pass 23 to 22 of 25. The game showing up unasked did drop (4% to 2%, 2% to 1%). Kept r15 live. Lesson: a 2B model cannot be the judge of its own knowledge from a few hundred examples; the hub reads the question instead (entry above).
- **PAN does not answer its own voice** (hub only, `voice-id.js` + `routes/api.js` /query/stream, Nov 15): the phone's echo filter drops words PAN just said, but a line it misses came back as his turn. Now every turn's CAM++ voice print (already made for voice ID) is also compared with PAN's own voice, `service/src/pan-voice-print.json` (20 Supertonic 3 lines, sid 9, speed 1.2, 4 steps, the phone's main voice; more voices can be added to its `voices` list). At 0.35 or more (`PAN_SELF`, env PAN_SELF_VOICE), and not clearly his voice, and the line does not name PAN, the turn is dropped before transcription: done with intent ambient, reason `pan_own_voice`, timing stage `pan_own_voice`. Setting `pan_self_voice` = off turns it off. Log, one line per turn: `[voice-id] self 0.47 his 0.24 -> DROPPED, PAN heard itself: "..."`. Numbers: clean PAN lines 0.71 to 0.87, his 200 recent turns median 0.08 and 99th percentile 0.29; over the air on the Pad bench (Mint speakers at 70%) PAN's lines 0.23 to 0.62 and 13 of 17 dropped at 0.35, recorded people and Windows' David voice -0.00 to 0.12, none dropped. PAN's own voice is never learned into his voice profile (and is pruned from it on load), and turns from test bench devices (setting `voice_test_devices`, default `opd2403`, the OnePlus Pad) no longer teach it either: a bench run had pushed his group from 53% to 41% of the pool. Not covered yet: the Android system voice used while interpreting.
- **Nobody sees Tailscale; update progress bar** (app 0.4.114 and 0.4.115, hub `routes/tailscale-key.js`, Nov 15). The owner: average people must never sign in to Tailscale or even see it. (1) The app never opens a Tailscale sign-in on its own any more (PanVpnService, MainViewModel, SettingsViewModel); with no key it stays on PAN Link and the service notification says "PAN Link only". The Tailscale block in Settings sits under a closed "Advanced" row, and the connection line says "the backup route". (2) The hub's key handout works now: an OAuth client cannot use its id and secret as a password (Tailscale answered 404), so the route trades them for an access token first (cached until near expiry) and sends `Bearer`; setting `tailscale_tag` = `tag:pan-device` was missing (501). (3) A phone stuck on an old Tailscale login (NeedsLogin or NeedsMachineAuth) that gets a key from the hub stops Tailscale, deletes `tsnet/tailscale/tailscaled.state` and starts fresh with the key; the key is single use and cleared after. The app asks for a key only while Tailscale is not connected (each ask mints one). OnePlus Pad: joined as `pan-opd2403-1`, tagged, with no browser. (4) Settings > Check for updates shows a progress bar and "X of Y MB" while it downloads (`UpdateChecker.progress`); the Pad pulled 0.4.115 over its own Tailscale in about 20 s. Android's one-time "install unknown apps" permission still has to be granted by the person.
- **Fixes from his Nov 14 afternoon** (Craft 36 and 37, app 0.4.106): (1) **Music:** the car played rap and PAN answered the lyrics line by line. The app sends `media_playing` (AudioManager.isMusicActive, not while PAN itself talks); the hub then answers only lines that name PAN or follow the assistant button (`reason: music_playing`). (2) **Upload on 4G:** hub time per turn was ~0.8 s (hub-asr median 0.39 s + first chunk 0.36 s) but the device saw a median 2.3 s first chunk: the rest was the phone's hotspot. The turn's audio now goes up as G.711 mu-law (`audio_ulaw`, half the bytes; the hub turns it back into PCM16 in /query/stream). Parakeet heard 28 of 30 voicebench clips the same both ways (the 2 that differed were Spanish and Japanese, garbled either way).
- **Fixes from his Nov 14 car talk** (Craft 34 and 35): (1) **20 to 30 s waits and "Sorry, I ran into a problem":** in the car his long sentences came in pieces, each piece cancelled the last request and sent a new one, and the voice reader (one slot) fell behind its 4 s deadline. The fallback was the same model on Ollama with nothing read (13 to 19 s), then the full prompt on gemma4:e2b on the hub CPU (`ai_fallback_chain_voice` starts with it), so the phone gave up. Now a reader that misses its deadline hands the turn straight to the cloud model (llm.js `callReaderStream` throws; routeStream's full prompt goes cloud first when a student model is set). Not yet seen on a real stall. Tried and dropped: a smaller llama-server batch (`-b 256`) did not make cancels land sooner (2.4 s vs 3.0 s). (2) **Stale place:** at 12:02 "where am I" got one town (hours old) while the phone's fix said another, because the turn reused the read ahead's situation line. A turn whose GPS address the line does not name now builds its own, and a fix under 5 min old reads "his phone is at X" either way (intuition/place.js), so the read ahead still matches.
- **Fixes from his Nov 12 talk** (2026-11-13, Craft 20 to 23):
  - Showing it something takes a photo (`camera-ask.js` SHOWING): "if you can see it", "I'm
    trying to show it to you", "why aren't you looking at it". "Can you see the error on my
    screen" does not.
  - Setting `about_him` (now "he makes War of Eternity, a 3D game in Godot (no 2D sprites any
    more)") goes in the situation line on every turn, so a window title is not filled in by
    guessing ("working on those sprites").
  - A place before the comma is a place, not a name: "in Porto, Portugal?" was silenced as said
    to "Portugal" (`namedOther`, VOCATIVE_END; "Thanks, John." still counts).
  - "What do you think I'm looking for?" no longer goes to the kind "about his chances" prompt:
    REASSURANCE needs an outcome or a judgement of him after "you think".
  - Sun times for a named place (`tools.js` sun tool): Wikipedia summary coordinates, the
    place.js sun maths, said in his own clock. A sun question never runs the news search (it
    has no sunrise, so it said "I couldn't run the search").
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
- **Follow-up questions (2026-11-08):** in a talk (PAN spoke in the last 3 minutes,
  `FOLLOW_UP_MS`), a question that leans on the last thing he asked gets one line under the
  student's history: "(He is following up on the last thing he asked: How far is the sun from
  the earth.)" (`followUpOf` and `followUpLine` in `intuition/conversation.js`: rules, no
  model). A question leans when it brings at most one new word of its own and points back ("how
  long would it take to get there?", "who is he?") or carries on ("and Mars?", "why not
  Sydney?"); after a run of follow-ups the line also names the question that started it. "What
  time is it" and "is it going to rain" do not count. The line goes after the history, so the
  voice reader's warmed read of the history still counts. Before this, "how long would it take
  to get there?" after the sun got "I don't know where you're headed." Hub bench (8 talks,
  Syrinx r10, `bench: true`): the line fixed the sun turn and changed nothing else; "how old is
  he?" after "who is the CEO of Tesla?" still got "I don't know who 'he' is". gemma4:e2b got
  those right on the same prompts, about 1 s later to first words. Tests: `node
  service/src/__tests__/follow-up.test.js` (7).
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
  own ("Describe the dog in this image" found his dog behind the desk). A plain look ("what am
  I looking at?", `plainLook` in camera-ask.js) skips the second model: the first sentence of a
  64-token description is the answer (`spokenLook`: "The image shows X" becomes "You're looking at
  X", and a sentence about writing in the photo is kept). Descriptions are capped
  (`PLAIN_LOOK_TOKENS` 64, `LOOK_TOKENS` 120, `analyzeImage` `maxTokens`): past two sentences
  moondream only repeated itself ("paste, paste mode, paste all"). Hub timings with a new photo
  (2026-11-08): moondream reads any photo as ~750 tokens in 5.6-9 s (it resizes to 378 px, so a
  smaller photo does not help), then writes ~32 tokens a second; the old full path took 12-19 s
  (19 s live), a plain look now ~7-8 s. llava-phi3 (still `model_selections.vision`, the
  other callers' model) said "a pony in a computer image" with "Shadhavar" written over it;
  gemma4:e2b and e4b return nonsense for images on Ollama 0.40.13 (a desk photo came back "a
  brick", a black dog "reddish-brown"); qwen2.5vl:3b takes ~35 s and missed the label too.
  `spokenVision()` strips markdown and lists and turns capitals read off the photo into
  words. A follow-up within 3 minutes that points at it ("yeah, what kind of pony?") gets
  what the photo showed added to the history (`_lastLook`), but only while the photo is still
  what the talk is on (`photoInFocus` in routes/api.js: the photo was the last thing he asked,
  or his questions since lean back on it). Added under "how far is the sun from the earth", it
  made "how long would it take to get there?" about the photo (2026-11-08). `bench: true` runs the same
  looks and saves nothing. `analyzeImage` (llm.js, `model` option per call) has no cloud
  fallback: photos and what is in them never leave the mini PC.
- **Photo reader (2026-11-08, off until the `photo_reader` setting names a model):** steward
  service `photo-reader` (:7787) runs that Ollama model ("moondream:latest" on the hub) from the
  files Ollama holds, in the llama-server Ollama ships, on this machine's graphics chip through
  the Vulkan backend Ollama ships beside it (`GGML_BACKEND_PATH`, every layer on the chip).
  `service/src/photo-reader.js`. `analyzeImage` asks it first for a one-photo call to the same
  model and falls back to Ollama: nothing there or another model is one local request, a failure
  part way at most 20 s. The image marker comes from `/props` on every call (llama-server picks a
  random one at each start), and the prompt is Ollama's moondream template. Hub bench with new
  photos (Ryzen 7 5800H, AMD iGPU): 5.1 s a photo against 7.5-8.3 s in Ollama on the CPU, the
  same descriptions, 32 of 32 runs, about 1 GB more memory while it runs. The voice model got
  nothing from the same chip (it read 271 and wrote 31 tokens a second either way), so only
  photos use it. Tried and not used: SmolVLM2-500M (1.7 s on the chip with a 512 px photo, but it
  missed his dog every time, repeated itself and made up names), and `--load-mode none` (the
  server died after two photos). The runner reaper knows it by its port. Turning it on: the
  setting, then a Craft swap; Ollama's own moondream copy can then be unloaded. Tests: `node
  service/src/__tests__/photo-reader.test.js` (6).
- **Phone shortcut:** the phone takes some camera lines itself before the hub sees them
  (`camera/CameraAsk.kt`, app 0.4.99; it was `isCameraCommand` in `PanForegroundService.kt`).
  Fixed phrases ("what am i looking at", "tell me what I'm looking at", "take a photo") count
  anywhere in the line; so does asking to look or use the phone's camera ("look through the
  camera of my phone"), but not another camera ("look at the garage camera") or a complaint
  ("what I was pointing at with the camera"). "What is that / look at this" counts only when
  nothing but filler follows it (app 0.4.58), so "what is that movie called, it has to do with
  a" reaches the word search instead of "the camera is turned off". Dropped letters count as
  the word ("what am i lookin at"): on 2026-11-08 the phone's recogniser wrote that, nothing
  matched, and the hub answered from the computer's screen ("You're looking at your browser").
- **Hub check (`camera-ask.js`, same words):** the hub checks its own transcript, which is
  better, before any model: with `can_camera` a match is `done` with `camera:true` at once
  (about 150 ms on the dev copy). Before this, "what am I looking at?" went to the model with
  the computer's screen in the prompt, and "look through the camera of my phone" got "I can't
  do that. I don't have a camera feed from the phone." Tests: `node
  service/src/__tests__/camera-ask.test.js` (4) and `CameraAskTest` (9, `gradlew
  :app:testDebugUnitTest`).
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

- **MCP Apps (test, 2026-11-11):** `pan_jobs_view` (`service/src/mcp/pan-apps.js`) returns the
  Scheduled Jobs data (`/jobs.json`) as `structuredContent` and points at `ui://pan/jobs-view.html`,
  a self-contained page (the `@modelcontextprotocol/ext-apps` 1.x App bundle is inlined, no CDN)
  that draws the jobs per machine. Registered on the stdio server only, and wrapped so a failure
  never takes the core tools down. Open question: which surfaces draw it (Code tab, desktop chat,
  phone). Hosts that do not draw apps still get the one-line text summary.

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

## xiaozhi boards (`service/src/xiaozhi-server.py`)

**Parked 2026-11-13 (owner): it overlaps what already exists.** An ESP32 already talks to PAN
through the phone app (the pendant's camera and mic over Bluetooth, `ble/PendantMic.kt`), and the
phone already does the ears and the voice. This door does both again on the hub for Wi-Fi boards.
Not installed, not started by anything, not committed. Kept only as a record of the test.

A door on the hub for xiaozhi voice boards: cheap ESP32 boards with a screen, mic and speaker
running the MIT licensed xiaozhi-esp32 firmware. The steward does not start it yet; it runs by
hand while it is tested. None of PAN's own code changed: the door only calls PAN's existing routes.

- **What it is:** a Python program (aiohttp) on 127.0.0.1:7788 that speaks the board's own
  protocol: the OTA check-in (`POST /xiaozhi/ota/`), pairing (`.../activate`) and a WebSocket
  (`/xiaozhi/v1/`) with Opus audio in binary frames and JSON in text frames, protocol version 1.
  The owner's calls are on a second port, 127.0.0.1:7789, which nothing else can reach.
- **Reaching it (not built, plan changed 2026-11-13):** boards should come in the way every other
  PAN device does, over PAN Link, paired as limited devices (`pan-link/allow.go`), with nothing
  public and no new port: pan-link's one UDP port is the only way in (docs/INSTALL-PLAN.md, "PAN
  Link"). That needs WireGuard in the board's firmware (xiaozhi is MIT, so a PAN build of it), and
  PAN passing `/xiaozhi/*` on to this door. Stock firmware can only call a plain address, so a
  stock board would need a second open port on the hub or a public address. A public address
  through Tailscale Funnel was looked at and dropped the same day: every owner would have to turn
  Funnel on in their own Tailscale account, and PAN's rule is that nothing is public. The
  `--public-url` flag stays for tests behind a relay.
- **What it calls:** `/api/v1/voice/warm` when the board starts listening, so PAN's voice model
  reads the talk while he is still speaking, and `/api/v1/query/stream` with the line's draft text
  and its 16 kHz audio when the line ends. Parakeet re-hears the audio; its `heard` text goes to
  the board as `stt` before the reply starts. The reply's chunks are spoken as they arrive.
- **Ears:** the phone's 70M streaming zipformer (`sherpa-onnx-streaming-zipformer-en-2023-06-26`).
  In the board's hands-free mode it also ends a line after 0.8 s of quiet (`--end-silence`).
- **Voice:** the phone's own, Supertonic 3 int8 (speaker 9, speed 1.20, 4 steps), with the same
  quiet trim, sent as 24 kHz Opus in 60 ms frames kept about 0.36 s ahead of the board's
  playback. The next sentence is made while one plays.
- **Pairing:** an unknown board gets a six digit code on its screen ("PAN" and the code) and
  nothing else. `POST 127.0.0.1:7789/xiaozhi/admin/approve {code, name, level}` on the hub
  approves it and gives it its own token; every WebSocket must carry that token (a wrong one gets
  401). `GET .../xiaozhi/admin/boards` lists boards and waiting codes, `POST .../xiaozhi/admin/remove
  {device_id}` removes one. These live only on the owner port: on the board port they are 404, and
  the owner port refuses any request carrying a relay header (`X-Forwarded-For`, `Forwarded`,
  `Tailscale-Funnel-Request`, `CF-Connecting-IP` and the like) in case a relay is ever pointed at
  it. Strangers can ask for codes but not approve one: one sender address (from the relay's
  `X-Forwarded-For`) may start 5 new codes per 10 minutes, then gets 429, and at most 20 codes wait
  at once. The board port's `/health` says only `ok`; the owner port's `/health` has the counts.
  Boards are kept in `<PAN data>/xiaozhi/boards.json`.
- **Levels:** `owner` is one more microphone into the owner's conversation, like the phone.
  `guest` (the default) keeps its own short talk, sent as `context`, and uses the bench flag, so
  nothing it says is kept and it never reads the owner's thread.
- **Its tools:** on connect the door asks the board's MCP for its tools (`initialize`,
  `tools/list`) and keeps the list with the board. PAN can't call them yet.
- **PAN sees it as** device `xiaozhi-<MAC hex>` (`-bench` added for guests).
- **Tested 2026-11-13 on the Mint** with `service/scripts/xiaozhi-fake-board.py`, which acts as a
  board and approves its own code, against the hub's PAN in bench mode (`--bench`): pairing, a
  wrong token refused, the MCP tool list, push to talk and hands-free. Spoken at talking pace, the
  board showed PAN's words 0.24 s after the line ended and PAN's voice started 0.97 to 1.04 s
  after it. The reply audio, transcribed back, matched word for word. Sent all at once (no time to
  read ahead), the first reply took 18 s. Second round the same day, after the owner port split:
  owner calls 404 on the board port and 403 with a relay header, a sixth new code from one address
  got 429 while another address still got one, an OTA reply through a relay handed out
  `wss://<host>/xiaozhi/v1/`, and the fake board passed end to end (first sound 1.1 to 1.9 s warm,
  2.4 s on the first turn).
- **Not done:** the hub install (a venv, the two models, an opus.dll for Windows, a steward
  entry), the PAN Link path for boards (above), a real board, approving a code from the phone,
  and calling a board's tools from PAN.
