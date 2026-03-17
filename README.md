# PAM — Personal AI Memory

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

## Project Status
- [x] Hardware selected and ordered
- [ ] Hardware arrives (~March 18-20)
- [ ] ESP32 firmware
- [ ] Android app
- [ ] Server-side data pipeline
- [ ] 3D case design
- [ ] Assembly and testing
- [ ] Battery integration
