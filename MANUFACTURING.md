# PAM — Manufacturing Origins & Sensor Industry

## Who Makes What

The sensor industry has a clear geographic split: **Europe designs the sensors, China builds the computing platform, China does the assembly.** Nobody really talks about this, but Europe is quietly dominant in sensor technology.

### The Brain — Chinese
| Component | Company | HQ | Role |
|-----------|---------|-----|------|
| ESP32-S3 chip | **Espressif Systems** | Shanghai, China | Designs and manufactures the actual silicon — the processor, WiFi, Bluetooth |
| XIAO board | **Seeed Studio** | Shenzhen, China | Takes Espressif's chip, puts it on a nice board with camera, mic, USB-C, antenna |

Espressif owns the ESP32 entirely — nobody else makes it. It's their chip, their design, their fabrication. The ESP32 has become the de facto standard for IoT because it's powerful, cheap (~€3 for the raw module), and has WiFi + Bluetooth built in.

### The Sensors — Mostly European

| Sensor | Company | HQ | What They Make |
|--------|---------|-----|---------------|
| Gas + Temp + Humidity + Pressure (BME688) | **Bosch Sensortec** | Reutlingen, Germany | The most important sensor IC maker in the world. Car sensors, phone sensors, environmental sensors. |
| Accelerometer + Gyroscope (BMI270) | **Bosch Sensortec** | Reutlingen, Germany | Motion sensing — in every phone, car, drone |
| Air Quality VOC (SGP40) | **Sensirion** | Stäfa, Switzerland | World leader in environmental sensors |
| Humidity/Temp (SHT40) | **Sensirion** | Stäfa, Switzerland | Highest precision humidity sensors made |
| Spectrometer (AS7341) | **ams-OSRAM** | Premstätten, Austria | 11-channel spectral sensing — Austrian innovation |
| Ambient Light sensors | **ams-OSRAM** | Premstätten, Austria | In most smartphones |
| Thermal Camera (MLX90640) | **Melexis** | Ieper, Belgium | Belgian company — thermal sensing for automotive and industrial |
| Thermal Camera high-end (FLIR Lepton) | **FLIR / Teledyne** | Wilsonville, Oregon, USA | American — military/industrial thermal imaging miniaturized |

### The Sensor ICs — American

| Sensor | Company | HQ | What They Make |
|--------|---------|-----|---------------|
| Speaker Amp (MAX98357A) | **Analog Devices / Maxim** | Wilmington, Massachusetts, USA | Audio amplifier ICs |
| Heart Rate (MAX30102) | **Analog Devices / Maxim** | USA | Optical pulse oximetry |
| Various sensor ICs | **Texas Instruments** | Dallas, Texas, USA | Broad semiconductor portfolio |

### Mixed / Other

| Component | Company | HQ |
|-----------|---------|-----|
| Accelerometers, gyroscopes (alternative) | **STMicroelectronics** | Geneva, Switzerland / Crolles, France / Catania, Italy |
| Magnetometer (QMC5883L) | **QST Corporation** | Shanghai, China |
| Camera sensor (OV2640) | **OmniVision** | Santa Clara, California, USA (Chinese-owned since 2015) |
| UV sensor (LTR390) | **Lite-On** | Taipei, Taiwan |
| Laser distance (VL53L0X) | **STMicroelectronics** | Switzerland/France/Italy |

### Arduino — The Misunderstood Brand
**Arduino SRL** is Italian — founded in Ivrea, Italy in 2005. But Arduino is really a **software platform and standard**, not a hardware manufacturer. The Arduino IDE, the programming framework, the pin layout conventions — that's the Italian contribution. The actual boards are manufactured in both Italy and China. When people say "Arduino" they usually mean the software ecosystem, not a specific piece of hardware.

## Geographic Summary

| Region | Role in PAM | Key Companies |
|--------|-------------|---------------|
| **China** | Computing platform (ESP32), board assembly, manufacturing | Espressif, Seeed Studio, QST |
| **Germany** | Environmental and motion sensors | Bosch Sensortec |
| **Switzerland** | Air quality, humidity, precision sensing | Sensirion, STMicro (partial) |
| **Austria** | Spectral sensing, light sensors | ams-OSRAM |
| **Belgium** | Thermal imaging | Melexis |
| **France/Italy** | Motion sensors, laser distance | STMicroelectronics |
| **USA** | Audio ICs, heart rate, thermal cameras, camera sensors | Analog Devices, TI, FLIR, OmniVision |
| **Taiwan** | UV and light sensors | Lite-On |
| **Italy** | Arduino software ecosystem | Arduino SRL |

## The Insight
PAM is genuinely international:
- **European sensors** detect the world (Germany, Switzerland, Austria, Belgium, France)
- **American ICs** process audio and health data (Analog Devices, TI)
- **Chinese computing** runs everything and connects it all (Espressif, Seeed)
- **Italian software** provides the programming framework (Arduino)

The real innovation in miniaturized sensing is European. China provides the cheap, powerful computing platform. America provides specialized analog/mixed-signal ICs. Together they make PAM possible at €65-75 retail.

## Cost at Scale

| Component | Retail (1 unit) | At Scale (1000+ units) |
|-----------|----------------|----------------------|
| ESP32-S3 module (raw, not Seeed board) | €8-15 | ~€3 |
| All pendant sensors on custom PCB | €80-120 | ~€40-50 |
| 1.69" LCD screen | €8-10 | ~€4 |
| Battery 1000mAh | €5-8 | ~€3 |
| Speaker + MAX98357A amp | €5-8 | ~€2 |
| Case (injection molded) | €5 (3D printed) | ~€1-2 |
| PCB manufacturing + assembly | N/A | ~€5-10 |
| **Total BOM** | **~€130 (V2 full sensors)** | **~€55-70** |
| **Retail at cost** | — | **€75-85** |
| **Includes:** | 15+ superhuman sensors, camera, mic, speaker, screen, battery, AI pendant | |

Selling at €75-85 covers parts, assembly, packaging, shipping, and a small buffer for returns/defects. No profit margin. A genuine at-cost device to help people.

For comparison:
- Limitless Pendant (audio only, no camera, no sensors): $99
- Humane AI Pin (fewer sensors, failed product): $699
- Apple Watch (fewer sensors): $399
- PAM fully loaded: €75-85

Nothing competes at this price point because nobody else is building for cost rather than profit.
