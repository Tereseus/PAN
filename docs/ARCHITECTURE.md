# ΠΑΝ — System Architecture

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║                              ΠΑΝ — SYSTEM ARCHITECTURE                         ║
╚══════════════════════════════════════════════════════════════════════════════════╝


    ┌─────────────────────────────────┐
    │         ΠΑΝ PANDANT             │
    │         (ESP32-S3)              │
    │                                 │
    │  ┌───────────┐  ┌───────────┐  │
    │  │  Camera    │  │    Mic    │  │
    │  │  OV2640    │  │   PDM    │  │
    │  │  (photos)  │  │ (backup) │  │
    │  └─────┬─────┘  └─────┬─────┘  │
    │        │              │         │
    │  ┌─────┴──────────────┴─────┐   │
    │  │     ESP32-S3 Sense       │   │
    │  │   + Future Sensors V2    │   │
    │  └────────────┬─────────────┘   │
    │               │                 │
    │  ┌────────────┴─────────────┐   │
    │  │      BLE 5.0 Radio       │   │◄──── Screen (1.69" IPS) ← responses
    │  └────────────┬─────────────┘   │◄──── Speaker (MAX98357A) ← audio
    │               │                 │
    └───────────────┼─────────────────┘
                    │
                    │ BLE (photos + sensor data DOWN, display + audio UP)
                    │
    ┌───────────────┼─────────────────────────────────────────────┐
    │               │           PHONE (Android APK)               │
    │               ▼                                             │
    │  ┌─────────────────────┐    ┌───────────────────────────┐   │
    │  │  BLE Receiver       │    │  PHONE MICROPHONE         │   │
    │  │  (Pandant data)     │    │  (PRIMARY audio capture)  │   │
    │  └─────────┬───────────┘    │  Always-on recording      │   │
    │            │                │  Higher quality than       │   │
    │            │                │  Pandant mic               │   │
    │            │                └─────────────┬──────────────┘   │
    │            │                              │                  │
    │            ▼                              ▼                  │
    │  ┌──────────────────────────────────────────────────────┐   │
    │  │              LOCAL PROCESSING                        │   │
    │  │                                                      │   │
    │  │  • Wake word detection (Layer 1 — from Pandant)      │   │
    │  │  • Speech-to-text (Layer 2 — on-device)              │   │
    │  │  • Translation (on-device, Google Translate)          │   │
    │  │  • Local buffer (stores data before upload)           │   │
    │  │  • Voice fingerprinting (is it YOU talking?)          │   │
    │  └──────────────────────┬───────────────────────────────┘   │
    │                         │                                   │
    │  ┌──────────────────────┴───────────────────────────────┐   │
    │  │              NETWORK LAYER                           │   │
    │  │              Tailscale VPN → Server                  │   │
    │  └──────────────────────┬───────────────────────────────┘   │
    │                         │                                   │
    │  Foreground Service ━━━━━━━━ keeps everything alive         │
    │  Permissions: Mic, BLE, Network, Storage, Foreground        │
    └─────────────────────────┼───────────────────────────────────┘
                              │
                              │ Tailscale (encrypted tunnel)
                              │
                              │  ┌─── photos (from Pandant camera)
                              │  ├─── audio stream (from phone mic)
                              │  ├─── transcripts (STT results)
                              │  ├─── sensor data (from Pandant)
                              │  └─── user queries ("Hey PAN, ...")
                              │
    ┌─────────────────────────┼───────────────────────────────────┐
    │                         ▼          SERVER                   │
    │                                                             │
    │  ┌──────────────────────────────────────────────────────┐   │
    │  │              WEB API                                 │   │
    │  │              Receives all incoming data               │   │
    │  └──────────────────────┬───────────────────────────────┘   │
    │                         │                                   │
    │            ┌────────────┼────────────┐                      │
    │            ▼            ▼            ▼                      │
    │  ┌──────────────┐ ┌──────────┐ ┌──────────────────┐        │
    │  │   STORAGE    │ │  CLAUDE  │ │   MEMORY INDEX   │        │
    │  │              │ │   API    │ │                   │        │
    │  │ Photos       │ │          │ │ All data indexed  │        │
    │  │ Audio files  │ │ Layer 3  │ │ and searchable    │        │
    │  │ Transcripts  │ │ AI proc  │ │                   │        │
    │  │ Sensor logs  │ │          │ │ "What did I see   │        │
    │  │ Blood data   │ │ Only     │ │  last Tuesday?"   │        │
    │  │ Session logs │ │ fires    │ │                   │        │
    │  └──────────────┘ │ when     │ │ Cross-references: │        │
    │                   │ asked    │ │ photos+audio+     │        │
    │                   │          │ │ sensors+blood+    │        │
    │                   │          │ │ location+time     │        │
    │                   └─────┬────┘ └──────────────────┘        │
    │                         │                                   │
    │                         ▼                                   │
    │              ┌─────────────────────┐                        │
    │              │     RESPONSE        │                        │
    │              │                     │                        │
    │              │ Text → phone → PAN  │                        │
    │              │        screen       │                        │
    │              │                     │                        │
    │              │ Audio → phone → PAN │                        │
    │              │         speaker     │                        │
    │              └─────────────────────┘                        │
    │                                                             │
    └─────────────────────────────────────────────────────────────┘


    ┌─────────────────────────────────────────────────────────────┐
    │                    DOCKING MODULES (Future)                  │
    │                                                             │
    │  ┌─────────────┐ ┌──────────────┐ ┌───────────────────┐    │
    │  │ Blood Dock  │ │ Environment  │ │ Weather Station   │    │
    │  │ €30-120     │ │ Station      │ │                   │    │
    │  │             │ │              │ │                   │    │
    │  │ Pandant     │ │ Spectrometer │ │ Wind, rain,       │    │
    │  │ docks in    │ │ Gas chromat  │ │ solar, pressure   │    │
    │  │ magnetically│ │ Water test   │ │                   │    │
    │  └──────┬──────┘ └──────┬───────┘ └────────┬──────────┘    │
    │         └───────────────┴──────────────────┘               │
    │                         │                                   │
    │              Data flows through Pandant → phone → server    │
    └─────────────────────────────────────────────────────────────┘


    DATA FLOW SUMMARY
    ━━━━━━━━━━━━━━━━━

    Pandant ──BLE──► Phone ──Tailscale──► Server ──Claude──► Response
                       │                    │
                       │                    ├── Stored forever
                       │                    ├── Indexed & searchable
                       │                    └── Cross-referenced
                       │
                       ├── Phone mic (PRIMARY audio)
                       ├── Pandant camera (photos)
                       ├── Pandant sensors (environment)
                       └── Local STT/TTS (fast, free)


    LATENCY
    ━━━━━━━

    Wake word ──100ms──► You speak ──2-3s──► STT ──500ms──► Claude ──1-2s──► Audio

    Total: ~3-5 seconds from finishing your sentence to hearing a response
```
