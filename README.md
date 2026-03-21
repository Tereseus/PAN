# ΠΑΝ — Personal AI Network

**Your voice controls everything.** Phone, computer, browser, any app — all through natural conversation.

ΠΑΝ (PAN) is an open-source AI operating system that connects all your devices into one intelligent network. Talk to it like a person. It remembers everything. It automates everything.

## What It Does Right Now

🎤 **Voice Assistant** — Real-time conversation via your phone. Sub-1-second responses. Ask questions, give commands, have discussions.

📱 **Phone Control** — Open apps, set timers, toggle flashlight, navigate, search, play music — all by voice.

💻 **Computer Control** — Create folders, open projects, run terminal commands, control your browser — from your phone or by voice.

🌐 **Browser Automation** — Read any tab, type messages, click buttons, navigate — across Chrome, Edge, Brave, Firefox.

📸 **Camera Vision** — "What is this?" → phone takes a photo → Claude Vision analyzes it → PAN describes what it sees.

📊 **Dashboard** — Web UI showing all conversations, photos, data management, device status, scheduled jobs.

🔇 **Privacy First** — All data stored locally. Self-hosted server. No cloud dependency. Delete anything anytime.

## Architecture

```
Phone (Android)                    PC (Windows/Linux)
├── Google Streaming STT           ├── PAN Service (port 7777)
├── Voice commands                 ├── Anthropic API (Haiku, sub-1s)
├── Camera + Claude Vision         ├── Browser Extension
├── App launching                  ├── UI Automation (pyautogui)
├── Accessibility Service          ├── Electron Tray App
└── Always-on listening            ├── Web Dashboard
                                   ├── Voice Training (Piper)
Pendant (ESP32-S3) [building]      └── Terminal Management
├── Camera (every 5s)
├── Microphone
├── 22 sensors
├── Laser pointer
├── BLE → Phone
└── 18350 battery (swappable)
```

## Quick Start

### Server (Windows)
```bash
# Clone the repo
git clone https://github.com/Tereseus/PAN.git
cd PAN/service

# Install dependencies
npm install

# Copy and configure API key
cp src/claude.js.template src/claude.js
# Edit src/claude.js — add your Anthropic API key

# Start the service
node pan.js start

# Install as Windows service (auto-starts on boot)
node install-service.js
```

### Phone (Android)
1. Build the APK from `android/` in Android Studio
2. Install on your phone
3. Set server URL in Settings (your PC's IP, port 7777)
4. Grant microphone and camera permissions
5. Start talking

### Browser Extension
1. Open `chrome://extensions/`
2. Enable Developer Mode
3. Load unpacked → select `browser-extension/`
4. ΠΑΝ can now read and control your browser

### Desktop App
```bash
cd service
npx electron electron/main.cjs
```

## Voice Commands

| Command | What Happens |
|---------|-------------|
| "Hey Pan, what time is it?" | Instant local response |
| "Open YouTube on my phone" | Launches YouTube |
| "Set a timer for 5 minutes" | Sets phone timer |
| "Turn on flashlight" | Toggles flashlight |
| "What is this?" | Camera → Claude Vision analysis |
| "Make a folder called Test on my desktop" | Creates folder on PC |
| "Open the PAN project" | Opens terminal on PC |
| "Play HUH on Spotify" | Opens Spotify search |
| "Put my computer to sleep" | Sleeps the PC |
| "Mute" / "Shut up" | Mutes PAN |
| "What tabs do I have open?" | Lists browser tabs |

## Hardware — The Pendant

One case. 22 sensors. Zippo-lighter size. €155.

| Spec | Detail |
|------|--------|
| Size | 52×42×25mm (Zippo lighter) |
| Weight | ~70g (same as AirPods case) |
| Battery | 18350 Li-ion, swappable, USB-C charging |
| Camera | OV2640, every 5s (smart mode) |
| Sensors | Gas, UV, thermal, magnetometer, spectrometer, GPS, + 16 more |
| Mount | Neodymium magnet — clips to any clothing |
| Laser | Visible laser for "what is this?" aiming |

Full sensor list: [SENSOR-ARRAY.md](SENSOR-ARRAY.md)

## The Philosophy

### AI Cyclosis
*The recursive loop of AI-driven development.*

AI identifies problems → developer builds solutions → solutions create new capabilities → new capabilities reveal new problems → AI identifies those → cycle continues.

Each session starts further ahead because the AI retains memory from all previous sessions. The spiral doesn't just repeat — it ascends.

Read more: [AI-CYCLOSIS.md](AI-CYCLOSIS.md)

### Why PAN Is Different

Every competitor is either a **passive recorder** (Limitless, Omi, Bee, PLAUD) or a **failed phone replacement** (Humane AI Pin, Rabbit R1).

PAN is the only system that:
- **Controls your computer** via voice
- **Executes commands**, not just records
- Works across **phone + PC + wearable** as one system
- Can be **fully self-hosted** — your data, your hardware
- Is **open source** (V1)

Competitive analysis: [COMPETITIVE.md](COMPETITIVE.md)

## Project Status

### ✅ Working
- Voice pipeline (Google STT → Anthropic API → TTS)
- Phone commands (20+ local commands)
- Camera + Claude Vision
- Browser extension (read/write any tab)
- Windows UI automation
- Android Accessibility Service
- Web dashboard with data management
- Terminal project management
- Voice training data collection (30+ min recorded)
- Electron desktop tray app

### 🔨 In Progress
- Piper voice cloning (data collected, training pipeline ready)
- Voice fingerprinting (speaker identification)
- Platform issue tracking (4 issues filed on Anthropic + Microsoft)

### 📋 Planned
- Linux support
- Pendant hardware + firmware
- Voice marketplace
- Installer for easy setup
- Subscription service for hosted users

Full roadmap: see project documentation

## Tech Stack

- **Phone**: Kotlin, Jetpack Compose, CameraX, Google STT, Hilt
- **Server**: Node.js, Express, SQLite (sql.js), Anthropic API
- **Desktop**: Electron, pyautogui, Windows UI Automation
- **Browser**: WebExtension API (Manifest V3)
- **AI**: Claude Haiku (conversation), Claude Vision (photos), Piper (voice clone)
- **Hardware**: ESP32-S3, I2C sensors, BLE 5.0

## License

Open source (V1). See LICENSE for details.

## Author

**Tereseus** — [github.com/Tereseus](https://github.com/Tereseus)

Built with Claude (Opus 4.6) through AI Cyclosis.
