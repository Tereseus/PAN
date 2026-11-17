# PAN Product Map

Started 2026-11-06 from the Mint PAN thread. This is the running list of what PAN is as a product: what exists, what is partly there, what is missing. Add features here when the owner names them. docs/FEATURES.md stays the spec of what is already built.

Status: **Works** (running today), **Part** (some of it exists), **Missing** (design or idea only).

## The plan

How it fits together:
1. **You talk to the phone or the Medallion.** Those are the only two ways in.
2. **The phone does the fast work:** hearing, end of turn, translation, the voice.
3. **The computer at home holds the brain:** memory, the database, Intuition, recall, and a thread relay to your other computers.
4. **Four programs do the fixed jobs, not the LLM:** Intuition (what is going on, who probably said what), Turn (was that to me, is it finished, what kind of line), Translation, Recall (search the database). The LLM only does what needs language.
5. **Each computer has its own thread,** and the relay sends a spoken job to the right one, which uses computer use to do it.
6. **You need an AI account.** Owner's decision: PAN is sold to people who already use AI. Claude is the only one that works for computer control today.

Build order:
1. One thread per computer. Done, using the PC Stuff threads.
2. Speed: translation to 0.7 s, then replies.
3. Voice yes for approvals. The hook and phone buttons work now.
4. Turn and Recall as their own programs.
5. Two devices in one room.
6. Auto backup.
7. Install path, hub first.
8. Medallion audio on the phone, when the hardware arrives.

Back burner: try alexei-led/claude-router and keep it if it is worth it.

## While waiting for the Medallion (from 2026-11-07, about a month or more)

The 5 units wait on screen and camera drawings and PCBWay's answer. Work that needs no device, in order. Size: small is hours, medium is a few days, big is a week or more.

| # | Job | Why now | Size |
|---|---|---|---|
| 1 | Web search that works | It failed in use. Search sites block the hub (see the web search note), so only news and Wikipedia work. Fix: hard or web questions go to the owner's own AI, which has search built in. | Small to medium |
| 2 | Hard questions and tasks go to a big model | Same handoff as 1. PAN keeps memory, translation and the fast replies; the big AI does long answers, web, ordering, computer use. | Medium |
| 3 | Check Anthropic's terms for driving a customer's subscription | Can stop a launch (see below). Decides whether PAN drives the AI or the AI app connects to PAN over MCP. | Small |
| 4 | Home Assistant on the hub, then the owner's Tapo devices | HA's TP-Link integration covers many Tapo devices; check his models. Gives smart home control without building it. | Medium |
| 5 | Auto backup | Launch blocker: one copy of the database on one SSD. | Medium |
| 6 | Older people features | Reminders for pills and appointments, "call my daughter", read a letter or label out loud with the camera, help signal, captions for hard of hearing. Fall detection waits for the device (the board has an IMU). | Medium each |
| 7 | Translation into earbuds | You hear the other person privately in your ear, they hear you from the Medallion. Phone side only. | Small to medium |
| 8 | Signup page with a link per site (Reddit, X, TikTok, YouTube) | Counts interest before the Kickstarter. No product photos until real units exist. | Small |
| 9 | Diagrams: how translation works, how to use it | For the page, the campaign and the manual. Diagrams are fine; photo like renders are not allowed on Kickstarter. | Small |
| 10 | Install path and pairing | Needed before anyone else can use PAN. Biggest job here. | Big |

Later: users, groups and organisations (routes/orgs.js exists, not needed for one owner). Needs the device: Medallion audio path, sound tuning, firmware, the photo shoot (owner may hire a photographer) and the campaign video.

## What the product is

| Thing | Status | Notes |
|---|---|---|
| Translator | Part | Runs on the phone with no hub and no LLM. Models are on one phone only, copied by hand. |
| Conversation | Works | Target 0.7 s or better. See Speed below. |
| Second brain | Works | Every conversation stored and searchable. PAN can find what was asked, not always what Claude answered (REBUILD-REVIEW change 4). |
| Control your computers | Part | Thread relay reaches every Claude desktop thread on the G16 and the Mint, and spoken jobs go to each machine's PC Stuff thread. Screen control through it is not tested yet. |
| Smart plugs and home devices | Missing | docs/HOME-ASSISTANT.md says use Home Assistant for devices, not rebuild it. Computer use cannot reach a plug. |
| Any AI, not only Claude | Part | PAN's MCP server at /mcp/pan works for any client that speaks MCP. The relay only works with Claude desktop. |
| Medallion and Ring | Part | Board and case designed, quotes in progress. Phone app has no Medallion audio path yet. |

## Tiers: who needs a computer

Interpreting already runs on the phone alone. The second brain does not: memory, the encrypted database and always on capture need a computer at home. Without one, PAN is a translator, not PAN.

Owner's decision: you need an AI account to use PAN. The on-phone interpreter is the one part that runs with none.

Likely first buyers are programmers. Someone less technical gets it set up by a relative, which is the case for selling a preinstalled mini PC (PAN Hub) later.

| Tier | Needs | Gets |
|---|---|---|
| Interpreter | Medallion plus a phone | Translation, no account, no hub, works offline |
| Full PAN | Above plus a computer at home | Memory, conversation, control of your machines |

Open: which phones are fast enough. Only the Pixel 10 Pro is measured.

## What computer you need

Measured on the current hub unless marked. Do not treat this as final until the voice work settles.

| | Minimum | Better |
|---|---|---|
| CPU | Ryzen 7 5800H class, 8 cores (measured) | Same |
| RAM | 32 GB (hub has 29 GB usable, 13.5 GB free while running) | Same |
| Graphics card | None | 8 GB NVIDIA |
| Disk | 256 GB SSD, an estimate. DB is 11.3 GB after 8 months of heavy use, models 11.7 GB | 512 GB |
| First spoken chunk at the hub | 0.30 s warm, worst 1.04 s | 0.19 s, worst 0.81 s (RTX 4070 Laptop) |
| Whole gap, estimate | about 1.1 s | about 0.65 s |
| Always on | Yes | Yes |

Still to measure: a weaker CPU (16 GB, 4 cores) to find the true floor, and the gap end to end with voice 3.

## Speed

| Path | Now | Target | Next step |
|---|---|---|---|
| Translation | 0.3 to 0.75 s on the bench with Android voices. About 1.0 to 1.4 s with voice 3, worked out from parts, not timed. Chinese through the hub: 1.34 s on a live line | 0.7 s | First clause speaking built in app 0.4.76, not yet timed on a phone. Next: time it, then check it sounds right |
| Reply | About 1.5 s felt on real turns, with the G16 GPU | 0.6 to 0.7 s | Send audio while the person talks, then early start |

## Own programs, not the LLM

Rule: if a job has a fixed answer shape, it gets its own program and the LLM only does what needs language.

| Program | Status |
|---|---|
| Interpreter | Works |
| Intuition | Works |
| Thread relay fast path | Works |
| Voice process, first in line for CPU | Missing, REBUILD-REVIEW change 3 |
| Turn labels (addressed, intent, camera) | Missing, still written by the model |
| Recall, target 1 s from 3.5 s | Missing, keyword only and goes through a model |
| Actions (timers, notes, device commands) | Missing, REBUILD-REVIEW |
| Who is talking (speaker embedding) | Missing, extractor already in the AAR |
| When PAN may speak | Part, Intuition should decide |

The Carrier and Craft are not a speed feature. They let server code reload without dropping sessions, so they matter for updates, and users never see them.

## Two devices in one room

Owner's requirement: two people with devices must not interrupt each other. There are two separate problems.

**Radio:** each Medallion bonds to its owner's phone, so nothing else can connect to it. Normal BLE bonding. Peers find each other with the rotating token in docs/BLE-MESH.md Mode 2, which strangers cannot read.

**Sound, the hard one:** my mic hears your voice and your device's speaker, so each device can translate the other's output in a loop. Plan:
1. Decide "that was my wearer" by loudness first. The mouth is about 20 cm from the Medallion and another person about 1 m or more, roughly 14 dB louder (calculated, not measured). No voiceprint needed.
2. The two mics sit side by side (MK1, MK2 in layout.py), so they can reject sound from the sides. They cannot separate the wearer from someone straight ahead, so loudness has to do that.
3. A voiceprint helps, and Intuition adds context: who is here, who was talking, what the topic is, so it can guess who said what. The voiceprint is a short list of numbers from a few seconds of speech, no training run, and it stays on the owner's phone. It is never sent to another device and never used to unlock anything.
4. When two PANs see each other, they agree a session over BLE.
5. In a session, send the words as text, signed with the sending device's key. The key proves who sent it, not the voice, so a copied voice gets nothing. Each device translates for its own wearer and speaks or shows it.
6. A device goes quiet on its own mic while the peer is playing.

Test with the Pixel 10 Pro and the Pixel 6 and recordings. No native speaker needed. The Pixel 6 also gives a first reading on an older phone.

## Medallion speaker

Owner's live test on 2026-11-06: the phone crackles when it is very loud, and that was very noticeable. It did this on the call path too, before interpreted lines moved to the media path.

**What the phone does.** Same test line, saved recording, both mics, media volume 20/25 to 25/25: S sounds rose 7 dB, the loud vowels under 1 dB, and the high sound inside vowels 9 to 10 dB, about 3 dB more than the volume step. The mics were not the limit: almost no samples came near full scale. So the speaker path is at its limit on vowels before 20/25, and the last steps add grit. That is probably the crackle, but it is one line and nobody has matched it to what the owner hears. Use the same test on the first Medallion. Interpreting stays at 25/25.

**First run as designed.** NS4150B on the 3.3 V rail. The 1.3 W in the BOM note is only true into 4 ohm. Every part found in this size is 8 ohm, which gets under 0.7 W (worked out from the supply; the datasheet table could not be read). That is below the parts' 1 W rating, so the amp cannot overdrive them. The speaker is not chosen: it is an off-board part on a GH1.25 lead that the maker sources. The case pocket is a placeholder of about 11 x 15 x 3.5 mm, and the sound leaves through slots in the rim.

**Parts that fit that pocket exactly** (15 x 11 x 3.5 mm, 8 ohm):

| Part | Level at 1 W, 10 cm | Notes |
|---|---|---|
| Ole Wolff OWS-111535LA-8H | 99 dB | DigiKey listing only, the datasheet link is dead. 670 Hz. 1 W, 1.3 W max |
| Same Sky CMS-151135-18S-X8 | 97 dB typical, 94 to 100 | Full datasheet, 1 cc box. 950 Hz. Spring contacts, 1 W, 1.3 W max |
| PUI AS01508AO-3-SC-R | 94 dB listed, conditions unclear | 0.7 W, 1 W max |

Same Sky's curve at full rating: about 1% distortion above 1.5 kHz, 3.5% at 1 kHz, 6% at 500 Hz, 15 to 20% under 300 Hz. At 200 Hz it is 30 dB down on 1 kHz, so those lows only cost distortion. No 15 x 11 part deeper than 3.5 mm turned up, though the case has 9.6 mm between the speaker and the board. No 4 ohm part in this size turned up either.

**Against the phone (estimate).** Bandicoot Lab measured the Pixel 10 Pro at 75.6 dB with pink noise, 40 cm, full volume, and 6.5% average distortion. Same Sky's curve run through that test, cut under 300 Hz, under the 3.3 V limit: 72 to 75 dBA for the 97 dB part, 74 to 77 for a 99 dB part, 69 to 72 for a 94 dB part. Nothing here is measured, and none of it allows for wearing it on a chest.

**Air behind it.** The case holds about 20 cc of air behind the speaker (41.7 cc behind the board, less battery, speaker, posts and board parts). The specs use a 1 cc box. Estimate: resonance falls from about 950 Hz toward 700 Hz, about 3 to 6 dB more low voice. This assumes the case seals. The speaker's Vas is not published.

**To do:**

- Before ordering, ask for the Ole Wolff part, or Same Sky if it cannot be had. These have spring contacts or pads, so the maker has to add the GH1.25 lead. It plugs in, so this needs no board change. Update 2026-11-07: the v4 copy uses OWS-121733TA-8 instead (12 x 17 x 3.3, 99 dB, 600 Hz, solder pads), the biggest size that fits beside the battery, and runs the amp from the battery.
- Before ordering, add a double sided foam gasket between the speaker and its ring. Nothing in the CAD holds the speaker, and the only seal is printed resin against the speaker face, which is likely to leak and buzz. The speaker has nothing behind it for 9.6 mm.
- In firmware, cut under about 300 Hz and limit just below where the amp clips.
- Second product version: a boosted smart amp is the bigger step. Maxim claims up to 2.5 times the loudness of a plain 5 V amp (vendor claim, 2019). A bigger speaker changes the case. (This is not the CAD's v2 or v3, which are case drafts.)

## One thread per computer

Owner's design: every computer has one thread that is that computer's own, and the relay is how you reach it. You say "on the Mint, play this video" to the phone or Medallion, and it goes to the right machine. The jobs are open ended: play something, check messages, whatever Claude can work out on the fly with the tools and MCPs it can reach.

Live since 2026-11-06 (Craft 69). These are the existing PC Stuff threads, Mint PC Stuff and G16 PC Stuff: the target is the thread on that host with PC or Computer in its title. Three ways to say it: "on the mint open firefox", "open firefox on the mint", "tell the mint to open firefox". Tested end to end on Mint PC Stuff: a labelled test job made a file and answered in 25 s. Not yet tried with screen control (computer use), or by voice from the phone.

Limit: a new connector that needs a sign in needs a person at a screen once.

Weak spot: the relay's wait loop lives in a Claude thread, so anything that restarts that session stops it. The G16 has a keeper. The Mint has none.

## Voice approvals

Owner's idea: Claude works out the job and people just say yes.

Allowed: Claude Code's PermissionRequest hook is a documented way for an outside program to answer allow or deny, and nothing says approvals must come from the local screen.

Working since 2026-11-06 (Craft 71), on the G16: a prompt nobody answers for 30 s shows on the phone as a notification with Allow and Deny, and on the /mobile page and dashboard. The hub waits up to 110 s for that tap. Claude Code's own prompt stays up the whole time, and if nobody answers it just stays there. Claude's questions to you never go to the phone, because they need your words. Tested on the live hub with fake requests. A real G16 prompt and the phone's notification are not confirmed yet.

Before this fix, anything left unanswered for 30 s was denied, including Claude's questions (44 of the 121 calls checked), and the buttons could not work. That is what refused the daily brief on Nov 5 and 6.

The Mint does not have the hook yet.

Voice yes, not built:
1. Hub says the request out loud in plain words.
2. A yes or no line answers the hook directly. It cannot be a relayed chat message: threads are told a message from another thread is never an approval.
3. A TV or someone else can say yes. So plain yes for harmless things. Deleting, spending or sending needs the Medallion button or a tap on the phone.

## Auto model switching

Owner's idea: don't spend Opus at high effort on easy computer jobs.

Two layers:
1. **Pick the model per computer thread.** A person sets it in the thread's menus. Most computer jobs do not need Opus.
2. **Change it per turn.** alexei-led/claude-router (MIT, updated 2026-11-05) is a Claude Code Mod that picks model and effort on each turn. It has an Ollama classifier, so prompts can stay on your own machines. It needs Claude Code 2.1.289 or newer. Not tested, and not known to load in the desktop app. Its own README says savings are not measured.

Status asks already use no Claude at all, because the relay reads them from the transcript.

Others found: tzachbon/claude-model-router-hook (MIT) warns by default and only changes new sessions. musistudio/claude-code-router (MIT) routes to other AI providers. The 0xrdan plugin is gone: its page and repo no longer load.

## Install path

| Piece | Status | Notes |
|---|---|---|
| Phone app | Part | Debug APK, OTA from your own hub. No store listing. Play Protect warns on it |
| Phone network | Works | panvpn.aar embeds Tailscale (tsnet, WireGuard inside the APK). No separate VPN app on the phone |
| Phone models | Missing | 3.4 GB copied by adb. Needs a download path, or other phones stay on the slower hub route |
| Second PCs | Part | service/installer/pan-installer.cjs joins a PC to a hub by invite link, QR or discovery |
| The hub itself | Missing | No one click install. SHIP-PLAN Phase 3 is not built, and it says no Tailscale, which conflicts with the Tailscale by email rule. Decide this first |
| Hub network | Part | Tailscale is installed by hand. Option: embed tsnet in a small helper so the hub also needs no separate install |
| Pairing | Missing | Scan a QR on the hub: phone gets its own key and joins. REBUILD-REVIEW change 1 |
| Medallion pairing and firmware updates | Missing | |
| App update from a nearby device | Idea (2026-11-17) | A car unit or tablet on the phone's hotspot takes the new app straight from the phone, which already holds the same file, in place of pulling 90 MB from the hub over mobile data. Both must be paired to the same hub and the file checked against the hub's hash. Came from the car failing to update on the old updater |

**Full plan: docs/INSTALL-PLAN.md (2026-11-08).** Phone app cleanup (tabs, settings, one look): docs/MOBILE-APP-PLAN.md (2026-11-16).

**Owner's install flow (2026-11-07):** out of the box, plug the Medallion into the computer; PAN downloads and installs; the Medallion screen shows a QR for the phone app; no login because everything is local; Tailscale and WireGuard set up on their own; the installer plays short videos on what PAN does while it works. Owner wants this as the spine of the work while waiting, with the phone app cleanup inside it.

What has to change to make it real:
1. A plugged in device cannot start an install on its own: Windows and macOS block that for safety. Closest real version: the Medallion shows up as a USB drive with one installer on it, and its screen says "open PAN Setup" (or shows a link). One double click.
2. The installer needs a code signing certificate, or Windows and macOS warn that it is unsafe. Yearly cost.
3. The phone app needs a Play Store listing for the QR to open it.
4. No login means PAN cannot use Tailscale accounts: Tailscale needs one per user. Owner does not want PAN running a connection server (liability: whoever runs it decides which devices may join a network). Proposed instead: PAN Setup puts plain WireGuard on the person's own computer, opens the router port automatically (UPnP) and pairs the phone by QR. Homes whose internet blocks incoming connections (carrier grade NAT, some routers) cannot be reached that way; for those, fall back to the person's own Tailscale with one Google sign in. Not decided.
5. The big AI is the one login left: the person signs in to their own Claude (or ChatGPT) once, and that app connects to PAN.

Personality (owner, 2026-11-07): the small model is fast but sounds generic and not personable next to Claude. Tone can be trained into a small model (Syrinx fine tune data, persona prompt, using what memory knows about the person); depth cannot, so long answers go to the big AI.

Check before selling: Tailscale's terms for a product built on customers' own free accounts, against self hosting Headscale.

## Ideas to add

Ordered by what they do for the product.

1. **Read signs and menus:** camera plus the translator. The obvious second use for travel.
2. **Live captions for deaf and hard of hearing people:** the same ear in one language. The wearer cannot read their own chest, so captions go on the Ring (it faces the wearer) or the phone. A real market, and a stronger Kickstarter story.
3. **"Say that again" and "what did they say":** replay or summarise the last talk after a translated conversation.
4. **Translate phone calls:** same loop on call audio.
5. **Where did I leave it:** search of camera frames from the day.
6. **Remind me when:** tied to a place or a person, not a time.
7. **Help signal:** docs/BLE-MESH.md already has an "I need help" message. Add fall detection from the IMU if the board has one.
8. **Proactive pings:** PAN watches something and asks by voice (project voice work loop).
9. **Flashlight (owner, 2026-11-07: necessary):** a good white light on the Medallion, hands free, on by voice. Designed on a copy, hardware/medallion_v4: LED and constant current driver on the board's screen side beside the camera, light through a tapered bezel hole. Board checks pass. Nothing built or sent to a vendor. Heat and brightness are estimates. Rule for adding parts: does it have to be on the chest, hands free? The light does. A better camera does not.
10. **Aiming laser dropped for now (owner, 2026-11-07):** a dot only helps if the wearer can see it, and a visible one is not worth the safety and paperwork yet. To try instead, with no hardware: point a finger and let the camera see it.
11. **Slang in the translator (owner, 2026-11-07):** train the ear and the translator on slang and African American English, and review bad lines after a talk so they feed the training. People speak naturally; they should not have to pick safer words. The Conversations page does not have this review yet; it was meant to.
12. **Jewelry line (owner, 2026-11-07):** swappable covers and small pieces of jewelry that work with the Medallion. No lock-in: the open PAN protocol is the point, the brand earns repeat buyers by being the most reliable, and better ideas from others get copied.
13. **One computer, screens anywhere (owner, 2026-11-17):** the hub does the work, the phone or the pendant is the microphone you always carry, and any screen in the house can be told by voice to show what needs showing: a page, an answer, a video. No second computer and no speech model per room. It is casting, not gaming: pages and video do not need a cable. A screen needs only a browser or a cast stick. Not researched yet: which casting way to build on, and how a screen is named and picked by voice. Follows from this: a client PC gets no speech model (the hub hears for every device), and a PC with no phone nearby could send its own microphone to the hub the same way the phone does. Not built; whether that is always on or push to talk is open (the owner is unsure about always on).

## Other people's devices (owner, 2026-11-13)

ΠAN is the hub: the brain and memory things plug into. It is not a radio standard like Bluetooth; it uses Bluetooth, WireGuard and MCP. Already built: pan-link pairing with limited devices (allow lists), the app's own Tailscale with keys from the hub, the pendant over Bluetooth through the phone, client approval, orgs and roles, and Home Assistant on the hub (docs/HOME-ASSISTANT.md). New, in order:

1. **xiaozhi boards (parked 2026-11-13, owner: it overlaps the phone and pendant path that already exists; see docs/FEATURES.md):** MIT licensed ESP32 voice firmware that runs on 70+ cheap boards (Waveshare and others) with a screen, mic and speaker. It already speaks MCP and lets the owner change its server. Add a door on the hub that speaks its format (Opus audio and JSON over a WebSocket, plus the setup call a board makes first) and feeds the same voice turn the phone gets. Each board pairs as a limited device. No ports opened and nothing public (owner, 2026-11-13: a regular person can't add firewall rules): boards join PAN Link as limited devices, like phones and PCs do, which needs WireGuard in the board's firmware (a PAN build of xiaozhi). Not built. Tailscale Funnel was looked at and dropped: each owner would have to switch it on in their own Tailscale account, and it makes the hub public. **Built 2026-11-13** (`service/src/xiaozhi-server.py`, details in docs/FEATURES.md "xiaozhi boards"): pairing by a code on the board's screen, owner or guest level, PAN's own ears and voice. Tested on the Mint with a fake board (`service/scripts/xiaozhi-fake-board.py`) against the hub's PAN in bench mode: PAN's voice starts about 1 s after the line ends. Owner calls moved to a port only the hub itself can reach, before any public address. Next: the PAN Link path for boards, tried first on the owner's own XIAO ESP32-S3.
2. **Car OBD (owner's Toyota):** the phone reads the OBD plug over Bluetooth whenever it sees it (speed, rpm, fuel, temperatures, fault codes) and sends it to the hub, which keeps it and gives MCP tools. Test with an OBD simulator, then one drive. Needs the plug's make and model.
3. **CAN for machines:** the Node's ESP32-S3 has CAN built in and only needs a transceiver chip. Prove it listen only on the Toyota's OBD port (an ESP32-S3 board, a CAN transceiver, an OBD cable); comma's opendbc says what Toyota's messages mean. Then an off the shelf mikroBUS CAN board in a Node slot. Trucks, tractors and diggers speak J1939 on the same wires. Later: AgOpenGPS (auto steer) and openpilot style bridges. Rule for anything that moves: the AI decides what, the machine's own controller decides how, and a safety chip with a STOP line decides if.
4. **ΠAN Ready spec:** written after 1 and 2 work. How a device pairs and gets its level, the card it sends (what it senses, what it can do, its limits, like the mount and port ID chip record), and how that becomes MCP tools. Makers who follow it get listed, the Meshtastic way.

5. **Accessory slots (owner, 2026-11-14): glasses, headphones, a watch, anything else.** Android's own standard is the one that wins, so ΠAN writes no driver per brand. Built in app 0.4.103 (`accessory/AccessoryHub.kt`, Settings > Accessories): anything Android calls an audio device lands in a slot (Glasses, Headphones, Watch, Medallion, Other), and a switch makes ΠAN listen and speak through it with Android's call routing. That covers Android XR glasses (they reach the phone as Bluetooth audio), Bluetooth and LE Audio earbuds, hearing aids, wired and USB headsets. Off by default: classic Bluetooth call audio makes music on the headset sound like a phone call; LE Audio does not. Later, in order: the glasses' camera and display through Jetpack Projected (`androidx.xr.projected`, still alpha), then a Wear OS app for the watch. Brand SDKs (MentraOS, Even Realities, Meta's toolkit) only if a buyer asks.
6. **LC3 for the Medallion's mic (owner, 2026-11-14: "let's do that").** The Bluetooth LE Audio codec, liblc3 (Apache 2.0). Measured on the owner's XIAO ESP32-S3 on the Mint: 16 kHz, 10 ms frames, 40 bytes a frame (32 kbps) takes 13% of one core to encode (1.3 ms average, 1.8 ms worst per frame), decode 2.7%, about 3.6 KB of memory. Twice the quality per byte of the pendant's IMA ADPCM (64 kbps), and the same format as LE Audio earbuds and the Even G2. Phone side: liblc3 decoder in the app beside PendantMic. Still to measure: words heard right through LC3 at 16, 24 and 32 kbps against raw, on the hub's Parakeet.

Looked at and not needed: Tailcat (Tailscale's data plane without an account, Aug 2026). The app's own Tailscale already works everywhere.

## Pilot mode: hands and eyes busy (owner, 2026-11-14)

Working with ΠAN and his Claude threads by voice alone, when the screen is off limits: driving, construction, plumbing, wiring, any manual job. Not only code: physical jobs too (wiring a power box, which wire goes where, a solar install), each job its own thread. The point is everyone's use, not his car: a worker on a site asks "what does this do", ΠAN sees it through the pendant camera and walks him through it step by step. Buttons are only the input: any button Android already knows (a car's steering wheel voice button, a headset button, the Medallion's button) does the same few things, so there is no work per car. The car is where it gets tested first. His ideas, in his order:

1. **Device modes.** Pilot (driving, or hands busy on a job): voice only, nothing to read, never sent to a screen (rules like Android Auto, with a voice that actually works). Parked: touch, plus wheel buttons that scroll the page. Phone. Desk. The mode comes from the head unit's speed and ignition and the phone's motion.
2. **Conductor.** One ongoing call with ΠAN that sends his words to the right thread, reads back a short spoken summary when a thread finishes, and reads out permission prompts so he can answer them by voice. Builds on the thread relay.
3. **Drafts and send.** ΠAN builds the message, reads back one line, and sends on "send" or a wheel button. Simple things (status, yes, which thread is done) the local model answers fast.
4. **Look at later.** Visual work (graphics; his game is 3D now) can't be judged by voice. Those go on a list for when he is parked or at a desk.
5. **Physical jobs.** One step at a time, said by colour and position; "done" moves to the next step. The pendant or phone camera lets ΠAN see the box.
6. **Which screen to show.** Start simple (the thread that last spoke) and log what he opens after each event, so ΠAN can learn to predict it.
7. **Car speech is training data.** It is how people really describe problems, and older people who can't read or tap will use ΠAN the same way. On Nov 14 the head unit's speech to text got his words badly wrong ("ivan over so i want...") and ΠAN answered it anyway. So first: the wheel button and speech to text in road noise.

**Built so far:** the wheel button (app 0.4.105, docs/FEATURES.md "Assistant button"): a press stops ΠAN talking, opens the mic and marks the next line as for ΠAN. The mic stays always on as before; the button only says "this one is for you" (owner, Nov 14: no push to talk). Round 16 of the voice model hands questions that need real thought to the bigger model.

## Things that can stop a launch

- **Backup:** the database is one copy on one SSD. A dead drive, theft or fire loses it, and a lost key makes any copy unreadable. Plan: auto backup, encrypted, to a place the owner picks by saying it (another computer, a USB drive), plus key recovery.
- **Recording law:** mostly a question outside the home and with guests. A wearable camera and mic needs a visible recording light, a real off button and consent rules per country. Interpreting that stores no audio is a much smaller risk than memory capture. Face recognition stays limited to people the owner enrolled. Get legal advice before launch.
- **Certification:** the board uses the pre-certified ESP32-S3-WROOM-1, which covers most of the radio work. The finished product likely still needs its own FCC and CE paperwork and labelling, and the battery has shipping rules. Check before a Kickstarter date.
- **Licences:** MODEL-CREDITS.md must reach an About page. The Greek ear is CC-BY-4.0 but was trained on podcasts its author does not own. Supertonic is OpenRAIL-M, check its use terms.
- **Claude dependence:** the relay reads Claude desktop transcripts and has no official API, so an app update can break it. Each user brings their own Claude account, the installer must set the relay up, and a person has to press send to start its first thread.
- **Subscription rules:** in April 2026 Anthropic stopped Claude subscriptions covering third party harnesses such as OpenClaw. Read the current terms before selling anything that drives a customer's subscription, including `claude -p` and the relay. Lower use from auto model switching helps, but does not settle this.
- **Stolen device:** BLE-MESH has a design, not built.
