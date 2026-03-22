# PAN Sensor Catalog

Complete list of known sensing modalities, categorized by size and feasibility for wearable integration.

## Human Senses (True External Sensors)
These detect stimuli from the external environment:

| # | Sense | What It Detects |
|---|-------|----------------|
| 1 | Vision | Electromagnetic radiation (visible light, ~380-700nm) |
| 2 | Hearing | Sound pressure waves (~20Hz-20kHz) |
| 3 | Smell (olfaction) | Airborne chemical molecules |
| 4 | Taste (gustation) | Chemical composition of substances (sweet, sour, salt, bitter, umami) |
| 5 | Touch (pressure) | Mechanical pressure on skin |
| 6 | Temperature (thermoception) | Heat and cold |
| 7 | Pain (nociception) | Tissue damage / harmful stimuli |
| 8 | Balance (vestibular) | Gravitational orientation, acceleration |
| 9 | Proprioception | Body position, limb location in space |
| 10 | Vibration | Mechanical oscillations (via Pacinian corpuscles) |
| 11 | Spatial awareness | 3D positioning relative to environment |

**Debatable / internal state (NOT true external sensors):**
- Time perception — memory/pattern recognition, not a sensor
- Hunger — internal hormone signaling (ghrelin), not external detection
- Thirst — internal osmotic balance monitoring
- Fatigue — internal energy state
- Itch — variant of pain/touch response

## Sensors That Fit in PAN Pandant
Small enough (fingernail to coin sized), runs on 3.3-5V, ESP32 compatible:

| # | Sensor | Module | Detects | Size | Beyond Human? |
|---|--------|--------|---------|------|---------------|
| 1 | Camera (OV2640/OV3660) | Built into XIAO | Visible light, photos | Tiny | No (but perfect recall) |
| 2 | Microphone (PDM) | Built into XIAO | Sound/audio | Tiny | No (but always recording) |
| 3 | Gas sensor (MQ series / BME688) | BME688 | VOCs, CO, methane, hundreds of compounds | 3x3mm | YES — closer to dog's nose |
| 4 | UV sensor (GUVA-S12SD / LTR390) | LTR390 | Ultraviolet light intensity | 2x2mm | YES — invisible to humans |
| 5 | IR thermal sensor (MLX90640) | MLX90640 | Heat signatures, thermal imaging | 16x12mm | YES — like a snake's pit organ |
| 6 | Magnetometer (LIS3MDL / QMC5883) | QMC5883L | Magnetic field direction/strength | 3x3mm | YES — like migratory birds |
| 7 | Barometric pressure (BMP390 / BME280) | BME280 | Air pressure, altitude, weather changes | 2.5x2.5mm | YES — more precise than any animal |
| 8 | Air quality (SGP40 / SCD41) | SGP40 | VOCs, CO2 levels, indoor air quality | 2.4x2.4mm | YES — invisible to humans |
| 9 | Spectrometer (AS7341) | AS7341 | 11 light wavelength channels (spectral analysis) | 3.1x2mm | YES — identifies materials by light |
| 10 | Accelerometer + Gyroscope (BMI270 / LSM6DSO) | BMI270 | Motion, rotation, vibration, orientation | 2.5x3mm | Matches human vestibular |
| 11 | Temperature + Humidity (SHT40 / AHT20) | SHT40 | Ambient temp and humidity | 1.5x1.5mm | More precise than human |
| 12 | Ultrasonic (RCWL-1601) | RCWL-1601 | Distance via echolocation | 20x15mm | YES — like bats |
| 13 | EMF sensor (AD8317) | AD8317 | Electromagnetic field strength | Small module | YES — no animal has this |
| 14 | Radiation (RadSens / SBM-20) | RadSens | Ionizing radiation (gamma, beta) | 10x50mm (tube) | YES — no animal has this |
| 15 | Heart rate / SpO2 (MAX30102) | MAX30102 | Pulse, blood oxygen (on chest contact) | 5.6x3.3mm | Self-monitoring |
| 16 | GSR (skin conductance) | GSR module | Stress, emotional arousal, sweat response | Small module | Self-monitoring |
| 17 | GPS (L76K / NEO-6M) | Seeed GNSS module | Global position, speed, direction | Small module | YES — precise coordinates |
| 18 | Ambient light (BH1750 / TSL2591) | BH1750 | Light intensity in lux | 2x2mm | More precise than human |
| 19 | Color sensor (TCS34725) | TCS34725 | Precise RGB color values | 2x2.4mm | More precise than human |
| 20 | Proximity sensor (VL53L0X) | VL53L0X | Precise distance to objects (laser ToF) | 4.4x2.4mm | YES — laser precision |
| 21 | Sound level (MAX4466) | MAX4466 | Decibel measurement | Small module | More precise than human |
| 22 | Soil/liquid pH (PH-4502C) | PH-4502C | Acidity/alkalinity of liquids | Probe + module | YES — no human equivalent |

**Total Pandant-compatible sensors: 22**
**Beyond human capability: 15 of 22**

## Sensors That Exist But DON'T Fit in Pandant
Too large, need dedicated power, or require specialized equipment:

| # | Sensor | Size | What It Detects |
|---|--------|------|----------------|
| 23 | LIDAR (TF-Luna small, others large) | Varies (some small enough) | 3D spatial mapping with lasers |
| 24 | Mass spectrometer | Backpack to lab-sized | Exact molecular composition of anything |
| 25 | X-ray imaging | Machine-sized | See through solid objects |
| 26 | CT scanner | Room-sized | 3D internal structure of objects |
| 27 | MRI | Room-sized | Soft tissue imaging via magnetic resonance |
| 28 | Electron microscope | Room-sized | Atomic-level surface imaging |
| 29 | Telescope (optical/radio) | Building-sized | Deep space observation |
| 30 | Seismometer | Box-sized | Earthquakes, ground vibration |
| 31 | Sonar array | Submarine-sized | Underwater 3D mapping |
| 32 | Ground penetrating radar | Cart-sized | Underground structures |
| 33 | Hyperspectral camera | Drone/satellite-mounted | Hundreds of light wavelengths simultaneously |
| 34 | Radio telescope | Building to km-sized | Radio waves from space |
| 35 | Particle detector | Building-sized (CERN) | Subatomic particles |
| 36 | Gravitational wave detector | Kilometers (LIGO) | Spacetime distortions |
| 37 | Neutrino detector | Underground tank | Neutrinos |
| 38 | DNA sequencer (MinION is small!) | Phone-sized (Oxford Nanopore) | Genetic code sequences |
| 39 | Chromatograph (gas/liquid) | Bench-sized | Separates and identifies chemical mixtures |
| 40 | Acoustic emission sensor | Module-sized | Stress fractures in materials |
| 41 | Interferometer | Bench-sized | Distances to nanometer precision |
| 42 | Magnetoencephalography (MEG) | Room-sized | Brain magnetic field mapping |
| 43 | Weather/Doppler radar | Building-sized | Storm tracking, precipitation |
| 44 | Nuclear magnetic resonance (NMR) | Bench to room-sized | Molecular structure analysis |
| 45 | Terahertz imaging | Lab equipment | See through clothing/packaging (security) |
| 46 | Gravitometer | Bench-sized | Local gravitational field variations |
| 47 | Magnetotelluric sensor | Field equipment | Earth's electromagnetic fields (geology) |
| 48 | Hydrophone | Underwater deployment | Underwater sound |
| 49 | Scintillation detector | Box-sized | Specific radiation types |
| 50 | Flux gate magnetometer | Bench-sized | Ultra-precise magnetic field measurement |

**Total known sensing modalities: ~50**
**Fit in Pandant: 22**
**Beyond human capability: 15 Pandant-sized + all 28 large ones = 43 out of 50**

## The Numbers

**Sensor categories vs specific sensors:**
The ~50 number represents **distinct sensing modalities** — categories of what you're detecting. Within each category there are hundreds or thousands of specific sensor implementations. For example, "camera" is one modality but there are thousands of different image sensors. "Gas detection" is one modality but there are hundreds of sensors for different chemical compounds (MQ-2 for methane, MQ-3 for alcohol, MQ-7 for CO, etc). If you count every specific sensor variant ever manufactured, the number is in the **tens of thousands**. But they all fall into roughly 50-70 categories of "what type of thing are you detecting."

The 50 listed here covers every commercially available sensing category. There are likely more in exotic physics labs, classified military applications, and experimental research — potentially pushing the total to 60-70 distinct modalities.

**Fundamental sensing dimensions:**
- Humans sense ~4 fundamental things: electromagnetic radiation (light), mechanical waves (sound/touch/balance), chemicals (smell/taste), and gravity
- A fully loaded PAN Pandant senses those same 4 plus: ionizing radiation, magnetic fields, electrical fields, spectral composition, ultrasonic, and precise geolocation — roughly **8-10 fundamental dimensions**
- The large/lab sensors add: subatomic particles, gravitational waves, molecular structure, genetic code — pushing to ~15 fundamental dimensions

## Summary
- Humans have ~11 true external senses (4 fundamental dimensions)
- PAN v1 has 2 sensors (camera + mic) — arrives March 18-20
- PAN fully loaded could have 22 sensors — all wearable on chest (8-10 fundamental dimensions)
- Total known sensing categories: ~50-70
- Total specific sensor implementations: tens of thousands
- Sensors that exceed human capability: 43 out of ~50 categories
- A fully loaded PAN Pandant: 22 out of ~50-70 categories, superhuman in 15 of them
