# PAN install plan

Written 2026-11-08 from a full read of the code (network, installers, phone app, Medallion board) plus outside checks. Owner's goal from PRODUCT-MAP.md, "Owner's install flow". Step 1 is under way; see "Progress" under "Order of work".

## The goal

Out of the box to working, with nothing technical:

1. Plug the Medallion into your computer. A drive called PAN opens with "PAN Setup" on it. The Medallion's screen says what to do and shows a QR code for the phone app.
2. Double click PAN Setup. It checks the computer, downloads the current PAN, installs it, and plays short videos about what PAN does while it works.
3. Install the phone app from the QR, open it, and scan the QR on the computer screen. The phone is paired.
4. The Medallion pairs with the phone: both screens show the same 6 digits, tap OK on each.
5. Sign in to Claude once, with the person's own account. PAN Setup adds PAN to Claude.

No PAN account, no API keys, no Tailscale login. Everything runs on the person's own computer. We run no server that holds or controls anything.

## What exists today

- **Network.** Everything remote is Tailscale, on Tailscale's servers. The hub and the PCs use the Tailscale app, installed by hand. The phone has Tailscale built in (`android/pan-vpn/panvpn.go`) and never sets its own server (no ControlURL).
- **Plain WireGuard was never tried in code.** In March 2026 it was decided against: Tailscale gets through hard home networks and gives devices names. A "Custom WireGuard" settings box was built on 2026-03-26 and lost in the March history rewrite. Headscale was only ever "planned".
- **The phone's key handout (auto-auth) is already gone.** It was an uncommitted hand patch in the hub's `C:\PAN\service\src\routes\api.js` (2026-09-11), and the update of `C:\PAN` on 2026-11-02 replaced that file. The phone still connects only because it remembers its Tailscale login. A copy recovered from the hub's backup is saved, not mounted, at `docs/legacy/tailscale-auto-auth-2026-09.js`. The repo has only the line that skips login for it (`server.js:682`).
- **Trust is by address, and that is the biggest hole.** `server.js:663-681` makes localhost, any `100.*` address, or a home address plus an `X-Device-Name` header the owner. Both internal proxies make every caller look like 127.0.0.1, so anything that reaches port 7777 is treated as the owner (REBUILD-REVIEW.md fix-now #1).
- **Installers.**
  - Working, for second PCs: `service/installer/pan-installer.cjs`, built by `service/scripts/build-installer.js`, released on GitHub by `.github/workflows/release-installer.yml`.
  - Hub installer skeleton from April: `installer/install.ps1` and `installer/pan-setup.nsi`. It installs only from a repo copy, and none of the AI or voice parts.
  - The real hub was put together by hand: the clone at `C:\PAN`, the SYSTEM task, Ollama, the models, the Python venv, Tailscale, Claude Code.
- **Updates.** The hub has no self update. Phone updates come from the hub's own Android build folder (`/apk/latest`), which a customer's hub won't have. There is no download server or website.
- **Phone app.** No first run screens, no QR scanner, no deep links. It asks for every permission at once. It hardcodes the owner's details: hub host names, two home network addresses, a PC name, and the owner's name on the mobile page.
- **Medallion.**
  - USB-C goes straight to the chip's own USB pins (GPIO19/20, `hardware/medallion/medallion_board.py:80-84`). So it can act as a USB drive with no board change.
  - ESP32-S3-WROOM-1-N16R8: 16 MB flash, 8 MB PSRAM. Touch (CST9217) is wired to the chip.
  - No Medallion firmware exists yet. The only firmware is the old XIAO pendant's, which has no Bluetooth pairing or encryption.
- **Home Assistant already runs on the hub** in a Hyper-V VM (since July 2026), with PAN's voice integration wired in. Not part of this plan; noted for the smart home job.

## The design

### 1. PAN Link: the network, on the person's own computer

- **pan-link** is a small program on the hub. It runs plain WireGuard inside the program (wireguard-go with its own network stack, MIT). So it installs no system VPN driver and does not fight other VPNs. The phone app gets the same thing inside `panvpn.aar`, whose Go module already includes wireguard-go, that network stack and Tailscale's router port opening code.
- **Hub and spokes.** Every phone and PC connects to the hub, never device to device. PAN's data lives on the hub anyway.
- **The hub listens on the computer itself only (127.0.0.1).** The only way in from outside is pan-link's WireGuard port. Each device has its own key, and pan-link tells PAN which device is calling. So "owner" comes from the key, not the address. Port 7777 is never opened on a router.
- **Reaching the hub from outside,** tried in this order:
  1. On home Wi-Fi, the hub's home address. Still through the encrypted tunnel, so nothing trusts the home network.
  2. IPv6, when both the home and the phone's network have it.
  3. IPv4, with the router port opened automatically: UPnP, NAT-PMP or PCP, using Tailscale's portmapper code (BSD licence).
  4. If none of that works, Tailscale with the person's own account, one Google sign in. This happens when the internet provider shares one address between homes (CGNAT) or the router refuses. It is the current code, kept and fixed.

  Tested 2026-11-08 on a home connection behind CGNAT: the router answered none of UPnP, NAT-PMP or PCP, and its provider shares IPv4 addresses between homes and blocks incoming IPv6 (common with satellite, fixed wireless and mobile broadband). There only 1 (at home) and 4 (Tailscale) work, so the fallback is a main path, not a corner case. pan-link already lists the hub's Tailscale address last in every pairing code, so a PC on the same tailnet reaches pan-link through Tailscale with no extra code. The phone needs its built in Tailscale to carry pan-link's packets (phone work, step 3).
- **Finding the hub when the home address changes.** The hub publishes its current address as a record signed by its own key on Pkarr (MIT): signed records on the public BitTorrent DHT, plus free relays. Nobody can fake the record or learn anything useful from it; the worst a relay can do is not answer. The phone also remembers the last address and relearns it at home.
- **Setup proves it works.** It asks the person to turn off Wi-Fi on the phone for a few seconds and tries the tunnel over mobile data. If that fails, it switches to the fallback and says so in plain words.

### 2. Pairing

- **Phone and hub.** The hub shows a QR holding:
  - a one time key for this phone,
  - the hub's public key and addresses,
  - a 10 minute expiry.

  The phone connects with it, makes its own permanent key, and sends the public half through the tunnel. Then the one time key is deleted, so a photo of the QR is useless afterwards.
- **Medallion and phone.** Bluetooth secure pairing with number comparison: both screens show the same 6 digits, and you tap OK on each. Once bonded and encrypted, nothing else can connect.
- **Second computers.** "Add a computer" on the phone or hub makes a link. The existing `pan-installer.cjs` installs pan-link in spoke mode and pairs the same way.

### 3. PAN Setup on the hub (Windows first)

- **What it is.** A small signed bootstrap program, both on the Medallion's drive and on GitHub Releases. It downloads everything else, so the copy on the drive never goes stale.
- **Steps:**
  1. Check the computer: 64 bit Windows 10 or 11, RAM, free disk, CPU.
  2. Fetch the release list from GitHub Releases and check its signature against an Ed25519 release key.
  3. Download PAN with its own pinned Node and prebuilt modules, plus pan-link and Ollama (silent install).
  4. Download the models from Hugging Face.
  5. Create the data folder and the database key, and set PAN to start at boot.
  6. Add one firewall rule, for pan-link's UDP port only.
  7. Set up PAN Link and run its check.
  8. If Claude isn't installed, open Claude's official download page. Then open `PAN.mcpb`, Anthropic's desktop extension format, so Claude shows its Install button.
  9. Show the phone pairing QR.

  Short videos and diagrams play during the download.
- **Size.** The models alone are about 12 GB today, so download time is real. Setup picks a lighter set on a smaller computer.
- **Licences shipped.** Owner's decision 2026-11-08: keep Liquid (Syrinx LFM), no switch to Gemma. Syrinx ships with a copy of the LFM licence and Liquid's credit; it is free while company revenue stays under $10M a year. At that point, buy Liquid's commercial licence or retrain on an open base (syrinx-gemma, Gemma 4 Apache 2.0, already exists). `MODEL-CREDITS.md` is shown in the app.
- **Starting at boot without a password.** Needs a test: a scheduled task "at startup" running as the user with no stored password, or a service. Either way it has to reach the user's Claude login and the GPU.
- **Updates.**
  - Hub: PAN checks GitHub Releases, verifies the signature, installs into a second folder and switches over. If the health check fails, it switches back.
  - Phone: the Play Store.
  - Medallion: firmware goes from the phone to the Medallion over Bluetooth, signed.

### 4. Phone app first run

- Welcome, then permissions one at a time with a reason for each, then "Scan the code on your computer", then Medallion pairing, then done.
- QR scanner in the app (ML Kit barcode, runs on the phone, no internet).
- A plain WireGuard mode in `panvpn.aar`, with the same local proxy the app already uses, so the rest of the app barely changes. This mode needs no Android VPN, so no VPN consent dialog. Play Store rules restrict apps that use Android's VPN service, so check whether the current fake VPN (`PanVpnService.kt:71-79`) can go entirely.
- Remove the owner constants (`HubLocator.kt:52-61`, `PanVpnService.kt:204-205`, `Constants.kt:34`, `PanVpn.kt:26,174`, `ResistanceClient.kt:27`).
- Mobile page (`service/public/mobile/index.html`): cut 13 tabs down to Talk, Memory, Devices and Settings, with the developer tabs behind a switch. Fix "+ Add Device": it asks for 24 hours, but the server reads `ttl_minutes`, so the code lasts 30 minutes.
- A release signed build on the Play Store internal test track first.

### 5. Medallion setup mode

Firmware, built on a dev board until the 5 units arrive.

- **First plug in:** a USB drive (TinyUSB mass storage, a 4 MB FAT part of the flash) holding PAN Setup and a short read me. Alongside it, a USB serial port for updates and recovery; the chip's own USB serial can't run beside the drive.
- **Screen:** the steps in big text, the Play Store QR, tap to go on.
- **Pairing:** Bluetooth secure pairing as above. Recovery is holding BOOT (SW1) and the power key.
- **Screens without hardware** (owner's idea, 2026-11-08): build the Medallion screens with LVGL (MIT), which runs in a window or a web page on a PC. Test them in Firefox with the WOE test framework's screenshots, and open the same page on a phone or the iPad to try touch. The same screen code then runs on the Medallion. The owner's ESP32 (no screen) tests the USB drive and Bluetooth pairing parts. The Flipper Zero is no use here.
- **The rest of the firmware** (screen driver, sound, camera, battery, flashlight) is its own plan. The only thing that tests the real screen driver before the 5 units arrive is a Waveshare ESP32-S3-Touch-AMOLED-1.75 (same screen, touch and power chips). Optional; buying one needs the owner's yes and a live price.

## Order of work

| # | Work | Size | Needs the owner |
|---|---|---|---|
| 0 | Decisions and sign ups | Small | Ship model: Liquid, decided 2026-11-08. Still open: Microsoft Artifact Signing ($9.99 a month, identity check for the owner's company; about $220 a year together with Apple's fee, agreed), Google Play developer account, where the release signing key lives |
| 1 | PAN Link: pan-link on the hub, plain WireGuard in the phone, pairing QR, hub on localhost only, device keys, port opening, Pkarr, Tailscale fallback (commit the fallback key handout from the hub) | Big | Router test steps |
| 2 | PAN Setup for the hub | Big | |
| 3 | Phone first run and cleanup, Play Store test track | Medium | Play account |
| 4 | Medallion setup mode: screens in the LVGL simulator, USB drive and pairing on the owner's ESP32 | Medium | Which computer the ESP32 is on |
| 5 | Updates for hub, phone and Medallion | Medium | |
| 6 | Full test on a fresh Windows machine | Medium | OK for a test VM |

Later: macOS and Linux hubs, the iPhone app.

Progress (2026-11-08, step 1). Details and test list: `pan-link/README.md`. pan-link itself is not installed on the real hub yet (one test run there, removed afterwards).

- Done in `pan-link/`: the WireGuard core, the hub forwarder, pairing by QR text (one time key, swapped for the device's own key through the tunnel), the client with a local port for apps, saved state, and the `pan-link` program (`hub`, `code`, `pair`, `client`, `probe`). Router port opening is written (`--open-router-port`, off unless PAN Setup turns it on after the person agrees; the forward is dropped when the hub stops).
- Done on the PAN side: `service/src/pan-link-auth.js`, checked in `server.js` before every other `/api` route, the auth routes included. PAN trusts the device id only with the secret from `link.json`, and with no `link.json` nothing changes. A new `link.json` or a new secret works at once. `GET /api/v1/auth/me` returns `link_device`, so a device can confirm PAN sees it as itself. Port 7777 is still open to the network until the Tailscale fallback comes in through pan-link.
- Devices try every hub address at once, so the dead ones (home addresses when away, IPv6 that the router blocks) cost nothing and the Tailscale address at the end of the list is reached at once.
- Tested: 19 Go tests in `pan-link`, 6 for the phone's link code and 17 PAN side tests pass. Real network runs on the owner's Linux PC passed: pairing worked, PAN saw the real device id when the device forged one, the tunnel port was not reachable from outside the tunnel, a used code was refused, and with three dead addresses in front of the live one the device connected in 52 ms.
- Tested in front of the dev PAN (port 7781) on one computer, 2026-11-08: 24 of 24 checks passed. PAN named the paired device on `/api/v1/auth/me`, forged headers were refused or replaced, the dashboard page, a big download and a WebSocket all went through, the device came back on its own 12 s after the hub restarted, and an unpaired device lost access at once. Through the link a call took 1 to 2 ms longer than straight to PAN.
- Tested on the real hub, 2026-11-08, after the owner added the firewall rule for UDP 41720: a device on the home network paired in 732 ms and reached the real PAN through the link 193 ms after it started. `/health` took 4.8 ms through the link and 4.5 ms straight over Tailscale. The home address and both Tailscale addresses worked one at a time; a Hyper-V virtual adapter address did not, so pairing codes should leave virtual adapters out. Unpairing cut the device off. The real PAN there did not have the PAN side changes yet.
- Fixed after that run: pairing codes leave out virtual machine and container adapters (checked on the real hub: the Hyper-V address is gone), and after a restart the hub starts the handshake to each device's last address itself, so a device that stayed connected is back in about 1 s instead of 12 to 16 s.
- Fixed: a link used to stay on a dead path for good (a phone leaving home Wi-Fi). Every new handshake now goes to all of the hub's addresses, so the link moves about 1 s after the app reports a network change, or about 16 s on WireGuard's own retry.
- Phone done, tested on the owner's Pixel 10 Pro (Android 17) on 2026-11-08 against pan-link on the real hub: paired from a `pan://pair` link in 2.4 s, PAN named the phone, and the app switched to the link by itself. On home Wi-Fi requests took 22 to 54 ms, the same as the app's Tailscale proxy. With the home address taken out of the pairing, the link went through the app's own Tailscale (31 ms on a direct path), which is the way in from outside a CGNAT home. Network changes reach the link at once, and a handshake WireGuard sent into a dead network is resent on the new one. A `pan://pair` link only asks; nothing pairs until the person taps Pair. Mobile data could not be tested: the phone's mobile data failed, and the app's Tailscale timed out on it too. The program also runs on Android 10 (pairing 1.3 s), but the app needs Android 12. Details: `pan-link/README.md`, "Phone run". App 0.4.93 shows a PAN Link status line in Settings and sends the link's events to the hub's log.
- pan-link installed on the real hub for good (2026-11-08, owner's yes): a `PAN-Link` scheduled task starts it at boot as SYSTEM beside `PAN-Hub`, from `pan-link\` next to PAN's data folder, and its launcher restarts it if it stops (`pan-link/windows/`). After a restart through the task the phone was back in 1.2 s. A real reboot is not tried yet.
- Not done in step 1: the Pkarr address record in pan-link, the reachability check, moving 7777 to 127.0.0.1 (after the PCs use the link), a QR scanner and a link status line in the app, a phone test on mobile data, and dropping the app's VPN (it blocks IPv6 for every app on the phone while it runs).

PAN Link goes first. Everything else sits on it, and it closes the "anything on port 7777 is the owner" hole. The owner's own devices move off Tailscale last, one at a time, with Tailscale still running underneath until each one works.

First test inside step 1: Pkarr lookup speed and relay availability from the hub and from a phone on mobile data. If it is slow or unreliable, the fallback for finding the hub is the router's own dynamic DNS where it has one. Done from a PC on 2026-11-08: all three public relays answered, publishing took 4.4 s (37 DHT nodes stored it), lookups took 73 to 203 ms, and a lookup for a record that doesn't exist took 2.6 to 4.5 s. Still to do: the same from a phone on mobile data.

## How we test it

- **pan-link on its own.** Two copies in one test, one as hub and one as phone, make a tunnel and pass PAN traffic. Wrong keys are refused, and a used one time key is refused.
- **Dev hub first.** Port 7781 first (test before deploy rule), then the real hub.
- **Phone side.** Android emulator or the Pixel 6, with builds sent over the air. The owner's phone only when they hand it over.
- **Reaching the hub:**
  - phone on home Wi-Fi;
  - phone on mobile data, with the router port opened (`pan-link probe` first says which of UPnP, NAT-PMP and PCP the router answers; it opens nothing);
  - phone on mobile data behind a CGNAT home, which must use the Tailscale path;
  - router port opening turned off, which must fall back cleanly;
  - the hub on a phone hotspot, where carriers share addresses, so the fallback must trigger.
- **Fresh machine.** A clean Windows 11 VM runs PAN Setup from the bootstrap, start to finish, then pairs a phone emulator.
- **Machine rules.** No heavy jobs on the owner's laptop. Nothing scheduled 8 AM to 2 PM ET on weekdays.

## The owner's hands

- Sign ups and payments (the signing service, the Play account).
- The router setting test, and any firewall change on their real machines.
- Approving a test VM on the hub.

## Found while reading (fix soon)

- A plain text settings dump at the repo root held the Tailscale OAuth secret. It was gitignored, so it never reached GitHub. Moved to the Recycle Bin on 2026-11-08; the owner empties it and rotates that secret.
- The fallback key handout was lost on the hub (see "What exists today"). The recovered copy waits in `docs/legacy/` for the Tailscale fallback work.
- Invite tokens starting with `dev-`, and the token `local`, are always accepted (`client-manager.js:67,74`).
- `hub-crypto.js` `deriveSharedSecret` is a hash of two public keys, not a key exchange. Do not use it for pairing.

## Found while testing (2026-11-08, dev PAN run)

- **The device push WebSocket (`/api/v1/device/push`) never delivered.** PAN uses it to send spoken replies and voice actions to the phone (`DevicePushClient.kt`). On a single process PAN (dev), `terminal.js` wrote a 404 onto the connection right after the handshake. On the hub the Super-Carrier accepts the socket, the Carrier answered its inner connection with a 404, and the Super-Carrier retried every 100 ms (about 9 log lines a second) for as long as the phone stayed connected. Checked on the hub: the socket opened in 13 ms and nothing came back in 6 s. Fixed 2026-11-08: the push handler marks its socket so `terminal.js` leaves it alone, and the Carrier passes the push path through to the primary Craft and closes it when the Craft changes. Tested on the three layers on spare ports with the dev data: before, nothing came back and 56 retry lines in 6 s; after, connected and answering in 13 ms, and the same phone socket reached the new Craft 1.3 s after a Craft swap.
- **A database from before 2026-09-01 failed to start** (`no such column: project_name`): the schema indexes two `episodic_memories` columns that had no upgrade step. Fixed in `db.js`'s pre-schema list. Restoring an old backup would have hit this.
- **Routes registered before the login check had no auth, and their file paths could be bent.** Screenshot upload, latest, view and list, `clipboard-image`, `setup-status`, `system-check`. Confirmed on the dev PAN: `screenshot/view` with `..\` in the path read `C:\Windows\win.ini`, and `screenshot/upload` (through `source`) and `clipboard-image` (through `mimeType`) wrote files outside their folders. The hub runs PAN as SYSTEM. Fixed 2026-11-08: the routes run the same login as the rest of `/api` (`apiAuth` in `server.js`), and names and paths go through `service/src/safe-files.js` (7 tests). After the fix all three were refused or kept in their folders, and in token mode the routes answered 401 to a home network caller like every other `/api` route.
- **The login itself is open by default.** `auth_mode` is `none` unless set to `token`, and then every caller who reaches 7777 is the owner. On the hub today only the tailnet reaches 7777: its home Wi-Fi is marked Public, and the "PAN Hub 7777" firewall rule covers Domain and Private only. Moving 7777 to 127.0.0.1 behind pan-link is the real fix.
- **For the phone step:** the push WebSocket takes any `device_id` with no auth, so it should take the device from pan-link instead. Requests through pan-link arrive from 127.0.0.1, so the middleware that registers phones by `X-Device-Name` (it skips local callers) won't see them; register from the link's device id.

## Sources

- [Headscale official install (Linux packages only)](https://headscale.net/setup/install/official)
- [tsnet package (ControlURL field)](https://pkg.go.dev/tailscale.com/tsnet@v1.44.3)
- [Claude desktop extensions (.mcpb)](https://www.anthropic.com/engineering/desktop-extensions)
- [ChatGPT connectors need a public HTTPS server](https://designrevision.com/blog/add-mcp-server-to-chatgpt)
- [Pkarr](https://github.com/pubky/pkarr)
- [wireguard-go netstack example](https://git.zx2c4.com/wireguard-go/plain/tun/netstack/examples/http_server.go)
- [Microsoft Artifact Signing pricing](https://azure.microsoft.com/pricing/details/artifact-signing/)
- [CGNAT explained (Nextcloud forum)](https://help.nextcloud.com/t/what-cg-nat-is-how-to-detect-it-why-it-is-bad-what-can-you-do-about-it/201908)
- [ESP32-S3 USB drive example](https://components.espressif.com/components/espp/usb_device/versions/1.4.0/examples/msc_example)
- [LFM licence](https://www.liquid.ai/lfm-license)
- [Tailscale portmapper (BSD-3)](https://github.com/tailscale/tailscale/tree/main/net/portmapper)
