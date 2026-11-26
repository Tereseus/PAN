package dev.pan.app.accessory

import android.annotation.SuppressLint
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothManager
import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Accessory slots: glasses, headphones, a watch, a car, anything else.
 *
 * The owner, Nov 14: "a glasses slot, a headphone slot, a watch slot, and all the accessories you
 * could think of", with the Android standard as the one that wins. So PAN has no driver per
 * brand. Whatever Android itself calls an audio device lands in a slot, and PAN listens and
 * speaks through it with Android's own call routing (AudioManager.setCommunicationDevice):
 *
 *  - Android XR glasses (Jetpack Projected) show up to the phone as Bluetooth audio, so their
 *    mic and speakers work here today. Their camera and display come later through
 *    androidx.xr.projected, which is still alpha.
 *  - Bluetooth and LE Audio earbuds and headsets, hearing aids, wired and USB headsets.
 *  - A watch (Wear OS) is listed when paired; talking through it needs a Wear OS app (later).
 *  - The Medallion (PendantBle, PendantMic) has no slot here: it is design only, so the owner took
 *    its slot off the screen on Nov 26 (app 0.5.57).
 *
 * Why the call route and nothing rawer: the mic is VOICE_COMMUNICATION with echo cancelling
 * (SherpaStreamingStt), and the call route is the one Android moves to a headset together with
 * the echo reference. PiperTtsEngine.toLoudspeaker() leaves a chosen headset alone (it only
 * moves the earpiece to the loudspeaker).
 *
 * The choice is off by default: an always open mic over classic Bluetooth (HFP) keeps the
 * headset in call mode, which also makes music on it sound like a phone call. LE Audio does not.
 */
@Singleton
class AccessoryHub @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    enum class Slot(val label: String) {
        GLASSES("Glasses"), HEADPHONES("Headphones"), WATCH("Watch"), CAR("Car"), OTHER("Other")
    }

    data class Accessory(
        /** "type:address", stable across reconnects. */
        val key: String,
        val slot: Slot,
        val name: String,
        val mic: Boolean,
        val speaker: Boolean,
        /** How it is linked, in plain words: "LE Audio", "Bluetooth call audio", "paired"... */
        val how: String,
        val connected: Boolean = true,
    )

    private val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val prefs = context.getSharedPreferences("accessories", Context.MODE_PRIVATE)

    private val _accessories = MutableStateFlow<List<Accessory>>(emptyList())
    val accessories: StateFlow<List<Accessory>> = _accessories

    /** The accessory PAN listens and speaks through, or null for the phone's own. */
    private val _micKey = MutableStateFlow(prefs.getString(KEY_MIC, null))
    val micKey: StateFlow<String?> = _micKey

    /** What is actually routed now, for the screen: the chosen one may be away. */
    private val _routed = MutableStateFlow<String?>(null)
    val routed: StateFlow<String?> = _routed

    /**
     * A car's Bluetooth audio is connected (the owner, Nov 15: "everyone plugs their phone in when
     * they're in the car"). The phone does the work and the car is only its speakers: the service
     * puts PAN's voice on the media path (TtsManager.carMode) so it plays through the car like a
     * navigation prompt, and keeps listening on the phone's own mic, so music never turns into a call.
     */
    private val _car = MutableStateFlow<String?>(null)
    val car: StateFlow<String?> = _car

    private var started = false

    private val callback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = refresh()
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = refresh()
    }

    @Synchronized
    fun start() {
        if (started) return
        started = true
        am.registerAudioDeviceCallback(callback, Handler(Looper.getMainLooper()))
        refresh()
    }

    /** Listen and speak through [key], or through the phone when null. */
    fun useForVoice(key: String?) {
        prefs.edit().putString(KEY_MIC, key).apply()
        _micKey.value = key
        route()
    }

    fun refresh() {
        val found = LinkedHashMap<String, Accessory>()
        val devices = am.getDevices(AudioManager.GET_DEVICES_INPUTS) + am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        for (d in devices) {
            val how = HOW[d.type] ?: continue
            val key = keyOf(d)
            val prev = found[key]
            val isMic = d.isSource
            found[key] = Accessory(
                key = key,
                slot = prev?.slot ?: slotOf(d),
                name = d.productName?.toString()?.takeIf { it.isNotBlank() } ?: how,
                mic = (prev?.mic ?: false) || isMic,
                speaker = (prev?.speaker ?: false) || d.isSink,
                how = how,
            )
        }
        // Paired watches and glasses that are not audio devices right now.
        for ((name, slot, addr) in bondedWearables()) {
            if (found.values.none { it.key.endsWith(":$addr") }) {
                found["bonded:$addr"] = Accessory("bonded:$addr", slot, name, mic = false, speaker = false,
                    how = if (slot == Slot.WATCH) "paired (talking through a watch needs the Wear OS app)" else "paired",
                    connected = false)
            }
        }
        _accessories.value = found.values.toList()
        // Speakers in the car: its media (A2DP) output, which is what PAN's voice goes to.
        _car.value = devices.firstOrNull { it.isSink && it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP && found[keyOf(it)]?.slot == Slot.CAR }
            ?.let { it.productName?.toString()?.takeIf { n -> n.isNotBlank() } ?: "car" }
        route()
    }

    /** Point Android's call route at the chosen accessory when it is here, else back to the phone. */
    private fun route() {
        val want = _micKey.value
        try {
            val target = want?.let { k -> am.availableCommunicationDevices.firstOrNull { keyOf(it) == k } }
            val current = am.communicationDevice
            if (target != null) {
                if (current == null || keyOf(current) != want) {
                    val ok = am.setCommunicationDevice(target)
                    Log.i(TAG, "voice through ${target.productName} (${HOW[target.type]}): $ok")
                }
                _routed.value = want
            } else {
                // Chosen one gone (or phone chosen): give the route back, but only one this hub set.
                // At start nothing was set here, so a call or TTS route is left alone.
                if (_routed.value != null && current != null && HOW.containsKey(current.type)) {
                    am.clearCommunicationDevice()
                    Log.i(TAG, "voice back to the phone")
                }
                _routed.value = null
            }
        } catch (e: Exception) {
            Log.w(TAG, "routing failed: ${e.message}")
        }
    }

    private fun keyOf(d: AudioDeviceInfo): String {
        // A headset shows as two entries (call audio and media); one accessory either way.
        val family = when (d.type) {
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bt"
            AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER -> "le"
            else -> d.type.toString()
        }
        return "$family:${d.address.ifBlank { d.productName }}"
    }

    @SuppressLint("MissingPermission")
    private fun slotOf(d: AudioDeviceInfo): Slot {
        val name = d.productName?.toString()?.lowercase() ?: ""
        if (GLASSES_NAME.containsMatchIn(name)) return Slot.GLASSES
        if (WATCH_NAME.containsMatchIn(name)) return Slot.WATCH
        val cls = try {
            (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
                ?.takeIf { d.address.isNotBlank() && android.bluetooth.BluetoothAdapter.checkBluetoothAddress(d.address) }
                ?.getRemoteDevice(d.address)?.bluetoothClass?.deviceClass
        } catch (_: SecurityException) { null } catch (_: Exception) { null }
        return when (cls) {
            BluetoothClass.Device.WEARABLE_GLASSES -> Slot.GLASSES
            BluetoothClass.Device.WEARABLE_WRIST_WATCH -> Slot.WATCH
            // Head units call themselves car audio, or hands-free (the call side of a car kit).
            BluetoothClass.Device.AUDIO_VIDEO_CAR_AUDIO, BluetoothClass.Device.AUDIO_VIDEO_HANDSFREE -> Slot.CAR
            else -> if (d.type == AudioDeviceInfo.TYPE_BLE_SPEAKER) Slot.OTHER else Slot.HEADPHONES
        }
    }

    @SuppressLint("MissingPermission")
    private fun bondedWearables(): List<Triple<String, Slot, String>> = try {
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter?.bondedDevices
            ?.mapNotNull { dev ->
                val name = dev.name ?: return@mapNotNull null
                val slot = when {
                    dev.bluetoothClass?.deviceClass == BluetoothClass.Device.WEARABLE_GLASSES ||
                        GLASSES_NAME.containsMatchIn(name.lowercase()) -> Slot.GLASSES
                    dev.bluetoothClass?.deviceClass == BluetoothClass.Device.WEARABLE_WRIST_WATCH ||
                        WATCH_NAME.containsMatchIn(name.lowercase()) -> Slot.WATCH
                    else -> return@mapNotNull null
                }
                Triple(name, slot, dev.address)
            } ?: emptyList()
    } catch (_: SecurityException) { emptyList() } catch (_: Exception) { emptyList() }

    companion object {
        private const val TAG = "AccessoryHub"
        private const val KEY_MIC = "voice_key"

        /** The Android audio device types that count as an accessory, in plain words. */
        private val HOW = mapOf(
            AudioDeviceInfo.TYPE_BLE_HEADSET to "LE Audio",
            AudioDeviceInfo.TYPE_BLE_SPEAKER to "LE Audio speaker",
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO to "Bluetooth call audio",
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP to "Bluetooth audio",
            AudioDeviceInfo.TYPE_HEARING_AID to "hearing aid",
            AudioDeviceInfo.TYPE_WIRED_HEADSET to "wired headset",
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES to "wired headphones",
            AudioDeviceInfo.TYPE_USB_HEADSET to "USB headset",
        )
        private val GLASSES_NAME = Regex("""glass|ray-?ban|oakley|xreal|\bxr\b|even g\d|\bframe\b|spectacles|rokid|vuzix""")
        private val WATCH_NAME = Regex("""watch|galaxy fit|pixel watch""")
    }
}
