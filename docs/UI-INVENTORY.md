# ΠAN UI inventory (Nov 26 2026)

Every screen, tab, setting, switch and button a person can see in ΠAN today, so the owner can mark
each one **regular** (a regular person sees it), **developer** (only with Developer options, or only
on the owner's machines) or **delete**. It feeds the user guide. Read from the code on Nov 26 (app
0.5.56); nothing was run.

How to read it:

- App paths are under `android/app/src/main/java/dev/pan/app/`. `ui/` means that folder's `ui/`.
- "Everyone" means shown with Developer options off. "Dev" means shown only with Developer options on.
- "Owner" means shown only to the person who runs the hub; a family member's device does not see it.
- Names follow the "## Feature index" in `docs/FEATURES.md` where it has one.
- My suggestion is a first pass only. The owner decides.

## App: tab bar and things on every tab

| # | Item | What it does | Where in code | Shown to | Works today? | My suggestion |
|---|---|---|---|---|---|---|
| 1 | Tab bar: Home, People, Memory, Settings | Moves between the four parts of the app | ui/navigation/PanNavGraph.kt:54 | Everyone | yes | **regular**: the whole app hangs on these four |
| 2 | Unread number on the People tab | Counts new messages from people on this ΠAN | ui/navigation/PanNavGraph.kt:96 | Everyone | yes | **regular**: plain unread count, every messaging app has it |
| 3 | Call strip at the top of every tab | Who is calling, with Answer and Not now; Leave or End while on a call | ui/navigation/PanNavGraph.kt:140, ui/people/PeopleScreen.kt:770 | Everyone | yes | **regular**: a call must be answerable from anywhere |
| 4 | App name under the icon: "ΠAN" | The launcher label | AndroidManifest.xml:52 | Everyone | yes (was Latin PAN until Nov 26) | **regular**: decide the spelling people see on the icon |
| 5 | Permission asks at first start: microphone, location, calendar, Bluetooth, notifications | Android's own prompts, all at once | MainActivity.kt:41 | Everyone | yes; the calendar ask is never explained | **regular**: needed, but the guide must say why each |
| 6 | Update toasts at every start ("ΠAN 0.5.56 is up to date", "found, downloading") | Says how the start up update check went | MainActivity.kt:78 to 87 | Everyone | yes | **developer**: "up to date" on every start is noise |

## App: Home

| # | Item | What it does | Where in code | Shown to | Works today? | My suggestion |
|---|---|---|---|---|---|---|
| 1 | Π and the connection line | Connected, Not paired yet, No internet, or Your computer is not answering, with a dot | ui/home/HomeScreen.kt:114 to 125 | Everyone | yes | **regular**: the one status a person needs |
| 2 | Interpreting badge (tap to end) | Shows interpreting is on and which language; a tap stops it | ui/home/HomeScreen.kt:128 to 137 | Everyone, while interpreting | yes | **regular**: only way to see and end interpreting |
| 3 | Incognito badge | Shows Incognito is on | ui/home/HomeScreen.kt:139 to 144 | Everyone, while on | yes | **regular**: privacy state must always be visible |
| 4 | Situation line (tap for With, Mood, Lately) | ΠAN's read of what he is doing now, from Intuition | ui/home/HomeScreen.kt:146, :236 to 266 | Everyone, when the hub has a read | yes | **regular**: keep, but "Mood" may feel like being watched |
| 5 | "Pair this phone with your computer" card with Scan the code | Opens the camera to scan the hub's pairing code | ui/home/HomeScreen.kt:147 to 158 | Everyone, never paired | yes, but its words are wrong: it says "open Devices and choose Add a device"; no such button exists anywhere in the repo. The hub's page is "Pair a phone" at /pair/ | **regular**: first thing a new person sees; fix the words |
| 6 | Needs you: "Claude is asking" with Allow and Deny | Answers a Claude Code permission prompt from the phone | ui/home/HomeScreen.kt:170 to 178 | Everyone, when a prompt waits | yes | **developer**: only matters to people running Claude Code |
| 7 | Needs you: alerts with Dismiss | Shows hub alerts (up to two) and clears them | ui/home/HomeScreen.kt:179 to 185 | Everyone, when there are alerts | yes | **regular**: but alerts must be written for people |
| 8 | Empty talk text ("ΠAN is listening." / "ΠAN is muted.") | Explains the screen before anything is said | ui/home/HomeScreen.kt:196 to 202 | Everyone | yes | **regular**: good first run hint |
| 9 | The talk: his lines right, ΠAN's left, time under each | The conversation with ΠAN | ui/home/HomeScreen.kt:211 to 221, :292 to 344 | Everyone | yes | **regular**: the heart of Home |
| 10 | Seconds waited under each ΠAN line ("· 1.2 s") | How long until the first word | ui/home/HomeScreen.kt:342 | Everyone | yes | **developer**: a speed number, not useful to most people |
| 11 | Tap a ΠAN line: where the time went and which model answered | Reply breakdown: hearing, model start, network, "Answered by the bigger model", ΠAN's read | ui/home/HomeScreen.kt:345 to 363, :383 to 413 | Everyone | yes | **developer**: model and timing detail is for tuning |
| 12 | Tap a line in another script: word by word reading | Sound, writing and meaning of each word | ui/home/HomeScreen.kt:348 to 359 | Everyone, on such lines | yes | **regular**: real help when interpreting Japanese |
| 13 | Latin letters under a foreign line (romaji) | How to say it | ui/home/HomeScreen.kt:334 | Everyone, on such lines | yes | **regular**: same reason as the word by word view |
| 14 | "Why ΠAN stayed out" note (small slanted line) | Says why ΠAN did not answer a line | ui/home/HomeScreen.kt:296 | Everyone | yes | **regular**: explains silence, builds trust; reword for strangers |
| 15 | App notes in the middle ("PAN muted") | Things the app did, not said by anyone | ui/home/HomeScreen.kt:304 | Everyone | yes | **regular**: short and clear |
| 16 | Pictures in the talk | A photo ΠAN took, shown on its line | ui/home/HomeScreen.kt:415 to 431 | Everyone | yes | **regular**: shows what ΠAN looked at |
| 17 | Thinking bubble | Shows ΠAN is working on a reply | ui/home/HomeScreen.kt:434 | Everyone | yes | **regular**: standard waiting sign |
| 18 | The box: live words, tap to type, Send | Shows his words as he talks; tapped, it becomes a text box with a Send arrow (`TYPED_LINE`) | ui/home/HomeScreen.kt:452 to 539 | Everyone | yes | **regular**: typing matters where talking is not possible |
| 19 | Box hint per listening mode ("Listening only...", "Name only...", "Don't remember...") | Says which mode is on | ui/home/HomeScreen.kt:521 to 529 | Everyone | yes | **regular**: the mode must be visible in words |
| 20 | Mic button: tap | Mute and unmute (`TOGGLE_MIC`) | ui/home/HomeScreen.kt:549 to 568 | Everyone | yes | **regular**: the main switch of ΠAN |
| 21 | Mic button: hold, then pick a mode | Normal, Listen only, Name only, Don't remember, Mute (`SET_LISTEN_MODE`) | ui/home/HomeScreen.kt:574 to 595, audio/ListenMode.kt:25 | Everyone | yes | **regular**: hidden behind a hold; the guide must teach it |

## App: People

All of it comes from the hub (`docs/PEOPLE-PLAN.md`); the app only shows it.

| # | Item | What it does | Where in code | Shown to | Works today? | My suggestion |
|---|---|---|---|---|---|---|
| 1 | Mic button in the People header (tap, hold) | Same mute and mode chooser as Home | ui/people/PeopleScreen.kt:218 | Everyone | yes | **regular**: mute where calls happen |
| 2 | "Muted: nobody on a call can hear you" line | Warns when muted during a call | ui/people/PeopleScreen.kt:222 | Everyone, muted in a call | yes | **regular**: prevents talking into nothing |
| 3 | "ΠAN could not be reached" line | Hub did not answer | ui/people/PeopleScreen.kt:227 | Everyone | yes | **regular**: plain error |
| 4 | Who to show drop down: the organization, each group, Everyone else, New group | Filters the list; New group is owner only | ui/people/PeopleScreen.kt:244 to 261 | Everyone; New group owner | yes | **regular**: simple filter |
| 5 | Call bars in the list: "X wants to talk" Answer / Not now; "On with X" End; group ringing Answer / Not now; group on Leave / Open; group going on Join | Every call state, always in view | ui/people/PeopleScreen.kt:268 to 298 | Everyone | yes | **regular**: core of calls |
| 6 | Call [group] and Earlier calls | Starts a call with everyone shown; opens past group calls | ui/people/PeopleScreen.kt:303 to 311 | Everyone who may send | yes | **regular**: family call in one tap |
| 7 | "Whoever set up this ΠAN has not opened messages for you" | Tells a person messaging is off for them | ui/people/PeopleScreen.kt:313 | A person, not the owner | yes | **regular**: honest about limits |
| 8 | "X can read your messages here" | On a child's device: says a parent can read | ui/people/PeopleScreen.kt:319 | A child | yes | **regular**: nothing read behind their back |
| 9 | Empty list text ("Nobody else is on your ΠAN yet...") | Explains people for a new owner | ui/people/PeopleScreen.kt:326 | Everyone | yes | **regular**: good first run hint |
| 10 | Person row: name, last message, role, time, unread | Opens the conversation | ui/people/PeopleScreen.kt:337, :625 | Everyone; role shown to owner | yes | **regular**: like any messages list |
| 11 | Group buttons: Choose people, Rename, Delete | Edit a group; dialogs "Who is in", "Rename" | ui/people/PeopleScreen.kt:342 to 348, :421 to 453 | Owner | yes, but Delete has no "are you sure" | **regular**: add a confirm to Delete |
| 12 | Add a person (dialog: Name; Adult, Child or Guest) | Puts a person on this ΠAN | ui/people/PeopleScreen.kt:353, :459 to 489 | Owner | yes | **regular**: family setup |
| 13 | Name it / Rename [organization] (dialog "Your organization") | Names the family or workplace | ui/people/PeopleScreen.kt:354, :379 to 394 | Owner | yes | **regular**: shown to everyone on it |
| 14 | New group dialog (ideas: Kids, Team, Guests, Friends) | Makes a group | ui/people/PeopleScreen.kt:399 to 417 | Owner | yes | **regular**: simple naming |
| 15 | Hint "Tap someone to write or call. Or say ΠAN, tell..." | Teaches the voice commands | ui/people/PeopleScreen.kt:357 | Everyone | yes | **regular**: teaches voice use |
| 16 | Read messages out loud switch | Messages to me are said aloud, or only shown; locked if the owner set it | ui/people/PeopleScreen.kt:363 to 374 | Everyone | yes | **regular**: a person's own choice |
| 17 | Everyone else: Show my code, Scan a code | People met: each scans the other's ΠAN code (`MeetCard`) | ui/people/PeopleScreen.kt:682 to 691, :727 to 749 | Everyone, when meeting is allowed | yes | **regular**: meeting people with their own ΠAN |
| 18 | Met person: ⋮ then Forget (dialog) | Drops the record of meeting | ui/people/PeopleScreen.kt:707 to 709, :753 to 759 | Everyone | yes | **regular**: a person's own record |
| 19 | Conversation: Back, Call button, Earlier, type box with Send, mic | Messages and calls with one person | ui/people/PeopleScreen.kt:1008 to 1138 | Everyone | yes | **regular**: core messaging |
| 20 | Conversation ⋮: Take calls / Don't take calls from X | Blocks or allows calls from this person | ui/people/PeopleScreen.kt:1054 | Everyone | yes | **regular**: a person's own choice |
| 21 | Conversation ⋮: X's messages (a child's) | Opens the child's conversations to read | ui/people/PeopleScreen.kt:1059, :967 to 1005 | Owner, child only | yes | **regular**: parents expect this; guide must say child sees it |
| 22 | Conversation ⋮: Groups (dialog) | Which groups this person is in | ui/people/PeopleScreen.kt:1060, :520 to 538 | Owner | yes | **regular**: same as group editing |
| 23 | Conversation ⋮: Other names (dialog, up to four) | Names ΠAN may hear for this person | ui/people/PeopleScreen.kt:1061, :543 to 561 | Owner | yes | **regular**: fixes misheard names |
| 24 | Conversation ⋮: Messages: read out / show only / Let X choose | Owner sets and locks how this person gets messages | ui/people/PeopleScreen.kt:1063 to 1065 | Owner | yes | **regular**: needed for children |
| 25 | Conversation ⋮: Add device (QR dialog, 10 minutes, once) | Pairing code for this person's device | ui/people/PeopleScreen.kt:1066, :502 to 514 | Owner | yes | **regular**: how family joins |
| 26 | Conversation ⋮: Rename, Remove (dialogs) | Rename; remove the person and cut their devices | ui/people/PeopleScreen.kt:1067 to 1068, :566 to 619 | Owner | yes | **regular**: owner must manage people |
| 27 | Group call screen: Back, Leave or Join, past lines, type box, mic | A call with a whole group | ui/people/PeopleScreen.kt:855 to 960 | Everyone | yes | **regular**: group calls |

## App: Memory

| # | Item | What it does | Where in code | Shown to | Works today? | My suggestion |
|---|---|---|---|---|---|---|
| 1 | Locked pane: Unlock with fingerprint, or Unlock with PIN / Set a PIN, or "stays closed here" | Nothing is fetched until it opens; locks again when left | ui/memory/MemoryScreen.kt:94 to 131, :64 to 73 | Everyone, lock on (default on) | yes | **regular**: privacy of everything kept |
| 2 | Lock icon at the top | Locks Memory now | ui/memory/MemoryScreen.kt:83 to 87 | Everyone, lock on | yes | **regular**: quick hide |
| 3 | Search box with clear | Search a word or a name | ui/memory/MemoryScreen.kt:160 to 179 | Everyone | yes | **regular**: main way to find things |
| 4 | Day row: day before, the date (tap for a calendar), day after | Browse by day | ui/memory/MemoryScreen.kt:183 to 202, :245 to 265 | Everyone | yes | **regular**: "what did I do Tuesday" |
| 5 | Count line ("12 kept", "40 found. Showing the newest 25") | How much is shown | ui/memory/MemoryScreen.kt:206 to 214 | Everyone | yes | **regular**: plain |
| 6 | Memory card with picture and delete icon | One kept thing; delete asks first | ui/memory/MemoryScreen.kt:221, :299 to 330 | Everyone | yes | **regular**: forgetting one thing is a right |
| 7 | Delete this day / Delete everything found | Forgets a whole day or a whole search | ui/memory/MemoryScreen.kt:234 to 242 | Everyone | yes | **regular**: with the confirm below |
| 8 | Delete confirm (Delete / Keep, fingerprint again) | "This cannot be undone"; also clears the talk on Home | ui/memory/MemoryScreen.kt:267 to 296 | Everyone | yes | **regular**: right safety step |

## App: Settings (the list)

| # | Item | What it does | Where in code | Shown to | Works today? | My suggestion |
|---|---|---|---|---|---|---|
| 1 | Five rows: This device, Voice and sounds, Accessories, Privacy, Updates and about | Each opens its page; Back returns to the list | ui/settings/SettingsScreen.kt:37 to 43, :138 to 151 | Everyone | yes | **regular**: short list is right |
| 2 | Version line ("ΠAN 0.5.56") | Shows the version | ui/settings/SettingsScreen.kt:152 | Everyone | yes | **regular**: support needs it |

## App: Settings > This device

| # | Item | What it does | Where in code | Shown to | Works today? | My suggestion |
|---|---|---|---|---|---|---|
| 1 | Device Name | Saved as `device_name`; sent as the `X-Device-Name` header (di/NetworkModule.kt:118) so other devices see it | ui/settings/SettingsScreen.kt:159 to 168, ui/settings/SettingsViewModel.kt:253 | Everyone | yes; note "Reminders and messages" names devices by phone model, not this name | **regular**: people name their own devices |
| 2 | "How it reaches ΠAN" line | Using ΠAN Link, backup route, or connecting | ui/settings/SettingsScreen.kt:198 to 209 | Everyone | yes | **regular**: but "backup route" means nothing to most |
| 3 | ΠAN Server (read only address) | Shows the hub address in use | ui/settings/SettingsScreen.kt:210 to 219 | Dev | yes | **developer**: an address is for fixing things |
| 4 | ΠAN Link summary text | Link state in words | ui/settings/SettingsScreen.kt:221 to 224 | Everyone | yes | **developer**: technical; the line above says enough |
| 5 | Scan a pairing code | Opens the camera pairing screen | ui/settings/SettingsScreen.kt:226 to 228 | Everyone | yes | **regular**: pair again or with a new hub |
| 6 | Forget this pairing (dialog Forget / Cancel) | Drops ΠAN Link, back to Tailscale | ui/settings/SettingsScreen.kt:229 to 230, :252 to 265 | Everyone, when paired | yes | **developer**: falling back to Tailscale is a technician's move |
| 7 | Pair this phone | Gets a code from the hub over Tailscale and pairs | ui/settings/SettingsScreen.kt:232 to 250 | Everyone, when not paired | yes, only on a phone already on Tailscale | **developer**: strangers have no Tailscale |
| 8 | Tailscale (backup) status | Connected, IP, or status | ui/settings/SettingsScreen.kt:270 to 285 | Dev | yes | **developer**: "nobody sees Tailscale" rule |
| 9 | Sign in to Tailscale button and QR, or "waiting for approval" | Shown only while the app's Tailscale wants a sign in | ui/settings/SettingsScreen.kt:286, :724 to 765 | Dev | yes | **developer**: same rule |

## App: Settings > Voice and sounds

| # | Item | What it does | Where in code | Shown to | Works today? | My suggestion |
|---|---|---|---|---|---|---|
| 1 | Personality: "How ΠAN talks" box, Save, Turn Off | Saved on the phone and in hub setting `personality`; the hub adds it to the prompt (service/src/router.js:1543 and :3657 `personPrompt`) | ui/settings/SettingsScreen.kt:290 to 326, ui/settings/SettingsViewModel.kt:384 | Everyone | yes; it is one setting for the whole hub, so a family member's change changes it for all | **regular**: fun and personal; owner only would be safer |
| 2 | Reminders and messages: Send them here / Follow me | Which device reads out reminders and messages; hub setting `notes_device` (service/src/phone-notes.js:63) | ui/settings/NotesDevice.kt:59 to 70 | Owner's devices only | yes | **regular**: but Follow me suits most; ΠAN could decide |
| 3 | How ΠAN listens: three word lists and Save | Your name for ΠAN (Name only), words that end Listen only, words that end Don't remember; any language | ui/settings/ListenWords.kt:102 to 129 | Everyone | yes | **regular**: a person's own words |
| 4 | Voice Quality picker: Default (Android), Supertonic Fast, Supertonic 3 Clear | Saves `voice_quality` in `pan_tts_prefs`; read by tts/TtsManager.kt:23 and service/PanForegroundService.kt:839; downloads, then needs a restart | ui/settings/SettingsScreen.kt:340 to 402 | Dev | yes; "restart app to activate", and the restart button is also Dev only | **developer**: buyers get one voice, as decided |
| 5 | Sound Effects switch | Saves `beep_enabled`; turns the sound off (audio/FeedbackSounds.kt:34) | ui/settings/SettingsScreen.kt:404 to 409 | Everyone | yes, but its words are wrong: it says "A tone when ΠAN hears a command"; since 0.5.56 the only sound is the one mute makes | **regular**: fix the words to "a soft sound when muted" |
| 6 | Vibration switch | Saves `vibration_enabled`; a buzz on the wake word (200 ms) and on a failure (500 ms) | ui/settings/SettingsScreen.kt:411 to 416, audio/FeedbackSounds.kt:35, :93 | Everyone | yes | **regular**: some people hate buzzing |

## App: Settings > Accessories

| # | Item | What it does | Where in code | Shown to | Works today? | My suggestion |
|---|---|---|---|---|---|---|
| 1 | Explanation line | Glasses, headphones and earbuds that work with Android work with ΠAN | ui/settings/SettingsScreen.kt:662 to 665 | Everyone | yes | **regular**: sets expectations |
| 2 | Slots: Glasses, Headphones, Watch, Medallion, Car, Other, each with "None connected" text | What is connected in each slot | ui/settings/SettingsScreen.kt:667 to 680, accessory/AccessoryHub.kt:53 | Everyone | yes | **regular**: but see the Medallion row |
| 3 | Medallion slot | Always "Not connected": the hardware is design only | ui/settings/SettingsScreen.kt:674 | Everyone | no device exists yet | **delete**: shows a product nobody can buy yet |
| 4 | Accessory row ("mic · speaker · ΠAN is using it") | One connected accessory | ui/settings/SettingsScreen.kt:681 to 690 | Everyone | yes | **regular**: plain state |
| 5 | Use for voice switch | Talk to ΠAN through this headset or glasses (`AccessoryHub.useForVoice`) | ui/settings/SettingsScreen.kt:692 to 694 | Everyone, connected mic devices | not sure: no test seen | **regular**: but ΠAN could pick the connected headset itself |
| 6 | "The one you picked is not connected" note | Falls back to the phone | ui/settings/SettingsScreen.kt:698 to 702 | Everyone | yes | **regular**: explains a quiet fallback |

## App: Settings > Privacy

| # | Item | What it does | Where in code | Shown to | Works today? | My suggestion |
|---|---|---|---|---|---|---|
| 1 | Incognito switch | Saves `incognito_mode`; every request carries scope incognito (`ScopeHolder`); turning it off erases the hub's incognito store. Greyed if the organization forbids it | ui/settings/SettingsScreen.kt:423 to 449, ui/settings/SettingsViewModel.kt:452 | Everyone | yes | **regular**: but it overlaps "Don't remember" mode; pick one |
| 2 | Lock Memory switch | Fingerprint (or PIN) to open Memory; turning it off asks for it | ui/settings/SettingsScreen.kt:451 to 466, ui/memory/Fingerprint.kt:45 | Everyone | yes (on by default) | **regular**: privacy is the person's call |
| 3 | Change the Memory PIN | Set or change the PIN | ui/settings/SettingsScreen.kt:467 to 470 | Everyone, no fingerprint and PIN allowed | yes | **regular**: needed where there is no fingerprint |
| 4 | "What each device may use": device picker | Pick which device's sensors to see | ui/main/MainScreen.kt:44 to 88 | Everyone | yes | **regular**: but only the owner should see other devices |
| 5 | Sensor switch per sensor (this phone's mic switch is Mute) | Turns a sensor on or off for that device (`GET/PUT /api/sensors/devices/:id`) | ui/main/MainScreen.kt:95 to 139 | Everyone | yes | **regular**: "what may ΠAN use" is a person's call |
| 6 | Locked sensor with the reason | A sensor the organization locked | ui/main/MainScreen.kt:119 to 125 | Everyone | yes | **regular**: honest about who decided |
| 7 | Tap a sensor: "When X captures, also attach" checkboxes | Which other sensors' data go with a capture | ui/main/MainScreen.kt:142 to 180 | Everyone | not sure: no reader checked | **developer**: wiring that nobody outside can judge |

## App: Settings > Updates and about

| # | Item | What it does | Where in code | Shown to | Works today? | My suggestion |
|---|---|---|---|---|---|---|
| 1 | Version and build number | "Version 0.5.56 (185)" | ui/settings/SettingsScreen.kt:486 to 491 | Everyone | yes | **regular**: support needs it |
| 2 | Check for updates, progress bar, MB count | Pulls the newest app from the hub now; Android asks to install | ui/settings/SettingsScreen.kt:492 to 510, ui/settings/SettingsViewModel.kt:414 | Everyone | yes | **regular**: ΠAN already checks by itself; button is a backup |
| 3 | Credits and licences (tap to open) | Projects ΠAN is built on, with licences | ui/settings/Credits.kt:68 to 100 | Everyone | yes | **regular**: licences must be shown |
| 4 | Send a report (dialog shows the text first; Send / Cancel) | Share sheet with version, phone, voice speed, last crash; nothing said | ui/settings/SettingsScreen.kt:519 to 540, ui/settings/PanReport.kt | Everyone | yes | **regular**: how strangers report trouble |
| 5 | Developer options switch | Saves `developer` in `pan_ui`; read only by Settings itself (SettingsScreen.kt:85) | ui/settings/SettingsScreen.kt:541 to 546 | Everyone | yes | **developer**: hide it, for example seven taps on the version |
| 6 | Hub button | Opens the Hub screens | ui/settings/SettingsScreen.kt:547 to 551 | Dev | yes | **developer**: tools for building ΠAN |
| 7 | Stop ΠAN Service / Force Restart | Stops the foreground service; or stops it, kills the app and starts it fresh | ui/settings/SettingsScreen.kt:555 to 575, ui/settings/SettingsViewModel.kt:482 to 513 | Dev | yes | **developer**: a stopped service looks broken to a buyer |

## App: Hub (Settings > Developer options > Hub)

Three tabs: Services, Intuition, Models. Machines sits inside Models. There is no Updates, About or
Accessories screen in Hub; those live in Settings.

| # | Item | What it does | Where in code | Shown to | Works today? | My suggestion |
|---|---|---|---|---|---|---|
| 1 | Top bar: Back, Refresh | Leaves; reloads (also every 15 s) | ui/hub/HubScreen.kt:85 to 87 | Dev | yes | **developer**: whole screen is a build tool |
| 2 | Tabs: Services, Intuition, Models | Switch between parts | ui/hub/HubScreen.kt:92 to 96 | Dev | yes | **developer**: same |
| 3 | Services: "N running, N down, N not reporting" | Count from `/dashboard/api/services` | ui/hub/HubScreen.kt:127 | Dev | yes | **developer**: for fixing the hub |
| 4 | Services: Down list, then running by category (dot, name, role, detail) | What runs on the hub | ui/hub/HubScreen.kt:132 to 139, :155 to 165 | Dev | yes; green and red dots, but the "Down" heading also says it in words | **developer**: for fixing the hub |
| 5 | Services: Not reporting | Parts that send no sign of life | ui/hub/HubScreen.kt:141 to 148 | Dev | yes | **developer**: same |
| 6 | Intuition: "Read N ago, N% sure" | Age and certainty of the read (`/api/v1/intuition/current`) | ui/hub/HubScreen.kt:182 | Dev | yes | **developer**: model internals |
| 7 | Intuition: What ΠAN reads about you now / What it expects next / What it read it from | The full read with reasons | ui/hub/HubScreen.kt:186 to 199 | Dev | yes | **developer**: could become a "what ΠAN knows about me" page later |
| 8 | Models: Answer model (hub) picker, with "Change the model?" confirm | Sets the hub's answer model for every device (`PUT /api/v1/settings`) | ui/hub/HubModels.kt:31, :66 to 74 | Dev | yes | **developer**: a wrong pick breaks every device |
| 9 | Models: Voice reader (hub) picker | Same, for the voice reader | ui/hub/HubModels.kt:32 | Dev | yes | **developer**: same |
| 10 | Models: Speech to text (hub) line | Names the hub's ear | ui/hub/HubModels.kt:33 | Dev | yes | **developer**: model name only |
| 11 | Machines: one row per computer, with a "ΠAN may use it" switch | Lets ΠAN run models there or not (`PUT /api/v1/compute/allow`) | ui/hub/HubModels.kt:170 to 185 | Dev | yes; one text names "WoE's running jobs", the owner's own game | **developer**: but a buyer with two PCs may want it |
| 12 | Machines: Test speed button, Loaded, Runs here now | Measures tokens a second; shows loaded models and jobs | ui/hub/HubModels.kt:188 to 199 | Dev | yes | **developer**: benchmark detail |
| 13 | Speech to text (this device) line | Names the phone's ear | ui/hub/HubModels.kt:45 | Dev | yes | **developer**: model name only |
| 14 | Text to speech (this device) and its speed | Names the voice; speed and steps | ui/hub/HubModels.kt:126 to 134 | Dev | yes | **developer**: model name only |
| 15 | Voice speed: Auto switch and Speed slider | Saves `pace_speed` and `pace_steps` in `pan_tts_prefs` (tts/VoicePace.kt:19) | ui/hub/HubModels.kt:137 to 151 | Dev | yes | **regular**: as Slower, Normal, Faster; Auto stays default |
| 16 | Voice timing line | ms to build each second of speech | ui/hub/HubModels.kt:47 to 52 | Dev | yes | **developer**: speed number |
| 17 | Your times table (Device, Average, Middle, Slowest, Turns) | Turn times per device | ui/hub/HubModels.kt:54 to 62 | Dev | yes | **developer**: speed numbers |

## App: other screens outside the tabs

| # | Item | What it does | Where in code | Shown to | Works today? | My suggestion |
|---|---|---|---|---|---|---|
| 1 | Scan screen (camera) | Reads a pairing code, or another person's ΠAN code | vpn/ScanPairActivity.kt:40 | Everyone | yes | **regular**: pairing and meeting |
| 2 | "Pair with [name]?" dialog, Pair / Cancel, then a toast | Asks before pairing from a `pan://pair` link or scan | vpn/PairActivity.kt:56 to 88 | Everyone | yes | **regular**: protects against a planted code |
| 3 | Assistant button (no screen) | Car wheel button, headset hold or the phone's assistant gesture makes the next line for ΠAN | assist/VoiceAssistActivity.kt:9 | Everyone, once ΠAN is the phone's assistant | yes | **regular**: the guide must say how to pick ΠAN as assistant |
| 4 | Screen control (Android accessibility service) | ΠAN can read and tap the screen | service/PanAccessibilityService.kt | Only where switched on in Android settings; hub allows it on the test Pixel 6 only | yes, test phone only | **developer**: no yes step yet |

## Notification

| # | Item | What it does | Where in code | Shown to | Works today? | My suggestion |
|---|---|---|---|---|---|---|
| 1 | Ongoing ΠAN notification title: "ΠAN is listening", "listening only", "answers to its name only", "is muted" | The state, always in the shade | service/PanForegroundService.kt:3677 to 3682 | Everyone | partly: in Don't remember mode it says "ΠAN is listening" | **regular**: add the Don't remember title |
| 2 | Status line: connection and ΠAN's read | Same words as Home | service/PanForegroundService.kt:3683 to 3698 | Everyone | yes | **regular**: quick check without opening |
| 3 | Pulled down: "You: ..." and "ΠAN: ..." last lines | The last thing said each way | service/PanForegroundService.kt:3705 to 3711 | Everyone | yes | **regular**: handy in the car |
| 4 | Tap the notification | Opens the app | service/PanForegroundService.kt:3701 | Everyone | yes | **regular**: standard |
| 5 | Mute / Unmute action | `TOGGLE_MIC` | service/PanForegroundService.kt:3702 | Everyone | yes | **regular**: fastest mute |
| 6 | Stop talking action | `STOP_TTS` | service/PanForegroundService.kt:3703 to 3707 | Everyone | yes | **regular**: cut a long answer short |
| 7 | "ΠAN: Claude is asking" with Allow / Deny | Claude Code permission prompt | service/PanForegroundService.kt:1117 to 1158 | Everyone, when a prompt waits | yes | **developer**: Claude Code users only |
| 8 | Slack message with Reply (voice or text) | Slack through the hub; reply goes back | service/PanForegroundService.kt:1286 to 1330 | Everyone, when the hub forwards Slack | yes | **developer**: the owner's Slack bridge, strangers have none |
| 9 | Call ring: "X wants to talk" with Not now / Answer | A call from someone on this ΠAN | service/PanForegroundService.kt:1375 to 1410 | Everyone | yes | **regular**: calls must ring |
| 10 | Alert notifications (meetings, messages set to show only, a thread's late answer) | Shown; a tap opens the app | service/PanForegroundService.kt:1415 to 1442 | Everyone | yes | **regular**: but thread answers are developer things |
| 11 | Notification channels in Android settings: ΠAN, Slack, Calls, Calls (ΠAN says who), alerts | Lets Android mute each kind | service/PanForegroundService.kt:1120, :1271, :1383, :3648 | Everyone | yes | **regular**: but drop Slack for strangers |

## Hub web pages

### Pages a person might open

| # | Page | What it is | Where in code | Shown to | Works today? | My suggestion |
|---|---|---|---|---|---|---|
| 1 | `/mobile/` phone page: tabs Chat, Alerts, Devices, Library, Sensors, Settings; with hub setting `mobile_developer_tabs` also Intuition, Dashboards, Data, Projects, Services, Usage, Tasks | The old phone dashboard, 2,701 lines | service/public/mobile/index.html, served at service/src/server.js:3215 | Anyone who types the address | still served, but the app no longer opens it: the hub page inside the app went in 0.5.32 (ui/navigation/PanNavGraph.kt:66) and `ui/dashboard/` is empty. CLAUDE.md still describes it as live | **delete**: the app replaced every tab |
| 2 | `/pair/` "Pair a phone" | Shows the pairing QR | service/public/pair/index.html | Opened by the installer at the end of setup (installer/windows/pan-setup.ps1) | yes | **regular**: Home's card should name this page |
| 3 | `/setup/` "PAN Setup": Identity, AI Provider, Phone Connection, Done | First run setup in the browser | service/public/setup/index.html, server.js:3199 | Anyone on the hub | not sure: may be replaced by the installer | **regular**: if the installer still uses it, else delete |
| 4 | `/status` and `/privacy` "Status & Privacy" | Memory stats, capture switches, services health, MCP connector | service/public/status.html, server.js:3227 | Anyone on the hub | yes | **regular**: the consent page |
| 5 | `/child/` "Hi!" | A page for a child, 344 lines | service/public/child/index.html | not sure who opens it | not sure | **delete**: unless the owner knows its use |
| 6 | `/` (root) old "ΠΑΝ Dashboard", 5,553 lines | Old dashboard before v2 | service/public/index.html, static at server.js:3765 | Anyone on the hub | not sure which route wins for `/`; `/dashboard` redirects to `/v2/` | **delete**: v2 replaced it |
| 7 | `report.html`, `hardware-health.html` (title says "desktop-pc"), `pan-system.html`, `runner.html`, `terminal-pre.html`, `docs/viewer.html`, `docs/install-requirements.html` | Efficiency report, hardware check, system map, project runner, terminal test, doc viewer, install list | service/public/ | Anyone who knows the address | not checked | **developer**: tools; terminal-pre and hardware-health look stale |

### Desktop dashboard `/v2/` (service/dashboard/src/routes/), mostly developer tools

| # | Page | Main panels | Suggestion |
|---|---|---|---|
| 1 | `/v2/` | Redirects to Terminal | **developer**: entry point |
| 2 | Terminal | Claude Code tabs, transcript, chat send; side widgets: Intuition, Alerts, Approvals, Apps, Atlas, Benchmarks, Bugs, Contacts, Devices, Instances, Library, Lifeboat, Live call, Mail, Perf, Pipeline, Project, Services, Setup, Tasks, Teams, Tests, Usage, Users | **developer**: the owner's workbench |
| 3 | Terminal dev | Same page for the dev server on 7781 | **developer**: testing only |
| 4 | Automation | Scheduled Jobs, Project Tech Stacks, Scout Findings, Approval Queue, AutoDev | **developer**: jobs and agents |
| 5 | Projects | Overall stats, a card per project | **developer**: project tracking |
| 6 | Sensors | Sensors per device, passive and active, attachments | **regular**: same switches as the app's Privacy page |
| 7 | Data | Overview, Activity Log, Captured Photos, Memory, Job History, Data Management and Danger Zone | **developer**: raw data tools |
| 8 | Settings | Appearance (Theme), General (Server Health, Scrub Mode, Personality, Branding, Terminal Appearance, Projects, Recent Sessions), AI and Usage (Terminal AI, Server API Model, Phone AI Gemini Flash, Job Models, Model Providers, Usage, Cost by Feature), Controls (Voice to Text, Screenshots, Voice Permission Approval), Devices (App Versions, Connected Devices), Organizations (Users, Teams, Members, Invite People, Org Settings), Security (Change Password), Authentication (Auth Mode, OAuth Providers), Remote Access (Remote Access, Set Up Phone) | **developer**: mixed; Organizations and Set Up Phone may be regular |
| 9 | Comms | Contacts, Mail, Calendar; Call Π mode | **developer**: the owner's mail and calendar |
| 10 | Compose | Write a message to a contact on a chosen channel | **developer**: part of Comms |
| 11 | Chat | Projects list and a chat per project | **developer**: old chat view |
| 12 | Conversations | Paged list of past conversations | **developer**: history browser |
| 13 | Call | WebRTC call page | **developer**: not sure it is still used |
| 14 | Atlas, Atlas phone, Atlas V2 | Live maps of the hub and the phone pipeline | **developer**: system maps |
| 15 | Kanban, Kronos, Timeline | Task board, time view, decision timeline with Guardian decisions | **developer**: owner's planning tools |
| 16 | Crucible | Shadow traffic stats and results | **developer**: model testing |

## Settings that exist in code but nobody can reach (dead)

These are saved or read in code but have no switch on any screen today.

| Setting | Where | Who reads it | State |
|---|---|---|---|
| `trigger_word` ("hey pan") | ui/settings/SettingsViewModel.kt:46, :264 | nobody | **delete**: no screen, no reader |
| `backchannel_enabled` (the optional "mm-hm") | ui/settings/SettingsViewModel.kt:52, :269 | service/PanForegroundService.kt:705 | no screen sets it, so it stays off; FEATURES calls it optional |
| `voice_response_enabled` | ui/settings/SettingsViewModel.kt:61, :287 | nobody | **delete** |
| `device_target` (which device answers) | ui/settings/SettingsViewModel.kt:68, ui/main/MainViewModel.kt:336 | service/PanForegroundService.kt:2569 | no screen; always "auto" |
| `preferred_music_app`, `preferred_messaging_app` | ui/settings/SettingsViewModel.kt:76 to 79, :297 to 305 | nobody | **delete** |
| `query_answer_source` (cloud or local) | ui/settings/SettingsViewModel.kt:83, :307 | service/PanForegroundService.kt:2083 (local LLM path) | no screen; always "cloud"; the local model path is gone ("All AI via server") |
| `classifier_model`, `conversation_model`, `selected_llm_model`, llm status and download progress, `addCustomModel` | ui/settings/SettingsViewModel.kt:87 to 104, :230 to 239, :312 | nobody | **delete**: on phone models were removed |
| `gemini_key` | ui/settings/SettingsViewModel.kt:118, :377 | nobody | **delete**: users never see API keys |
| `server_url` setter | ui/settings/SettingsViewModel.kt:259 | read only for the Dev address box | setter never called |
| `blackoutAllowed` (organization policy) | ui/settings/SettingsViewModel.kt:152, :214 | nobody | **delete** or build the blackout switch |
| VPN consent launcher (`vpnLauncher`) | ui/settings/SettingsScreen.kt:96 to 102 | never launched | **delete** |
| `SettingDropdown` helper | ui/settings/SettingsScreen.kt:584 | never used | **delete** |
| Data dividend row | ui/settings/SettingsScreen.kt:481 (a comment) | not built | waits on the owner |

## Broken or wrong today (short list)

1. Home's pairing card tells people to "open Devices and choose Add a device"; that button does not exist. The hub page is "Pair a phone" at `/pair/`.
2. Sound Effects says "A tone when ΠAN hears a command"; only mute makes a sound now.
3. The notification title says "ΠAN is listening" in Don't remember mode.
4. Deleting a group in People has no "are you sure".
5. The Voice Quality pick needs an app restart, and the restart button is Dev only.
6. Personality is one hub setting: anyone's change applies to every device.
7. `/mobile/` is still served and CLAUDE.md still calls it the phone page, but the app stopped opening it in 0.5.32.
8. Machines text names "WoE's running jobs", the owner's own game, on a screen meant for any hub.
9. The launcher label is "PAN", not "ΠAN".

## Settings ΠAN could decide by itself

- Voice speed (Auto already exists; offer only Slower, Normal, Faster).
- Which device reads reminders and messages (Follow me as the default).
- Which headset or glasses to talk through (the one connected and worn).
- Voice quality (one voice for everyone; Supertonic 3 where the phone is fast enough).
- When to check and download updates (already does, on Wi-Fi, not in a call).
- Which machines may run models, and which model answers (the hub can measure and pick).
- Sensor "also attach" wiring.
- ΠAN Link versus the Tailscale backup route.
- Which sound plays on mute, and the vibration length.

## Things only the person can decide

- Device name, and their own name for ΠAN (Name only words).
- People: who is on their ΠAN, groups, roles (Adult, Child, Guest), other names, removing someone.
- Who may call them, and whether messages are read out or only shown.
- Whether a child's messages may be read, and what a child may do.
- Mute, and the listening mode (Normal, Listen only, Name only, Don't remember).
- Privacy: Incognito, Lock Memory and the PIN, which sensors each device may use.
- What to forget in Memory (one thing, a day, a search).
- ΠAN's personality.
- Pairing with a computer, and meeting other people's ΠAN.
- Sending a report, and installing an update when Android asks.
- Allowing permissions (microphone, location, calendar, Bluetooth, notifications, accessibility).
