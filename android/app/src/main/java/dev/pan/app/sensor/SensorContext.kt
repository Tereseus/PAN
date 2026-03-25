package dev.pan.app.sensor

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Geocoder
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper
import java.util.Locale
import android.util.Log
import androidx.core.content.ContextCompat
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * PAN Sensor Context — collects all available sensor data into a context envelope
 * that gets attached to every AI request (voice queries, photos, terminal commands).
 *
 * Phone sensors: GPS, compass, accelerometer, gyroscope, barometer, light, proximity, step counter
 * Pendant sensors: gas, spectrometer, temperature, humidity (via BLE, future)
 *
 * Each sensor can be toggled on/off in settings. When off, its data is null in the envelope.
 */
@Singleton
class SensorContext @Inject constructor(
    @ApplicationContext private val context: Context
) : SensorEventListener, LocationListener {

    companion object {
        private const val TAG = "PanSensor"
    }

    private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager

    // Latest sensor readings
    var gps: GpsReading? = null; private set
    var address: String? = null; private set  // reverse geocoded address
    var compass: Float? = null; private set          // degrees from north
    var accelerometer: FloatArray? = null; private set  // x, y, z m/s²
    var gyroscope: FloatArray? = null; private set      // x, y, z rad/s
    var barometer: Float? = null; private set           // hPa
    var light: Float? = null; private set               // lux
    var proximity: Float? = null; private set           // cm (usually 0 or max)
    var stepCount: Int? = null; private set

    // Pendant sensors (populated via BLE)
    var gasReadings: Map<String, Double>? = null
    var temperature: Float? = null
    var humidity: Float? = null
    var spectrometerData: FloatArray? = null

    // Toggles — controlled from settings / sensor dashboard
    // These control what PAN is allowed to use, NOT the device hardware
    var cameraEnabled = true   // PAN can take photos
    var gpsEnabled = true
    var compassEnabled = true
    var accelerometerEnabled = true
    var gyroscopeEnabled = false  // off by default (noisy, high frequency)
    var barometerEnabled = true
    var lightEnabled = true
    var proximityEnabled = true
    var stepCounterEnabled = false  // off by default

    // Pendant toggles
    var gasEnabled = true
    var temperatureEnabled = true
    var humidityEnabled = true
    var spectrometerEnabled = true

    private var started = false

    /**
     * Generic sensor enable/disable by PAN sensor ID.
     * Maps dashboard sensor IDs to actual hardware toggle flags.
     * Returns true if the sensor ID was recognized.
     */
    fun setSensorEnabled(sensorId: String, enabled: Boolean): Boolean {
        return when (sensorId) {
            "gps" -> { gpsEnabled = enabled; if (!enabled) { try { locationManager.removeUpdates(this) } catch (_: Exception) {} } else if (started) { startGps() }; true }
            "accel_gyro" -> { accelerometerEnabled = enabled; gyroscopeEnabled = enabled; true }
            "ambient_light" -> { lightEnabled = enabled; true }
            "barometer" -> { barometerEnabled = enabled; true }
            // Pendant sensors (will send BLE command when connected)
            "gas" -> { gasEnabled = enabled; true }
            "uv", "thermal", "ir", "spectrometer" -> { spectrometerEnabled = enabled; true }
            "temperature" -> { temperatureEnabled = enabled; true }
            "humidity" -> { humidityEnabled = enabled; true }
            "compass" -> { compassEnabled = enabled; true }
            "proximity" -> { proximityEnabled = enabled; true }
            "step_counter" -> { stepCounterEnabled = enabled; true }
            "camera" -> { cameraEnabled = enabled; true }
            // microphone is handled separately (STT engine)
            "microphone" -> true
            else -> { Log.w(TAG, "Unknown sensor ID: $sensorId"); false }
        }
    }

    fun start() {
        if (started) return
        started = true
        Log.i(TAG, "Starting sensor collection")

        // Register phone sensors
        registerSensor(Sensor.TYPE_MAGNETIC_FIELD)      // compass
        registerSensor(Sensor.TYPE_ACCELEROMETER)
        registerSensor(Sensor.TYPE_GYROSCOPE)
        registerSensor(Sensor.TYPE_PRESSURE)             // barometer
        registerSensor(Sensor.TYPE_LIGHT)
        registerSensor(Sensor.TYPE_PROXIMITY)
        registerSensor(Sensor.TYPE_STEP_COUNTER)

        // Start GPS
        startGps()
    }

    fun stop() {
        started = false
        sensorManager.unregisterListener(this)
        try { locationManager.removeUpdates(this) } catch (_: Exception) {}
    }

    private fun registerSensor(type: Int) {
        val sensor = sensorManager.getDefaultSensor(type)
        if (sensor != null) {
            // SENSOR_DELAY_NORMAL = ~200ms updates, good balance of power/freshness
            sensorManager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_NORMAL)
        }
    }

    private fun startGps() {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "No GPS permission")
            return
        }
        try {
            // Try multiple providers — FUSED may not be available on all devices
            val providers = listOf(
                LocationManager.FUSED_PROVIDER,
                LocationManager.GPS_PROVIDER,
                LocationManager.NETWORK_PROVIDER
            )
            for (provider in providers) {
                try {
                    if (locationManager.isProviderEnabled(provider)) {
                        locationManager.requestLocationUpdates(
                            provider, 5000, 5f, this, Looper.getMainLooper()
                        )
                        Log.i(TAG, "GPS using provider: $provider")
                        break
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Provider $provider failed: ${e.message}")
                }
            }
            // Get last known from any provider
            val last = providers.firstNotNullOfOrNull { p ->
                try { locationManager.getLastKnownLocation(p) } catch (_: Exception) { null }
            }
            if (last != null) {
                onLocationChanged(last)
                Log.i(TAG, "GPS initial: ${last.latitude}, ${last.longitude}")
            } else {
                Log.w(TAG, "No last known location from any provider")
            }
        } catch (e: Exception) {
            Log.w(TAG, "GPS start failed: ${e.message}")
        }
    }

    // --- Sensor callbacks ---

    override fun onSensorChanged(event: SensorEvent) {
        when (event.sensor.type) {
            Sensor.TYPE_MAGNETIC_FIELD -> {
                // Simple compass heading from magnetic field X/Y
                val x = event.values[0]
                val y = event.values[1]
                compass = Math.toDegrees(Math.atan2(y.toDouble(), x.toDouble())).toFloat()
            }
            Sensor.TYPE_ACCELEROMETER -> accelerometer = event.values.copyOf()
            Sensor.TYPE_GYROSCOPE -> gyroscope = event.values.copyOf()
            Sensor.TYPE_PRESSURE -> barometer = event.values[0]
            Sensor.TYPE_LIGHT -> light = event.values[0]
            Sensor.TYPE_PROXIMITY -> proximity = event.values[0]
            Sensor.TYPE_STEP_COUNTER -> stepCount = event.values[0].toInt()
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    override fun onLocationChanged(location: Location) {
        gps = GpsReading(
            lat = location.latitude,
            lng = location.longitude,
            altitude = if (location.hasAltitude()) location.altitude else null,
            speed = if (location.hasSpeed()) location.speed.toDouble() else null,
            accuracy = if (location.hasAccuracy()) location.accuracy.toDouble() else null,
            bearing = if (location.hasBearing()) location.bearing.toDouble() else null
        )
        // Reverse geocode to get address (don't block — best effort)
        try {
            val geocoder = Geocoder(context, Locale.getDefault())
            val results = geocoder.getFromLocation(location.latitude, location.longitude, 1)
            if (!results.isNullOrEmpty()) {
                val a = results[0]
                address = listOfNotNull(
                    a.subThoroughfare, a.thoroughfare, a.locality, a.adminArea, a.countryCode
                ).joinToString(", ")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Geocode failed: ${e.message}")
        }
    }

    /**
     * Build the context envelope — only includes enabled sensors with non-null readings.
     * This gets attached to every AI request.
     */
    fun getContextEnvelope(): Map<String, Any?> {
        val phoneSensors = mutableMapOf<String, Any?>()

        if (gpsEnabled && gps != null) {
            phoneSensors["gps"] = mapOf(
                "lat" to gps!!.lat,
                "lng" to gps!!.lng,
                "altitude" to gps!!.altitude,
                "speed" to gps!!.speed,
                "accuracy" to gps!!.accuracy,
                "bearing" to gps!!.bearing,
                "address" to address
            )
        }
        if (compassEnabled && compass != null) phoneSensors["compass"] = compass
        if (accelerometerEnabled && accelerometer != null) {
            phoneSensors["accelerometer"] = mapOf(
                "x" to accelerometer!![0], "y" to accelerometer!![1], "z" to accelerometer!![2]
            )
        }
        if (gyroscopeEnabled && gyroscope != null) {
            phoneSensors["gyroscope"] = mapOf(
                "x" to gyroscope!![0], "y" to gyroscope!![1], "z" to gyroscope!![2]
            )
        }
        if (barometerEnabled && barometer != null) phoneSensors["barometer_hpa"] = barometer
        if (lightEnabled && light != null) phoneSensors["light_lux"] = light
        if (proximityEnabled && proximity != null) phoneSensors["proximity_cm"] = proximity
        if (stepCounterEnabled && stepCount != null) phoneSensors["steps"] = stepCount

        val pendantSensors = mutableMapOf<String, Any?>()
        if (gasEnabled && gasReadings != null) pendantSensors["gas"] = gasReadings
        if (temperatureEnabled && temperature != null) pendantSensors["temperature_c"] = temperature
        if (humidityEnabled && humidity != null) pendantSensors["humidity_pct"] = humidity
        if (spectrometerEnabled && spectrometerData != null) pendantSensors["spectrometer"] = spectrometerData?.toList()

        val envelope = mutableMapOf<String, Any?>(
            "timestamp" to System.currentTimeMillis()
        )
        if (phoneSensors.isNotEmpty()) envelope["phone"] = phoneSensors
        if (pendantSensors.isNotEmpty()) envelope["pendant"] = pendantSensors

        return envelope
    }
}

data class GpsReading(
    val lat: Double,
    val lng: Double,
    val altitude: Double?,
    val speed: Double?,
    val accuracy: Double?,
    val bearing: Double?
)
