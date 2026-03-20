# ΠΑΝ — Strategic Direction

## Core Insight
PAN is software, not hardware. The pendant is one input device among many. The permanent value is the software layer that orchestrates AI across all devices.

## Why PAN Survives Hardware Changes
- When Google ships AR glasses → PAN runs on them (Android app)
- When Apple ships something → PAN connects via companion device
- When better wearables appear → PAN migrates, data stays
- The pendant proves the concept, the software IS the product

## Software Layer Architecture (Bulletproof Design)

### 1. Device Abstraction
Every device registers as a capability set, not a device type:
- Phone: {mic, camera, GPS, apps, sensors, BLE}
- PC: {terminal, files, browser, apps, GPU}
- Pendant: {camera, mic, sensors, BLE}
- Raspberry Pi: {GPIO, sensors, relay}
- Smart TV: {display, speakers}
PAN doesn't care WHAT it is. It knows what it CAN DO.

### 2. Transport Abstraction
Same JSON commands over any channel:
- HTTP/WiFi (current — LAN devices)
- BLE (pendant, nearby devices)
- Tailscale/WireGuard (remote devices, security)
- WebSocket (real-time streaming)
- MQTT (IoT devices, smart home)

### 3. AI Abstraction
PAN sends prompts, gets responses. Backend is swappable:
- Claude (current, via API)
- GPT/OpenAI
- Gemini
- Grok
- Local models (Llama, Mistral)
- On-device (Gemini Nano when it works)

### 4. Storage Abstraction
Schema stays the same, backend swaps:
- SQLite (current — local, single device)
- Firebase (cloud sync, multi-device)
- PostgreSQL (self-hosted server)
- User owns their data regardless of backend

## Hardware Reality Check
- Phones won't get smaller (transistors still shrinking but form factor is set)
- Glasses are 5+ years from replacing phones
- Watches are limited (screen, camera angle, battery)
- Chest/shoulder worn = best first-person view, hands-free, 2-3 year sweet spot
- Quantum computing doesn't affect wearables
- Flexible displays are 5-10 years out

## The Pendant's Role
- Proves the concept (people need to see hardware to understand)
- Buys time while the software matures
- First-person view camera is genuinely useful
- 22 sensors is a compelling demo
- If something better comes along, PAN migrates to it

## Growth Strategy
- Start with 5-10 power users (friends) who use it daily
- If it saves 30 min/day, they tell people
- V1 open source builds community and proves concept
- Subscription service for non-technical users
- Enterprise version for teams (later)

## What We Don't Compete On
- Hardware manufacturing (leave to Google/Apple/Samsung)
- AI model training (use Claude/GPT/Gemini)
- Cloud infrastructure (use Firebase/AWS)

## What We DO Compete On
- Software integration across ALL devices
- Open source / self-hosted / privacy-first
- The only active AI agent (not passive recorder)
- Cross-platform orchestration (no one else does this)

## Device Ecosystem Reality
Most people have: phone + computer. That's it. PAN supports both already.
- Watch data → comes through phone's Health Connect API, no direct connection needed
- Earbuds, car BT, etc → phone already aggregates these
- Phone IS the hub, PC IS the brain. Everything else connects through one of those two.
- No need to reinvent Bluetooth device management — Android already does it.

## Work/Personal Separation
- Profiles, not separate servers (like Chrome profiles)
- Auto-switch based on WiFi/VPN (home = personal, work VPN = work)
- Or voice: "Pan, switch to work"
- Data stays separated per profile
- Android Work Profile integration for enterprise
- V1: single profile. Multi-profile is Phase 2.

## Bluetooth Strategy
- Existing BT devices (speakers, watches, sensors): PAN connects as client, reads standard BT service UUIDs for capability discovery
- PAN pendant: custom firmware, flash once, then auto-discovers via BLE
- No flashing needed for anything except the custom pendant
- Phone is already the BT hub for all connected devices
