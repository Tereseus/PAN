# ΠΑΝ — Personal AI Network

Voice-controlled AI operating system. Phone, computer, browser, wearable pendant — one unified system. Self-hosted, open source, all data on your hardware.

---

## What PAN Does

PAN routes voice commands across all your devices. One sentence triggers multi-step automation across your phone, PC, browser tabs, and pendant sensors. Always-on microphone — no wake word, no button press, continuous context.

### Always-On vs Trigger-Based

Other assistants: wake word → 5-10 seconds of attention → done. PAN: continuous listening with full conversation context. You can reference something you said 10 minutes ago. You can interrupt mid-sentence. It's a conversation, not a command prompt.

### Multi-Step Automation

**"Deploy my project."**
1. Opens terminal on PC → navigates to project directory
2. Runs test suite → waits for results
3. Tests pass → git commit → git push
4. Monitors CI pipeline
5. Reports back: "All tests passed, deployed to production"

**"Show me VideoGameDonkey's newest video."**
1. Opens YouTube in browser (via browser extension)
2. Navigates to the channel
3. Finds most recent upload → plays it
4. Tells you the title

**"I had a conversation about swords yesterday, what was it about?"**
1. Searches memory database for "swords" across all conversations — voice, text, phone, every device
2. Finds the matching conversation
3. Reads back the full context — who said what, when, what the conclusion was

PAN indexes every conversation across all devices. A separate AI session searched files for 7 minutes and found nothing. PAN found it in 1 second.

**"What is this pill I found on the floor?"**
1. Pendant spectrometer (AS7341) reads spectral signature
2. Pendant camera captures photo → sends to Claude Vision
3. Cross-references color, shape, spectral data, visible markings
4. Identifies ibuprofen 200mg from spectral + visual match

**"Find that article about battery tech I was reading last week and send it to my work email."**
1. Searches browser history + PAN memory for "battery" articles from last week
2. Finds the URL → opens email in browser
3. Composes email with link → sends it

### Proactive Awareness

PAN doesn't just respond to questions — it learns your patterns over time and helps before you ask. You choose what it monitors and how much it tells you.

**Sun exposure:**
PAN knows you've been outside for 3 hours. It knows the UV index at your GPS location. It knows from weeks of observation that you don't wear sunscreen. It tells you: "You should put on sunscreen. UV index is 7 and you've been outside since noon." It figured this out from GPS, UV sensor, time tracking, and your habits — not because you asked.

**Nutrition:**
The pendant camera sees your meals. PAN identifies what you're eating through vision analysis, estimates portions, and tracks your intake. After lunch: "That's your third high-sugar meal today. You've had about 80g of sugar — that's over your daily target." No food diary app. No manual logging. PAN just sees what you eat and keeps track.

**"Where did I leave my keys last night?"**
PAN's camera captures photos continuously. It saw your keys on the kitchen counter at 11:47 PM. It tells you exactly where they are, with the photo to prove it.

**"Where's Marcus right now?"**
Marcus also uses PAN and has shared his location with you. PAN checks his GPS: "Marcus is at the gym on 5th Street. He's been there for about 40 minutes." You don't need to call him, text him, or open an app. PAN networks between users who opt in to sharing.

**"Tell Marcus I'm running late."**
PAN opens whatever messaging app you use with Marcus — iMessage, WhatsApp, Instagram DM — types "Running late, be there in 20," and sends it. You didn't touch your phone. You didn't even say which app. PAN already knows which one you use with Marcus because it's seen your conversation history.

**Safety:**
You're about to drill into a wall. The EMF sensor detects a live wire behind the drywall — PAN warns you before you hit it. The thermal camera spots an overheating outlet you walked past — PAN flags it. The gas sensor picks up a methane leak in your garage — PAN alerts you before you can smell it.

You control all of this. Turn off nutrition tracking. Turn off location sharing. Keep safety alerts on. Every category is independently controllable — PAN only monitors what you tell it to.

### Cross-Device Orchestration

PAN treats phone, PC, browser, and pendant as one system.

- Ask about code from last week → PAN searches terminal history → opens the file in your editor
- Pendant camera captures a document → Claude Vision extracts text → saves searchable in database
- Pendant thermal camera spots an overheating outlet → alerts you via phone → logs it on PC
- You tell PAN to message someone → PAN picks the right app, types the message, sends it

---

## Your Data, Your Control

PAN captures a lot of data. All of it stays on your devices — not in the cloud, not on anyone else's servers.

### Where Your Data Lives

| Data Type | Where It's Stored | Format |
|-----------|------------------|--------|
| Voice transcripts | Your PC: `service/data/pan.db` | SQLite database |
| Photos from vision | Your PC: `service/src/data/photos/` | JPEG files |
| Voice training audio | Your PC: `service/src/data/voice/` | WAV files |
| Phone conversations | Your phone's app storage | SQLite database |
| Browser tab data | Your PC's PAN server | In-memory, flushed to SQLite |
| Gas / air quality readings | Your PC: `data/sensors/gas/` | Timestamped JSON |
| Spectral analysis | Your PC: `data/sensors/spectral/` | Timestamped JSON |
| Thermal captures | Your PC: `data/sensors/thermal/` | Heatmap images + JSON |
| UV / light / sound levels | Your PC: `data/sensors/uv/`, `light/`, `sound/` | Timestamped JSON |
| Heart rate / SpO2 | Your PC: `data/sensors/heart/` | Timestamped JSON |
| GPS / motion data | Your PC: `data/sensors/gps/`, `motion/` | Timestamped JSON |
| EMF / radiation readings | Your PC: `data/sensors/emf/`, `radiation/` | Timestamped JSON |

No cloud sync by default. Your data physically exists on your hard drive and your phone in standard file formats you can open with any tool.

### Transparency

Every action PAN takes is logged in the dashboard at `http://localhost:7777/dashboard/`:
- What PAN heard you say
- How it classified the request (local, server, ambient)
- Which API it called and how long it took
- What response it generated
- Whether it was handled on your phone or sent to your PC

### What You Can Delete

Everything. At any level of granularity.

- **Delete one message** — tap the delete button next to any conversation entry
- **Delete all data from a specific day** — pick a date, click delete
- **Delete everything matching a search** — search for "medical" and delete all results
- **Delete ALL data** — nuclear option, requires your password twice
- **Delete a photo** — each captured photo has its own delete button

All deletes are **password-protected**. You set the password. Default is "pan" — change it immediately in Settings.

When you delete something, it's gone. Not "archived." Not "marked as deleted but still on the server." The SQLite row is removed. The JPEG file is deleted from disk. It does not exist anymore.

### What PAN Records

**When the microphone is on:**
- Text transcription of what you say (not raw audio — unless you're doing voice training)
- Commands you give and PAN's responses
- The pendant captures photos every 5 seconds and sensor readings continuously

**When the microphone is off:**
- Nothing. No recording, no processing, no data.

**What PAN does not record without you knowing:**
- PAN does not send data to any external server without your API key
- PAN does not record raw audio continuously (only during deliberate voice training sessions)
- PAN does not access apps you've blocklisted
- PAN shows a visible notification when the mic is active

You can turn off any individual sensor from the dashboard. Disable the camera, the microphone, the gas sensor — whatever you want. Every sensor is independently controllable.

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

| # | Sensor | What It Does |
|---|--------|-------------|
| 1 | Camera (OV2640) | "What is this?" — identify anything you point at, read signs, translate text |
| 2 | Microphone (PDM) | Always-on voice commands, conversation recall, ambient awareness |
| 3 | Laser pointer | Aim at a specific object — "what is THIS?" with precision |
| 4 | LED | Status indicator, utility light |
| 5 | Gas Sensor (BME688) | Detect gas leaks, carbon monoxide, smoke — alerts you before you can smell it |
| 6 | UV Sensor (LTR390) | Tracks UV exposure over time — warns you based on your habits and location |
| 7 | Thermal Camera (MLX90640) | See heat through walls, find hot wires, detect body heat in darkness |
| 8 | Spectrometer (AS7341) | Identify unknown pills, check food freshness, verify metals by spectral signature |
| 9 | Magnetometer (QMC5883L) | Detect hidden magnets, find metal in walls, compass navigation |
| 10 | Accelerometer + Gyro (BMI270) | Fall detection, step counting, posture alerts |
| 11 | GPS (L76K) | Every event geotagged — "where was I when I said that?" |
| 12 | Air Quality (SGP40) | "Is the air safe?" — VOC levels, mold risk, ventilation warnings |
| 13 | Barometer (in BME688) | Weather prediction, altitude tracking, storm detection |
| 14 | Temperature + Humidity (in BME688) | Ambient conditions logged — mold risk, comfort monitoring |
| 15 | Ambient Light (BH1750) | Eye strain alerts, automatic brightness context |
| 16 | Color Sensor (TCS34725) | Exact color matching — "is this the right paint color?" |
| 17 | Laser Distance (VL53L0X) | Instant tape measure — point and get distance |
| 18 | Sound Level (MAX4466) | "Is this too loud?" — hearing damage alerts at concerts, job sites |
| 19 | Heart Rate + SpO2 (MAX30102) | Continuous pulse and blood oxygen monitoring |
| 20 | EMF Sensor (AD8317) | Detect live wires behind walls — don't drill into electrical |
| 21 | Ultrasonic (RCWL-1601) | Distance measurement in total darkness, obstacle detection |
| 22 | Radiation (RadSens) | Ionizing radiation detection |

All sensor data is timestamped, geotagged, and searchable from the dashboard. Every reading correlates with what you were doing, where you were, and what was happening around you.

Full specifications, sizes, and pin budget: [SENSOR-ARRAY.md](SENSOR-ARRAY.md)

### Build It Yourself or Buy It

**DIY:** Full parts list, 3D printable case files, assembly guide, and firmware — all open source. Buy the components (~€155), print the case, solder it together, flash the firmware. Everything you need is in this repo.

**Pre-built:** We'll sell assembled pendants for people who don't want to build. Same hardware, same firmware, ready to use.

**Battery:** Standard 18350 Li-ion — rechargeable via USB-C, or swap a fresh one in 2 seconds. Common cell, available everywhere for €3-5.

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
├── Laser pointer (precision targeting)
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
- Real-time voice conversation (sub-1-second responses via Claude)
- Cross-device command routing (phone → PC → browser in one voice command)
- Camera + Claude Vision analysis (point at anything, get an answer)
- Browser extension (read/write any tab — not just search, full DOM control)
- Windows UI automation (control any desktop application by voice)
- Android Accessibility Service (read/control any phone app — no API needed)
- Full conversation memory with search (every voice interaction, searchable)
- Web dashboard with data management, photos, search, granular delete
- Voice training data collection for custom TTS voice cloning
- Terminal project management with full context restoration across sessions

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

## Open Source

The self-hosted option is the primary path — for anyone who wants privacy and control over their data. If you don't want to set any of that up and are fine with us handling your data (with the ability to delete it whenever you want), there's a hosted convenience subscription. Use whichever works for you.

## License

Open source (V1). See LICENSE for details.

## Author

**Tereseus** — [github.com/Tereseus](https://github.com/Tereseus)

Built with Claude.
