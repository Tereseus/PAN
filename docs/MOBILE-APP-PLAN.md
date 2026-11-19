# Phone app cleanup plan

Written 2026-11-16 from a full read of the Android app (every screen and every setting), the phone
page the app shows in its Dashboard tab (`service/public/mobile/index.html`, 13 tabs), the desktop
dashboard (pages and widgets) and the standalone pages. Nothing here is built yet. It extends the
"Phone app first run" part of [INSTALL-PLAN.md](./INSTALL-PLAN.md).

The app grew one feature at a time while the voice path was being worked out. That was the right way
to find out what works. Now the shape is known, so this is the pass that makes it look like one product.

## What the app is today

- **Three screens you can reach:** Main, Settings, and Dashboard (a web page inside the app).
  There is no bottom bar. Two more screens exist in the code and cannot be opened: a typed
  conversation with PAN, and a command history.
- **The Dashboard is the phone page with 13 tabs:** Chat, Intuition, Dashboards, Usage, Alerts, Tasks,
  Devices, Services, Library, Projects, Sensors, Data, Settings. Most of them are tools for building
  PAN, not for using it.
- **Settings are in two places:** the app's own Settings screen and the Settings tab of the phone page.
- **The build people get is the debug build.** Test commands are active in it, the web view can be
  inspected from a computer, and plain http is allowed.
- **First start asks for every permission at once,** with no reason given, then asks to be excused
  from battery saving.

## The target

Four tabs in a bottom bar (Home, People, Memory, Settings; People came in 0.5.17), all drawn by the app itself. The web page stays, behind a developer switch.

The test for every item is what a person who bought PAN does with the app, not what helps build PAN.
That person talks to it. They open the app to see that it is on, to read or type when they can't
talk, to answer something PAN is waiting on, to look up what it remembers, and to control what it
records. Devices are set up once and then left alone, so they live inside Settings and show up on
Home only when one needs attention (a new one asking to join, one that went offline).

| Tab | What is on it | Comes from |
|---|---|---|
| **Home** | Mic on or off, big. The talk: what PAN heard, who said it, what it answered, and any photo it took. A box at the bottom that fills with your words as you speak, so you see the line before it goes (see "Home: the line you can see"). One line for the connection and one for what PAN thinks is going on. A "Needs you" strip: things to allow or deny, open alerts, a new device asking to join, an update that is ready. | Main screen's status and mic cards; the unreachable Conversation screen; the phone page's approvals banner and Alerts tab |
| **Memory** | Everything PAN has kept, found the way a person asks for it: one search box you can type or talk into (a word, a name, a date), a calendar to open any day, photos. Delete one thing, everything a search found, or a whole day. Behind the phone's fingerprint or face check. "Keep and erase": how long things are kept, and erasing on a schedule. See "Memory" below. | Phone page Library tab; desktop Data page (Memory, Photos, delete) |
| **Settings** | Your name, PAN's voice and personality, privacy (incognito and what this phone captures: mic, camera, location, screen, one switch each), your devices (online or not, rename, remove, approve a new one, add one with a code, accessories), pairing, updates, data dividend, about. | See "Settings" below; Main screen's Sensors section; phone page Sensors and Devices tabs; desktop Devices widget |

**Favourites are not settings.** "Music App" and "Messaging App" were there so that "play music"
opens the right app. Nothing ever read them. The same thing is one remembered fact: said once
("use Spotify for music"), or learned the first time PAN has to ask, then kept like anything else
he tells it. It is found in Memory by searching for it and changed by saying so. It is not a fixed
list on a screen (the first mockup had one, and it read as a page of settings). The same goes for which device does
what: PAN picks, you correct it by saying so, and Settings > Your devices has the manual choice for
when it keeps picking wrong.

**Developer switch** (Settings > About, off by default). Turns on: the web dashboard with all its tabs,
the timing numbers on Home, the Tailscale backup section, Stop and Force Restart.

## Home: the line you can see

From the owner's notes on the first mockup (2026-11-17). The box at the bottom is not a "type here"
box. It is where his line shows up while he is saying it.

- **Words appear in the box as he speaks.** The app already hears them on the phone; today they are
  only shown after the reply.
- **The line goes when he stops, as it does now.** No waiting on a button: that would slow every turn.
- **"No, wait, I meant ..." replaces it.** The hub already drops an older line when a newer one
  arrives, so a correction said right away takes the place of the first one. The box shows the swap.
- **Tap the box to fix a word or to type instead.** Then it waits for Send.
- **Who said it.** Each line in the talk carries a name: him, PAN, or "someone else". The hub already
  tells voices apart.
- **What PAN thinks is going on,** one plain line under the connection line ("In the car, driving").
  Tap it for the rest: who is here, where, what it is doing. The full read-out stays for developers.
- **Photos in the talk.** When PAN looks through a camera (phone or pendant), the picture shows as a
  small image in the talk, next to the answer about it.

## Memory

- **One search box, typed or spoken:** a word, a name or a date ("last Tuesday"). Results say who
  said it and when. "Delete all of these" removes what the search found.
- **Calendar:** open any day and see what was kept. Delete the day.
- **Lock:** opening Memory asks for the fingerprint. Deleting asks again.
  On by default; can be turned off in Settings > Privacy.
- **Keep and erase:** how long things are kept (always, a year, 90 days, 30 days, 7 days). "Erase
  the last 7 days." Erasing can be set for a time ("today at 2 pm"); PAN says so beforehand and it
  can be stopped until then.
- **All of it by voice.** "Delete everything about X", "what did I say on Friday", "erase today":
  the screen shows the same thing the voice did. Anything that deletes is confirmed on the phone.
- **The same page on the computer,** in the dashboard.
- What the hub can do today: delete one item, a list, a day, a photo, or everything. Not built:
  delete by word, keeping time, timed erase, the lock.

## Lockdown

From the owner (2026-11-17): nobody who picks up the phone should get into Memory, and there should
be an emergency way to shut everything.

The rule: **anyone can lock, only the owner can unlock.** Locking is always the safe direction, so
it needs no proof. Unlocking is always the fingerprint, after a lockdown too (owner, 2026-11-17:
"always do fingerprint", no PIN).

- **By voice:** "PAN, lock down" (the words can be changed). **By hand:** a lock button on Home and
  in the notification.
- **By itself:** when the fingerprint or face check at Memory fails too many times. The app takes a
  picture with the front camera of whoever tried and puts an alert on his other devices.
- **What a lockdown does:** Memory closes, the talk on Home is hidden, "Needs you" answers nothing,
  and PAN gives no answer from his memory by voice, on any of his devices, until he unlocks. The hub
  holds the lock, so the computer dashboard and the car lock with the phone.
- **Locking the phone itself:** Android lets an app lock the screen at once if the owner gives it
  that right one time (device admin, lock only). Offered as a switch, off by default. PAN never
  wipes anything in a lockdown.
- **Voice is the other door.** A lock on the screen means little if anyone can ask out loud what he
  said on Friday. Answers from memory go only to his own voice (the hub already tells voices apart),
  and to nobody in a lockdown.

## Who shows in the talk

A crowd would fill Home with strangers. Home shows the talk PAN is part of: his lines, PAN's lines,
and another person's line only when it belongs to that exchange (an interpreted conversation, or the
line PAN answered). The rest of what was heard is not on Home. A name shows only when more than one
person is in the talk.

## Versions

The first build of this redesign is 0.5.0 (owner, 2026-11-17). The version code keeps counting up
from the 0.4 builds.

- **0.5.0** (code 129): incognito survives a restart, Settings cleaned up, sound and vibration switches work.
- **0.5.1** (code 130): the three tabs. Home with the talk, the live box and "Needs you"; Memory with
  the fingerprint lock, search, days and delete; Settings as a tab. What it does not have yet is
  listed at the end of its entry in docs/FEATURES.md.
- **0.5.2** (code 131): the name written ΠAN, the Mm-hm switch out, Home follows the talk and shows
  the hub's words, the drop-down notification redone.
- **0.5.3** (code 132): words said before ΠAN answers join the turn in place of cancelling it; the
  live box reads as a sentence.
- **0.5.4** (code 133): an empty reply is not kept as a blank line.
- **0.5.5** (code 134): the unused voices, espeak, Vosk and Google's on-phone AI are out; a line ΠAN
  stays out of gets a small "Not for ΠAN" note with the reason.
- **0.5.6** (code 135): "where am I" goes down the normal route (the old one answered "trouble thinking").
- **0.5.7** (code 136): how long each reply took, under the line; tap for where the time went and
  what ΠAN thought was going on; the address is off Home's top line.
- **0.5.8** (code 137): an "Interpreting" badge on Home; lines the phone translates itself get their time.
- **0.5.40** (code 169, Nov 19): the models that hear are inside the app (no 107 MB download on the first mic tap); the app no longer guesses a hub by name or address; Home says when the phone was never paired and offers the scanner; three different sentences for no answer; a call's sound stops and says so when the hub is gone for 15 s; turning the mic on claims Android's microphone type; the flashlight needs the whole command; updates are quiet on a hub with no build and refuse a build without a checksum.
- **0.5.39** (code 168, published on the hub Nov 19; one patch, from 167): a call turns the mic on when the phone is muted and puts it back after; lines said in a call go to the hub alone, not joined; the update at launch waits for a network that is not metered and never comes down during a call.
- **0.5.38** (code 167, published on the hub Nov 19; patches from 161 to 166, each 124 MB because the voice is new to those builds): ΠAN's voice is inside the app (`fetchVoice` in `app/build.gradle.kts`, read from the assets), no download on first start; the app file is 219 MB. On the OnePlus Pad, the Pixel 6 and the car unit; the Pixel 10 takes it from the hub.
- **0.5.37** (code 166, published on the hub Nov 19; patches from 160 to 165): which voice speaks is decided in one tested place (`tts/VoiceChoice.kt`); every start logs its voice and every line the Android voice takes logs why; the turn's log line carries its upload size and time.
- **0.5.36** (code 165, published on the hub Nov 19; patches from 159 to 164): a device that has ΠAN's voice downloaded but whose setting still says Android (the car unit since Nov 17) moves to it at start, unless Android was chosen by hand in Settings.
- **0.5.35** (code 164, published on the hub Nov 19 with `android/publish-apk.py`; patches from 158 to 163): a call's sound is Opus, about 3 kB a second while someone talks where mu-law was 16. A call with a 0.5.34 device still works, on mu-law. Debug: `TEST_OPUS`.
- **0.5.34** (code 163, published on the hub Nov 19; rollback pair v162): a call carries the voice itself. On a call someone has joined, the phone sends its microphone's sound through the hub and plays the other's (`audio/CallAudio.kt`); ΠAN still listens for its name. Muted, you still hear them and they do not hear you. When the sound cannot get through, the written lines are read out as before. 0.5.33 was the same without a debug switch used to test it with no sound.
- **0.5.32** (code 161, published on the hub Nov 18; rollback pair v160): the hub's web page is out of the app. In its place, behind the developer switch, is **Hub**: two of the app's own screens, Services (what runs on the hub, what is down first, parts that send no sign of life as one line) and Intuition (what ΠAN reads about the owner now, why, and what it read it from). Read only, fresh every 15 seconds while open.
- **0.5.31** (code 160, published on the hub Nov 18; rollback pair v159): the hub dashboard inside the app also drops Devices, Dashboards and Sensors (the owner's call); Services and Intuition come first.
- **0.5.30** (code 159, published on the hub Nov 18; rollback pair v158): a call with a whole group. In People, with the organization or a group picked in the drop down, a "Call <name>" button rings everyone in it; "Earlier calls" shows what you said and heard in that group's calls. A group's call has its own screen (who is on, the lines with who said each, Leave, the same typing box and microphone as Home). A group call that rings shows on every tab and as a ringing notification with Answer and Not now, like a call from one person.
- **0.5.29** (code 158, published on the hub Nov 18; rollback pair v157): the Command log is gone (a debug list of typed questions sent the old way, which Home already shows; its list could not scroll because the device cards above it took the whole screen). The other developer button is now "Hub dashboard" with a line saying what it is. Inside the app the hub's page drops its old typed chat with the project and session rows, and the empty Tasks and Projects tabs; Devices comes first.
- **0.5.28** (code 157, published on the hub Nov 18; rollback pair v156): a conversation in People has the same box as Home (the words, the send arrow at their end, the microphone to the right), and Home's box has no X beside the send arrow any more (it could wipe what was typed; Back leaves typing when nothing is typed).
- **0.5.27** (code 156, Nov 18): every device of a person notices when a call opens or closes on another of their devices, so the call strip shows there too.
- **0.5.26** (code 155, published on the hub Nov 18; rollback pair v154): a call shows on every tab and rings as a notification with Answer and Not now; the conversation has the big microphone in the corner, a "Call" button and a line saying where your voice goes; "Don't take calls from <name>".
- **0.5.25** (code 154, published on the hub Nov 18; rollback pair v153): People opens on one drop down (your organization, its groups, everyone else), the list is plain, everything about a person is in the "..." inside their conversation, a person can be in several groups, and a call can be answered with "Not now". Details: docs/FEATURES.md "Groups inside the organization".
- **0.5.24** (code 153, published on the hub Nov 18; rollback pair v152): the mute button is on the People list too.
- **0.5.23** (code 152, published on the hub Nov 18; rollback pair v151): the mute button is inside a conversation in People too. The hub side of the same day: a person's device takes only its own person's voice (docs/FEATURES.md "Whose voice on a person's device").
- **0.5.22** (code 151, published on the hub Nov 18; rollback pair v150): People has two parts, your organization and Others. Groups inside the organization (make, name, move people, delete), and other names for a person whose name ΠAN mishears. Details: docs/FEATURES.md "Groups inside the organization".
- **0.5.21** (code 150, published on the hub Nov 18; rollback pair v148, 0.5.20 was never published on its own): a call with someone on your ΠAN (say "ΠAN, talk to <name>" or tap the call button, then just talk), and a switch for whether messages are read out or only shown. Details: docs/FEATURES.md "Messages between people".
- **0.5.20** (code 149, Nov 18, on the test devices only; it went out as part of 0.5.21): People > Met. Show your code, scan theirs, and your ΠAN keeps that you met; forget anyone. The owner names the group. Details: docs/FEATURES.md "People met".
- **0.5.19** (code 148, published on the hub Nov 18; rollback pair v147): the data dividend row is off Settings until it does something.
- **0.5.18** (code 147, published on the hub Nov 18; rollback pair v146): the owner can read a child's messages from the child's row in People, and the child's device says so. Settings is a list of five pages in place of one long scroll; nothing removed. Not seen on a screen yet. Details: docs/FEATURES.md "A child's messages, and Settings as pages".
- **0.5.17** (code 146, published on the hub Nov 18; rollback pair v145): the People tab. Everyone else on this ΠAN, the conversation with each (said to ΠAN or typed), a count of new messages on the tab, and for the owner adding, renaming and removing people (moved here from Settings). Needs the hub's `/api/v1/people` calls. Not seen on a screen yet. Details: docs/FEATURES.md "People tab".
- **0.5.16** (code 145, published on the hub Nov 18; rollback pair v143): (1) On a device paired for a person other than the owner the app no longer asks the hub for the owner's things. It used to ask for terminal approvals, alerts, Intuition and the device list every few seconds and was refused each time. `PanServerClient.ownersDevice()` reads `person` from `GET /api/v1/auth/me` (asked again every minute, since the owner can take a device back) and the four polls stop while it is a person's device. So do device registration (it retried for ever), the upload queue and the history load. Watched for 50 s on the test phone that is a person's: only `/health`, its notes and `auth/me`, all 200; the owner's tablet keeps every poll. (2) Settings has "Reminders and messages" (`ui/settings/NotesDevice.kt`): which of the owner's devices ΠAN's notes come to, with "Send them here" and "Follow me" (the hub's `notes_device` setting, `service/src/phone-notes.js`). (3) People has Rename. Includes 0.5.15's 16 KB work.
- **0.5.15** (code 144, Nov 18, not on the hub yet): the "Android App Compatibility" notice about 16 KB pages is gone. Two libraries had 4 KB aligned LOAD segments: `libtensorflowlite_jni.so` (TensorFlow Lite 2.16.1, now LiteRT 1.4.2, same API) and `libgojni.so` (ours, `pan-vpn/build-aar.sh` now links it with `-z max-page-size=16384`). The other seven the notice listed were already fine: Android lists every library once one fails, the good ones as "Unknown error". Seen on the Pixel 6 Pro test phone: no notice, `pageSizeCompat` 4 to 0, hub reached, YAMNet loaded and heard speech. Check an APK with `zipalign -c -P 16 -v 4` and `llvm-readelf -lW` on each .so (every LOAD line must end in 0x4000).
- **0.5.14** (code 143, published on the hub Nov 18): People in Settings. The owner adds a person (adult, child or guest), gets a one-time code for their device, and removes them. A device paired with the code talks to ΠAN as that person and reaches nothing of the owner's. Seen on the test tablet.
- **0.5.13** (code 142, published on the hub Nov 18): an interpreted line is spoken in its own language when that language is written in Latin letters (Vietnamese, Spanish, French...); before, the voice was told it was English. Heard on the test tablet: a Vietnamese line in ΠAN's own voice.
- **0.5.12** (code 141, published on the hub Nov 18): the hub can tell the device to mute, for when the device's own ear missed the words (the car). Seen on the test tablet: muted 27 ms after the line.
- **0.5.11** (code 140, published on the hub Nov 18): a Japanese line asks for its reading three times, not once. Memory still opens only with a fingerprint; a device without one cannot open it (a PIN was written and switched off, owner's call).
- **0.5.10** (code 139, published on the hub Nov 18): tap the Interpreting badge to stop; a short word only one ear heard is left out; Settings, About has the credits list.
- **0.5.9** (code 138): a Japanese line shows its Latin letters under it, and a tap opens it word by word with meanings (the hub works the reading out).

## Every feature and where it shows

| Feature that exists | Where a buyer meets it |
|---|---|
| Talking to PAN, typing to PAN | Home |
| Who is talking (voice ID) | Home, a name on each line; Memory results |
| What PAN thinks is going on (Intuition) | Home, one line, more on tap |
| Camera and pendant photos | Home, in the talk; Memory > photos |
| Allow or deny, alerts, a new device, an update | Home, "Needs you" |
| Interpreter | Home: a bar "Interpreting, Greek and English" with Stop |
| Claude threads by voice | Home, as lines in the talk with the thread's name; the chat page stays behind the developer switch |
| Music, directions | Voice; the result is a line in the talk |
| Mute | Home, the mic button; by voice once the app can be told to mute |
| Incognito | Settings > Privacy; a badge on Home while it is on |
| Lockdown | Not built. Voice, a button on Home, or failed checks at Memory; see "Lockdown" |
| Car and hands-busy mode | Automatic; Settings > Voice |
| Places where PAN does not record (zones) | Settings > Privacy |
| Devices, accessories, pairing | Settings > Your devices, Connection |
| Search, delete, keeping time | Memory |
| Data dividend | Settings. Not built; off until he turns it on |
| Updates | Settings; "Needs you" when one is ready |
| Usage, models, services, tasks, projects, tests | Developer switch |

## What to take from the dashboard pages

**For everyone, into the app:**

| Thing | Why it matters | Where it goes |
|---|---|---|
| Approvals (allow or deny what Claude wants to do) | PAN waits on these; today they show as a banner on the web page and as a notification | Home, "Needs you", plus the notification that already exists |
| Alerts (acknowledge, dismiss) | The only way PAN tells you something is wrong | Home, "Needs you" |
| A new device asking to join | Today only the desktop can approve it | Home, "Needs you", and Settings > Your devices |
| Capture and privacy switches | What PAN is allowed to record | Settings > Privacy |
| Incognito | Privacy | Settings |
| Devices list, rename, remove, add | Managing your own things | Settings > Your devices |
| Memory search, photos, delete | The product promise is "PAN remembers" and you can see and remove it | Memory |
| Personality, your name | Small, personal, used | Settings |
| One line of what PAN thinks is going on | Already on Main; keep it to one line | Home |

**Behind the developer switch (stays on the web page):** Chat with Claude sessions and the model
picker, Usage and plan limits, the Dashboards list (models page, jobs page), the full Intuition
read-out, Services, Tasks, Projects, raw Data, Diagnostics.

**Desktop only, never on the phone:** Tests, Instances, Lifeboat, Pipeline, Benchmarks, Perf, Atlas,
Kronos, Crucible, Automation, organisation and team management, sign-in providers, email setup,
terminal colours.

## Settings: what goes, what stays

**Remove. Nothing reads these, or what they say is no longer true:**

| Setting | Why |
|---|---|
| Voice Responses switch | Nothing reads it. Mute is the mic switch. |
| Music App, Messaging App | Nothing reads them. |
| Query Answers (Cloud / Local / Auto) | "Local" calls an empty stub, so every choice does the same thing. |
| Local AI Model section: status pill, "AI Backend: Server (Cerebras)", Add Custom Model | The pill shows the raw word "server". The Cerebras line is false. The custom model is saved and never used. |
| Gemini API Key | Nothing reads it, it is shown unmasked, and users never handle keys. |
| Device Preference radios | A copy of the "Default Device" chip on Main, and picking a specific device does nothing. Keep one control, under Settings > Your devices, with only the choices that work. |
| Voice Quality picker | The app moves "Default" to Supertonic 3 by itself, so the choice does not stick, and one of the options is a voice that was rejected. One voice everywhere. Keep the picker for developers. |

**Wire up or remove:** Sound Effects and Vibration. Sounds and vibration play no matter what the
switches say. People do want to silence them, so make the switches work.

**Move behind the developer switch:** Tailscale (backup) and its sign-in, PAN Server address,
Stop PAN Service and Force Restart.

**Keep:** Device Name, connection status and pairing, "Mm-hm while you think", Accessories, Incognito,
Personality, App Updates.

**New order:** You (name) · Voice (personality, mm-hm, sounds, vibration) · Privacy (incognito, what
this phone captures, places where PAN does not record, the Memory lock) · Your devices (list, add,
accessories, which one acts) · Connection (status, pair, forget) · Updates · Data dividend ·
About (version, developer switch).

## Main screen: what goes

- "STT: idle". Nothing ever changes it.
- "First chunk" and "Total" timings. Developer switch.
- "AI - Connected". Same flag as the line above it.
- "Secure - Failed: <error text>". Say "Not connected, trying again" and keep the detail for developers.
- Service chips ("name ✕"). Developer switch.
- The "Default Device" chip. It moves to Settings > Your devices.
- The "PAN Dashboard" button. The tabs replace it.

## One look

Today: the theme sets 8 of the colours and leaves the rest to Android's defaults, there is no type
scale and no shape rule, cards use three paddings, and the same kind of action is a filled button in
one place and a text button in another. The phone page has its own palette, 12 font sizes and six
button radiuses.

- **One palette for the app and the phone page.** Name every colour the screens use (including the
  red for "live" and the warning yellow) in one place each: `ui/theme/Theme.kt` and the page's CSS
  variables, same values.
- **Type and shapes:** one scale (title, body, label, small), one card (16 padding, 12 radius),
  one spacing step.
- **Buttons:** one filled button per screen for the main action, text buttons for the rest, outlined
  red for anything that deletes or stops.
- **One name:** ΠAN in headings and notifications, never "Π" alone in one place and "PAN" in another.
- **Plain words:** no "STT", "Tailscale", "Craft", "PTY", "proxy" or error text from the code on any
  screen a buyer sees. "…" not "...".
- **All text in `strings.xml`.** Today every string is written in the Kotlin files, so nothing can be
  translated.

## When the connection is bad

Added 2026-11-17 after a drive through places with weak signal: the only sign was a late "server
didn't respond", so there was no way to tell a dead link from a slow one.

- **Home's connection line says which part is the problem,** in plain words: "Connected", "Weak
  signal, answers will be slow", "No internet", "Can't reach your home computer".
- **A failed reply says why,** out loud and on screen: no internet on this device, or the home
  computer did not answer. Never the same sentence for both.
- **The line turns to "weak" before a reply fails,** from what the app already measures: how long
  the last upload took and how long the link takes to answer.
- **A speed number (kB/s) is for developers only.** A buyer gets the words, not the number.
- **The same line shows in the notification,** so it can be read without opening the app.
- Related, and the bigger win: on a slow link a long sentence takes 9 to 14 s because its sound is
  uploaded only after he stops talking (car, 2026-11-17). Sending the sound while he talks,
  compressed, is the fix; it is voice work, not app design.

## First start

Welcome, then one permission at a time with one sentence of why (mic first, the rest when the feature
is first used), then "Scan the code on your computer", then done. The battery question comes with a
sentence of why. This is the flow already in INSTALL-PLAN.md.

## Bugs found while reading

| # | Where | What |
|---|---|---|
| 1 | App | Incognito is only put back when Settings or Dashboard is opened. After an app restart, events are not incognito until then. Fix first: it is a privacy bug. |
| 2 | Hub | Anyone who can reach the approvals answer route can allow or deny. There is no check of who is asking. |
| 3 | Phone page, Services | Every service shows as stopped. The page looks for "running", the hub says "up". |
| 4 | Phone page, Tasks | The list request has no handler on the hub. |
| 5 | Phone page, Settings | "+ Add Device" says the code lasts 24 hours. It lasts 30 minutes. |
| 6 | Phone page, Sensors | The switch sends the sensor's name where the hub expects its id. |
| 7 | Desktop, Approvals widget | Every row shows "Permission" with no description. It reads field names the hub does not send. |
| 8 | Phone page, Settings | Two sections are both called "Devices" and disagree on who is online. |
| 9 | Desktop, Settings | Remote Access and the Treasury wallet call hub routes that do not exist. |
| 10 | Phone page | An owner name and a project number are written into the page as fallbacks. |
| 11 | App source | An old backup copy of a source file sits next to the real one. |

## Order of work

| Step | What | Needs an app build |
|---|---|---|
| 1 | Bugs 1 to 8. Hide the developer tabs on the phone page behind a switch (default: Chat, Alerts, Devices, Sensors, Library, Settings). | Only bug 1 |
| 2 | Settings and Main cleanup: remove the dead items, the debug text and the word Tailscale; make Sound and Vibration work; one theme. | Yes |
| 3 | Bottom bar with Home, Memory, Settings drawn by the app; "Needs you" on Home; the typed conversation screen brought back. **Done in 0.5.1.** | Yes |
| 3b | Memory: keeping time and timed erase, spoken search, the same page on the dashboard, forgetting the vector copy too. Lockdown. Memory answers by voice only to his voice. Names on lines when more than one person talks. | Yes, and the hub |
| 4 | First start flow. | Yes |
| 5 | A signed release build in place of the debug build. Moving from the debug key to a release key means one reinstall and one new pairing per phone. | Yes |

Every app build is tried on the test tablet first and goes out over the air like the builds before it.

## Open choices

1. **Where the Claude session chat lives.** This plan puts it behind the developer switch and keeps
   only the allow / deny part for everyone. The other way is a fifth tab, "Work", that shows only
   when Claude is connected.
2. **The voice picker.** This plan removes it for buyers (one voice). The other way is to keep it
   with only the voices that are good.
3. **Colours.** This plan keeps today's dark look and makes it consistent. The other way is to take
   the colours from the website.
4. **The Memory lock.** This plan asks for fingerprint or face every time Memory opens. The other
   way is only when something is deleted.
5. **Who said it, for buyers.** Settled 2026-11-17: a name only when more than one person is in the talk.
