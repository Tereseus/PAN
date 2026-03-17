# PAN — Personal AI Network

Wearable AI pendant that captures everything you see and hear, stores it as searchable memory, and talks back to you in real-time.

## What It Does
- Always-on camera (photo every few seconds) + continuous audio
- Streams to phone via BLE, phone sends to server for Claude processing
- Shows responses on 1.69" touch screen
- Speaks responses through built-in speaker
- All data indexed and queryable — your external memory
- Secondary use: live translation service

## Hardware (Version 1)

| Component | Part | Status |
|-----------|------|--------|
| Brain | Seeed XIAO ESP32-S3 Sense (camera + mic + BLE/WiFi) | Ordered (Berrybase) |
| Screen | Waveshare 1.69" IPS LCD 240x280, SPI, ST7789V | Ordered (Berrybase) |
| Speaker Amp | Adafruit MAX98357A I2S 3W Class D | Ordered (Berrybase) |
| Speaker | Mini Mylar 28mm 0.5W 8Ω | Ordered (Berrybase) |
| Battery | 3.7V 1000mAh LiPo JST 1.25mm (model 902040) | Need to order |
| Case | 3D printed (AnkerMake printer) | To design |
| Mount | Neodymium magnets (on hand) | Have |
| Wires | From Arduino kit | Have |

### Delivery: ~March 18-20, 2026 (Berrybase → DHL Kalamaria)

## Hardware (Version 2 — Future)
- Shoulder-mounted gimbal (2x SG90 micro servos, 3D printed pan/tilt)
- AI face/motion tracking via phone
- Larger battery / swappable battery system
- Watch notifications integration

## Sensor Roadmap (Future Versions)
All of these are available as small ESP32-compatible modules:

| Sensor | What It Detects | Module Size |
|--------|----------------|-------------|
| Gas / e-nose | Hundreds of chemical compounds (beyond human smell) | Fingernail |
| UV sensor | Ultraviolet light (invisible to humans) | Fingernail |
| IR thermal camera | Heat signatures (like a snake) | Small chip |
| Magnetometer | Magnetic fields (like birds) | Fingernail |
| Barometric pressure | Weather/altitude changes | Fingernail |
| Air quality (PM2.5, CO2, VOC) | Pollution, air composition | Small module |
| Spectrometer | Chemical composition by light | Small module |
| Accelerometer/Gyroscope | Motion, orientation, balance | Fingernail |
| Temperature | Ambient temperature | Fingernail |
| LIDAR | 3D spatial mapping | Small module |
| Ultrasonic | Echolocation (like bats) | Small module |
| Radiation detector | Ionizing radiation | Small module |
| EMF sensor | Electromagnetic fields | Fingernail |
| Heart rate / SpO2 | Pulse, blood oxygen (on chest) | Small module |
| GSR | Skin conductance (stress/emotion) | Fingernail |

## Architecture

```
PAM Pendant (ESP32-S3)
  ├── Camera (OV2640) → photo every N seconds
  ├── Microphone (PDM) → continuous audio
  ├── Screen (1.69" IPS) ← display responses/translations
  ├── Speaker (via MAX98357A) ← play voice responses
  └── BLE 5.0 ↕ phone

Phone (Android APK)
  ├── Receives photos + audio via BLE
  ├── Speech-to-text (on-device)
  ├── Translation (on-device, Google Translate)
  ├── Sends data to server via Tailscale
  ├── Receives Claude responses
  ├── Text-to-speech → sends audio to PAM speaker
  └── Sends display text → PAM screen

Server (Northbridge / ProDesk1)
  ├── Web server accepting photos + transcripts
  ├── Claude Code CLI for processing
  ├── Indexed storage (all memories)
  └── Queryable from any machine / Discord bot
```

## Display Philosophy — PAM is Screenless by Nature

PAM's 1.69" pendant screen is tiny — useful only when you're glancing down at your chest. It's NOT PAM's primary display. PAM is a headless AI that pushes output to whatever screen makes the most sense in context:

| Screen | When | Use Case |
|--------|------|----------|
| **Pendant (1.69")** | Glancing down, quick check | Short alerts, translation text, status icons |
| **Phone** | Most of the time | Full responses, detailed data, conversation history |
| **Watch (Huawei Band)** | Quick notification | Ping alerts, one-line summaries |
| **Computer** | At desk | Full dashboard, charts, blood trends, detailed analysis |
| **Docking station display** | Using a module | Blood results while testing, environmental readings |
| **TV / Projector** | Sharing, reviewing | Show someone your data, review your day's captures |

PAM doesn't care WHERE it displays. It sends information to the most appropriate screen based on context — like Bluetooth audio plays through whatever speaker is connected. The pendant screen is just one endpoint, and often not even the primary one.

This is like the difference between looking at a notification on your watch vs your phone. Sometimes the watch is enough. Usually you want the phone. At your desk, you want the big screen. PAM adapts.

## Software Components
1. **ESP32 Firmware** (Arduino/MicroPython) — camera capture, BLE streaming, screen driver, I2S audio
2. **Android APK** — BLE connection, STT, TTS, Tailscale networking, always-on service
3. **Server** — web API, Claude integration, memory database, search

## Naming
**PAN = Personal AI Network**

Named after Pan (Πάν/Πας) — Greek for "all/everything." Also Pan the god — a satyr (σάτυρος), god of the wild and nature, with superhuman senses in the natural world. The name fits: a device that senses everything, remembers everything, networks everything.

The "N" stands for Network because PAN IS a network — the pendant, phone, server, and docking modules all connected.

## User Customization
- **Custom wake name** — users choose their own. "Hey PAN," "Hey Jarvis," "Hey Friday," whatever they want. Not forced.
- **Always-on by default** — captures photos and audio continuously
- **Pause:** "PAN stop" / "PAN sleep" / tap and hold screen
- **Resume:** "PAN wake up" / tap screen / auto-resume after configurable timeout
- **Privacy mode:** "PAN go dark" — stops all recording, screen shows visible indicator so people around you know it's off
- **Custom voice** — choose the TTS voice for responses
- **Custom screen themes** — personalize the display

## Voice Recognition Architecture

Voice processing happens in three layers — cheap and fast at the bottom, expensive and smart at the top:

### Layer 1: Wake Word Detection (on ESP32 — local, instant)
- Tiny ML model runs directly on the ESP32-S3 chip
- Only listens for ONE specific wake word pattern
- Uses TensorFlow Lite Micro or ESP-SR (Espressif's speech recognition library)
- Almost no battery drain (~5-10mA)
- **NEVER leaves the device** — no network, no API, no latency
- Response time: ~100ms

### Layer 2: Speech-to-Text (on phone — local, fast)
- Wake word triggers ESP32 → tells phone via BLE "they're talking to me"
- Phone records the actual command/question
- On-device STT (Google Speech API or Whisper) — still no API call
- Text ready in under 500ms

### Layer 3: AI Processing (server — smart, only when needed)
- Text + latest photos + sensor data sent to server via Tailscale
- Claude Code CLI processes and responds
- This is the ONLY "expensive" step, and only fires when you actually ask something
- Maybe 10-50 times per day — negligible API cost

### Total Latency
Wake word (~100ms) → you speak (~2-3 seconds) → STT (~500ms) → Claude (~1-2 seconds) → response audio
**~3-5 seconds from finishing your sentence to hearing a response.**

### Voice Security — Preventing Conflicts
**Problem:** What if your friend says your wake word to mess with you or confuse your device?

**Solutions (layered):**
1. **Custom wake words** — set yours to "Hey Atlas," friend's is "Hey Nova." No conflict possible.
2. **Voice fingerprinting** — phone learns YOUR specific voice pattern. Even if someone says the exact same wake word, the phone recognizes it's not you and ignores it. This uses speaker verification ML models that run locally on the phone.
3. **Bluetooth pairing** — each PAN pendant only communicates with its paired phone. Even if two PANs are in the same room with the same wake word, each triggers only its own phone.
4. **Confirmation mode** (optional) — for sensitive commands, PAN asks "Was that you?" and waits for confirmation before acting.

In practice, voice fingerprinting + custom wake words makes false triggers nearly impossible.

## Project Status
- [x] Hardware selected and ordered
- [ ] Hardware arrives (~March 18-20)
- [ ] ESP32 firmware
- [ ] Android app
- [ ] Server-side data pipeline
- [ ] 3D case design
- [ ] Assembly and testing
- [ ] Battery integration
