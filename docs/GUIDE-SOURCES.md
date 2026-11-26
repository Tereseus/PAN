# Sources for "How to use ΠAN" (second version, Nov 26 2026)

Where each page's claims come from. App paths are under `android/app/src/main/java/dev/pan/app/`;
hub paths under `service/src/`. "FEATURES" means `docs/FEATURES.md`, "UI" means `docs/UI-INVENTORY.md`.
Where docs and code disagreed, the code was followed.

## What changed from the first version (owner's review, Nov 26)

- The first version read like a helper you give orders to, and sold small tricks. Rewritten to lead
  with memory, being on every device, groups, translating and privacy.
- Cut on purpose, everywhere: flashlight, music keys, battery answers, timers, telling the time,
  money and unit sums, weather as a selling point, trivia questions, the word "assistant", the
  word "family" as the only kind of group.
- No "Coming" labels. Things still being built are written as part of ΠAN, with no dates (list
  below). Nothing is described that is not in FEATURES at all.
- Every page has an inline SVG picture, drawn on a 340 wide box so it reads at 380 px, colours
  from CSS variables so it works light and dark. Checked in headless Edge at 380 px, both schemes.
- Text cut by about a third. No dashes as punctuation, no owner name, no real names (Mia and Kit
  are made up, taken from the app's own example strings), no addresses or ports.
- Don't remember ends only with the button. The hour limit is not mentioned (the owner may add a
  setting later).
- Order: What ΠAN is, Memory, People and groups, Translating, Privacy, On all your devices,
  Getting started, Talking, Listening modes, Showing things, Car, Computers, Models, Updates and
  help. File names kept; `where-you-are.html` now holds "On all your devices".

## Written as part of ΠAN although still being built

| Page | Line in the guide | State in FEATURES |
|---|---|---|
| memory, privacy | Each person in your group has a memory of their own | "A person other than the owner can talk to ΠAN": a person's turn stores nothing; own memory listed under "Does not do yet" |
| people | ΠAN carries messages and calls between ΠANs | "A call with a whole group" > Not done: a call with people who have their own ΠAN |
| translating | When they have ΠAN too, each phone speaks to its own person | Phone voice "PAN to PAN": test only (`PeerLink`) |
| what-is-pan, camera, where-you-are | The pendant: ears and a camera you wear | "Camera pendant link over BLE", "Pendant mic" (test only) |
| where-you-are | Now and then ΠAN starts a short talk on its own | Hub platform "Interjections and the action engine"; the phone takes no push, so whether it reaches a phone today is not sure |
| computer | Opens an app or page on the right computer, plays and pauses there, learns a correction | Hub platform "pan-client commands and upkeep" (`open_app`, `open_url`, `media_control`, `tts_speak`, `notification`), "Smart router and action paths" (`pickDevice`, `detectCorrection`), "Multi-Device Routing" |
| computer | Reads your phone's screen and taps, types, scrolls, on the phones you allow | Syrinx "Screen control: a command goes to one named device" (owner devices only) |

## index.html
Topic list and the hub picture. Tabs and labels from UI "App: tab bar".

## what-is-pan.html
- Hub thinks and keeps memory, phone hears and speaks: FEATURES "Hub re-transcription", "Speech models and ΠAN's voice inside the app".
- "Your computer is not answering": `ui/home/HomeScreen.kt`. Accessories: `ui/settings/SettingsScreen.kt`.
- Group on one hub: "Messages between people on one ΠAN", "Groups inside the organization".

## memory.html
- Kept: talk and photos (UI "App: Memory"); people met ("People met"); notes on things and private notes held back with other voices around (Hub voice path "A question that names one of his things", Syrinx "Notes endpoints").
- Memory tab, lock, PIN rule, search, day row, delete, confirm: `ui/memory/MemoryScreen.kt`; Syrinx "Memory opens with a PIN"; Lock Memory text in `SettingsScreen.kt`.
- Clears talk on Home: Phone app "Forgetting in Memory also clears the talk on Home".
- Asking: "Recall by day", "Questions about past talks go to memory search".
- Delete removes events, search rows and picture files: `routes/dashboard.js` mem/forget. **Unsure:** whether vector copies go; guide says a summary may remain.
- The picture's moment (Tuesday, weekend plans) is made up.

## people.html
- Labels: `ui/people/PeopleScreen.kt`. Messages: "Messages between people on one ΠAN". Calls: "The voice itself in a call", "In a call: saying no, and ΠAN answering for both". Smaller groups and group calls: "Groups inside the organization", "A call with a whole group". Met: "People met". Group name and "Family" default: "People met" > "The group's name".
- Child: Syrinx "A child's messages"; child cannot meet: "People met" > Pre-gate.

## translating.html
- Syrinx "Interpreting" (start phrases, late language, ask them, say that again, two hours after last use); badge and tap to stop: `HomeScreen.kt`; reading under lines: UI Home 12 and 13; volume: "Interpreting volume".
- Spanish lines in the picture are written for the guide, not taken from ΠAN output.

## privacy.html
- Kept on hub: FEATURES memory sections; photos: "Photo answers"; call sound kept nowhere: "The voice itself in a call".
- Encrypted link: "PAN Link on the phone". **Unsure:** how a phone reaches the hub away from home for a regular person; not claimed.
- Swapped out before a model: "His line is scrubbed before any prompt" (`anonymizeForAI`). It covers the voice line, not every text ΠAN handles.
- Fresh facts without a name: "Lookups worked out by code", `weather.js`.
- Own Claude gets hard questions: Syrinx "The smart model at install", "The cloud fallback carries nothing".
- Don't remember: "Listening modes" (button only way out since Nov 25; the hour limit left out on purpose); console log exception: "Listening modes" > Still kept.
- Incognito, What each device may use, Send a report: `SettingsScreen.kt`. Child's messages: "Messages between people" (`ownerMayRead`).

## where-you-are.html (On all your devices)
- `intuition/where.js` (computer input within 2 min; car Bluetooth or 20 km/h within 10 min; else phone place within 30 min; newest wins).
- Situation line, With, Mood, Lately: `HomeScreen.kt` SituationLine. Place name, not position: "Voice situation line".
- Follow me / Send them here, another device takes a note when one is away: "Notes for a device", `ui/settings/NotesDevice.kt`. Owner only setting.

## getting-started.html
- Setup opens the pair page at its end: `installer/windows/pan-setup.ps1` (pairUrl, `Start-Process`). **Unsure:** "run ΠAN Setup again" to get the page back; it does open it at the end, but a rerun may also reinstall. The web address was dropped as too technical.
- Scan the code, Pair, Connected: `HomeScreen.kt`, `PairActivity`; codes: "PAN Link pairing codes". Starts muted: Phone app "Staying alive".
- Permissions: `MainActivity.kt`, `vpn/ScanPairActivity.kt`, "Android self-update". **Unsure:** how a regular person installs the app the first time; left out.

## talking.html
- Name, follow ups: "Listening modes", Syrinx "Follow-up questions", "Lowest bar while in a talk". Quiet notes: `notForPanNote`. Stuck word: Syrinx "Stuck on a word".
- Stopping: Syrinx "Words stop ΠAN"; "The power button stops ΠAN talking"; notification Stop talking.
- Typing box: `HomeScreen.kt`. Voice button: "Assistant button" (the guide never uses that word). Personality, Sound Effects, Vibration: `SettingsScreen.kt`.

## listening-modes.html
- FEATURES "Listening modes" table; `audio/ListenMode.kt`; mode pictures redrawn after `ui/home/ModeIcons.kt`; MicButton hold and tick in `HomeScreen.kt`.
- Spoken words: `ListenMode.kt`, `listen-mode.js`. English only: "Listening modes" > Not yet.
- "Words that end Don't remember" is not taught (removed from the app, next build).

## camera.html
- Syrinx "Phone shortcut" (`camera/CameraAsk.kt`), "Where a look came from", "Photo answers" (no cloud fallback, a few seconds). Camera off: `PanForegroundService.kt` handleCameraCommand.

## car.html
- Syrinx "Car mode on the phone"; Car slot in `SettingsScreen.kt`; notification lines: UI Notification 3; driving signs: `intuition/where.js`. **Unsure:** Car mode on a plain phone in a real car was untested when written up (Nov 15).

## computer.html
- Knows you are there: `where.js` idle time from pan-client. Window titles: "Device presence". Screen pictures off unless turned on: "Capture consent". Other lines: see the table above.
- **Unsure:** whether a regular buyer can put ΠAN on a second computer today.

## models.html
- Roles: "Hub voice path: models", "Hub re-transcription", "Photo reader", "Translator server", "Phone voice". No model names, since the live picks change.
- Own Claude at the end of Setup, browser sign in, ΠAN never sees the password, works without it: Syrinx "The smart model at install". ChatGPT not named: not in FEATURES.

## updates-and-help.html
- "Android self-update", "Update at launch only on unmetered network, not in a call", progress bar; `SettingsScreen.kt`, `update/UpdateChecker.kt`. Help rows: Home connection texts, quiet notes, Memory lock, camera message, Needs you (UI Home 7), Send a report.
- **Left out:** how the hub itself updates.
