# PAN Client

The PAN Client turns any computer into a PAN-controlled device. No DB, no server — just an executor + observer that connects to the hub.

## What it is

A Tauri + Node.js process that:
1. Connects to the PAN hub via Tailscale (WebSocket, persistent)
2. Receives commands from the hub and executes them locally
3. Wraps apps via Tauri and captures all interaction data back to hub
4. Reports device state, BLE devices, smart home devices on its LAN

## User types (trust-level gated)

| Type | Runs | Sees | Examples |
|------|------|------|----------|
| Super admin | Full PAN hub | Everything | You |
| Project dev | Client + terminal access | Assigned projects, chat, tasks | Contractor, team dev |
| Regular user | Client, no terminal | Chat bot, tasks, smart home, notifications | Family, marketing |
| Customer | No client, browser only | Public page, support chat | End users |

Trust levels control what data syncs, what APIs are callable, what projects are visible.

## Client bundle

```
pan-client/               (~30-40MB installed)
  pan-client.js            Main process: WebSocket to hub, command executor
  pan-shell.exe            Tauri binary (app wrapping, webview, JS eval)
  package.json             Minimal deps: ws, node-fetch
  node_modules/            
```

Tauri is REQUIRED, not optional. It's the observation layer — without it the hub is blind to what's happening inside apps on the client machine.

## Command types (hub -> client)

| Command | Action |
|---------|--------|
| `open_app` | Launch native app by name |
| `open_url` | Open URL in default browser or Tauri webview |
| `shell_exec` | Run shell command, stream output back to hub |
| `media_control` | Play/pause/volume/next via OS media APIs |
| `display_control` | Sleep/wake monitor, brightness |
| `notification` | Show OS notification |
| `wrap_app` | Open app in Tauri with initScript data capture |
| `eval_window` | Execute JS in a wrapped window |
| `stream_receive` | Receive frames from hub for a remote app |
| `ble_scan` | Scan Bluetooth, report devices to hub |
| `smart_home` | Control Tapo/devices on local LAN |
| `screenshot` | Capture screen, send to hub |
| `file_transfer` | Download/upload file to/from hub |
| `tts_speak` | Speak text through local speakers |
| `mic_listen` | Capture mic audio, STT, send transcript to hub |

## Data flow

```
Client machine
  App opened -> Tauri wraps it -> initScript injected
    DOM changes detected -> POST to hub /api/v1/wrap/inbound
    User types message -> captured -> sent to hub
    Screenshot requested -> captured -> sent to hub
    Shell command run -> output streamed -> sent to hub
    BLE devices found -> reported to hub
    Heartbeat every 30s -> capabilities + state -> hub

  Hub sends command down via WebSocket:
    "open Discord" -> Tauri opens + wraps
    "send message to X" -> eval in wrapped window
    "what's on screen?" -> screenshot -> hub
    "run npm install" -> shell exec -> stream output

  Everything logged in hub DB as events (tagged with source_device)
```

## Hub-side additions

### New files
- `service/src/routes/client.js` — Client management API
- `service/src/client-manager.js` — Track connected clients, route commands

### New API endpoints
| Endpoint | Purpose |
|----------|---------|
| `POST /api/v1/client/register` | Client phones home on first connect |
| `GET /api/v1/client/devices` | List all connected clients |
| `POST /api/v1/client/command` | Send command to a specific client |
| `GET /api/v1/client/invite` | Generate install token + QR |
| `POST /api/v1/client/heartbeat` | Client alive check |

### DB additions (hub only)
```sql
-- Extend existing devices table
ALTER TABLE devices ADD COLUMN client_version TEXT;
ALTER TABLE devices ADD COLUMN capabilities TEXT;  -- JSON array
ALTER TABLE devices ADD COLUMN online INTEGER DEFAULT 0;

-- Smart home device registry
CREATE TABLE smart_devices (
  id INTEGER PRIMARY KEY,
  name TEXT,
  type TEXT,           -- 'plug', 'bulb', 'switch', 'sensor'
  protocol TEXT,       -- 'tapo', 'ble', 'zigbee'
  address TEXT,        -- IP or MAC
  room TEXT,
  state TEXT,          -- JSON
  discovered_by TEXT,  -- device hostname that found it
  last_seen INTEGER,
  org_id TEXT
);
```

## Smart routing (hub decides)

When a command targets a client, the hub picks the best execution strategy:

1. **App available locally?** -> Tell client to open it natively
2. **Tauri available?** -> Wrap the app on the client (captures data too)
3. **Neither?** -> Stream frames from hub to client display

## Install flow

1. Admin generates invite: `GET /api/v1/client/invite?name=bedroom`
2. On target machine, one command:
   - Windows: `irm https://100.x.x.x:7777/install/TOKEN | iex`
   - Linux: `curl -s https://100.x.x.x:7777/install/TOKEN | bash`
3. Script downloads Node.js portable + pan-client + Tauri binary
4. Registers as system service (Windows service / systemd)
5. Connects to hub, sends capabilities, hub assigns trust level
6. Device appears in admin's device list immediately

### QR onboarding (non-technical users)
1. Phone app -> "Add device"
2. Shows QR with hub address + install token
3. New computer scans QR -> browser opens install page
4. Copy one-liner or click "Download installer"
5. Client installs, auto-connects

## Build phases

| Phase | What | Depends on |
|-------|------|------------|
| 1 | `pan-client.js` — WebSocket to hub, command executor, heartbeat | Nothing |
| 2 | Hub routes (`/api/v1/client/*`) + `client-manager.js` | Phase 1 |
| 3 | Install script (Windows + Linux) + invite token system | Phase 2 |
| 4 | Smart home integration (Tapo LAN discovery + control) | Phase 2 |
| 5 | QR onboarding from phone | Phase 3 |
| 6 | Frame streaming (hub Tauri -> client display) | Phase 1 + Tauri |
