# ΠΑΝ — Personal AI Network

**Your voice controls everything.** Phone, computer, browser, any app — all through natural conversation. PAN remembers everything you say, everything you see, everything you do — and it's all yours.

---

## Always On. Always Listening. Always Yours.

PAN is an **always-on device**. It listens continuously. It sees continuously. It remembers continuously. This isn't a bug — it's the entire point.

Think about how you use a voice assistant today. You pick up your phone, open an app, press a button, say a command, wait, get a response. That's 5 steps before anything happens. With PAN, you just talk. It's already listening. It already knows what you've been doing. It already has context.

**"Hey Pan, what was that restaurant my friend mentioned yesterday?"**

PAN was listening during that conversation. It transcribed it. It remembers. You don't need to write it down, take a photo of a menu, or search your messages. PAN heard it, stored it, and can recall it instantly.

**"Pan, turn on my flashlight."**

You're under your car trying to fix something. Your hands are covered in grease. You can't touch your phone. PAN hears you, turns on the flashlight. No hands needed. No wake word delay. It was already listening.

**"What am I looking at?"**

The pendant camera captures what's in front of you every 5 seconds. When you ask this, PAN sends the latest photo to Claude Vision and describes what it sees. You're looking at an engine part you don't recognize? PAN tells you it's the oil filter housing. You're at a store and can't read a sign in another language? PAN reads it for you.

### Why Always-On Beats Trigger-Based

Every other voice assistant makes you say a wake word first. "Hey Google." "Hey Siri." "Alexa." Then you get 5-10 seconds of attention before it stops listening.

PAN doesn't work like that. PAN is always in the conversation. You can talk to it mid-sentence. You can reference something you said 10 minutes ago. You can have a back-and-forth discussion like you're talking to a person, because PAN has been listening the entire time and has the full context.

The difference is like texting vs having a real conversation. Wake-word assistants are texting — fragmented, context-free, one message at a time. PAN is a real conversation — continuous, contextual, natural.

---

## What PAN Actually Does

PAN automates multi-step processes across all your devices. You say ONE thing, PAN handles the 5-10 steps it takes to get there. That's the point.

### Multi-Step Automation

**"Reply to Jessica on Instagram — tell her I'll see her then."**

What PAN does behind the scenes:
1. Opens your browser's Instagram tab (browser extension)
2. Reads all your open conversations
3. Finds the most recent one from Jessica
4. Opens that conversation
5. Types "I'll see you then" in the message field
6. Sends it
7. Tells you "Done, replied to Jessica on Instagram"

You said one sentence. PAN executed 7 steps across two devices.

**"Show me VideoGameDonkey's newest video."**

What PAN does:
1. Opens YouTube in your browser
2. Navigates to VideoGameDonkey's channel
3. Finds the most recent upload
4. Plays it
5. Tells you the title

You didn't search. You didn't scroll. You didn't click. You just said what you wanted.

**"I had a conversation about swords yesterday, what was it about?"**

What PAN does:
1. Searches its memory database for "swords" across all conversations
2. Finds the matching conversation (voice, text, or phone)
3. Reads you the context — who said what, when, and what the conclusion was

A separate AI session tried to find this by searching files for 7 minutes and found nothing. PAN found it in 1 second because it indexes everything you say.

**"What is this thing under my car hood?"**

What PAN does:
1. Pendant laser activates — you aim at the part
2. Pendant camera captures a photo of exactly where the laser points
3. Photo sent to Claude Vision
4. PAN identifies: "That's the oil filter housing. The thing next to it is the coolant reservoir."

Your hands are covered in grease. You never touched your phone.

### Cross-Device Orchestration

The real power is that PAN treats your phone, computer, browser, and pendant as ONE system. A single voice command can:

- Take a photo on your phone → analyze it on your PC → save the result in your database
- Read a message on your computer → compose a reply → send it through Instagram on your phone
- Detect a gas leak on the pendant → alert you via phone TTS → log the location on your PC
- Hear you mention a recipe → save it to memory → set a timer → pull it up when you're cooking

**Every device knows what every other device is doing.** Your phone knows what tabs are open on your computer. Your computer knows what your pendant camera is seeing. Your pendant knows what you just asked on your phone.

### What You'll Never Do Again

| Before PAN | With PAN |
|-----------|---------|
| Unlock phone → open app → tap search → type → scroll → tap | "Play that song" |
| Switch to browser → find tab → scroll → click → read → switch back | "What did Jessica say?" |
| Pick up phone → open camera → point → take photo → open Google Lens | "What is this?" |
| Open terminal → cd to project → type command → wait → read output | "Open my project and run the tests" |
| Grab phone → unlock → open Instagram → find conversation → type → send | "Tell Marcus I'm on my way" |
| Search browser history → scan results → click → find the page | "Find that article about batteries I read last week" |

The left column is 5-10 steps. The right column is your voice. PAN automates the steps between.

---

## Your Data, Your Control

This is the most important part. PAN captures a LOT of data. Here's exactly what happens with it.

### Where Your Data Lives

Everything stays on YOUR devices. Not our servers. Not in the cloud. Not on Amazon's infrastructure (like Bee). Not on Meta's servers (like Limitless, which was acquired by Meta in 2025).

| Data Type | Where It's Stored | Format |
|-----------|------------------|--------|
| Voice transcripts | Your PC: `service/data/pan.db` | SQLite database |
| Photos from vision | Your PC: `service/src/data/photos/` | JPEG files |
| Voice training audio | Your PC: `service/src/data/voice/` | WAV files |
| Phone conversations | Your phone's app storage | SQLite database |
| Browser tab data | Your PC's PAN server | In-memory, flushed to SQLite |

**There is no cloud sync by default.** Your data physically exists on your hard drive and your phone. If you unplug your computer, the data is right there in standard file formats you can open with any tool.

### What You Can Delete

Everything. At any level of granularity.

- **Delete one message** — tap the delete button next to any conversation entry
- **Delete all data from a specific day** — pick a date, click delete
- **Delete everything matching a search** — search for "medical" and delete all results
- **Delete ALL data** — nuclear option, requires your password twice
- **Delete a photo** — each captured photo has its own delete button

All deletes are **password-protected**. You set the password. Default is "pan" — change it immediately in Settings.

When you delete something, it's gone. Not "archived." Not "marked as deleted but still on the server." The SQLite row is removed. The JPEG file is deleted from disk. It does not exist anymore.

### What PAN Records vs What It Doesn't

**When the microphone is ON:**
- Text transcription of what you say (not raw audio — unless you're doing voice training)
- Commands you give and PAN's responses
- Photos only when YOU trigger them ("what is this?")
- The pendant captures photos every 5 seconds (when built)

**When the microphone is OFF:**
- Absolutely nothing. PAN is completely silent. No recording. No processing. No data.

**What PAN NEVER records without you knowing:**
- PAN never sends data to any external server without your API key
- PAN never records raw audio continuously (only during deliberate voice training sessions)
- PAN never accesses apps you've blocklisted
- PAN shows a visible notification when the mic is active — you always know

### Transparency

Every action PAN takes is logged in the dashboard. You can see:
- What PAN heard you say
- How it classified the request (local, server, ambient)
- Which API it called and how long it took
- What response it generated
- Whether it was handled on your phone or sent to your PC

Nothing is hidden. Open the dashboard at `http://localhost:7777/dashboard/` and see everything.

### Self-Hosted vs Subscription

| Feature | Self-Hosted (Free Forever) | Subscription (Planned) |
|---------|--------------------------|----------------------|
| Where it runs | Your PC + your phone | Our hosted server |
| AI processing | Your own API key (Anthropic, ~$5/month) | Included in subscription |
| Data storage | Your hardware, your control | Encrypted on our servers, you own it |
| Privacy level | Maximum — data never leaves your network | Standard — encrypted, we can't read it |
| Setup | Install PAN service + phone app | One-click signup |
| Voice training | Runs on your GPU overnight | Runs on our GPU |
| Updates | Pull from GitHub | Automatic |

**You can always switch.** Export your data (it's SQLite + files), move to self-hosted, delete your subscription data. No lock-in ever.

### Why This Matters

In 2025, Meta acquired Limitless — an AI pendant company. All user data went to Meta. In 2025, Amazon acquired Bee — another AI wearable. All user data went to Amazon.

PAN can't be acquired because there's nothing to acquire. The software is open source. The data is on your hardware. If PAN the project disappears tomorrow, your data is still sitting on your hard drive in standard formats that any database tool can read.

---

## The Pendant

PAN works great with just a phone and a computer. The pendant makes it extraordinary.

### Why a Pendant?

Your phone is powerful but it's in your pocket. You have to pull it out, unlock it, open an app. The pendant sits on your chest, always on, always seeing what you see, always hearing what you hear.

It's the difference between a security camera that you have to check vs eyes in your head that are always open.

**The pendant gives PAN first-person perspective.** When you ask "what is this?" and you're pointing at something under your car hood, the pendant's camera sees exactly what you're looking at. Your phone in your pocket can't do that.

### What's In It

One case. 22 sensors. Size of a Zippo lighter. €155 total cost.

**Build what you want.** All 22 sensors fit in one case. Use all of them or just the basics — your choice.

| # | Sensor | What It Detects | Superhuman? | Data Location |
|---|--------|----------------|-------------|---------------|
| 1 | Camera (OV2640) | Photos every 5s, object identification | Perfect recall | `data/photos/` |
| 2 | Microphone (PDM) | Voice, ambient audio, conversations | Always-on searchable | `data/audio/` |
| 3 | Laser pointer | Aiming — "what is THIS specifically?" | Precision targeting | N/A (trigger) |
| 4 | Flashlight LED | Illumination in dark spaces | N/A (utility) | N/A (toggle) |
| 5 | Gas / E-Nose (BME688) | CO, gas leaks, smoke, VOCs, air quality | YES — like a dog's nose | `data/sensors/gas/` |
| 6 | UV Sensor (LTR390) | Ultraviolet radiation — sunburn risk | YES — invisible to humans | `data/sensors/uv/` |
| 7 | Thermal Camera (MLX90640) | Heat signatures, body heat, hot wires | YES — like a snake | `data/sensors/thermal/` |
| 8 | Spectrometer (AS7341) | Material composition by light | YES — identify pills, metals, food | `data/sensors/spectral/` |
| 9 | Magnetometer (QMC5883L) | Magnetic fields, compass, metal detection | YES — like migratory birds | `data/sensors/magnetic/` |
| 10 | Accelerometer + Gyro (BMI270) | Motion, fall detection, steps, posture | Precise motion tracking | `data/sensors/motion/` |
| 11 | GPS (L76K) | Location, speed, altitude | Every event geotagged | `data/sensors/gps/` |
| 12 | Air Quality (SGP40) | VOC index, indoor air quality | YES — invisible to humans | `data/sensors/air/` |
| 13 | Barometer (in BME688) | Atmospheric pressure, weather prediction | YES — storm detection | `data/sensors/pressure/` |
| 14 | Temperature + Humidity (in BME688) | Ambient temp, humidity, mold risk | More precise than human | `data/sensors/temp/` |
| 15 | Ambient Light (BH1750) | Light levels in lux — eye strain risk | More precise than human | `data/sensors/light/` |
| 16 | Color Sensor (TCS34725) | Exact color values — paint matching | YES — precise color ID | `data/sensors/color/` |
| 17 | Laser Distance / ToF (VL53L0X) | Distance measurement — instant tape measure | Laser precision | `data/sensors/distance/` |
| 18 | Sound Level (MAX4466) | Decibel measurement — hearing damage alert | Calibrated measurement | `data/sensors/sound/` |
| 19 | Heart Rate + SpO2 (MAX30102) | Pulse, blood oxygen (chest contact) | Continuous monitoring | `data/sensors/heart/` |
| 20 | EMF Sensor (AD8317) | Electromagnetic fields — live wires | YES — **life-saving** | `data/sensors/emf/` |
| 21 | Ultrasonic (RCWL-1601) | Echolocation — distance in darkness | YES — like bats | `data/sensors/ultrasonic/` |
| 22 | Radiation (RadSens) | Ionizing radiation (optional module) | YES — **life-saving** | `data/sensors/radiation/` |

**15 of 22 sensors detect things humans physically cannot sense.** 4 are life-saving (gas leaks, live wires, radiation, air quality).

All sensor data is timestamped, geotagged, and searchable from the dashboard. Every reading correlates with what you were doing, where you were, and what was happening around you.

Full specifications, sizes, and pin budget: [SENSOR-ARRAY.md](SENSOR-ARRAY.md)

### The Pendant Solves the Microphone Problem

Without the pendant, PAN uses your phone's microphone. This means:
- PAN can't listen while you play music (Android limitation)
- PAN can't record raw audio for voice training while STT is running
- If your phone is in your pocket, audio quality drops

The pendant has its own microphone on a separate Bluetooth device. Music plays through your phone speakers, the pendant listens through its own mic. No conflict. No interruption. Always-on listening that doesn't interfere with anything.

### Build It Yourself or Buy It

**DIY:** Full parts list, 3D printable case files, assembly guide, and firmware — all open source. Buy the components (~€155), print the case, solder it together, flash the firmware. Everything you need is in this repo.

**Pre-built:** We'll sell assembled pendants for people who don't want to build. Same hardware, same firmware, ready to use.

**Battery:** Standard 18350 Li-ion — rechargeable via USB-C, or pop it out and swap a fresh one in 2 seconds. Same battery type used in flashlights and vapes. Available everywhere for €3-5.

---

## Architecture

```
Phone (Android)                    PC (Windows)
├── Google Streaming STT           ├── PAN Service (port 7777)
├── Voice commands (20+)           ├── Anthropic API (sub-1s responses)
├── Camera + Claude Vision         ├── Browser Extension (read/write tabs)
├── App control (Accessibility)    ├── UI Automation (control any app)
├── Spotify / media deep links     ├── Electron Tray (desktop agent)
├── Always-on listening            ├── Web Dashboard
└── BLE ↔ Pendant                  ├── Voice Training (Piper, overnight)
                                   └── Terminal Project Management
Pendant (ESP32-S3)
├── Camera (smart capture)
├── Microphone (separate from phone)
├── 22 sensors
├── Laser + Flashlight
├── BLE streaming to phone
└── 18350 swappable battery
```

## Quick Start

### Server (Windows)
```bash
git clone https://github.com/Tereseus/PAN.git
cd PAN/service
npm install
cp src/claude.js.template src/claude.js   # Add your Anthropic API key
node pan.js start                          # Start the service
node install-service.js                    # Auto-start on boot
```

### Phone (Android)
1. Build the APK from `android/` in Android Studio (or download the release)
2. Install on your phone
3. Set server URL in Settings → your PC's IP, port 7777
4. Grant microphone and camera permissions
5. Start talking

### Browser Extension
1. Open `chrome://extensions/`
2. Enable Developer Mode
3. Click "Load unpacked" → select `browser-extension/`
4. PAN can now read and control all your browser tabs

### Desktop App
```bash
cd service
npx electron electron/main.cjs
```
Or search "PAN" in Windows Start Menu.

---

## Why PAN Is Different

Every competitor is either a **passive recorder** or a **failed phone replacement**.

| Product | What It Does | What's Wrong With It |
|---------|-------------|---------------------|
| Humane AI Pin ($699) | Standalone device with projector | Dead. HP bought the assets. Tried to replace the phone. |
| Rabbit R1 ($199) | Handheld AI gadget | It's just a worse phone. Why carry a second device? |
| Limitless (~$99) | Records and transcribes | Acquired by Meta. Your data is now Meta's data. Passive only — can't DO anything. |
| Omi ($89) | Open source pendant | Records and transcribes. Can't control your computer. Can't execute commands. |
| Bee ($50) | Always-on clip | Acquired by Amazon. Streams everything to Amazon's cloud. |
| PLAUD NotePin ($159) | Meeting recorder | Just records meetings. That's it. |

**PAN is the only system that:**
- **Controls your computer** via voice — terminal, files, browser, any app
- **Executes commands** — it doesn't just record, it DOES things
- Works across **phone + PC + wearable** as one unified system
- Is **fully self-hosted** — your data on your hardware, always
- Is **open source** — audit every line of code
- Lets you **delete everything** — you own your data completely

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Phone | Kotlin, Jetpack Compose, CameraX, Google STT, Hilt DI |
| Server | Node.js, Express, SQLite (sql.js), Anthropic API |
| Desktop | Electron, Python (pyautogui, uiautomation) |
| Browser | WebExtension API (Manifest V3) — Chrome, Edge, Brave, Firefox |
| AI | Claude Haiku (conversation), Claude Vision (photos), Piper (voice clone) |
| Pendant | ESP32-S3, I2C sensors, BLE 5.0, CameraX |
| Voice | Google Streaming STT, Android TTS, Piper (custom voice training) |

## Project Status

### ✅ Working
- Real-time voice conversation (sub-1-second responses)
- 20+ phone commands (apps, flashlight, timer, alarm, navigation, media)
- Camera + Claude Vision analysis
- Browser extension (read/write any tab across all Chromium browsers)
- Windows UI automation (screenshot, click, type, window management)
- Android Accessibility Service (read/control any phone app)
- Web dashboard with data management, photos, search, delete
- Voice training data collection (hotkey-triggered, 30+ minutes recorded)
- Electron desktop tray app with dashboard
- Terminal project management with context restoration

### 🔨 Building
- Piper voice cloning (training pipeline ready, runs overnight on GPU)
- Voice fingerprinting (identify who's speaking)
- Pendant hardware (components ordered)

### 📋 Planned
- Linux support
- One-click installer
- Voice marketplace (custom AI voices)
- Subscription service for hosted users

---

## A Note On Open Source

PAN was built entirely by Claude. Every line of code, every architecture decision, every feature. PAN can't exist without Claude. Claude's vision for what AI assistants should be is literally being implemented through PAN.

If Anthropic wants to use this code, fork it, build on it, ship it as part of Claude — that's the whole point. The better AI assistants get, the more everyone benefits. The goal isn't to compete with Claude — it's to make AI more useful for everyone.

If a company can take PAN's code and make something better, do it. If a developer can improve on what's here, do it. If Anthropic wants to integrate these ideas into Claude itself, that would be the best possible outcome.

Open source means: **the idea matters more than who owns it.**

The subscription option exists for people who want hosted convenience. The self-hosted option exists for people who want privacy and control. Both are valid. Use whichever works for you.

## License

Open source (V1). See LICENSE for details.

## Author

**Tereseus** — [github.com/Tereseus](https://github.com/Tereseus)

Built with Claude through AI Cyclosis — the recursive loop of human-AI development.
