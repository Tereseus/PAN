// XIAO ESP32-S3 Sense — camera frames over BLE.
//
// WHY BLE AND NOT WI-FI: the pendant runs off a cell small enough to fit in a
// gutted earbud case. Wi-Fi TX bursts are the single largest draw on this board;
// BLE is roughly an order of magnitude cheaper for the same duty cycle, and the
// destination is the phone in his pocket, not an access point. The ESP32-S3 has
// BT 5 (LE) only, no Bluetooth Classic, so no SPP and no A2DP. Everything here
// is GATT notifications.
//
// PROTOCOL (IMG characteristic, notify):
//   every packet is  [uint16 seq big-endian][payload]
//   seq 0    payload = "PANF" + uint32 len + uint16 w + uint16 h   (12 bytes)
//   seq 1..N payload = raw JPEG bytes, in order
// The sequence number is not decoration. BLE notifications are unacknowledged
// and the controller drops them silently once its buffers fill, so without a
// seq the host cannot tell a slow link from a lossy one, and a throughput
// number measured over a lossy link is a lie.
//
// CONTROL characteristic (write):
//   'c'  capture and send one frame now
//   's'  start periodic capture
//   'x'  stop periodic capture
//   '0'-'9'      period in seconds (0 means as fast as it will go)
//   'q'/'m'/'h'  frame size QVGA / SVGA / HD, applied on the next capture

#include "esp_camera.h"
#include "mbedtls/base64.h"
#include "esp_pm.h"
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

// Seeed XIAO ESP32-S3 Sense camera pinout.
#define PWDN_GPIO_NUM  -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM  10
#define SIOD_GPIO_NUM  40
#define SIOC_GPIO_NUM  39
#define Y9_GPIO_NUM    48
#define Y8_GPIO_NUM    11
#define Y7_GPIO_NUM    12
#define Y6_GPIO_NUM    14
#define Y5_GPIO_NUM    16
#define Y4_GPIO_NUM    18
#define Y3_GPIO_NUM    17
#define Y2_GPIO_NUM    15
#define VSYNC_GPIO_NUM 38
#define HREF_GPIO_NUM  47
#define PCLK_GPIO_NUM  13

// Random UUIDs generated for this project so nothing else claims them.
#define SVC_UUID "6e2a0001-b5a3-f393-e0a9-e50e24dcca9e"
#define IMG_UUID "6e2a0002-b5a3-f393-e0a9-e50e24dcca9e"
#define CTL_UUID "6e2a0003-b5a3-f393-e0a9-e50e24dcca9e"

static BLECharacteristic *imgChar = nullptr;
static BLEServer *server = nullptr;
static volatile bool connected = false;
static volatile uint16_t negotiatedMtu = 23;   // BLE default until the host raises it

static volatile bool captureNow = false;
static volatile bool periodic = false;
static volatile uint32_t periodMs = 5000;      // his stated cadence, one frame every 5s
static volatile uint32_t gapMs = 3;            // inter-packet pacing, swept from the host
static framesize_t wantSize = FRAMESIZE_SVGA;
static framesize_t haveSize = FRAMESIZE_SVGA;
/** Whether the camera driver is currently initialised. See stopCamera(). */
static bool camReady = false;

/**
 * Release the camera between frames? DEFAULT OFF, on purpose.
 *
 * MEASURED 2026-09-08, and it is not the free win it looks like. Deinit stops
 * the 20MHz XCLK for the ~4.6s the pendant is idle, but re-initialising the
 * sensor and re-running auto-exposure costs 526ms of EXTRA ACTIVE time on the
 * next frame: total_ms went 360 -> 886, taking the duty cycle from 7.2% to
 * 17.7%.
 *
 * MEASURED AND SETTLED 2026-09-10. Board idle, advertising, not connected,
 * only this flag changed:
 *     camera clocked   140 mA @ 5.3V
 *     camera released  146 mA @ 5.3V
 * No saving at all. The reason is hardware: PWDN_GPIO_NUM is -1 on the XIAO
 * Sense, so the camera's power-down pin is NOT WIRED. esp_camera_deinit() stops
 * the 20MHz XCLK but leaves the OV2640 powered, so there is nothing to reclaim.
 *
 * Therefore this stays OFF permanently: it costs 526ms of extra active time per
 * frame and buys nothing. Do not re-enable it hoping for a power win. Turning
 * the sensor off on this board needs a MOSFET on its supply rail, not software.
 */
static bool powerDownCamera = false;

// CPU frequency, in MHz.
//
// The ESP32-S3 runs at 240MHz by default and stays there, which is wasted for a
// device that is idle ~93% of the time. It drops to CPU_IDLE_MHZ between frames
// and steps up to CPU_BUSY_MHZ only for the capture-and-transmit burst, where
// JPEG encoding and BLE throughput actually benefit from the clock.
//
// 80MHz is the floor here, not 40: BLE needs the higher-frequency clock source
// to keep servicing connection events, and dropping below it loses the link.
static const uint32_t CPU_BUSY_MHZ = 240;
static const uint32_t CPU_IDLE_MHZ = 80;
static int wantQuality = 12;
static int haveQuality = 12;

class SrvCB : public BLEServerCallbacks {
  void onConnect(BLEServer *s) override {
    connected = true;
    Serial.println("BLE_CONNECTED");
  }
  void onDisconnect(BLEServer *s) override {
    connected = false;
    periodic = false;
    negotiatedMtu = 23;
    Serial.println("BLE_DISCONNECTED");
    s->startAdvertising();
  }
  // NOTE: onMtuChanged is deliberately NOT overridden. Its signature differs
  // between the Bluedroid and NimBLE builds of this core (esp_ble_gatts_cb_param_t
  // vs ble_gap_conn_desc) and both declarations sit behind config guards, so a
  // sketch that overrides it only compiles against one of the two. getPeerMTU()
  // is declared unconditionally, so the MTU is polled at frame time instead.
};

// Commands are parsed as a tiny text protocol rather than single characters so
// the pacing delay and JPEG quality can be swept from the host without a
// reflash. Finding the loss knee takes a dozen runs; reflashing for each one
// would make measuring it not worth doing, which is how magic constants end up
// in firmware unmeasured.
class CtlCB : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    String v = c->getValue();
    for (size_t i = 0; i < v.length(); i++) {
      char ch = v[i];
      if (ch == 'c') { captureNow = true; }
      else if (ch == 's') { periodic = true; }
      else if (ch == 'x') { periodic = false; }
      else if (ch == 'q') { wantSize = FRAMESIZE_QVGA; }
      else if (ch == 'm') { wantSize = FRAMESIZE_SVGA; }
      else if (ch == 'h') { wantSize = FRAMESIZE_HD; }
      else if (ch == 'd' || ch == 'p' || ch == 'j') {
        uint32_t n = 0; size_t k = i + 1; bool any = false;
        while (k < v.length() && v[k] >= '0' && v[k] <= '9') { n = n * 10 + (v[k] - '0'); k++; any = true; }
        if (any) {
          if (ch == 'd') gapMs = n;
          else if (ch == 'p') periodMs = n * 1000UL;
          else { wantQuality = (int)n; }
          i = k - 1;
        }
      }
    }
    Serial.printf("CTL periodic=%d periodMs=%u gapMs=%u size=%d q=%d\n",
                  (int)periodic, (unsigned)periodMs, (unsigned)gapMs,
                  (int)wantSize, wantQuality);
  }
};

static bool startCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer   = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;  c.pin_d1 = Y3_GPIO_NUM;
  c.pin_d2 = Y4_GPIO_NUM;  c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;  c.pin_d5 = Y7_GPIO_NUM;
  c.pin_d6 = Y8_GPIO_NUM;  c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;
  c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM;
  c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM;
  c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  // Init at the size we actually want, not a fixed SVGA. The camera is now
  // deinitialised between frames to save power, so this runs repeatedly;
  // hardcoding SVGA here would silently undo the QVGA setting on every
  // re-init while haveSize still claimed QVGA was applied.
  c.frame_size = wantSize;
  c.jpeg_quality = 12;
  // fb_count 1 + GRAB_WHEN_EMPTY: capture ON DEMAND, not continuously.
  //
  // With fb_count 2 and GRAB_LATEST the driver free-runs, capturing frames
  // forever whether or not anyone wants one. On the bench that showed up as a
  // stream of "cam_hal: FB-OVF" (buffers overflowing because nothing drains
  // them) and it destabilised the BLE link by starving the radio task. On a
  // battery it is worse than a bug: the sensor and the JPEG path would be
  // running flat out between shots, which for a pendant that wants ONE frame
  // every five seconds is nearly all of its power spent on frames nobody sees.
  c.fb_count = 1;
  c.fb_location = CAMERA_FB_IN_PSRAM;
  c.grab_mode = CAMERA_GRAB_WHEN_EMPTY;

  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) { Serial.printf("CAM_INIT_FAIL 0x%x\n", err); return false; }
  // A fresh init starts at the config's size and default quality, so the
  // "have" state must match or the change-detection below never re-applies.
  haveSize = wantSize;
  haveQuality = 12;
  if (wantQuality != haveQuality) {
    sensor_t *s = esp_camera_sensor_get();
    if (s && s->set_quality(s, wantQuality) == 0) haveQuality = wantQuality;
  }
  camReady = true;
  return true;
}

/**
 * Release the camera between frames.
 *
 * The OV2640 has no PWDN pin wired on the XIAO Sense (PWDN_GPIO_NUM is -1), so
 * there is no hardware power-down to assert. Deinit is the only way to stop the
 * driver's 20MHz XCLK, which otherwise runs continuously whether or not anyone
 * wants a picture. With a frame every 5s that clock was live for ~93% of the
 * pendant's life for no reason.
 *
 * The cost is a re-init on the next capture, which is not free, so total_ms per
 * frame is the number to watch after this change.
 */
static void stopCamera() {
  if (!powerDownCamera) return;
  if (!camReady) return;
  esp_camera_deinit();
  camReady = false;
}

// Pacing is the whole problem here. notify() is fire and forget, so pushing a
// 22KB frame at the stack as fast as the CPU can loop simply overruns the
// controller buffers and the far end sees holes. The delay below is a starting
// point to be tuned against measured loss, not a value to trust on sight.
/** Restore the idle power state. Every exit from sendFrame must go through this
 *  or the board silently stays at 240MHz with the camera clocked, which is the
 *  exact condition this change exists to end. */
static void goIdle() {
  stopCamera();
  setCpuFrequencyMhz(CPU_IDLE_MHZ);
}

static void sendFrame() {
  uint32_t t0 = millis();
  setCpuFrequencyMhz(CPU_BUSY_MHZ);
  if (!camReady && !startCamera()) { Serial.println("CAM_REINIT_FAIL"); goIdle(); return; }

  if (wantSize != haveSize || wantQuality != haveQuality) {
    sensor_t *s = esp_camera_sensor_get();
    if (s) {
      if (wantSize != haveSize && s->set_framesize(s, wantSize) == 0) haveSize = wantSize;
      if (wantQuality != haveQuality && s->set_quality(s, wantQuality) == 0) haveQuality = wantQuality;
      delay(200);   // let the sensor settle after a mode change
    }
  }

  // DISCARD STALE FRAMES BEFORE THE REAL ONE.
  //
  // Dropped from the USB sketch by accident and it produced a convincing lie:
  // the board returned a buffered frame from an earlier scene, the transfer
  // succeeded, the JPEG was valid, and the picture was simply of the wrong
  // moment. The tell was in the log the whole time. cap_ms=1 cannot be a real
  // SVGA capture; the OV2640 needs tens of milliseconds to read a frame out, so
  // a 1ms "capture" is the driver handing back what was already in the buffer.
  // Timing is in micros() now precisely because millis() was too coarse to make
  // that obvious.
  uint32_t tWarm = micros();
  for (int i = 0; i < 3; i++) {
    camera_fb_t *stale = esp_camera_fb_get();
    if (stale) esp_camera_fb_return(stale);
  }
  uint32_t warmUs = micros() - tWarm;

  uint32_t tGet = micros();
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) { Serial.println("CAPTURE_FAIL"); goIdle(); return; }
  uint32_t capUs = micros() - tGet;
  uint32_t tCap = millis();

  // Poll rather than cache: the peer can raise the MTU after the connection is
  // already up, and a stale 23 here would silently cap throughput at 18 bytes
  // per packet while everything still appeared to work.
  uint16_t mtu = server->getPeerMTU(server->getConnId());
  if (mtu < 23) mtu = 23;
  negotiatedMtu = mtu;
  // TWO independent ceilings, and missing the second one costs you every packet:
  //   MTU - 3   ATT notification overhead
  //   512       the BLE spec's maximum ATTRIBUTE VALUE length, which does NOT
  //             grow with the MTU. At MTU 517 the first limit says 514, so a
  //             514 byte packet looks legal and the board reports sending it,
  //             but the stack refuses anything over 512 and the peer receives
  //             nothing. Measured 2026-09-07: 49 of 49 packets vanished this
  //             way while the 14 byte header arrived fine.
  // Then subtract our own 2 byte sequence number.
  uint16_t maxAtt = (uint16_t)(mtu - 3);
  if (maxAtt > 512) maxAtt = 512;
  const uint16_t chunk = (maxAtt > 4) ? (uint16_t)(maxAtt - 2) : 15;

  uint8_t hdr[2 + 12];
  hdr[0] = 0; hdr[1] = 0;
  memcpy(hdr + 2, "PANF", 4);
  uint32_t len = fb->len;
  hdr[6]  = (len >> 24) & 0xFF; hdr[7]  = (len >> 16) & 0xFF;
  hdr[8]  = (len >> 8) & 0xFF;  hdr[9]  = len & 0xFF;
  hdr[10] = (fb->width >> 8) & 0xFF;  hdr[11] = fb->width & 0xFF;
  hdr[12] = (fb->height >> 8) & 0xFF; hdr[13] = fb->height & 0xFF;
  imgChar->setValue(hdr, sizeof(hdr));
  imgChar->notify();

  uint8_t *pkt = (uint8_t *)malloc(chunk + 2);
  if (!pkt) { Serial.println("ALLOC_FAIL"); esp_camera_fb_return(fb); goIdle(); return; }

  uint16_t seq = 1;
  for (uint32_t off = 0; off < len; off += chunk) {
    if (!connected) break;
    uint16_t n = (len - off) < chunk ? (uint16_t)(len - off) : chunk;
    pkt[0] = (seq >> 8) & 0xFF; pkt[1] = seq & 0xFF;
    memcpy(pkt + 2, fb->buf + off, n);
    imgChar->setValue(pkt, n + 2);
    imgChar->notify();
    seq++;
    // Yield so the BLE task can actually drain. Without this the loop starves
    // the stack on the same core and the far end loses packets. The value is
    // swept from the host rather than guessed; see gapMs.
    if (gapMs) delay(gapMs);
  }
  free(pkt);

  uint32_t tDone = millis();
  // warm_us and cap_us are printed separately and in MICROseconds so a stale
  // frame is impossible to mistake for a fresh one. A real SVGA read is tens of
  // thousands of microseconds; anything near zero means the buffer was reused.
  Serial.printf("FRAME bytes=%u %ux%u q=%d mtu=%u chunk=%u pkts=%u gap=%u warm_us=%u cap_us=%u tx_ms=%u total_ms=%u\n",
                (unsigned)len, (unsigned)fb->width, (unsigned)fb->height, haveQuality,
                (unsigned)mtu, (unsigned)chunk, (unsigned)seq, (unsigned)gapMs,
                (unsigned)warmUs, (unsigned)capUs,
                (unsigned)(tDone - tCap), (unsigned)(tDone - t0));
  esp_camera_fb_return(fb);
  goIdle();
}

// Serial image path, kept alongside the BLE one on purpose.
//
// BLE is the product; USB is the instrument. When the Windows BLE host started
// dropping notifications mid frame there was no way to answer the only question
// that mattered ("is this picture actually of right now?") because the sole
// image channel was the flaky one. A second, boring, known-good path means a
// transport problem can never again masquerade as a camera problem.
static void sendFrameSerial() {
  // The camera is released between frames now, so this path has to bring it
  // back too. Without this the USB diagnostic route breaks the moment the power
  // saving lands, which is exactly when it is most needed.
  setCpuFrequencyMhz(CPU_BUSY_MHZ);
  if (!camReady && !startCamera()) { Serial.println("CAM_REINIT_FAIL"); goIdle(); return; }
  uint32_t tWarm = micros();
  for (int i = 0; i < 3; i++) {
    camera_fb_t *stale = esp_camera_fb_get();
    if (stale) esp_camera_fb_return(stale);
  }
  uint32_t warmUs = micros() - tWarm;

  uint32_t tGet = micros();
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) { Serial.println("CAPTURE_FAIL"); goIdle(); return; }
  uint32_t capUs = micros() - tGet;

  size_t outLen = 0;
  mbedtls_base64_encode(NULL, 0, &outLen, fb->buf, fb->len);
  unsigned char *b64 = (unsigned char *)heap_caps_malloc(outLen + 1, MALLOC_CAP_SPIRAM);
  if (!b64) { Serial.println("ALLOC_FAIL"); esp_camera_fb_return(fb); goIdle(); return; }

  size_t written = 0;
  if (mbedtls_base64_encode(b64, outLen + 1, &written, fb->buf, fb->len) != 0) {
    Serial.println("B64_FAIL");
    free(b64); esp_camera_fb_return(fb); goIdle(); return;
  }

  Serial.printf("SER_FRAME warm_us=%u cap_us=%u\n", (unsigned)warmUs, (unsigned)capUs);
  Serial.printf("IMG_BEGIN %u %u %u\n", (unsigned)fb->len,
                (unsigned)fb->width, (unsigned)fb->height);
  for (size_t i = 0; i < written; i += 76) {
    size_t n = (written - i) < 76 ? (written - i) : 76;
    Serial.write(b64 + i, n);
    Serial.println();
  }
  Serial.println("IMG_END");

  free(b64);
  esp_camera_fb_return(fb);
  goIdle();
}

void setup() {
  Serial.begin(115200);
  delay(2500);
  Serial.println();
  Serial.println("XIAO_CAM_BLE_READY");

  if (!startCamera()) return;
  Serial.println("CAM_OK");

  BLEDevice::init("PAN-CAM");
  // Ask for the largest MTU the peer will grant. Chunk size is MTU minus 5, so
  // this is the single biggest lever on throughput.
  BLEDevice::setMTU(517);

  server = BLEDevice::createServer();
  server->setCallbacks(new SrvCB());

  BLEService *svc = server->createService(SVC_UUID);
  imgChar = svc->createCharacteristic(IMG_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  BLECharacteristic *ctl =
      svc->createCharacteristic(CTL_UUID, BLECharacteristic::PROPERTY_WRITE |
                                          BLECharacteristic::PROPERTY_WRITE_NR);
  ctl->setCallbacks(new CtlCB());
  svc->start();

  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SVC_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();

  // POWER: let the CPU idle down and light-sleep between frames.
  //
  // WHY THIS MATTERS MORE THAN THE DUTY CYCLE. Measured 2026-09-08, a QVGA
  // frame costs ~360ms of work (warm 128 + capture 72 + transmit 160) once
  // every 5s, so the board is BUSY about 7% of the time. It was nonetheless
  // burning full power for the other 93%: loop() just spun on delay(20), the
  // CPU stayed at 240MHz and the camera's 20MHz clock ran continuously. On the
  // arithmetic that idle period is roughly six times more energy than all the
  // capturing and transmitting put together, which makes it the single largest
  // power term in the whole pendant and the reason optimising pacing was
  // chasing the small number.
  //
  // RESULT 2026-09-08: this returns ESP_ERR_NOT_SUPPORTED on the Arduino core.
  // The core ships PRECOMPILED IDF libraries built without CONFIG_PM_ENABLE, so
  // automatic light sleep cannot be turned on from sketch code at all. Enabling
  // it needs a custom core build. The call is kept, and its result printed,
  // specifically so this is not silently retried and assumed to work: a power
  // "optimisation" that no-ops is worse than none, because it stops anyone
  // looking further.
  //
  // Automatic light sleep rather than an explicit esp_light_sleep_start because
  // BLE has to stay connected and the PM layer knows to wake the radio for each
  // connection event; forcing sleep by hand would drop the link.
  esp_pm_config_t pm = {
    .max_freq_mhz = 240,
    .min_freq_mhz = 40,
    .light_sleep_enable = true,
  };
  esp_err_t pmErr = esp_pm_configure(&pm);
  Serial.printf("PM light_sleep=%s (%s)\n",
                pmErr == ESP_OK ? "ENABLED" : "FAILED", esp_err_to_name(pmErr));
  Serial.println("BLE_ADVERTISING PAN-CAM");

  // Enter the low-power idle state immediately. setup() initialised the camera
  // to prove it works (CAM_OK); leaving it running afterwards would keep the
  // 20MHz XCLK alive for the whole first inter-frame gap.
  goIdle();
  // Report the camera state HONESTLY. This line used to say "camera=off"
  // unconditionally, which was false whenever powerDownCamera is disabled
  // (the default). A log that misreports the thing being measured is how
  // power work goes wrong.
  Serial.printf("IDLE cpu=%uMHz camera=%s\n", (unsigned)CPU_IDLE_MHZ,
                camReady ? "on (powerDownCamera disabled)" : "released");
}

void loop() {
  static uint32_t last = 0;

  // Serial trigger works whether or not anything is connected over BLE.
  if (Serial.available()) {
    int ch = Serial.read();
    if (ch == 'c' || ch == 'C') sendFrameSerial();
  }

  if (connected) {
    if (captureNow) { captureNow = false; sendFrame(); }
    else if (periodic && (millis() - last >= periodMs)) { last = millis(); sendFrame(); }
  }
  delay(20);
}
