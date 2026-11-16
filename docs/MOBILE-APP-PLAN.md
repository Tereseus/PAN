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

Four tabs in a bottom bar, all drawn by the app itself. The web page stays, behind a developer switch.

| Tab | What is on it | Comes from |
|---|---|---|
| **Home** | Mic on or off, big. What PAN heard and what it said, as a conversation you can also type into. One line for the connection. A "Needs you" strip: things to allow or deny, open alerts, a new device asking to join, an update that is ready. | Main screen's status and mic cards; the unreachable Conversation screen; the phone page's approvals banner and Alerts tab |
| **Memory** | Search what PAN remembers. Recent days. Photos. Delete a day or one item. | Phone page Library tab; desktop Data page (Memory, Photos, delete) |
| **Devices** | This phone: what it captures (mic, camera, location, screen) with one switch each. Accessories. Other devices: online or not, rename, remove, approve a new one, add one with a code. | Main screen's Sensors section; Settings > Accessories; phone page Sensors and Devices tabs; desktop Devices widget |
| **Settings** | Your name, PAN's voice and personality, privacy (incognito), pairing, updates, about. | See "Settings" below |

**Developer switch** (Settings > About, off by default). Turns on: the web dashboard with all its tabs,
the timing numbers on Home, the Tailscale backup section, Stop and Force Restart.

## What to take from the dashboard pages

**For everyone, into the app:**

| Thing | Why it matters | Where it goes |
|---|---|---|
| Approvals (allow or deny what Claude wants to do) | PAN waits on these; today they show as a banner on the web page and as a notification | Home, "Needs you", plus the notification that already exists |
| Alerts (acknowledge, dismiss) | The only way PAN tells you something is wrong | Home, "Needs you" |
| A new device asking to join | Today only the desktop can approve it | Home, "Needs you", and Devices |
| Capture and privacy switches | What PAN is allowed to record | Devices |
| Incognito | Privacy | Settings |
| Devices list, rename, remove, add | Managing your own things | Devices |
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
| Device Preference radios | A copy of the "Default Device" chip on Main, and picking a specific device does nothing. Keep one control, on the Devices tab, with only the choices that work. |
| Voice Quality picker | The app moves "Default" to Supertonic 3 by itself, so the choice does not stick, and one of the options is a voice that was rejected. One voice everywhere. Keep the picker for developers. |

**Wire up or remove:** Sound Effects and Vibration. Sounds and vibration play no matter what the
switches say. People do want to silence them, so make the switches work.

**Move behind the developer switch:** Tailscale (backup) and its sign-in, PAN Server address,
Stop PAN Service and Force Restart.

**Keep:** Device Name, connection status and pairing, "Mm-hm while you think", Accessories, Incognito,
Personality, App Updates.

**New order:** You (name) · Voice (personality, mm-hm, sounds, vibration) · Privacy (incognito) ·
Connection (status, pair, forget) · Updates · About (version, developer switch).

## Main screen: what goes

- "STT: idle". Nothing ever changes it.
- "First chunk" and "Total" timings. Developer switch.
- "AI - Connected". Same flag as the line above it.
- "Secure - Failed: <error text>". Say "Not connected, trying again" and keep the detail for developers.
- Service chips ("name ✕"). Developer switch.
- The "Default Device" chip. It moves to Devices.
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
| 3 | Bottom bar with Home, Memory, Devices, Settings drawn by the app; "Needs you" on Home; the typed conversation screen brought back. | Yes |
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
