# ΠΑΝ — Sensor Array & Capabilities

> **Ἡ γνῶσις ἥτις σῴζει οὐδενὶ δεσπότῃ ἀνήκει.**
>
> **Knowledge that saves belongs to no master.**
>
> **ΠΑΝ is now remembering.**

22 sensors. Two modes of use.

## How the Pendant Works

The pendant sits on your chest. Most sensors work passively from there — reading the environment around you without any interaction. Some sensors need close range and require you to hold the pendant up to what you're scanning, or hold the object up to the pendant.

### Passive Mode (on your chest, always running)

| Sensor | Range | Notes |
|--------|-------|-------|
| Camera | Line of sight | Sees what you see. Captures photos every 5 seconds. |
| Microphone | Room-scale | Picks up conversation, ambient audio. |
| Gas / Air Quality | Ambient | Reads the air around you continuously. Detects leaks, smoke, VOCs. |
| UV Sensor | Ambient | Reads UV from the sky. Tracks exposure over time. |
| Barometer / Temp / Humidity | Ambient | Weather, altitude, mold risk. |
| GPS | Satellite | Always tracking. Every event geotagged. |
| Accelerometer / Gyro | On-body | Motion, steps, fall detection, posture. |
| Heart Rate / SpO2 | Chest contact | Continuous pulse and blood oxygen. |
| Ambient Light | Ambient | Light level monitoring, eye strain. |
| Sound Level | Room-scale | Decibel measurement, hearing damage alerts. |
| Laser Distance | Up to 2m | Points outward from chest. Instant tape measure. |
| Ultrasonic | Up to 4m | Distance in darkness, obstacle detection. |
| Thermal Camera | 1-5m | See heat signatures from across the room. Hot wires, body heat, overheating outlets. |

### Active Mode (hold it up to something)

| Sensor | Range | How to use |
|--------|-------|-----------|
| Spectrometer | 1-5 cm | Hold pendant up to the object, or hold the object up to the pendant. Reads chemical composition — food freshness, material ID, ripeness, fakes. |
| Color Sensor | 1-2 cm | Same — hold it close. Reads exact color values for paint matching, material verification. |
| EMF Sensor | 5-15 cm | Hold pendant near a wall to check for live wires before drilling. Works through drywall. |
| Magnetometer | 5-20 cm | Hold near a surface to detect metal, hidden magnets, or get compass heading. |

The pendant has a **magnetic clip** — unclip it from your shirt, hold it up to what you're scanning, clip it back. Takes 2 seconds.

---

## V1 — Ships with Pandant

### 1. Camera (OV2640) — Built into XIAO
- **What:** Visible light photos, 2MP
- **How:** Photo every N seconds, streamed to phone via BLE
- **Size:** Tiny (built in)

**Use cases:**
- "What am I looking at?" → Claude identifies objects
- Read text, signs, labels from photos
- Face recognition (who's in front of you)
- Document/receipt capture
- Visual diary — everything you saw, searchable forever
- "Where did I leave my keys?" → search photo history
- Navigation aid for visually impaired
- License plate capture
- Plant/animal identification
- Surgical field monitoring (medical)

**Superhuman?** No — but PERFECT RECALL makes it superhuman

---

### 2. Microphone (PDM) — Built into XIAO
- **What:** Audio capture, human hearing range (~20Hz-20kHz)
- **How:** Backup mic on Pandant + phone mic is PRIMARY
- **Size:** Tiny (built in)

**Use cases:**
- Backup audio if phone is far/pocketed
- Closer to source in conversations (on chest)
- Wake word detection (ESP-SR on-device)
- Ambient sound monitoring
- "What song is playing?"
- Meeting/conversation recording
- Evidence capture

**Superhuman?** No — but ALWAYS ON + SEARCHABLE is superhuman

---

## V2 — Sensor Expansion (~€120 budget, ~€300 full)

### 3. Gas / E-Nose (BME688) — €15 · 3x3mm — MVP SENSOR FOR V2
- **What:** VOCs, CO, methane, alcohol, smoke + temp/humidity/pressure (4-in-1 chip)
- **How:** Heated metal oxide surface changes resistance with gas

**Use cases:**
- ★ "CO rising in this room — open a window NOW"
- ★ "Gas leak detected nearby — leave immediately"
- "Air is stale — CO2 at 1200ppm, that's why you're drowsy"
- "Alcohol detected on this person's breath"
- "Smoke detected — possible fire"
- "Your dog is stressed" (cortisol metabolites)
- "Someone nearby is anxious" (stress hormones in air)
- "Food is starting to spoil" (bacterial VOCs)
- Surgical: "infected tissue detected at incision site"
- Factory: continuous air safety monitoring

★ = LIFE SAVING · **Superhuman? YES — like a dog's nose**

Highest value single addition after camera and mic.

---

### 4. UV Sensor (LTR390) — €3 · 2x2mm
- **What:** Ultraviolet light intensity
- **How:** Photodiode sensitive to UV-A and UV-B wavelengths

**Use cases:**
- "UV index is 9 — you'll burn in 15 minutes"
- "UV exposure today: 3.2 hours — limit reached"
- UV fluorescence detection (biological residue on surfaces)
- Permanent blacklight — CSI mode
- "This surface hasn't been cleaned" (biological residue)
- Skin cancer prevention through daily UV tracking

**Superhuman? YES — UV is invisible to humans**

---

### 5. IR Thermal Camera (MLX90640) — €40-60 · 16x12mm
- **What:** 32x24 pixel thermal image, heat signatures
- **How:** Detects infrared radiation emitted by warm objects

**Use cases:**
- "Someone sat in that chair recently" (heat trace)
- "Heat leak from that wall — bad insulation"
- "Person behind that door" (body heat through thin walls)
- "Engine overheating" (equipment monitoring)
- Night vision — see warm bodies in total darkness
- Fever detection in crowds
- Electrical hotspots (fire risk in wiring)
- Animal detection at night (wildlife, security)
- "Your hands are cold — circulation issue?"

**Superhuman? YES — like a snake's pit organ**

---

### 6. Magnetometer (QMC5883L) — €2 · 3x3mm
- **What:** Magnetic field direction and strength
- **How:** Hall effect / magnetoresistive elements

**Use cases:**
- Always-on compass — "North is that direction"
- "Metal object underground here" (buried pipes, treasure)
- "Large metal structure behind this wall"
- "Magnetic anomaly — something metallic nearby"
- Stud finder (detect nails/screws in walls)
- Detect hidden electronics
- Geomagnetic navigation (works without GPS)

**Superhuman? YES — like migratory birds**

---

### 7. Air Quality (SGP40) — €8 · 2.4x2.4mm
- **What:** VOC index, indoor air quality score
- **How:** Metal oxide semiconductor, heated plate

**Use cases:**
- "This room has bad air — VOC index 300, open windows"
- "Paint fumes detected — ventilate"
- "Cleaning chemicals in the air — irritant level"
- Long-term air quality logging (your home, office, commute)
- "This restaurant kitchen has poor ventilation"
- Factory worker safety — continuous exposure monitoring

**Superhuman? YES — completely invisible to humans**

---

### 8. Spectrometer (AS7341) — €15 · 3.1x2mm — KILLER FEATURE
- **What:** 11-channel light wavelength analysis (spectral fingerprint of materials)
- **How:** Photodiode array with narrowband optical filters

**Use cases:**
- ★ "That pill is ibuprofen 400mg, not aspirin"
- ★ "That food is starting to spoil"
- "That paint contains lead" (old buildings, kids' toys)
- "That's fake gold" / "That's real silver"
- "This water has unusual composition"
- "That fabric is polyester, not silk"
- "That pigment is titanium white — post-1920 painting"
- Fruit ripeness detection
- Gemstone / mineral identification
- Forgery detection (currency, documents, art)

★ = KILLER FEATURE · **Superhuman? YES — identifies materials by light signature**

---

### 9. Accelerometer + Gyroscope (BMI270) — €5 · 2.5x3mm
- **What:** Motion, rotation, vibration, orientation, freefall
- **How:** MEMS — microscopic spring-mass systems on silicon

**Use cases:**
- Step counter, distance walked
- Fall detection → "PAN user has fallen, alerting contacts"
- Sleep quality tracking (restlessness via chest movement)
- "Vibration detected — heavy machinery nearby"
- Earthquake detection
- Activity recognition (walking, running, driving, sitting)
- Gesture control (tap Pandant = command)
- Posture monitoring

**Superhuman?** Matches human vestibular — but more precise

---

### 10. Ultrasonic Distance (RCWL-1601) — €2 · 20x15mm
- **What:** Distance measurement via echolocation (>20kHz)
- **How:** Emits ultrasonic pulse, measures return time

**Use cases:**
- "Object 1.2m to your left" (visually impaired aid)
- Room mapping in darkness
- "Ultrasonic source at 23kHz — pest deterrent device"
- Parking distance sensing
- Detect ultrasonic emitters (some security systems)
- Detect approaching objects you can't see

**Superhuman? YES — echolocation like bats**

---

### 11. EMF Sensor (AD8317) — €3 · small module
- **What:** Electromagnetic field strength (RF + power frequency)
- **How:** Logarithmic RF power detector

**Use cases:**
- ★ "Strong EMF in this wall — LIVE WIRING, don't drill"
- "WiFi network here, strong signal"
- "Cell tower nearby — high RF exposure"
- "Hidden electronic device detected" (bug sweeping)
- Construction: find live wires before cutting
- "Microwave oven is leaking RF"
- Detect active surveillance equipment

★ = LIFE SAVING · **Superhuman? YES — no animal has this**

---

### 12. Radiation Detector (RadSens) — €30 · 10x50mm tube
- **What:** Ionizing radiation (gamma + beta)
- **How:** Geiger-Müller tube — gas ionization from particles

**Use cases:**
- ★ "Elevated radiation — MOVE AWAY from this area"
- "Background radiation normal" (peace of mind)
- Check items from unknown origin (antiques, scrap metal)
- Nuclear accident early warning
- Construction: check building materials for contamination
- Travel safety in unfamiliar regions
- Continuous logging — "your daily exposure was X microsieverts"

★ = LIFE SAVING · **Superhuman? YES — no animal has this**

---

### 13. Heart Rate + SpO2 (MAX30102) — €3 · 5.6x3.3mm
- **What:** Pulse rate + blood oxygen percentage
- **How:** IR LED shines through skin, measures absorption (needs skin contact — window in case back on chest)

**Use cases:**
- Continuous heart rate monitoring
- "Heart rate spiked to 140, sustained 20 min — check in"
- Arrhythmia detection (irregular patterns over time)
- Blood oxygen drop warning (sleep apnea, altitude, COVID)
- Exercise intensity tracking
- "Your resting heart rate has increased 8bpm this week"
- Stress indicator (elevated HR + context)

**Superhuman?** Self-monitoring (humans can't read own vitals)

---

### 14. GSR / Skin Conductance (GSR module) — €3 · small module
- **What:** Galvanic skin response — sweat/conductance changes
- **How:** Two electrodes measure skin's electrical conductance (needs skin contact on chest)

**Use cases:**
- "Skin conductance suggests anxiety — try breathing"
- Lie detection (entertainment, not forensic-grade)
- Stress tracking over time
- Emotional state correlation with events
- "You get stressed every Monday at 9am" (pattern detection)
- Meditation/calm feedback

**Superhuman?** Self-monitoring

---

### 15. GPS (Seeed GNSS L76K) — €13 · small module
- **What:** Global position, speed, direction, altitude
- **How:** Satellite triangulation (GPS + GLONASS + Galileo)

**Use cases:**
- Every photo/audio tagged with exact location
- "Where was I when I had that conversation?" → search
- Speed tracking, route logging
- Geofencing alerts ("you left the house")
- Emergency: exact coordinates for rescue services
- "You spend 6 hours/week at this location"
- Works without phone (Pandant has own GPS)

**Superhuman? YES — precise coordinates no animal can match**

---

### 16. Ambient Light (BH1750) — €2 · 2x2mm
- **What:** Light intensity in lux (0.1 - 65535 lux)
- **How:** Photodiode with digital output

**Use cases:**
- Auto-adjust Pandant screen brightness
- "You've had only 200 lux today — get sunlight"
- Sleep hygiene — "your bedroom has too much light at night"
- "This workspace is 150 lux — too dim, eye strain risk"
- Light exposure logging for circadian health

**Superhuman?** More precise than human perception

---

### 17. Color Sensor (TCS34725) — €5 · 2x2.4mm
- **What:** Precise RGB + clear light color values
- **How:** Photodiode array with RGB color filters

**Use cases:**
- Exact color matching — "that's Pantone 185 C"
- Paint matching for home improvement
- Skin tone monitoring (jaundice, pallor, sunburn progression)
- Food color analysis (ripeness, freshness)
- "That mole changed color" (skin health tracking)

**Superhuman?** More precise than human color perception

---

### 18. Laser Distance / ToF (VL53L0X) — €3 · 4.4x2.4mm
- **What:** Precise distance to objects (up to 2m, mm accuracy)
- **How:** Time-of-flight laser — fires IR laser, measures return

**Use cases:**
- Instant tape measure — "that wall is 3.7m away"
- Proximity alert for visually impaired
- Gesture detection (hand wave near Pandant)
- Object approach warning
- Precise object positioning

**Superhuman? YES — laser precision**

---

### 19. Sound Level (MAX4466) — €3 · small module
- **What:** Decibel measurement (calibrated sound pressure)
- **How:** Electret mic with amplifier, analog output

**Use cases:**
- "85dB — hearing damage risk, prolonged exposure"
- Noise logging over time
- "This workspace averages 72dB — above recommended"
- Concert/club safety — "you've been at 95dB for 2 hours"
- Construction site compliance monitoring

**Superhuman?** More precise than human hearing

---

### 20. Temperature + Humidity (SHT40) — included in BME688
- **What:** Ambient temp (±0.1°C) and humidity (±1.8% RH)
- **How:** Capacitive humidity + bandgap temperature sensor

**Use cases:**
- "31°C, 80% humidity — dehydration risk"
- "Room is 16°C — cold enough to affect immune system"
- Mold risk warning (high humidity sustained)
- "Humidity dropped 20% in 1 hour — weather changing"
- Comfort optimization — "your productivity peaks at 22°C"

**Superhuman?** More precise than human thermoception

---

### 21. Barometric Pressure — included in BME688
- **What:** Atmospheric pressure (300-1100 hPa)
- **How:** Piezoresistive MEMS pressure sensor

**Use cases:**
- "Pressure dropping fast — storm in 2-3 hours"
- Altitude measurement — "you're at 342m elevation"
- Weather prediction without internet
- Floor detection in buildings (elevator vs stairs)
- Aviation/hiking altitude safety
- "Pressure change may trigger your migraines"

**Superhuman? YES — no animal this precise**

---

### 22. pH Sensor (PH-4502C) — €5 · probe + module
- **What:** Acidity/alkalinity of liquids (0-14 pH)
- **How:** Glass electrode measures hydrogen ion concentration

**Use cases:**
- Water quality testing
- Soil testing (gardening/agriculture)
- Pool/aquarium maintenance
- Food safety — "that milk is turning"
- Wound pH monitoring (healing indicator)

**Superhuman? YES — no human equivalent**

Note: may skip for Pandant, spectrometer partially replaces

---

## Optional High-End

### FLIR Lepton (thermal camera upgrade) — €150-200
- **What:** 80x60 pixel radiometric thermal camera
- **How:** Microbolometer array — military tech miniaturized

Replaces MLX90640 with much higher resolution. Same use cases but sharper, longer range, more detail. Optional — only for full build (~€300 total).

---

## Added: Visible Laser + Flashlight (V1)

### Visible Laser Pointer — €0.50 · 6mm diameter
- **What:** Red or green visible laser dot
- **How:** Laser diode module, GPIO pin through NPN transistor
- **Mounted:** Next to camera lens, aligned with camera center

**Use cases:**
- "What is this?" → laser turns on, you aim by moving shoulder
- Camera captures every 0.5s while laser is on
- Claude identifies what the laser is pointing at
- Mechanics, electricians, anyone working with hands
- Precise identification of small components in tight spaces

### Flashlight LED — €0.10 · 3mm
- **What:** Bright white LED for illumination
- **How:** GPIO pin through NPN transistor
- **Mounted:** Above camera for illumination in dark environments

**Use cases:**
- Dark spaces (under car, inside cabinets, attic)
- Supplements camera in low light
- Emergency flashlight
- "Turn on the light" voice command

---

## Physical Size Comparison

### V1 — Dog Tag / Name Badge
- **Components:** XIAO ESP32S3 + camera + mic + laser + flashlight + 18350 battery (1000mAh)
- **Battery:** 18350 Li-ion, 18mm x 35mm, replaceable, twist-lock back cap
- **With case (1.5mm walls) + magnet (3mm):** ~45x38x23mm
- **Weight:** ~35g (lighter than a car key fob)
- **Analogy:** Name badge / thick dog tag. Forget it's there after 5 minutes.
- **Attachment:** Neodymium N52 magnet (10mm x 3mm, ~5 lb pull) + steel disc on shirt inside
- **Battery swap:** 2 seconds, carry a spare, zero downtime

### V2 — Zippo Lighter (without radiation tube)
- **Components:** All 20 sensors (skip radiation + pH) + 18350 battery (1000mAh) + GPS
- **With case + magnet:** ~52x42x25mm
- **Weight:** ~70g (same as AirPods case)
- **Analogy:** Zippo lighter. Notice it day one, forget by day two.
- **Battery swap:** Same 18350 as V1 — universal across both versions

### Charging & Battery
- **18350 Li-ion** — standard, rechargeable, €3-5, available everywhere
- **USB-C port** — already on the XIAO ESP32S3, no extra port needed
- **XIAO's built-in charge IC** handles battery charging through its own USB-C
- **18350 holder** soldered to XIAO's BAT+/BAT- pads
- **Twist-lock back cap** — quarter turn, battery slides out, one-hand operation
- **Two options:** plug USB-C in at night (like a phone), OR hot-swap battery for zero downtime
- **USB-C also works for:** firmware flashing, though OTA via BLE preferred

### ONE Design — All Sensors

No V1/V2 split. One case, one PCB, all 20 practical sensors. Reasons:
- "22 sensors including thermal camera and spectrometer" sells itself
- €155 total — cheaper than an Apple Watch
- Soldering 3 sensors vs 20 is 30 minutes extra work, same I2C bus
- One case to design, one BOM, one assembly guide
- Sensors not yet supported in firmware just sit dormant (zero power)
- Every unit ships with full capability

### Case Design — Single Enclosure

**Front face (top to bottom):**
- Camera window (center, 5mm clear plastic)
- Laser pinhole (right of camera)
- Flashlight hole (left of camera)
- UV/spectrometer/ambient light/color sensor window (clear strip below camera)
- Ultrasonic ports (two small holes, bottom edge)

**Side (left or right edge):**
- Gas/air ventilation grille (slots like a phone speaker)
- USB-C port (XIAO's built-in)

**Back:**
- Heart rate optical window (clear plastic, center, against chest)
- Neodymium magnet (offset from heart rate window)
- Battery twist-lock cap (bottom half)

**Bottom edge:**
- Mic port (1mm sound hole)

**Fully enclosed (no openings needed):**
- Thermal camera, magnetometer, accelerometer/gyro, GPS, EMF
- Radiation tube (fits alongside battery — both ~35-50mm long)
- ToF distance, sound level, barometer

### Design Philosophy
- ONE device, all sensors, full capability
- Replaceable 18350 battery — charge via USB-C or hot-swap
- Right to repair — cheap, user-swappable battery, 3D printable case
- Magnetic attachment — works on any clothing
- ~70g — same as AirPods case, forget it's there by day two
- Case is 3D printable — design files open source
- Zippo lighter size (~52x42x25mm with case and magnet)

### Battery Life (1000mAh)

| Mode | Camera | Mic | BLE | Life |
|------|--------|-----|-----|------|
| Full blast | Every 5s | Always on | Always streaming | 6-8 hrs |
| Smart (default) | 5s moving, 30s still | VAD only | Batch every 30s | 10-14 hrs |
| Meeting (no camera) | Off | Always on | Batch | 16-20 hrs |
| Sleep | Off | Off | Periodic sync | 3-4 days |

Smart mode is the default — motion-triggered camera (accelerometer detects movement),
VAD-gated mic (ESP32 low-power core), batched BLE transmission.
Full day coverage in smart mode.

### V2 Full — Small Matchbox (with radiation tube)
- **Components:** All 22 sensors including RadSens tube
- **Size:** ~55mm x 35mm x 15mm
- **Weight:** ~60g
- **Analogy:** Small matchbox. The radiation tube (50mm) forces the length.
- **Note:** Radiation sensor is optional snap-on module. Most people don't need it.

---

## Pin Budget (XIAO ESP32S3 Sense)

| Connection | Pins | What's on it |
|-----------|------|-------------|
| I2C bus (shared) | 2 | 11 sensors: BME688, LTR390, MLX90640, QMC5883L, SGP40, AS7341, BMI270, MAX30102, BH1750, TCS34725, VL53L0X |
| Camera | 8 | OV2640 (built-in, dedicated) |
| Microphone | 1 | PDM mic (built-in) |
| Analog | 2-3 | GSR, EMF, sound level |
| Digital GPIO | 2 | Laser diode, flashlight LED |
| UART | 1-2 | GPS module |
| Pulse | 1 | RadSens (if included) |
| **Total needed** | ~19-20 | |
| **Available on XIAO** | ~11 | Need I2C GPIO expander (MCP23017, €2) for V2 |

V1 fits easily on XIAO's native pins. V2 needs a €2 GPIO expander chip.

---

## Summary

| Metric | Value |
|--------|-------|
| Total sensors | 22 (20 practical, 2 optional) |
| Beyond human capability | 15 of 22 |
| Life-saving sensors | 4 (gas, EMF, radiation, spectrometer) |
| V1 size | AirTag / coat button (~30mm) |
| V1 cost | ~€30-40 (ESP32 + battery + case + laser + LED) |
| V2 size | Zippo lighter (~45x35mm) |
| V2 cost (practical build) | ~€120 |
| V2 cost (full build) | ~€300 |
| Dimensions of reality covered | 9 of 12 fundamental physics dimensions |
