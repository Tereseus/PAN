# pan-link

PAN Link: plain WireGuard inside the program, so a phone or PC reaches PAN on the person's own computer with no Tailscale account and no system VPN driver. Design: `docs/INSTALL-PLAN.md`, section "PAN Link".

## Status (2026-11-08)

Step 1 of the install plan. Built and tested, installed on the real hub (starts at boot), and the owner's phone app uses it.

### Files

- `link.go`: starts a WireGuard device on its own network stack. Keys, peers, one tunnel address per peer (WireGuard drops packets from a key that use another address, so the tunnel address proves which device is calling). Peers can be added, removed or swapped while it runs.
- `bind.go`: a UDP socket on one address only. Tests use 127.0.0.1, so Windows never asks about the firewall.
- `pair.go`: the pairing code, `pan://pair?v=1&...` (the QR's text). It holds the hub's public key, the tunnel addresses, a one time key, the hub's addresses and the expiry.
- `state.go`: `link.json` on the hub (its key, the link secret, the paired devices) and `client.json` on a device. Saved by writing a new file and renaming it, readable by the owner only. Also `link-endpoints.json` beside `link.json`: the address each device last used, kept apart so `link.json` (which PAN reads) isn't rewritten each time a phone changes networks.
- `hub.go`: the hub side. Serves HTTP inside the tunnel on port 7777 and forwards to PAN on the computer itself. It strips any `X-PAN-Device`, `X-PAN-Device-Name` or `X-PAN-Link-Secret` a device sends, then sets the real ones. A device still holding only its one time key can finish pairing and nothing else. Unknown keys get nothing. The admin API (make a code, list or remove devices) listens on 127.0.0.1 only and needs the link secret. The program saves each device's address every 10 s and on a clean stop. After a restart the hub starts the handshake to those addresses itself, so a device that stayed connected is back in about 1 s instead of WireGuard's own wait of about 15 s.
- `client.go`: pairing (makes the device's own key and swaps it in through the tunnel), connecting, and a local port that apps on the device use to reach PAN.
- `spray.go`: every handshake start goes to all of the hub's known addresses at once, and the first address the hub answers on wins; other packets go only to that address. Dead addresses cost nothing, which matters away from home. Because every new handshake goes everywhere again, a link whose path dies (a phone leaving home Wi-Fi) moves to one that works: about 1 s after `Rehandshake`, which the app calls on a network change, or about 16 s on WireGuard's own retry. Before this, a link stayed on a dead path. WireGuard makes at most one handshake every 5 s, so when it made one less than 5 s ago that went unanswered (a phone with no network for a while, WireGuard trying into nothing), `Rehandshake` sends that same one again on every path: the hub never saw it, so it accepts it, and the link is back in milliseconds instead of after WireGuard's wait. Copies for the hub's Tailscale addresses go `TailnetDelay` (150 ms) after the others, so a direct path (home Wi-Fi, an open router port) wins whenever it works and the link doesn't depend on Tailscale at home; Tailscale wins only when nothing else answers. It also stops "port unreachable" errors (which Windows reports on later reads) from halting a link, and looks up addresses given as names.
- `record.go`: the hub's address record. Once a device is paired, the hub publishes its addresses on Pkarr (signed records on the public Mainline DHT, through Pkarr's free HTTP relays): encrypted with XChaCha20-Poly1305 under a key only paired devices get (through the tunnel, in the pairing answer and from `GET /.pan-link/record`), and signed with an Ed25519 key of the hub's own, so nobody can forge it or read it. It goes out when the addresses change, and hourly (the DHT forgets after about two hours). A device that can't reach the hub on any saved address looks the record up on all relays at once, takes the newest record that checks out (an older one than it last used is refused), and adds the new addresses to its link. Removing a device changes the encryption key, so a lost phone can't follow the hub's addresses; the other devices fetch the new key the next time they are connected. `link.json` gets `record_seed` and `record_secret`; a hub set up before records gets them on its next start.
- `allow.go`: limited devices. A device can carry an allow list of requests (`"POST /api/v1/notify/inbound"`, or `"GET /static/*"` for everything under a folder); pan-link answers 403 itself to anything else that device sends, WebSocket upgrades included, so PAN never sees it. Paths with dot segments, double slashes or percent escapes are refused, so a request can't name an allowed path and reach another. The list is saved with the device in `link.json`, set at pairing (`POST /admin/pair` with `allow`, or `pan-link code --allow ...`) and changed with `PUT /admin/devices/{id}/allow` from the next request on (empty lifts the limit). Each refused kind of request is logged once. It is for a computer someone else also controls, such as a work computer whose company has admin rights on it: it can send to PAN but can't read PAN or change it. The link itself only goes one way: a device's own end listens only on its local port, so nothing can come back into that computer through it.
- `portmap.go`: asks the home router to forward the hub's UDP port (UPnP, NAT-PMP or PCP), using Tailscale's portmapper (BSD-3). Opens nothing until the hub is started with `--open-router-port`.
- `netstack/`: the network stack glue, copied from tailscale/wireguard-go (MIT, licence in that folder) and adjusted to the gVisor version tailscale.com v1.96.4 uses, so it can live in the same `panvpn.aar` as the phone's Tailscale. Also fixes a crash when a link closes while packets are in flight.
- `cmd/pan-link`: the program.

PAN side: `service/src/pan-link-auth.js`, checked in `server.js` before every other `/api` route, the auth routes included. PAN trusts the device id only when the secret matches `link.json` in its data folder, and refuses link headers with a wrong secret (403). With no `link.json` it changes nothing for callers that send no link headers. The secret is cached for a minute, but a mismatch looks at `link.json` again at once, so a new `link.json` or a new secret works straight away. `GET /api/v1/auth/me` returns `link_device` (`{ id, name }`, or null), so a device can confirm PAN sees it as itself. `PAN_LINK=0` turns it off.

### The program

```
pan-link hub    --data DIR [--port 41720] [--bind ADDR] [--backend URL] [--admin 127.0.0.1:7792] [--name NAME] [--endpoint HOST:PORT]... [--open-router-port] [--address-record=false]
pan-link code   --data DIR [--name "My Pixel"] [--minutes 10]    asks the running hub for a pairing code
pan-link pair   --data DIR --code "pan://pair?..." [--name NAME] [--bind ADDR]
pan-link client --data DIR [--listen 127.0.0.1:7779] [--bind ADDR]
pan-link probe  [--port 41720] [--seconds 5]                     which port opening the router answers; opens nothing
```

The hub puts its addresses in each pairing code in this order: home network IPv4 (the adapter with the default route first), global IPv6, a public IPv4 on the computer itself, the router's public address when it forwards the port, the Tailscale address, then any `--endpoint`. Adapters that only reach virtual machines or containers on the computer are left out: Hyper-V and WSL (vEthernet), Docker, VirtualBox, VMware, libvirt, LXC. On Windows the adapter's description counts too, since VirtualBox's adapter is just called "Ethernet 2". The adapter with the default route always stays, because a Hyper-V external switch puts the computer's own home address on a vEthernet adapter.

The hub publishes its address record (see `record.go`) about 15 s after it starts and then checks every minute; `--address-record=false` turns that off. `pan-link client` looks the record up when the saved addresses fail (at most every 5 minutes) and saves new addresses into `client.json`.

A hub listening on all addresses makes Windows ask about the firewall on its first run. PAN Setup adds that rule. Nobody should click it on someone else's behalf.

### Tests

`go test ./...` (33 tests, all on 127.0.0.1 or in memory, so no firewall prompt; one more uses Pkarr's real relays when `PAN_LINK_LIVE=1` is set):

- a phone pairs and reaches PAN, and PAN sees the real device id even when the phone forges the headers;
- a stranger key that knows the hub's public key and address gets nothing, and PAN is never reached;
- a device still pairing can't reach PAN;
- a used code is refused, and an expired code is refused quickly;
- the admin API refuses calls without the secret;
- real UDP: pair, use the local port, restart the hub from `link.json`, unpair;
- real UDP: after a hub restart on the same port, the same device link works again in 1.0 s (16 s without the hub starting the handshake);
- a damaged `link-endpoints.json` doesn't stop the hub from starting;
- the port mapper sends nothing until asked;
- the address order in pairing codes;
- which adapters stay out of pairing codes (checked on the real hub too: its Hyper-V address is gone, the home and both Tailscale addresses stay);
- with two dead addresses in front of the live one, pairing and connecting take as long as the live one alone (connect 1 to 2 ms);
- three network paths through UDP relays: cut the one in use and the link moves in 1.0 s after `Rehandshake`, and in 16 s with nothing said (the old code never moved);
- no network at all for a while, then a different path comes up 1 s after WireGuard's last try: back in 5 ms after `Rehandshake` (4.3 s before it resent that try);
- a handshake's copies for Tailscale addresses go 150 ms after the others, and at once when there is no other address or it can't be sent to;
- a "port unreachable" error doesn't stop the link from reading;
- names in the address list are looked up, and repeats dropped;
- the address record: it opens and checks out with the right keys only, and one flipped bit anywhere, another key, another secret or a record signed by another key under this one's name is refused; addresses that don't fit in 1000 bytes are cut from the end; z-base-32 matches its published examples;
- a hub that moved (restarted on another port) is found through its record: the device's saved address gets nothing, the record has the new one, and the link answers 3 ms after adding it; an older record than the last one used is refused; a hub with no paired device publishes nothing;
- a removed device can't open the next record; a kept device can't either until it fetches the new key through the tunnel, then can; the removed device can't connect to fetch it;
- a `link.json` from before records gets their keys on the next start, its secret unchanged;
- no relay answering is an error, not a hang, and an empty relay says there is no record;
- a device whose program restarts 1 s later, or 2 s after a crash that left a connection open, is back in 2 to 3 ms (a restart within about 20 ms of the last handshake costs WireGuard's 5 s retry);
- limited devices: which allow lists are accepted (bad methods, unclean paths, stars outside a final `/*`, too many or too long are refused); which requests match (exact and prefix rules, any method, dot segments, double slashes and escapes refused); a device paired with a limit reaches PAN only with its own requests, under its own identity, while PAN memory, MCP, hooks, the dashboard, a refused method and a dot path are answered 403 by pan-link with PAN never reached, each kind logged once; the limit is in `link.json`, survives a hub restart, and the admin API lifts it and sets it again from the next request (a bad rule changes nothing, an unknown device is 404).

PAN side: `node service/src/__tests__/pan-link-auth.test.js` (10 tests) and `pan-link-routes.test.js` (11 tests: a code and its QR from `POST /api/v1/link/pair`, the time limit capped, owner only, devices, removing a device, a bad device id never reaching pan-link, only the owner removing, a limited code carrying PAN's preset, limiting and lifting the limit on a paired device (owner only, a bad id or value never reaching pan-link), no `link.json`, pan-link not running). `tailscale-key.test.js` (7 tests: a link device gets a single use tagged key and the key is never logged; the owner without the link is refused; no OAuth client or no tag stops before Tailscale is asked; Tailscale's refusal passed on; at most 3 keys per device in 10 minutes; Tailscale not reachable). The app's QR reader: `PairCodeReaderTest` (4 tests, `gradlew :app:testDebugUnitTest`).

Phone side: `go test ./linkmode/` in `android/pan-vpn` (7 tests: pair, start, use and forget; a phone that starts before the hub is reachable; the link carried by the app's own Tailscale, also when Tailscale comes up after the link; a link that started on Tailscale while the direct path was down moves back to it once it works (4.9 s, the next check plus WireGuard's 5 s limit); which addresses count as Tailscale's; a hub that moved while the phone was away is found through its address record by the link itself, and the pairing keeps the new address).

Real network run on a Linux PC on the home network (2026-11-08), all passed:

- pairing over the PC's home address, with a code of 178 characters;
- PAN saw the real device id when the request carried a forged one;
- the tunnel's port 7777 was not reachable from outside the tunnel;
- a used code was refused.

Second run, with the real default socket instead of one bound to a single address: three dead addresses put in front of the live one in `client.json`, and the client still connected in 52 ms, program start included. Before the change it waited 6 s for each dead address. Pairing took 705 ms, most of it a deliberate 700 ms wait for the hub to switch keys.

### In front of the dev PAN (2026-11-08)

The hub ran in front of the dev PAN (port 7781) with the dev data folder as its `--data`, and a device paired and used its local port, all on 127.0.0.1 on one Windows computer. 24 of 24 checks passed:

- before pan-link, forged link headers straight to PAN were refused (403) on an auth route and on another route;
- pairing took 762 ms; PAN's `/health` answered through the link 73 ms after the client started;
- `/api/v1/auth/me` through the link named the paired device, even though a forged call had been refused just before `link.json` existed;
- forged headers sent by the device were replaced by the real ones; forged headers straight to PAN were still refused;
- the dashboard page, a 1.9 MB image and the device push WebSocket went through the link;
- the hub was stopped and started again from `link.json`; the device was back on its own 12 s later;
- an unpaired device lost access at once, and a used code was refused (after the 10 s wait for an answer).

| Measure | Straight to PAN | Through the link |
|---|---|---|
| `/health`, median of 20 | 2.0 ms | 3.2 ms |
| 1.9 MB download, median of 5 | 5.5 ms | 140 ms (107 Mbit/s) |
| Device push WebSocket, open to pong | 9 ms | 11 ms |

The run found three PAN bugs, fixed in this run: the auth routes never saw the device (they sit in front of the old check), a database from before 2026-09-01 failed to start, and `terminal.js` wrote a 404 onto the device push WebSocket right after its handshake. On the hub that WebSocket also never reached the Craft, because the Carrier answered 404; the Carrier now passes it through (tested on a three layer copy). See "Found while testing" in `docs/INSTALL-PLAN.md`.

### On the real hub (2026-11-08)

The owner added a firewall rule for UDP 41720. A test copy of the hub then ran on the real hub for a few minutes, in front of the real PAN (which did not have the PAN side changes yet), and a device paired from the owner's Linux PC on the home network. The test copy, its keys and the device's files were removed afterwards.

- Pairing took 732 ms.
- With all four hub addresses in the code, PAN's `/health` answered through the link 193 ms after the client started, over the home address, and `/api/v1/auth/me` answered too.
- `/health`, median of 20: 4.8 ms through the link, 4.5 ms straight over Tailscale.
- One address at a time: the home address, the Tailscale IPv4 address and the Tailscale IPv6 address all worked (107, 59 and 120 ms from client start). A Hyper-V virtual adapter address got no answer in 12 s.
- After the hub unpaired the device through the admin API, the device's next call got no answer.

### Installed on the real hub (2026-11-08)

pan-link now runs on the real hub for good, in front of the real PAN, and starts at boot:

- `pan-link.exe` and `windows/start-pan-link.bat` sit in `pan-link\` inside PAN's folder (`%LOCALAPPDATA%\PAN\pan-link\` there), next to `data\`, which holds `link.json` and `link-endpoints.json`. The launcher runs `pan-link hub --data <PAN folder>\data --name "PAN hub"`, logs to `data\pan-link.log`, and starts it again about 5 s after it stops.
- `windows/install-pan-link-task.ps1` registers the scheduled task `PAN-Link`: at startup, as SYSTEM, no time limit (`schtasks` would stop it after 3 days), restart on failure. It runs beside `PAN-Hub`.
- To update: `schtasks /end /tn PAN-Link` (it ends the launcher and pan-link with it), replace the exe, `schtasks /run /tn PAN-Link`. Paired devices are back within about a second, since the hub calls each one back: after a restart this way, PAN answered through the phone's link 1.2 s after the task started again.
- Not tried yet: a real reboot of the hub.
- PAN makes pairing codes through pan-link's admin API: `POST /api/v1/link/pair` (owner only) answers the `pan://pair` code and its QR as SVG, `GET /api/v1/link/devices` lists the paired devices and `DELETE /api/v1/link/devices/:id` removes one (`service/src/routes/link.js`). The app's "Pair this phone" uses it, and so does PAN's pairing page `/pair/`: "Show a pairing code" gives the QR with a countdown, the page says "Paired: <name>" once a device has used it, and lists the paired devices with Remove. On the dev PAN a device paired with the code the page showed, and the page noticed within 3 s.

### Phone run (owner's Pixel 10 Pro, Android 17, 2026-11-08)

App 0.4.92 with `panvpn.aar` built from this code, against pan-link on the real hub (started by hand for the test, `link.json` in PAN's data folder). All passed except mobile data, which the phone's carrier didn't give.

- Pairing from a `pan://pair` link: 2.4 s. PAN's `/api/v1/auth/me` named the phone (`link_device`), and the app's hub finder switched from the Tailscale proxy port to the link's port by itself.
- Home Wi-Fi: `/health` median 22 to 54 ms through the link, against 23 to 46 ms through the app's Tailscale proxy in the same runs. The phone dashboard page (146 KB) loaded in 0.27 s. The hub saw the phone at its home address, so UDP 41720 gets through the hub's firewall rule even though ping and TCP 7777 don't.
- Only the Tailscale path (the home address taken out of the phone's pairing for one run): the link went through the app's own Tailscale, and the hub saw the phone at its Tailscale address. 31 ms once Tailscale had a direct path, 99 ms while it went through Tailscale's relay. From a cold app start PAN answered through it after 5.0 s (about 8 s before the app told the link the moment its Tailscale was up).
- Cold start on Wi-Fi: PAN answered through the link 1.15 s after the app started.
- Wi-Fi off, then on: Android's network events reached the link at once. After 3.5 min off, the 0.4.91 build took about 3 s after Wi-Fi came back, because WireGuard had tried less than 5 s before and skipped the app's request (fixed in 0.4.92, see `spray.go`). With 0.4.92 and 1 min off, the old session was still valid and the link answered as soon as Wi-Fi was back.
- Mobile data: not tested. The phone's mobile data kept failing to connect, and when it did connect, Tailscale's own TCP connections timed out for over a minute (its relay took 40 s, its control server never answered), so neither the old Tailscale proxy nor the link could work. The link can only be as good as the app's Tailscale there.
- 0.4.93 (same day): Settings shows a "PAN Link" line (connected or not, over the home network or through Tailscale, last handshake) with a button to forget the pairing, and the phone sends its link events (network changes, connected or not, which path) to the hub's log (`/api/v1/logs`, source `pan-link`), so a test away from home can be read back. After the hub had called the phone back over Tailscale, the link stayed there at home; it now prefers a direct path (`TailnetDelay`) and a link on Tailscale checks every 2 minutes whether the direct path works again. With 0.4.93 the link started on the home network, and after pan-link restarted through its boot task PAN answered through it 1.2 s later.
- 0.4.95 (same day): "Scan a pairing code" in Settings reads the QR from PAN's `/pair/` page with the back camera (CameraX, ZXing core on the phone; any QR that isn't a `pan://pair?` link is ignored). Settings starts with one plain line on the way the app reaches PAN ("Using PAN Link, over your home network"), and the main screen's Connection card says the same; before, it said "Tailscale Encrypted" whatever the path, so the owner thought the phone was still on Tailscale. Seen on the Pixel; the camera opened. Reading a real QR is the owner's test.
- Also seen: the app's VPN (`PanVpnService`, kept for Tailscale) sets no IPv6 route, so Android blocks IPv6 for every app on the phone while it runs (`::/0 unreachable`). Another reason to drop that VPN once the link carries everything.

Android 10 (Blackview BV9900 Pro): the app needs Android 12, so only the program was tested, as both hub and device on the phone, with PAN stood in by a small server on the laptop over USB. Pairing took 1.3 s, every request carried the device's id, name and the link secret, and a round trip took 50 ms (over USB both ways).

### What the home network allows

Checked 2026-11-08 with `pan-link probe` on the owner's home network: the router answers none of UPnP, NAT-PMP or PCP. The connection is behind CGNAT and the router blocks incoming IPv6. So away from home only the Tailscale path works there. PCs on the same tailnet already get it from the Tailscale address in the pairing code. The phone needs its built in Tailscale to carry pan-link's packets.

### Finding the hub (Pkarr test, 2026-11-08)

A stdlib-only test program signed a record and stored it through the public Pkarr relays (`pkarr.pubky.org`, `relay.pkarr.org`, `pkarr.pubky.app`). All three answered. Publishing took 4.4 s (37 DHT nodes stored it). Lookups took 73 to 203 ms and returned the same record from each relay. A lookup for a record that doesn't exist took 2.6 to 4.5 s.

With `record.go` (2026-11-08, `PAN_LINK_LIVE=1 go test -run LiveRelays`, a throwaway key and documentation addresses only): all three relays took the encrypted record (3.0 to 10.7 s each, as they store it on the DHT), each gave it back with the right addresses in 47 to 73 ms, and `FindHub` over all three took 72 ms. On the real hub, the new pan-link published its record (3 addresses) 18 s after it started.

### A second computer

A PC reaches PAN through the link the same way the phone does: `pan-link client` keeps the link up and serves PAN on a local port.

1. On the PAN computer, open `/pair/`, "Show a pairing code", then "Pairing a computer instead?" and copy the code.
2. On the second computer: `pan-link pair --data <PAN folder>\link-client --code "<the code>" --name "<its name>"`.
3. Windows: put `pan-link.exe` and `windows/start-pan-link-client.bat` in `<PAN folder>\pan-link\` and run `windows/install-pan-link-client-task.ps1` in an elevated PowerShell: the task `PAN-Link-Client` starts it at boot as SYSTEM and its launcher restarts it after 5 s if it stops (log in `link-client\pan-link-client.log`). Without admin rights, `-CurrentUser` makes it start at that user's logon instead, with no window. Windows may quietly add inbound block rules for `pan-link.exe` the first time it runs (when firewall notifications are off); a client doesn't need inbound, replies to its own packets still arrive. Linux: `linux/pan-link-client.service` as a systemd user service (steps at its top).
4. Point the computer's PAN tools at `http://127.0.0.1:7779`: the PAN client's `hub_ws` and `relay_hub_url`, Claude Code's user MCP server and HTTP hooks, and any script of your own that calls PAN. The repo's MCP servers (`.mcp.json`) find the link by themselves (`service/src/mcp/pan-address.js`). Tailscale can stay on underneath until it all works.

Tried on one computer against the dev PAN (2026-11-08): the launcher refuses to start unpaired and says why; once paired, PAN answered through its port 594 ms after it started and named the computer; with the client killed (not the hub), the launcher brought it back and PAN answered again 5.2 s after the kill. Three computers reached the hub's 7777 over Tailscale (seen in the hub's connections on 2026-11-08); all three have to move before 7777 can go to 127.0.0.1.

The owner's laptop moved first (2026-11-08): the boot task as SYSTEM (installer run elevated), paired by name, PAN on 127.0.0.1:7779 over the home network path, as fast as Tailscale (8 to 61 ms against 9 to 62 ms). On it, five things used the hub's address: Claude Code's PAN MCP server (`claude mcp add --transport http --scope user pan http://127.0.0.1:7779/mcp/pan`), Claude Code's HTTP hooks (`~/.claude/settings.json`), the PAN client and the thread relay (`pan-client/pan-client-config.json`: `hub_ws` and `relay_hub_url`), and the transcript sync, which now follows that file. After the switch the PAN client registered and connected its WebSocket through the link, the relay's new wait loop was alive, and the hub saw no more direct connections from the laptop. Claude Code sessions that were already open keep the old address until they restart, which works until 7777 closes.

A Linux desktop moved next, the same day: `pan-link` built for linux/amd64 on the laptop (`GOOS=linux GOARCH=amd64 CGO_ENABLED=0`, same flags as below), paired with a code made through the laptop's link, then run as the systemd user service (the owner enabled it). It reached the hub over the home network path, as owner, MCP included. Besides the same four things as on the laptop it had a game mode script that tells PAN which computer's Ollama to use; all five go through the link now, and the transcript sync finds the PAN client's settings outside the repo too (`~/pan-client`, or where the client installer puts them). One thing went around the link on every computer: the repo's `.mcp.json` named the hub's Tailscale address, so Claude sessions opened in the PAN folder called 7777 directly. Its MCP servers now find PAN by themselves (`service/src/mcp/pan-address.js`); on the laptop a search through the PAN MCP server, started with no address, came back through the link. Afterwards the hub's only direct connection on 7777 was the work computer's.

### Limited devices, tried against the dev PAN (2026-11-08)

The dev PAN (port 7781) with a dev hub on 127.0.0.1, both on the laptop. The `/pair/` page made a limited code ("Make a limited code" under "Pairing a computer instead?"), and a throwaway client paired with it showed up as "Limited: can only send alerts and messages", with PAN's preset in `link.json`. Through that client: `/health` 200, the PAN client's WebSocket (`/ws/client`) 101, a note to `POST /api/v1/notify/inbound` queued; PAN's login check, the device list, MCP, hooks, the dashboard's event search, the dashboard page, `/pair/`, the device lifting its own limit, a GET to an allowed POST path, a dot path sent as is and an escaped slash were all 403 from pan-link and logged once each. "Give full access" on the page made the same client get 200 from the login check on its next request, and "Limit" made it 403 again; the client stayed connected throughout. The page's script had never run before this (an apostrophe in a quoted string), so the QR page had not worked since it was added.

### Building

Offline from the module cache, on two cores to keep the load low:

```
GOPROXY=off GOSUMDB=off GOFLAGS=-mod=mod GOMAXPROCS=2 go test -p 2 ./...
GOPROXY=off GOSUMDB=off GOFLAGS=-mod=mod GOMAXPROCS=2 go build -p 2 -trimpath -ldflags="-s -w" ./cmd/pan-link
```

`GOFLAGS=-mod=mod` also overrides a global `GOFLAGS` (set with `go env -w`) that points at an overlay file which no longer exists. The program is about 12 MB.

## Next

1. Done: the Pkarr address record (`record.go`, above). The key that opens it comes through the tunnel, not in the pairing code, so the QR stays the same size. Still to see: a phone finding the hub after a real address change (needs a home whose router forwards the port, or IPv6).
2. The reachability check PAN Setup runs (phone off Wi-Fi for a few seconds).
3. Phone: done and tested on the owner's Pixel (above). In the app: `LinkManager` (start with the service, follow Android's network, use the link's port while it has a recent handshake, send link events to the hub's log, a status line), `PairActivity` for `pan://pair` links (asks first, naming the computer and any pairing it replaces), `RemoteAccessManager` and `HubLocator` prefer the link, and `PanVpnService` tells the link when its Tailscale is up. `ScanPairActivity` reads the pairing QR. Still to do: the scanner and the pairing dialog tried by eye on a real QR, a test on mobile data, and dropping `PanVpnService`'s VPN (the link needs no VPN permission; only Tailscale does).
4. Done: pan-link runs on the real hub for good, started at boot beside PAN (see above). Next: move PAN's 7777 to 127.0.0.1 so the link is the only way in from outside, once the PCs use the link too.
5. Through the link a big download runs at about 107 Mbit/s on one computer. Plenty for PAN today; if big files go through, look at the network stack's buffer sizes.

Done since the hub run (2026-11-08): the hub starts the handshake itself after a restart (devices back in about 1 s, was 12 to 16 s), pairing codes leave out virtual machine and container adapters, and links move off a dead path (see `spray.go`). Since the phone run: `Rehandshake` resends WireGuard's unanswered handshake when it can't make a new one yet (see `spray.go`).
