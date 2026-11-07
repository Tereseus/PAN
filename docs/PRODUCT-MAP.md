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

- Before ordering, ask for the Ole Wolff part, or Same Sky if it cannot be had. These have spring contacts or pads, so the maker has to add the GH1.25 lead. It plugs in, so this needs no board change.
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

## Things that can stop a launch

- **Backup:** the database is one copy on one SSD. A dead drive, theft or fire loses it, and a lost key makes any copy unreadable. Plan: auto backup, encrypted, to a place the owner picks by saying it (another computer, a USB drive), plus key recovery.
- **Recording law:** mostly a question outside the home and with guests. A wearable camera and mic needs a visible recording light, a real off button and consent rules per country. Interpreting that stores no audio is a much smaller risk than memory capture. Face recognition stays limited to people the owner enrolled. Get legal advice before launch.
- **Certification:** the board uses the pre-certified ESP32-S3-WROOM-1, which covers most of the radio work. The finished product likely still needs its own FCC and CE paperwork and labelling, and the battery has shipping rules. Check before a Kickstarter date.
- **Licences:** MODEL-CREDITS.md must reach an About page. The Greek ear is CC-BY-4.0 but was trained on podcasts its author does not own. Supertonic is OpenRAIL-M, check its use terms.
- **Claude dependence:** the relay reads Claude desktop transcripts and has no official API, so an app update can break it. Each user brings their own Claude account, the installer must set the relay up, and a person has to press send to start its first thread.
- **Subscription rules:** in April 2026 Anthropic stopped Claude subscriptions covering third party harnesses such as OpenClaw. Read the current terms before selling anything that drives a customer's subscription, including `claude -p` and the relay. Lower use from auto model switching helps, but does not settle this.
- **Stolen device:** BLE-MESH has a design, not built.
