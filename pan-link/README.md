# pan-link

PAN Link: plain WireGuard inside the program, so a phone or PC reaches PAN on the person's own computer with no Tailscale account and no system VPN driver. Design: `docs/INSTALL-PLAN.md`, section "PAN Link".

## Status (2026-11-08)

Step 1 of the install plan. Built and tested, including one test run on the real hub (removed afterwards). pan-link itself is not installed on the hub yet.

### Files

- `link.go`: starts a WireGuard device on its own network stack. Keys, peers, one tunnel address per peer (WireGuard drops packets from a key that use another address, so the tunnel address proves which device is calling). Peers can be added, removed or swapped while it runs.
- `bind.go`: a UDP socket on one address only. Tests use 127.0.0.1, so Windows never asks about the firewall.
- `pair.go`: the pairing code, `pan://pair?v=1&...` (the QR's text). It holds the hub's public key, the tunnel addresses, a one time key, the hub's addresses and the expiry.
- `state.go`: `link.json` on the hub (its key, the link secret, the paired devices) and `client.json` on a device. Saved by writing a new file and renaming it, readable by the owner only.
- `hub.go`: the hub side. Serves HTTP inside the tunnel on port 7777 and forwards to PAN on the computer itself. It strips any `X-PAN-Device`, `X-PAN-Device-Name` or `X-PAN-Link-Secret` a device sends, then sets the real ones. A device still holding only its one time key can finish pairing and nothing else. Unknown keys get nothing. The admin API (make a code, list or remove devices) listens on 127.0.0.1 only and needs the link secret.
- `client.go`: pairing (makes the device's own key and swaps it in through the tunnel), connecting, and a local port that apps on the device use to reach PAN.
- `spray.go`: while pairing or connecting, every packet goes to all of the hub's known addresses at once, and the first address the hub answers on wins. Dead addresses cost nothing, which matters away from home. It also stops "port unreachable" errors (which Windows reports on later reads) from halting a link, and looks up addresses given as names.
- `portmap.go`: asks the home router to forward the hub's UDP port (UPnP, NAT-PMP or PCP), using Tailscale's portmapper (BSD-3). Opens nothing until the hub is started with `--open-router-port`.
- `netstack/`: the network stack glue, copied from tailscale/wireguard-go (MIT, licence in that folder) and adjusted to the gVisor version tailscale.com v1.96.4 uses, so it can live in the same `panvpn.aar` as the phone's Tailscale. Also fixes a crash when a link closes while packets are in flight.
- `cmd/pan-link`: the program.

PAN side: `service/src/pan-link-auth.js`, checked in `server.js` before every other `/api` route, the auth routes included. PAN trusts the device id only when the secret matches `link.json` in its data folder, and refuses link headers with a wrong secret (403). With no `link.json` it changes nothing for callers that send no link headers. The secret is cached for a minute, but a mismatch looks at `link.json` again at once, so a new `link.json` or a new secret works straight away. `GET /api/v1/auth/me` returns `link_device` (`{ id, name }`, or null), so a device can confirm PAN sees it as itself. `PAN_LINK=0` turns it off.

### The program

```
pan-link hub    --data DIR [--port 41720] [--bind ADDR] [--backend URL] [--admin 127.0.0.1:7792] [--name NAME] [--endpoint HOST:PORT]... [--open-router-port]
pan-link code   --data DIR [--name "My Pixel"] [--minutes 10]    asks the running hub for a pairing code
pan-link pair   --data DIR --code "pan://pair?..." [--name NAME] [--bind ADDR]
pan-link client --data DIR [--listen 127.0.0.1:7779] [--bind ADDR]
pan-link probe  [--port 41720] [--seconds 5]                     which port opening the router answers; opens nothing
```

The hub puts its addresses in each pairing code in this order: home network IPv4, global IPv6, a public IPv4 on the computer itself, the router's public address when it forwards the port, the Tailscale address, then any `--endpoint`.

A hub listening on all addresses makes Windows ask about the firewall on its first run. PAN Setup adds that rule. Nobody should click it on someone else's behalf.

### Tests

`go test ./...` (13 tests, all on 127.0.0.1 or in memory, so no firewall prompt):

- a phone pairs and reaches PAN, and PAN sees the real device id even when the phone forges the headers;
- a stranger key that knows the hub's public key and address gets nothing, and PAN is never reached;
- a device still pairing can't reach PAN;
- a used code is refused, and an expired code is refused quickly;
- the admin API refuses calls without the secret;
- real UDP: pair, use the local port, restart the hub from `link.json`, unpair;
- the port mapper sends nothing until asked;
- the address order in pairing codes;
- with two dead addresses in front of the live one, pairing and connecting take as long as the live one alone (connect 1 to 2 ms);
- a "port unreachable" error doesn't stop the link from reading;
- names in the address list are looked up, and repeats dropped.

PAN side: `node service/src/__tests__/pan-link-auth.test.js` (10 tests).

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

### What the home network allows

Checked 2026-11-08 with `pan-link probe` on the owner's home network: the router answers none of UPnP, NAT-PMP or PCP. The connection is behind CGNAT and the router blocks incoming IPv6. So away from home only the Tailscale path works there. PCs on the same tailnet already get it from the Tailscale address in the pairing code. The phone needs its built in Tailscale to carry pan-link's packets.

### Finding the hub (Pkarr test, 2026-11-08)

A stdlib-only test program signed a record and stored it through the public Pkarr relays (`pkarr.pubky.org`, `relay.pkarr.org`, `pkarr.pubky.app`). All three answered. Publishing took 4.4 s (37 DHT nodes stored it). Lookups took 73 to 203 ms and returned the same record from each relay. A lookup for a record that doesn't exist took 2.6 to 4.5 s.

### Building

Offline from the module cache, on two cores to keep the load low:

```
GOPROXY=off GOSUMDB=off GOFLAGS=-mod=mod GOMAXPROCS=2 go test -p 2 ./...
GOPROXY=off GOSUMDB=off GOFLAGS=-mod=mod GOMAXPROCS=2 go build -p 2 -trimpath -ldflags="-s -w" ./cmd/pan-link
```

`GOFLAGS=-mod=mod` also overrides a global `GOFLAGS` (set with `go env -w`) that points at an overlay file which no longer exists. The program is about 12 MB.

## Next

1. The Pkarr address record: the hub publishes its addresses, signed by its own key, and devices look it up when the saved ones fail. Encrypt the addresses with a key from the pairing code, so the DHT only ever stores an unreadable blob.
2. The reachability check PAN Setup runs (phone off Wi-Fi for a few seconds).
3. Phone: plain WireGuard mode in `panvpn.aar` using this package, with Tailscale carrying the packets when nothing else works.
4. Install pan-link on the real hub for good, started at boot beside PAN (the firewall rule for its UDP port is in place), then move PAN's 7777 to 127.0.0.1 so the link is the only way in from outside.
5. After a hub restart, devices take about 12 s to come back: WireGuard waits that long before a new handshake. The hub could save each device's last address and start the handshake itself.
6. Through the link a big download runs at about 107 Mbit/s on one computer. Plenty for PAN today; if big files go through, look at the network stack's buffer sizes.
7. Leave virtual adapters (Hyper-V, WSL, Docker) out of the addresses in the pairing code. Only VMs on the hub itself can reach them, so they just make the code longer.
