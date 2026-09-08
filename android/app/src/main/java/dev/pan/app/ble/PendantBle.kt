package dev.pan.app.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * BLE client for the PAN camera pendant (Seeed XIAO ESP32-S3 Sense, "PAN-CAM").
 *
 * WHY BLE AND NOT WI-FI: the pendant runs off a cell small enough to fit a
 * gutted earbud case. Wi-Fi TX is the single largest draw on that board, and the
 * destination is this phone in his pocket, not an access point. The ESP32-S3 has
 * BT 5 (LE) only, so everything is GATT notifications.
 *
 * WIRE PROTOCOL (must stay in lockstep with xiao_cam_ble.ino):
 *   every notification is  [uint16 seq big-endian][payload]
 *     seq 0    payload = "PANF" + uint32 len + uint16 w + uint16 h
 *     seq 1..N payload = raw JPEG bytes, in order
 *
 * The sequence number is not decoration. BLE notifications are unacknowledged
 * and the controller drops them silently once its buffers fill, so without it a
 * truncated image is indistinguishable from a slow one. Measured on the bench
 * 2026-09-07: a full SVGA frame is ~22KB and crosses in ~0.35s at ~63 kB/s with
 * zero loss, which is about a 7% radio duty cycle at one frame per five seconds.
 *
 * TWO CEILINGS govern chunk size on the firmware side, and missing the second
 * costs every packet: MTU-3 for ATT overhead, and 512 for the BLE maximum
 * ATTRIBUTE VALUE length, which does NOT grow with the MTU. At MTU 517 the first
 * rule says 514, the board happily reports sending 514-byte packets, and the
 * peer receives nothing at all. Do not "optimise" the firmware chunk upward.
 */
@Singleton
class PendantBle @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    companion object {
        private const val TAG = "PendantBle"

        val SVC_UUID: UUID = UUID.fromString("6e2a0001-b5a3-f393-e0a9-e50e24dcca9e")
        val IMG_UUID: UUID = UUID.fromString("6e2a0002-b5a3-f393-e0a9-e50e24dcca9e")
        val CTL_UUID: UUID = UUID.fromString("6e2a0003-b5a3-f393-e0a9-e50e24dcca9e")
        private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        private const val DEVICE_NAME = "PAN-CAM"

        /** Ask for the largest MTU the peer will grant; chunk size follows it. */
        private const val WANT_MTU = 517

        /**
         * Inter-packet gap the board should use, in ms. The firmware default of
         * 3ms overruns the link and loses most of every frame. Bench sweep on a
         * Windows host found the first lossless setting at 8ms; 15 is chosen as
         * a deliberate margin over that, since a dropped packet costs the WHOLE
         * frame while a few extra ms costs only latency on a 5s cadence.
         */
        private const val PACING_MS = 15

        /**
         * Default frame size: QVGA 320x240. Measured on this phone 2026-09-08.
         *
         * SVGA is not viable on a battery here. Android connects at a slower
         * interval than the bench Windows host, so an SVGA frame (~23KB, 48
         * packets) needs ~120ms pacing to arrive intact, which puts transmit at
         * 5.8s against a 5s cadence: the radio is on essentially permanently.
         *
         *   SVGA  @120ms   48 pkts   tx 5760ms   ~100% duty   clean
         *   SVGA   @15ms   48 pkts   tx  720ms    ~14% duty   21% of frames survive
         *   QVGA   @15ms   12 pkts   tx  160ms    ~7% duty    93% survive
         *
         * A quarter of the pixels is a quarter of the packets, which buys both
         * reliability AND the duty cycle back. Shrink the payload rather than
         * slowing the link.
         */
        private const val DEFAULT_SIZE = "q"

        /**
         * Tuning override, read from `filesDir/ble_pacing_ms` when present.
         *
         * Exists because finding this value empirically needs a dozen runs and a
         * rebuild-per-value turns a ten minute sweep into an hour. A missing or
         * unparseable file just means PACING_MS, so production behaviour is
         * unchanged and there is nothing to remove later.
         */
        private const val PACING_OVERRIDE_FILE = "ble_pacing_ms"

        /**
         * Frame-size override, read from `filesDir/ble_size`: q = QVGA 320x240,
         * m = SVGA 800x600, h = HD 1280x720. Default is the firmware's SVGA.
         *
         * Size is the dominant power term, not pacing. An SVGA frame is ~48
         * packets; at the pacing needed to deliver it reliably on this phone the
         * radio ends up on almost continuously, which defeats the point of a
         * battery device. A quarter of the pixels is a quarter of the packets.
         */
        private const val SIZE_OVERRIDE_FILE = "ble_size"

        /** A frame that has not completed in this long is abandoned, not merged
         *  into the next one. Bench worst case is well under 2s. */
        private const val FRAME_TIMEOUT_MS = 15_000L

        /** Sanity ceiling. A malformed header must never make us allocate wildly. */
        private const val MAX_FRAME_BYTES = 512 * 1024
    }

    /** Human readable link state, for the notification and the UI. */
    private val _status = MutableStateFlow("Off")
    val status: StateFlow<String> = _status

    private val _framesReceived = MutableStateFlow(0)
    val framesReceived: StateFlow<Int> = _framesReceived

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError

    /** Set by the owner (PanForegroundService) to receive completed JPEGs. */
    @Volatile var onFrame: ((ByteArray, Int, Int) -> Unit)? = null

    private val adapter: BluetoothAdapter? by lazy {
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
    }

    private var gatt: BluetoothGatt? = null
    private var scanning = false
    @Volatile private var wantConnected = false
    /** Guards against a burst of queued scan results each opening its own GATT. */
    @Volatile private var connecting = false

    // ---- frame reassembly state -------------------------------------------
    private var expect = 0
    private var width = 0
    private var height = 0
    private var buf = ByteArray(0)
    private var filled = 0
    private var lastSeq = -1
    private var lost = 0
    private var frameStartedAt = 0L

    // -----------------------------------------------------------------------

    fun isSupported(): Boolean = adapter != null

    /** Frame-size command letter: the tuning file if valid, else DEFAULT_SIZE. */
    private fun sizeCmd(): String {
        return try {
            val f = java.io.File(context.filesDir, SIZE_OVERRIDE_FILE)
            if (!f.exists()) return DEFAULT_SIZE
            val v = f.readText().trim()
            if (v in listOf("q", "m", "h")) v else DEFAULT_SIZE
        } catch (_: Exception) { DEFAULT_SIZE }
    }

    /** PACING_MS unless overridden by the tuning file. Never throws. */
    private fun pacingMs(): Int {
        return try {
            val f = java.io.File(context.filesDir, PACING_OVERRIDE_FILE)
            if (!f.exists()) return PACING_MS
            val v = f.readText().trim().toIntOrNull() ?: return PACING_MS
            if (v in 1..500) v else PACING_MS
        } catch (_: Exception) { PACING_MS }
    }

    @SuppressLint("MissingPermission")
    fun start() {
        if (wantConnected) return
        wantConnected = true
        val a = adapter
        if (a == null) { fail("no bluetooth adapter"); return }
        if (!a.isEnabled) { fail("bluetooth is off"); return }
        startScan()
    }

    @SuppressLint("MissingPermission")
    fun stop() {
        wantConnected = false
        stopScan()
        try { gatt?.disconnect(); gatt?.close() } catch (_: Exception) {}
        gatt = null
        _status.value = "Off"
    }

    private fun fail(msg: String) {
        Log.w(TAG, msg)
        _lastError.value = msg
        _status.value = "Error"
    }

    @SuppressLint("MissingPermission")
    private fun startScan() {
        val scanner = adapter?.bluetoothLeScanner ?: run { fail("no BLE scanner"); return }
        if (scanning) return
        scanning = true
        _status.value = "Scanning"
        // Filter on the SERVICE UUID rather than the name: the name only appears
        // in the scan response, so a name filter misses advertisements on some
        // stacks and makes this look like the pendant is absent.
        val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SVC_UUID)).build()
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_POWER)
            .build()
        try {
            scanner.startScan(listOf(filter), settings, scanCallback)
            Log.i(TAG, "scanning for $DEVICE_NAME")
        } catch (e: Exception) {
            scanning = false
            fail("startScan failed: ${e.message}")
        }
    }

    @SuppressLint("MissingPermission")
    private fun stopScan() {
        if (!scanning) return
        scanning = false
        try { adapter?.bluetoothLeScanner?.stopScan(scanCallback) } catch (_: Exception) {}
    }

    private val scanCallback = object : ScanCallback() {
        @SuppressLint("MissingPermission")
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val dev = result.device ?: return
            // stopScan() does NOT stop results already queued in the stack, and
            // more arrive for several milliseconds afterwards. Without this
            // guard every one of them opened ANOTHER GATT connection: measured
            // 2026-09-07, nine simultaneous connections to the same pendant, all
            // subscribed, interleaving their packets into one reassembly buffer
            // so that EVERY frame failed with an overflow. The link was fine; the
            // client was talking to itself nine times over.
            synchronized(this@PendantBle) {
                if (connecting || gatt != null) return
                connecting = true
            }
            stopScan()
            Log.i(TAG, "found ${dev.address}, connecting")
            _status.value = "Connecting"
            connect(dev)
        }

        override fun onScanFailed(errorCode: Int) {
            scanning = false
            fail("scan failed: $errorCode")
        }
    }

    @SuppressLint("MissingPermission")
    private fun connect(device: BluetoothDevice) {
        gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
    }

    private val gattCallback = object : BluetoothGattCallback() {
        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(g: BluetoothGatt, statusCode: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                connecting = false
                gatt = g
                Log.i(TAG, "connected, requesting MTU $WANT_MTU")
                _status.value = "Connected"
                // CONNECTION INTERVAL, not just MTU. Android connects at roughly
                // 30ms by default, so the link drains about half as fast as the
                // board sends at its 15ms pacing, and the controller silently
                // drops the excess. Measured 2026-09-07: the board reported
                // sending all ~48 packets of a 23KB frame (gap=15, tx_ms=705)
                // while the phone received only 3-6KB. HIGH priority asks for
                // ~11.25ms, which puts the drain rate ahead of the send rate.
                val ok = g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                Log.i(TAG, "requestConnectionPriority(HIGH) -> $ok")
                // MTU first, services after: chunk size is MTU-5, so discovering
                // and subscribing before the MTU is raised means the first frame
                // arrives in 18-byte pieces.
                g.requestMtu(WANT_MTU)
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                Log.i(TAG, "disconnected (status=$statusCode)")
                connecting = false
                resetFrame()
                try { g.close() } catch (_: Exception) {}
                gatt = null
                _status.value = "Disconnected"
                // Rescan rather than reconnect: the pendant may have powered off,
                // and a stale BluetoothDevice reconnect loop burns phone battery.
                if (wantConnected) startScan()
            }
        }

        @SuppressLint("MissingPermission")
        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, statusCode: Int) {
            Log.i(TAG, "MTU now $mtu")
            g.discoverServices()
        }

        @SuppressLint("MissingPermission")
        override fun onServicesDiscovered(g: BluetoothGatt, statusCode: Int) {
            val svc = g.getService(SVC_UUID)
            if (svc == null) { fail("PAN-CAM service not found"); return }
            val img = svc.getCharacteristic(IMG_UUID)
            if (img == null) { fail("image characteristic not found"); return }

            g.setCharacteristicNotification(img, true)
            // setCharacteristicNotification only flips a LOCAL flag. Without also
            // writing the CCCD the peer never actually sends anything, and it
            // fails silently, which looks exactly like a dead pendant.
            val cccd = img.getDescriptor(CCCD_UUID)
            if (cccd == null) {
                fail("CCCD missing; notifications cannot be enabled")
                return
            }
            @Suppress("DEPRECATION")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            } else {
                cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                g.writeDescriptor(cccd)
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, statusCode: Int) {
            Log.i(TAG, "notifications enabled (status=$statusCode); pacing then starting capture")
            _status.value = "Streaming"
            // PACING MUST BE SET BEFORE STREAMING, and it is not optional.
            //
            // The firmware default is a 3ms inter-packet gap, which is faster
            // than the link can drain: measured 2026-09-07 it loses most of every
            // frame, arriving as 3-6KB of a ~25KB image. The board resets to that
            // default whenever it is power cycled, so the phone has to set it on
            // every connection rather than assuming a previous session's value
            // survived.
            //
            // Sent as ONE write ("d15s") because the firmware parses a whole
            // command string, and two back-to-back WRITE_NO_RESPONSE writes can
            // be dropped by the stack.
            val pacing = pacingMs()
            val size = sizeCmd()
            Log.i(TAG, "pacing = ${pacing}ms size = $size")
            // Size before pacing before start, all in one write.
            sendCommand("${size}d${pacing}s")
        }

        // API 33+ delivers the payload as a parameter; 31/32 read it off the
        // characteristic. minSdk is 31, so both paths have to exist.
        override fun onCharacteristicChanged(
            g: BluetoothGatt, ch: BluetoothGattCharacteristic, value: ByteArray
        ) {
            if (ch.uuid == IMG_UUID) onPacket(value)
        }

        @Deprecated("Deprecated in API 33")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic) {
            if (ch.uuid == IMG_UUID) ch.value?.let { onPacket(it) }
        }
    }

    /**
     * Send a control command. See the firmware header for the vocabulary:
     * 'c' capture now, 's' start periodic, 'x' stop, 'p<n>' period seconds,
     * 'd<n>' inter packet pacing ms, 'q'/'m'/'h' frame size.
     */
    @SuppressLint("MissingPermission")
    fun sendCommand(cmd: String): Boolean {
        val g = gatt ?: return false
        val ctl = g.getService(SVC_UUID)?.getCharacteristic(CTL_UUID) ?: return false
        return try {
            @Suppress("DEPRECATION")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeCharacteristic(
                    ctl, cmd.toByteArray(),
                    BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                )
                true
            } else {
                ctl.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                ctl.value = cmd.toByteArray()
                g.writeCharacteristic(ctl)
            }
        } catch (e: Exception) {
            Log.w(TAG, "sendCommand('$cmd') failed: ${e.message}")
            false
        }
    }

    /** Ask for a single frame right now, for the "hey, look at this" path. */
    fun captureNow(): Boolean = sendCommand("c")

    private fun resetFrame() {
        expect = 0; width = 0; height = 0
        buf = ByteArray(0); filled = 0
        lastSeq = -1; lost = 0; frameStartedAt = 0L
    }

    // Synchronized: the stack delivers notifications on a binder thread POOL, so
    // consecutive packets of one frame can land on different threads. Observed
    // 2026-09-07 (thread ids 20162/20163/20165/20184 all writing the same frame).
    // Reassembly state is shared mutable state and must not be raced.
    @Synchronized
    private fun onPacket(pkt: ByteArray) {
        if (pkt.size < 2) return
        val seq = ((pkt[0].toInt() and 0xFF) shl 8) or (pkt[1].toInt() and 0xFF)

        if (seq == 0) {
            // Header. Anything still buffered belonged to a frame that never
            // finished; say so rather than silently folding it into this one.
            if (filled > 0) Log.w(TAG, "discarding $filled orphan bytes from a truncated frame")
            resetFrame()
            if (pkt.size < 14) return
            if (!(pkt[2] == 'P'.code.toByte() && pkt[3] == 'A'.code.toByte() &&
                  pkt[4] == 'N'.code.toByte() && pkt[5] == 'F'.code.toByte())) return
            val len = ((pkt[6].toInt() and 0xFF) shl 24) or ((pkt[7].toInt() and 0xFF) shl 16) or
                      ((pkt[8].toInt() and 0xFF) shl 8) or (pkt[9].toInt() and 0xFF)
            if (len <= 0 || len > MAX_FRAME_BYTES) { Log.w(TAG, "implausible length $len"); return }
            width = ((pkt[10].toInt() and 0xFF) shl 8) or (pkt[11].toInt() and 0xFF)
            height = ((pkt[12].toInt() and 0xFF) shl 8) or (pkt[13].toInt() and 0xFF)
            expect = len
            buf = ByteArray(len)
            frameStartedAt = System.currentTimeMillis()
            return
        }

        if (expect == 0) return  // chunk before its header
        if (frameStartedAt > 0 && System.currentTimeMillis() - frameStartedAt > FRAME_TIMEOUT_MS) {
            Log.w(TAG, "frame timed out at $filled/$expect bytes, dropping")
            resetFrame()
            return
        }

        if (lastSeq >= 0 && seq > lastSeq + 1) lost += seq - lastSeq - 1
        lastSeq = seq

        val n = pkt.size - 2
        if (filled + n > expect) {
            // More bytes than declared means the stream is out of step. Abandon
            // rather than write a corrupt JPEG into memory.
            Log.w(TAG, "overflow: $filled + $n exceeds $expect, dropping frame")
            resetFrame()
            return
        }
        System.arraycopy(pkt, 2, buf, filled, n)
        filled += n

        if (filled >= expect) {
            val complete = buf
            val w = width; val h = height; val dropped = lost
            resetFrame()
            if (dropped > 0) {
                // A frame with holes is a corrupt JPEG. Counting it as success is
                // how a lossy link masquerades as a working one.
                Log.w(TAG, "frame had $dropped lost packets, discarding")
                return
            }
            _framesReceived.value = _framesReceived.value + 1
            Log.i(TAG, "frame ${complete.size}B ${w}x$h (total ${_framesReceived.value})")
            try { onFrame?.invoke(complete, w, h) } catch (e: Exception) {
                Log.w(TAG, "onFrame handler threw: ${e.message}")
            }
        }
    }
}
