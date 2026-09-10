# Pendant firmware (Seeed XIAO ESP32-S3 Sense)

Camera frames over BLE to the phone, which uploads them to `/api/v1/photo`.
The Android side is `android/app/src/main/java/dev/pan/app/ble/PendantBle.kt`
and the wire protocol must stay in lockstep with it.

## Build and flash

```
arduino-cli compile --fqbn "esp32:esp32:XIAO_ESP32S3:PSRAM=opi,PartitionScheme=max_app_8MB" -u -p COM5 firmware/pendant
```

`PartitionScheme=max_app_8MB` is required; `huge_app` is not a valid value for
this board. `PSRAM=opi` is required or an SVGA framebuffer will not allocate.

## Measured configuration (2026-09-08, Pixel 10 Pro)

| setting | value | why |
|---|---|---|
| frame size | QVGA 320x240 | SVGA needs 120ms pacing to arrive intact, which is 5.8s of transmit against a 5s cadence: the radio never turns off |
| pacing | 15ms | at QVGA the link delivers at every pacing tested |
| CPU idle | 80MHz | free: active time unchanged at ~366ms, BLE unaffected |
| camera power-down | OFF | costs 526ms extra active time per frame; the saving is unmeasured |

Per frame at these settings: ~5.2KB, 12 packets, `tx_ms` 165, `total_ms` 366,
so roughly a 7% radio duty cycle at one frame every 5s.

## Traps

- A GATT characteristic value maxes at **512 bytes** regardless of MTU. At MTU
  517 the "MTU minus 3" rule suggests 514, the board reports sending every
  packet, and the peer receives **nothing**.
- `fb_count=2` + `CAMERA_GRAB_LATEST` makes the driver free-run forever,
  spewing `cam_hal: FB-OVF` and starving the BLE task. Use `fb_count=1` +
  `CAMERA_GRAB_WHEN_EMPTY`.
- Warm-up frames must be discarded or captures return a **stale buffer**. The
  tell is `cap_us` near zero; a real QVGA read is ~72,000us.
- `esp_pm_configure` returns `ESP_ERR_NOT_SUPPORTED`: the Arduino core ships
  precompiled IDF libraries built without `CONFIG_PM_ENABLE`, so automatic
  light sleep needs a custom core build. Do not retry it expecting success.

## Measured power (2026-09-10, USB inline meter)

Board idle: powered, BLE advertising, NOT connected, CPU at 80MHz. This is the
state it is in ~93% of the time, so it dominates battery life.

| state | current @ 5.3V |
|---|---|
| camera clocked (`powerDownCamera = false`, default) | 140 mA |
| camera released (`powerDownCamera = true`) | 146 mA |

**Releasing the camera saves nothing**, because `PWDN_GPIO_NUM` is `-1` on this
board: the sensor's power-down pin is not wired, so `esp_camera_deinit()` stops
the XCLK but leaves the OV2640 powered. `powerDownCamera` therefore stays OFF
permanently; it costs 526ms of extra active time per frame for no saving. Turning
the sensor off here needs a MOSFET on its supply rail, not software.

~140mA idle is far above a bare ESP32-S3 advertising over BLE (published figures
are ~30-50mA), so most of it is the Sense expansion board: the permanently
powered camera plus OPI PSRAM.

Implication: roughly 4 to 5 hours on a 1020mAh cell, ~3 hours on 700mAh. All-day
runtime is NOT reachable on a pendant-sized cell with this architecture.

The remaining levers, largest first: light sleep (needs a custom Arduino core,
see the traps above), a hardware switch on the camera supply, a longer BLE
advertising interval, or accepting ~4 hours and hot-swapping cells.
