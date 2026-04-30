# Multi-Device Routing

How PAN decides WHICH device executes a command and HOW it gets there.

---

## The Core Problem

When a user says "play a movie" from the phone, PAN needs to know:
- **Where:** Which device (hub PC, Mini PC, projector PC, phone)?
- **How:** Which app on that device (VLC, MPV, Windows Media Player)?
- **Route:** Is the device online? Can it be reached (WS or HTTP queue)?

This is the multi-device routing problem.

---

## Device Registry

All known devices are in the `devices` table:

```sql
devices (
  hostname       TEXT UNIQUE,     -- OS hostname, primary key
  name           TEXT,            -- human-readable label (e.g. "Mini PC", "TED")
  device_type    TEXT,            -- 'pc' | 'phone' | 'tablet'
  capabilities   TEXT,            -- JSON array: ["windows", "app:vlc", "app:chrome", ...]
  online         INTEGER,         -- 1 = online now, 0 = offline
  trusted        INTEGER,         -- 1 = approved, null = pending, -1 = denied
  last_seen      TEXT,            -- last heartbeat timestamp
  tailscale_hostname TEXT         -- Tailscale IP (if on VPN)
)
```

**Online detection:** `GET /api/v1/devices/active` returns devices with
`last_seen >= now - 5 minutes`. The `online` column is authoritative.

### Capabilities array

Capabilities are strings in the capabilities JSON array:
- `windows`, `linux`, `macos` — platform
- `shell_exec`, `open_app`, `open_url`, `notification` — generic actions
- `tts_speak`, `screenshot`, `media_control` — specific features
- `app:vlc`, `app:chrome`, `app:spotify`, `app:discord`, `app:obs` — detected apps
- `kvm`, `projector` — physical capabilities (set manually or via installer)

App capabilities are detected at startup by `steward.js` (checks known install paths for 9 apps)
and stored in the `devices` table for the hub itself. Client devices report their own capabilities
on registration via pan-client.

---

## Action Envelope

Every routing decision produces an **action envelope** — a structured object describing
what should happen, where, and how:

```json
{
  "actions": [
    {
      "target":      "device",          // "device" | "server" | "phone"
      "device_id":   "Minipc-Ted",      // hostname
      "device_type": "pc",
      "type":        "play_media",      // action type (see below)
      "app":         "vlc",             // specific app to use (optional)
      "args": {
        "query": "Inception",
        "url":   "...",
        "path":  "..."
      }
    }
  ],
  "intent":        "media",
  "response_text": "Playing Inception on Mini PC"
}
```

### Action types

| Type | Description |
|---|---|
| `play_media` | Play video/audio content |
| `play_music` | Music specifically (Spotify, YouTube) |
| `navigate` | Open URL or navigate to location |
| `open_app` | Launch application by name |
| `run_command` | Shell command execution |
| `tts_speak` | Text to speech on target device |
| `notification` | Push OS notification |
| `screenshot` | Capture screen |
| `terminal` | Send text to terminal session |

---

## Routing Flow

```
Phone/client sends: POST /api/v1/query
  headers: X-Device-Id: phone-pixel-10-pro
  body: { text: "play a movie on the projector" }
          ↓
router.js handleUnified()
  → Claude classifies intent: "media"
  → Extracts device hint: "projector"
          ↓
resolveActionTarget(intent, text, user_id, org_id, activeDevices)
  1. Check action_preferences table (user-level pref for this action_type)
  2. Check action_preferences table (org-level default for this action_type)
  3. If device hint in text: resolveDeviceAlias("projector") → hostname
  4. Hard-coded defaults: media → best PC with video app
  5. If still ambiguous: return needsClarification=true
          ↓
Build actions[] with resolved device_id + app
          ↓
Return to phone: { response_text, intent, actions[] }
```

---

## Preference Store

Users can set persistent preferences for how PAN routes specific action types.

```sql
action_preferences (
  user_id     TEXT,   -- user who set this pref
  org_id      TEXT,   -- org scope
  action_type TEXT,   -- 'play_media', 'play_music', 'navigate', etc.
  device_id   TEXT,   -- preferred device hostname (nullable)
  device_type TEXT,   -- 'pc' | 'phone' (nullable)
  app         TEXT,   -- preferred app (nullable)
  confidence  REAL,   -- 0-1, grows with use_count
  use_count   INTEGER -- increments each time this pref is used
  -- UNIQUE(user_id, org_id, action_type)
)
```

**Fallback chain:**
1. User-level pref → if confidence ≥ 0.5 and device online → use it
2. Org-level pref → same check
3. Hard-coded default → terminal/files → hub PC, music → phone, navigate → phone
4. Ambiguous → ask user, store pending clarification

**API:**
- `GET /api/v1/preferences` — list prefs for current user + org
- `POST /api/v1/preferences` — set/update pref
- `DELETE /api/v1/preferences/:action_type` — remove pref
- `POST /api/v1/preferences/confirm` — user confirmed an action → boost confidence to 0.8

---

## Device Aliases

Friendly names map to device hostnames:

```sql
device_aliases (
  org_id    TEXT,   -- scope
  alias     TEXT,   -- friendly name, e.g. "projector", "bedroom tv"
  device_id TEXT,   -- hostname
  -- UNIQUE(org_id, alias)
)
```

Built-in alias resolution also checks `devices.name` directly (so "Mini PC" finds
the device without needing an alias entry).

**API:**
- `GET /api/v1/preferences/aliases` — list aliases
- `POST /api/v1/preferences/aliases` — create/update alias
- `DELETE /api/v1/preferences/aliases/:alias` — remove alias

Pre-seeded aliases: `projector → tedprodesk2` (set during setup).

---

## Device Command Delivery

Once a target device is resolved, commands are delivered via two paths:

### Path 1: WebSocket (live connection)
If the device has an active WS connection in `client-manager.js`, the command is
sent immediately over that socket. Response arrives via `command_result` message.

```
Craft → client-manager.sendToClient(deviceId, type, params)
      → WS frame → pan-client.js on device
      → executes → sends command_result back
```

### Path 2: HTTP queue (offline / Cloudflare tunnel)
If no WS connection, the command is queued in `client_command_queue` table.
pan-client polls `GET /api/v1/client/poll` (compatible with Cloudflare tunnel, no WS required).

```
Craft → client_command_queue table
      → pan-client polls every 5s → picks up command → executes
      → POST /api/v1/client/result
```

### Path 3: Per-device WS push
For server-initiated commands (not responses to queries), the server can push to
a device via `/api/v1/device/push?device_id=X`. This is a separate WS channel
for devices that don't maintain a pan-client connection (e.g. phone browser).

---

## Device Installation

### Hub PC (TedGL)
Auto-registered on server startup. Detected as 'pc' with capabilities scanned by steward.
Hardware model detected via `wmic computersystem get model` for name.

### Client PCs
Install via: `irm http://<hub>/install/<token> | iex` (Windows)
or: `curl -s http://<hub>/install/<token> | bash` (Linux/Mac)

The installer:
1. Downloads `pan-client.js` from hub
2. Detects hardware model (wmic/system_profiler/DMI) for device name
3. Writes `pan-client-config.json` with hub WS address + token + name
4. Registers startup task (Windows: schtasks, Linux: systemd user service)
5. Launches `pan-client.js` — connects to hub WS and sends register message

Invited from dashboard → Devices panel → "Invite Device" button → generates
30-minute token → shows QR code + install command.

### Phone
Registers automatically via X-Device-Id header on first API call. Device type = 'phone'.
Sends capabilities on each heartbeat.

---

## What's Missing (v2 Roadmap)

| Gap | Status | Fix |
|---|---|---|
| Auto-seeding preferences from first use | Not built | On first route, store pref at low confidence (0.3), grow with use |
| Online check before routing | Partial | resolveActionTarget should check `devices.online` before committing |
| App availability check | Not built | Cross-reference action type with device's capabilities array |
| Fallback device if preferred offline | Not built | Try next device in priority list |
| Context resumption for clarifications | Not built | Store pending_intent in session, resume on next turn |
| Usage tracking (success/fail per route) | Not built | action_history table → feeds recommendation engine |

See [FEATURES.md] for the full feature registry.
