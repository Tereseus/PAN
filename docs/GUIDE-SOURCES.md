# Sources for "How to use ΠAN" (first version, Nov 26 2026)

Where each page's claims come from. App paths are under `android/app/src/main/java/dev/pan/app/`;
hub paths under `service/src/`. "FEATURES" means `docs/FEATURES.md`, "UI" means `docs/UI-INVENTORY.md`.
Only items UI marks regular are taught. Where docs and code disagreed, the code was followed.

## index.html
Topic list only. Tabs and labels from UI "App: tab bar".

## what-is-pan.html
- Hub thinks, keeps memory; phone hears, speaks, shows talk: FEATURES "Hub re-transcription", "Speech models and ΠAN's voice inside the app" (index), CLAUDE.md phone screens.
- Connection line texts: `ui/home/HomeScreen.kt` (Connected, Not paired with a computer yet, No internet on this device, Your computer is not answering).
- Accessories line: `ui/settings/SettingsScreen.kt` Accessories text.
- Pendant: FEATURES "Camera pendant link over BLE"; owner's brief says coming, not for sale.

## getting-started.html
- Pair a phone page, Show a pairing code: `service/public/pair/index.html`; setup opens it: `installer/windows/pan-setup.ps1` (pairUrl).
- Home card and Scan the code: `ui/home/HomeScreen.kt`; Pair dialog: FEATURES "PAN Link on the phone" (`PairActivity`).
- Code works once, expires (10 min default): FEATURES "PAN Link pairing codes".
- App starts muted: FEATURES "Staying alive on the phone"; Home empty text `HomeScreen.kt`.
- Permissions: `MainActivity.kt` (mic, location, calendar, Bluetooth, notifications); camera asked by `vpn/ScanPairActivity.kt`; battery optimisation: FEATURES "Staying alive"; install apps: FEATURES "Android self-update" > Permissions. Calendar use: FEATURES "Calendar and email questions on the old route".
- Device Name text: `SettingsScreen.kt` ("The name your other devices see").
- **Unsure:** typing `localhost:7777/pair` on the hub. The route is static and served by the hub, but the link routes it calls are owner only; not tried. **Unsure:** how a regular person installs the app the first time (no store, no page for it found); left vague.

## talking.html
- Normal mode answers when judged spoken to: FEATURES "Listening modes"; follow ups: Syrinx "Follow-up questions", "Lowest bar while in a talk".
- Quiet notes: `service/PanForegroundService.kt` `notForPanNote`.
- Stop words, interrupting, yeah/mm hmm: FEATURES Syrinx "Words stop ΠAN"; "Spoken mute and unmute" (STOP_WORDS); power button: "The power button stops ΠAN talking"; notification Stop talking: UI Notification 6.
- Typing box "Type to ΠAN": `HomeScreen.kt`.
- Phone by itself: `service/InstantWords.kt` and `PanForegroundService.kt` `handleInstantHardware` (flashlight, play/pause/stop music/next/skip/previous, battery). **Not on the phone:** time and date (taken out Nov 2, code comment), setting timers (only in the dead `handleLocally`, never called), so the brief's "time, timers" were not listed as phone answers.
- Hub answers: time anywhere, money, dates, units: FEATURES "Lookups worked out by code"; weather: "Voice lookup tools", "Voice situation line"; ringing timer stop: "Stop a ringing timer or alarm by voice".
- Stuck word: Syrinx "Stuck on a word"; `router.js` `voice_interject` default `stuck`.
- Assistant button: FEATURES "Assistant button", Syrinx "Car mode on the phone".
- Personality per device: FEATURES "The owner's UI calls done (app 0.5.57)"; Sound Effects and Vibration texts: `SettingsScreen.kt`.
- Left out: music and directions from a reply (ResistanceClient), not sure it still fires reliably.

## listening-modes.html
- Modes, pictures, behaviour: FEATURES "Listening modes"; `audio/ListenMode.kt`; `HomeScreen.kt` MicButton (tap mute, hold chooser, tick), box hints.
- Voice commands: regexes in `audio/ListenMode.kt` and `listen-mode.js`; mute words: FEATURES "Spoken mute and unmute".
- Don't remember ends only by button or after an hour: `ListenMode.kt` `commandIn` returns null in FORGET; `listen-mode.js` line 134. **Mismatch found:** Settings > How ΠAN listens still has a field "Words that end Don't remember" with the hint "Remember again always works", but neither the app nor the hub honours it any more. The guide does not teach that field. The field should be removed or its words changed.
- English only for spoken commands: FEATURES "Listening modes" > Not yet.
- Calls in every mode: FEATURES "Listening modes" > Calls.

## memory.html
- What is kept, Memory tab, lock, PIN rule, search, day row, delete, confirm: UI "App: Memory"; FEATURES Syrinx "App 0.5.1: three tabs", "Memory opens with a PIN"; `ui/memory/MemoryScreen.kt`, Lock Memory text in `SettingsScreen.kt`.
- Clears talk on Home: FEATURES "Forgetting in Memory also clears the phone's own talk".
- Asking: FEATURES "Recall by day", "Questions about past talks go to memory search".
- Delete removes events, search index rows and picture files: `routes/dashboard.js` mem/forget. **Unsure:** whether vector copies are removed; FEATURES (Nov 17) says vector copies and summaries were not. Guide says summaries may remain.
- Family members' talk not kept: FEATURES Syrinx "A person other than the owner can talk to ΠAN" (stores nothing), "A person's words stay out of the owner's log". Own memory per person listed as not done there, so marked Coming.

## people.html
- All labels: `ui/people/PeopleScreen.kt` (Add a person, Adult/Child/Guest, role text, Add device code text, Name it, Family, Read messages out loud, call bars, Call, Answer, Not now, Leave, Join, End, Show my code, Scan a code, Forget, menu items).
- Messages by voice: FEATURES "Messages between people on one ΠAN"; calls: "The voice itself in a call", "A call with a whole group", "In a call: saying no, and ΠAN answering for both"; met people: "People met".
- Child reading: Syrinx "A child's messages"; child cannot meet: "People met" > Pre-gate.
- Calls with other ΠANs: "A call with a whole group" > Not done, so marked Coming.
- Mia, Kit are placeholder names taken from the app's own example strings.

## translating.html
- FEATURES Syrinx "Interpreting" (start phrases, fixed acks, late language, ask them, say that again, one line, survives 2 hours after last use); badge and tap to stop: `HomeScreen.kt`; reading under lines: UI Home 12 and 13; volume: "Interpreting volume".
- Left out: translating on the phone without the hub (models go on by adb, not for regular people).

## camera.html
- Phrases: FEATURES Syrinx "Phone shortcut" (`camera/CameraAsk.kt`); back camera only and the spoken source: "Where a look came from"; follow ups: "Photo answers"; photos never leave the hub: "Photo answers" (`analyzeImage` has no cloud fallback).
- Camera off message: `PanForegroundService.kt` handleCameraCommand.
- Timing "a few seconds": "Photo answers" (about 7 to 8 s for a plain look).

## car.html
- FEATURES Syrinx "Car mode on the phone"; Car slot text in `SettingsScreen.kt`; notification lines: UI Notification 3; car presence: "Where he is: what the hub can tell".
- **Unsure:** Car mode on a phone was "not yet tested in a real car" when written (Nov 15); later car talks used the owner's head unit. The head unit setup is developer only and left out.

## where-you-are.html
- `intuition/where.js` (computer: input within 2 min; car: car Bluetooth or 20 km/h within 10 min; else phone place within 30 min; newest wins).
- Situation line and With, Mood, Lately: `HomeScreen.kt` SituationLine.
- Place name, not coordinates, in the prompt: FEATURES "Voice situation line".
- Reminders and messages, Send them here / Follow me: `ui/settings/NotesDevice.kt`, FEATURES "Notes for a device".
- **Unsure:** whether Intuition's own nudges (`intuition/action.js`) reach a phone today (the phone takes no WebSocket push), so marked Coming.

## models.html
- Roles from FEATURES "Hub voice path: models", "Hub re-transcription", "Photo reader"/"Photo answers", "Translator server", "Phone voice". No model names used, since the live picks change.
- Worked out by code: "Lookups worked out by code".
- Own Claude or ChatGPT: owner's brief, Coming.

## computer.html
- All Coming per the owner's brief. "What works today": `intuition/where.js` idle time; window titles sent by pan-client and read into the situation line: FEATURES "Device presence"; screen watchers off by default: "Capture consent".
- **Unsure:** whether a regular buyer gets ΠAN on a second computer today.

## privacy.html
- Kept on hub: FEATURES memory sections; photos: "Photo answers"; call sound kept nowhere: "The voice itself in a call".
- Encrypted link: PAN Link is a WireGuard style handshake ("PAN Link on the phone"). **Unsure:** how a phone reaches the hub away from home for a regular person; not claimed.
- Scrubbing: FEATURES "His line is scrubbed before any prompt" (`anonymizeForAI`): emails, phones, SSN and card shapes, IPs, GPS pairs, street addresses. It covers the voice line, not every text ΠAN handles.
- Outside services: weather (open-meteo, rounded position: `weather.js`, `tools.js`), rates and geocoder: "Lookups worked out by code".
- Incognito text: `SettingsScreen.kt`; Don't remember and the console log exception: FEATURES "Listening modes" > Still kept.
- Owner reads only a child's messages: FEATURES "Messages between people" (`ownerMayRead`).
- Report: `SettingsScreen.kt` Send a report text.
- **Left out:** web lookups through the hub's browser (built, not wired on the hub per notes), offline Wikipedia (bench only), the `/privacy` page capture switches.

## updates-and-help.html
- FEATURES "Android self-update", "Update at launch only on unmetered network, not in a call", "Updates ... progress bar"; Check for updates label: `SettingsScreen.kt`; install permission message: `update/UpdateChecker.kt`.
- Help rows: Home connection texts, quiet notes, Memory lock, camera message, Needs you alerts (UI Home 7), Send a report.
- **Left out:** how the hub itself updates (nothing found for regular people).
