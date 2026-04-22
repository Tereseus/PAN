# PAN — BLE Mesh & Local Identity Architecture

---

## The Three BLE Modes

```
┌─────────────────────────────────────────────────────────────────┐
│                     BLE RADIO (shared)                          │
├─────────────────┬───────────────────────┬───────────────────────┤
│  BEACON MODE    │   PEER MODE           │  AMBIENT MODE         │
│  (receive only) │   (contact-only)      │  (passive listening)  │
│                 │                       │                       │
│  One-way        │   Two-way             │  No transmission      │
│  No response    │   Recognized contacts │  Environmental sense  │
│  No log         │   only                │  Adjusts behavior     │
└─────────────────┴───────────────────────┴───────────────────────┘
```

---

## Mode 1 — Beacon (Geofencing + Government Alerts)

```
EMITTER (hospital, government, org admin)
    │
    │  BLE Advertisement broadcast (no receiver, no ACK channel)
    │  UUID:  PAN-ZONE-BEACON
    │  Data:  org_id | zone_id | alert_type | timestamp
    │  Range: ~10-30m (TX power controlled)
    │
    ▼
PAN DEVICE (passive scanner — never transmits back)
    │
    ├─ Heard beacon → check local DB: "am I in org_id?"
    │       YES → trigger action:
    │               org switch, emergency alert, zone notification
    │       NO  → discard silently, no trace
    │
    └─ Result stored LOCALLY ONLY
         Nothing sent back to beacon
         Beacon never knows who received it
         No server log of recipients
```

**What government/org can know:**
- ✅ That their beacon was transmitting
- ✅ The physical location of the beacon
- ❌ Which devices were in range
- ❌ What those devices did with it
- ❌ Any user data whatsoever

**Use cases:**
- Hospital entrance → switch to org_hospital context (different permissions, data scope)
- Government emergency alert → receive like a cell broadcast, act locally
- Restricted zone → PAN reduces what it shares, increases privacy mode
- Conference room → switch to org_work_meeting context automatically

**Why this is safer than GPS geofencing:**
GPS geofencing requires your location to travel to a server.
Server gets subpoenaed → government gets everyone's location history.
BLE beacon: your location never leaves your device.
The beacon is just a local radio signal, like a lighthouse.

---

## Mode 2 — Peer (PAN-to-PAN Contact Communication)

```
DEVICE A (Tereseus's phone)          DEVICE B (contact's phone)
    │                                     │
    │── BLE advertisement (low power) ───▶│
    │   Contains: PAN presence token       │
    │   (NOT identity — just "I'm a PAN") │
    │                                     │
    │◀─ Device B scans, sees token ───────│
    │   Checks: is this in my contacts?   │
    │       YES → initiate GATT channel   │
    │       NO  → ignore completely       │
    │                                     │
    │◀══ Encrypted GATT channel open ════▶│
    │    Exchange:                         │
    │    - Presence confirmation           │
    │    - Signed with hardware key        │
    │    - Context snapshot (if allowed)   │
    │    - Emergency: "I need help" signal │
```

**Contact recognition without revealing identity:**
- Advertisement contains a rotating token derived from your key pair
- Only your contacts can derive the expected token (shared secret at add-time)
- Strangers see random-looking bytes → meaningless noise to them
- You're invisible to non-contacts even when broadcasting

**What a non-contact sees:**
Some BLE advertisement bytes. Indistinguishable from thousands of other BLE devices.
They cannot tell it's PAN. They cannot tell who it is. They get nothing.

---

## Mode 3 — Ambient (Environmental Awareness)

PAN listens to the BLE environment without broadcasting.
Uses signal density + audio sensors to understand the physical context.

```
Many unknown BLE devices detected
    + Loud ambient audio (crowd noise, talking)
    + Accelerometer: moving (train, walking)
            │
            ▼
    CROWDED / PUBLIC context
    → Reduce own broadcast power (shorter range)
    → Increase skepticism of incoming signals
    → Switch to haptic-only responses (no audio)
    → Tighten data sharing scope

Few BLE devices detected
    + Quiet audio
    + Location: known home/office beacon
            │
            ▼
    PRIVATE / TRUSTED context
    → Normal broadcast range
    → Full audio responses OK
    → Relaxed sharing scope
```

**The key insight:** PAN doesn't need GPS to know if you're in a library, a train,
or at home. The BLE device density + audio environment tells it.

---

## Identity & Security Framework

### Hardware-Bound Identity

```
┌─────────────────────────────────────────────────────────┐
│  ENROLLMENT (one time)                                   │
│                                                          │
│  Device generates key pair inside hardware security chip │
│  Private key: NEVER LEAVES THE CHIP (hardware guarantee) │
│  Public key:  registered with PAN Hub + shared w contacts│
│                                                          │
│  ┌──────────────┬──────────────┬──────────────┐         │
│  │   Pendant    │    Phone     │    PC        │         │
│  │   eFuse HSM  │  Android     │   TPM 2.0    │         │
│  │   (ESP32S3)  │  Keystore    │  (Windows)   │         │
│  └──────────────┴──────────────┴──────────────┘         │
└─────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────┐
│  ALL PEER MESSAGES                                       │
│                                                          │
│  signed(message + timestamp + nonce, private_key)       │
│                                                          │
│  Receiver verifies against stored public key            │
│  Invalid signature → drop, ignore, optionally alert     │
│  Replay attack → nonce check fails → drop               │
└─────────────────────────────────────────────────────────┘
```

**Why stolen credentials don't work:**
- Username + password → can't produce a hardware signature
- Even with the physical device: the private key is inside a secure enclave
  that cannot be extracted via software or most physical attacks
- Brute forcing a 256-bit ECDSA key: more compute than exists on Earth

---

### Stolen Device — Continuous Biometric Defense

Even if someone has your physical device, PAN knows it's not you.

```
CONTINUOUS AUTHENTICATION (always running, silent)
    │
    ├─ Voice recognition (Whisper + voiceprint)
    │      Every word spoken compared to enrolled voiceprint
    │      Confidence drops if voice doesn't match
    │
    ├─ Face recognition (camera, InsightFace)
    │      Periodic checks when camera active
    │      Checks ambient environment for enrolled faces
    │
    └─ Behavioral patterns
           Typing rhythm, usage patterns, location habits
           Anomaly detection over time

TRUST LEVEL (continuous score, 0-100)
    │
    100 ─ Full trust: voice + face match, normal patterns
     80 ─ Light warning: one signal off, ask for confirmation
     50 ─ Reduced trust: BLE peer comms suspended
     20 ─ Low trust: only emergency functions, alerts owner
      0 ─ Lockout: BLE comms off, hub notified, key revocation pending
```

**Stolen device timeline:**
- Minute 0: Stolen
- Minute 1-5: Thief tries to use it, voice doesn't match, trust drops
- Minute 5-15: Trust below 50, BLE peer comms suspended automatically
- Minute 15+: Owner reports stolen → hub revokes public key → all contacts reject signatures
- Result: device is a brick for BLE mesh purposes within ~15-30 minutes

**What the thief can access:**
- Local data that isn't biometric-locked (some read-only views)
- **Cannot:** send authenticated messages to contacts, join org contexts, participate in mesh

---

## Full System Diagram

```
                    GOVERNMENT/ORG BEACONS
                    (broadcast only, no receiver)
                            │
                     BLE signal (one-way)
                            │
         ┌──────────────────┼──────────────────┐
         │                  │                  │
         ▼                  ▼                  ▼
   PAN Device A       PAN Device B       PAN Device C
   (Tereseus)         (contact)          (stranger)
         │                  │                  │
    In org?            In org?            In org?
    YES → act          YES → act          NO → ignore
         │                  │
    ┌────┘                  └────┐
    │   Peer mode (if contacts)  │
    │◀══ rotating token check ══▶│
    │   In contacts?             │
    │   YES → GATT channel       │
    │   Sign with hardware key   │
    │   Exchange presence/data   │
    │                            │
    │   Environmental awareness  │
    │   (both devices)           │
    │   Crowded? → quiet mode    │
    │   Noisy? → haptic only     │
    └────────────────────────────┘

         CONTINUOUS BIOMETRIC (local, always)
         Voice + Face + Behavior → Trust Score
         Trust < 50 → suspend BLE comms
         Device stolen → report → key revoked → mesh dead
```

---

## Implementation Plan

### Phase 1 — Geofencing (Android, no pendant needed)
1. `BleGeofenceScanner.kt` — passive BLE scan for PAN-ZONE-BEACON UUID
2. `GeofenceManager.kt` — maps org_id → context switch, alert handling
3. Server: `POST /api/v1/orgs/beacons` — admin registers beacon UUIDs + org mapping
4. Dashboard: Org Settings → Beacons tab → add/remove authorized beacons

### Phase 2 — Peer (Android phone-to-phone, no pendant needed)
1. `BlePeerAdvertiser.kt` — broadcasts rotating presence token (low power)
2. `BlePeerScanner.kt` — scans, checks contact list, initiates GATT if matched
3. `BlePeerChannel.kt` — encrypted GATT channel, hardware-signed messages
4. Contact key exchange at add-time (public key stored locally)

### Phase 3 — Ambient Awareness
1. BLE device density monitoring (count of unique MACs in scan window)
2. Audio environment classifier (quiet / normal / loud / crowd)
3. Context state machine → adjusts broadcast power + response modality

### Phase 4 — Pendant (when hardware exists)
- Pendant inherits all of the above via BLE to phone
- Pendant eFuse key becomes the primary identity anchor (highest trust weight)
- Pendant's physical sensors (thermal, gas, EMF) add environmental data to ambient mode

---

## What This Is Not

- **Not a mesh network** — PAN devices don't route data through each other
- **Not location tracking** — no GPS, no coordinates ever transmitted
- **Not always-on broadcast** — transmission only when useful, environmental-aware
- **Not identifiable to strangers** — rotating tokens, no persistent identifiers in advertisements

---

*Created: 2026-04-21*
