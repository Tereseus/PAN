# PAN — Business Model & Enterprise Vision

## Why PAN Wins on Form Factor

Every wearable AI attempt has tried the wrong form factor:

| Product | Form Factor | Why It Failed/Struggles |
|---------|-------------|----------------------|
| Google Glass | Glasses | People don't want shit on their face. Looks weird. Social stigma. |
| Meta Ray-Ban | Glasses | Better looking but still glasses. Not everyone wears glasses. Prescription wearers have to choose. |
| Apple Vision Pro | Headset | Isolating. Heavy. Expensive. You look like a robot. |
| Humane AI Pin | Chest pin | Right idea, terrible execution. No screen. Overheated. $699. |
| Rabbit R1 | Handheld device | Just a worse phone. Why carry a second device? |
| Limitless Pendant | Necklace | Audio only. No camera. No sensors. Limited. |

**PAN's form factor: a button on your shirt.**

Nobody thinks twice about a pin, a badge, or a button. It's invisible socially. It doesn't go on your face. You don't hold it. It's just there — like a watch but even less intrusive. It sticks magnetically, weighs nothing, and it sees/hears/senses everything.

Future clothing manufacturers could even build PAN-ready magnetic mounts into shirts — a small reinforced spot with a magnet already embedded. "PAN-compatible" becomes a clothing tag.

## The Glasses Problem

Glasses-based AR/AI has fundamental issues:
- Not everyone wears glasses — forces non-glasses-wearers to adopt a new accessory
- Prescription wearers have to choose between their prescription and the smart glasses (or pay for expensive prescription smart lenses)
- Social stigma — people know you're recording them
- Weight on nose and ears all day
- Fragile, easy to break
- Fashion limitations — you're stuck with one frame style
- Eye strain from screens millimeters from your eyes
- For translation: other people can't see what you're reading (PAN's chest screen solves this)

A button on your chest has none of these problems.

## Pricing Strategy

### At-Cost Philosophy
PAN is built to help people, not extract profit. Sell at cost, make the technology accessible.

| Scale | BOM | Retail Price | Notes |
|-------|-----|-------------|-------|
| Prototype (1 unit) | ~€130 | N/A | What we're building now |
| Small batch (100 units) | ~€90 | ~€100-110 | Early adopters, Kickstarter |
| Medium (1,000 units) | ~€70 | ~€80-90 | Covering assembly + shipping + returns |
| Large (10,000 units) | ~€55-65 | ~€70-75 | True at-cost |
| Massive (100,000+ units) | ~€40-50 | ~€50-60 | Approaching impulse-buy territory |

At €50-60, PAN is cheaper than AirPods. At that price it's an impulse buy for anyone interested in personal AI, translation, health monitoring, or just being able to ask "what am I looking at?"

### Revenue Model (Not From Hardware)

The hardware is sold at cost. Revenue comes from services:

**Option A: Subscription**
- Free tier: on-device processing only (wake word, basic camera, local STT/TTS)
- PAN Cloud (€5-10/month): full Claude AI processing, cloud memory storage, cross-device sync, advanced sensor analysis
- PAN Pro (€15-20/month): medical-grade blood analysis AI, veterinary chemical analysis, professional-grade spectral identification

**Option B: AI Company Partnership**
- Partner with Anthropic, Google, or similar
- They subsidize hardware cost (like Google subsidizes Android phones)
- In exchange: anonymized sensor data at scale
- Users consent to data sharing for reduced/free service
- This is the Google model: give away the tool, monetize the data

**Option C: Pure Open Source**
- Hardware designs fully open source
- Software fully open source
- Anyone can build their own PAN
- Revenue from selling pre-assembled units at cost for people who don't want to build
- Community-driven development

## The Data Opportunity

PAN generates data that doesn't exist anywhere else:

| Data Type | Current Sources | PAN Adds |
|-----------|----------------|----------|
| Visual (what people see) | Phone photos (intentional only) | Continuous passive capture — everything, not just what you choose to photograph |
| Audio (what people hear) | Voice assistants (only when triggered) | Continuous ambient audio — conversations, environmental sounds, everything |
| Chemical (what's in the air) | Fixed sensors in buildings | Mobile, personal, continuous air quality and chemical detection everywhere you go |
| Thermal (heat signatures) | Specialized equipment only | Continuous thermal awareness of your environment |
| Health (blood, vitals) | Doctor visits 1-2x/year | Daily blood panels, continuous heart rate proxy, stress levels |
| Environmental correlation | Weather apps (generic, not personal) | YOUR specific environment — the air YOU breathe, the temperature WHERE you are |

**The combination is what's valuable.** Any single data stream is somewhat interesting. ALL of them correlated together with AI analysis is unprecedented. Nobody has continuous multimodal personal sensor data at this resolution.

For AI training: this is exactly the kind of real-world grounded data that makes AI models understand physical reality — not just text and images from the internet, but actual sensor readings correlated with human experience.

## Enterprise Applications

PAN isn't just consumer. Enterprise use cases:

| Industry | Application |
|----------|------------|
| **Medical** | Nurses/doctors with always-on vital awareness, surgical gas sensing, patient monitoring |
| **Manufacturing** | Workers detecting gas leaks, overheating equipment, air quality in factories |
| **Agriculture** | Farmers monitoring soil, plant health, weather, animal welfare continuously |
| **Construction** | Detecting live wires (EMF), structural heat leaks (thermal), air quality in enclosed spaces |
| **Security** | Continuous environmental monitoring, radiation detection, chemical threat detection |
| **Veterinary** | Animal health monitoring through chemical sensing |
| **Food safety** | Continuous spectral analysis of food products, spoilage detection |
| **Research** | Field scientists with always-on environmental data collection |

For enterprise, you'd use the **Claude API directly** — one API key per organization, pay per usage, built into the subscription. Users don't need individual Claude subscriptions. Volume pricing negotiated with Anthropic.

## Why Anthropic (or Similar) Would Care

1. **Novel training data** — multimodal sensor data correlated with human experience. This doesn't exist in any dataset.
2. **Real-world grounding** — AI models struggle with physical world understanding because they're trained on internet text/images. PAN provides actual sensor readings from the real world.
3. **Distribution** — PAN puts Claude in people's lives 24/7, not just when they open a chat window. That's the dream for every AI company.
4. **Lock-in** — once your entire life memory is stored in a system powered by Claude, switching to GPT or Gemini means losing your memories. Powerful retention.
5. **Data moat** — the company that has millions of people's continuous real-world sensor data has an unassailable competitive advantage in training grounded AI.

## Open Questions
- Regulatory: medical device classification for blood analysis module?
- Privacy: GDPR compliance for continuous recording in EU?
- Social acceptance: will people around you be comfortable with an always-on camera?
- Insurance: could continuous health monitoring reduce health insurance premiums?
- Legal: recording laws vary by jurisdiction — two-party consent states/countries?
