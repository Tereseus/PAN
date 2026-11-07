# PAN Rebuild Review

*2026-11-04. Four read-only reviewers swept the code (voice loop, server core, Intuition and
memory, devices and model serving), and the main claims were then checked by hand against the
code and the live hub. Companion to [NORTH-STAR-AUDIT.md](./NORTH-STAR-AUDIT.md), which decided
WHAT to keep. This one is about HOW it's built and what's missing. Line numbers are from the tree
on this date; "reviewer-reported" marks claims that were not re-checked by hand.*

## The picture in one paragraph

PAN grew as a coding environment with a dashboard, and voice was added on top. The north star
flipped that, but the shape stayed. The hot-swap tiers protect the dev terminal, not the voice
loop. The hub runs the full dev profile. The phone and the hub talk by polling, so nothing can be
pushed. Memory, conversation and device state each live in several copies that disagree. Regexes
stand in for model judgment. About nine background model loops share a CPU-only hub with voice,
and nothing gives way to a live turn. None of this is one bad decision: it's hundreds of sessions,
each adding to what was there.

## Fix now (small, checked by hand)

| # | What | Why it matters | Who |
|---|---|---|---|
| 1 | Port 7777 is open on the hub's Wi-Fi (Windows rule "PAN Hub 7777", profile Any, and the Wi-Fi is a Public network). Every request reaches the app as 127.0.0.1, which counts as the owner (no X-Forwarded-For: super-carrier.js:124-131; owner check: server.js:656-680). Tested: a Wi-Fi request with no login read all settings and events. | Anyone who joins that Wi-Fi can read PAN's memory and send commands to enrolled PCs. | Owner: close the rule (Decisions 1). Code: edge auth (big change 1). |
| 2 | While interpreting, "ask them ..." and "tell them ..." go to the Claude thread relay instead of the interpreter if a relay job ran in the last 15 minutes. The relay's FOLLOWUP match runs before the interpreting check (router.js ~2469 vs ~2485; thread-relay.js:441, 536-543). | The interpreter's own core phrase can land in a Claude thread. | Code, S |
| 3 | An interrupted turn (barge-in, or a new utterance) lands in routeStream's catch. It records "Sorry, I ran into a problem thinking that through" as PAN's reply and raises a voice alert (router.js:3268-3274). | Wrong conversation history and false alerts. | Code, S |
| 4 | "From now on" anywhere in a line sets a standing mode (STANDING_SET_RE, router.js:526), and the check runs before the room-talk and dictation filters. | A TV line or dictated text can lock PAN into a sticky mode for two hours. | Code, S |
| 5 | Every recall result set goes through privatizeSearch (memory-search.js:611), and privacy_enabled is 1 on the hub. Reviewer-reported: the noise is about 80x the ranking scores, so results come back in near-random order, and a failed synthesis speaks hits[0]. | "What did we decide about X" gets a random hit. The noise protects nothing when the owner searches his own data at home. | Code, S. Keep the noise only for data leaving the house. Test before and after. |
| 6 | createAlert writes org_id 1 (routes/dashboard.js:2248), and every alerts view reads 'org_personal' (allScoped, db.js:904-906). | No internal alert (steward giving up, crashes, voice failures) has ever shown on the phone or dashboard. | Code, S. Age out or clear the old ones first, or the first view floods. |
| 7 | Translator health: one 3 s probe a minute with no tolerance, and a 503 "loading" counts as down (steward.js:706-716, 779-782). Restart failures are never counted, because startFn never throws, so backoff and giving up can't engage (1143-1164). | Phantom "Translator down" alerts and pointless restarts. | Code, S. Copy the Ollama check (3 misses in 5 minutes, 784-859). |
| 8 | The dream's prompt has been a literal "..." since April (dream.js:121-124), so it writes fiction into .pan-state.md. Reviewer-reported: its readers look for that file in a different folder anyway. | Wasted CPU and a false "living state". | Turn off (Decisions 2) |
| 9 | Smart steward asked gemma4:e2b every 5 minutes (1,789 calls in 7 days, about 8 s each), and every restart it sent failed: unknown device, unknown service, or not permitted. | CPU taken from voice. | DONE 2026-11-04 (Craft 52): it asks only when concerns change, ignores its own alerts, and refuses devices that aren't trusted and online. |
| 10 | 459 duplicate firewall rules named "PAN Hub (177xx)", one per Craft boot port (server.js:6026). | Clutter, and each Craft port is open on private networks. | Code: stop adding them. Owner: delete the rules. |

Phone side (needs an app build, reviewer-reported):
- After a flashlight command, "is that one any good?" turns the torch on, because "on" matches inside "one" (PanForegroundService.kt:2077-2106).
- "The battery life of the new iPhone" reads out the phone's own battery (:2129).
- The hub compares the source to "phone", but the phone sends "phone-<model>" (api.js:1756, router.js:2508), so those gates never fire.

## The big changes

Ranked by what they'd change for the owner. Size: S a day, M a week, L more.

### 1. Lock the door: identity at the edge (M)
**Now:**
- Identity comes from the network address, and behind two proxies every caller is 127.0.0.1.
- /dashboard and /mcp/pan have no auth.
- Device trust rests on an id the device names itself.
- pan-client accepts an unsigned code bundle (pan-client.js:1186-1193).
- The 2026-08-07 exposure went through the same path (profiles.js:64-71).

**Should be:** the permanent edge (super-carrier.js) authenticates every request and socket and passes a verified identity downstream. Keys come from QR pairing (hub-crypto.js already has unused Ed25519 identity code) or from the Tailscale identity. Client updates are signed. The pendant uses BLE secure pairing.

**Owner notices:** nothing, until the day a guest's phone would have had a shell on his PCs. A consumer box can't ship without this.

### 2. One live connection per device, with an outbox (M to L)
**Now:**
- Every hub-to-phone signal is polled: approvals, check-ins, notifications, Claude replies.
- A push socket exists at both ends but is never connected ("DevicePushClient is unused", PanForegroundService.kt:945).
- The Carrier answers only four WebSocket paths, so the Craft's push route can't be reached (terminal.js:841-869).
- NOTIFY items sit in a 50-item array in Craft memory, which every deploy wipes (api.js:837-876).
- Reviewer-reported: the phone's loops add up to about one poll a second, with a wakelock held for the life of the service (PanForegroundService.kt:704).
- In the Nov 3 bench, barge-ins early and mid-reply were never detected, and a late one took 2 s.

**Should be:**
- One authenticated WebSocket per phone and pendant, held by the edge. It carries audio frames, partial transcripts, end-of-turn candidates, cancels, "played up to here" acks, approvals, notifications and PAN-initiated speech.
- A durable outbox table with per-device cursors and acks.
- An FCM wake message when the socket is down.
- On the phone, one listening/speaking state machine that decides barge-in, backchannels, and when a queued message may speak.

**Owner notices:**
- Alerts and Claude answers arrive in about a second and survive deploys.
- He can cut PAN off mid-sentence, and messages wait their turn instead of talking over him.
- Better battery.

It also unblocks streaming ASR while he talks, the pendant's audio, and NOTIFY.

### 3. Split the processes by job, so deploys can't touch voice (L)
**Now:**
- The Craft is hot-swapped several times an hour, and it holds everything voice needs: the ASR models, the conversation buffer, the phone queue, the steward and every loop.
- Each swap re-runs the full boot (a code comment records a 167 s event-loop freeze during Craft boot), and the old Craft keeps running its loops for another 30 s.
- The Carrier holds the dev terminal's PTYs.
- Five things supervise and restart processes: super-carrier, carrier, steward, claude-control and smart steward.
- Device connections live in the Carrier, while the Craft's device map is always empty (routes/client.js:127). So remote actions ("open Spotify on the desktop"), speak and mic routing, remote screens and approvals don't reach the PCs (client-manager.js:181-204).

**Should be:**
- A permanent edge that owns sockets, auth, devices and one command table.
- A small voice/API process that boots in seconds.
- One worker process holding a lease, so no loop runs twice.
- Model servers as long-lived processes.
- One real supervisor outside the app (NSSM or Task Scheduler now, systemd on a box). It holds the child handles, restarts on exit, and uses tolerant readiness checks.
- Retire the Carrier's PTY ownership, Lifeboat, and shadow/crucible/pipeline.

**Owner notices:** a deploy stops costing a slow, forgetful minute of voice. Voice control of his PCs works. No more phantom restarts.

### 4. One model host with a CPU budget, where voice goes first (M to L)
**Now:**
- Chat, embedding and vision models stay loaded forever (keep_alive -1).
- Four ASR models reload inside the Craft on every swap.
- MADLAD runs 8 threads plus a 4-thread referee, and Ollama uses every core.
- Five things decide where a model runs: an env var, a setting, per-model URLs, any device that ever reported Ollama up, and GAME MODE (db.js:1192-1256).
- About nine background model loops share the CPU, and nothing yields to a live turn.

**Should be:**
- A declared model plan per hardware tier: which models stay loaded, which load on demand, which go to the cloud.
- Priority in this order: voice, then interpreter, then interactive, then background.
- Thread budgets and unloading after idle.
- Background jobs pause while a voice turn or an interpreter line is in flight.

**Owner notices:** steady reply times. The plan also becomes the PAN Hub box's model manifest.

### 5. Let the voice model route, and give every model call a schema (M to L)
**Now:**
- About 20 regex gates on the hub and a dozen on the phone choose among nine prompts and three follow-up calls (router.js:2451-3170).
- Statements the owner tells PAN wait about 5.5 s: they're judged room talk, re-asked in the cloud, then held.
- No caller uses Ollama `format` or Gemini `responseSchema` (llm.js:135-138), so JSON is dug out of text by regex everywhere. One recorded turn went silent because gemma answered in prose.

**Should be:**
- Syrinx emits a route field right after `to`: talk, think, look, data, recall, save, remind or delegate. It's trained on today's regex and cloud decisions.
- Start logging the route and the model for every turn now. recordVoiceTurn stores neither (api.js:368-372), and that log is the training set.
- Add a `schema` option to askAI and askAIStream, mapped to Ollama `format` and Gemini `responseSchema`, then delete the hand-written extractors.
- Regex stays only for mute/stop and for prefetching data early.

**Owner notices:** quick replies to statements, fewer odd answers and fewer silent turns. A Hub with no cloud needs this.

### 6. One memory, and answers about his past must cite it (M to L)
**Now:**
- Recall searches raw events through three text extractors that disagree.
- Claude's answers never reach searchable text, so by voice PAN finds what he asked Claude but not what Claude answered (NIGHTMARE #431).
- The vector search reads every vector synchronously, in 4 to 6 s (memory-search.js:518-538), so voice recall is keyword-only.
- The guard against making things up is seven interacting regex gates (router.js:37-111, 2531-2642).
- The evals have one long-term recall case.
- Conversation memory has four copies that disagree: the phone's last 10 lines, events, conversation state and dialog state.

**Should be:**
- One `memories` table, written at capture time. Each entry is exchange-sized (his line plus the reply, a prompt plus Claude's answer, decisions, recaps, notes) and carries time, place, project and people.
- FTS5 with triggers, and qwen3 vectors cut to 256 dimensions as int8, for search in milliseconds.
- One recall() shared by voice, MCP and the dashboard, with retrieval on every final turn.
- The model answers `{response, cites}` under a schema. Code accepts a claim about his past only if every cite is a retrieved id.
- A recall eval built from his own history: real questions with known answers, plus things that never happened.
- One append-only session log on the hub, written from the hub's transcripts and from what was actually played.

**Owner notices:** "what did we decide about X" works by voice, with fewer invented answers and no freezes.

### 7. Voice actions on the main voice path (M)
**Now:**
- The streaming path only offers query, music, memory and ambient (router.js:2864-2868).
- Notes, Claude tasks, home control and the calendar live on the old handleUnified path, which the phone barely reaches.
- Timers and alarms sit in handleLocally, which nothing calls (router.js:2137-2260).
- A spoken "yes, go ahead" has nothing tying it to the thread that asked.
- The old prompt still lets a model write a PowerShell command that pan-agent.ps1 runs with Invoke-Expression.

**Should be:**
- One action registry the streaming path can call.
- A spoken confirmation before anything with side effects.
- An "awaiting answer" link from a spoken message to its thread or job.
- Delete the PowerShell intent.

**Owner notices:** "set a timer", "remember this" and "tell Claude yes" actually happen. That's job 4 of the north star.

### 8. Intuition: situations and one speak/notify policy before the next retrain (reorder S, work M to L)
**Now:**
- Syrinx gets state only when a regex matches ("what am I doing"), and in a line format the later steps will change.
- NOTIFY bypasses Intuition entirely (thread-relay.js:359, api.js:866-871).
- The single-device rule never fires, because clients live in the Carrier.
- The 60 s tick writes a full snapshot every minute, and nothing deletes them.
- The mood, topic and recall rules read English only.

**Should be, in this order:**
1. The state bench, and a frozen, versioned state-line schema.
2. The event-driven world, including what's waiting on him: finished or blocked threads, approvals, alerts, flagged mail.
3. Situations feeding one policy (speak, hold, push silently) that every producer goes through.
4. r11, trained on a generic key:value block.

Mood stays a minor input. The cues become language-neutral, on a small head over the embedding model that's already loaded.

**Owner notices:** PAN stays quiet on calls and while he dictates, and tells him things when he can take them.

### 9. The pendant does voice (L)
**Now:**
- The only firmware is a camera sketch (firmware/pendant/xiao_cam_ble.ino). Its README says all-day runtime isn't reachable on the Arduino core.
- The medallion board already has the codec, the echo-cancel loopback, the amp, two mics and the power chip, and no code uses them.
- The phone's recognizer opens its own mic and can't take another source.
- Pendant frames are uploaded with analyze=false, so Intuition's camera input is a placeholder.

**Should be:**
- ESP-IDF firmware with Espressif's speech front end (echo cancel, noise suppression, voice detection).
- Opus audio sent only while he speaks, and a downlink so PAN speaks from the medallion.
- Battery reporting and a flow-controlled BLE channel.
- On the phone, an audio-source seam in front of the recognizer, and Android's companion-device presence.
- Frames sent only when the scene changes, captioned on the phone.

**Owner notices:** the medallion becomes his mic and speaker.

### 10. A path to a box other people can run (L)
**Now:**
- An update is a git pull plus a Claude session doing a swap.
- Process plumbing is Windows-only: PowerShell, tasklist, netstat, SendKeys.
- Tests are visual-only.
- Three processes open a 1.6 GB SQLCipher database on their main threads, with no retention.
- Settings have no owner: 148 raw reads in 47 files, 36 hand-written quote strips, and three places hold the model choice.
- Reviewer-reported: Scout can rewrite the voice model at runtime (scout.js:925-934).
- OTA ships a debug APK and needs a tap each time.
- The phone reaches the tailnet through a fake VPN and a one-port TCP forwarder.

**Should be:**
- A Linux image per hardware tier, with systemd units and a model manifest.
- Signed A/B updates that commit only after a health check.
- One typed config module with change events, and versioned migrations.
- Headless tests and tiered retention.
- First-boot QR pairing as the only setup.
- A release-signed app that updates itself.
- For the owner, the official Tailscale app on Always-on VPN.

## Decisions for the owner

1. **Close the Wi-Fi door.** It's a Windows security setting, so the owner runs it. In an admin PowerShell on the hub:
   `Set-NetFirewallRule -DisplayName 'PAN Hub 7777' -Profile Private,Domain`
   Tailscale is a Private network on the hub and keeps working, while the Wi-Fi is Public and gets closed. The laptop's pan-client was moved to the hub's Tailscale address first (2026-11-04).
2. **Turn off the loops that produce nothing:**
   - Evolution: it edits pan-config/*.md, which nothing reads, and has applied nothing since April.
   - Orchestrator and scout's LLM pass: they queue work for a dashboard the north star turned off.
   - Dream: its prompt is empty.
   - pan-reasoning.

   The July audit turned these off, and later sessions turned evolution and Forge back on "per user" (steward.js:484-615). Turn off, don't delete.

   **DONE 2026-11-04 (Craft 53):** dream, evolution, scout and orchestrator are off through `feature_toggles`, and Forge was already off. Consolidation stays on, because it's the part that actually files the database into memory, and it now catches up instead of dropping everything past 200 events a run (FEATURES.md, "Idle loops off").
3. **Run the hub on the wearable profile** (or a new hub profile) instead of `full`. Today the hub runs the dev terminal's probes and screen grabs on a headless box (start-hub.bat:37).
4. **Where to start.** Recommended order:
   1. The fix-now list (about a day).
   2. Big change 1, edge auth.
   3. Big change 2, the live connection and outbox.
   4. Big changes 3 and 4 together, the voice process and the model host.
   5. Big change 6, memory.
   6. Big change 5, routing (start the route log now).
   7. Big changes 7, 8, 9 and 10, in that order.

## Leave alone

- **Voice:**
  - The phone's end-of-turn stack (Smart Turn, the dangling-word veto, re-judge), which had 0% false cut-offs in the bench.
  - The hub's second ASR pass and its choice of model per language: move the process, keep the design.
  - Syrinx's `to` gating, with the reply streamed out of the JSON, and the hold band for unsure lines.
- **Interpreter:** the direction decided in code, the hub translator first, the cloud circuit breaker, and translate-server's exclusive bind with 503 while loading.
- **Relay and measurement:**
  - The thread relay's SQLite job queue (fix only its last hop).
  - voicebench, VoiceEvents and voice-timing.jsonl, which produced every number here.
- **Server:**
  - super-carrier.js's small, DB-free shape, which is the seed of the edge.
  - proxy-headers.js, and the MCP layer as a plain HTTP proxy.
  - The steward's service state machine and its tolerant Ollama check, the pattern to copy.
  - The slow-SQL log and the loop-block monitor.
  - capture-consent.js's live toggles, secrets.js's env-first resolution, and profiles.js's fail-open gating.
- **Intuition and memory:** reader.js's emergency rules and hypothetical filter, world.js modes, time.js, resistance.js, the embedding worker thread, and the local-only background chain.
- **Hardware and phone:** the medallion's hardware choices, the firmware's measurement habits, PendantBle's frame reassembly, and UpdateChecker's resumable download and sha256 check.
