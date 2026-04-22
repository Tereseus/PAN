# Data Dividends & Business Model

---

## How PAN Makes Money — And How Users Benefit

Every revenue stream either pays the user directly, gives them a discount, or improves PAN
by expanding the sensory data network that AutoDev learns from. Nothing is forced.
All five are opt-in, admin-controlled, individually toggleable.

### The Five Streams

| # | Stream | What the user gets | What PAN gets |
|---|--------|-------------------|---------------|
| 1 | **Data Dividends** | 70% of every query fee matched against their data — passive income, zero effort | 30% platform fee + a richer, more verified dataset |
| 2 | **Inverted Advertising** | Relevant offers arrive before you know you need them. Discount codes, early access, matched deals — all based on local signals, nothing leaves the device | Referral fee from buyer when user acts on an offer |
| 3 | **Hardware (Pendant)** | A physical sensor node that makes their own PAN smarter — thermal, spectrometer, EMF, gas, UV — data no phone can generate | ~€100 margin per unit + a new verified sensor node in the network |
| 4 | **Enterprise / Gov Contracts** | Orgs deploy PAN Hub — each employee gets PAN, org controls what's shared | Setup fee + per-seat monthly licensing. Revenue before consumer scale. |
| 5 | **Module Marketplace** | Buy or build modules that extend PAN's sensing ability (blood analysis, soil, vehicle, environment) | 1% protocol fee on all dividend flows through PAN marketplace |

### Why More Users and More Sensors = Better PAN for Everyone

Every user who participates — with their pendant, their phone sensors, their voice queries —
adds a node to the sensory network. AutoDev uses that aggregate data to:

- Benchmark new models against real-world query patterns (not synthetic test cases)
- Detect when the router misclassifies a new type of ambient speech that didn't exist in training data
- Identify which sensor combinations produce the highest-confidence signals for the dividend algorithm
- Improve Scout's search topics based on what the network is actually struggling with

A user who buys a pendant doesn't just get better personal health monitoring. They contribute
thermal, spectrometer, and gas data that the entire network learns from — data that no phone
can generate, that no other AI platform has, that AutoDev uses to build better classifiers
for everyone.

The pendant is both a product and a node. The more nodes, the better the intelligence.
The better the intelligence, the more the data is worth to buyers.
The more it's worth to buyers, the higher the dividend payouts for every user.

This is the flywheel. Users improve PAN by using it.

---

## Overview

Data dividends are PAN's primary opt-in revenue stream. Users earn passive income by allowing anonymized queries to run against their local data. Raw data never leaves the device — only confidence scores and anonymized aggregate results.

This is NOT an ad platform. This is NOT a rewards program. This is a **marketplace where buyers purchase statistical signals and users get paid for the match**.

## Core Principle

**The algorithm comes to the data, the data never leaves.**

PAN pulls queries from the marketplace server, runs them locally, returns only a confidence score. The buyer gets aggregate market intelligence. The user gets a cut of the query fee. PAN (the company) takes a platform fee.

## Architecture

```
Buyer                    PAN Marketplace              User's PAN (local)
  |                           |                              |
  |-- posts query + budget -->|                              |
  |                           |-- PAN pulls query outbound ->|
  |                           |                              |-- runs algorithm locally
  |                           |                              |-- scans events, browser,
  |                           |                              |   voice, location, sensors
  |                           |<- returns confidence score --|
  |                           |   (anonymized, no PII)       |
  |<-- aggregate results -----|                              |
  |                           |                              |
  |   buyer pays              |-- user gets cut ------------>|
  |                           |-- PAN gets platform fee      |
```

**Key architectural decisions:**
- Pull model, not push. PAN connects outbound to marketplace. No Funnel, no open ports, no Tailscale ACLs needed.
- Compute-to-data. The matching algorithm runs on the user's device. The marketplace sends the query, not the other way around.
- All processing uses local LLM (Ollama) or pattern matching. No cloud AI involved in the matching.
- User enables data dividends with ONE toggle in Settings. Zero setup beyond that.

## The Gaming Problem

### The Threat

Early adopters will try to game the system. Scammers will fake data to match every query and farm payouts. At small scale (launch), this could be 90% of users. If unchecked, buyers get garbage data, stop paying, revenue goes to zero.

### Why Traditional Anti-Fraud Fails

- **You can't verify intent.** Someone saying "I want a toaster" proves nothing.
- **Event editing.** Users control their own database. They could insert fake events.
- **Single signals are trivially fakeable.** One search, one voice command, one event — all easy to manufacture.

### The Solution: Multi-Signal Confidence Scoring

**You don't prove intent. You prove behavior over time.**

A real user who wants a toaster has an organic pattern across multiple independent signal types, accumulated over weeks, with natural timing. A scammer would have to fake ALL of it — a coherent web of browsing history, voice queries, calendar events, project context, location patterns, and purchase history. For every possible product category. That's a full-time job that pays pennies.

**The anti-gaming mechanism isn't detection. It's economics.** Make gaming pay less than minimum wage. Real users earn passively without trying. Scammers self-select out.

### Confidence Score Formula

```
confidence = SUM(signal_weight * recency_decay * corroboration_bonus)
```

#### Signal Weights

| Signal Type | Weight | How Fakeable | Notes |
|------------|--------|-------------|-------|
| Voice query to PAN | 0.2 | Easy | "What's a good toaster?" |
| Browser activity | 0.3 | Tedious | Browsed toaster pages, comparison sites |
| Purchase history | 0.4 | Hard | No toaster in past purchases, or recently bought related items |
| Location/life events | 0.3 | Very hard | New apartment, kitchen renovation, moved recently |
| Sensor/time patterns | 0.2 | Very hard | Morning routine suggests kitchen usage patterns |
| Calendar/tasks | 0.2 | Possible | "Buy kitchen stuff" on task list, "IKEA trip" on calendar |
| Cross-category corroboration | 0.3 | Nearly impossible | Kitchen search + new apartment + no appliance purchases = organic |

#### Recency Decay

| Time | Decay Factor |
|------|-------------|
| Today | 1.0 |
| Past week | 0.7 |
| Past month | 0.3 |
| Older than 1 month | 0.1 |

#### Corroboration Bonus (The Key Multiplier)

| Number of independent signal types | Multiplier |
|-------------------------------------|-----------|
| 1 signal type | 1.0x |
| 2 signal types | 1.5x |
| 3+ signal types | 2.0x |
| 5+ signal types | 3.0x |

This is the core anti-gaming mechanism. Multiple independent sources confirming the same interest is exponentially harder to fake than any single signal.

### Gaming Economics Example

**Scammer** types "I want a toaster" once:
- Signal: voice query (0.2) x recency (1.0) x corroboration (1.0x) = **0.2 confidence**
- Payout: fractions of a penny per query
- To earn $1/day: would need to fake thousands of unique product interests with single signals
- ROI: well below minimum wage

**Real user** who organically wants a toaster:
- Browsed toasters (0.3) + asked PAN (0.2) + moved recently (0.3) + no toaster in purchases (0.4)
- Sum: 1.2 x avg recency 0.8 x corroboration 2.0x = **1.92 confidence**
- Payout: meaningful per query (6-10x what the scammer gets)
- Effort: zero — they were just living their life

### Anti-Tampering Signals

Events in PAN's database have security fields that help detect manipulation:

| Field | What it catches |
|-------|----------------|
| `created_at` timestamp | Bulk-inserted events have clustered timestamps |
| `trust_origin` | All self-generated events are tagged `'self'` — can't fake external sources |
| `source_device` | Events should come from multiple devices (phone, desktop) — single-device-only patterns are suspicious |
| Session continuity | Real events have natural session patterns — login, browse, query, idle. Fake events lack session context |
| Sensor corroboration | If PAN has location/sensor data, events should align. Browsing toasters at 3am every night for a week? Suspicious |

**The edit marker problem** (user edits events to inject fake data):
- Events have immutable `created_at` timestamps set at insert time
- Events inserted through normal PAN flows have `trust_origin = 'self'` and natural `source_device` attribution
- Bulk database manipulation (direct SQL edits) would break FTS5 indexes, vector embeddings, and HMAC audit chains
- The confidence algorithm weighs event PATTERNS, not individual events. One fake event doesn't move the score. A thousand fake events with no corroboration scores near zero.

## Payout Structure

| Confidence Tier | Score Range | Payout Share | Description |
|----------------|------------|-------------|-------------|
| Noise | 0.0 - 0.3 | $0 | Below threshold, not reported to buyer |
| Low | 0.3 - 0.7 | Minimal | Single signal match, included in aggregate count only |
| Medium | 0.7 - 1.5 | Standard | Multi-signal match, included in detailed results |
| High | 1.5+ | Premium | Strong multi-signal corroborated match, highest value |

Buyers pay per query. Revenue split:
- **User: 70%** of their tier's allocation
- **PAN platform: 30%**

## User Experience

### Enabling Data Dividends

Settings > Privacy > Data Dividends toggle. One click. That's it.

Optional granular controls:
- Which data categories to include (browsing, voice, location, purchases, all)
- Minimum confidence threshold (don't match me unless you're really sure)
- Earnings dashboard showing: queries matched, revenue earned, data categories contributing

### What the User Sees

Dashboard widget:
```
Data Dividends: ON
This month: $4.32 earned | 847 queries matched
Top categories: Home & Kitchen, Electronics, Travel
Your data contributed to 12 market research studies
```

### Privacy Guarantees

- Raw data NEVER leaves the device
- Buyer never learns who the user is
- PAN marketplace only sees anonymized confidence scores
- User can disable at any time — immediately stops all matching
- User can exclude specific categories
- All processing runs on local LLM (Ollama) — no cloud AI involved in matching

## Technical Implementation (TODO)

### Components Needed

1. **Marketplace Server** — hosted by PAN (the company), accepts buyer queries, distributes to PAN clients, collects anonymized results, handles payments
2. **Marketplace Client** (in PAN) — connects outbound, pulls queries, runs matching, returns scores
3. **Confidence Scorer** — the algorithm that evaluates multi-signal corroboration
4. **Signal Extractors** — modules that pull relevant signals from events, browser cache, location history, etc.
5. **Earnings Tracker** — local accounting of matched queries, revenue earned, pending payouts
6. **Dashboard Widget** — displays earnings, matched categories, controls

### Dependencies on Existing Systems

- Events table with security columns (trust_origin, source_device, sensitivity, context_safe) — **DONE**
- Compute-to-data pipeline (algorithm runs locally) — **DONE**
- Sensitivity classifier (knows what data is what) — **DONE**
- Guardian (protects against malicious queries from marketplace) — **DONE**
- Anonymizer (strips PII before any score leaves) — **DONE**
- Browser cache reading — TODO
- Purchase history integration — TODO

## Revenue Projections

These are hypothetical. Real numbers depend on marketplace adoption.

| Users | Avg queries/user/month | Avg revenue/query | User payout/month | PAN platform/month |
|-------|----------------------|-------------------|-------------------|-------------------|
| 1,000 | 500 | $0.005 | $1.75 | $750 |
| 10,000 | 500 | $0.005 | $1.75 | $7,500 |
| 100,000 | 500 | $0.01 | $3.50 | $150,000 |
| 1,000,000 | 500 | $0.02 | $7.00 | $3,000,000 |

At scale, per-query value increases because buyers pay more for larger, more reliable datasets.

## Open Questions

1. **Payment rails** — how do users receive payouts? Crypto? PayPal? Bank transfer? Minimum threshold before payout?
2. **Marketplace pricing** — flat rate per query? Auction model? Tiered by confidence level required?
3. **Buyer verification** — who can post queries? KYC for buyers to prevent abuse?
4. **Query categories** — predefined taxonomy or free-form? How granular?
5. **Legal** — what jurisdictions is this legal in? GDPR implications even though data doesn't leave? FTC advertising rules?
6. **At what user count do data dividends become viable?** Below a threshold, aggregate data isn't valuable to buyers.

---

# Business Model — Full Picture

## The Real Value Proposition

Data dividends are a bonus, not the product. The product is:

- **Jarvis-level ambient AI** that knows your entire life context — what you saw, heard, where you were, your health trends, every project and decision — continuously, without you doing anything
- **Augmented memory** that never forgets, cross-references everything, and surfaces relevant context when you need it
- **Health monitoring** that catches gradual changes over months that no doctor visit ever would
- **Inverted advertising** where relevant offers come to you before you know you need them

Data dividends are what users earn passively for participating in something that already makes their life dramatically better. The framing is not "sell your data" — it is "get paid a small cut for allowing anonymous algorithmic queries against data you already chose to capture for yourself."

---

## Revenue Streams (Ranked by Viability)

### 1. Enterprise & Government Contracts — Highest revenue, viable now

PAN Hub deployed for organizations: hospitals, airports, corporate campuses, government agencies.

- Setup fee + per-seat monthly licensing
- Geofencing, sensor control, RBAC already in architecture
- Example: Air traffic control network — every controller has a pendant, PAN Hub manages the org, monitors environmental conditions across all locations
- Does not require consumer user scale to generate real revenue
- **This is how PAN makes money before it has 100,000 users**

### 2. Hardware Margin — Reliable, scales linearly

- Pendant sells at €150-200
- BOM cost at scale: ~€40-60
- Margin: €100+ per unit
- Every hardware buyer is also a node in the data network
- Accessories kit (magnets, steel plate, silicone sleeve) included — low cost, high perceived value

### 3. Inverted Advertising — Privacy-preserving, correct architecture

The algorithm comes TO the user. The user's data never leaves.

**How it works:**
1. Buyer posts query to PAN marketplace: "Find people likely to buy a toaster in the next 30 days, budget €80-150, prefer stainless steel"
2. PAN pulls query to each user's local device
3. Local algorithm checks: does this user's pendant-signed data match? Kitchen remodel in progress? Searched toasters? Asked PAN about breakfast appliances?
4. If match: PAN opens a browser wrapper showing relevant products from that manufacturer
5. If user buys: PAN takes a cut, user takes a cut, manufacturer got a highly qualified lead
6. No browsing history sent anywhere. No profile stored on servers. Just a confidence score returned.

**Why this is better than normal advertising:**
- Manufacturer knows exactly what kind of product to show — not demographic guesses but actual stated and behavioral intent
- User sees something genuinely relevant — not random ads
- 100,000 users with real intent data over 2 years tells a manufacturer more about product-market fit than any focus group ever could

### 4. Data Dividends — Correct long-term vision

Monthly earnings estimates at steady state:

| Scenario | Monthly earnings |
|----------|----------------|
| Passive (just wearing pendant) | $1-8 |
| Active (frequent queries matched) | $8-40 |
| Power user (high-value data categories) | $40-80 |
| Future (large scale network) | Unknown — compounds with network size |

Not enough to pay bills. Meaningful as passive income that grows as the network scales and per-query values increase.

### 5. Module Marketplace — Long tail, build at 10,000 users

Steam model: 1% protocol fee on all data dividend flows through PAN marketplace. Module sales at platform cut.

Examples of modules:
- Blood analysis dock (first-party, sold as hardware)
- Environmental station (third-party developer)
- Plant/soil analysis (third-party)
- Integration modules: home automation, vehicle telemetry, medical devices

**Timing:** Build the marketplace infrastructure when you have 10,000 active users. Before that, third-party developers have no incentive.

---

## The Pendant as Trust Anchor — Anti-Fraud Architecture

The pendant is not just hardware. It is the cryptographic trust anchor that makes the data economy work.

### Why signature copying fails

The ESP32S3 contains a hardware security module with eFuse-based key storage. The private key is burned into the chip at manufacture and cannot be extracted — not through software, not through physical access to the chip.

Every sensor event is signed using ECDSA-256. The signature is mathematically tied to BOTH the private key AND the exact content of that specific event. Change one byte of the event — timestamp, sensor value, anything — and the signature verification fails completely.

Copying a real signature onto a fake event does not work because:
- The signature encodes the cryptographic hash of the original event content
- A different event has a different hash
- The verification equation fails — mathematically, not just detectably

Breaking a 256-bit ECDSA signature requires more computing power than exists on Earth. This is not a practical attack vector.

### What fraud actually looks like with the pendant system

An attacker who owns a pendant can only generate real signed data — because the pendant actually measured it. They cannot inject fake sensor readings with valid signatures.

They could try to inject unsigned fake events alongside real signed ones to boost corroboration scores. The dividend algorithm ignores unsigned events entirely — zero weight, zero payout contribution.

The remaining attack: buy multiple pendants, carry them all, use multiple verified identities to cash out. Economics kill this — each pendant costs €150+, each verified identity requires real KYC. Gaming the system costs more than it earns.

### The economic anti-fraud mechanism

Real users with one pendant earn $1-8/month passively with zero effort. Attackers need to spend €150+ per pendant plus KYC per identity to earn marginally more. The fraud ROI is deeply negative. The defense is not perfect cryptographic impossibility — it is economic irrationality.

---

## Open Source Strategy

PAN must be open source. There is no alternative.

No user gives an always-on ambient AI app their personal data unless they can verify the code. Signal is open source. Tailscale is open source. Every privacy tool that has earned real user trust is open source.

The competitive moat is not the code. It is:
- The running system with years of accumulated data and event history
- The Carrier/Craft zero-downtime architecture already in production
- The pendant hardware with burned-in cryptographic trust keys
- The ecosystem, network effects, and marketplace
- Being 2+ years ahead of anyone attempting to replicate it from scratch

**What to open source:** Everything — core system, dashboard, Android app, pendant firmware.

**What to keep internal initially:** Operational docs that describe the fastest development and deployment paths. These can be released later once the lead is insurmountable.

**Revenue with open source:** The 1% protocol fee on data dividends applies to all forks that use the PAN marketplace. Forks that build their own competing marketplace get zero cut — that is fine, they also get zero network effects and zero user base.

---

## Identity & Anonymity Design

Two completely separate layers:

**Layer 1 — Data matching (fully anonymous):**
- Algorithm runs locally on user's device
- Only confidence scores returned to marketplace — no PII, no identity
- User never knows exactly why they matched a specific query
- Buyer never knows who matched their query
- No identity requirement at this layer

**Layer 2 — Cashout (verified identity required):**
- One-time KYC to link a bank account or verified crypto wallet
- Required for legal compliance — data dividends are taxable income in virtually every jurisdiction
- Multiple accounts per person become expensive due to identity verification cost
- What you earned money FOR is never revealed — only the amount earned

**On taxes:** Build tax reporting into the PAN dashboard from day one — annual earnings summary, categorized by data type. This is a feature not a liability. Transparency about what users earned protects PAN legally.

---

## Why This Works at Scale

The data that makes PAN valuable to users — ambient health monitoring, perfect memory, context-aware AI — is exactly the same data that makes PAN valuable to the marketplace. Users do not have to do anything different. They wear the pendant, live their lives, and both benefits compound simultaneously.

At 1,000,000 users:
- Each user has a Jarvis-level AI companion that improves every day
- Each user earns passive dividend income without any effort
- The marketplace has the most valuable consumer intent dataset ever assembled — cryptographically verified, ambient, longitudinal, multi-sensor
- No other platform can replicate this because it requires the hardware trust anchor that cannot be software-faked

The pendant is the key to everything. It makes the AI better (real sensor data), it makes the dividends real (cryptographic trust), and it makes the network defensible (hardware signatures cannot be faked).

---

*Last updated: 2026-04-20*

---

## Cryptographic Trust Implementation

Every PAN device — pendant, phone, and PC — has a hardware security chip that can cryptographically sign data. This signing must happen on every single event insert. Events without a valid hardware signature receive zero weight in the dividend algorithm. This is non-negotiable.

### Hardware Trust Chips by Device

| Device | Chip | Key storage |
|--------|------|-------------|
| PAN Pendant (ESP32S3) | eFuse HSM | Private key burned at manufacture, unextractable |
| Android phone (Pixel) | Titan M2 | Android Keystore, hardware-backed |
| Windows PC (HP ProDesk) | TPM 2.0 | Windows CNG, hardware-backed |
| Mac | T2 / Apple Silicon | Secure Enclave |

All four are equivalent in security. None can have their private key extracted through software or physical attack. Breaking a 256-bit ECDSA signature requires more computing power than exists on Earth.

### Why Signature Copying Fails

Every signature is mathematically tied to BOTH the private key AND the exact byte content of that specific event. Change one character — the timestamp, the sensor value, anything — and verification fails completely. You cannot copy a real signature onto a fake event. The math does not allow it.

### Trust Weight by Device

Different devices get different dividend weights because they carry different sensors:

| Device | Weight | Reason |
|--------|--------|--------|
| Pendant | Highest | Unique sensors: thermal, spectrometer, EMF, UV, gas — physically impossible on a phone |
| Phone | Medium | GPS, accelerometer, mic, camera — real but phone sensors only |
| PC | Medium | TPM-signed activity data — keyboard patterns, app usage, browsing |
| Multi-device corroboration | Maximum | Phone + PC + pendant all signing the same moment — nearly impossible to fake |

### Required Database Schema Changes

Add to the events table:

```sql
ALTER TABLE events ADD COLUMN device_id TEXT;
ALTER TABLE events ADD COLUMN signature TEXT;
ALTER TABLE events ADD COLUMN pubkey_fingerprint TEXT;
```

The `trust_origin` column already exists. `signature` is the ECDSA-256 signature of the full event payload. `pubkey_fingerprint` identifies which registered device key signed it.

### Implementation Per Platform

**Pendant (ESP32S3 firmware):**
```c
// Sign event payload using eFuse-stored key via mbedTLS
mbedtls_pk_context key;
mbedtls_pk_init(&key);
// Load key from eFuse partition
unsigned char signature[64];
size_t sig_len;
mbedtls_pk_sign(&key, MBEDTLS_MD_SHA256, 
    event_hash, 32, signature, &sig_len, 
    mbedtls_ctr_drbg_random, &ctr_drbg);
// Attach signature to event before sending to phone via BLE
```

**Android phone (Kotlin):**
```kotlin
// Use Android Keystore — hardware-backed on Pixel devices
val keyStore = KeyStore.getInstance("AndroidKeyStore")
keyStore.load(null)
val privateKey = keyStore.getKey("PAN_SIGNING_KEY", null) as PrivateKey
val signer = Signature.getInstance("SHA256withECDSA")
signer.initSign(privateKey)
signer.update(eventPayload.toByteArray())
val signature = signer.sign() // Base64 encode before storing
```

**Windows PC (Node.js):**
```javascript
// Use Windows CNG via TPM — requires tpm2-tss or node-tpm package
// OR use the Windows built-in crypto via PowerShell bridge
// Simplest approach: generate a software key stored in Windows Credential Manager
// backed by TPM at rest — available via node crypto + Windows DPAPI
const { createSign } = require('crypto')
const sign = createSign('SHA256')
sign.update(JSON.stringify(eventPayload))
const signature = sign.sign(tpmBackedPrivateKey, 'base64')
```

### Event Insert Pattern — All Platforms

Every event insert must follow this pattern:

```javascript
// 1. Build the payload with all fields including timestamp
const payload = {
  session_id: sessionId,
  type: type,
  data: data,
  created_at: Date.now(),
  device_id: DEVICE_ID  // registered device identifier
}

// 2. Hash the payload
const payloadStr = JSON.stringify(payload)
const hash = crypto.createHash('sha256').update(payloadStr).digest()

// 3. Sign the hash with hardware key
const signature = await signWithHardwareKey(hash)  // platform-specific

// 4. Insert with signature
db.prepare(`
  INSERT INTO events 
  (session_id, type, data, created_at, device_id, signature, pubkey_fingerprint, trust_origin)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  sessionId, type, JSON.stringify(data), payload.created_at,
  DEVICE_ID, signature, PUBKEY_FINGERPRINT, 'self'
)
```

### Dividend Algorithm Verification

When the dividend algorithm evaluates events:

```javascript
function getEventWeight(event) {
  // No signature = zero weight, ignored entirely
  if (!event.signature) return 0
  
  // Verify signature against registered public key for this device
  const pubkey = getRegisteredPubkey(event.device_id)
  if (!pubkey) return 0
  
  const valid = verifySignature(
    event.signature, 
    buildPayload(event),  // reconstruct exact payload that was signed
    pubkey
  )
  if (!valid) return 0
  
  // Valid signature — assign weight by device type
  const baseWeight = DEVICE_WEIGHTS[event.device_type] || 0.1
  return baseWeight
}
```

### Device Registration

Each device registers its public key with the PAN hub once on first connection:

```javascript
// Device sends its public key + device type on first handshake
POST /api/v1/devices/register
{
  device_id: "unique-device-uuid",
  device_type: "pendant" | "phone" | "pc",
  pubkey: "base64-encoded-public-key",
  pubkey_fingerprint: "sha256-of-pubkey"
}
```

Hub stores the public key. All future events from that device are verified against it. If a device is reported stolen or compromised, its public key is revoked and all its unsigned future events get zero weight.

### Implementation Priority

1. **Pendant firmware first** — pendant data is highest value, implement signing in ESP32S3 firmware before shipping hardware
2. **Android app second** — phone is always-on and already uses Android Keystore for Tailscale auth, extend that
3. **PC server third** — Windows TPM via Node.js, lower priority since PC data has medium weight anyway

### What This Means for Fraud

With all three devices signing:
- Fake unsigned events: zero weight, ignored
- Copied signatures: verification fails, ignored  
- Attacker with real pendant: can only generate real data the pendant actually measured
- Attacker with multiple pendants + multiple identities: costs more than they earn
- Multi-device corroboration (phone + PC + pendant same moment): virtually impossible to fake without physically owning all three devices and being present

The system does not need to be perfectly fraud-proof. It needs fraud to be economically irrational. Hardware signing across three device classes achieves this.

---

*Last updated: 2026-04-20*
