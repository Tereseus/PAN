# Data Dividends — Design Document

## Overview

Data dividends are PAN's primary revenue model. Users earn passive income by allowing anonymized queries to run against their local data. Raw data never leaves the device — only confidence scores and anonymized aggregate results.

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
