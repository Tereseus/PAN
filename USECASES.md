# PAM — Real-World Use Cases by Sensor

What people would know at all times with a fully loaded PAM.

## Safety (Could Save Your Life)

| Use Case | Sensor | Why It Matters |
|----------|--------|---------------|
| "CO levels rising in this room — open a window" | Gas (BME688) | CO is odorless, kills people in their sleep |
| "Gas leak detected nearby" | Gas (BME688) | Natural gas/propane leaks cause explosions |
| "Elevated radiation — move away" | Geiger (RadSens) | Invisible, no human sense for it |
| "UV index is 9, you'll burn in 15 minutes" | UV (LTR390) | Skin cancer prevention |
| "Air quality bad, PM2.5 is high" | Air quality (SGP40) | Long-term lung damage from pollution |
| "Strong EMF source in this wall — live wiring" | EMF (AD8317) | Avoid drilling into live wires |

**Most likely to trigger daily:** Gas sensor alerts (CO2, VOCs in poorly ventilated rooms). Most people have no idea their rooms have bad air.

## Material Identification (Probably the Best Feature)

| Use Case | Sensor | Why It Matters |
|----------|--------|---------------|
| "That pill is ibuprofen 400mg" | Spectrometer (AS7341) | Verify medication without reading tiny labels |
| "That food is starting to spoil" | Spectrometer + Gas | Detect before you can smell or see it |
| "That paint contains lead" | Spectrometer | Old buildings, children's toys |
| "This water has unusual composition" | Spectrometer | Travel safety |
| "That fabric is polyester, not silk" | Spectrometer | Shopping, authenticity |
| "That's fake gold" | Spectrometer | Material verification |

**This is the killer feature.** Identifying what something IS made of without touching it, instantly, all the time. Nobody has this ability today outside of a lab.

## Health Monitoring

| Use Case | Sensor | Why It Matters |
|----------|--------|---------------|
| "Heart rate spiked to 140, sustained 20 min" | Heart rate (MAX30102) | Cardiac health, stress monitoring |
| "Skin conductance suggests anxiety — try breathing" | GSR | Mental health awareness |
| "Room is 31°C, 80% humidity — dehydration risk" | Temp/Humidity (BME688) | Environmental health |
| "CO2 at 1200ppm — you're drowsy from bad air, not tired" | Air quality (SGP40) | **This one is huge** — most people blame themselves for feeling tired when it's literally the room |

## Navigation & Spatial

| Use Case | Sensor | Why It Matters |
|----------|--------|---------------|
| "342m elevation, pressure dropping — storm in 2-3 hours" | Barometer (BME688) | Weather prediction without internet |
| "North is that direction" | Magnetometer (QMC5883L) | Always-on compass |
| "Object 1.2m to your left" | Proximity (VL53L0X) / Ultrasonic | Useful in dark, for visually impaired |
| "Walking 4.2 km/h, 3.7 km today" | Accelerometer + GPS | Fitness without a watch |

## Environmental Awareness

| Use Case | Sensor | Why It Matters |
|----------|--------|---------------|
| "Someone nearby is stressed" | Gas (cortisol metabolites) | Social awareness beyond visual cues |
| "Your dog is anxious" | Gas (anal gland VOCs) | Cross-species communication |
| "WiFi network here, strong signal" | EMF | Network awareness |
| "Magnetic anomaly — metal underground" | Magnetometer | Finding buried objects/pipes |
| "Vibration = heavy machinery nearby" | Accelerometer | Situational awareness |
| "Ultrasonic source at 23kHz — pest deterrent" | Ultrasonic | Hear the unhearable |

## The Invisible World

| Use Case | Sensor | Why It Matters |
|----------|--------|---------------|
| "UV fluorescence on this surface — biological residue" | UV | Permanent CSI blacklight |
| "Someone sat in that chair recently" | IR thermal (MLX90640) | See heat traces |
| "Heat leak from that wall — bad insulation" | IR thermal | Save money on heating |
| "Magnetic field distorted — large metal behind wall" | Magnetometer | See through walls (partially) |
| "Background radiation normal" / "elevated" | Geiger | Peace of mind or early warning |

## Medical / Surgical Applications

Current operating rooms monitor anesthetic gas levels and exhaled CO2, but they do NOT have comprehensive gas sensor arrays analyzing the surgical site.

Research shows:
- Infected tissue produces different volatile compounds than healthy tissue
- Cancerous tissue has a distinct chemical signature
- Necrotic tissue off-gasses specific compounds

A gas sensor array pointed at an open surgical site could theoretically:
- "Cancerous tissue still present — you missed a margin"
- "Early signs of infection at incision site"
- "Tissue viability is declining in this area"

This is active research but not yet in clinical use. PAM-style sensing in surgery could provide data surgeons currently cannot access.

## V2 Hardware Notes

### What fits inside the pendant (18 sensors):
All sensors 2-3mm chip size, stackable on one PCB. Adds ~15g to pendant weight.

### What needs external mounting (4 sensors):
| Sensor | Size | V2 Solution |
|--------|------|-------------|
| IR thermal camera (MLX90640) | 16x12mm | Side of pendant, or shoulder gimbal |
| Ultrasonic (RCWL-1601) | 20x15mm | Top or side of pendant, needs air exposure |
| Radiation tube (RadSens/SBM-20) | 10x50mm | Side mount or shoulder unit |
| pH sensor | Probe + module | Skip — spectrometer partially replaces |

### Dual camera approach:
The ESP32-S3 has one camera interface. For visible + thermal:
- OV2640/OV3660 for visible photos (existing)
- FLIR Lepton for thermal imaging via SPI (separate interface)
- Alternate between them, or dedicate thermal to shoulder gimbal unit

Some combo visible+thermal cameras exist but are expensive and not ESP32-native.

### Heart rate through the case:
MAX30102 uses infrared light through skin. Needs direct skin contact — small window/cutout in the 3D case back where sensor touches chest. Works perfectly since PAM is magnetically mounted against your body.

### The MVP sensor for V2:
**BME688** — one $15 chip that combines gas detection + temperature + humidity + barometric pressure. Four sensor categories in a 3x3mm package. This single chip is the highest value addition after camera and mic.

## Sensor Shopping List for V2 (~€300-350 total)

| Sensor | Part | Source | Price |
|--------|------|--------|-------|
| Gas + Temp + Humidity + Pressure (4-in-1) | BME688 | Berrybase/Adafruit | €15 |
| UV | LTR390 | AliExpress | €3 |
| IR Thermal Camera | MLX90640 | Berrybase/Mouser | €40-60 |
| Magnetometer | QMC5883L | AliExpress | €2 |
| Air Quality (VOC) | SGP40 | Berrybase | €8 |
| Spectrometer (11-channel) | AS7341 | Adafruit/Mouser | €15 |
| Accelerometer + Gyroscope | BMI270 | AliExpress | €5 |
| Ultrasonic Distance | RCWL-1601 | AliExpress | €2 |
| EMF | AD8317 | AliExpress | €3 |
| Radiation | RadSens | Specialty | €30 |
| Heart Rate + SpO2 | MAX30102 | AliExpress/Berrybase | €3 |
| Ambient Light | BH1750 | AliExpress | €2 |
| Color | TCS34725 | Adafruit | €5 |
| Laser Distance (ToF) | VL53L0X | AliExpress | €3 |
| Thermal Camera (high-end) | FLIR Lepton | Mouser/GroupGets | €150-200 |
| GSR (skin conductance) | GSR module | AliExpress | €3 |
| GPS | Seeed GNSS L76K | Berrybase | €13 |

**Budget V2 (skip FLIR Lepton):** ~€120
**Full V2 (everything):** ~€300-350
